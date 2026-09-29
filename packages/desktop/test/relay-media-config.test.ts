import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OPENAI_IMAGE_MODEL_REF,
  RELAY_BASE_URL,
  RELAY_PROVIDER_ID,
  XAI_VIDEO_MODEL_REF,
  XAI_VIDEO_PROVIDER_ID,
  applyRelayConfig,
  buildRelayPatch,
  buildRelayRemovalPatch,
  fetchRelayMediaCapabilities,
  type ApplyRelayConfigDeps,
} from '../src/main/commercial/relay-config.js';

function snapshot(config: Record<string, unknown>, hash = 'h1') {
  return { hash, config, raw: '', path: '' };
}

const providersOf = (patch: unknown): Record<string, Record<string, unknown>> =>
  (patch as { models: { providers: Record<string, Record<string, unknown>> } }).models.providers;

const mediaModelsOf = (patch: unknown): Record<string, { primary?: unknown }> | undefined =>
  (patch as { agents?: { defaults?: { mediaModels?: Record<string, { primary?: unknown }> } } })?.agents?.defaults
    ?.mediaModels;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('relay 媒体能力接线', () => {
  it('默认 fail-closed：没有服务端能力证据时图片和视频都不写', () => {
    const patch = buildRelayPatch({ relayKey: 'rly_abc', deviceFingerprint: 'fp' });

    expect(providersOf(patch).openai).toBeUndefined();
    expect(providersOf(patch).xai).toBeUndefined();
    expect(mediaModelsOf(patch)).toBeUndefined();
  });

  it('video=true 时复用内置 xai provider 指向 relay /v1', () => {
    const patch = buildRelayPatch({
      relayKey: 'rly_abc',
      deviceFingerprint: 'fp',
      videoGenerationWired: true,
    });

    expect(providersOf(patch)[XAI_VIDEO_PROVIDER_ID]).toEqual({
      baseUrl: `${RELAY_BASE_URL}/v1`,
      apiKey: 'rly_abc',
      headers: { 'X-ClawRouter-Project-Id': 'fp' },
    });
    expect(mediaModelsOf(patch)?.video?.primary).toBe(XAI_VIDEO_MODEL_REF);
  });

  it('图片和视频同时可用时合并 mediaModels，不互相覆盖', () => {
    const patch = buildRelayPatch({
      relayKey: 'rly_abc',
      deviceFingerprint: 'fp',
      imageGenerationWired: true,
      videoGenerationWired: true,
    });

    expect(mediaModelsOf(patch)).toEqual({
      image: { primary: OPENAI_IMAGE_MODEL_REF },
      video: { primary: XAI_VIDEO_MODEL_REF },
    });
  });

  it('用户自己的 xai provider 不得被覆盖，视频模型也不改', () => {
    const patch = buildRelayPatch({
      relayKey: 'rly_abc',
      deviceFingerprint: 'fp',
      videoGenerationWired: true,
      existingConfig: snapshot({
        models: { providers: { xai: { baseUrl: 'https://api.x.ai/v1', apiKey: 'user-key' } } },
        agents: { defaults: { mediaModels: { video: { primary: 'xai/user-video-model' } } } },
      }),
    });

    expect(providersOf(patch).xai).toBeUndefined();
    expect(mediaModelsOf(patch)?.video).toBeUndefined();
  });

  it('能力降级时只删除我们自己写入的图片/视频配置，不能把旧能力留成幽灵入口', () => {
    const patch = buildRelayPatch({
      relayKey: 'rly_abc',
      deviceFingerprint: 'fp',
      imageGenerationWired: false,
      videoGenerationWired: false,
      existingConfig: snapshot({
        models: {
          providers: {
            openai: { baseUrl: `${RELAY_BASE_URL}/v1`, apiKey: 'redacted' },
            xai: { baseUrl: `${RELAY_BASE_URL}/v1`, apiKey: 'redacted' },
          },
        },
        agents: {
          defaults: {
            mediaModels: {
              image: { primary: OPENAI_IMAGE_MODEL_REF },
              video: { primary: XAI_VIDEO_MODEL_REF },
            },
          },
        },
      }),
    });

    expect(providersOf(patch).openai).toBeNull();
    expect(providersOf(patch).xai).toBeNull();
    expect(mediaModelsOf(patch)).toEqual({
      image: { primary: null },
      video: { primary: null },
    });
  });

  it('能力关闭时不删除用户自己的同名媒体 provider 与模型', () => {
    const patch = buildRelayPatch({
      relayKey: 'rly_abc',
      deviceFingerprint: 'fp',
      imageGenerationWired: false,
      videoGenerationWired: false,
      existingConfig: snapshot({
        models: {
          providers: {
            openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'user-key' },
            xai: { baseUrl: 'https://api.x.ai/v1', apiKey: 'user-key' },
          },
        },
        agents: {
          defaults: {
            mediaModels: {
              image: { primary: 'openai/gpt-image-1' },
              video: { primary: 'xai/user-video-model' },
            },
          },
        },
      }),
    });

    expect(providersOf(patch).openai).toBeUndefined();
    expect(providersOf(patch).xai).toBeUndefined();
    expect(mediaModelsOf(patch)).toBeUndefined();
  });

  it('注销只清理自己拥有的 xai provider 与 video primary', () => {
    const removal = buildRelayRemovalPatch(
      snapshot({
        models: {
          providers: {
            clawrouter: { baseUrl: RELAY_BASE_URL },
            xai: { baseUrl: `${RELAY_BASE_URL}/v1` },
          },
        },
        agents: { defaults: { mediaModels: { video: { primary: XAI_VIDEO_MODEL_REF } } } },
      }),
    );

    const providers = (removal?.patch.models as { providers: Record<string, unknown> }).providers;
    const mediaModels = (removal?.patch.agents as { defaults: { mediaModels: Record<string, { primary: unknown }> } })
      .defaults.mediaModels;
    expect(providers.xai).toBeNull();
    expect(mediaModels.video.primary).toBeNull();
  });

  it('注销不碰用户自己的 xai provider 与视频模型', () => {
    const removal = buildRelayRemovalPatch(
      snapshot({
        models: {
          providers: {
            clawrouter: { baseUrl: RELAY_BASE_URL },
            xai: { baseUrl: 'https://api.x.ai/v1', apiKey: 'user-key' },
          },
        },
        agents: { defaults: { mediaModels: { video: { primary: 'xai/user-video-model' } } } },
      }),
    );

    const providers = (removal?.patch.models as { providers: Record<string, unknown> }).providers;
    const defaults = (removal?.patch.agents as { defaults?: Record<string, unknown> } | undefined)?.defaults;
    expect(providers.xai).toBeUndefined();
    expect(defaults?.mediaModels).toBeUndefined();
  });
});

describe('fetchRelayMediaCapabilities', () => {
  it('只接受 relay 返回的严格 enabled 布尔值', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        image: { enabled: true, model: 'qwen-image-1' },
        video: { enabled: false },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchRelayMediaCapabilities('rly_abc')).resolves.toEqual({ image: true, video: false });
    expect(fetchMock).toHaveBeenCalledWith(
      `${RELAY_BASE_URL}/v1/capabilities`,
      expect.objectContaining({ headers: { Authorization: 'Bearer rly_abc' } }),
    );
  });

  it('非 2xx 或响应结构不合法时抛错，让上层 fail-closed 并留下告警', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503 })),
    );
    await expect(fetchRelayMediaCapabilities('rly_abc')).rejects.toThrow('503');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ image: true, video: false }) })),
    );
    await expect(fetchRelayMediaCapabilities('rly_abc')).rejects.toThrow('invalid media capabilities');
  });
});

describe('applyRelayConfig 媒体能力', () => {
  function deps(overrides: Partial<ApplyRelayConfigDeps> = {}): ApplyRelayConfigDeps & {
    patchConfig: ReturnType<typeof vi.fn>;
  } {
    return {
      getConfig: vi.fn(async () =>
        snapshot({
          models: { providers: { [RELAY_PROVIDER_ID]: { baseUrl: RELAY_BASE_URL, apiKey: 'redacted' } } },
        }),
      ),
      patchConfig: vi.fn(async () => ({ ok: true })),
      ...overrides,
    } as never;
  }

  it('只把能力探针明确返回 true 的能力写进配置', async () => {
    const d = deps({
      getConfig: vi
        .fn()
        .mockResolvedValueOnce(
          snapshot({
            models: { providers: { [RELAY_PROVIDER_ID]: { baseUrl: RELAY_BASE_URL, apiKey: 'redacted' } } },
          }),
        )
        .mockResolvedValueOnce(
          snapshot({
            models: {
              providers: {
                [RELAY_PROVIDER_ID]: { baseUrl: RELAY_BASE_URL, apiKey: 'redacted' },
                openai: { baseUrl: `${RELAY_BASE_URL}/v1`, apiKey: 'redacted' },
              },
            },
            agents: { defaults: { mediaModels: { image: { primary: OPENAI_IMAGE_MODEL_REF } } } },
          }),
        ),
      resolveMediaCapabilities: vi.fn(async () => ({ image: true, video: false })),
    });

    const result = await applyRelayConfig(d, { relayKey: 'rly_abc', deviceFingerprint: 'fp' });

    expect(result.configured).toBe(true);
    const raw = JSON.parse((d.patchConfig.mock.calls[0]?.[0] as { raw: string }).raw) as Record<string, unknown>;
    expect(providersOf(raw).openai).toBeDefined();
    expect(providersOf(raw).xai).toBeUndefined();
    expect(mediaModelsOf(raw)).toEqual({ image: { primary: OPENAI_IMAGE_MODEL_REF } });
  });

  it('能力探针失败时保持关闭并返回安全告警，不阻塞聊天中转', async () => {
    const d = deps({
      resolveMediaCapabilities: vi.fn(async () => {
        throw new Error('capabilities unavailable');
      }),
    });

    const result = await applyRelayConfig(d, { relayKey: 'rly_abc', deviceFingerprint: 'fp' });

    expect(result.configured).toBe(true);
    expect(result.warnings).toContain('resolve-media-capabilities-failed');
    const raw = JSON.parse((d.patchConfig.mock.calls[0]?.[0] as { raw: string }).raw) as Record<string, unknown>;
    expect(providersOf(raw).openai).toBeUndefined();
    expect(providersOf(raw).xai).toBeUndefined();
  });

  it('能力探针失败时会清掉旧的自有媒体接线，并校验清理真的生效', async () => {
    const owned = snapshot({
      models: {
        providers: {
          [RELAY_PROVIDER_ID]: { baseUrl: RELAY_BASE_URL, apiKey: 'redacted' },
          openai: { baseUrl: `${RELAY_BASE_URL}/v1`, apiKey: 'redacted' },
          xai: { baseUrl: `${RELAY_BASE_URL}/v1`, apiKey: 'redacted' },
        },
      },
      agents: {
        defaults: {
          mediaModels: {
            image: { primary: OPENAI_IMAGE_MODEL_REF },
            video: { primary: XAI_VIDEO_MODEL_REF },
          },
        },
      },
    });
    const stillStale = deps({
      getConfig: vi.fn(async () => owned),
      resolveMediaCapabilities: vi.fn(async () => {
        throw new Error('capabilities unavailable');
      }),
    });

    const failedVerification = await applyRelayConfig(stillStale, {
      relayKey: 'rly_abc',
      deviceFingerprint: 'fp',
    });
    expect(failedVerification.configured).toBe(false);
    expect(failedVerification.errorCode).toBe('verify-failed');
    const raw = JSON.parse((stillStale.patchConfig.mock.calls[0]?.[0] as { raw: string }).raw) as Record<
      string,
      unknown
    >;
    expect(providersOf(raw).openai).toBeNull();
    expect(providersOf(raw).xai).toBeNull();

    const cleaned = snapshot({
      models: {
        providers: { [RELAY_PROVIDER_ID]: { baseUrl: RELAY_BASE_URL, apiKey: 'redacted' } },
      },
      agents: { defaults: {} },
    });
    const appliesCleanup = deps({
      getConfig: vi.fn().mockResolvedValueOnce(owned).mockResolvedValueOnce(cleaned),
      resolveMediaCapabilities: vi.fn(async () => {
        throw new Error('capabilities unavailable');
      }),
    });
    await expect(
      applyRelayConfig(appliesCleanup, { relayKey: 'rly_abc', deviceFingerprint: 'fp' }),
    ).resolves.toMatchObject({ ok: true, configured: true });
  });
});
