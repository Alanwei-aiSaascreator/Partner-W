import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import * as runtimePatch from './relay-video-runtime.mjs';

const owned = {
  cfg: {
    models: { providers: { xai: { baseUrl: 'https://api.rongyinghudong.com/relay/v1' } } },
    agents: { defaults: { mediaModels: { video: { primary: 'xai/grok-imagine-video' } } } },
  },
};
const candidate = { provider: 'xai', model: 'grok-imagine-video' };

test('owned relay fills omitted generation parameters before upstream normalization', () => {
  const input = { model: candidate.model, durationSeconds: undefined, resolution: undefined };
  const result = runtimePatch.normalizeRelayVideoOverrides(input, owned, candidate);
  assert.equal(result.durationSeconds, 5);
  assert.equal(result.resolution, '480p');
  assert.equal(result.aspectRatio, '16:9');
  assert.equal(input.durationSeconds, undefined);
});

for (const value of [
  { durationSeconds: 8 },
  { durationSeconds: 5.2 },
  { resolution: '720p' },
  { resolution: '4k' },
  { aspectRatio: '3:2' },
  { size: '1280x720' },
  { audio: true },
  { watermark: false },
  { inputImages: [{ url: 'https://example.test/image.png' }] },
  { inputVideos: [{ url: 'https://example.test/video.mp4' }] },
  { inputAudios: [{ url: 'https://example.test/audio.mp3' }] },
  { providerOptions: { seed: 1 } },
]) {
  test(`rejects unsupported explicit relay input before normalization: ${JSON.stringify(value)}`, () => {
    assert.throws(
      () => runtimePatch.normalizeRelayVideoOverrides({ ...value }, { ...owned, ...value }, candidate),
      /relay-video-unsupported/,
    );
  });
}

test('preserves explicit supported values', () => {
  const input = { durationSeconds: 5, resolution: '480p', aspectRatio: '16:9', model: candidate.model };
  assert.deepEqual(runtimePatch.normalizeRelayVideoOverrides(input, { ...owned, ...input }, candidate), input);
});

test('accepts the runtime resolution spelling and supported portrait or square ratios', () => {
  for (const aspectRatio of ['9:16', '1:1']) {
    const input = { resolution: '480P', aspectRatio, durationSeconds: 5 };
    assert.deepEqual(runtimePatch.normalizeRelayVideoOverrides(input, { ...owned, ...input }, candidate), input);
  }
});

test('does not change other providers, models or customer-owned endpoints', () => {
  const input = { durationSeconds: 8, resolution: '720p' };
  for (const [params, target] of [
    [{ cfg: { models: { providers: { xai: { baseUrl: 'https://api.x.ai/v1' } } } } }, candidate],
    [{ cfg: {} }, candidate],
    [owned, { provider: 'another', model: candidate.model }],
    [owned, { provider: 'xai', model: 'another' }],
    [
      {
        cfg: {
          ...owned.cfg,
          models: { providers: { xai: { baseUrl: 'https://api.rongyinghudong.com/relay/v1-other' } } },
        },
      },
      candidate,
    ],
  ]) {
    assert.equal(runtimePatch.normalizeRelayVideoOverrides(input, params, target), input);
  }
});

const fixture = `async function generateVideo(params, deps = {}) {
  const candidates = deps.candidates;
  return deps.runCandidates({
    candidates,
    async prepareCandidate(candidate, provider) {
      return provider.generateVideo(params);
    }
  });
}`;
const fixtureHash = createHash('sha256').update(fixture).digest('hex');

test('runtime patch supplies defaults inside candidate scope and leaves caller state untouched', async () => {
  const patched = runtimePatch.patchRelayVideoRuntime(fixture, fixtureHash);
  const generate = vm.runInNewContext(`${patched}\ngenerateVideo`);
  const input = { ...owned, prompt: 'A square moves' };
  const result = await generate(input, {
    candidates: [candidate],
    runCandidates: ({ prepareCandidate }) => prepareCandidate(candidate, { generateVideo: (request) => request }),
  });
  assert.equal(result.durationSeconds, 5);
  assert.equal(input.durationSeconds, undefined);
  assert.equal(runtimePatch.patchRelayVideoRuntime(patched, fixtureHash), patched);
});

test('runtime patch rejects unsupported input before a provider can be invoked', async () => {
  const generate = vm.runInNewContext(`${runtimePatch.patchRelayVideoRuntime(fixture, fixtureHash)}\ngenerateVideo`);
  let calls = 0;
  await assert.rejects(
    generate(
      { ...owned, durationSeconds: 8 },
      {
        candidates: [candidate],
        runCandidates: ({ prepareCandidate }) =>
          prepareCandidate(candidate, {
            generateVideo: () => {
              calls++;
            },
          }),
      },
    ),
    /relay-video-unsupported/,
  );
  assert.equal(calls, 0);
});

test('runtime patch refuses an unknown source or duplicated anchors', () => {
  assert.throws(() => runtimePatch.patchRelayVideoRuntime(fixture), /source hash/);
  const duplicated = `${fixture}\n${fixture}`;
  assert.throws(
    () => runtimePatch.patchRelayVideoRuntime(duplicated, createHash('sha256').update(duplicated).digest('hex')),
    /anchor/,
  );
});
