import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>(),
  appPath: '',
  bundledRoot: '',
  managedDir: '',
  config: {} as Record<string, unknown>,
  notify: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => mocks.appPath },
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) =>
      mocks.handlers.set(name, handler),
  },
}));
vi.mock('@clawwork/core', () => ({ resolveCatalogAgentId: () => 'main' }));
vi.mock('../src/main/ws/index.js', () => ({ getGatewayClient: () => gateway }));
const gateway = {
  isConnected: true,
  listAgents: async () => ({ agents: [{ id: 'main' }] }),
  getSkillsStatus: async () => ({ agentId: 'main', managedSkillsDir: mocks.managedDir }),
};
vi.mock('../src/main/workspace/config.js', () => ({
  readConfig: () => mocks.config,
  updateConfig: (value: Record<string, unknown>) => Object.assign(mocks.config, value),
}));
vi.mock('../src/main/skills/locate.js', () => ({ resolveOurSkillsRoot: () => mocks.bundledRoot }));
vi.mock('../src/main/skills/cache-refresh.js', () => ({ notifySkillCacheChange: mocks.notify }));
vi.mock('../src/main/debug/index.js', () => ({ getDebugLogger: () => ({ warn: mocks.warn }) }));
import { registerSkillsHandlers } from '../src/main/skills/handlers.js';

let root = '';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.config = {};
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'slidegen-runtime-handlers-'));
  mocks.bundledRoot = path.join(root, 'bundle');
  mocks.managedDir = path.join(root, 'managed');
  mocks.appPath = path.join(root, 'application');
  fs.mkdirSync(mocks.appPath);
  fs.cpSync(path.join(import.meta.dirname, '../our-skills/deck-layout'), path.join(mocks.bundledRoot, 'deck-layout'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(mocks.bundledRoot, 'other-skill'));
  fs.writeFileSync(
    path.join(mocks.bundledRoot, 'other-skill/SKILL.md'),
    '---\nname: Other\ndescription: Other\n---\nOther',
  );
  mocks.notify.mockResolvedValue(undefined);
  registerSkillsHandlers();
});
afterEach(() => {
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('test path escaped');
  fs.rmSync(root, { recursive: true, force: true });
});
function invoke(name: string, slug?: string) {
  return mocks.handlers.get(name)!(null, { gatewayId: 'local', agentId: 'main', slug });
}
function config() {
  const file = path.join(mocks.managedDir, 'deck-layout/scripts/generate-runtime.json');
  expect(fs.existsSync(file)).toBe(true);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

it('configures the current app through the existing explicit installation IPC', async () => {
  expect(await invoke('skills:our-install', 'deck-layout')).toEqual({ ok: true });
  expect(config()).toMatchObject({
    schemaVersion: 1,
    executable: process.execPath,
    args: [mocks.appPath],
    launcherSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(mocks.notify).toHaveBeenCalledOnce();
});

it('refreshes program paths on every ensure without reinstalling unchanged skills', async () => {
  expect(await invoke('skills:our-ensure')).toMatchObject({
    ok: true,
    result: { installed: ['deck-layout', 'other-skill'], failed: [] },
  });
  const script = fs.readFileSync(path.join(mocks.managedDir, 'deck-layout/scripts/generate.cjs'));
  mocks.appPath = path.join(root, 'moved application');
  fs.mkdirSync(mocks.appPath);
  expect(await invoke('skills:our-ensure')).toMatchObject({
    ok: true,
    result: { installed: [], upgraded: [], failed: [] },
  });
  expect(config().args).toEqual([mocks.appPath]);
  expect(fs.readFileSync(path.join(mocks.managedDir, 'deck-layout/scripts/generate.cjs'))).toEqual(script);
});

it('reports runtime configuration failure without enabling an unusable manual install', async () => {
  fs.rmdirSync(mocks.appPath);
  expect(await invoke('skills:our-install', 'deck-layout')).toMatchObject({
    ok: false,
    error: 'slidegen-runtime-unavailable',
  });
  expect(mocks.notify).not.toHaveBeenCalled();
});

it('preserves customized launchers and reports their configuration boundary during ensure', async () => {
  await invoke('skills:our-ensure');
  const scripts = path.join(mocks.managedDir, 'deck-layout/scripts');
  config();
  const before = fs.readFileSync(path.join(scripts, 'generate-runtime.json'));
  fs.appendFileSync(path.join(scripts, 'generate.cjs'), '\ncustomization');
  expect(await invoke('skills:our-ensure')).toMatchObject({
    ok: true,
    result: { failed: [{ slug: 'deck-layout', error: 'slidegen-runtime-script-modified' }] },
  });
  expect(fs.readFileSync(path.join(scripts, 'generate-runtime.json'))).toEqual(before);
});

it('keeps unrelated skill installation independent from the PPT runtime', async () => {
  expect(await invoke('skills:our-install', 'other-skill')).toEqual({ ok: true });
  expect(fs.existsSync(path.join(mocks.managedDir, 'other-skill/scripts/generate-runtime.json'))).toBe(false);
});

it('preserves customized launchers before an automatic guide upgrade copies files', async () => {
  await invoke('skills:our-ensure');
  const scripts = path.join(mocks.managedDir, 'deck-layout/scripts');
  fs.appendFileSync(path.join(scripts, 'generate.cjs'), '\ncustomization');
  const script = fs.readFileSync(path.join(scripts, 'generate.cjs'));
  const runtime = fs.readFileSync(path.join(scripts, 'generate-runtime.json'));
  const records = JSON.stringify(mocks.config);
  fs.appendFileSync(path.join(mocks.bundledRoot, 'deck-layout/SKILL.md'), '\nUpdated guide');
  expect(await invoke('skills:our-ensure')).toMatchObject({
    ok: true,
    result: { upgraded: [], failed: [{ slug: 'deck-layout', error: 'slidegen-runtime-script-modified' }] },
  });
  expect(fs.readFileSync(path.join(scripts, 'generate.cjs'))).toEqual(script);
  expect(fs.readFileSync(path.join(scripts, 'generate-runtime.json'))).toEqual(runtime);
  expect(JSON.stringify(mocks.config)).toBe(records);
});

it('allows a recorded owned launcher version to upgrade with its guide', async () => {
  await invoke('skills:our-ensure');
  const oldRuntime = config();
  expect(oldRuntime.launcherSha256).toMatch(/^[a-f0-9]{64}$/);
  fs.appendFileSync(path.join(mocks.bundledRoot, 'deck-layout/scripts/generate.cjs'), '\nvoid 0;');
  fs.appendFileSync(path.join(mocks.bundledRoot, 'deck-layout/SKILL.md'), '\nUpdated guide');
  expect(await invoke('skills:our-ensure')).toMatchObject({
    ok: true,
    result: { upgraded: ['deck-layout'], failed: [] },
  });
  expect(config().launcherSha256).not.toBe(oldRuntime.launcherSha256);
  expect(fs.readFileSync(path.join(mocks.managedDir, 'deck-layout/scripts/generate.cjs'))).toEqual(
    fs.readFileSync(path.join(mocks.bundledRoot, 'deck-layout/scripts/generate.cjs')),
  );
});

it('upgrades legacy skills that never installed a launcher', async () => {
  await invoke('skills:our-ensure');
  const scripts = path.join(mocks.managedDir, 'deck-layout/scripts');
  fs.unlinkSync(path.join(scripts, 'generate.cjs'));
  fs.unlinkSync(path.join(scripts, 'generate-runtime.json'));
  fs.appendFileSync(path.join(mocks.bundledRoot, 'deck-layout/SKILL.md'), '\nUpdated guide');
  expect(await invoke('skills:our-ensure')).toMatchObject({
    ok: true,
    result: { upgraded: ['deck-layout'], failed: [] },
  });
  expect(config().executable).toBe(process.execPath);
});
