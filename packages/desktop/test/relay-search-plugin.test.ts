import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RELAY_SEARCH_PLUGIN_ID,
  ensureRelaySearchPlugin,
  isRelaySearchPluginInstalled,
  relaySearchPluginDir,
  relaySearchPluginFiles,
} from '../src/main/runtime/relay-search-plugin.js';

/**
 * 联网搜索 provider 插件（2026-10-12）—— **测真正会跑的那份代码**。
 *
 * 纪律与收件箱守卫同款：单测把 ensure 写进状态目录的 `index.mjs` **原样 import 回来**，
 * 对着真实 `register(api)` / `createTool` / `execute` 跑（不是复刻一份逻辑来测）。
 * 网络用 stub 的 globalThis.fetch 拦在 fetch 层（插件不看 env、只吃 config）。
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

interface ProviderShape {
  id: string;
  requiresCredential: boolean;
  credentialPath: string;
  getCredentialValue: () => unknown;
  setCredentialValue: () => void;
  createTool: (ctx: { config: Record<string, unknown> }) => {
    description: string;
    parameters: Record<string, unknown>;
    execute: (args: Record<string, unknown>, context?: { signal?: AbortSignal }) => Promise<unknown>;
  };
}

async function loadPlugin(): Promise<{ id: string; register: (api: unknown) => void }> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-search-plugin-'));
  roots.push(stateDir);
  ensureRelaySearchPlugin(stateDir);
  const entry = path.join(relaySearchPluginDir(stateDir), 'index.mjs');
  const mod = (await import(pathToFileURL(entry).href)) as {
    default: { id: string; register: (api: unknown) => void };
  };
  return mod.default;
}

async function loadedProvider(): Promise<ProviderShape> {
  const plugin = await loadPlugin();
  let captured: ProviderShape | null = null;
  plugin.register({ registerWebSearchProvider: (provider: ProviderShape) => (captured = provider) });
  if (!captured) throw new Error('plugin did not register a web search provider');
  return captured;
}

function configWith(webSearch: Record<string, unknown> | null, tools?: Record<string, unknown>) {
  return {
    plugins: {
      entries: {
        [RELAY_SEARCH_PLUGIN_ID]: {
          enabled: true,
          ...(webSearch ? { config: { webSearch } } : {}),
        },
      },
    },
    ...(tools ? { tools } : {}),
  };
}

const CONFIGURED = configWith({ baseUrl: 'http://127.0.0.1:8791/', apiKey: 'relay-fixture' });

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

/**
 * ⚠️ 桩必须打**relay 出口的形状**（`{results, count, tookMs}`），不是博查原始形状
 * （`data.webPages.value`）——博查→relay 的映射在 relay 侧（search.ts 的解析 + 测试）；
 * 插件边界收到的永远是 relay 归一化后的行。
 */
function relayBody(rows: unknown[]) {
  return { results: rows, count: rows.length, tookMs: 3 };
}

describe('relay-search plugin files', () => {
  it('writes the three-file shape and stays import-safe (no bare imports in the entry)', () => {
    const files = relaySearchPluginFiles();
    expect(Object.keys(files).sort()).toEqual(['index.mjs', 'openclaw.plugin.json', 'package.json']);
    // 状态目录插件不在 runtime 的 node_modules 树里：bare specifier 解析不到 ⇒ 入口零 import。
    expect(files['index.mjs']).not.toMatch(/^\s*import\s/m);
    const manifest = JSON.parse(files['openclaw.plugin.json']) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      id: RELAY_SEARCH_PLUGIN_ID,
      activation: { onStartup: true },
      contracts: { webSearchProviders: [RELAY_SEARCH_PLUGIN_ID] },
    });
    const pkg = JSON.parse(files['package.json']) as { openclaw?: { extensions?: string[] } };
    expect(pkg.openclaw?.extensions).toEqual(['./index.mjs']);
  });

  it('ensure is idempotent and the probe accepts the written plugin', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-search-plugin-'));
    roots.push(stateDir);
    ensureRelaySearchPlugin(stateDir);
    const dir = relaySearchPluginDir(stateDir);
    const before = fs.statSync(path.join(dir, 'index.mjs')).mtimeMs;
    ensureRelaySearchPlugin(stateDir);
    expect(fs.statSync(path.join(dir, 'index.mjs')).mtimeMs).toBe(before); // 内容没变不重写
    expect(isRelaySearchPluginInstalled(stateDir)).toBe(true);
  });
});

describe('register: provider contract shape', () => {
  it('registers exactly one provider with the none-credential contract', async () => {
    const plugin = await loadPlugin();
    const registered: ProviderShape[] = [];
    plugin.register({ registerWebSearchProvider: (provider: ProviderShape) => registered.push(provider) });
    expect(registered).toHaveLength(1);
    const provider = registered[0];
    expect(provider.id).toBe(RELAY_SEARCH_PLUGIN_ID);
    expect(provider.requiresCredential).toBe(false);
    expect(provider.credentialPath).toBe('');
    expect(provider.getCredentialValue()).toBeUndefined();
    expect(() => provider.setCredentialValue()).not.toThrow();
  });
});

describe('execute: relay request and payload mapping', () => {
  it('posts to <baseUrl>/v1/search with the relay key and maps relay rows into the payload', async () => {
    const provider = await loadedProvider();
    const fetchMock = vi.fn(async () =>
      okResponse(
        relayBody([
          {
            title: '标题甲',
            url: 'https://a.example/1',
            snippet: '摘要甲',
            siteName: 'a.example',
            published: '2026-09-23T00:00:00+08:00',
          },
          { title: '坏 URL', url: 'javascript:alert(1)', snippet: 'x' }, // 防御性再过滤（relay 已滤，双保险）
          { title: '   ', url: 'https://b.example/2', snippet: 'x' },
          { title: '标题乙', url: 'http://b.example/2', snippet: 's2' },
        ]),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const tool = provider.createTool({ config: CONFIGURED });
    const result = (await tool.execute({ query: '荣盈魔方', count: 3, freshness: 'week' })) as {
      provider: string;
      count: number;
      results: Array<Record<string, unknown>>;
      externalContent: Record<string, unknown>;
    };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('http://127.0.0.1:8791/v1/search'); // 尾斜杠已剥
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer relay-fixture');
    expect(JSON.parse(init.body)).toEqual({ query: '荣盈魔方', count: 3, freshness: 'week' });

    expect(result.provider).toBe(RELAY_SEARCH_PLUGIN_ID);
    expect(result.count).toBe(2);
    expect(result.externalContent).toMatchObject({ untrusted: true, source: 'web_search' });
    expect(result.results[0]).toMatchObject({
      title: '标题甲',
      url: 'https://a.example/1',
      snippet: '摘要甲',
      siteName: 'a.example',
      published: '2026-09-23T00:00:00+08:00',
    });
    expect(result.results[1]).toMatchObject({ title: '标题乙', url: 'http://b.example/2', snippet: 's2' });
  });

  it('caches identical queries in-process (with the cached flag) and does not hit the relay again', async () => {
    const provider = await loadedProvider();
    const fetchMock = vi.fn(async () =>
      okResponse(relayBody([{ title: 't', url: 'https://a.example/1', snippet: 's' }])),
    );
    vi.stubGlobal('fetch', fetchMock);

    const tool = provider.createTool({ config: CONFIGURED });
    const first = (await tool.execute({ query: '同一查询', count: 2 })) as { cached?: boolean };
    const second = (await tool.execute({ query: '同一查询', count: 2 })) as { cached?: boolean };
    expect(first.cached).toBeUndefined();
    expect(second.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [402, /积分不足/],
    [401, /重新登录/],
    [500, /暂时不可用/],
    [503, /暂时不可用/],
  ])('maps relay HTTP %i into a model-actionable message', async (status, pattern) => {
    const provider = await loadedProvider();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status, json: async () => ({}) })),
    );
    const tool = provider.createTool({ config: CONFIGURED });
    await expect(tool.execute({ query: 'x' }, {})).rejects.toThrow(pattern);
  });

  it('fails closed without connection config (and never calls fetch)', async () => {
    const provider = await loadedProvider();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const tool = provider.createTool({ config: configWith(null) });
    await expect(tool.execute({ query: 'x' }, {})).rejects.toThrow(/尚未配置/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns a network failure into a message that points at the browser fallback', async () => {
    const provider = await loadedProvider();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const tool = provider.createTool({ config: CONFIGURED });
    await expect(tool.execute({ query: 'x' }, {})).rejects.toThrow(/browser 工具/);
  });

  it('rejects a malformed relay payload instead of returning a half-empty result', async () => {
    const provider = await loadedProvider();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse({ nothing: true })),
    );
    const tool = provider.createTool({ config: CONFIGURED });
    await expect(tool.execute({ query: 'x' }, {})).rejects.toThrow(/响应异常/);
  });

  it('requires a non-empty query', async () => {
    const provider = await loadedProvider();
    const tool = provider.createTool({ config: CONFIGURED });
    await expect(tool.execute({ query: '   ' }, {})).rejects.toThrow(/query is required/);
  });
});
