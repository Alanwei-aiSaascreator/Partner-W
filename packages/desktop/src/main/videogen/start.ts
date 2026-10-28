import { createHash } from 'node:crypto';
import { BrowserWindow } from 'electron';
import type { VideogenFailure } from '@clawwork/shared';
import { getDebugLogger } from '../debug/index.js';
import { activeRelayBaseUrl } from '../commercial/relay-config.js';
import { getActiveRelayKey } from '../commercial/relay-key.js';
import { getLicenseGeneration } from '../commercial/license-generation.js';
import { captureArtifactWorkspaceOwner } from '../artifact/workspace-owner.js';
import { getWorkspaceScope } from '../workspace/scope.js';
import { captureArtifactDeliveryOperation } from '../artifact/delivery-operation.js';
import { createVideogenRelayClient } from './client.js';
import { extractVideogenBlocks } from './blocks.js';
import { generateVideosFromMessage } from './generate.js';

/**
 * 视频生成的**后台启动器**（2026-10-12 视频接入）。
 *
 * ## 为什么不能像 docgen/htmlgen 那样在消息收尾路径里同步 await
 *
 * 那三条流水线在本机几秒内完成；视频是**远端付费异步任务**，以分钟计。
 * 在 `ipc/data-handlers.ts` 的消息收尾链里 await 它，会把"消息已完成"的记账、
 * 交付活动帧的终态、驱动侧的空闲判定全部拖住几分钟——历史上"120s idle 误杀整轮"
 * （BUG-014 链上的一课）就是这个形状的故障。
 *
 * ## 这个文件负责的四件事（generate.ts 只管单条请求的生命周期）
 *
 *  1. **进程内去重**：同一归属内 (taskId, messageId) 同时只启动一次，结束后允许持久幂等恢复；
 *  2. **自己的交付活动帧**：`captureArtifactDeliveryOperation` 独立于消息路径那条
 *     （它会被消息路径提前 finish，晚到的视频相位挂不上去）；
 *  3. **relay 凭据解析**：从活网关配置读回 relay key（见 `relayKeyFromConfigSnapshot`），
 *     失败按 `videogen-not-configured` 如实上报，不猜；
 *  4. **终态广播**：`artifact:saved`（每个成品）+ `videogen:failed`（失败集合）+
 *     活动帧 `finish(status)`（成功/失败/部分）。
 *
 * ⚠️ 本模块**只被 `data-handlers.ts` 调用**；不做 IPC handler（没有"手动重试"入口，
 *    重试 = 用户再发一条消息，走同一条链）。
 */

/** Seedance 只记录活跃作业；H3 无持久请求 ID，保留同消息进程内去重。 */
const startedMessages = new Set<string>();

/**
 * 解析直呼 relay 的凭据：基址走受控出口，**key 走内存持有者**
 * （`relay-key.ts`；绝不要从 `gateway.getConfig()` 读 key —— 那里是脱敏占位符，
 * 2026-10-12 的 401 实锤，见 `relay-config.ts` 的历史教训注释）。
 */
function resolveVideogenRelayAuth(): { baseUrl: string; relayKey: string } | null {
  const relayKey = getActiveRelayKey();
  if (!relayKey) return null;
  const baseUrl = activeRelayBaseUrl();
  // 诊断（key 只进 sha12 指纹，明文不出内存）：401 这类"认证层"故障必须能从这里读到
  // "当时解析到哪、用的哪把 key"——2026-10-12 真机 E2E 的排障就是靠它定案。
  getDebugLogger().info({
    domain: 'artifact',
    event: 'videogen.auth-resolved',
    data: { baseUrl, keySha12: createHash('sha256').update(relayKey).digest('hex').slice(0, 12) },
  });
  return { baseUrl, relayKey };
}

function broadcastToWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
}

export interface StartVideogenJobsInput {
  workspacePath: string;
  taskId: string;
  sessionKey: string;
  messageId: string;
  runId?: string;
  content: string;
  sourceCurrent?: () => boolean;
  retainSource?: () => () => void;
  /** 画质档与图生视频首帧（见 blocks.ts / session-image.ts）。 */
  blockOptions?: import('./blocks.js').VideogenBlockOptions;
  authorizedAttachmentPaths?: readonly string[];
}

/**
 * 启动（脱离调用栈的）视频生成作业。**同步返回**，立即让出消息收尾路径。
 */
export function startVideogenJobs(input: StartVideogenJobsInput): void {
  const generation = getLicenseGeneration();
  const relayKey = getActiveRelayKey();
  const workspace = captureArtifactWorkspaceOwner();
  const current = () =>
    workspace.current() &&
    (input.sourceCurrent?.() ?? true) &&
    generation === getLicenseGeneration() &&
    relayKey === getActiveRelayKey();
  if (!current()) return;
  // 没有 videogen 块的消息什么都不做 —— 不建活动帧、不推失败（否则每条普通消息
  // 都会长出一个多余的"生成视频"活动记录）。
  const gate = extractVideogenBlocks(input.content, input.blockOptions);
  if (gate.requests.length === 0 && gate.failures.length === 0) return;
  const legacyRequest = gate.requests.some((request) => request.model !== 'seedance-2.5');

  const dedupeKey = `${generation}:${getWorkspaceScope().revision}:${input.taskId}:${input.messageId}`;
  if (startedMessages.has(dedupeKey)) return;

  const operation = captureArtifactDeliveryOperation({
    taskId: input.taskId,
    sessionKey: input.sessionKey,
    messageId: input.messageId,
    runId: input.runId,
  });

  startedMessages.add(dedupeKey);
  void (async () => {
    const log = getDebugLogger();
    let releaseSource: (() => void) | undefined;
    try {
      releaseSource = input.retainSource?.();
      const auth = resolveVideogenRelayAuth();
      if (!current()) {
        operation.finish('canceled');
        return;
      }
      if (!auth) {
        log.warn({ domain: 'artifact', event: 'videogen.not-configured', data: { taskId: input.taskId } });
        operation.phase('generating-video');
        operation.finish('failed');
        broadcastToWindows('videogen:failed', [{ code: 'videogen-not-configured' }] satisfies VideogenFailure[]);
        return;
      }

      const client = createVideogenRelayClient(auth);
      const result = await generateVideosFromMessage({
        workspacePath: input.workspacePath,
        taskId: input.taskId,
        messageId: input.messageId,
        content: input.content,
        blockOptions: input.blockOptions,
        ...(input.authorizedAttachmentPaths ? { authorizedAttachmentPaths: input.authorizedAttachmentPaths } : {}),
        client,
        onActivity: (phase, progress) => {
          if (current()) operation.phase(phase, progress);
        },
        sourceCurrent: current,
      });

      if (!current()) {
        operation.finish('canceled');
        return;
      }
      for (const artifact of result.saved) {
        if (!current()) {
          operation.finish('canceled');
          return;
        }
        broadcastToWindows('artifact:saved', artifact);
      }
      if (!current()) {
        operation.finish('canceled');
        return;
      }
      if (result.failed.length > 0) broadcastToWindows('videogen:failed', result.failed);

      // 终态：全成 ⇒ succeeded；全败 ⇒ failed；有成有败 ⇒ needs-review（如实的中间态）。
      const unconfirmed = result.failed.some(
        (failure) =>
          failure.code === 'videogen-billing-pending' ||
          failure.code === 'videogen-timeout' ||
          (failure.code === 'videogen-task-failed' && failure.upstreamCode === null) ||
          (failure.code === 'videogen-create-failed' &&
            (failure.httpStatus === 0 || failure.httpStatus === 409 || failure.httpStatus >= 500)),
      );
      operation.finish(
        unconfirmed
          ? 'needs-review'
          : result.failed.length === 0
            ? 'succeeded'
            : result.saved.length === 0
              ? 'failed'
              : 'needs-review',
      );
    } catch (error) {
      if (!current()) {
        operation.finish('canceled');
        return;
      }
      // generate.ts 自己不抛；能到这里的是启动器自己的意外（配置解析之后、结果之外）。
      log.warn({
        domain: 'artifact',
        event: 'videogen.start-failed',
        data: { taskId: input.taskId, error: (error as Error).message },
      });
      operation.phase('generating-video');
      operation.finish('failed');
      broadcastToWindows('videogen:failed', [{ code: 'videogen-save-failed' }] satisfies VideogenFailure[]);
    } finally {
      if (!legacyRequest) startedMessages.delete(dedupeKey);
      releaseSource?.();
    }
  })();
}
