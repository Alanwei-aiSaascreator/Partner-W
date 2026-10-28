import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { installBundledSkill } from '../src/main/skills/bundled.js';

const bundledRoot = path.join(import.meta.dirname, '../our-skills');
let root = '',
  managedDir = '',
  scripts = '',
  appPath = '';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'slidegen-runtime-config-'));
  managedDir = path.join(root, 'managed');
  appPath = path.join(root, 'application');
  fs.mkdirSync(appPath);
  expect(installBundledSkill({ root: bundledRoot, managedDir, slug: 'deck-layout' }).ok).toBe(true);
  scripts = path.join(managedDir, 'deck-layout/scripts');
});
afterEach(() => {
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('test path escaped');
  fs.rmSync(root, { recursive: true, force: true });
});
async function configure(isPackaged = false, executable = process.execPath) {
  const module = await import('../src/main/skills/slidegen-runtime.js').catch(() => undefined);
  expect(typeof module?.configureSlidegenRuntime).toBe('function');
  return module!.configureSlidegenRuntime({ root: bundledRoot, managedDir, isPackaged, executable, appPath });
}
function config() {
  return JSON.parse(fs.readFileSync(path.join(scripts, 'generate-runtime.json'), 'utf8'));
}

it.each([false, true])(
  'configures the current program for packaged=%s without claiming a model invocation',
  async (isPackaged) => {
    expect(await configure(isPackaged)).toEqual({ ok: true });
    expect(config()).toMatchObject({
      schemaVersion: 1,
      executable: process.execPath,
      args: isPackaged ? [] : [appPath],
      launcherSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(fs.readdirSync(scripts).filter((name) => name.startsWith('.'))).toEqual([]);
  },
);

it('refreshes generated runtime paths after a program move even when the skill contents are unchanged', async () => {
  expect(await configure()).toEqual({ ok: true });
  const script = fs.readFileSync(path.join(scripts, 'generate.cjs'));
  appPath = path.join(root, 'moved application');
  fs.mkdirSync(appPath);
  expect(await configure()).toEqual({ ok: true });
  expect(config().args).toEqual([appPath]);
  expect(fs.readFileSync(path.join(scripts, 'generate.cjs'))).toEqual(script);
});

it('preserves configuration belonging to a user-modified launcher', async () => {
  expect(await configure()).toEqual({ ok: true });
  const before = fs.readFileSync(path.join(scripts, 'generate-runtime.json'));
  fs.appendFileSync(path.join(scripts, 'generate.cjs'), '\nuser customization');
  expect(await configure()).toMatchObject({ ok: false, error: 'slidegen-runtime-script-modified' });
  expect(fs.readFileSync(path.join(scripts, 'generate-runtime.json'))).toEqual(before);
});

it('rejects a scripts junction outside the managed skill root without changing its contents', async () => {
  const outside = path.join(root, 'outside');
  fs.renameSync(scripts, outside);
  fs.symlinkSync(outside, scripts, 'junction');
  expect(await configure()).toMatchObject({ ok: false, error: 'slidegen-runtime-unavailable' });
  expect(fs.existsSync(path.join(outside, 'generate-runtime.json'))).toBe(false);
});

it('accepts the authorized managed root as a junction', async () => {
  const alias = path.join(root, 'alias');
  fs.symlinkSync(managedDir, alias, 'junction');
  managedDir = alias;
  expect(await configure()).toEqual({ ok: true });
  expect(config().executable).toBe(process.execPath);
});

it('does not create phantom scripts or configuration when the launcher is missing', async () => {
  fs.unlinkSync(path.join(scripts, 'generate.cjs'));
  expect(await configure()).toMatchObject({ ok: false, error: 'slidegen-runtime-unavailable' });
  expect(fs.existsSync(path.join(scripts, 'generate-runtime.json'))).toBe(false);
});

it('rejects an unavailable program instead of configuring a guessed tool', async () => {
  expect(await configure(true, path.join(root, 'missing.exe'))).toMatchObject({
    ok: false,
    error: 'slidegen-runtime-unavailable',
  });
  expect(fs.existsSync(path.join(scripts, 'generate-runtime.json'))).toBe(false);
});
