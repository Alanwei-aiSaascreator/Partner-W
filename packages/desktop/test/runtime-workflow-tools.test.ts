import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ensureBundledWorkflowTools } from '../src/main/runtime/workflow-tools';
import { buildGatewayEnvironment, ensureGatewayRunning } from '../src/main/runtime/gateway-process';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(config: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-tools-'));
  roots.push(root);
  const stateDir = path.join(root, 'state');
  const plugin = path.join(root, 'node_modules/openclaw/dist/extensions/lobster');
  fs.mkdirSync(stateDir);
  fs.mkdirSync(path.join(plugin, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'manifest.json'),
    JSON.stringify({ runtimes: [{ patches: ['official-lobster-2026.9.3', 'rongying-lobster-windows-state-v1'] }] }),
  );
  fs.writeFileSync(
    path.join(plugin, 'package.json'),
    JSON.stringify({ name: '@openclaw/lobster', version: '2026.9.3' }),
  );
  fs.writeFileSync(
    path.join(plugin, 'openclaw.plugin.json'),
    JSON.stringify({ id: 'lobster', contracts: { tools: ['lobster'] } }),
  );
  fs.writeFileSync(path.join(plugin, 'dist/index.js'), 'compiled plugin');
  const configPath = path.join(stateDir, 'openclaw.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  return { root, stateDir, plugin, configPath, read: () => JSON.parse(fs.readFileSync(configPath, 'utf8')) };
}
it('enables a supplied default plugin without expanding any tool or agent policy and is idempotent', () => {
  const config = {
    tools: { profile: 'minimal', deny: ['lobster'] },
    agents: { list: [{ id: 'custom', tools: { allow: ['read'] } }] },
    plugins: { entries: { other: { enabled: false }, lobster: { config: {} } } },
  };
  const f = fixture(config);
  expect(ensureBundledWorkflowTools(f.root, f.stateDir)).toBe(true);
  expect(f.read()).toEqual({
    ...config,
    plugins: { ...config.plugins, entries: { ...config.plugins.entries, lobster: { config: {}, enabled: true } } },
  });
  expect(ensureBundledWorkflowTools(f.root, f.stateDir)).toBe(false);
});
it.each([
  { plugins: { enabled: false } },
  { plugins: { entries: { lobster: { enabled: false } } } },
  { plugins: { allow: ['other'] } },
  { plugins: { allow: [] } },
  { plugins: { deny: ['lobster'] } },
])('preserves explicit plugin restrictions: %j', (config) => {
  const f = fixture(config);
  const before = fs.readFileSync(f.configPath, 'utf8');
  expect(ensureBundledWorkflowTools(f.root, f.stateDir)).toBe(false);
  expect(fs.readFileSync(f.configPath, 'utf8')).toBe(before);
});
it('does not enable legacy bundles and refuses a marked but missing compiled plugin', () => {
  const f = fixture();
  fs.rmSync(path.join(f.root, 'manifest.json'));
  expect(ensureBundledWorkflowTools(f.root, f.stateDir)).toBe(false);
  fs.writeFileSync(
    path.join(f.root, 'manifest.json'),
    JSON.stringify({ runtimes: [{ patches: ['official-lobster-2026.9.3', 'rongying-lobster-windows-state-v1'] }] }),
  );
  fs.rmSync(path.join(f.plugin, 'dist/index.js'));
  expect(() => ensureBundledWorkflowTools(f.root, f.stateDir)).toThrow(/compiled/);
  expect(f.read()).toEqual({});
});
it('binds Lobster storage to the owned state instead of inherited machine state', () => {
  const env = buildGatewayEnvironment(
    { LOBSTER_STATE_DIR: 'external-state', lobster_state_dir: 'external-alias' },
    'owned-state',
  );
  expect(env.LOBSTER_STATE_DIR).toBe(path.join('owned-state', 'lobster'));
  expect(Object.keys(env).filter((key) => key.toUpperCase() === 'LOBSTER_STATE_DIR')).toEqual(['LOBSTER_STATE_DIR']);
});
it('enables the plugin before an owned spawn and leaves reused gateways unchanged', async () => {
  const f = fixture();
  const child = { pid: 42, onExit: vi.fn(), kill: vi.fn() };
  const spawn = vi.fn(() => {
    expect(f.read().plugins.entries.lobster.enabled).toBe(true);
    return child;
  });
  await ensureGatewayRunning({
    port: 18789,
    token: 'owned',
    nodeExe: process.execPath,
    cliPath: 'fixture-cli',
    deployedRoot: f.root,
    stateDir: f.stateDir,
    authenticate: async () => true,
    probe: async () => ({ reachable: false }),
    spawn,
    waitReady: async () => undefined,
  });
  expect(spawn).toHaveBeenCalledOnce();
  fs.writeFileSync(f.configPath, '{}');
  await ensureGatewayRunning({
    port: 18789,
    token: 'owned',
    nodeExe: process.execPath,
    cliPath: 'fixture-cli',
    deployedRoot: f.root,
    stateDir: f.stateDir,
    authenticate: async () => true,
    probe: async () => ({ reachable: true, status: 'started' }),
    spawn,
    waitReady: async () => undefined,
  });
  expect(f.read()).toEqual({});
  expect(spawn).toHaveBeenCalledOnce();
});
