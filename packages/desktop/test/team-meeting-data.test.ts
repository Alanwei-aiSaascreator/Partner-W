import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const packageDir = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
let runnerDir: string;
let workspacePath: string;

function run(scenario: string): Record<string, unknown> {
  const child = spawnSync(require('electron') as string, [join(runnerDir, 'probe.mjs'), workspacePath, scenario], {
    cwd: packageDir,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 30_000,
  });
  if (child.status !== 0 || child.error) throw new Error(`Probe failed: ${child.error?.message ?? child.stderr}`);
  const line = child.stdout.split(/\r?\n/).find((line) => line.startsWith('TEAM_MEETING_RESULT='));
  if (!line) throw new Error(child.stdout);
  return JSON.parse(line.slice('TEAM_MEETING_RESULT='.length));
}

describe('team meeting metadata SQLite IPC', () => {
  beforeAll(async () => {
    runnerDir = mkdtempSync(join(packageDir, '.team-meeting-probe-'));
    await build({
      configFile: false,
      logLevel: 'silent',
      root: packageDir,
      resolve: { alias: { electron: fileURLToPath(new URL('./helpers/team-meeting-ipc.ts', import.meta.url)) } },
      plugins: [
        {
          name: 'nested-probe-index-source',
          enforce: 'pre',
          load(id) {
            if (process.env.CLAW_TEST_GIT_INDEX !== '1') return;
            const repository = resolve(packageDir, '../..');
            const path = relative(repository, id.split('?')[0]).replaceAll('\\', '/');
            if (/^packages\/[^/]+\/(?:src|test)\/.*\.[cm]?[jt]sx?$/.test(path))
              return execFileSync('git', ['show', ':' + path], { cwd: repository, encoding: 'utf8' });
          },
        },
        {
          name: 'fixture-device-id',
          enforce: 'pre',
          resolveId(source, importer) {
            if (source === '../workspace/config.js' && importer?.includes('team-meeting-handlers'))
              return '\0fixture-device-id';
          },
          load(id) {
            if (id === '\0fixture-device-id') return 'export const ensureDeviceId = () => "test-device";';
          },
        },
      ],
      ssr: { noExternal: true, external: ['better-sqlite3'] },
      build: {
        target: 'es2022',
        emptyOutDir: true,
        minify: false,
        outDir: runnerDir,
        ssr: fileURLToPath(new URL('./helpers/team-meeting-data-probe.ts', import.meta.url)),
        rollupOptions: { output: { entryFileNames: 'probe.mjs' } },
      },
    });
  });
  afterAll(() => {
    if (runnerDir) rmSync(runnerDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    workspacePath = mkdtempSync(join(tmpdir(), 'clawwork-meeting-test-'));
  });
  afterEach(() => {
    if (workspacePath) rmSync(workspacePath, { recursive: true, force: true });
  });

  it('creates the metadata table through the normal disposable database migration', () => {
    expect(run('schema')).toEqual([{ name: 'team_meetings' }]);
  });
  it('atomically creates exactly three tasks and metadata without assistant copies', () => {
    expect(run('create')).toMatchObject({
      response: { ok: true, result: { record: { revision: 0 }, tasks: [{}, {}, {}] } },
      listed: { ok: true, result: [{ id: 'meeting' }] },
      count: { tasks: { n: 3 }, meetings: { n: 1 } },
      assistantRows: { n: 0 },
    });
  });
  it('rolls back all tasks when the metadata insertion fails', () => {
    expect(run('rollback')).toMatchObject({ response: { ok: false }, count: { tasks: { n: 0 }, meetings: { n: 0 } } });
  });
  it.each(['gateway', 'agent', 'device', 'ensemble', 'missing'])(
    'rejects invalid %s before inserting tasks',
    (kind) => {
      expect(run(`invalid-${kind}`)).toMatchObject({
        response: { ok: false },
        count: { tasks: { n: 0 }, meetings: { n: 0 } },
      });
    },
  );
  it('compares revisions and preserves immutable ownership', () => {
    expect(run('cas')).toMatchObject({
      saved: { ok: true, result: { revision: 1 } },
      stale: { ok: false },
      ownership: { ok: false },
      listed: { ok: true, result: [{ gatewayId: 'gateway', revision: 1 }] },
    });
  });
  it('fails safely on malformed JSON', () => {
    expect(run('corrupt')).toMatchObject({ ok: false });
  });
  it('does not let a caller mark a task missing to bypass ownership validation', () => {
    expect(run('missing-save')).toMatchObject({ ok: false });
  });
  it('preserves accepted receipts and checks canonical message ownership before completion', () => {
    expect(run('receipt')).toMatchObject({
      accepted: { ok: true },
      replacement: { ok: false },
      missingMessage: { ok: false },
      saved: { ok: true },
      regression: { ok: false },
    });
  });
  it('blocks deleting an active meeting task', () => {
    expect(run('delete-running')).toMatchObject({ error: expect.any(String), count: { tasks: { n: 3 } } });
  });
  it.each([
    ['draft', 'none'],
    ['running', 'none'],
    ['stopping', 'requested'],
    ['dispatching', 'none'],
    ['syncing', 'none'],
    ['stopped', 'unconfirmed'],
    ['stopped', 'requested'],
    ['interrupted', 'unconfirmed'],
    ['interrupted', 'requested'],
  ])('rejects IPC creation alongside persisted %s/%s without inserting tasks', (status, abortStatus) => {
    expect(run(`start:${status}:${abortStatus}`)).toMatchObject({
      response: { ok: false, error: expect.stringContaining('active meeting') },
      count: { tasks: { n: 3 }, meetings: { n: 1 } },
    });
  });
  it.each(['confirmed', 'not-running'])('allows IPC creation only after explicit abort retry reports %s', (result) => {
    expect(run(`start:stopped:unconfirmed:${result}`)).toMatchObject({
      response: { ok: false },
      blockedCount: { tasks: { n: 3 }, meetings: { n: 1 } },
      retry: { ok: true },
      unlocked: { ok: true },
      count: { tasks: { n: 6 }, meetings: { n: 2 } },
    });
  });
  it.each([
    ['stopped', 'unconfirmed'],
    ['stopped', 'requested'],
    ['interrupted', 'unconfirmed'],
    ['interrupted', 'requested'],
  ])('blocks deletion of %s tasks with %s cancellation', (status, abortStatus) => {
    expect(run(`delete-state:${status}:${abortStatus}`)).toMatchObject({
      error: expect.stringContaining('active meeting'),
      removed: false,
      count: { tasks: { n: 3 }, meetings: { n: 1 } },
    });
  });
  it.each([
    ['stopped', 'confirmed'],
    ['stopped', 'not-running'],
    ['completed', 'unconfirmed'],
  ])('allows deletion after %s/%s canonical or cancellation evidence', (status, abortStatus) => {
    expect(run(`delete-state:${status}:${abortStatus}`)).toMatchObject({
      removed: true,
      count: { tasks: { n: 2 }, meetings: { n: 1 } },
    });
  });
  it.each([
    ['stopped', 'unconfirmed', 'unrelated'],
    ['completed', 'unconfirmed', 'same-team'],
    ['failed', 'not-running', 'same-team'],
  ])('allows %s/%s records alongside %s IPC creation', (status, abortStatus, team) => {
    expect(run(`start:${status}:${abortStatus}:${team}`)).toMatchObject({
      response: { ok: true },
      count: { tasks: { n: 6 }, meetings: { n: 2 } },
    });
  });
  it('does not relock canonical completed meetings after managed deletion interrupts their metadata', () => {
    expect(run('delete-state:completed:unconfirmed:create')).toMatchObject({
      removed: true,
      deletedCount: { tasks: { n: 2 }, meetings: { n: 1 } },
      nextMeeting: { ok: true },
      count: { tasks: { n: 5 }, meetings: { n: 2 } },
      listed: {
        ok: true,
        result: [{ id: 'meeting', status: 'interrupted', abortStatus: 'unconfirmed' }, { id: 'next-meeting' }],
      },
    });
  });
  it('retains child tasks and marks missing owner metadata after idle deletion', () => {
    expect(run('delete-idle')).toMatchObject({
      count: { tasks: { n: 2 }, meetings: { n: 1 } },
      taskIds: [{ id: 'task-0' }, { id: 'task-1' }],
      listed: {
        ok: true,
        result: [{ ownerTaskId: 'task-2', status: 'interrupted', missingTaskIds: ['task-2'], revision: 1 }],
      },
    });
  });
  it('rolls back task deletion if interrupted metadata cannot be saved', () => {
    expect(run('delete-rollback')).toMatchObject({
      error: expect.any(String),
      count: { tasks: { n: 3 } },
      listed: { ok: true, result: [{ status: 'draft', revision: 0 }] },
    });
  });
});
