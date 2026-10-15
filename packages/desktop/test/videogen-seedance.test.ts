import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { readVideogenFirstFrame } from '../src/main/videogen/reference-image.js';
import { parseVideogenRequest } from '../src/main/videogen/request.js';
import { createVideogenRelayClient } from '../src/main/videogen/client.js';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);
describe('Seedance candidate image boundary', () => {
  it('explicit Seedance branch accepts local first frame and enforces adaptive', () => {
    const parsed = parseVideogenRequest({
      model: 'seedance-2.5',
      prompt: 'flower',
      firstFrame: 'images/flower.png',
      duration: 5,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.request.resolution).toBe('720P');
      expect(parsed.request.aspectRatio).toBe('adaptive');
    }
    expect(parseVideogenRequest({ model: 'seedance-2.5', prompt: 'x', imageUrl: 'https://example.org/x' }).ok).toBe(
      false,
    );
    expect(parseVideogenRequest({ model: 'seedance-2.5', prompt: 'x', firstFrame: 'https://example.org/x' }).ok).toBe(
      false,
    );
    expect(
      parseVideogenRequest({ model: 'seedance-2.5', prompt: 'x', firstFrame: 'a.png', aspectRatio: '16:9' }).ok,
    ).toBe(false);
  });
  it('reads exact workspace bytes; rejects outside files unless task explicitly authorizes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'videogen-ref-'));
    try {
      const ws = join(root, 'ws');
      await mkdir(ws);
      await writeFile(join(ws, 'inside.png'), png);
      const outside = join(root, 'outside.png');
      await writeFile(outside, png);
      expect(await readVideogenFirstFrame({ workspacePath: ws, path: 'inside.png' })).toEqual({
        mimeType: 'image/png',
        content: png.toString('base64'),
      });
      await expect(readVideogenFirstFrame({ workspacePath: ws, path: outside })).rejects.toThrow();
      await expect(readVideogenFirstFrame({ workspacePath: ws, path: 'https://localhost/x' })).rejects.toThrow();
      expect(
        await readVideogenFirstFrame({ workspacePath: ws, path: outside, authorizedAttachmentPaths: [outside] }),
      ).toEqual({ mimeType: 'image/png', content: png.toString('base64') });
      await writeFile(join(ws, 'fake.png'), 'not a picture');
      await expect(readVideogenFirstFrame({ workspacePath: ws, path: 'fake.png' })).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('client routes Seedance separately with stable id and bytes, no direct URL', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ taskId: 'job-1' }), { status: 200 });
    }) as typeof fetch;
    const client = createVideogenRelayClient({ baseUrl: 'https://relay.example', relayKey: 'fixture', fetchImpl });
    const parsed = parseVideogenRequest({ model: 'seedance-2.5', prompt: 'flower' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    await client.create(parsed.request, 'stable-12345678');
    expect(calls[0].url).toBe('https://relay.example/v1/seedance/videos');
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      requestId: 'stable-12345678',
      prompt: 'flower',
      resolution: '720P',
    });
  });
});
