import { describe, expect, it, vi } from 'vitest';
import type { BrowserGatewayClient } from '../src/gateway/client';
import { createBrowserGatewayTransport } from '../src/platform/gateway-adapter';

vi.mock('../src/persistence/db', () => ({ listGateways: vi.fn() }));

describe('browser transport dispatch receipts', () => {
  function fixture(response: unknown) {
    const sendChatMessage = vi.fn(async () => response);
    const client = { id: 'gateway', isConnected: true, sendChatMessage } as unknown as BrowserGatewayClient;
    const { transport } = createBrowserGatewayTransport(
      () => [client],
      () => client,
      async () => 'device',
    );
    return { transport, sendChatMessage };
  }

  it('returns the acknowledged run on the requested session', async () => {
    const h = fixture({ runId: 'run', sessionKey: 'untrusted-returned-session' });
    expect(await h.transport.sendMessage('gateway', 'requested-session', 'question')).toEqual({
      ok: true,
      result: { runId: 'run', sessionKey: 'requested-session' },
    });
    expect(h.sendChatMessage).toHaveBeenCalledWith('requested-session', 'question', undefined);
  });

  it.each([undefined, null, {}, { runId: '' }, { runId: ' ' }, { runId: 42 }])(
    'does not invent a receipt for %j',
    async (response) => {
      const h = fixture(response);
      expect(await h.transport.sendMessage('gateway', 'session', 'question')).toEqual({ ok: true });
    },
  );
});
