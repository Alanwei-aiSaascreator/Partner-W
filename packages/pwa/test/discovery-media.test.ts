import { describe, expect, it, vi } from 'vitest';
import { buildSessionKey } from '@clawwork/shared';
import type { BrowserGatewayClient } from '../src/gateway/client.js';
import { createBrowserGatewayTransport } from '../src/platform/gateway-adapter.js';

vi.mock('../src/persistence/db.js', () => ({ listGateways: vi.fn() }));

async function discover(messages: unknown[]) {
  const key = buildSessionKey('media-task', 'main', 'qa-device');
  const client = {
    id: 'qa-gateway',
    isConnected: true,
    httpBase: 'https://gateway.example',
    listSessions: async () => ({ sessions: [{ key, updatedAt: 0 }] }),
    getChatHistory: async () => ({ messages }),
  } as unknown as BrowserGatewayClient;
  const { transport } = createBrowserGatewayTransport(
    () => [client],
    () => client,
    async () => 'qa-device',
  );
  return transport.syncSessions();
}

describe('PWA discovery preserves canonical media', () => {
  it('retains a native video-only message and its managed artifact identity', async () => {
    const result = await discover([
      {
        role: 'assistant',
        timestamp: 0,
        __openclaw: { runId: 'video-run' },
        content: [
          {
            type: 'video',
            url: '/api/chat/media/outgoing/qa.mp4',
            fileName: 'clip.mp4',
            artifactId: 'artifact_managed_media_qa',
          },
        ],
      },
    ]);
    expect(result.ok).toBe(true);
    expect(result.discovered?.[0].messages).toEqual([
      expect.objectContaining({
        runId: 'video-run',
        timestamp: new Date(0).toISOString(),
        attachments: [
          expect.objectContaining({
            artifactId: 'artifact_managed_media_qa',
            mimeType: 'video/mp4',
            dataUrl: 'https://gateway.example/api/chat/media/outgoing/qa.mp4',
          }),
        ],
      }),
    ]);
  });

  it('accepts string content and preserves a video media directive', async () => {
    const result = await discover([
      { role: 'assistant', timestamp: 1000, content: 'Video:\nMEDIA: https://example.com/clip.mp4' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.discovered?.[0].messages[0]).toMatchObject({
      content: 'Video:',
      attachments: [expect.objectContaining({ dataUrl: 'https://example.com/clip.mp4', mimeType: 'video/mp4' })],
    });
  });

  it('preserves epoch zero for discovered task and tool timestamps', async () => {
    const result = await discover([
      {
        role: 'assistant',
        timestamp: 0,
        content: [{ type: 'toolCall', id: 'tool-qa', name: 'exec', arguments: '{}' }],
      },
      { role: 'toolResult', timestamp: 0, content: [{ type: 'toolResult', id: 'tool-qa', result: 'done' }] },
    ]);
    const epoch = new Date(0).toISOString();
    expect(result.discovered?.[0]).toMatchObject({
      updatedAt: epoch,
      messages: [
        expect.objectContaining({
          timestamp: epoch,
          toolCalls: [expect.objectContaining({ startedAt: epoch, completedAt: epoch })],
        }),
      ],
    });
  });
});
