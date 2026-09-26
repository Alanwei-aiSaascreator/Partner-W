import { resolvePerformerAgentName } from '@clawwork/shared';
import type { Message, MessageAttachment, IpcResult, ErrorStage, TaskRoom, RoomStatus } from '@clawwork/shared';
import type { GatewayTransportPort, ChatAttachment } from '../ports/gateway-transport.js';
import { buildAppError, formatErrorForUser, formatErrorForToast } from './error-classify.js';
import type { TranslateFn } from './error-classify.js';
import { runManualCompaction } from './compaction-announce.js';
import { describeSendRefusal } from './send-refusal-message.js';
import { decidePermissionPatch } from './computer-access.js';
import type { AppliedPermissionMap, AppliedPermissionMode, ComputerAccessTier } from './computer-access.js';

interface TaskRef {
  id: string;
  gatewayId: string;
  sessionKey: string;
  title: string;
  /** 该任务当前用的模型 —— `/think` 要靠它判断档位支不支持。 */
  model?: string;
  ensemble?: boolean;
}

export interface ChatComposerDeps {
  gateway: Pick<GatewayTransportPort, 'sendMessage' | 'abortChat' | 'patchSession'>;

  getTaskStore: () => {
    tasks: TaskRef[];
    commitPendingTask: () => TaskRef;
    updateTaskTitle: (id: string, title: string) => void;
    updateTaskMetadata: (id: string, meta: { model?: string; modelProvider?: string; thinkingLevel?: string }) => void;
  };

  getMessageStore: () => {
    addMessage: (
      taskId: string,
      role: 'user' | 'system',
      content: string,
      attachments?: MessageAttachment[],
      options?: { persist?: boolean; sessionKey?: string },
    ) => Message;
    removeMessage: (taskId: string, messageId: string) => void;
    setProcessing: (taskId: string, processing: boolean) => void;
    clearMessages: (taskId: string) => void;
    // ⭐ B8 统一出口要用的三个（压缩播报的记账与幂等）
    announceCompactionOnce: (taskId: string, sessionKey: string, episode: number, text: string) => boolean;
    beginCompactionEpisode: (sessionKey: string) => number;
    ensureCompactionEpisode: (sessionKey: string) => number;
  };

  persistMessage: (msg: {
    id: string;
    taskId: string;
    role: string;
    content: string;
    timestamp: string;
    sessionKey?: string;
    attachments?: unknown[];
    toolCalls?: unknown[];
  }) => Promise<unknown>;

  markAbortedByUser: (taskId: string) => void;

  compactSession: (gatewayId: string, sessionKey: string) => Promise<IpcResult>;
  resetSession: (gatewayId: string, sessionKey: string, mode: string) => Promise<IpcResult>;

  getModelProvider?: (gatewayId: string, modelId: string) => string | undefined;

  /**
   * 某模型支持的思考档位（协议 id，顺序即默认优先级）。**拿不准时返回 undefined**。
   *
   * 为什么要这个：`presetThinking` 以前只挡了 `'off'`，**从不校验模型到底支不支持**，
   * 于是任何无效档位都能直达网关，用户看到的是英文报错
   * `thinkingLevel "adaptive" is not supported for clawrouter/qwen3.5-27b`。
   *
   * ⚠️ 必须能区分「确定不支持」（返回数组但不含该值）与「还不知道」（undefined）——
   * 目录还没加载完就把用户选的档位悄悄改掉，比让他看一次报错更糟。
   * 数据源与 `thinking-levels.ts` 的 `thinkingLevelsFor` 是同一份。
   */
  getSupportedThinkingLevels?: (gatewayId: string, modelId: string) => string[] | undefined;
  /**
   * 「电脑操控权限」两档（spec `2026-09-26-computer-access-two-tiers-design.md`）。
   *
   * ⚠️ **不注入 = 这个功能不存在**：发送链上一次 `permissionMode` 都不会发，
   *    与 0.0.35 的行为**逐字节相同**。老宿主（如 pwa）没接这条 dep 是**合法状态**，
   *    不是"忘了接"—— 所以这里用可选字段而不是必填。
   */
  computerAccess?: {
    tier: () => ComputerAccessTier;
    applied: () => AppliedPermissionMap;
    /** ⚠️ **只在 patch 成功之后**才该被调用（失败记账 = 下次不补 = 永久哑掉）。 */
    remember: (sessionKey: string, mode: AppliedPermissionMode) => void;
  };

  getRoomState?: (taskId: string) => TaskRoom | undefined;
  setRoomStatus?: (taskId: string, status: RoomStatus) => void;

  /**
   * `agentId` → 展示名（宿主注入 —— core 不认识网关目录，也不该认识）。
   *
   * 用在给 conductor 那句「用户 @ 了谁」上（见 `resolveMentionNames`）。
   * **拿不准就返回 `undefined`**：调用方会退回房间快照里的名字、再退回裸 agentId ——
   * "取个名字"这件事绝不能影响发消息。
   */
  resolveAgentName?: (taskId: string, agentId: string) => string | undefined;

  translate: TranslateFn;
  onError?: (toast: { title: string; description: string }) => void;
}

export interface SendOptions {
  content: string;
  attachments?: ChatAttachment[];
  messageAttachments?: MessageAttachment[];
  /** Keep an optimistic user message in memory, but persist it only after gateway dispatch succeeds. */
  deferUserMessageUntilSent?: boolean;
  presetModel?: string;
  presetThinking?: string;
  titleHint?: string;
  mentions?: string[];
  mentionAll?: boolean;
}

const SEND_TIMEOUT_MS = 30_000;

/**
 * 决定这次到底该把哪个思考档位发给网关。返回 `null` = **不发**。
 *
 * 三种情形（顺序即优先级）：
 *   1. 没选档位 / 选的是 `off` ⇒ 不发（保持既有行为：`off` 是默认态，不必 patch）
 *   2. 拿不到该模型的能力（目录没加载完）⇒ **照发**，不自作主张替用户改档位
 *   3. 拿得到但**确实不支持** ⇒ 回落到该模型声明的**第一档**（= 它的默认档位），
 *      并且**只改状态、不插系统消息** —— 用户可能正在打字，插消息会打断他。
 *      （与 `useChatSend` 里切模型时那条回落保持同一套语义）
 *
 * 为什么优先信任模型自己的声明而不是某个常量表：档位是**逐模型**的，
 * 客户端写死的表迟早和网关漂开 —— `adaptive` 就是活证据。
 */
function resolveThinkingLevel(
  deps: ChatComposerDeps,
  gatewayId: string,
  modelId: string | undefined,
  requested: string,
): 'ok' | 'unavailable' | { level: string } {
  if (!modelId) return 'ok'; // 拿不到模型就无从校验，保持原样

  const supported = deps.getSupportedThinkingLevels?.(gatewayId, modelId);
  if (!supported) return 'ok'; // 「还不知道」≠「不支持」
  if (supported.includes(requested)) return 'ok';

  const fallback = supported[0];
  if (!fallback || fallback === 'off') return 'unavailable'; // 该模型只有 off ⇒ 没档位可发
  return { level: fallback };
}

/** `send` 路径：返回**实际该发的档位**，`null` = 这次不发 patch。 */
function resolveSupportedThinking(
  deps: ChatComposerDeps,
  task: { gatewayId: string },
  options: SendOptions,
): string | null {
  const requested = options.presetThinking;
  if (!requested || requested === 'off') return null; // off 是默认态，不必 patch

  const verdict = resolveThinkingLevel(deps, task.gatewayId, options.presetModel, requested);
  if (verdict === 'unavailable') return null;
  return verdict === 'ok' ? requested : verdict.level;
}

function resolveMentionTargets(
  room: TaskRoom | undefined,
  mentions: string[] | undefined,
  mentionAll: boolean | undefined,
): string[] {
  if (!room || (!mentions?.length && !mentionAll)) return [];

  if (mentionAll) {
    return [room.conductorSessionKey, ...room.performers.map((p) => p.sessionKey)];
  }

  const targets: string[] = [];
  for (const agentId of mentions!) {
    const performer = room.performers.find((p) => p.agentId === agentId);
    if (performer) targets.push(performer.sessionKey);
  }
  return targets;
}

/**
 * 「用户 @ 了谁」那句话里该写哪个名字（给 conductor 的那句通知）。
 *
 * 为什么不能直接 `mentions.join(', ')`：`mentions` 里是**裸 agentId**
 * （`useChatSend` 传的就是 `agentMentions.map((a) => a.agentId)`）⇒ 模型看到的是
 * `[User directed message to rongying-tpl-78b62899: "…"]`。名字一直是有的
 * （网关目录里就写着「爆款内容教练」，房间快照里还有一份），只是没往这句话里送 ——
 * **人和模型看到的是两个名字**。这是 T-a7 同一家族的第**四**个面
 * （前三个：消息头、团队页、`@` 选择器）。
 *
 * 优先级**不在这里重写** —— 交给 shared 的 `resolvePerformerAgentName`
 * （目录 → 快照 → 裸 id）。宿主注入的 resolver 已经把"目录"那一层封好了。
 *
 * fail-soft：查名字**绝不能炸掉派活**（与 `room-store` 的 `snapshotAgentName` 同口径）——
 * 与档位、模型那几处同一条原则：显示问题不许升级成发不出去。
 */
function resolveMentionNames(
  deps: ChatComposerDeps,
  taskId: string,
  performers: TaskRoom['performers'],
  mentions: string[] | undefined,
): string[] {
  return (mentions ?? []).map((agentId) => {
    const performer = performers.find((p) => p.agentId === agentId);
    let catalogName: string | undefined;
    try {
      catalogName = deps.resolveAgentName?.(taskId, agentId);
    } catch (err) {
      console.warn('[chat-composer] resolveAgentName failed:', err);
    }
    return resolvePerformerAgentName(performer, catalogName ? { name: catalogName } : undefined);
  });
}

export function createChatComposer(deps: ChatComposerDeps) {
  const responseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const sessionToTask = new Map<string, string>();
  const pendingResponseSessions = new Map<string, Set<string>>();

  /**
   * ⚠️ 2026-09-24：**别把拒绝的原因吞掉**。这里原来是一个裸的 `catch { return null }`，
   *    调用方（`send`）于是只能一律报「助手无响应」—— 而「点名要的助手不在本机」是另一回事
   *    （有确定的下一步：换一个助手）。独立复核指出这条 PWA 路径上两句话被压成了一句。
   *    现在把异常原样带出去，由 `describeSendRefusal` 选话。
   */
  function resolveTask(taskId?: string): { task: TaskRef | null; error?: unknown } {
    if (taskId) {
      return { task: deps.getTaskStore().tasks.find((t) => t.id === taskId) ?? null };
    }
    try {
      return { task: deps.getTaskStore().commitPendingTask() };
    } catch (error) {
      return { task: null, error };
    }
  }

  function emitError(
    taskId: string,
    source: 'gateway' | 'local',
    stage: ErrorStage,
    rawMessage: string,
    code?: string,
    details?: Record<string, unknown>,
    sessionKey?: string,
  ): void {
    const store = deps.getMessageStore();
    const appError = buildAppError({ source, stage, rawMessage, code, details });
    store.addMessage(taskId, 'system', formatErrorForUser(appError, deps.translate), undefined, { sessionKey });
    const toast = formatErrorForToast(appError, deps.translate);
    deps.onError?.(toast);
  }

  function clearTimer(taskId: string): void {
    const timer = responseTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      responseTimers.delete(taskId);
    }
    pendingResponseSessions.delete(taskId);
    for (const [sk, tid] of sessionToTask) {
      if (tid === taskId) sessionToTask.delete(sk);
    }
  }

  function notifyResponse(sessionKey: string): void {
    deps.getMessageStore().setProcessing(sessionKey, false);
    const taskId = sessionToTask.get(sessionKey);
    if (!taskId) return;
    sessionToTask.delete(sessionKey);
    const pendingSessions = pendingResponseSessions.get(taskId);
    pendingSessions?.delete(sessionKey);
    if (!pendingSessions || pendingSessions.size === 0) clearTimer(taskId);
  }

  async function send(
    taskId: string | undefined,
    options: SendOptions,
  ): Promise<{ ok: boolean; taskId?: string; partialFailure?: string }> {
    const { task, error: resolveError } = resolveTask(taskId);
    if (!task) {
      deps.onError?.({
        title: deps.translate('errors.stage.send'),
        description: describeSendRefusal(resolveError, deps.translate),
      });
      return { ok: false };
    }

    const store = deps.getMessageStore();
    const pendingUserMessage = store.addMessage(task.id, 'user', options.content, options.messageAttachments, {
      persist: false,
    });
    const rollbackPendingUserMessage = () => {
      if (options.deferUserMessageUntilSent) store.removeMessage(task.id, pendingUserMessage.id);
    };
    let processingSessionKeys: string[] = [];

    if (!task.title && options.titleHint) {
      const title = options.titleHint.slice(0, 30).replace(/\n/g, ' ').trim();
      deps.getTaskStore().updateTaskTitle(task.id, title + (options.titleHint.length > 30 ? '\u2026' : ''));
    }

    try {
      const room = task.ensemble ? deps.getRoomState?.(task.id) : undefined;
      const mentionTargets = resolveMentionTargets(room, options.mentions, options.mentionAll);
      const isMentionSend = mentionTargets.length > 0;
      processingSessionKeys = isMentionSend ? mentionTargets : [task.sessionKey];
      for (const sessionKey of processingSessionKeys) store.setProcessing(sessionKey, true);
      let acceptedMentionTargets = mentionTargets;
      let partialFailure: string | undefined;

      if (!isMentionSend) {
        if (options.presetModel) {
          const modelRes = await deps.gateway.patchSession(task.gatewayId, task.sessionKey, {
            model: options.presetModel,
          });
          if (!modelRes.ok) {
            rollbackPendingUserMessage();
            store.setProcessing(task.sessionKey, false);
            emitError(
              task.id,
              'gateway',
              'send',
              modelRes.error || deps.translate('errors.sendFailed'),
              undefined,
              undefined,
              task.sessionKey,
            );
            return { ok: false, taskId: task.id };
          }
          deps.getTaskStore().updateTaskMetadata(task.id, {
            model: options.presetModel,
            modelProvider: deps.getModelProvider?.(task.gatewayId, options.presetModel),
          });
        }
        // ⚠️ 用户**没**显式选模型时，任务级的那个也必须下发 —— 否则第一条消息一定跑
        //    网关默认，而 composer 显示的是任务级的值，**界面在说谎**（2026-09-14 实机：
        //    composer 显示 deepseek-v4-flash，消息徽章却是 QWEN3.5-27B）。
        //    `chat.send` 不带模型（模型是**会话级**的），所以不钉就没人钉。
        //
        //    与上面 presetModel 的**关键差别**：这里**尽力而为**。用户没显式选过，
        //    钉不上（模型下架/中转不提供）就照发 —— 跑网关默认，徽章会如实显示真实模型；
        //    而"因为一个显示问题把消息卡住"是更坏的失败。
        else if (task.model) {
          const pinned = await deps.gateway.patchSession(task.gatewayId, task.sessionKey, { model: task.model });
          if (!pinned?.ok) {
            console.warn('[chat-composer] pin task model failed:', task.model, pinned?.error);
          }
        }
        // ⚠️ 最后一道关，别再只挡 `'off'`。以前就是这里把无效档位放过去的：
        //    用户/历史状态带着 `adaptive`，网关回英文 400，用户只看到一条看不懂的错。
        const thinkingLevel = resolveSupportedThinking(deps, task, options);
        if (thinkingLevel) {
          const thinkingRes = await deps.gateway.patchSession(task.gatewayId, task.sessionKey, {
            thinkingLevel,
          });
          if (!thinkingRes.ok) {
            rollbackPendingUserMessage();
            store.setProcessing(task.sessionKey, false);
            emitError(
              task.id,
              'gateway',
              'send',
              thinkingRes.error || deps.translate('errors.sendFailed'),
              undefined,
              undefined,
              task.sessionKey,
            );
            return { ok: false, taskId: task.id };
          }
          deps.getTaskStore().updateTaskMetadata(task.id, { thinkingLevel });
        }
        // 「电脑操控权限」两档：开着的档位必须在你说得上话的每个会话里都成立（spec §2.5）。
        // ⚠️ **尽力而为**：失败只 warn、绝不拦住发送（同上面 `task.model` 那条的成例）——
        //    "因为一次权限补刀失败把用户的消息卡住"是更坏的失败。
        if (deps.computerAccess) {
          const mode = decidePermissionPatch({
            tier: deps.computerAccess.tier(),
            sessionKey: task.sessionKey,
            applied: deps.computerAccess.applied(),
          });
          if (mode) {
            const permissionRes = await deps.gateway.patchSession(task.gatewayId, task.sessionKey, {
              permissionMode: mode,
            });
            // ⚠️ **成功了才记账**：失败还记账 ⇒ 下次不补 ⇒ 永久哑掉（有测试按名钉住）。
            if (permissionRes?.ok) deps.computerAccess.remember(task.sessionKey, mode);
            else console.warn('[chat-composer] permission patch failed:', mode, permissionRes?.error);
          }
        }
      }

      if (isMentionSend) {
        const attachments = options.attachments?.length ? options.attachments : undefined;
        const results = await Promise.allSettled(
          mentionTargets.map((sk) => deps.gateway.sendMessage(task.gatewayId, sk, options.content, attachments)),
        );
        acceptedMentionTargets = mentionTargets.filter((_, index) => {
          const result = results[index];
          return result.status === 'fulfilled' && (!result.value || result.value.ok);
        });
        const failures = results.flatMap((result) => {
          if (result.status === 'rejected') return [String(result.reason)];
          if (result.value && !result.value.ok) return [result.value.error ?? deps.translate('errors.sendFailed')];
          return [];
        });
        for (const sessionKey of mentionTargets) {
          if (!acceptedMentionTargets.includes(sessionKey)) store.setProcessing(sessionKey, false);
        }
        if (acceptedMentionTargets.length === 0) {
          rollbackPendingUserMessage();
          emitError(
            task.id,
            'gateway',
            'send',
            failures.join('; ') || deps.translate('errors.sendFailed'),
            undefined,
            undefined,
            task.sessionKey,
          );
          return { ok: false, taskId: task.id };
        }
        if (failures.length > 0) partialFailure = failures.join('; ');

        if (room && !mentionTargets.includes(room.conductorSessionKey)) {
          // 名字走目录优先（见 `resolveMentionNames`）。
          // ⚠️ 这里**不再**有 `?? 'performers'` 那个兜底词：走到这一句时 `mentions` 一定非空
          //    （`mentionAll` 那一支会把 conductor 自己也算进目标 ⇒ 上面的守卫已经返回），
          //    而 `resolveMentionNames` 最差也会给出裸 agentId ⇒ 名字列表不可能为空。
          const targetNames = resolveMentionNames(deps, task.id, room.performers, options.mentions).join(', ');
          const preview = options.content.slice(0, 200);
          deps.gateway
            .sendMessage(
              task.gatewayId,
              room.conductorSessionKey,
              `[User directed message to ${targetNames}: "${preview}"]`,
            )
            .catch((err) => console.error('[chat-composer] conductor sendMessage failed:', err));
        }
      } else {
        const result = await deps.gateway.sendMessage(
          task.gatewayId,
          task.sessionKey,
          options.content,
          options.attachments?.length ? options.attachments : undefined,
        );
        if (result && !result.ok) {
          rollbackPendingUserMessage();
          store.setProcessing(task.sessionKey, false);
          emitError(
            task.id,
            'gateway',
            'send',
            result.error || deps.translate('errors.sendFailed'),
            result.errorCode,
            result.errorDetails,
            task.sessionKey,
          );
          return { ok: false, taskId: task.id };
        }
      }

      clearTimer(task.id);
      const watchKeys = isMentionSend ? acceptedMentionTargets : [task.sessionKey];
      const pendingSessions = new Set(watchKeys);
      pendingResponseSessions.set(task.id, pendingSessions);
      for (const sk of watchKeys) sessionToTask.set(sk, task.id);
      responseTimers.set(
        task.id,
        setTimeout(() => {
          responseTimers.delete(task.id);
          pendingResponseSessions.delete(task.id);
          for (const sk of pendingSessions) {
            sessionToTask.delete(sk);
            store.setProcessing(sk, false);
          }
          const appError = buildAppError({
            source: 'gateway',
            stage: 'lifecycle',
            rawMessage: deps.translate('errors.agentNotResponding'),
          });
          deps
            .getMessageStore()
            .addMessage(task.id, 'system', formatErrorForUser(appError, deps.translate), undefined, {
              sessionKey: task.sessionKey,
            });
        }, SEND_TIMEOUT_MS),
      );

      deps
        .persistMessage({
          id: pendingUserMessage.id,
          taskId: pendingUserMessage.taskId,
          role: pendingUserMessage.role,
          content: pendingUserMessage.content,
          timestamp: pendingUserMessage.timestamp,
          sessionKey: task.sessionKey,
          attachments: pendingUserMessage.attachments as unknown[] | undefined,
          toolCalls: pendingUserMessage.toolCalls,
        })
        .catch((err) => console.error('[chat-composer] persistMessage failed:', err));

      return { ok: true, taskId: task.id, ...(partialFailure ? { partialFailure } : {}) };
    } catch (err) {
      rollbackPendingUserMessage();
      for (const sessionKey of processingSessionKeys) store.setProcessing(sessionKey, false);
      emitError(
        task.id,
        'local',
        'send',
        err instanceof Error ? err.message : String(err),
        undefined,
        undefined,
        task.sessionKey,
      );
      return { ok: false, taskId: task.id };
    }
  }

  async function abort(taskId: string): Promise<void> {
    const task = deps.getTaskStore().tasks.find((t) => t.id === taskId);
    if (!task) return;

    deps.markAbortedByUser(taskId);
    clearTimer(taskId);

    if (!task.ensemble || !deps.getRoomState || !deps.setRoomStatus) {
      await deps.gateway.abortChat(task.gatewayId, task.sessionKey);
      return;
    }

    const room = deps.getRoomState(taskId);
    if (!room || room.status !== 'active') {
      await deps.gateway.abortChat(task.gatewayId, task.sessionKey);
      return;
    }

    deps.setRoomStatus(taskId, 'stopping');

    const allKeys = new Set<string>();
    allKeys.add(room.conductorSessionKey);
    for (const p of room.performers) allKeys.add(p.sessionKey);

    await Promise.allSettled([...allKeys].map((sk) => deps.gateway.abortChat(task.gatewayId, sk)));

    deps.setRoomStatus(taskId, 'stopped');
  }

  /** 统一出口的依赖（B8）：⚠️ 传取值函数而不是快照（兜底在定时器里跑）。 */
  const compactionDeps = { getStore: () => deps.getMessageStore(), translate: deps.translate };

  async function applySlashCommand(
    taskId: string,
    command: 'compact' | 'reset' | 'model' | 'think',
    arg?: string,
  ): Promise<{ ok: boolean; message?: string; error?: string }> {
    const task = deps.getTaskStore().tasks.find((t) => t.id === taskId);
    if (!task) return { ok: false };

    const store = deps.getMessageStore();

    switch (command) {
      case 'compact': {
        const res = await deps.compactSession(task.gatewayId, task.sessionKey);
        if (!res.ok) return { ok: false };

        // ⭐ **不再在这里插消息了**（B8）：从前"RPC 被接受"就被当成了"压缩完成"。
        //    现在只把网关的结论交给统一出口 —— **只认 `compacted === true`**；
        //    若网关的 `sessions.changed` 先到，兜底那次会被幂等挡掉
        //    （见 compaction-announce.ts 的三条硬规矩）。
        await runManualCompaction(
          { ...compactionDeps, compactSession: (gw, sk) => deps.compactSession(gw, sk) },
          { gatewayId: task.gatewayId, sessionKey: task.sessionKey, taskId },
        );
        return { ok: true };
      }
      case 'reset': {
        const res = await deps.resetSession(task.gatewayId, task.sessionKey, 'reset');
        if (res.ok) {
          store.clearMessages(taskId);
          const msg = deps.translate('session.contextReset');
          store.addMessage(taskId, 'system', msg, undefined, { sessionKey: task.sessionKey });
          return { ok: true, message: msg };
        }
        return { ok: false };
      }
      case 'model': {
        if (!arg) return { ok: false };
        const res = await deps.gateway.patchSession(task.gatewayId, task.sessionKey, { model: arg });
        // 带上网关原文：调用方只看到 ok=false 的话，用户就只有一句「发送失败」，
        // 分不清是模型不存在、档位不支持还是网络问题。见 gateway-error-message.ts。
        if (!res.ok) return { ok: false, error: res.error };
        deps.getTaskStore().updateTaskMetadata(taskId, {
          model: arg,
          modelProvider: deps.getModelProvider?.(task.gatewayId, arg),
        });
        return { ok: true };
      }
      case 'think': {
        if (!arg) return { ok: false };
        // ⚠️ `/think` 是**用户手打**的，等于把任意字符串直接送进网关。
        //    以前这里一个字都没校验 —— `/think adaptive` 会照样发出去，
        //    然后用户收到一条英文 400。`send` 那条路径已经收了，
        //    这里不收就只是把同一个洞换个入口。
        const verdict = resolveThinkingLevel(deps, task.gatewayId, task.model, arg);
        if (verdict === 'unavailable') {
          // 造一条**网关原话形状**的错误，好让既有的翻译器把它变成中文
          // （`gateway-error-message.ts` 认这个格式，见那里的正则）。
          return {
            ok: false,
            error: `thinkingLevel "${arg}" is not supported for ${task.model ?? 'this model'} (use off)`,
          };
        }
        const level = verdict === 'ok' ? arg : verdict.level;
        const res = await deps.gateway.patchSession(task.gatewayId, task.sessionKey, { thinkingLevel: level });
        if (!res.ok) return { ok: false, error: res.error };
        deps.getTaskStore().updateTaskMetadata(taskId, { thinkingLevel: level });
        return { ok: true };
      }
    }
  }

  function dispose(): void {
    for (const timer of responseTimers.values()) clearTimeout(timer);
    responseTimers.clear();
    sessionToTask.clear();
    pendingResponseSessions.clear();
  }

  return { send, abort, applySlashCommand, clearTimer, notifyResponse, dispose };
}

export type ChatComposer = ReturnType<typeof createChatComposer>;
