import { expect, it, vi } from 'vitest';
import { createImagegenRelayClient } from '../src/main/imagegen/client.js';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const request = {
  model: 'qwen-image-plus' as const,
  prompt: 'A mountain',
  size: '1328*1328',
  title: 'Mountain',
  operationId: 'mountain-001',
};
it('client sends only model/spec/prompt and persisted request id, never retries unknown POST', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => {
    throw new Error('lost');
  });
  const client = createImagegenRelayClient({
    baseUrl: 'https://relay.example/relay',
    relayKey: 'customer-key',
    fetchImpl: fetcher,
  });
  expect(await client.create(request, id)).toEqual({ ok: false, code: 'imagegen-request-unconfirmed' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe('https://relay.example/relay/v1/imagegen');
  expect(JSON.parse(String(init?.body))).toEqual({
    requestId: id,
    model: request.model,
    prompt: request.prompt,
    size: request.size,
  });
  expect(init?.redirect).toBe('error');
});
it('client gates undocumented sizes and missing server capability evidence', async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ enabled: true, model: 'qwen-image-plus', sizes: ['1328*1328'] }),
  );
  const client = createImagegenRelayClient({
    baseUrl: 'https://relay.example',
    relayKey: 'customer-key',
    fetchImpl: fetcher,
  });
  expect(await client.capabilities('1328*1328')).toBe(true);
  expect(await client.capabilities('4K')).toBe(false);
  fetcher.mockResolvedValueOnce(Response.json({ enabled: true }));
  expect(await client.capabilities('1328*1328')).toBe(false);
});
it('client refuses missing usage completion status, wrong MIME and excessive image data', async () => {
  const fetcher = vi.fn<typeof fetch>();
  const client = createImagegenRelayClient({
    baseUrl: 'https://relay.example',
    relayKey: 'customer-key',
    fetchImpl: fetcher,
  });
  fetcher.mockResolvedValueOnce(Response.json({ status: 'unknown' }));
  expect(await client.query(id)).toEqual({ status: 'failed', code: 'imagegen-result-unconfirmed' });
  fetcher.mockResolvedValueOnce(new Response('<html>error</html>', { headers: { 'content-type': 'text/html' } }));
  expect((await client.download(id)).ok).toBe(false);
  fetcher.mockResolvedValueOnce(
    new Response(new Uint8Array(4), {
      headers: { 'content-type': 'image/png', 'content-length': String(11 * 1024 * 1024) },
    }),
  );
  expect((await client.download(id)).ok).toBe(false);
});
