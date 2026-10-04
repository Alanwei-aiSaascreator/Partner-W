export function normalizeRelayVideoOverrides(overrides, params, candidate) {
  const baseUrl = params.cfg?.models?.providers?.xai?.baseUrl;
  const primary = params.cfg?.agents?.defaults?.mediaModels?.video?.primary;
  if (
    typeof baseUrl !== 'string' ||
    baseUrl.trim().replace(/\/+$/, '') !== 'https://api.rongyinghudong.com/relay/v1' ||
    primary !== 'xai/grok-imagine-video' ||
    candidate.provider !== 'xai' ||
    candidate.model !== 'grok-imagine-video'
  )
    return overrides;

  const reject = (field) => {
    throw new Error(
      `relay-video-unsupported: ${field}; this test entitlement supports text-to-video, 5 seconds, 480p and 16:9/9:16/1:1. No video was submitted.`,
    );
  };
  if (params.durationSeconds !== undefined && params.durationSeconds !== 5) reject('durationSeconds');
  if (params.resolution !== undefined && !['480P', '480p'].includes(params.resolution)) reject('resolution');
  if (params.aspectRatio !== undefined && !['16:9', '9:16', '1:1'].includes(params.aspectRatio)) reject('aspectRatio');
  for (const key of ['size', 'audio', 'watermark']) {
    if (params[key] !== undefined) reject(key);
  }
  for (const key of ['inputImages', 'inputVideos', 'inputAudios']) {
    if ((params[key]?.length ?? 0) > 0) reject(key);
  }
  if (params.providerOptions && Object.keys(params.providerOptions).length > 0) reject('providerOptions');
  return {
    ...overrides,
    durationSeconds: params.durationSeconds ?? 5,
    resolution: params.resolution ?? '480p',
    aspectRatio: params.aspectRatio ?? '16:9',
  };
}
import { createHash } from 'node:crypto';

export const RELAY_VIDEO_RUNTIME_ENTRY = 'node_modules/openclaw/dist/runtime-oTTY85Zl.mjs';
export const RELAY_VIDEO_RUNTIME_SOURCE_SHA256 = '06fdfc7e3c76e665702ca479350255f1b98991699835337204cc4dce6208e098';
export const RELAY_VIDEO_RUNTIME_PATCH_ID = 'rongying-relay-video-trial-v1';

export function patchRelayVideoRuntime(source, expectedHash = RELAY_VIDEO_RUNTIME_SOURCE_SHA256) {
  const header = `${normalizeRelayVideoOverrides.toString()}\n`;
  const entry = 'async function generateVideo(params, deps = {}) {';
  const candidate = 'async prepareCandidate(candidate, provider) {';
  const entryPatch = `${entry}\nconst rongyingOriginalParams = params;`;
  const candidatePatch = `${candidate}\nconst params = normalizeRelayVideoOverrides(rongyingOriginalParams, rongyingOriginalParams, candidate);`;
  let original = source;
  if (source.startsWith(header)) {
    original = source.slice(header.length).replace(entryPatch, entry).replace(candidatePatch, candidate);
  }
  if (createHash('sha256').update(original).digest('hex') !== expectedHash) {
    throw new Error('relay video runtime source hash mismatch; review the upstream version before patching');
  }
  if (original.split(entry).length !== 2 || original.split(candidate).length !== 2) {
    throw new Error('relay video runtime requires exactly one entry and candidate anchor');
  }
  return header + original.replace(entry, entryPatch).replace(candidate, candidatePatch);
}
