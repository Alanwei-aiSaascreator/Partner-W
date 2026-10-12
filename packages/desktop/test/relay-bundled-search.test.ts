import { describe, expect, it } from 'vitest';
import { applyRelayConfig, buildRelayPatch } from '../src/main/commercial/relay-config.js';
import { RELAY_SEARCH_PLUGIN_ID } from '../src/main/runtime/relay-search-plugin.js';

const INPUT = { relayKey: 'fixture-relay-key', deviceFingerprint: 'fixture-device', bundledWebSearchAvailable: true };
const RELAY_BASE = 'https://api.rongyinghudong.com/relay';

describe('installed relay web search configuration', () => {
  it('selects the installed relay provider explicitly and writes its relay connection config', () => {
    const patch = buildRelayPatch(INPUT);
    expect(patch).toHaveProperty('tools.web.search', { enabled: true, provider: RELAY_SEARCH_PLUGIN_ID });
    expect(patch).toHaveProperty(`plugins.entries.${RELAY_SEARCH_PLUGIN_ID}.enabled`, true);
    // 连接配置随激活写入：baseUrl=活体 relay 地址、apiKey=活体 relay key（与 clawrouter 同一把）。
    expect(patch).toHaveProperty(`plugins.entries.${RELAY_SEARCH_PLUGIN_ID}.config.webSearch`, {
      baseUrl: RELAY_BASE,
      apiKey: 'fixture-relay-key',
    });
    expect(patch).not.toHaveProperty('plugins.allow');
  });

  it.each([undefined, false])('does not invent provider availability when the runtime reports %s', (available) => {
    const patch = buildRelayPatch({ ...INPUT, bundledWebSearchAvailable: available });
    expect(patch).not.toHaveProperty('tools');
    expect(patch).not.toHaveProperty(`plugins.entries.${RELAY_SEARCH_PLUGIN_ID}`);
  });

  it('does not select a provider when the saved preference is off', () => {
    const patch = buildRelayPatch({ ...INPUT, webSearch: false });
    expect(patch).not.toHaveProperty('tools');
    expect(patch).not.toHaveProperty(`plugins.entries.${RELAY_SEARCH_PLUGIN_ID}`);
  });

  it('disables and re-enables without clearing user-tunable search settings', () => {
    const existingConfig = {
      config: {
        tools: { web: { search: { enabled: true, provider: RELAY_SEARCH_PLUGIN_ID, cacheTtlMinutes: 7 } } },
        plugins: {
          entries: {
            [RELAY_SEARCH_PLUGIN_ID]: {
              enabled: true,
              config: { webSearch: { baseUrl: 'http://old', apiKey: 'old' } },
            },
          },
        },
      },
    };
    const disabled = buildRelayPatch({ ...INPUT, existingConfig, webSearch: false });
    expect(disabled).toHaveProperty('tools.web.search', { enabled: false });
    expect(disabled).not.toHaveProperty('plugins.entries');
    // 用户调过的缓存 TTL 不重写（merge patch 省略键 = 保持原值）。
    expect(disabled).not.toHaveProperty('tools.web.search.cacheTtlMinutes');
    existingConfig.config.tools.web.search.enabled = false;
    const enabled = buildRelayPatch({ ...INPUT, existingConfig, webSearch: true });
    expect(enabled).toHaveProperty('tools.web.search', { enabled: true, provider: RELAY_SEARCH_PLUGIN_ID });
    // ⚠️ 与旧 duckduckgo 语义的**有意差异**：连接配置（baseUrl/apiKey）每次激活都重写 ——
    //    它们是"打到哪 + 用什么凭据"，会随测试/生产环境切换，必须跟随活体值；用户侧可调项
    //    （maxResults/timeoutSeconds/cacheTtlMinutes）在 tools.web.search 下，本 patch 不碰。
    expect(enabled).toHaveProperty(`plugins.entries.${RELAY_SEARCH_PLUGIN_ID}.config.webSearch`, {
      baseUrl: RELAY_BASE,
      apiKey: 'fixture-relay-key',
    });
    expect(enabled).not.toHaveProperty('tools.web.search.cacheTtlMinutes');
  });

  it('takes over a legacy duckduckgo selection written by an older version', () => {
    const patch = buildRelayPatch({
      ...INPUT,
      existingConfig: {
        config: { tools: { web: { search: { enabled: true, provider: 'duckduckgo' } } } },
      },
    });
    expect(patch).toHaveProperty('tools.web.search', { enabled: true, provider: RELAY_SEARCH_PLUGIN_ID });
    expect(patch).toHaveProperty(`plugins.entries.${RELAY_SEARCH_PLUGIN_ID}.enabled`, true);
  });

  it.each([true, false])('preserves a user search provider when preference is %s', (webSearch) => {
    const patch = buildRelayPatch({
      ...INPUT,
      webSearch,
      existingConfig: {
        config: {
          tools: { web: { search: { enabled: true, provider: 'brave', apiKey: 'user-key' } } },
          plugins: { entries: { brave: { enabled: true } }, allow: ['brave'] },
        },
      },
    });
    expect(patch).not.toHaveProperty('tools');
    expect(patch).not.toHaveProperty('plugins.entries');
    expect(patch).toHaveProperty('plugins.allow', ['brave', 'clawrouter']);
  });

  it.each([
    { tools: { web: { search: { enabled: false } } } },
    { tools: { web: { search: { apiKey: 'user-key' } } } },
    { plugins: { enabled: false } },
    { plugins: { deny: [RELAY_SEARCH_PLUGIN_ID] } },
    { plugins: { entries: { [RELAY_SEARCH_PLUGIN_ID]: { enabled: false } } } },
  ])('respects explicit user search and plugin policy %j', (config) => {
    const patch = buildRelayPatch({ ...INPUT, existingConfig: { config } });
    expect(patch).not.toHaveProperty('tools');
    expect(patch).not.toHaveProperty(`plugins.entries.${RELAY_SEARCH_PLUGIN_ID}`);
  });

  it('extends an existing allowlist with only the relay search plugin', () => {
    const patch = buildRelayPatch({
      ...INPUT,
      existingConfig: {
        config: {
          plugins: {
            allow: ['memory-core', 'clawrouter'],
            entries: { 'memory-core': { enabled: true } },
          },
        },
      },
    });
    expect(patch).toHaveProperty('plugins.allow', ['memory-core', 'clawrouter', RELAY_SEARCH_PLUGIN_ID]);
    expect(patch).not.toHaveProperty(['plugins', 'entries', 'memory-core']);
  });

  it('does not report applied search when the gateway ignores the search patch', async () => {
    let config: Record<string, unknown> = {};
    const result = await applyRelayConfig(
      {
        getConfig: async () => ({ hash: 'fixture-hash', config }),
        patchConfig: async ({ raw }) => {
          const patch = JSON.parse(raw) as Record<string, unknown>;
          config = { models: patch.models };
        },
      },
      INPUT,
    );
    expect(result.configured).toBe(false);
    expect(result.errorCode).toBe('verify-failed');
  });
});
