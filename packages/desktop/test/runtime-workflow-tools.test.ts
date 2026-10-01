import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ensureBundledWorkflowTools } from '../src/main/runtime/workflow-tools';
import { buildGatewayEnvironment, ensureGatewayRunning } from '../src/main/runtime/gateway-process';
import { ASSISTANT_ID_BY_WORKSPACE } from '../src/renderer/lib/assistant-task-presets';
import { mergeToolsDefaults } from '../src/main/runtime/state-config';

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
it.each([undefined, true])('authorizes only Lobster under the system default tools policy (enabled=%s)', (enabled) => {
  const tools = mergeToolsDefaults(null);
  const config = { tools, plugins: { entries: { lobster: enabled === undefined ? {} : { enabled } } } };
  const f = fixture(config);
  expect(ensureBundledWorkflowTools(f.root, f.stateDir)).toBe(true);
  expect(f.read().tools).toEqual(tools);
  expect(f.read().agents.entries.main.tools).toEqual({ alsoAllow: ['lobster'] });
  expect(f.read().plugins.entries.lobster.enabled).toBe(true);
  expect(ensureBundledWorkflowTools(f.root, f.stateDir)).toBe(false);
});
it.each([
  { profile: 'minimal' },
  { profile: 'full' },
  { allow: ['read'] },
  { alsoAllow: ['other'] },
  { deny: ['lobster'] },
  { deny: ['*'] },
  { deny: ['group:plugins'] },
  { byProvider: { openai: { allow: ['read'] } } },
])('does not expand an explicit global tool policy: %j', (policy) => {
  const tools = { ...mergeToolsDefaults(null), ...policy };
  const f = fixture({ tools, plugins: { entries: { lobster: { enabled: true } } } });
  expect(ensureBundledWorkflowTools(f.root, f.stateDir)).toBe(false);
  expect(f.read().tools).toEqual(tools);
});
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

it('grants current system roster entries while preserving custom and restricted agents', () => {
  const agents = {
    list: [
      { id: 'main' },
      { id: 'rongying-office' },
      { id: 'custom' },
      { id: 'rongying-video', tools: { profile: 'minimal' } },
      { id: 'rongying-research', tools: { deny: ['lobster'] } },
    ],
  };
  const f = fixture({ tools: mergeToolsDefaults(null), agents });
  expect(ensureBundledWorkflowTools(f.root, f.stateDir)).toBe(true);
  expect(f.read().agents.list).toEqual([
    { id: 'main', tools: { alsoAllow: ['lobster'] } },
    { id: 'rongying-office', tools: { alsoAllow: ['lobster'] } },
    ...agents.list.slice(2),
  ]);
  expect(ensureBundledWorkflowTools(f.root, f.stateDir)).toBe(false);
});
it('supports current entries roster without inventing agents in a custom-only roster', () => {
  const f = fixture({
    agents: { entries: { main: { workspace: 'owned' }, custom: { tools: { profile: 'minimal' } } } },
  });
  expect(ensureBundledWorkflowTools(f.root, f.stateDir)).toBe(true);
  expect(f.read().agents.entries.main).toEqual({ workspace: 'owned', tools: { alsoAllow: ['lobster'] } });
  expect(f.read().agents.entries.custom).toEqual({ tools: { profile: 'minimal' } });
  const custom = fixture({
    agents: { list: [{ id: 'custom' }] },
    plugins: { entries: { lobster: { enabled: true } } },
  });
  expect(ensureBundledWorkflowTools(custom.root, custom.stateDir)).toBe(false);
  expect(custom.read().agents.list).toEqual([{ id: 'custom' }]);
});
it('does not expand restricted inherited agent defaults or explicitly disabled plugin tools', () => {
  for (const config of [
    { agents: { defaults: { tools: { profile: 'minimal' } }, list: [{ id: 'main' }] } },
    { plugins: { entries: { lobster: { enabled: false } } }, tools: mergeToolsDefaults(null) },
  ]) {
    const f = fixture(config);
    ensureBundledWorkflowTools(f.root, f.stateDir);
    expect(f.read().agents).toEqual('agents' in config ? config.agents : undefined);
    expect(f.read().tools).toEqual('tools' in config ? config.tools : undefined);
  }
});

it('covers the actual built-in assistant IDs without authorizing arbitrary custom IDs', () => {
  const ids = Object.values(ASSISTANT_ID_BY_WORKSPACE);
  const f = fixture({ agents: { entries: Object.fromEntries([...ids, 'custom'].map((id) => [id, {}])) } });
  expect(ensureBundledWorkflowTools(f.root, f.stateDir)).toBe(true);
  for (const id of ids) expect(f.read().agents.entries[id].tools).toEqual({ alsoAllow: ['lobster'] });
  expect(f.read().agents.entries.custom).toEqual({});
});
it.each([
  { agents: null },
  { agents: [] },
  { agents: 'invalid' },
  { agents: { list: {} } },
  { agents: { list: null } },
  { agents: { list: [null] } },
  { agents: { entries: [] } },
  { agents: { entries: null } },
  { agents: { entries: { main: null } } },
  { agents: { defaults: [] } },
  { agents: { defaults: null } },
])('rejects malformed agent configuration without rewriting its bytes: %j', (config) => {
  const f = fixture(config);
  const before = fs.readFileSync(f.configPath, 'utf8');
  expect(() => ensureBundledWorkflowTools(f.root, f.stateDir)).toThrow(/agent/i);
  expect(fs.readFileSync(f.configPath, 'utf8')).toBe(before);
});
