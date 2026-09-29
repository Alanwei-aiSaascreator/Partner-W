import { createHash } from 'node:crypto';
import { ipcMain } from 'electron';
import { getGatewayClient, getAllGatewayClients, reconnectGateway } from '../ws/index.js';
import { readConfig, ensureDeviceId } from '../workspace/config.js';
import { isClawWorkSession, parseTaskIdFromSessionKey, parseAgentIdFromSessionKey } from '@clawwork/shared';
import { normalizeContentBlocks, parseToolArgs } from '@clawwork/core';
import type {
  ApprovalDecision,
  ChatAttachment,
  CommandsListParams,
  ConfigPatchParams,
  ConfigSetParams,
  ExecApprovalResolveParams,
  QuestionResolveParams,
  SkillInstallParams,
  SkillSearchParams,
  SkillUpdateParams,
} from '@clawwork/shared';
import { getDebugLogger } from '../debug/index.js';
import { trackChatSent } from '../analytics/reporter.js';
import type { GatewayClient } from '../ws/gateway-client.js';
import {
  beginArtifactRunForGatewayDispatch,
  bindArtifactRun,
  cancelArtifactRun,
  cancelArtifactRunsForSession,
} from './data-handlers.js';

async function gatewayRpc(
  gatewayId: string,
  fn: (gw: GatewayClient) => Promise<Record<string, unknown> | void>,
): Promise<{
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
  errorCode?: string;
  errorDetails?: Record<string, unknown>;
}> {
  const gw = getGatewayClient(gatewayId);
  if (!gw?.isConnected) return { ok: false, error: 'gateway not connected', errorCode: 'GATEWAY_NOT_CONNECTED' };
  try {
    const result = await fn(gw);
    return result ? { ok: true, result } : { ok: true };
  } catch (err) {
    const typed = err as Error & { code?: string; details?: Record<string, unknown> };
    return {
      ok: false,
      error: typed.message ?? 'unknown error',
      errorCode: typed.code,
      errorDetails: typed.details,
    };
  }
}

interface GatewaySessionRow {
  key: string;
  sessionId?: string;
  updatedAt: number | null;
  derivedTitle?: string;
  label?: string;
  displayName?: string;
  model?: string;
  modelProvider?: string;
  thinkingLevel?: string;
  reasoningLevel?: string;
  fastMode?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextTokens?: number;
}

interface SessionsListPayload {
  sessions?: GatewaySessionRow[];
}

interface RawContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  url?: string;
  openUrl?: string;
  alt?: string;
  mimeType?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown> | string;
  result?: unknown;
}

/**
 * `chat.history` 的 `content` 是**多态**的 —— 实测（2026-09-14，`discovery-probe`）：
 *
 * ```
 * role=user       content = "你好"          ← 纯字符串
 * role=assistant  content = [{type:'text'}] ← 块数组
 * ```
 *
 * 之前这里**只**声明成块数组，运行时拿 user 消息一 `.filter` 就抛
 * `(m.content ?? []).filter is not a function`，而外层 catch 会因此
 * **整个网关的会话全部归零**（`discovered=0`，线上潜伏很久）。
 *
 * 类型必须如实表达多态，别再用断言把它强行写成数组。
 * OpenClaw 没有随包发布 `.d.ts`（实测 node_modules 里没有），所以这里用最小本地
 * union，不去引一套外部类型体系。
 */
type RawMessageContent = string | RawContentBlock[] | null | undefined;

interface ChatHistoryMessage {
  role: string;
  /** 实际生成这条回复的模型。**只有 assistant 记录带**（实测网关 transcript）。 */
  model?: string;
  content: RawMessageContent;
  timestamp?: number;
}

interface ChatHistoryPayload {
  messages?: ChatHistoryMessage[];
  sessionId?: string;
}

/**
 * 把多态的 `content` 归一成**块数组**，让下游可以放心 `.filter` / `.map`。
 *
 * 规则（刻意显式，不猜）：
 *   - 字符串 ⇒ 合成一个 `{type:'text'}` 块（**不能**丢，user 消息的正文就在这里）
 *   - 数组   ⇒ 原样返回
 *   - null/undefined ⇒ `[]`（空内容，不是错误）
 *   - 其它未知形状 ⇒ `[]` + 记一条日志，**fail-soft**
 *
 * ⚠️ **不要**用 `String(content)` 兜底：对象会被转成 `"[object Object]"` 并污染历史。
 * ⚠️ 只对**非数组对象**告警。`content` 声明成 `unknown` 是有意的 —— 网关送来的东西
 *    不受我们控制，类型系统在这里保证不了什么，运行时兜底才是真的。
 */
function normalizeMessageContent(content: unknown): RawContentBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (Array.isArray(content)) {
    // ⚠️ 元素也要挡一层：`Array.isArray` 只保证外层是数组，**不保证元素是对象**。
    //    `['x', {type:'text'}]` 这种混合数组若直接 `as RawContentBlock[]`，
    //    下游 `b.type` 又会炸 —— 同一个 bug 换个形状回来。
    return content.filter((b): b is RawContentBlock => typeof b === 'object' && b !== null);
  }
  if (content === null || content === undefined) return [];
  getDebugLogger().warn({
    domain: 'ipc',
    event: 'ipc.ws.sync-sessions.unknown-content-shape',
    data: { shape: typeof content },
  });
  return [];
}

const INTERNAL_ASSISTANT_MARKERS = new Set(['NO_REPLY']);
const RELATIVE_GATEWAY_MEDIA_PATH_RE = /^\/(?:api\/chat\/media\/outgoing\/|media\/|__openclaw__\/media\/)/;

/** Parsed tool call for transport to renderer */
interface ParsedToolCall {
  id: string;
  name: string;
  status: 'running' | 'done' | 'error';
  args?: Record<string, unknown>;
  result?: string;
  startedAt: string;
  completedAt?: string;
}

function resolveRelativeImageUrls(messages: Record<string, unknown>[], httpBase: string): void {
  for (const msg of messages) {
    const blocks = msg.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (typeof block !== 'object' || block === null) continue;
      const imageBlock = block as Record<string, unknown>;
      if (imageBlock.type !== 'image') continue;
      if (typeof imageBlock.url === 'string' && RELATIVE_GATEWAY_MEDIA_PATH_RE.test(imageBlock.url)) {
        imageBlock.url = new URL(imageBlock.url, httpBase).toString();
      }
      if (typeof imageBlock.openUrl === 'string' && RELATIVE_GATEWAY_MEDIA_PATH_RE.test(imageBlock.openUrl)) {
        imageBlock.openUrl = new URL(imageBlock.openUrl, httpBase).toString();
      }
    }
  }
}

export function registerWsHandlers(): void {
  ipcMain.handle('ws:get-http-base', async (_event, payload: { gatewayId: string }) => {
    const gw = getGatewayClient(payload.gatewayId);
    return gw?.httpBase;
  });

  ipcMain.handle(
    'ws:send-message',
    async (
      _event,
      payload: {
        gatewayId: string;
        sessionKey: string;
        content: string;
        attachments?: ChatAttachment[];
      },
    ) => {
      const taskId = parseTaskIdFromSessionKey(payload.sessionKey) ?? undefined;
      getDebugLogger().info({
        domain: 'ipc',
        event: 'ipc.ws.send-message.requested',
        gatewayId: payload.gatewayId,
        sessionKey: payload.sessionKey,
        taskId,
        data: { contentLength: payload.content.length, attachmentCount: payload.attachments?.length ?? 0 },
      });
      const gw = getGatewayClient(payload.gatewayId);
      if (!gw?.isConnected) {
        getDebugLogger().error({
          domain: 'ipc',
          event: 'ipc.ws.send-message.failed',
          gatewayId: payload.gatewayId,
          sessionKey: payload.sessionKey,
          taskId,
          error: { message: 'gateway not connected' },
        });
        return { ok: false, error: 'gateway not connected', errorCode: 'GATEWAY_NOT_CONNECTED' };
      }
      let artifactRunToken: string | null = null;
      if (taskId) {
        try {
          artifactRunToken = beginArtifactRunForGatewayDispatch({
            gatewayId: payload.gatewayId,
            sessionKey: payload.sessionKey,
            taskId,
            userContent: payload.content,
          });
        } catch (error) {
          getDebugLogger().error({
            domain: 'artifact',
            event: 'artifact.run.begin-failed',
            gatewayId: payload.gatewayId,
            sessionKey: payload.sessionKey,
            taskId,
            error: { message: error instanceof Error ? error.message : String(error) },
          });
        }
      }
      try {
        const sendResult = await gw.sendChatMessage(payload.sessionKey, payload.content, payload.attachments);
        if (taskId && artifactRunToken && typeof sendResult?.runId === 'string') {
          bindArtifactRun(taskId, payload.sessionKey, artifactRunToken, sendResult.runId);
        }
        getDebugLogger().info({
          domain: 'ipc',
          event: 'ipc.ws.send-message.completed',
          gatewayId: payload.gatewayId,
          sessionKey: payload.sessionKey,
          taskId,
          ok: true,
        });
        // 到这一行说明消息**真的发出去了**（失败从下面的 catch 返回）。
        // 埋点绝不 await、绝不改返回值 —— 它对这条路径必须完全透明。
        trackChatSent();
        return { ok: true };
      } catch (err) {
        if (taskId && artifactRunToken) cancelArtifactRun(taskId, payload.sessionKey, artifactRunToken);
        const typed = err as Error & { code?: string; details?: Record<string, unknown> };
        const msg = typed.message ?? 'unknown error';
        getDebugLogger().error({
          domain: 'ipc',
          event: 'ipc.ws.send-message.failed',
          gatewayId: payload.gatewayId,
          sessionKey: payload.sessionKey,
          taskId,
          error: { message: msg, code: typed.code },
        });
        return { ok: false, error: msg, errorCode: typed.code, errorDetails: typed.details };
      }
    },
  );

  ipcMain.handle(
    'ws:chat-history',
    async (
      _event,
      payload: {
        gatewayId: string;
        sessionKey: string;
        limit?: number;
      },
    ) => {
      const gw = getGatewayClient(payload.gatewayId);
      if (!gw?.isConnected) {
        return { ok: false, error: 'gateway not connected' };
      }
      try {
        const result = (await gw.getChatHistory(payload.sessionKey, payload.limit)) as Record<string, unknown> & {
          messages?: Record<string, unknown>[];
        };
        if (result?.messages?.length) {
          resolveRelativeImageUrls(result.messages, gw.httpBase);
        }
        return { ok: true, result };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle(
    'ws:list-sessions',
    async (
      _event,
      payload: {
        gatewayId: string;
      },
    ) => {
      const gw = getGatewayClient(payload.gatewayId);
      if (!gw?.isConnected) {
        return { ok: false, error: 'gateway not connected' };
      }
      try {
        const result = await gw.listSessions();
        return { ok: true, result };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle('ws:list-sessions-by-spawner', async (_event, payload: { gatewayId: string; spawnedBy: string }) => {
    const { spawnedBy } = payload;
    if (!spawnedBy || typeof spawnedBy !== 'string' || spawnedBy.length === 0) {
      return { ok: false, error: 'invalid spawnedBy parameter' };
    }
    const gw = getGatewayClient(payload.gatewayId);
    if (!gw?.isConnected) return { ok: false, error: 'gateway not connected' };
    try {
      const result = await gw.listSessionsBySpawner(spawnedBy);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
    }
  });

  ipcMain.handle(
    'ws:create-session',
    async (_event, payload: { gatewayId: string; key: string; agentId: string; message?: string }) => {
      const gw = getGatewayClient(payload.gatewayId);
      if (!gw?.isConnected) return { ok: false, error: 'gateway not connected' };
      try {
        const result = await gw.createSession({
          key: payload.key,
          agentId: payload.agentId,
          message: payload.message,
        });
        return { ok: true, result };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
      }
    },
  );

  ipcMain.handle('ws:gateway-status', () => {
    const clients = getAllGatewayClients();
    const statusMap: Record<string, { connected: boolean; name: string; error?: string; serverVersion?: string }> = {};
    for (const [id, client] of clients) {
      statusMap[id] = {
        connected: client.isConnected,
        name: client.name,
        error: client.lastConnectionError ?? undefined,
        serverVersion: client.version,
      };
    }
    return statusMap;
  });

  ipcMain.handle('ws:sync-sessions', async () => {
    const clients = getAllGatewayClients();
    getDebugLogger().info({
      domain: 'ipc',
      event: 'ipc.ws.sync-sessions.started',
      data: { gatewayCount: clients.size },
    });

    const discovered: {
      gatewayId: string;
      taskId: string;
      sessionKey: string;
      title: string;
      updatedAt: string;
      agentId: string;
      model?: string;
      modelProvider?: string;
      thinkingLevel?: string;
      inputTokens?: number;
      outputTokens?: number;
      contextTokens?: number;
      messages: {
        role: string;
        content: string;
        timestamp: string;
        attachments?: unknown[];
        toolCalls: ParsedToolCall[];
        /** 这条回复实际由哪个模型生成（逐条来自网关）。 */
        model?: string;
      }[];
    }[] = [];

    for (const [gatewayId, gw] of clients) {
      if (!gw.isConnected) continue;
      try {
        const deviceId = ensureDeviceId();
        const raw = (await gw.listSessions()) as unknown as SessionsListPayload;
        const allSessions = raw.sessions ?? [];
        const ours = allSessions.filter((s) => isClawWorkSession(s.key, deviceId));

        // ⚠️ **session 级的隔离边界**：`sessions.list` 属于 gateway 级
        //    （失败 ⇒ 上面那个 catch ⇒ `gateway-failed`，该网关整体作废，合理）；
        //    而**单条**会话的 `chat.history` / 解析 / 组装失败**只该丢它自己**。
        //
        //    之前这两层共用一个 try，于是一条坏会话会把**整个网关**的会话全部清零
        //    —— 表现就是 `discovered=0` 且不报错（实测：user 消息 content 是字符串时
        //    在 `.filter` 上抛，见 `normalizeMessageContent` 的注释）。
        for (const s of ours) {
          const taskId = parseTaskIdFromSessionKey(s.key);
          if (!taskId) continue;

          try {
            const historyRaw = (await gw.getChatHistory(s.key, 200)) as unknown as ChatHistoryPayload;
            const rawMsgs = historyRaw.messages ?? [];

            const toolResultMap = new Map<string, string>();
            for (const m of rawMsgs) {
              if (m.role === 'toolResult') {
                for (const b of normalizeMessageContent(m.content)) {
                  if (b.type === 'toolResult' && b.id && b.result !== undefined) {
                    toolResultMap.set(b.id, typeof b.result === 'string' ? b.result : JSON.stringify(b.result));
                  }
                }
              }
            }

            const msgs = rawMsgs
              .filter((m) => m.role === 'user' || m.role === 'assistant')
              .map((m) => {
                // ⭐ 先归一：user 是字符串、assistant 是块数组（见 RawMessageContent 注释）。
                const blocks = normalizeMessageContent(m.content);

                const normalizedContent =
                  m.role === 'assistant'
                    ? normalizeContentBlocks(blocks, gw.httpBase)
                    : {
                        content: blocks
                          .filter((b) => b.type === 'text' && b.text)
                          .map((b) => b.text!)
                          .join(''),
                      };

                const toolCalls: ParsedToolCall[] = blocks
                  .filter((b) => b.type === 'toolCall' && b.id && b.name)
                  .map((b) => {
                    const tcId = b.id!;
                    const resultText = toolResultMap.get(tcId);
                    return {
                      id: tcId,
                      name: b.name!,
                      status: (resultText !== undefined ? 'done' : 'running') as ParsedToolCall['status'],
                      args:
                        typeof b.arguments === 'object' && b.arguments !== null
                          ? (b.arguments as Record<string, unknown>)
                          : typeof b.arguments === 'string'
                            ? parseToolArgs(b.arguments)
                            : undefined,
                      result: resultText,
                      startedAt: m.timestamp ? new Date(m.timestamp).toISOString() : new Date().toISOString(),
                      completedAt:
                        resultText !== undefined
                          ? m.timestamp
                            ? new Date(m.timestamp).toISOString()
                            : new Date().toISOString()
                          : undefined,
                    };
                  });

                return {
                  role: m.role,
                  content: normalizedContent.content,
                  attachments: normalizedContent.attachments,
                  timestamp: m.timestamp ? new Date(m.timestamp).toISOString() : new Date().toISOString(),
                  toolCalls,
                  // 逐条透传：网关每条 assistant 记录都带它（实测），user 记录没有。
                  model: m.model,
                };
              })
              .filter((m) => {
                if (!m.content && m.toolCalls.length === 0 && !m.attachments?.length) return false;
                if (m.role === 'assistant' && INTERNAL_ASSISTANT_MARKERS.has(m.content.trim())) return false;
                return true;
              });

            const firstUserMsg = msgs.find((m) => m.role === 'user' && m.content);
            const titleFromMsg = firstUserMsg ? firstUserMsg.content.slice(0, 30) : '';

            discovered.push({
              gatewayId,
              taskId,
              sessionKey: s.key,
              title: s.derivedTitle ?? s.label ?? titleFromMsg,
              updatedAt: s.updatedAt ? new Date(s.updatedAt).toISOString() : new Date().toISOString(),
              agentId: parseAgentIdFromSessionKey(s.key),
              model: s.model,
              modelProvider: s.modelProvider,
              thinkingLevel: s.thinkingLevel,
              inputTokens: s.inputTokens,
              outputTokens: s.outputTokens,
              contextTokens: s.contextTokens,
              messages: msgs,
            });
          } catch (err) {
            // 只丢这一条，**继续处理同网关的其它会话**。
            // ⚠️ 日志不带正文；session 标识用哈希截断，不落原文 key。
            const msg = err instanceof Error ? err.message : 'unknown error';
            getDebugLogger().error({
              domain: 'ipc',
              event: 'ipc.ws.sync-sessions.session-failed',
              gatewayId,
              // session 标识只出哈希截断 —— 不落 session key 原文
              data: { sessionKeyHash: createHash('sha256').update(s.key).digest('hex').slice(0, 8) },
              error: { message: msg },
            });
          }
        }
      } catch (err) {
        // ⚠️ 走到这里才真的是 **gateway 级**失败（连接 / `sessions.list` / `ensureDeviceId`）。
        const msg = err instanceof Error ? err.message : 'unknown error';
        getDebugLogger().error({
          domain: 'ipc',
          event: 'ipc.ws.sync-sessions.gateway-failed',
          gatewayId,
          error: { message: msg },
        });
      }
    }

    getDebugLogger().info({
      domain: 'ipc',
      event: 'ipc.ws.sync-sessions.completed',
      data: { discoveredCount: discovered.length },
    });
    return { ok: true, discovered };
  });

  ipcMain.handle('ws:models-list', async (_event, payload: { gatewayId: string }) => {
    const gw = getGatewayClient(payload.gatewayId);
    if (!gw?.isConnected) return { ok: false, error: 'gateway not connected' };
    try {
      const result = await gw.listModels();
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
    }
  });

  ipcMain.handle('ws:commands-list', async (_event, payload: { gatewayId: string } & CommandsListParams) => {
    const gw = getGatewayClient(payload.gatewayId);
    if (!gw?.isConnected) return { ok: false, error: 'gateway not connected' };
    const params: Record<string, unknown> = {
      scope: payload.scope ?? 'text',
      includeArgs: payload.includeArgs ?? true,
    };
    if (payload.agentId) params.agentId = payload.agentId;
    if (payload.provider) params.provider = payload.provider;
    try {
      const result = await gw.listCommands(params);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
    }
  });

  ipcMain.handle('ws:agents-list', async (_event, payload: { gatewayId: string }) =>
    gatewayRpc(payload.gatewayId, (gw) => gw.listAgents()),
  );

  ipcMain.handle(
    'ws:agents-create',
    async (_event, payload: { gatewayId: string; name: string; workspace: string; emoji?: string; avatar?: string }) =>
      gatewayRpc(payload.gatewayId, (gw) =>
        gw.createAgent({
          name: payload.name,
          workspace: payload.workspace,
          emoji: payload.emoji,
          avatar: payload.avatar,
        }),
      ),
  );

  ipcMain.handle(
    'ws:agents-update',
    async (
      _event,
      payload: {
        gatewayId: string;
        agentId: string;
        name?: string;
        workspace?: string;
        model?: string;
        avatar?: string;
      },
    ) =>
      gatewayRpc(payload.gatewayId, (gw) =>
        gw.updateAgent({
          agentId: payload.agentId,
          name: payload.name,
          workspace: payload.workspace,
          model: payload.model,
          avatar: payload.avatar,
        }),
      ),
  );

  ipcMain.handle(
    'ws:agents-delete',
    async (_event, payload: { gatewayId: string; agentId: string; deleteFiles?: boolean }) =>
      gatewayRpc(payload.gatewayId, (gw) =>
        gw.deleteAgent({ agentId: payload.agentId, deleteFiles: payload.deleteFiles }),
      ),
  );

  ipcMain.handle('ws:agents-files-list', async (_event, payload: { gatewayId: string; agentId: string }) =>
    gatewayRpc(payload.gatewayId, (gw) => gw.listAgentFiles(payload.agentId)),
  );

  ipcMain.handle('ws:agents-files-get', async (_event, payload: { gatewayId: string; agentId: string; name: string }) =>
    gatewayRpc(payload.gatewayId, (gw) => gw.getAgentFile(payload.agentId, payload.name)),
  );

  ipcMain.handle(
    'ws:agents-files-set',
    async (_event, payload: { gatewayId: string; agentId: string; name: string; content: string }) =>
      gatewayRpc(payload.gatewayId, (gw) => gw.setAgentFile(payload.agentId, payload.name, payload.content)),
  );

  ipcMain.handle(
    'ws:session-patch',
    async (
      _event,
      payload: {
        gatewayId: string;
        sessionKey: string;
        patch: Record<string, unknown>;
      },
    ) => {
      const gw = getGatewayClient(payload.gatewayId);
      if (!gw?.isConnected) return { ok: false, error: 'gateway not connected' };
      try {
        const result = await gw.patchSession({ key: payload.sessionKey, ...payload.patch });
        return { ok: true, result };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle('ws:list-gateways', async () => {
    const config = readConfig();
    const clients = getAllGatewayClients();
    return (config?.gateways ?? []).map((gw) => ({
      ...gw,
      connected: clients.get(gw.id)?.isConnected ?? false,
    }));
  });

  ipcMain.handle('ws:abort-chat', async (_event, payload: { gatewayId: string; sessionKey: string }) => {
    cancelArtifactRunsForSession(payload.sessionKey);
    const gw = getGatewayClient(payload.gatewayId);
    if (!gw?.isConnected) return { ok: false, error: 'gateway not connected' };
    try {
      await gw.abortChat(payload.sessionKey);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle(
    'ws:tools-catalog',
    async (
      _event,
      payload: {
        gatewayId: string;
        agentId?: string;
      },
    ) => gatewayRpc(payload.gatewayId, (gw) => gw.getToolsCatalog(payload.agentId)),
  );

  ipcMain.handle(
    'ws:tools-effective',
    async (
      _event,
      payload: {
        gatewayId: string;
        sessionKey: string;
        agentId?: string;
      },
    ) => gatewayRpc(payload.gatewayId, (gw) => gw.getEffectiveTools(payload.sessionKey, payload.agentId)),
  );

  ipcMain.handle(
    'ws:skills-status',
    async (
      _event,
      payload: {
        gatewayId: string;
        agentId?: string;
      },
    ) => gatewayRpc(payload.gatewayId, (gw) => gw.getSkillsStatus(payload.agentId)),
  );

  ipcMain.handle('ws:skills-search', async (_event, payload: { gatewayId: string } & SkillSearchParams) => {
    const { gatewayId, ...params } = payload;
    return gatewayRpc(gatewayId, (gw) => gw.searchSkills(params));
  });

  ipcMain.handle('ws:skills-detail', async (_event, payload: { gatewayId: string; slug: string }) =>
    gatewayRpc(payload.gatewayId, (gw) => gw.getSkillDetail(payload.slug)),
  );

  ipcMain.handle('ws:skills-install', async (_event, payload: { gatewayId: string } & SkillInstallParams) => {
    const { gatewayId, ...params } = payload;
    return gatewayRpc(gatewayId, (gw) => gw.installSkill(params));
  });

  ipcMain.handle('ws:skills-update', async (_event, payload: { gatewayId: string } & SkillUpdateParams) => {
    const { gatewayId, ...params } = payload;
    return gatewayRpc(gatewayId, (gw) => gw.updateSkill(params));
  });

  ipcMain.handle('ws:skills-bins', async (_event, payload: { gatewayId: string }) =>
    gatewayRpc(payload.gatewayId, (gw) => gw.getSkillBins()),
  );

  ipcMain.handle('ws:config-get', async (_event, payload: { gatewayId: string }) =>
    gatewayRpc(payload.gatewayId, (gw) => gw.getConfig()),
  );

  ipcMain.handle('ws:config-set', async (_event, payload: { gatewayId: string } & ConfigSetParams) => {
    const { gatewayId, ...params } = payload;
    return gatewayRpc(gatewayId, (gw) => gw.setConfig(params));
  });

  ipcMain.handle('ws:config-patch', async (_event, payload: { gatewayId: string } & ConfigPatchParams) => {
    const { gatewayId, ...params } = payload;
    return gatewayRpc(gatewayId, (gw) => gw.patchConfig(params));
  });

  ipcMain.handle('ws:config-schema', async (_event, payload: { gatewayId: string }) =>
    gatewayRpc(payload.gatewayId, (gw) => gw.getConfigSchema()),
  );

  ipcMain.handle('ws:config-schema-lookup', async (_event, payload: { gatewayId: string; path: string }) =>
    gatewayRpc(payload.gatewayId, (gw) => gw.lookupConfigSchema(payload.path)),
  );

  ipcMain.handle('ws:usage-status', async (_event, payload: { gatewayId: string }) =>
    gatewayRpc(payload.gatewayId, (gw) => gw.getUsageStatus()),
  );

  ipcMain.handle(
    'ws:session-preview',
    async (
      _event,
      payload: {
        gatewayId: string;
        keys: string[];
        limit?: number;
        maxChars?: number;
      },
    ) => {
      const { gatewayId, keys, limit, maxChars } = payload;
      if (!keys.length) return { ok: false, error: 'no session keys provided' };
      return gatewayRpc(gatewayId, (gw) => gw.previewSessions({ keys, limit, maxChars }));
    },
  );

  ipcMain.handle(
    'ws:question-resolve',
    async (
      _event,
      payload: {
        gatewayId: string;
        params: QuestionResolveParams;
      },
      // 参数原样透传：网关 schema 是 closedObject（多/少字段都会被拒），
      // 所以这里**不做任何包装或裁剪**，拼装责任在 core 的 buildQuestion*Params。
    ) =>
      gatewayRpc(payload.gatewayId, (gw) =>
        gw.sendReq('question.resolve', payload.params as unknown as Record<string, unknown>),
      ),
  );

  /**
   * 重连 / 重启后捞回仍在挂起的问题。
   * 少了这一步，进程重启期间创建的问题在客户端不可见，用户下一条消息又会被网关
   * 当成「答案」吞掉（就是 2026-09-17 那次锁死的窄窗口版本）。
   */
  ipcMain.handle('ws:question-list', async (_event, payload: { gatewayId: string }) =>
    gatewayRpc(payload.gatewayId, (gw) => gw.sendReq('question.list', {})),
  );

  ipcMain.handle(
    'ws:exec-approval-resolve',
    async (
      _event,
      payload: ExecApprovalResolveParams & {
        gatewayId: string;
      },
    ) => {
      const gw = getGatewayClient(payload.gatewayId);
      if (!gw?.isConnected) return { ok: false, error: 'gateway not connected' };
      try {
        await gw.sendReq('exec.approval.resolve', {
          id: payload.id,
          decision: payload.decision as ApprovalDecision,
        });
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle(
    'ws:session-reset',
    async (
      _event,
      payload: {
        gatewayId: string;
        sessionKey: string;
        reason?: 'new' | 'reset';
      },
    ) => {
      cancelArtifactRunsForSession(payload.sessionKey);
      const gw = getGatewayClient(payload.gatewayId);
      if (!gw?.isConnected) return { ok: false, error: 'gateway not connected' };
      try {
        await gw.resetSession(payload.sessionKey, payload.reason);
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle(
    'ws:session-delete',
    async (
      _event,
      payload: {
        gatewayId: string;
        sessionKey: string;
      },
    ) => {
      cancelArtifactRunsForSession(payload.sessionKey);
      const gw = getGatewayClient(payload.gatewayId);
      if (!gw?.isConnected) return { ok: false, error: 'gateway not connected' };
      try {
        await gw.deleteSession(payload.sessionKey, true);
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle(
    'ws:session-compact',
    async (
      _event,
      payload: {
        gatewayId: string;
        sessionKey: string;
        maxLines?: number;
      },
    ) => {
      const gw = getGatewayClient(payload.gatewayId);
      if (!gw?.isConnected) return { ok: false, error: 'gateway not connected' };
      try {
        const raw = (await gw.compactSession(payload.sessionKey, payload.maxLines)) as {
          compacted?: unknown;
          reason?: unknown;
          kept?: unknown;
        };
        // ⭐ 把网关的结论**带回去**（B8）：从前这个 payload 整个被丢掉，调用方只剩 `ok`
        //    ⇒ "RPC 被接受"被当成了"压缩完成"。现在手动那条只认 `compacted === true`。
        return {
          ok: true,
          result: {
            compacted: raw.compacted === true,
            ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
            ...(typeof raw.kept === 'number' ? { kept: raw.kept } : {}),
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle('ws:reconnect-gateway', (_event, payload: { gatewayId: string }) => {
    reconnectGateway(payload.gatewayId);
    return { ok: true };
  });

  ipcMain.handle('ws:cron-list', async (_event, payload: { gatewayId: string; [k: string]: unknown }) => {
    const { gatewayId, ...params } = payload;
    return gatewayRpc(gatewayId, (gw) => gw.listCronJobs(params));
  });

  ipcMain.handle('ws:cron-status', async (_event, payload: { gatewayId: string }) =>
    gatewayRpc(payload.gatewayId, (gw) => gw.getCronStatus()),
  );

  ipcMain.handle('ws:cron-add', async (_event, payload: { gatewayId: string; [k: string]: unknown }) => {
    const { gatewayId, ...params } = payload;
    return gatewayRpc(gatewayId, (gw) => gw.addCronJob(params));
  });

  ipcMain.handle(
    'ws:cron-update',
    async (_event, payload: { gatewayId: string; jobId: string; patch: Record<string, unknown> }) =>
      gatewayRpc(payload.gatewayId, (gw) => gw.updateCronJob(payload.jobId, payload.patch)),
  );

  ipcMain.handle('ws:cron-remove', async (_event, payload: { gatewayId: string; jobId: string }) =>
    gatewayRpc(payload.gatewayId, (gw) => gw.removeCronJob(payload.jobId)),
  );

  ipcMain.handle('ws:cron-run', async (_event, payload: { gatewayId: string; jobId: string; mode?: string }) =>
    gatewayRpc(payload.gatewayId, (gw) => gw.runCronJob(payload.jobId, payload.mode)),
  );

  ipcMain.handle('ws:cron-runs', async (_event, payload: { gatewayId: string; [k: string]: unknown }) => {
    const { gatewayId, ...params } = payload;
    return gatewayRpc(gatewayId, (gw) => gw.listCronRuns(params));
  });
}
