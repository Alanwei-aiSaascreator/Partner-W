import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  preparePortableState,
  rebasePortableConfig,
  PORTABLE_STATE_MIGRATION_BLOCKED,
} from '../src/main/runtime/portable-state-migration.js';
import { acquireStateReadLease } from '../src/main/runtime/state-read-lease.js';

let root: string;
let source: string;
let target: string;
const token = 'test-portable-identity';
const readLease = async () => ({ assertHeld() {}, async release() {} });
const write = (file: string, value: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
};
const writeConfig = (dir: string) =>
  write(path.join(dir, 'openclaw.json'), JSON.stringify({ gateway: { auth: { token } } }));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawwork-migration-test-'));
  source = path.join(root, 'local', 'state', 'identity');
  target = path.join(root, 'portable', 'state', 'identity');
  writeConfig(source);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (root.startsWith(path.join(os.tmpdir(), 'clawwork-migration-test-')))
    fs.rmSync(root, { recursive: true, force: true });
});

const migrate = (overrides: Partial<Parameters<typeof preparePortableState>[0]> = {}) =>
  preparePortableState({
    sourceDir: source,
    stateDir: target,
    workspacePath: path.join(root, 'workspace'),
    token,
    acquireLease: readLease,
    ...overrides,
  });

describe('portable state migration', () => {
  it('copies database and all sidecars together, retains originals and excludes disposable locks', async () => {
    for (const suffix of ['', '-wal', '-shm', '-journal'])
      write(path.join(source, 'state', `openclaw.sqlite${suffix}`), `bytes:${suffix}`);
    write(path.join(source, 'agents', 'main', 'agent', 'history.sqlite-wal'), 'agent-wal');
    write(path.join(source, 'tmp', 'stale.tmp'), 'stale');
    await migrate();
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      expect(fs.readFileSync(path.join(target, 'state', `openclaw.sqlite${suffix}`), 'utf8')).toBe(`bytes:${suffix}`);
      expect(fs.readFileSync(path.join(source, 'state', `openclaw.sqlite${suffix}`), 'utf8')).toBe(`bytes:${suffix}`);
    }
    expect(fs.readFileSync(path.join(target, 'agents', 'main', 'agent', 'history.sqlite-wal'), 'utf8')).toBe(
      'agent-wal',
    );
    expect(fs.existsSync(path.join(target, 'tmp'))).toBe(false);
    expect(fs.existsSync(path.join(target, '.clawwork-portable-state.json'))).toBe(true);
  });

  it('refuses a live gateway before attempting to copy', async () => {
    write(path.join(source, 'tmp', 'openclaw', 'gateway.state.lock'), JSON.stringify({ pid: process.pid }));
    const acquireLease = vi.fn(readLease);
    await expect(migrate({ acquireLease })).rejects.toMatchObject({ code: PORTABLE_STATE_MIGRATION_BLOCKED });
    expect(acquireLease).not.toHaveBeenCalled();
    expect(fs.existsSync(target)).toBe(false);
  });

  it('does not create an empty replacement when the read lease cannot be acquired', async () => {
    await expect(
      migrate({
        acquireLease: async () => {
          throw new Error('busy');
        },
      }),
    ).rejects.toMatchObject({ code: PORTABLE_STATE_MIGRATION_BLOCKED });
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(path.join(source, 'openclaw.json'))).toBe(true);
  });

  it('rolls back only its stage after a mid-copy failure and permits a clean retry', async () => {
    write(path.join(source, 'state', 'history.sqlite'), 'keep-original');
    vi.spyOn(fs, 'copyFileSync').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    await expect(migrate()).rejects.toThrow('disk full');
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(path.dirname(target))).toEqual([]);
    expect(fs.readFileSync(path.join(source, 'state', 'history.sqlite'), 'utf8')).toBe('keep-original');
    vi.restoreAllMocks();
    await migrate();
    expect(fs.readFileSync(path.join(target, 'state', 'history.sqlite'), 'utf8')).toBe('keep-original');
  });

  it('keeps migration blocked even if removing a failed stage also fails', async () => {
    vi.spyOn(fs, 'copyFileSync').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => {
      throw new Error('cleanup denied');
    });
    await expect(migrate()).rejects.toMatchObject({ code: PORTABLE_STATE_MIGRATION_BLOCKED });
    expect(fs.existsSync(target)).toBe(false);
  });

  it('never overwrites existing target history with legacy source history', async () => {
    writeConfig(target);
    write(path.join(target, 'state', 'history.sqlite'), 'newest');
    write(path.join(source, 'state', 'history.sqlite'), 'obsolete');
    await migrate();
    expect(fs.readFileSync(path.join(target, 'state', 'history.sqlite'), 'utf8')).toBe('newest');
  });

  it('refuses another token identity and unsupported links without following them', async () => {
    await expect(migrate({ token: 'another-account' })).rejects.toThrow('does not match');
    const external = path.join(root, 'external');
    fs.mkdirSync(external);
    fs.symlinkSync(external, path.join(source, 'credentials'), 'junction');
    await expect(migrate()).rejects.toThrow('unsupported link');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('rebases known config paths for a drive move while preserving prose, credentials and unrelated paths', () => {
    const previous = { stateDir: 'E:\\app-data\\state\\identity', workspacePath: 'E:\\workspace' };
    const next = { stateDir: 'F:\\app-data\\state\\identity', workspacePath: 'F:\\workspace' };
    const result = rebasePortableConfig(
      {
        agents: {
          entries: {
            main: { workspace: 'E:\\workspace' },
            analyst: {
              workspace: 'E:\\workspace\\agents\\analyst',
              agentDir: 'E:\\app-data\\state\\identity\\agents\\analyst\\agent',
            },
            external: { workspace: 'E:\\workspace-other' },
          },
        },
        skills: { load: { extraDirs: ['E:\\app-data\\state\\identity\\skills'] } },
        prompt: 'E:\\workspace',
        apiKey: 'E:\\workspace',
      },
      previous,
      next,
    );
    expect(result).toMatchObject({
      agents: {
        entries: {
          main: { workspace: 'F:\\workspace' },
          analyst: {
            workspace: 'F:\\workspace\\agents\\analyst',
            agentDir: 'F:\\app-data\\state\\identity\\agents\\analyst\\agent',
          },
          external: { workspace: 'E:\\workspace-other' },
        },
      },
      skills: { load: { extraDirs: ['F:\\app-data\\state\\identity\\skills'] } },
      prompt: 'E:\\workspace',
      apiKey: 'E:\\workspace',
    });
  });

  it('does not remap other agents when the user chooses a different workspace folder', () => {
    expect(
      rebasePortableConfig(
        { agents: { entries: { analyst: { workspace: 'E:\\old-project\\analyst' } } } },
        { stateDir: 'E:\\data\\state\\identity', workspacePath: 'E:\\old-project' },
        { stateDir: 'E:\\data\\state\\identity', workspacePath: 'E:\\new-project' },
      ),
    ).toEqual({ agents: { entries: { analyst: { workspace: 'E:\\old-project\\analyst' } } } });
  });

  it.runIf(process.platform === 'win32')(
    'native read lease blocks a writer until the snapshot is released',
    async () => {
      const file = path.join(source, '\u4e2d\u6587\u76ee\u5f55', 'history.sqlite');
      const wal = `${file}-wal`;
      write(file, 'database');
      write(wal, 'wal');
      const lease = await acquireStateReadLease([file, wal]);
      try {
        lease.assertHeld();
        expect(() => fs.openSync(file, 'r+')).toThrow();
        expect(() => fs.openSync(wal, 'r+')).toThrow();
      } finally {
        await lease.release();
      }
      const writer = fs.openSync(wal, 'r+');
      try {
        await expect(acquireStateReadLease([file, wal])).rejects.toThrow('State is busy');
      } finally {
        fs.closeSync(writer);
      }
    },
  );
});
