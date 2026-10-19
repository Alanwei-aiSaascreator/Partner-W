import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/main/workspace/config.js';

const memory = vi.hoisted(() => ({
  config: {} as Partial<AppConfig>,
  files: new Map<string, string>(),
  directories: new Set<string>(),
  unreadable: new Set<string>(),
  updates: [] as Partial<AppConfig>[],
  portableRoot: null as string | null,
  writes: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const win = (await import('node:path')).win32;
  const key = (value: string): string => win.normalize(value).toLowerCase();
  return {
    ...actual,
    existsSync: (value: string) => memory.directories.has(key(value)) || memory.files.has(key(value)),
    mkdirSync: (value: string) => memory.directories.add(key(value)),
    readFileSync: (value: string) => {
      if (memory.unreadable.has(key(value))) throw new Error('EACCES');
      const result = memory.files.get(key(value));
      if (result === undefined) throw new Error('ENOENT');
      return result;
    },
    writeFileSync: (value: string, content: string) => {
      memory.writes += 1;
      memory.files.set(key(value), content);
    },
  };
});
vi.mock('../src/main/db/index.js', () => ({ initDatabase: vi.fn(), closeDatabase: vi.fn() }));
vi.mock('../src/main/workspace/config.js', () => ({
  readConfig: () => memory.config,
  updateConfig: (patch: Partial<AppConfig>) => {
    memory.updates.push(patch);
    memory.config = { ...memory.config, ...patch };
  },
  getDefaultWorkspacePath: () => 'F:\\Work',
  getHomedirWorkspacePath: () => 'C:\\Users\\fixture\\Work',
  getPortableWorkspaceRoot: () => memory.portableRoot,
  setPortableWorkspaceRoot: (root: string | null) => {
    memory.portableRoot = root;
  },
}));

import { prepareWorkspaceAtStartup } from '../src/main/workspace/startup.js';
import { readWorkspaceId } from '../src/main/workspace/init.js';
import { WORKSPACE_MARKER_FILE } from '../src/main/workspace/portable.js';
import { existsSync } from 'node:fs';

const key = (value: string): string => path.win32.normalize(value).toLowerCase();
const marker = (value: string): string => key(path.win32.join(value, WORKSPACE_MARKER_FILE));
const target = 'F:\\Work';
function seed(recorded = 'E:\\Work', id: string | undefined = 'A', contents = '{"workspaceId":"A"}'): void {
  memory.config = {
    workspacePath: recorded,
    workspaceRelPath: 'Work',
    workspaceBinding: 'app-volume',
    workspaceId: id,
  };
  memory.directories.add(key(target));
  memory.files.set(marker(target), contents);
}
function harness() {
  const database = { init: vi.fn(), close: vi.fn() };
  const dialogs = {
    askForMissingWorkspace: vi.fn(async () => ({ kind: 'quit' as const })),
    browseForDirectory: vi.fn(async () => null),
    askForUnusableWorkspace: vi.fn(async () => 'quit' as const),
  };
  return {
    database,
    dialogs,
    run: () =>
      prepareWorkspaceAtStartup({
        exePath: 'F:\\App\\app.exe',
        removableDrives: ['F:\\'],
        exists: existsSync,
        database,
        dialogs,
      }),
  };
}

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  memory.config = {};
  memory.files.clear();
  memory.directories.clear();
  memory.unreadable.clear();
  memory.updates = [];
  memory.portableRoot = null;
  memory.writes = 0;
});
afterEach(() => vi.restoreAllMocks());

describe('R8 startup identity with real portable/init/startup modules', () => {
  it.each(['E:\\Work', target])(
    'preserves configured identity at %s for every unreadable or conflicting marker',
    async (recorded) => {
      for (const contents of ['{"workspaceId":"B"}', '{"formatVersion":1}', '{broken', 'unreadable']) {
        seed(recorded, 'A', contents);
        memory.updates = [];
        memory.writes = 0;
        if (contents === 'unreadable') memory.unreadable.add(marker(target));
        const snapshot = JSON.stringify(memory.config);
        const h = harness();
        expect(await h.run()).toEqual({ kind: 'quit', reason: 'user-chose-quit' });
        expect(h.dialogs.askForMissingWorkspace).toHaveBeenCalledTimes(1);
        expect(h.database.init).not.toHaveBeenCalled();
        expect(JSON.stringify(memory.config)).toBe(snapshot);
        expect(memory.updates).toEqual([]);
        expect(memory.files.get(marker(target))).toBe(contents);
        expect(memory.writes).toBe(0);
      }
    },
  );

  it.each<NonNullable<AppConfig['bundledSkillRecords']>>([
    { 'E:\\unrelated-gateway\\skills': {} },
    { 'E:\\old-state\\skills': {}, 'G:\\current-state\\skills': {} },
    { 'E:\\retired-install\\skills': {} },
  ])('does not infer identity from skill history %j', async (records) => {
    seed('E:\\Work', 'A', '{"workspaceId":"B"}');
    delete memory.config.workspaceId;
    memory.config.workspaceBinding = 'explicit-path';
    memory.config.bundledSkillRecords = records;
    const snapshot = JSON.stringify(memory.config);
    const h = harness();
    await h.run();
    expect(h.dialogs.askForMissingWorkspace).toHaveBeenCalledTimes(1);
    expect(h.database.init).not.toHaveBeenCalled();
    expect(JSON.stringify(memory.config)).toBe(snapshot);
    expect(memory.writes).toBe(0);
  });

  it.each(['app-volume'] as const)(
    'automatically restores proven identity across drive letters for %s',
    async (binding) => {
      seed();
      memory.config.workspaceBinding = binding;
      const h = harness();
      expect(await h.run()).toMatchObject({ kind: 'ready', path: target, decision: { kind: 'healed' } });
      expect(h.dialogs.askForMissingWorkspace).not.toHaveBeenCalled();
      expect(h.database.init).toHaveBeenCalledExactlyOnceWith(target);
      expect(memory.config).toMatchObject({ workspacePath: target, workspaceId: 'A', workspaceBinding: 'app-volume' });
      expect(readWorkspaceId(target)).toBe('A');
      expect(memory.writes).toBe(0);
    },
  );

  it('upgrades a legacy app-volume workspace once and then restores the same identity', async () => {
    seed(target, 'A', '{"formatVersion":1,"app":"rongying-cube"}');
    delete memory.config.workspaceId;
    const h = harness();
    expect(await h.run()).toMatchObject({ kind: 'ready', decision: { kind: 'configured' } });
    const id = readWorkspaceId(target);
    expect(id).toBeTruthy();
    expect(memory.config.workspaceId).toBe(id);
    expect(memory.writes).toBe(1);
    await h.run();
    expect(memory.writes).toBe(1);
    memory.config.workspacePath = 'E:\\Work';
    expect(await h.run()).toMatchObject({ kind: 'ready', path: target, decision: { kind: 'healed' } });
    expect(memory.config.workspaceId).toBe(id);
    expect(h.dialogs.askForMissingWorkspace).not.toHaveBeenCalled();
    expect(memory.writes).toBe(1);
  });

  it('opens the bound current-volume copy when the old drive contains the same identity', async () => {
    seed();
    memory.directories.add(key('E:\\Work'));
    memory.files.set(marker('E:\\Work'), '{"workspaceId":"A"}');
    const h = harness();
    expect(await h.run()).toMatchObject({ kind: 'ready', path: target, decision: { kind: 'healed' } });
    expect(h.dialogs.askForMissingWorkspace).not.toHaveBeenCalled();
    expect(h.database.init).toHaveBeenCalledExactlyOnceWith(target);
    expect(memory.config).toMatchObject({ workspacePath: target, workspaceId: 'A', workspaceBinding: 'app-volume' });
    expect(memory.files.get(marker('E:\\Work'))).toBe('{"workspaceId":"A"}');
    expect(memory.writes).toBe(0);
  });

  it.each([false, true])(
    'never adopts a current-volume copy of an explicit external binding (old exists=%s)',
    async (oldExists) => {
      seed();
      memory.config.workspaceBinding = 'explicit-path';
      if (oldExists) {
        memory.directories.add(key('E:\\Work'));
        memory.files.set(marker('E:\\Work'), '{"workspaceId":"A"}');
      }
      const snapshot = JSON.stringify(memory.config);
      const h = harness();
      if (oldExists) {
        expect(await h.run()).toMatchObject({ kind: 'ready', path: 'E:\\Work', decision: { kind: 'configured' } });
        expect(h.database.init).toHaveBeenCalledExactlyOnceWith('E:\\Work');
        expect(memory.config.workspaceBinding).toBe('explicit-path');
      } else {
        expect(await h.run()).toEqual({ kind: 'quit', reason: 'user-chose-quit' });
        expect(h.dialogs.askForMissingWorkspace).toHaveBeenCalledTimes(1);
        expect(h.database.init).not.toHaveBeenCalled();
        expect(JSON.stringify(memory.config)).toBe(snapshot);
        expect(memory.updates).toEqual([]);
      }
      expect(memory.writes).toBe(0);
    },
  );

  it('does not silently recreate an identified workspace when its directory disappears', async () => {
    memory.config = { workspacePath: target, workspaceId: 'A' };
    memory.directories.add(key('F:\\'));
    const h = harness();
    expect(await h.run()).toEqual({ kind: 'quit', reason: 'user-chose-quit' });
    expect(h.dialogs.askForMissingWorkspace).toHaveBeenCalledTimes(1);
    expect(h.database.init).not.toHaveBeenCalled();
    expect(memory.updates).toEqual([]);
    expect(memory.writes).toBe(0);
    expect(memory.config.workspaceId).toBe('A');
  });
});
