import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyRelayConfig, buildRelayPatch } from '../src/main/commercial/relay-config.js';
import { ensureRelayConfigured } from '../src/main/commercial/relay-bootstrap.js';

const { readConfigMock, getAllGatewayClientsMock, getCommercialClientMock } = vi.hoisted(() => ({
  readConfigMock: vi.fn(),
  getAllGatewayClientsMock: vi.fn(),
  getCommercialClientMock: vi.fn(),
}));

vi.mock('../src/main/workspace/config.js', () => ({
  ensureDeviceId: () => 'search-test-device',
  readConfig: readConfigMock,
  updateConfig: vi.fn(),
}));
vi.mock('../src/main/ws/index.js', () => ({ getAllGatewayClients: getAllGatewayClientsMock }));
vi.mock('../src/main/commercial/client.js', () => ({ getCommercialClient: getCommercialClientMock }));
vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));
vi.mock('../src/main/runtime/index.js', () => ({ getActiveLocalGatewayStateDir: () => 'search-test-state' }));
vi.mock('../src/main/runtime/bundled-search.js', () => ({ hasInstalledSearchProvider: () => true }));

const INPUT = { relayKey: 'test-relay-key', deviceFingerprint: 'test-device' };
const SEARCH_REFS = ['clawrouter/qwen-turbo', 'clawrouter/qwen-plus', 'clawrouter/qwen3.7-flash'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergePatch(base: unknown, patch: unknown): unknown {
  if (!isRecord(patch)) return patch;
  const result = isRecord(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

function makeGateway(initial: Record<string, unknown> = {}) {
  let config: unknown = initial;
  const getConfig = vi.fn(async () => ({ hash: 'test-hash', config }));
  const patchConfig = vi.fn(async ({ raw }: { baseHash: string; raw: string }) => {
    config = mergePatch(config, JSON.parse(raw));
    return { ok: true };
  });
  return {
    isConnected: true,
    getConfig,
    patchConfig,
    runConfigMutation: async <T>(
      work: (tx: { getConfig: typeof getConfig; patchConfig: typeof patchConfig }) => Promise<T>,
    ) => work({ getConfig, patchConfig }),
  };
}

function searchPath(ref: string): string[] {
  return ['agents', 'defaults', 'models', ref, 'params', 'extra_body', 'enable_search'];
}

function tableResult(data: unknown) {
  const result = { data, error: null };
  const query = {
    select: () => query,
    eq: () => query,
    order: () => query,
    maybeSingle: async () => result,
    then: (onFulfilled: (value: typeof result) => unknown) => Promise.resolve(result).then(onFulfilled),
  };
  return query;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('relay search preference merge patches', () => {
  it('deletes only the owned search leaves when disabled', () => {
    const patch = buildRelayPatch({ ...INPUT, webSearch: false });
    expect(patch).toHaveProperty(['agents', 'defaults', 'models'], {
      'clawrouter/qwen-turbo': { params: { extra_body: { enable_search: null } } },
      'clawrouter/qwen-plus': { params: { extra_body: { enable_search: null } } },
      'clawrouter/qwen3.7-flash': { params: { extra_body: { enable_search: null } } },
    });
    expect(patch).not.toHaveProperty('tools');
  });

  it('supports on-off-on without replacing sibling parameters or user configuration', async () => {
    const initial = {
      agents: {
        defaults: {
          model: { primary: 'custom/model' },
          models: {
            'clawrouter/qwen-turbo': {
              alias: 'Turbo',
              params: { temperature: 0.4, extra_body: { custom_option: 'keep' } },
            },
            'clawrouter/qwen-plus': { params: { top_p: 0.8, extra_body: { custom_option: 'also-keep' } } },
            'custom/qwen-plus': { params: { extra_body: { enable_search: true } } },
            'clawrouter/deepseek-v4-flash': { params: { temperature: 0.2 } },
          },
        },
      },
      models: { providers: { custom: { baseUrl: 'https://example.test/v1' } } },
      tools: { web: { search: { enabled: true, provider: 'brave' } } },
    };
    const gateway = makeGateway(initial);

    for (const enabled of [true, false, true]) {
      const result = await applyRelayConfig(gateway, { ...INPUT, webSearch: enabled });
      expect(result.configured).toBe(true);
      const { config } = await gateway.getConfig();
      for (const ref of SEARCH_REFS) {
        if (enabled) expect(config).toHaveProperty(searchPath(ref), true);
        else expect(config).not.toHaveProperty(searchPath(ref));
      }
      expect(config).toMatchObject(initial);
    }
  });

  it.each([undefined, true])('keeps search enabled for preference %s', async (webSearch) => {
    const gateway = makeGateway();
    const result = await applyRelayConfig(gateway, { ...INPUT, webSearch });
    expect(result.configured).toBe(true);
    const { config } = await gateway.getConfig();
    for (const ref of SEARCH_REFS) expect(config).toHaveProperty(searchPath(ref), true);
    expect(config).not.toHaveProperty('tools');
  });

  it('removes existing search flags when a capability refresh reads false', async () => {
    const gateway = makeGateway();
    await applyRelayConfig(gateway, INPUT);
    const result = await ensureRelayConfigured({
      hasCommercialClient: () => true,
      checkAuth: async () => 'authenticated',
      readLicenseKey: async () => 'test-license',
      fetchRelayKey: async () => ({ ok: true, relayKey: INPUT.relayKey }),
      getGateway: () => gateway,
      deviceFingerprint: () => INPUT.deviceFingerprint,
      webSearchEnabled: () => false,
      resolveMediaCapabilities: async () => ({ image: false, video: false }),
    });
    expect(result.status).toBe('applied');
    const { config } = await gateway.getConfig();
    for (const ref of SEARCH_REFS) expect(config).not.toHaveProperty(searchPath(ref));
  });

  it.each([
    [true, true],
    [true, false],
    [false, true],
  ] as const)(
    'forwards selected gateway availability %s and saved preference %s during startup',
    async (available, webSearch) => {
      const gateway = { ...makeGateway(), bundledWebSearchAvailable: available };
      const result = await ensureRelayConfigured({
        hasCommercialClient: () => true,
        checkAuth: async () => 'authenticated',
        readLicenseKey: async () => 'test-license',
        fetchRelayKey: async () => ({ ok: true, relayKey: INPUT.relayKey }),
        getGateway: () => gateway,
        deviceFingerprint: () => INPUT.deviceFingerprint,
        webSearchEnabled: () => webSearch,
        resolveMediaCapabilities: async () => ({ image: false, video: false }),
      });
      expect(result.status).toBe('applied');
      const { config } = await gateway.getConfig();
      if (available && webSearch)
        expect(config).toHaveProperty(['tools', 'web', 'search', 'provider'], 'rongying-search');
      else expect(config).not.toHaveProperty(['tools', 'web', 'search']);
    },
  );
});

describe('license activation search preference', () => {
  it.each([
    ['test-gateway', false],
    ['test-gateway', true],
    ['test-gateway', undefined],
    ['local-runtime', false],
    ['local-runtime', true],
    ['local-runtime', undefined],
  ] as const)(
    'honors the selected gateway %s and saved preference %s during activation',
    async (gatewayId, webSearch) => {
      const gateway = makeGateway();
      await applyRelayConfig(gateway, INPUT);
      getAllGatewayClientsMock.mockReturnValue(new Map([[gatewayId, gateway]]));
      readConfigMock.mockReturnValue({ webSearch, commercial: { licenseKey: 'test-license' } });
      getCommercialClientMock.mockReturnValue({
        auth: { getUser: async () => ({ data: { user: { id: 'test-user' } }, error: null }) },
        rpc: async () => ({ data: { relayKey: INPUT.relayKey }, error: null }),
        from: (table: string) => {
          if (table === 'org_members') return tableResult([{ org_id: 'test-org' }]);
          if (table === 'licenses') {
            return tableResult({
              id: 'test-license-id',
              org_id: 'test-org',
              license_key: 'test-license',
              sku: 'test-sku',
              status: 'active',
              expires_at: null,
              max_activations: 1,
              token_quota_micros: 0,
              token_used_micros: 0,
            });
          }
          throw new Error(`Unexpected table: ${table}`);
        },
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: false, status: 503 })),
      );

      const { activateLicense } = await import('../src/main/commercial/license.js');
      const result = await activateLicense('test-license');
      expect(result).toMatchObject({ ok: true, result: { activated: true, relayConfigured: true } });
      const { config } = await gateway.getConfig();
      for (const ref of SEARCH_REFS) {
        if (webSearch === false) expect(config).not.toHaveProperty(searchPath(ref));
        else expect(config).toHaveProperty(searchPath(ref), true);
      }
      if (gatewayId === 'local-runtime' && webSearch !== false) {
        expect(config).toHaveProperty(['tools', 'web', 'search', 'provider'], 'rongying-search');
      } else {
        expect(config).not.toHaveProperty(['tools', 'web', 'search']);
      }
    },
  );
});
