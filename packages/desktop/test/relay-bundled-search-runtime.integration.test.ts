import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { buildGatewayEnvironment } from '../src/main/runtime/gateway-process.js';
import { ensureRelaySearchPlugin, RELAY_SEARCH_PLUGIN_ID } from '../src/main/runtime/relay-search-plugin.js';

/**
 * 联网搜索 provider 插件的**真实运行时集成**（2026-10-12 联网搜索接入）。
 *
 * 不复刻内核行为：直接拿**真实部署态运行时**（`node_modules/openclaw` 实体）：
 *   ① `openclaw config validate` 验证含我们插件配置的 openclaw.json；
 *   ② 用运行时的 `web-search-providers.runtime` 解析 provider 注册表 —— 验证
 *      load.paths 插件真的被装载、`partner-w-search` 注册且归到本插件名下；
 *   ③ `runWebSearch` **真发一次搜索**（provider execute → POST relay /v1/search）。
 *
 * 两个可选输入，缺一即跳过（平时的全量 vitest 里不跑；与 template-deck 集成测试同惯例）：
 *   · `OPENCLAW_FREE_SEARCH_FIXTURE` —— 已解压的运行时根（含 node_modules/openclaw）；
 *   · `ROYIN_SEARCH_RELAY_BASE` / `ROYIN_SEARCH_RELAY_KEY` —— 活体 relay（**真实花费**：
 *     一次搜索 = 一次博查调用，本地账本按 5,760,000 微积分/次落账）。
 */

const fixtureRoot = process.env.OPENCLAW_FREE_SEARCH_FIXTURE;
const relayBase = process.env.ROYIN_SEARCH_RELAY_BASE;
const relayKey = process.env.ROYIN_SEARCH_RELAY_KEY;

it.runIf(Boolean(fixtureRoot && relayBase && relayKey))(
  'loads the app-written provider plugin through the real runtime and reaches the relay',
  () => {
    const root = path.resolve(fixtureRoot!);
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-search-integration-'));
    const pluginDir = ensureRelaySearchPlugin(stateDir);
    const configuration = {
      tools: { web: { search: { enabled: true, provider: RELAY_SEARCH_PLUGIN_ID } } },
      plugins: {
        load: { paths: [pluginDir] },
        allow: [RELAY_SEARCH_PLUGIN_ID],
        entries: {
          [RELAY_SEARCH_PLUGIN_ID]: {
            enabled: true,
            config: { webSearch: { baseUrl: relayBase, apiKey: relayKey } },
          },
        },
      },
    };
    const configPath = path.join(stateDir, 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify(configuration));
    const productionEnv = { ...process.env };
    for (const key of Object.keys(productionEnv)) {
      if (key === 'VITEST' || key.startsWith('VITEST_') || key === 'NODE_ENV') delete productionEnv[key];
    }
    const env = buildGatewayEnvironment(productionEnv, stateDir);
    env.OPENCLAW_CONFIG_PATH = configPath;
    const host = path.join(root, 'node_modules/openclaw');
    try {
      const validation = spawnSync(
        process.execPath,
        [path.join(host, 'openclaw.mjs'), 'config', 'validate', '--json'],
        { env, encoding: 'utf8', timeout: 45000, windowsHide: true },
      );
      expect(validation.error).toBeUndefined();
      expect(validation.status, validation.stderr).toBe(0);
      expect(JSON.parse(validation.stdout).valid).toBe(true);

      const script = `
        import { pathToFileURL } from 'node:url';
        const host = ${JSON.stringify(host)};
        const config = ${JSON.stringify(configuration)};
        process.argv[1] = host + '/openclaw.mjs';
        const { n: providers } = await import(pathToFileURL(host + '/dist/web-search-providers.runtime.js'));
        const registered = providers({ config }).map(({ id, pluginId }) => ({ id, pluginId }));
        const { o: search } = await import(pathToFileURL(host + '/dist/runtime-BOsnJ2Zn.mjs'));
        const result = await search({ config, preferInputConfig: true, args: { query: 'Partner-W', count: 3 }, signal: AbortSignal.timeout(30000) });
        console.log(JSON.stringify({ registered, provider: result.provider, count: result.result.count, firstTitle: (result.result.results && result.result.results[0] && result.result.results[0].title) || null }));
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        env,
        encoding: 'utf8',
        timeout: 45000,
        windowsHide: true,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout) as {
        registered: Array<{ id: string; pluginId: string }>;
        provider: string;
        count: number;
        firstTitle: string | null;
      };
      expect(report.registered).toEqual([{ id: RELAY_SEARCH_PLUGIN_ID, pluginId: RELAY_SEARCH_PLUGIN_ID }]);
      expect(report.provider).toBe(RELAY_SEARCH_PLUGIN_ID);
      expect(report.count).toBeGreaterThan(0);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  },
  65000,
);
