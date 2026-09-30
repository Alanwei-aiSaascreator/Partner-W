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
});
