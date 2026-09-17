import type { IpcResult } from '@clawwork/shared';
import { buildSystemSessionKey, mergeGatewayStreamText } from '@clawwork/shared';
import type { GatewayEvent } from '../ports/gateway-transport.js';
import { extractText } from '../protocol/parse-content.js';
import type { ChatEventPayload } from '../protocol/types.js';
import type { SystemSessionState } from '../stores/system-session-store.js';

interface SystemSessionGateway {
  createSession: (gatewayId: string, params: { key: string; agentId: string; message?: string }) => Promise<IpcResult>;
  deleteSession: (gatewayId: string, sessionKey: string) => Promise<IpcResult>;
  sendMessage: (gatewayId: string, sessionKey: string, content: string) => Promise<IpcResult>;
  patchSession?: (gatewayId: string, sessionKey: string, patch: { model?: string }) => Promise<IpcResult>;
  onGatewayEvent: (callback: (data: GatewayEvent) => void) => () => void;
}

export interface SystemSessionServiceDeps {
  gateway: SystemSessionGateway;
  getStore: () => SystemSessionState;
}

export interface SystemSessionService {
  start(opts: {
    gatewayId: string;
    agentId: string;
    purpose: string;
    initialMessage?: string;
    /**
     * 显式指定这条侧会话用哪个模型。
     *
     * 侧会话是以某个 agent（通常是主助手 `main`）的身份建的，会**继承它配的模型**。
     * 2026-09-17 实机：主助手配的模型卡在 `starting_model`，于是「创建智能体」向导的
     * AI 引导永远转圈，用户以为整个创建功能坏了（真正的 `agents.create` 从未执行）。
     * 传一个**当前确实可用**的模型就能绕开。
     */
    model?: string;
  }): Promise<IpcResult>;
  send(content: string): Promise<IpcResult>;
  abort(): void;
  end(): Promise<void>;
}

export function createSystemSessionService(deps: SystemSessionServiceDeps): SystemSessionService {
  let removeListener: (() => void) | null = null;

  function handleEvent(data: GatewayEvent): void {
    if (data.event !== 'chat') return;
    const store = deps.getStore();
    const payload = data.payload as unknown as ChatEventPayload;
    if (!store.sessionKey || payload.sessionKey !== store.sessionKey) return;

    const text = extractText(payload);

    switch (payload.state) {
      case 'delta': {
        const msgs = store.messages;
        const last = msgs[msgs.length - 1];
        if (last?.role === 'assistant') {
          store.updateLastAssistant(mergeGatewayStreamText(last.content, text));
        }
        store.setStatus('streaming');
        break;
      }
      case 'final': {
        if (text) {
          const msgs = store.messages;
          const last = msgs[msgs.length - 1];
          if (last?.role === 'assistant') {
            store.updateLastAssistant(mergeGatewayStreamText(last.content, text));
          }
        }
        store.setStatus('active');
        break;
      }
      case 'aborted':
        store.setStatus('active');
        break;
      case 'error': {
        const errMsg = payload.errorMessage ?? payload.error?.message ?? 'unknown error';
        store.setError(errMsg);
        break;
      }
    }
  }

  return {
    async start(opts) {
      const store = deps.getStore();
      if (store.sessionKey) {
        return { ok: false, error: 'system session already active' };
      }

      const sessionKey = buildSystemSessionKey(opts.purpose, opts.agentId);
      store.open({
        sessionKey,
        gatewayId: opts.gatewayId,
        agentId: opts.agentId,
        purpose: opts.purpose,
      });

      removeListener = deps.gateway.onGatewayEvent(handleEvent);

      const res = await deps.gateway.createSession(opts.gatewayId, {
        key: sessionKey,
        agentId: opts.agentId,
      });

      if (!res.ok) {
        removeListener();
        removeListener = null;
        store.close();
        return res;
      }

      // 模型补丁必须在首条消息之前：第一条回复就会走这个模型，晚一步等于没打。
      // 失败只当作「用了继承来的模型」，**不能**因此挡住上层功能（引导只是辅助）。
      if (opts.model) {
        await deps.gateway.patchSession?.(opts.gatewayId, sessionKey, { model: opts.model }).catch(() => undefined);
      }

      if (opts.initialMessage) {
        return this.send(opts.initialMessage);
      }

      return { ok: true };
    },

    async send(content) {
      const store = deps.getStore();
      if (!store.sessionKey || !store.gatewayId) {
        return { ok: false, error: 'no active system session' };
      }

      const now = new Date().toISOString();
      store.appendMessage({ role: 'user', content, timestamp: now });
      store.appendMessage({ role: 'assistant', content: '', timestamp: now });
      store.setStatus('streaming');

      return deps.gateway.sendMessage(store.gatewayId, store.sessionKey, content);
    },

    abort() {
      removeListener?.();
      removeListener = null;
      deps.getStore().close();
    },

    async end() {
      const store = deps.getStore();
      const { gatewayId, sessionKey } = store;

      removeListener?.();
      removeListener = null;

      if (gatewayId && sessionKey) {
        await deps.gateway.deleteSession(gatewayId, sessionKey).catch(() => {});
      }

      store.close();
    },
  };
}
