import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { buildGatewayEnvironment } from '../src/main/runtime/gateway-process.js';
import { hasBundledSearchProvider } from '../src/main/runtime/bundled-search.js';

const fixtureRoot = process.env.OPENCLAW_FREE_SEARCH_FIXTURE;

it.runIf(Boolean(fixtureRoot))(
  'executes the actual bundled provider with the production Gateway child environment',
  () => {
    const root = path.resolve(fixtureRoot!);
    expect(hasBundledSearchProvider(root)).toBe(true);
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'official-search-integration-'));
    const configuration = {
      tools: { web: { search: { enabled: true, provider: 'duckduckgo' } } },
      plugins: { allow: ['duckduckgo'], entries: { duckduckgo: { enabled: true } } },
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
        const result = await search({ config, preferInputConfig: true, args: { query: 'OpenClaw official documentation', count: 2 }, signal: AbortSignal.timeout(30000) });
        console.log(JSON.stringify({ registered, provider: result.provider, count: result.result.count }));
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        env,
        encoding: 'utf8',
        timeout: 45000,
        windowsHide: true,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.registered).toEqual([{ id: 'duckduckgo', pluginId: 'duckduckgo' }]);
      expect(report.provider).toBe('duckduckgo');
      expect(report.count).toBeGreaterThan(0);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  },
  65000,
);
