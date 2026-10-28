import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P01（2026-10-15）：**新后端商业启用前的客户端隔离 —— 端点切换时的归属与去重**。
 *
 * ## 这一组钉的是什么
 *
 * 客户端默认中转基址是 `RELAY_BASE_URL`（生产 `/relay`）。把候选切到新命名空间
 * （r13 的 `/relay-108`）之后，**上一次运行留在网关配置里的旧端点 provider**
 * 会同时踩两个坑（依据 `reviews/r13-client-backend-isolation-review.md`）：
 *
 *   ① 用量去重（`usage-reporter`）：只认当前 base ⇒ 旧 provider 不再被认成"走中转的"
 *      ⇒ 已经被 relay 服务端计量过一次的用量**再上报一次** = 用户被扣两次钱；
 *   ② 归属/清理（`ownsOpenAIImageConfig` / `ownsXaiVideoConfig` / `buildRelayRemovalPatch`）：
 *      只认当前 base ⇒ 我们写过的 `openai`/`xai` 媒体 provider 变成"用户的"，
 *      既不会被接管（图片能力静默不接线）也不会被清掉（注销后残留幽灵入口）。
 *
 * 判据**只能是官方端点**（旧 `/relay` + 新 `/relay-108`），不做同 origin 前缀匹配 ——
 * 那会把用户自建的同 origin provider 也认成我们的。
 *
 * ⚠️ 控制项（`relayProviderIds` 必须保持"只认当前端点"）：它同时是 bootstrap 的
 *    幂等快路径判据（`relay-bootstrap.ts:324`）。把它放宽，换端点后 bootstrap 会
 *    以为"已经配好了"而**不重写配置** —— 客户端会继续打旧端点却以为自己在新端点上。
 */

const LEGACY_RELAY_BASE_URL = 'https://api.rongyinghudong.com/relay';
const NEW_RELAY_BASE_URL = 'https://api.rongyinghudong.com/relay-108';
const OPENAI_IMAGE_MODEL_REF = 'openai/qwen-image-1';
const XAI_VIDEO_MODEL_REF = 'xai/grok-imagine-video';

function snapshot(config: Record<string, unknown>) {
  return { hash: 'h1', config, raw: '', path: '' };
}

/** 我们写过的图片媒体配置（provider baseUrl 是 relay 的 `/v1`）。 */
function ourImageConfig(relayBaseUrl: string) {
  return {
    models: { providers: { openai: { baseUrl: `${relayBaseUrl}/v1`, apiKey: '__OPENCLAW_REDACTED__' } } },
    agents: { defaults: { mediaModels: { image: { primary: OPENAI_IMAGE_MODEL_REF } } } },
  };
}

/** 我们写过的视频媒体配置。 */
function ourVideoConfig(relayBaseUrl: string) {
  return {
    models: { providers: { xai: { baseUrl: `${relayBaseUrl}/v1`, apiKey: '__OPENCLAW_REDACTED__' } } },
    agents: { defaults: { mediaModels: { video: { primary: XAI_VIDEO_MODEL_REF } } } },
  };
}

// ── usage-reporter 的真实入口夹具（与 test/usage-reporter.test.ts 同款） ──────────
const rpcMock = vi.fn(async () => ({ data: null, error: null }));
const getCommercialClientMock = vi.fn(() => ({
  rpc: rpcMock,
  auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })) },
}));
vi.mock('../src/main/commercial/client.js', () => ({
  getCommercialClient: getCommercialClientMock,
}));

const getSessionUsageMock = vi.fn();
const getConfigMock = vi.fn();
const getAllGatewayClientsMock = vi.fn();
vi.mock('../src/main/ws/index.js', () => ({
  getAllGatewayClients: getAllGatewayClientsMock,
}));

vi.mock('../src/main/debug/index.js', () => ({
  initDebugLogger: vi.fn(),
  getDebugLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() }),
}));

function gatewayWith() {
  return { id: 'gw-1', isConnected: true, getSessionUsage: getSessionUsageMock, getConfig: getConfigMock };
}

function oneSession(provider: string) {
  return {
    sessions: [
      {
        key: 'sess-1',
        modelUsage: [
          { provider, model: 'm', count: 1, totals: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 } },
        ],
      },
    ],
  };
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  getCommercialClientMock.mockReturnValue({
    rpc: rpcMock,
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } }, error: null })) },
  } as never);
  rpcMock.mockResolvedValue({ data: null, error: null } as never);
  getConfigMock.mockResolvedValue(snapshot({ models: { providers: {} } }));
  // BUG-087：上报器**默认影子模式**（算出"本应上报什么"但不实际发送）。
  // 这一组用例验的是**去重/归属判据本身**，所以显式打开直发；
  // "默认影子"由 usage-reporter.test.ts 的专项用例钉住，这里不重复。
  const reporter = await import('../src/main/commercial/usage-reporter.js');
  reporter.setUsageReportingMode('live');
});

describe('P01 · 端点切换后的用量去重（真实上报入口）', () => {
  it('⭐ 活动端点=新端点时，仍指向官方旧端点的 provider 必须被跳过（不双扣）', async () => {
    getAllGatewayClientsMock.mockReturnValue(new Map([['gw-1', gatewayWith()]]));
    getConfigMock.mockResolvedValue({
      hash: 'h1',
      config: { models: { providers: { clawrouter: { baseUrl: LEGACY_RELAY_BASE_URL } } } },
      raw: '',
      path: '',
    });
    getSessionUsageMock.mockResolvedValue(oneSession('clawrouter'));

    const relayConfig = await import('../src/main/commercial/relay-config.js');
    relayConfig.setActiveRelayBaseUrl(NEW_RELAY_BASE_URL);
    const { runUsageReport } = await import('../src/main/commercial/usage-reporter.js');

    const sent = await runUsageReport();

    expect(sent).toBe(0);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('⭐ 活动端点=官方旧端点（回退态）时，指向新端点的 provider 同样必须被跳过', async () => {
    getAllGatewayClientsMock.mockReturnValue(new Map([['gw-1', gatewayWith()]]));
    getConfigMock.mockResolvedValue({
      hash: 'h1',
      config: { models: { providers: { clawrouter: { baseUrl: NEW_RELAY_BASE_URL } } } },
      raw: '',
      path: '',
    });
    getSessionUsageMock.mockResolvedValue(oneSession('clawrouter'));

    const relayConfig = await import('../src/main/commercial/relay-config.js');
    relayConfig.setActiveRelayBaseUrl(null); // 生产默认 = 旧端点
    const { runUsageReport } = await import('../src/main/commercial/usage-reporter.js');

    expect(await runUsageReport()).toBe(0);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('控制项：用户自建的第三方 provider 照常上报（不因放宽归属而漏记）', async () => {
    getAllGatewayClientsMock.mockReturnValue(new Map([['gw-1', gatewayWith()]]));
    getConfigMock.mockResolvedValue({
      hash: 'h1',
      config: {
        models: {
          providers: {
            mine: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
            // 同 origin、但**不是**官方端点前缀 —— 不能认成我们的。
            neighbor: { baseUrl: 'https://api.rongyinghudong.com/relay-other' },
          },
        },
      },
      raw: '',
      path: '',
    });
    getSessionUsageMock.mockResolvedValue({
      sessions: [
        {
          key: 'sess-1',
          modelUsage: [
            { provider: 'mine', model: 'm', count: 1, totals: { input: 1, output: 1 } },
            { provider: 'neighbor', model: 'm', count: 1, totals: { input: 1, output: 1 } },
          ],
        },
      ],
    });

    const relayConfig = await import('../src/main/commercial/relay-config.js');
    relayConfig.setActiveRelayBaseUrl(NEW_RELAY_BASE_URL);
    const { runUsageReport } = await import('../src/main/commercial/usage-reporter.js');

    expect(await runUsageReport()).toBe(2);
    expect(rpcMock).toHaveBeenCalledTimes(2);
  });
});

describe('P01 · 端点切换后的 provider 归属（媒体 provider 与清理）', () => {
  it('⭐ 上次运行在旧端点写的 openai 图片 provider 仍算我们的（否则能力静默失联）', async () => {
    const relayConfig = await import('../src/main/commercial/relay-config.js');
    relayConfig.setActiveRelayBaseUrl(NEW_RELAY_BASE_URL);

    expect(relayConfig.ownsOpenAIImageConfig(snapshot(ourImageConfig(LEGACY_RELAY_BASE_URL)))).toBe(true);
  });

  it('⭐ 上次运行在旧端点写的 xai 视频 provider 仍算我们的', async () => {
    const relayConfig = await import('../src/main/commercial/relay-config.js');
    relayConfig.setActiveRelayBaseUrl(NEW_RELAY_BASE_URL);

    expect(relayConfig.ownsXaiVideoConfig(snapshot(ourVideoConfig(LEGACY_RELAY_BASE_URL)))).toBe(true);
  });

  it('控制项：用户自己的 openai 图片 provider 依然**不是**我们的（不被接管/清理）', async () => {
    const relayConfig = await import('../src/main/commercial/relay-config.js');
    relayConfig.setActiveRelayBaseUrl(NEW_RELAY_BASE_URL);

    const usersOwn = snapshot({
      models: { providers: { openai: { baseUrl: 'https://api.openai.com/v1', models: [{ id: 'gpt-image-1' }] } } },
      agents: { defaults: { mediaModels: { image: { primary: 'openai/gpt-image-1' } } } },
    });
    expect(relayConfig.ownsOpenAIImageConfig(usersOwn)).toBe(false);
    expect(relayConfig.buildRelayRemovalPatch(usersOwn)).toBeNull();
  });

  it('⭐ 换端点后旧端点的媒体 provider 必须能被清账（否则注销后残留幽灵入口）', async () => {
    const relayConfig = await import('../src/main/commercial/relay-config.js');
    relayConfig.setActiveRelayBaseUrl(NEW_RELAY_BASE_URL);

    const removal = relayConfig.buildRelayRemovalPatch(snapshot(ourImageConfig(LEGACY_RELAY_BASE_URL)));

    expect(removal?.patch).toEqual({
      models: { providers: { openai: null } },
      agents: { defaults: { mediaModels: { image: { primary: null } } } },
    });
  });

  it('⭐ 换端点后旧端点的视频 provider 必须能被清账', async () => {
    const relayConfig = await import('../src/main/commercial/relay-config.js');
    relayConfig.setActiveRelayBaseUrl(NEW_RELAY_BASE_URL);

    const removal = relayConfig.buildRelayRemovalPatch(snapshot(ourVideoConfig(LEGACY_RELAY_BASE_URL)));

    expect(removal?.patch).toEqual({
      models: { providers: { xai: null } },
      agents: { defaults: { mediaModels: { video: { primary: null } } } },
    });
  });

  it('控制项：旧端点残留的普通 relay provider（换名字的用户可改 provider）也要清', async () => {
    const relayConfig = await import('../src/main/commercial/relay-config.js');
    relayConfig.setActiveRelayBaseUrl(NEW_RELAY_BASE_URL);

    const removal = relayConfig.buildRelayRemovalPatch(
      snapshot({
        models: { providers: { myClaw: { baseUrl: `${LEGACY_RELAY_BASE_URL}/` } } },
        agents: { defaults: { model: { primary: 'myClaw/deepseek-v4-flash' } } },
      }),
    );

    expect(removal?.patch).toEqual({
      models: { providers: { myClaw: null } },
      agents: { defaults: { model: { primary: null } } },
    });
  });

  it('⭐ 接管时把旧端点的媒体 provider 改写到当前端点（能力重新接线）', async () => {
    const relayConfig = await import('../src/main/commercial/relay-config.js');
    relayConfig.setActiveRelayBaseUrl(NEW_RELAY_BASE_URL);

    const patch = relayConfig.buildRelayPatch({
      relayKey: 'rly_abc',
      deviceFingerprint: 'fp',
      existingConfig: snapshot(ourImageConfig(LEGACY_RELAY_BASE_URL)),
      imageGenerationWired: true,
    });
    const providers = (patch as { models: { providers: Record<string, { baseUrl?: string }> } }).models.providers;

    expect(providers.openai?.baseUrl).toBe(`${NEW_RELAY_BASE_URL}/v1`);
  });
});

describe('P01 · 控制项：`relayProviderIds` 必须保持"只认当前端点"', () => {
  it('⭐ 活动端点=新端点时，旧端点的 provider 不算"已应用"（否则 bootstrap 不重写配置）', async () => {
    const relayConfig = await import('../src/main/commercial/relay-config.js');
    relayConfig.setActiveRelayBaseUrl(NEW_RELAY_BASE_URL);

    const ids = relayConfig.relayProviderIds(
      snapshot({ models: { providers: { clawrouter: { baseUrl: LEGACY_RELAY_BASE_URL } } } }),
    );

    expect(ids.size).toBe(0);
  });

  it('活动端点上的 provider 仍算"已应用"（幂等快路径原样保留）', async () => {
    const relayConfig = await import('../src/main/commercial/relay-config.js');
    relayConfig.setActiveRelayBaseUrl(NEW_RELAY_BASE_URL);

    const ids = relayConfig.relayProviderIds(
      snapshot({ models: { providers: { clawrouter: { baseUrl: `${NEW_RELAY_BASE_URL}/` } } } }),
    );

    expect([...ids]).toEqual(['clawrouter']);
  });
});

describe.each([
  { active: NEW_RELAY_BASE_URL, previous: LEGACY_RELAY_BASE_URL },
  { active: LEGACY_RELAY_BASE_URL, previous: NEW_RELAY_BASE_URL },
])('BUG-086 URL ownership with active=$active', ({ active, previous }) => {
  it('recognizes equivalent official URLs while keeping the current endpoint distinct', async () => {
    const relay = await import('../src/main/commercial/relay-config.js');
    relay.setActiveRelayBaseUrl(active);
    const config = snapshot({
      models: {
        providers: {
          currentCase: { baseUrl: active.replace('api.rongyinghudong.com', 'API.RONGYINGHUDONG.COM') },
          currentPort: { baseUrl: active.replace('.com/', '.com:443/') },
          currentPath: { baseUrl: `${active}/child/%2e%2e/v1/` },
          previousCase: { baseUrl: previous.replace('api.rongyinghudong.com', 'API.RONGYINGHUDONG.COM') },
          previousPort: { baseUrl: previous.replace('.com/', '.com:443/') },
          previousPath: { baseUrl: `${previous}/./v1/` },
        },
      },
    });

    expect([...relay.relayProviderIds(config)]).toEqual(['currentCase', 'currentPort', 'currentPath']);
    expect([...relay.relayOwnedProviderIds(config)]).toEqual([
      'currentCase',
      'currentPort',
      'currentPath',
      'previousCase',
      'previousPort',
      'previousPath',
    ]);
    expect(relay.buildRelayRemovalPatch(config)?.patch).toEqual({
      models: {
        providers: {
          currentCase: null,
          currentPort: null,
          currentPath: null,
          previousCase: null,
          previousPort: null,
          previousPath: null,
        },
      },
    });
  });

  it.each(['..', '%2e%2e', '.%2E'])('preserves providers escaping through %s', async (dotSegment) => {
    const relay = await import('../src/main/commercial/relay-config.js');
    relay.setActiveRelayBaseUrl(active);
    const config = snapshot({
      models: {
        providers: {
          currentEscape: { baseUrl: `${active}/${dotSegment}/relay-other` },
          previousEscape: { baseUrl: `${previous}/${dotSegment}/relay-other` },
        },
      },
    });

    expect([...relay.relayProviderIds(config)]).toEqual([]);
    expect([...relay.relayOwnedProviderIds(config)]).toEqual([]);
    expect(relay.buildRelayRemovalPatch(config)).toBeNull();
  });

  it('preserves adjacent paths, different origins and third-party hosts', async () => {
    const relay = await import('../src/main/commercial/relay-config.js');
    relay.setActiveRelayBaseUrl(active);
    for (const baseUrl of [
      `${active}-other/v1`,
      `${previous}-other/v1`,
      active.replace('https:', 'http:'),
      active.replace('.com/', '.com:444/'),
      active.replace('.com/', '.com.example.test/'),
      'https://example.test/relay/v1',
      'https://example.test/relay-108/v1',
    ]) {
      const config = snapshot({ models: { providers: { mine: { baseUrl } } } });
      expect([...relay.relayProviderIds(config)], baseUrl).toEqual([]);
      expect([...relay.relayOwnedProviderIds(config)], baseUrl).toEqual([]);
      expect(relay.buildRelayRemovalPatch(config), baseUrl).toBeNull();
    }
  });

  it('rejects malformed and ambiguous URL forms without removing providers', async () => {
    const relay = await import('../src/main/commercial/relay-config.js');
    relay.setActiveRelayBaseUrl(active);
    for (const baseUrl of [
      'not a URL',
      'https://[invalid]/relay',
      active.replace('https://', '//'),
      active.replace('https://', 'https:///'),
      active.replace('https://', 'https://user:password@'),
      active.replace('https://', 'https://@'),
      `${active}/v1?mode=other`,
      `${active}/v1#other`,
      `${active}/v1?`,
      `${active}/v1#`,
      ` ${active}`,
      `${active}/v1\t`,
      `${active}/v1\u0000`,
      `${active}/\\../relay-other`,
      `${active}/%2f../relay-other`,
      `${active}/%5c../relay-other`,
      `${active}/%252e%252e/relay-other`,
      `${active}/%00`,
      `${active}/%zz`,
    ]) {
      const config = snapshot({ models: { providers: { mine: { baseUrl } } } });
      expect([...relay.relayProviderIds(config)], baseUrl).toEqual([]);
      expect([...relay.relayOwnedProviderIds(config)], baseUrl).toEqual([]);
      expect(relay.buildRelayRemovalPatch(config), baseUrl).toBeNull();
    }
  });

  it('reports only escaped, neighboring and third-party providers in a mixed usage snapshot', async () => {
    const relay = await import('../src/main/commercial/relay-config.js');
    relay.setActiveRelayBaseUrl(active);
    const providers = {
      current: { baseUrl: active.replace('.com/', '.com:443/') },
      previous: { baseUrl: previous.replace('api.rongyinghudong.com', 'API.RONGYINGHUDONG.COM') },
      escaped: { baseUrl: `${previous}/%2e%2e/relay-other` },
      neighbor: { baseUrl: `${active}-other` },
      thirdParty: { baseUrl: 'https://example.test/relay/v1' },
    };
    getAllGatewayClientsMock.mockReturnValue(new Map([['gw-1', gatewayWith()]]));
    getConfigMock.mockResolvedValue(snapshot({ models: { providers } }));
    getSessionUsageMock.mockResolvedValue({
      sessions: [
        {
          key: 'mixed-url-session',
          modelUsage: Object.keys(providers).map((provider) => ({
            provider,
            model: provider,
            count: 1,
            totals: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
          })),
        },
      ],
    });
    const { runUsageReport } = await import('../src/main/commercial/usage-reporter.js');

    expect(await runUsageReport()).toBe(3);
    expect(rpcMock).toHaveBeenCalledTimes(3);
    for (const model of ['escaped', 'neighbor', 'thirdParty']) {
      expect(rpcMock).toHaveBeenCalledWith('report_usage', expect.objectContaining({ p_model: model }));
    }
  });

  describe.each([
    {
      provider: 'openai',
      kind: 'image',
      model: OPENAI_IMAGE_MODEL_REF,
      foreignModel: 'openai/gpt-image-1',
      foreignUrl: 'https://api.openai.com/v1',
    },
    {
      provider: 'xai',
      kind: 'video',
      model: XAI_VIDEO_MODEL_REF,
      foreignModel: 'xai/user-video',
      foreignUrl: 'https://api.x.ai/v1',
    },
  ])('$provider independent media guards', ({ provider, kind, model, foreignModel, foreignUrl }) => {
    function mediaSnapshot(baseUrl: string, primary: string) {
      return snapshot({
        models: { providers: { [provider]: { baseUrl } } },
        agents: { defaults: { mediaModels: { [kind]: { primary } } } },
      });
    }

    it('recognizes equivalent exact media URLs and rewrites them to the active endpoint', async () => {
      const relay = await import('../src/main/commercial/relay-config.js');
      relay.setActiveRelayBaseUrl(active);
      const owns = provider === 'openai' ? relay.ownsOpenAIImageConfig : relay.ownsXaiVideoConfig;
      for (const base of [active, previous]) {
        const config = mediaSnapshot(
          `${base.replace('api.rongyinghudong.com', 'API.RONGYINGHUDONG.COM:443')}/child/%2e%2e/v1/`,
          model,
        );
        expect(owns(config)).toBe(true);
        expect(relay.buildRelayRemovalPatch(config)?.patch).toEqual({
          models: { providers: { [provider]: null } },
          agents: { defaults: { mediaModels: { [kind]: { primary: null } } } },
        });
        expect(
          relay.buildRelayPatch({
            relayKey: 'rly_test',
            deviceFingerprint: 'test-fp',
            existingConfig: config,
            imageGenerationWired: true,
            videoGenerationWired: true,
          }),
        ).toHaveProperty(`models.providers.${provider}.baseUrl`, `${active}/v1`);
      }
    });

    it('keeps our model ref on a third-party URL untouched', async () => {
      const relay = await import('../src/main/commercial/relay-config.js');
      relay.setActiveRelayBaseUrl(active);
      const owns = provider === 'openai' ? relay.ownsOpenAIImageConfig : relay.ownsXaiVideoConfig;
      const config = mediaSnapshot(foreignUrl, model);

      expect(owns(config)).toBe(false);
      expect(relay.buildRelayRemovalPatch(config)).toBeNull();
      expect(
        relay.buildRelayPatch({
          relayKey: 'rly_test',
          deviceFingerprint: 'test-fp',
          existingConfig: config,
          imageGenerationWired: true,
          videoGenerationWired: true,
        }),
      ).not.toHaveProperty(`models.providers.${provider}`);
    });

    it('keeps a foreign model ref on either official URL untouched', async () => {
      const relay = await import('../src/main/commercial/relay-config.js');
      relay.setActiveRelayBaseUrl(active);
      const owns = provider === 'openai' ? relay.ownsOpenAIImageConfig : relay.ownsXaiVideoConfig;
      for (const base of [active, previous]) {
        const config = mediaSnapshot(`${base}/v1`, foreignModel);
        expect(owns(config)).toBe(false);
        expect(relay.buildRelayRemovalPatch(config)).toBeNull();
        expect(
          relay.buildRelayPatch({
            relayKey: 'rly_test',
            deviceFingerprint: 'test-fp',
            existingConfig: config,
            imageGenerationWired: true,
            videoGenerationWired: true,
          }),
        ).not.toHaveProperty(`models.providers.${provider}`);
      }
    });

    it('keeps our model ref on escaped, adjacent and extra media paths untouched', async () => {
      const relay = await import('../src/main/commercial/relay-config.js');
      relay.setActiveRelayBaseUrl(active);
      const owns = provider === 'openai' ? relay.ownsOpenAIImageConfig : relay.ownsXaiVideoConfig;
      for (const base of [active, previous]) {
        for (const suffix of ['/../relay-other/v1', '/%2e%2e/relay-other/v1', '-other/v1', '/v1/extra']) {
          const config = mediaSnapshot(`${base}${suffix}`, model);
          expect(owns(config), suffix).toBe(false);
          expect(relay.buildRelayRemovalPatch(config), suffix).toBeNull();
          expect(
            relay.buildRelayPatch({
              relayKey: 'rly_test',
              deviceFingerprint: 'test-fp',
              existingConfig: config,
              imageGenerationWired: true,
              videoGenerationWired: true,
            }),
            suffix,
          ).not.toHaveProperty(`models.providers.${provider}`);
        }
      }
    });
  });
});

describe('BUG-086 controlled active endpoints', () => {
  it.each([
    { active: 'http://localhost:8791/test-relay', equivalent: 'http://LOCALHOST:8791/test-relay/' },
    { active: 'http://localhost:80', equivalent: 'http://LOCALHOST/' },
    { active: 'http://127.0.0.1:8791', equivalent: 'http://127.0.0.1:8791/' },
  ])('retains HTTP localhost support for $active', async ({ active, equivalent }) => {
    const relay = await import('../src/main/commercial/relay-config.js');
    relay.setActiveRelayBaseUrl(active);
    const config = snapshot({
      models: {
        providers: {
          local: { baseUrl: equivalent },
          old: { baseUrl: LEGACY_RELAY_BASE_URL },
          next: { baseUrl: NEW_RELAY_BASE_URL },
          otherPort: { baseUrl: 'http://localhost:8792/test-relay' },
        },
      },
    });

    expect([...relay.relayProviderIds(config)]).toEqual(['local']);
    expect([...relay.relayOwnedProviderIds(config)]).toEqual(['local', 'old', 'next']);
    expect(relay.ownsOpenAIImageConfig(snapshot(ourImageConfig(equivalent.replace(/\/+$/, ''))))).toBe(true);
    expect(relay.ownsXaiVideoConfig(snapshot(ourVideoConfig(equivalent.replace(/\/+$/, ''))))).toBe(true);
    expect(relay.buildRelayRemovalPatch(config)?.patch).toEqual({
      models: { providers: { local: null, old: null, next: null } },
    });
  });

  it('does not trust a malformed or ambiguous active endpoint by string equality', async () => {
    const relay = await import('../src/main/commercial/relay-config.js');
    for (const active of [
      'not a URL',
      'ftp://localhost/relay',
      'http://user:password@localhost:8791/relay',
      'http://localhost:8791/relay?other',
    ]) {
      relay.setActiveRelayBaseUrl(active);
      const config = snapshot({ models: { providers: { invalid: { baseUrl: active } } } });
      expect([...relay.relayProviderIds(config)], active).toEqual([]);
      expect([...relay.relayOwnedProviderIds(config)], active).toEqual([]);
      expect(relay.buildRelayRemovalPatch(config), active).toBeNull();
    }
  });
});

describe.each([
  { active: NEW_RELAY_BASE_URL, currentId: 'next' },
  { active: LEGACY_RELAY_BASE_URL, currentId: 'old' },
])('BUG-086 followup canonical paths with active=$active', ({ active, currentId }) => {
  it.each([
    { oldPath: '/%72elay', nextPath: '/%72elay-108' },
    { oldPath: '/rela%79', nextPath: '/relay%2d108' },
    { oldPath: '//relay', nextPath: '//relay-108' },
  ])('recognizes safe equivalent paths $oldPath and $nextPath', async ({ oldPath, nextPath }) => {
    const relay = await import('../src/main/commercial/relay-config.js');
    relay.setActiveRelayBaseUrl(active);
    const config = snapshot({
      models: {
        providers: {
          old: { baseUrl: `https://api.rongyinghudong.com${oldPath}` },
          next: { baseUrl: `https://api.rongyinghudong.com${nextPath}` },
        },
      },
    });

    expect([...relay.relayProviderIds(config)]).toEqual([currentId]);
    expect([...relay.relayOwnedProviderIds(config)]).toEqual(['old', 'next']);
    expect(relay.buildRelayRemovalPatch(config)?.patch).toEqual({
      models: { providers: { old: null, next: null } },
    });
  });

  it('does not expand canonical ownership to neighboring paths, other hosts or encoded delimiters', async () => {
    const relay = await import('../src/main/commercial/relay-config.js');
    relay.setActiveRelayBaseUrl(active);
    for (const baseUrl of [
      'https://api.rongyinghudong.com//%72elay-other',
      'https://api.rongyinghudong.com/relay%2d108-other',
      'https://api.rongyinghudong.com//relay-108/%2e%2e/relay-other',
      'https://example.test//%72elay-108',
      'https://api.rongyinghudong.com.evil.test//relay-108',
      `${active}/%2f/../v1`,
      `${active}/%5c/../v1`,
      `${active}/%252e%252e/../v1`,
    ]) {
      const config = snapshot({ models: { providers: { mine: { baseUrl } } } });
      expect([...relay.relayProviderIds(config)], baseUrl).toEqual([]);
      expect([...relay.relayOwnedProviderIds(config)], baseUrl).toEqual([]);
      expect(relay.buildRelayRemovalPatch(config), baseUrl).toBeNull();
    }
  });

  it('skips both canonical official providers while reporting the adjacent path', async () => {
    const relay = await import('../src/main/commercial/relay-config.js');
    relay.setActiveRelayBaseUrl(active);
    const providers = {
      old: { baseUrl: 'https://api.rongyinghudong.com//%72elay' },
      next: { baseUrl: 'https://api.rongyinghudong.com//relay%2D108' },
      neighbor: { baseUrl: 'https://api.rongyinghudong.com//%72elay-other' },
    };
    getAllGatewayClientsMock.mockReturnValue(new Map([['gw-1', gatewayWith()]]));
    getConfigMock.mockResolvedValue(snapshot({ models: { providers } }));
    getSessionUsageMock.mockResolvedValue({
      sessions: [
        {
          key: 'canonical-path-session',
          modelUsage: Object.keys(providers).map((provider) => ({
            provider,
            model: provider,
            count: 1,
            totals: { input: 10, output: 20 },
          })),
        },
      ],
    });
    const { runUsageReport } = await import('../src/main/commercial/usage-reporter.js');

    expect(await runUsageReport()).toBe(1);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith('report_usage', expect.objectContaining({ p_provider: 'neighbor' }));
  });

  it.each(['..', '%2e%2e', '.%2E'])('rejects raw repeated-slash/dot ambiguity with %s', async (dotSegment) => {
    const relay = await import('../src/main/commercial/relay-config.js');
    relay.setActiveRelayBaseUrl(active);
    for (const base of [LEGACY_RELAY_BASE_URL, NEW_RELAY_BASE_URL]) {
      const config = snapshot({
        models: { providers: { mine: { baseUrl: `${base}//${dotSegment}/relay-other` } } },
      });
      expect([...relay.relayProviderIds(config)]).toEqual([]);
      expect([...relay.relayOwnedProviderIds(config)]).toEqual([]);
      expect(relay.buildRelayRemovalPatch(config)).toBeNull();
    }
  });

  describe.each([
    { provider: 'openai', kind: 'image', model: OPENAI_IMAGE_MODEL_REF, foreignModel: 'openai/gpt-image-1' },
    { provider: 'xai', kind: 'video', model: XAI_VIDEO_MODEL_REF, foreignModel: 'xai/user-video' },
  ])('$provider canonical media paths', ({ provider, kind, model, foreignModel }) => {
    function mediaSnapshot(baseUrl: string, primary: string) {
      return snapshot({
        models: { providers: { [provider]: { baseUrl } } },
        agents: { defaults: { mediaModels: { [kind]: { primary } } } },
      });
    }

    it('recognizes encoded v1 and merged slashes on both official media endpoints', async () => {
      const relay = await import('../src/main/commercial/relay-config.js');
      relay.setActiveRelayBaseUrl(active);
      const owns = provider === 'openai' ? relay.ownsOpenAIImageConfig : relay.ownsXaiVideoConfig;
      for (const base of [LEGACY_RELAY_BASE_URL, NEW_RELAY_BASE_URL]) {
        for (const baseUrl of [`${base}/%76%31`, `${base}//v1//`, `${base.replace('/relay', '//%72elay')}//%76%31/`]) {
          const config = mediaSnapshot(baseUrl, model);
          expect(owns(config), baseUrl).toBe(true);
          expect(relay.buildRelayRemovalPatch(config)?.patch).toEqual({
            models: { providers: { [provider]: null } },
            agents: { defaults: { mediaModels: { [kind]: { primary: null } } } },
          });
          expect(
            relay.buildRelayPatch({
              relayKey: 'rly_test',
              deviceFingerprint: 'test-fp',
              existingConfig: config,
              imageGenerationWired: true,
              videoGenerationWired: true,
            }),
          ).toHaveProperty(`models.providers.${provider}.baseUrl`, `${active}/v1`);
        }
      }
    });

    it('preserves the independent media URL and model guards after canonicalization', async () => {
      const relay = await import('../src/main/commercial/relay-config.js');
      relay.setActiveRelayBaseUrl(active);
      const owns = provider === 'openai' ? relay.ownsOpenAIImageConfig : relay.ownsXaiVideoConfig;
      for (const config of [
        mediaSnapshot('https://example.test//%72elay-108/%76%31', model),
        mediaSnapshot('https://api.rongyinghudong.com//%72elay-other/%76%31', model),
        mediaSnapshot('https://api.rongyinghudong.com//relay%2D108/%76%31/extra', model),
        mediaSnapshot('https://api.rongyinghudong.com//%72elay/%76%31', foreignModel),
        mediaSnapshot('https://api.rongyinghudong.com//relay%2D108/%76%31', foreignModel),
      ]) {
        expect(owns(config)).toBe(false);
        expect(relay.buildRelayRemovalPatch(config)).toBeNull();
        expect(
          relay.buildRelayPatch({
            relayKey: 'rly_test',
            deviceFingerprint: 'test-fp',
            existingConfig: config,
            imageGenerationWired: true,
            videoGenerationWired: true,
          }),
        ).not.toHaveProperty(`models.providers.${provider}`);
      }
    });

    it('does not own or rewrite raw ambiguous media URLs even if WHATWG ends at v1', async () => {
      const relay = await import('../src/main/commercial/relay-config.js');
      relay.setActiveRelayBaseUrl(active);
      const owns = provider === 'openai' ? relay.ownsOpenAIImageConfig : relay.ownsXaiVideoConfig;
      for (const base of [LEGACY_RELAY_BASE_URL, NEW_RELAY_BASE_URL]) {
        for (const suffix of ['//../v1', '//%2e%2e/v1', '//./v1', '/%2e//v1']) {
          const config = mediaSnapshot(`${base}${suffix}`, model);
          expect(owns(config), suffix).toBe(false);
          expect(relay.buildRelayRemovalPatch(config), suffix).toBeNull();
          expect(
            relay.buildRelayPatch({
              relayKey: 'rly_test',
              deviceFingerprint: 'test-fp',
              existingConfig: config,
              imageGenerationWired: true,
              videoGenerationWired: true,
            }),
            suffix,
          ).not.toHaveProperty(`models.providers.${provider}`);
        }
      }
    });
  });
});

describe('BUG-086 followup controlled endpoint paths', () => {
  it('canonicalizes safe local provider and active endpoint paths without mixing ports', async () => {
    const relay = await import('../src/main/commercial/relay-config.js');
    for (const active of ['http://localhost:8791/test-relay', 'http://localhost:8791//%74est-relay']) {
      relay.setActiveRelayBaseUrl(active);
      const config = snapshot({
        models: {
          providers: {
            local: { baseUrl: 'http://LOCALHOST:8791//%74est-relay/%76%31' },
            otherPort: { baseUrl: 'http://localhost:8792//%74est-relay/v1' },
            neighbor: { baseUrl: 'http://localhost:8791//%74est-relay-other/v1' },
          },
        },
      });
      expect([...relay.relayProviderIds(config)]).toEqual(['local']);
      expect([...relay.relayOwnedProviderIds(config)]).toEqual(['local']);
      expect(relay.ownsOpenAIImageConfig(snapshot(ourImageConfig('http://localhost:8791/test-relay')))).toBe(true);
      expect(relay.ownsXaiVideoConfig(snapshot(ourVideoConfig('http://localhost:8791/test-relay')))).toBe(true);
    }
  });

  it('does not use an ambiguous active path to claim a canonical local provider', async () => {
    const relay = await import('../src/main/commercial/relay-config.js');
    relay.setActiveRelayBaseUrl('http://localhost:8791/relay//../relay-other');
    const config = snapshot({
      models: { providers: { mine: { baseUrl: 'http://localhost:8791/relay/relay-other' } } },
    });
    expect([...relay.relayProviderIds(config)]).toEqual([]);
    expect([...relay.relayOwnedProviderIds(config)]).toEqual([]);
    expect(relay.buildRelayRemovalPatch(config)).toBeNull();
  });
});

/**
 * BUG-086 残留 LOW（Lead 复现后补钉，2026-10-16）：
 * **尾点主机（FQDN 根点）等价性**。
 *
 * `api.rongyinghudong.com.` 与 `api.rongyinghudong.com` 在 DNS 上等价（尾点是"绝对域名"写法），
 * 但 WHATWG URL **保留**尾点 ⇒ `origin` 不等 ⇒ 归属判据漏认官方端点。
 * 漏认方向 = 本该跳过的用量被 `report_usage` 再报一次（**可能双扣**），
 * 媒体侧则是"既不被接管也不被清理"的幽灵残留。
 *
 * 写入侧不会产生尾点（我们只写 `RELAY_BASE_URL`），所以触发前提是**用户/第三方手改配置**；
 * 这条 LOW 于本轮独立复审提出、由 Lead 复现并修复。
 */
describe('BUG-086 残留 LOW：尾点主机（FQDN 根点）必须与官方端点等价', () => {
  const ACTIVE_OLD = 'https://api.rongyinghudong.com/relay';
  const ACTIVE_NEW = 'https://api.rongyinghudong.com/relay-108';

  it('every official endpoint written with a trailing dot is still ours (漏认=可能双扣)', async () => {
    const relay = await import('../src/main/commercial/relay-config.js');
    relay.setActiveRelayBaseUrl(ACTIVE_NEW);
    const config = snapshot({
      models: {
        providers: {
          old: { baseUrl: 'https://api.rongyinghudong.com./relay' },
          next: { baseUrl: 'https://api.rongyinghudong.com./relay-108' },
          stranger: { baseUrl: 'https://example.test./v1' },
        },
      },
    });
    expect([...relay.relayOwnedProviderIds(config)]).toEqual(['old', 'next']);
    expect(relay.buildRelayRemovalPatch(config)?.patch).toEqual({
      models: { providers: { old: null, next: null } },
    });
    // 控制项：尾点不许把别人的主机也变成"我们的"
    expect([...relay.relayOwnedProviderIds(config)]).not.toContain('stranger');
  });

  it('relayProviderIds still answers "current endpoint" when the config spelling carries a trailing dot', async () => {
    const relay = await import('../src/main/commercial/relay-config.js');
    relay.setActiveRelayBaseUrl(ACTIVE_OLD);
    const config = snapshot({
      models: {
        providers: {
          dotted: { baseUrl: 'https://api.rongyinghudong.com./relay' },
          plain: { baseUrl: 'https://api.rongyinghudong.com/relay' },
        },
      },
    });
    expect([...relay.relayProviderIds(config)]).toEqual(['dotted', 'plain']);
  });

  it('media providers written with a trailing dot are ours (接管与清账都不能漏)', async () => {
    const relay = await import('../src/main/commercial/relay-config.js');
    relay.setActiveRelayBaseUrl(ACTIVE_NEW);
    expect(relay.ownsOpenAIImageConfig(snapshot(ourImageConfig('https://api.rongyinghudong.com./relay-108')))).toBe(
      true,
    );
    expect(relay.ownsXaiVideoConfig(snapshot(ourVideoConfig('https://api.rongyinghudong.com./relay')))).toBe(true);
    // 控制项：相邻前缀 + 尾点仍然不是我们的
    expect(relay.ownsOpenAIImageConfig(snapshot(ourImageConfig('https://api.rongyinghudong.com./relay-other')))).toBe(
      false,
    );
  });

  it('a trailing dot must not become an escape hatch (dot segments / look-alike host stay foreign)', async () => {
    const relay = await import('../src/main/commercial/relay-config.js');
    relay.setActiveRelayBaseUrl(ACTIVE_NEW);
    for (const baseUrl of [
      'https://api.rongyinghudong.com./relay-108/../relay-other',
      'https://api.rongyinghudong.com./relay-108/%2e%2e/relay-other',
      'https://api.rongyinghudong.com.evil.test./relay-108',
      'https://api.rongyinghudong.com./relay-other',
    ]) {
      const config = snapshot({ models: { providers: { mine: { baseUrl } } } });
      expect([...relay.relayOwnedProviderIds(config)], baseUrl).toEqual([]);
      expect(relay.buildRelayRemovalPatch(config), baseUrl).toBeNull();
    }
  });
});
