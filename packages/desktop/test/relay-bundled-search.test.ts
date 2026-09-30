import { describe, expect, it } from 'vitest';
import { applyRelayConfig, buildRelayPatch } from '../src/main/commercial/relay-config.js';

const INPUT = { relayKey: 'fixture-relay-key', deviceFingerprint: 'fixture-device', bundledWebSearchAvailable: true };

describe('bundled key-free web search configuration', () => {
  it('selects the installed official provider explicitly for models without native search', () => {
    const patch = buildRelayPatch(INPUT);
    expect(patch).toHaveProperty('tools.web.search', { enabled: true, provider: 'duckduckgo' });
    expect(patch).toHaveProperty('plugins.entries.duckduckgo.enabled', true);
    expect(patch).not.toHaveProperty('plugins.allow');
  });

  it.each([undefined, false])('does not invent provider availability when the runtime reports %s', (available) => {
    const patch = buildRelayPatch({ ...INPUT, bundledWebSearchAvailable: available });
    expect(patch).not.toHaveProperty('tools');
    expect(patch).not.toHaveProperty('plugins.entries.duckduckgo');
  });

  it('does not select a provider when the saved preference is off', () => {
    const patch = buildRelayPatch({ ...INPUT, webSearch: false });
    expect(patch).not.toHaveProperty('tools');
    expect(patch).not.toHaveProperty('plugins.entries.duckduckgo');
  });

  it('disables and re-enables the installed provider without clearing its settings', () => {
    const existingConfig = {
      config: {
        tools: { web: { search: { enabled: true, provider: 'duckduckgo', cacheTtlMinutes: 7 } } },
        plugins: { entries: { duckduckgo: { enabled: true, config: { webSearch: { region: 'uk-en' } } } } },
      },
    };
    const disabled = buildRelayPatch({ ...INPUT, existingConfig, webSearch: false });
    expect(disabled).toHaveProperty('tools.web.search', { enabled: false });
    expect(disabled).not.toHaveProperty('plugins.entries');
    expect(disabled).not.toHaveProperty('tools.web.search.cacheTtlMinutes');
    existingConfig.config.tools.web.search.enabled = false;
    const enabled = buildRelayPatch({ ...INPUT, existingConfig, webSearch: true });
    expect(enabled).toHaveProperty('tools.web.search', { enabled: true, provider: 'duckduckgo' });
    expect(enabled).not.toHaveProperty('plugins.entries.duckduckgo.config');
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
    { plugins: { deny: ['duckduckgo'] } },
    { plugins: { entries: { duckduckgo: { enabled: false } } } },
  ])('respects explicit user search and plugin policy %j', (config) => {
    const patch = buildRelayPatch({ ...INPUT, existingConfig: { config } });
    expect(patch).not.toHaveProperty('tools');
    expect(patch).not.toHaveProperty('plugins.entries.duckduckgo');
  });

  it('extends an existing allowlist with only the installed official plugin', () => {
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
    expect(patch).toHaveProperty('plugins.allow', ['memory-core', 'clawrouter', 'duckduckgo']);
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
