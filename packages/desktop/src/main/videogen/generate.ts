import { createHash } from 'node:crypto';
import type { Artifact, VideogenFailure } from '@clawwork/shared';
import { getDebugLogger } from '../debug/index.js';
import { findReplayArtifact, saveArtifactFromBuffer } from '../artifact/save.js';
import { captureArtifactWorkspaceOwner } from '../artifact/workspace-owner.js';
import { notifyArtifactActivity, type ArtifactActivityCallback } from '../artifact/activity-callback.js';
import { verifyMp4Buffer } from '../artifact/verify.js';
import { extractVideogenBlocks } from './blocks.js';
import type { VideogenRelayClient } from './client.js';
import { videoFileNameFor, type VideogenRequest } from './request.js';

/**
 * 消息里有 ```` ```videogen ```` 块 ⇒ 去 relay 远端生成视频并**走客户端现成的产物通道**存下来。
 *
 * ## 与 docgen/htmlgen 的一条本质差别（调用方必须知道）
 *
 * 这条流水线**以分钟计**（远端付费异步任务）。调用方（`ipc/data-handlers.ts`）必须
 * **脱离消息收尾路径**地跑它（见那边的 `startVideogenJobs`）——在这里同步 await
 * 会把"消息已完成"的记账拖住好几分钟。
 *
 * ## 三重防重复（防的是"付费任务被重复创建"，比重复登记贵得多）
 *
 *  1. `sourceKey`（内容哈希）在**创建远端任务之前**用 `findReplayArtifact` 探测：
 *     同一 messageId 里同内容的产物已存在且文件在盘 ⇒ 直接跳过，一个请求都不发；
 *  2. `saveArtifactFromBuffer` 自己的重放结算（登记层，最后的保险）；
 *  3. 调用方的进程内去重（同一消息只启动一次）。
 *
 * ## 失败语义
 *
 * 一份失败不影响另一份（多份请求里坏了一份，其余照做）；**不抛**——调用方在后台
 * 任务里跑它，抛出去只会变成一条没人看的 unhandled rejection。
 * 用户可见的文案在渲染层按 `VideogenFailure` 的码本地化。
 */

export const VIDEOGEN_POLL_INTERVAL_MS = 10_000;
/** 最长等多久。15s 片在实测里两三分钟出；12 分钟兜异常排队的底。超时如实报"没等到"。 */
export const VIDEOGEN_DEADLINE_MS = 12 * 60_000;
/** 轮询连续失败几次才判任务失败（网络瞬断不该毁掉一个已经付费的任务）。 */
export const VIDEOGEN_QUERY_FAILURE_TOLERANCE = 3;

export interface VideogenGenerateInput {
  workspacePath: string;
  taskId: string;
  messageId: string;
  content: string;
  client: VideogenRelayClient;
  onActivity?: ArtifactActivityCallback;
  pollIntervalMs?: number;
  deadlineMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface VideogenGenerateResult {
  saved: Artifact[];
  failed: VideogenFailure[];
}

/**
 * 去重键：**内容哈希**（与 docgen/htmlgen 同一个理由——只带标题会在"标题相同内容不同"
 * 时算出同一个键，后者被唯一约束静默丢掉）。
 */
export function videogenSourceKey(request: VideogenRequest): string {
  const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 16);
  return `videogen:${digest}`;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 处理一条请求：创建 → 轮询 → 下载 → 校验 → 登记。
 * 返回 `{artifact}` 或 `{failure}`（判别联合，不抛）。
 */
async function runOneRequest(
  input: VideogenGenerateInput,
  request: VideogenRequest,
  owner: { current: () => boolean; assertCurrent: () => void },
): Promise<{ artifact: Artifact } | { failure: VideogenFailure }> {
  const log = getDebugLogger();
  const sleep = input.sleep ?? defaultSleep;
  const now = input.now ?? Date.now;
  const pollInterval = input.pollIntervalMs ?? VIDEOGEN_POLL_INTERVAL_MS;
  const deadline = input.deadlineMs ?? VIDEOGEN_DEADLINE_MS;
  const sourceKey = videogenSourceKey(request);

  // ① 重放探测（**花任何钱之前**）：同消息同内容已有可用产物 ⇒ 什么都不做。
  const replay = findReplayArtifact(input.messageId, sourceKey);
  if (replay) {
    log.info({
      domain: 'artifact',
      event: 'videogen.replay-skipped',
      data: { taskId: input.taskId, name: replay.name },
    });
    return { artifact: replay };
  }

  notifyArtifactActivity(input.onActivity, 'generating-video');

  const created = await input.client.create(request);
  if (!created.ok) {
    log.warn({
      domain: 'artifact',
      event: 'videogen.create-failed',
      data: {
        taskId: input.taskId,
        status: created.failure.code === 'videogen-create-failed' ? created.failure.httpStatus : null,
      },
    });
    return { failure: created.failure };
  }

  const startedAt = now();
  let consecutiveQueryFailures = 0;
  for (;;) {
    if (!owner.current()) {
      // 工作区已切换：任务还在远端跑（钱已花），但我们不能再往下走——如实记日志，不发 artifact。
      log.warn({ domain: 'artifact', event: 'videogen.workspace-changed', data: { taskId: input.taskId } });
      return { failure: { code: 'videogen-task-failed', upstreamCode: null } };
    }

    const queried = await input.client.query(created.taskId);
    if (queried.status === 'finished') break;
    if (queried.status === 'failed') {
      if (queried.failure.code === 'videogen-task-failed' && queried.failure.upstreamCode === null) {
        // 网络/HTTP 层的查询失败：可能是瞬断。容忍几次再判。
        consecutiveQueryFailures += 1;
        if (consecutiveQueryFailures < VIDEOGEN_QUERY_FAILURE_TOLERANCE) {
          await sleep(pollInterval);
          continue;
        }
      }
      log.warn({
        domain: 'artifact',
        event: 'videogen.task-failed',
        data: { taskId: input.taskId, failureCode: queried.failure.code },
      });
      return { failure: queried.failure };
    }
    consecutiveQueryFailures = 0;
    if (now() - startedAt >= deadline) {
      log.warn({
        domain: 'artifact',
        event: 'videogen.timeout',
        data: { taskId: input.taskId, waitedMs: now() - startedAt },
      });
      return { failure: { code: 'videogen-timeout', waitedMs: now() - startedAt } };
    }
    await sleep(pollInterval);
  }

  const downloaded = await input.client.download(created.taskId);
  if (!downloaded.ok) {
    log.warn({ domain: 'artifact', event: 'videogen.download-failed', data: { taskId: input.taskId } });
    return { failure: downloaded.failure };
  }

  // 下载完整性（登记门之外**再做一次显式检查**：这里能给出"下载不完整"这个更准确的失败语义；
  // save 内部还会按 .mp4 判据再验一次，两次都是纯函数、成本可忽略）。
  const integrity = verifyMp4Buffer(downloaded.buffer);
  if (!integrity.ok) {
    log.warn({
      domain: 'artifact',
      event: 'videogen.download-incomplete',
      data: { taskId: input.taskId, reason: integrity.reason, bytes: downloaded.buffer.length },
    });
    return { failure: { code: 'videogen-download-failed' } };
  }

  owner.assertCurrent();
  notifyArtifactActivity(input.onActivity, 'saving-artifacts');
  try {
    const artifact = await saveArtifactFromBuffer({
      workspacePath: input.workspacePath,
      taskId: input.taskId,
      messageId: input.messageId,
      fileName: videoFileNameFor(request),
      buffer: downloaded.buffer,
      artifactType: 'file',
      sourceKey,
    });
    log.info({
      domain: 'artifact',
      event: 'videogen.saved',
      data: { taskId: input.taskId, name: artifact.name, size: artifact.size, resolution: request.resolution },
    });
    return { artifact };
  } catch (error) {
    log.warn({
      domain: 'artifact',
      event: 'videogen.save-failed',
      data: { taskId: input.taskId, error: (error as Error).message },
    });
    return { failure: { code: 'videogen-save-failed' } };
  }
}

export async function generateVideosFromMessage(input: VideogenGenerateInput): Promise<VideogenGenerateResult> {
  const owner = captureArtifactWorkspaceOwner();
  const result: VideogenGenerateResult = { saved: [], failed: [] };
  const { requests, failures } = extractVideogenBlocks(input.content);
  result.failed.push(...failures.map((entry) => entry.failure));
  if (failures.length > 0) {
    getDebugLogger().warn({
      domain: 'artifact',
      event: 'videogen.blocks-invalid',
      data: { taskId: input.taskId, details: failures.map((entry) => entry.detail) },
    });
  }
  if (requests.length === 0) return result;

  // 顺序执行：一个块一段视频，排队比并发诚实（进度可见、上游并发配额也不浪费）。
  for (const request of requests) {
    if (!owner.current()) break;
    const outcome = await runOneRequest(input, request, owner);
    if ('artifact' in outcome) result.saved.push(outcome.artifact);
    else result.failed.push(outcome.failure);
  }
  return result;
}
