import { createHash } from 'node:crypto';
import type { Artifact, VideogenFailure } from '@clawwork/shared';
import { getDebugLogger } from '../debug/index.js';
import { findReplayArtifact, saveArtifactFromBuffer } from '../artifact/save.js';
import { captureArtifactWorkspaceOwner } from '../artifact/workspace-owner.js';
import { notifyArtifactActivity, type ArtifactActivityCallback } from '../artifact/activity-callback.js';
import { verifyMp4Buffer } from '../artifact/verify.js';
import { extractVideogenBlocks } from './blocks.js';
import type { VideogenRelayClient } from './client.js';
import { readVideogenFirstFrame } from './reference-image.js';
import { resolveVideogenRequestId } from './request-identity.js';
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
  sourceCurrent?: () => boolean;
  pollIntervalMs?: number;
  deadlineMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 用户界面选择的画质档（见 blocks.ts 的 VideogenBlockOptions）。 */
  blockOptions?: import('./blocks.js').VideogenBlockOptions;
  /** 首帧读取的授权路径（用户在**发送那一轮**附的图，见 session-image.ts）。 */
  authorizedAttachmentPaths?: readonly string[];
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

  owner.assertCurrent();
  notifyArtifactActivity(input.onActivity, 'generating-video');
  owner.assertCurrent();

  // ② Seedance 首帧装载（R8-06）：解析出的只是**路径**，创建前必须换成**受信字节**。
  //
  //  · `readVideogenFirstFrame` 已有完整纪律（工作区钉扎 / 越界拒绝 / 坏图拒绝 / 读一致性），
  //    这里只负责在**真实生产入口**调用它 —— 原先它只有定义、零调用，图生视频会被静默
  //    降级成文生视频（r8 独立终审 VV-2）。
  //  · 装载失败 ⇒ **零创建**（一个请求都不发）、可行动错误：绝不"图没用上也照样生成"。
  //  · 失败码用它现有的 `videogen-block-invalid`（"这个请求做不了"）：坏图/越界/缺失文件
  //    的区别进日志（`videogen.reference-rejected` 的 reason），不上屏——界面文案按码本地化，
  //    新增一个专用码要动 shared + 九种语言，不在本次返工范围（已如实上报）。
  let effective = request;
  if (request.model === 'seedance-2.5' && request.firstFrame) {
    try {
      const firstFrameData = await readVideogenFirstFrame({
        workspacePath: input.workspacePath,
        path: request.firstFrame,
        ...(input.authorizedAttachmentPaths ? { authorizedAttachmentPaths: input.authorizedAttachmentPaths } : {}),
      });
      owner.assertCurrent();
      effective = { ...request, firstFrameData };
    } catch (error) {
      log.warn({
        domain: 'artifact',
        event: 'videogen.reference-rejected',
        data: { taskId: input.taskId, reason: (error as Error).message },
      });
      return { failure: { code: 'videogen-block-invalid' } };
    }
  }

  owner.assertCurrent();

  // ③ 稳定逻辑身份（R8-06）：同操作重放/进程重启 ⇒ 同一把 requestId；新操作才是新 id。
  //    只在 Seedance 通道用（H3 的创建体里没有这个字段，传了也无处安放）。
  const requestId =
    request.model === 'seedance-2.5'
      ? resolveVideogenRequestId({ taskId: input.taskId, request: effective })
      : undefined;

  // ④ 工作区切换 ⇒ **零创建**。轮询环里那条同名检查守不住这里：创建是花第一笔钱的点，
  //    必须在它之前判（用户已经切走工作区时，不该再向旧任务投一笔付费创建）。
  if (!owner.current()) {
    log.warn({
      domain: 'artifact',
      event: 'videogen.workspace-changed',
      data: { taskId: input.taskId, phase: 'before-create' },
    });
    return { failure: { code: 'videogen-task-failed', upstreamCode: null } };
  }

  const created = await input.client.create(effective, requestId);
  owner.assertCurrent();
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
    owner.assertCurrent();
    if (queried.status === 'finished') break;
    if (queried.status === 'failed') {
      if (queried.failure.code === 'videogen-task-failed' && queried.failure.upstreamCode === null) {
        // 网络/HTTP 层的查询失败：可能是瞬断。容忍几次再判。
        consecutiveQueryFailures += 1;
        if (consecutiveQueryFailures < VIDEOGEN_QUERY_FAILURE_TOLERANCE) {
          await sleep(pollInterval);
          owner.assertCurrent();
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
    owner.assertCurrent();
  }

  owner.assertCurrent();
  const downloaded = await input.client.download(created.taskId);
  owner.assertCurrent();
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
  owner.assertCurrent();
  try {
    const artifact = await saveArtifactFromBuffer({
      workspacePath: input.workspacePath,
      taskId: input.taskId,
      messageId: input.messageId,
      fileName: videoFileNameFor(request),
      buffer: downloaded.buffer,
      // BUG-120（2026-10-17）：视频登记专属类型 —— 此前记 `'file'`，卡片只能靠 `.mp4` 文件名反推。
      artifactType: 'video',
      sourceKey,
    });
    owner.assertCurrent();
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
  const workspace = captureArtifactWorkspaceOwner();
  const current = () => workspace.current() && (input.sourceCurrent?.() ?? true);
  const owner = {
    current,
    assertCurrent: () => {
      if (!current()) throw new Error('videogen-source-changed');
    },
  };
  const result: VideogenGenerateResult = { saved: [], failed: [] };
  if (!current()) return result;
  const { requests, failures } = extractVideogenBlocks(input.content, input.blockOptions);
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
    try {
      const outcome = await runOneRequest(input, request, owner);
      if (!current()) return { saved: [], failed: [] };
      if ('artifact' in outcome) result.saved.push(outcome.artifact);
      else result.failed.push(outcome.failure);
    } catch (error) {
      if (!current()) return { saved: [], failed: [] };
      throw error;
    }
  }
  return result;
}
