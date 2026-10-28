/**
 * 联网搜索 provider 插件 —— web_search 工具接 relay 的**代码级**落实（2026-10-12 联网搜索接入）。
 *
 * ## 为什么是"随盘写一份插件"而不是改运行时分发
 *
 * 内核 `web_search` 的 provider 是插件制：官方 duckduckgo 插件在运行时 dist 里
 * （`dist/extensions/duckduckgo`，入口 `api.registerWebSearchProvider(…)` +
 * `openclaw.plugin.json` 的 `contracts.webSearchProviders`）。内置 provider 的
 * endpoint 全部写死（DDG=html.duckduckgo.com，minimax 两域名二选一），没有
 * "把内置 provider 指到我们服务器"的配置键 —— 唯一的扩展点就是**注册自己的
 * provider 插件**（不需要改内核二进制，也不需要重打 runtime 包）。
 *
 * 于是沿用收件箱只读守卫同款机制（`guard/inbox-readonly.ts`，2026-10-07 真机
 * 实验验证过的装载三条件）：应用把插件写进状态目录，`state-config.ts` 每次启动
 * 对齐 `plugins.load.paths` + `plugins.entries.<id>.enabled`；relay 激活时由
 * `relay-config.ts` 写入 `plugins.entries.<id>.config.webSearch.{baseUrl,apiKey}`
 * —— 插件把查询 POST 到 `<baseUrl>/v1/search`，上游搜索的真凭据只留在 relay
 * 环境变量里（与模型/视频通道同款纪律：真 key 不进 U 盘）。
 *
 * ## 工具存活闸（与 kernel 补丁的配合）
 *
 * 随包补丁 `partner-w-web-search-availability-v1` 让 `createWebSearchTool` 在
 * `hasUsableWebSearchProvider` 为假时直接返回 null。它的判据：显式选择了
 * `tools.web.search.provider` 且该 provider 已在插件注册表里 ⇒ 可用。
 * 所以：**未激活/未接 relay 的机器 = provider 没被选中 = 工具不出现**
 * （fail-closed，不会让用户看到注定失败的搜索），激活后自动出现。
 *
 * ## 判定逻辑的唯一真源
 *
 * 下面是 `index.mjs` 的插件源码，随文件写进状态目录；单测直接从状态目录把那份
 * 文件 import 回来钉（测的就是真正会跑的那份代码）。
 * ⚠️ 插件是**运行在网关进程里**的普通 ESM：不 import 本仓任何东西，也**不 import
 *    `openclaw/plugin-sdk/*`**（状态目录插件不在 runtime 的 node_modules 树里，
 *    bare specifier 解析不到——收件箱守卫注释同款理由）。provider 契约字段按官方
 *    duckduckgo 插件形状手写（`searchCredential: {type:'none'}` 的等价 noop，
 *    2026-10-12 实读 `provider-web-search-contract-fields-*.mjs` 的 'none' 分支）。
 *
 * ⚠️ **结果字段不做包裹**（原始 title/snippet 直接返回）：内核宿主
 *    `normalizeWebSearchOutput` 对 kind=results 的**每一行字段**都会走
 *    `wrapProse`（`unwrapEnvelopes` → 截断 → `wrapWebContent` 重新打
 *    EXTERNAL_UNTRUSTED_CONTENT 边界标记）—— 2026-10-12 实读
 *    `openclaw-tools-INLTkEBK.mjs:17071-17080` 定案。这里再包一层会被 unwrap
 *    拆掉再重包（纯浪费），且官方 DDG 插件的预包裹在宿主路径上同样被 unwrap。
 *    本插件只需保证结构：每行 title 非空字符串 + url 是 http(s)
 *    （任一行不合，宿主把整组降级成 raw 文本路径 = 丢结构化信息）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 插件 id == provider id == `tools.web.search.provider` 的选择值（三处同一字符串）。 */
export const RELAY_SEARCH_PLUGIN_ID = 'partner-w-search';
/** 插件目录族（相对状态目录）：`<stateDir>/providers/partner-w-search/`。 */
export const RELAY_SEARCH_PROVIDERS_DIR_NAME = 'providers';

/** 插件目录的绝对路径。 */
export function relaySearchPluginDir(stateDir: string): string {
  return path.join(stateDir, RELAY_SEARCH_PROVIDERS_DIR_NAME, RELAY_SEARCH_PLUGIN_ID);
}

/**
 * 插件源码（`index.mjs`）。零 import（除 node 内建外什么都不 import）；
 * provider 契约字段手写（同官方 duckduckgo 形状，见文件头注释）。
 *
 * ⚠️ 模板字符串纪律：这份 JS 里**不用** backtick 模板字面量（外层就是模板字符串，
 *    嵌 `${` 会被当成插值）。字符串拼接一律 `+`。
 */
export const RELAY_SEARCH_PLUGIN_ENTRY = `// Partner-W · 联网搜索 provider（由应用生成，请勿手改）
//
// 内核 web_search 工具的 provider 插件：把查询 POST 到Partner-W relay 的 /v1/search
// （上游搜索真凭据只在服务器）。装载三条件与配置写入见应用侧
// runtime/relay-search-plugin.ts 的文件头注释。
//
// 结果字段**不做包裹**：内核宿主 normalizeWebSearchOutput 对每一行字段统一走
// wrapProse（unwrap → 截断 → 重新打不可信边界标记）——这里只需保证结构合法：
// 每行 title 非空字符串 + url 是 http(s)（任一行不合，宿主整组降级成 raw 路径）。

const PROVIDER_ID = '${RELAY_SEARCH_PLUGIN_ID}';
const DEFAULT_TIMEOUT_SECONDS = 20;
const DEFAULT_CACHE_TTL_MINUTES = 15;
const MAX_COUNT = 10;
const UNAVAILABLE_SUFFIX = '你可以改用 browser 工具直接打开网页获取信息。';

// 进程内短缓存：同一查询在 TTL 内不重复打 relay（每次搜索都真实计费）。
// 有界：最多 100 条，满了删最旧一条。
const CACHE = new Map();

function readWebSearchConfig(config) {
  const entry = config && config.plugins && config.plugins.entries && config.plugins.entries[PROVIDER_ID];
  const webSearch = entry && entry.config && entry.config.webSearch;
  return webSearch && typeof webSearch === 'object' && !Array.isArray(webSearch) ? webSearch : {};
}

function readPositiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function cacheKeyOf(query, count, freshness) {
  return JSON.stringify({ provider: PROVIDER_ID, query: query, count: count, freshness: freshness || '' });
}

function readCache(key, ttlMs) {
  const hit = CACHE.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > ttlMs) {
    CACHE.delete(key);
    return undefined;
  }
  return hit.value;
}

function writeCache(key, value) {
  CACHE.set(key, { at: Date.now(), value: value });
  if (CACHE.size > 100) {
    let oldestKey;
    let oldestAt = Infinity;
    for (const entry of CACHE.entries()) {
      if (entry[1].at < oldestAt) {
        oldestAt = entry[1].at;
        oldestKey = entry[0];
      }
    }
    if (oldestKey !== undefined) CACHE.delete(oldestKey);
  }
}

async function runRelaySearch(params) {
  const searchConfig = readWebSearchConfig(params.config);
  const baseUrl = typeof searchConfig.baseUrl === 'string' ? searchConfig.baseUrl.replace(/\\/+$/, '') : '';
  const apiKey = typeof searchConfig.apiKey === 'string' ? searchConfig.apiKey : '';
  if (!baseUrl || !apiKey) {
    throw new Error('联网搜索尚未配置（应用未完成激活或本设备未授权）。' + UNAVAILABLE_SUFFIX);
  }

  const toolConfig = params.config && params.config.tools && params.config.tools.web && params.config.tools.web.search;
  const timeoutSeconds = Math.min(readPositiveInt(toolConfig && toolConfig.timeoutSeconds) || DEFAULT_TIMEOUT_SECONDS, 60);
  const cacheTtlMs = (readPositiveInt(toolConfig && toolConfig.cacheTtlMinutes) || DEFAULT_CACHE_TTL_MINUTES) * 60000;

  const key = cacheKeyOf(params.query, params.count, params.freshness);
  const cached = readCache(key, cacheTtlMs);
  if (cached) return Object.assign({}, cached, { cached: true });

  const timeoutSignal = AbortSignal.timeout(timeoutSeconds * 1000);
  const combined =
    params.signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([params.signal, timeoutSignal])
      : timeoutSignal;

  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(baseUrl + '/v1/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({
        query: params.query,
        count: params.count,
        ...(params.freshness ? { freshness: params.freshness } : {}),
      }),
      signal: combined,
    });
  } catch (error) {
    if (params.signal && params.signal.aborted) throw error; // 调用方取消：原样上抛，不当服务故障
    throw new Error('联网搜索请求失败（网络超时或不可达）。' + UNAVAILABLE_SUFFIX);
  }

  if (!response.ok) {
    if (response.status === 402) throw new Error('联网搜索已暂停：账户积分不足，请充值后重试。');
    if (response.status === 401) throw new Error('联网搜索凭据失效，请退出应用重新登录。');
    if (response.status === 400) throw new Error('联网搜索请求被拒绝（参数不合法）。');
    throw new Error('联网搜索服务暂时不可用（错误 ' + response.status + '）。' + UNAVAILABLE_SUFFIX);
  }

  const payload = await response.json().catch(() => null);
  const rows = payload && Array.isArray(payload.results) ? payload.results : null;
  if (!rows) throw new Error('联网搜索响应异常。' + UNAVAILABLE_SUFFIX);

  const results = rows
    .filter(function (row) {
      return (
        row &&
        typeof row.title === 'string' &&
        row.title.trim().length > 0 &&
        typeof row.url === 'string' &&
        /^https?:\\/\\//i.test(row.url)
      );
    })
    .slice(0, MAX_COUNT)
    .map(function (row) {
      return Object.assign(
        { title: row.title, url: row.url, snippet: typeof row.snippet === 'string' ? row.snippet : '' },
        typeof row.siteName === 'string' && row.siteName ? { siteName: row.siteName } : {},
        typeof row.published === 'string' && row.published ? { published: row.published } : {},
      );
    });

  const value = {
    query: params.query,
    provider: PROVIDER_ID,
    count: results.length,
    tookMs: Date.now() - startedAt,
    externalContent: { untrusted: true, source: 'web_search', provider: PROVIDER_ID, wrapped: true },
    results: results,
  };
  writeCache(key, value);
  return value;
}

const SEARCH_PARAMETERS = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Search query string.' },
    count: { type: 'integer', description: 'Number of results to return (1-10).', minimum: 1, maximum: 10 },
    freshness: { type: 'string', description: 'Time filter for results: day, week, month, or year.' },
  },
  additionalProperties: false,
};

export default {
  id: PROVIDER_ID,
  name: 'Partner-W·联网搜索',
  description: '把 web_search 接到Partner-W互联网关（relay）—— 上游真凭据只留在服务器。',
  register(api) {
    api.registerWebSearchProvider({
      id: PROVIDER_ID,
      label: 'Partner-W联网搜索',
      hint: '随设备授权提供的联网搜索（无需单独配置密钥）',
      onboardingScopes: ['text-inference'],
      requiresCredential: false,
      envVars: [],
      placeholder: '(no key needed)',
      signupUrl: '',
      docsUrl: 'https://docs.openclaw.ai/tools/web',
      // 自动探测只认"有凭据的 provider"；本 provider 必须显式选中
      // （tools.web.search.provider）——这正是应用接线做的事。
      autoDetectOrder: 500,
      credentialPath: '',
      // searchCredential: {type:'none'} 的等价 noop（实读内核 contract-fields 的 'none' 分支）。
      inactiveSecretPaths: [],
      getCredentialValue: function () {
        return undefined;
      },
      setCredentialValue: function () {},
      createTool: function (ctx) {
        return {
          description: 'Search the web for current information. Returns titles, URLs and snippets.',
          parameters: SEARCH_PARAMETERS,
          execute: async function (args, context) {
            if (context && context.signal) context.signal.throwIfAborted();
            const query = args && typeof args.query === 'string' ? args.query.trim() : '';
            if (!query) throw new Error('query is required.');
            let count = Number(args.count);
            if (!Number.isInteger(count) || count < 1) count = 5;
            if (count > MAX_COUNT) count = MAX_COUNT;
            const freshness =
              args.freshness === 'day' || args.freshness === 'week' || args.freshness === 'month' || args.freshness === 'year'
                ? args.freshness
                : undefined;
            const result = await runRelaySearch({
              config: ctx.config,
              query: query,
              count: count,
              freshness: freshness,
              signal: context ? context.signal : undefined,
            });
            if (context && context.signal) context.signal.throwIfAborted();
            return result;
          },
        };
      },
    });
  },
};
`;

/**
 * 插件清单。`activation.onStartup: true` 是"网关启动时加载"的开关（缺了就不加载，实测）；
 * `contracts.webSearchProviders` 让内核把本插件注册的 provider 登记进 provider 注册表
 * （`resolveManifestContractOwnerPluginId` 靠它把 provider id 认到插件名下）；
 * `configSchema` 声明 relay-config 会写入的 `webSearch.{baseUrl,apiKey}`（网关配置校验会照它放行）。
 */
export const RELAY_SEARCH_PLUGIN_MANIFEST = `${JSON.stringify(
  {
    id: RELAY_SEARCH_PLUGIN_ID,
    name: 'Partner-W·联网搜索',
    description: '把 web_search 接到Partner-W互联网关（relay）—— 上游真凭据只留在服务器。',
    activation: { onStartup: true },
    contracts: { webSearchProviders: [RELAY_SEARCH_PLUGIN_ID] },
    configSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        webSearch: {
          type: 'object',
          additionalProperties: false,
          properties: {
            baseUrl: { type: 'string' },
            apiKey: { type: 'string' },
          },
        },
      },
    },
  },
  null,
  2,
)}\n`;

/** 包元数据：`openclaw.extensions` 指入口（缺了同样不加载，实测）。 */
export const RELAY_SEARCH_PLUGIN_PACKAGE_JSON = `${JSON.stringify(
  {
    name: RELAY_SEARCH_PLUGIN_ID,
    version: '1.0.0',
    private: true,
    type: 'module',
    openclaw: { extensions: ['./index.mjs'] },
  },
  null,
  2,
)}\n`;

/** 插件目录里的三个文件（文件名 → 内容）。 */
export function relaySearchPluginFiles(): Record<string, string> {
  return {
    'openclaw.plugin.json': RELAY_SEARCH_PLUGIN_MANIFEST,
    'package.json': RELAY_SEARCH_PLUGIN_PACKAGE_JSON,
    'index.mjs': RELAY_SEARCH_PLUGIN_ENTRY,
  };
}

/** 内容变了才写（同 inbox-readonly 的写盘纪律：每次启动重写会改 mtime）。 */
function writeFileIfChanged(filePath: string, contents: string): void {
  try {
    if (readFileSync(filePath, 'utf-8') === contents) return;
  } catch {
    // 读不到（不存在/不可读）⇒ 照写。
  }
  const tmpPath = `${filePath}.tmp`;
  let written = false;
  try {
    writeFileSync(tmpPath, contents, 'utf-8');
    written = true;
    renameSync(tmpPath, filePath);
    written = false;
  } finally {
    if (written) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // 尽力清理；真正的错误由上面抛出去。
      }
    }
  }
}

/**
 * 确保状态目录里有搜索 provider 插件，返回**插件目录**路径（写进 `plugins.load.paths` 的就是它）。
 * 写失败**向上抛** —— 调用方据此决定"这次别把配置指过去"（宁可不装，也不要指向不存在的目录）。
 */
export function ensureRelaySearchPlugin(stateDir: string): string {
  const dir = relaySearchPluginDir(stateDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  for (const [name, contents] of Object.entries(relaySearchPluginFiles())) {
    writeFileIfChanged(path.join(dir, name), contents);
  }
  return dir;
}

/**
 * 可用性探针：状态目录里的搜索插件**就绪且外形正确**（三件文件在位 + 清单自称
 * 我们的 id/契约/onStartup）。供 relay 接线（`hasInstalledSearchProvider`）判断
 * "这台机器能不能把 web_search 接出来"。
 *
 * 为什么校验清单内容而不是只看文件在不在：与旧版 duckduckgo 探针同款纪律——
 * 半截写入 / 被别的程序放了一份同名异物 / 手改坏了，都必须在**接线前**判否
 * （fail-closed：宁可不接线，也不把工具接向一个装不上的 provider）。
 * 任何 IO 异常 ⇒ false（探针永不抛）。
 */
export function isRelaySearchPluginInstalled(stateDir: string | null | undefined): boolean {
  if (!stateDir) return false;
  try {
    const dir = relaySearchPluginDir(stateDir);
    const manifest = JSON.parse(readFileSync(path.join(dir, 'openclaw.plugin.json'), 'utf8')) as {
      id?: unknown;
      activation?: { onStartup?: unknown };
      contracts?: { webSearchProviders?: unknown };
    };
    return (
      manifest.id === RELAY_SEARCH_PLUGIN_ID &&
      manifest.activation?.onStartup === true &&
      Array.isArray(manifest.contracts?.webSearchProviders) &&
      (manifest.contracts.webSearchProviders as unknown[]).includes(RELAY_SEARCH_PLUGIN_ID) &&
      existsSync(path.join(dir, 'index.mjs')) &&
      existsSync(path.join(dir, 'package.json'))
    );
  } catch {
    return false;
  }
}
