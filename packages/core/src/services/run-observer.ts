import type { ChatDispatchReceipt } from '@clawwork/shared';
import type { GatewayTransportPort } from '../ports/gateway-transport.js';

export type ChatRunTerminal =
  | { kind: 'final' | 'error' | 'aborted'; runId: string }
  | { kind: 'cancelled' }
  | { kind: 'unconfirmed'; reason: 'timeout' | 'disconnected' | 'invalid-receipt' | 'truncated'; runId?: string };

export function observeChatRun(options: {
  gateway: Pick<GatewayTransportPort, 'onGatewayEvent' | 'onGatewayStatus'>;
  gatewayId: string;
  sessionKey: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): { terminal: Promise<ChatRunTerminal>; bind: (receipt: ChatDispatchReceipt) => void; dispose: () => void } {
  const buffered = new Map<string, ChatRunTerminal>();
  let runId: string | undefined;
  let settled = false;
  let unsubscribeEvent: (() => void) | undefined;
  let unsubscribeStatus: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: (value: ChatRunTerminal) => void;
  const terminal = new Promise<ChatRunTerminal>((done) => {
    resolve = done;
  });
  const cleanup = () => {
    if (timer !== undefined) clearTimeout(timer);
    unsubscribeEvent?.();
    unsubscribeStatus?.();
    unsubscribeEvent = undefined;
    unsubscribeStatus = undefined;
    options.signal?.removeEventListener('abort', cancel);
    buffered.clear();
  };
  const finish = (value: ChatRunTerminal) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve(value);
  };
  const cancel = () => finish({ kind: 'cancelled' });
  const bind = (receipt: ChatDispatchReceipt) => {
    if (settled) return;
    if (receipt.sessionKey !== options.sessionKey || !receipt.runId.trim() || (runId && runId !== receipt.runId)) {
      finish({ kind: 'unconfirmed', reason: 'invalid-receipt' });
      return;
    }
    runId = receipt.runId;
    const early = buffered.get(runId);
    buffered.clear();
    if (early) finish(early);
  };
  if (options.signal?.aborted) {
    cancel();
    return { terminal, bind, dispose: cancel };
  }
  options.signal?.addEventListener('abort', cancel, { once: true });
  unsubscribeEvent = options.gateway.onGatewayEvent((event) => {
    const payload = event.payload;
    if (
      settled ||
      event.gatewayId !== options.gatewayId ||
      event.event !== 'chat' ||
      payload.sessionKey !== options.sessionKey
    )
      return;
    const eventRunId = payload.runId;
    const state = payload.state;
    if (typeof eventRunId !== 'string' || !eventRunId.trim() || (runId && runId !== eventRunId)) return;
    if (state !== 'final' && state !== 'error' && state !== 'aborted') return;
    if (state === 'final' && payload.yielded === true) return;
    const value: ChatRunTerminal =
      state === 'final' && payload.stopReason === 'length'
        ? { kind: 'unconfirmed', reason: 'truncated', runId: eventRunId }
        : { kind: state, runId: eventRunId };
    if (runId) finish(value);
    else if (!buffered.has(eventRunId)) {
      if (buffered.size >= 16) buffered.delete(buffered.keys().next().value!);
      buffered.set(eventRunId, value);
    }
  });
  unsubscribeStatus = options.gateway.onGatewayStatus((status) => {
    if (status.gatewayId === options.gatewayId && !status.connected) {
      finish({ kind: 'unconfirmed', reason: 'disconnected', ...(runId ? { runId } : {}) });
    }
  });
  if (settled) cleanup();
  else
    timer = setTimeout(
      () => finish({ kind: 'unconfirmed', reason: 'timeout', ...(runId ? { runId } : {}) }),
      options.timeoutMs ?? 600_000,
    );
  return { terminal, bind, dispose: cancel };
}
