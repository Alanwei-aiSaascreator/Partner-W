import type {
  GatewayTransportPort,
  GatewayEvent,
  GatewayStatusEvent,
  GatewayStatusMap,
  GatewayListItem,
  DiscoveredSession,
  SyncResult,
  RawContentBlock,
} from '@clawwork/core';
import { INTERNAL_ASSISTANT_MARKERS, normalizeContentBlocks, parseToolArgs, toISOTimestamp } from '@clawwork/core';
import { isClawWorkSession, parseTaskIdFromSessionKey, parseAgentIdFromSessionKey } from '@clawwork/shared';
import type { BrowserGatewayClient } from '../gateway/client.js';
import { listGateways as listGatewayConfigs } from '../persistence/db.js';
import { reportDebugEvent } from '../lib/debug.js';

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
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
}

interface SessionsListPayload {
  sessions?: GatewaySessionRow[];
}

interface ChatHistoryMessage {
  role: string;
  __openclaw?: { runId?: string };
  content?: RawContentBlock[] | string | null;
  timestamp?: number;
}

interface ChatHistoryPayload {
  messages?: ChatHistoryMessage[];
}

interface ParsedToolCall {
  id: string;
  name: string;
  // V1（2026-10-13）：与 core/desktop 同口径 —— 历史缺 result ⇒ declared（声明但无结果）。
  status: 'running' | 'done' | 'error' | 'declared';
  args?: Record<string, unknown>;
  result?: string;
  startedAt: string;
  completedAt?: string;
}

type EventCallback = (data: GatewayEvent) => void;
type StatusCallback = (status: GatewayStatusEvent) => void;

export interface BrowserGatewayTransportResult {
  transport: GatewayTransportPort;
  broadcastEvent: EventCallback;
  broadcastStatus: StatusCallback;
}

export function createBrowserGatewayTransport(
  getClients: () => BrowserGatewayClient[],
  getClient: (id: string) => BrowserGatewayClient | undefined,
  getDeviceId: () => Promise<string>,
): BrowserGatewayTransportResult {
  const eventListeners = new Set<EventCallback>();
  const statusListeners = new Set<StatusCallback>();

  function broadcastEvent(data: GatewayEvent): void {
    for (const listener of eventListeners) {
      try {
        listener(data);
      } catch (err) {
        reportDebugEvent({
          level: 'warn',
          domain: 'gateway',
          event: 'gateway.listener.event.failed',
          error: { message: err instanceof Error ? err.message : 'event listener failed' },
        });
      }
    }
  }

  function broadcastStatus(status: GatewayStatusEvent): void {
    for (const listener of statusListeners) {
      try {
        listener(status);
      } catch (err) {
        reportDebugEvent({
          level: 'warn',
          domain: 'gateway',
          event: 'gateway.listener.status.failed',
          error: { message: err instanceof Error ? err.message : 'status listener failed' },
        });
      }
    }
  }

  const transport: GatewayTransportPort = {
    getHttpBase(gatewayId) {
      return getClient(gatewayId)?.httpBase;
    },
    async sendMessage(gatewayId, sessionKey, content, attachments) {
      const client = getClient(gatewayId);
      if (!client?.isConnected)
        return { ok: false, error: 'gateway not connected', errorCode: 'GATEWAY_NOT_CONNECTED' };
      try {
        const response = await client.sendChatMessage(sessionKey, content, attachments);
        const runId = response?.runId;
        return { ok: true, ...(typeof runId === 'string' && runId.trim() ? { result: { sessionKey, runId } } : {}) };
      } catch (err) {
        const typed = err as Error & { code?: string; details?: Record<string, unknown> };
        return { ok: false, error: typed.message, errorCode: typed.code, errorDetails: typed.details };
      }
    },

    async chatHistory(gatewayId, sessionKey, limit) {
      const client = getClient(gatewayId);
      if (!client?.isConnected)
        return { ok: false, error: 'gateway not connected', errorCode: 'GATEWAY_NOT_CONNECTED' };
      try {
        const result = await client.getChatHistory(sessionKey, limit);
        return { ok: true, result };
      } catch (err) {
        const typed = err as Error & { code?: string };
        return { ok: false, error: typed.message, errorCode: typed.code };
      }
    },

    async abortChat(gatewayId, sessionKey) {
      const client = getClient(gatewayId);
      if (!client?.isConnected)
        return { ok: false, error: 'gateway not connected', errorCode: 'GATEWAY_NOT_CONNECTED' };
      try {
        await client.abortChat(sessionKey);
        return { ok: true };
      } catch (err) {
        const typed = err as Error & { code?: string };
        return { ok: false, error: typed.message, errorCode: typed.code };
      }
    },

    async listSessionsBySpawner(_gatewayId, _spawnedBy) {
      return { ok: false as const, error: 'not supported in PWA', errorCode: 'NOT_SUPPORTED' };
    },

    async patchSession(gatewayId, sessionKey, patch) {
      const client = getClient(gatewayId);
      if (!client?.isConnected)
        return { ok: false, error: 'gateway not connected', errorCode: 'GATEWAY_NOT_CONNECTED' };
      try {
        await client.patchSession({ sessionKey, ...patch });
        return { ok: true };
      } catch (err) {
        const typed = err as Error & { code?: string };
        return { ok: false, error: typed.message, errorCode: typed.code };
      }
    },

    async gatewayStatus() {
      const clients = getClients();
      const statusMap: GatewayStatusMap = {};
      for (const client of clients) {
        statusMap[client.id] = {
          connected: client.isConnected,
          name: client.name,
          error: client.lastError,
          serverVersion: client.serverVersion,
        };
      }
      return statusMap;
    },

    async syncSessions(): Promise<SyncResult> {
      const clients = getClients();
      const deviceId = await getDeviceId();
      const discovered: DiscoveredSession[] = [];

      for (const client of clients) {
        if (!client.isConnected) continue;
        try {
          const raw = (await client.listSessions()) as unknown as SessionsListPayload;
          const allSessions = raw.sessions ?? [];
          // ⚠️ 不按 deviceId 过滤：桌面端建的会话带的是电脑的设备 id，手机端带手机 id，
          //    一旦按本机 id 过滤，手机上就永远看不到电脑上的任务（真机验证踩到）。
          //    这里只认「是不是 ClawWork 会话」，同一个网关下的任务就是同一批任务。
          const ours = allSessions.filter((s) => isClawWorkSession(s.key));

          for (const s of ours) {
            const taskId = parseTaskIdFromSessionKey(s.key);
            if (!taskId) continue;

            const historyRaw = (await client.getChatHistory(s.key, 200)) as unknown as ChatHistoryPayload;
            const rawMsgs = historyRaw.messages ?? [];

            const toolResultMap = new Map<string, string>();
            for (const m of rawMsgs) {
              if (m.role === 'toolResult') {
                for (const b of Array.isArray(m.content) ? m.content : []) {
                  if (b.type === 'toolResult' && b.id && b.result !== undefined) {
                    toolResultMap.set(b.id, typeof b.result === 'string' ? b.result : JSON.stringify(b.result));
                  }
                }
              }
            }

            const msgs = rawMsgs
              .filter((m) => m.role === 'user' || m.role === 'assistant')
              .map((m) => {
                const blocks: RawContentBlock[] =
                  typeof m.content === 'string'
                    ? [{ type: 'text', text: m.content }]
                    : Array.isArray(m.content)
                      ? m.content
                      : [];
                const normalized =
                  m.role === 'assistant'
                    ? normalizeContentBlocks(blocks, client.httpBase)
                    : {
                        content: blocks
                          .filter((b) => b.type === 'text' && b.text)
                          .map((b) => b.text)
                          .join(''),
                      };
                const timestamp = toISOTimestamp(m.timestamp);

                const toolCalls: ParsedToolCall[] = blocks
                  .filter((b) => b.type === 'toolCall' && b.id && b.name)
                  .map((b) => {
                    const tcId = b.id!;
                    const resultText = toolResultMap.get(tcId);
                    return {
                      id: tcId,
                      name: b.name!,
                      // V1（2026-10-13）：历史缺 result ⇒ declared（与 ws-handlers 同旁路口径）。
                      status: (resultText !== undefined ? 'done' : 'declared') as ParsedToolCall['status'],
                      args:
                        typeof b.arguments === 'object' && b.arguments !== null
                          ? (b.arguments as Record<string, unknown>)
                          : typeof b.arguments === 'string'
                            ? parseToolArgs(b.arguments)
                            : undefined,
                      result: resultText,
                      startedAt: timestamp,
                      completedAt: resultText !== undefined ? timestamp : undefined,
                    };
                  });

                return {
                  role: m.role,
                  ...normalized,
                  runId: m.__openclaw?.runId,
                  timestamp,
                  toolCalls,
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
              gatewayId: client.id,
              taskId,
              sessionKey: s.key,
              title: s.derivedTitle ?? s.label ?? titleFromMsg,
              updatedAt: toISOTimestamp(s.updatedAt ?? undefined),
              agentId: parseAgentIdFromSessionKey(s.key),
              model: s.model,
              modelProvider: s.modelProvider,
              thinkingLevel: s.thinkingLevel,
              inputTokens: s.inputTokens,
              outputTokens: s.outputTokens,
              contextTokens: s.contextTokens,
              messages: msgs,
            });
          }
        } catch (err) {
          reportDebugEvent({
            level: 'warn',
            domain: 'gateway',
            event: 'gateway.sync.client.failed',
            data: { gatewayId: client.id },
            error: { message: err instanceof Error ? err.message : 'sync sessions failed' },
          });
          continue;
        }
      }

      return { ok: true, discovered };
    },

    async listGateways(): Promise<GatewayListItem[]> {
      const configs = await listGatewayConfigs();
      const clients = getClients();
      const clientMap = new Map(clients.map((c) => [c.id, c]));

      return configs.map((cfg) => {
        const client = clientMap.get(cfg.id);
        return {
          id: cfg.id,
          name: cfg.name,
          url: cfg.url,
          token: cfg.token,
          password: cfg.password,
          pairingCode: cfg.pairingCode,
          authMode: cfg.authMode ?? 'token',
          isDefault: cfg.isDefault,
          connected: client?.isConnected ?? false,
        };
      });
    },

    async listModels(gatewayId, agentId) {
      const client = getClient(gatewayId);
      if (!client?.isConnected)
        return { ok: false, error: 'gateway not connected', errorCode: 'GATEWAY_NOT_CONNECTED' };
      try {
        const result = await client.listModels(agentId);
        return { ok: true, result };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'listModels failed' };
      }
    },

    async listCommands(gatewayId, params) {
      const client = getClient(gatewayId);
      if (!client?.isConnected)
        return { ok: false, error: 'gateway not connected', errorCode: 'GATEWAY_NOT_CONNECTED' };
      const req: Record<string, unknown> = {
        scope: params?.scope ?? 'text',
        includeArgs: params?.includeArgs ?? true,
      };
      if (params?.agentId) req.agentId = params.agentId;
      if (params?.provider) req.provider = params.provider;
      try {
        const result = await client.listCommands(req);
        return { ok: true, result };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'listCommands failed' };
      }
    },

    async listAgents(gatewayId) {
      const client = getClient(gatewayId);
      if (!client?.isConnected)
        return { ok: false, error: 'gateway not connected', errorCode: 'GATEWAY_NOT_CONNECTED' };
      try {
        const result = await client.listAgents();
        return { ok: true, result };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'listAgents failed' };
      }
    },

    async getToolsCatalog(gatewayId, agentId) {
      const client = getClient(gatewayId);
      if (!client?.isConnected)
        return { ok: false, error: 'gateway not connected', errorCode: 'GATEWAY_NOT_CONNECTED' };
      try {
        const result = await client.getToolsCatalog(agentId);
        return { ok: true, result };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'getToolsCatalog failed' };
      }
    },

    async getEffectiveTools(gatewayId, sessionKey, agentId) {
      const client = getClient(gatewayId);
      if (!client?.isConnected)
        return { ok: false, error: 'gateway not connected', errorCode: 'GATEWAY_NOT_CONNECTED' };
      try {
        const result = agentId
          ? await client.getEffectiveTools(sessionKey, agentId)
          : await client.getEffectiveTools(sessionKey);
        return { ok: true, result };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'getEffectiveTools failed' };
      }
    },

    async getSkillsStatus(gatewayId, agentId) {
      const client = getClient(gatewayId);
      if (!client?.isConnected)
        return { ok: false, error: 'gateway not connected', errorCode: 'GATEWAY_NOT_CONNECTED' };
      try {
        const result = await client.getSkillsStatus(agentId);
        return { ok: true, result };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'getSkillsStatus failed' };
      }
    },

    async createSession(gatewayId, params) {
      const client = getClient(gatewayId);
      if (!client?.isConnected)
        return { ok: false, error: 'gateway not connected', errorCode: 'GATEWAY_NOT_CONNECTED' };
      try {
        await client.createSession(params);
        return { ok: true };
      } catch (err) {
        const typed = err as Error & { code?: string };
        return { ok: false, error: typed.message, errorCode: typed.code };
      }
    },

    async deleteSession(gatewayId, sessionKey) {
      const client = getClient(gatewayId);
      if (!client?.isConnected)
        return { ok: false, error: 'gateway not connected', errorCode: 'GATEWAY_NOT_CONNECTED' };
      try {
        await client.deleteSession(sessionKey);
        return { ok: true };
      } catch (err) {
        const typed = err as Error & { code?: string };
        return { ok: false, error: typed.message, errorCode: typed.code };
      }
    },

    onGatewayEvent(callback) {
      eventListeners.add(callback);
      return () => {
        eventListeners.delete(callback);
      };
    },

    onGatewayStatus(callback) {
      statusListeners.add(callback);
      return () => {
        statusListeners.delete(callback);
      };
    },
  };

  return { transport, broadcastEvent, broadcastStatus };
}
