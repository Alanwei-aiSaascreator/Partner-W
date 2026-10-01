import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const packageDir = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
let runnerDir: string;
let workspacePath: string;

function run(scenario: string, role?: string, collision?: string): Record<string, unknown> {
  const child = spawnSync(
    require('electron') as string,
    [join(runnerDir, 'probe.mjs'), workspacePath, scenario, ...(role ? [role] : []), ...(collision ? [collision] : [])],
    {
      cwd: packageDir,
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 30_000,
      windowsHide: true,
    },
  );
  if (child.status !== 0 || child.error) throw new Error(`Probe failed: ${child.error?.message ?? child.stderr}`);
  const line = child.stdout.split(/\r?\n/).find((line) => line.startsWith('MESSAGE_PERSISTENCE_RESULT='));
  if (!line) throw new Error(child.stdout);
  return JSON.parse(line.slice('MESSAGE_PERSISTENCE_RESULT='.length));
}

describe('production message IPC with Drizzle and Electron SQLite', () => {
  beforeAll(async () => {
    runnerDir = mkdtempSync(join(packageDir, '.message-persistence-probe-'));
    await build({
      configFile: false,
      logLevel: 'silent',
      root: packageDir,
      resolve: { alias: { electron: fileURLToPath(new URL('./helpers/message-persistence-ipc.ts', import.meta.url)) } },
      plugins: [
        {
          name: 'isolate-message-ipc-environment',
          enforce: 'pre',
          resolveId(source, importer) {
            if (
              importer?.replaceAll('\\', '/').endsWith('/src/main/ipc/data-handlers.ts') &&
              ![
                '../artifact/delivery-operation.js',
                '../artifact/workspace-owner.js',
                '../slidegen/tool-receipts.js',
              ].includes(source) &&
              (source.startsWith('../artifact/') ||
                source.startsWith('../docgen/') ||
                source.startsWith('../htmlgen/') ||
                source.startsWith('../slidegen/') ||
                source === '../workspace/config.js' ||
                source === '../ws/index.js' ||
                source === '../debug/index.js' ||
                source === './team-meeting-handlers.js')
            )
              return '\0message-ipc-environment';
          },
          load(id) {
            if (id === '\0message-ipc-environment')
              return `
                export const getWorkspacePath = () => null;
                export const getGatewayClient = () => undefined;
                export const getDebugLogger = () => undefined;
                export const withTeamMeetingTaskDeletion = (_id, remove) => remove();
                export const DISPLAY_TRUNCATION_MARKER = '[truncated]';
                export const EXPECTED_ARTIFACT_LABELS = {};
                export const autoExtractArtifacts = async () => undefined;
                export const captureTaskArtifactBaseline = async () => new Map();
                export const reconcileTaskArtifacts = async () => [];
                export const resolveAgentWorkspace = () => undefined;
                export const generateDocumentsFromMessage = async () => [];
                export const resolvePptxTemplatesRoot = () => undefined;
                export const generateHtmlPagesFromMessage = async () => [];
                export const generateSlidesFromMessage = async () => [];
                export const captureDeckFileBaseline = async () => new Map();
                export const changedDeckFiles = () => [];
                export const decksFromFiles = () => [];
                export const historyFetcherFrom = () => undefined;
                export const recoverFullReply = async () => undefined;
                export const checkClaimedFiles = () => [];
                export const expectedArtifactKindsFromRequest = () => [];
                export const missingExpectedArtifactKinds = () => [];
              `;
          },
        },
      ],
      ssr: { noExternal: true, external: ['better-sqlite3'] },
      build: {
        target: 'es2022',
        emptyOutDir: true,
        minify: false,
        outDir: runnerDir,
        ssr: fileURLToPath(new URL('./helpers/message-persistence-probe.ts', import.meta.url)),
        rollupOptions: { output: { entryFileNames: 'probe.mjs' } },
      },
    });
  });
  afterAll(() => {
    if (runnerDir) rmSync(runnerDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    workspacePath = mkdtempSync(join(packageDir, '.message-persistence-workspace-'));
  });
  afterEach(() => {
    if (workspacePath) rmSync(workspacePath, { recursive: true, force: true });
  });

  it('creates a partial canonical index for a fresh database', () => {
    expect(run('fresh')).toMatchObject({
      index: { sql: expect.stringMatching(/WHERE role <> 'system'/) },
      integrity: { foreignKeys: [], duplicates: [] },
    });
  });
  it('preserves legacy history, rowids, artifact references and FTS through migration and reopening', () => {
    const result = run('migration');
    const legacy = result.legacy as { history: Array<{ id: string; rowid: number; content: string }> };
    expect(result).toMatchObject({
      migrated: { index: { sql: expect.stringMatching(/WHERE role <> 'system'/) }, rows: [{}, {}, {}] },
      response: { ok: true },
      reopened: {
        rows: [{}, {}, {}, {}],
        index: { sql: expect.stringMatching(/WHERE role <> 'system'/) },
        integrity: {
          artifacts: [{ message_id: 'old-system' }],
          foreignKeys: [],
          fts: [{}, {}, {}, {}],
          duplicates: [],
        },
      },
    });
    expect(result.history).toEqual(expect.arrayContaining(legacy.history));
  });
  it('rolls back index replacement when legacy canonical conflicts prevent migration', () => {
    const result = run('migration-rollback');
    const before = result.before as { history: unknown[]; oldIndex: unknown };
    expect(result.error).toMatch(/UNIQUE constraint failed/);
    expect(result.index).toEqual(before.oldIndex);
    expect(result.history).toEqual(before.history);
    expect(result.logicalIndex).toEqual({ name: 'messages_logical_unique' });
  });
  it.each(['distinct', 'same-text'])('preserves different system IDs in the same millisecond: %s', (scenario) => {
    const result = run(scenario);
    expect(result).toMatchObject({
      responses: [{ ok: true }, { ok: true }],
      before: [{ id: 'system-1' }, { id: 'system-2' }],
      integrity: { foreignKeys: [], artifacts: [{ message_id: 'system-1' }], fts: [{}, {}], duplicates: [] },
    });
    expect(result.reopened).toEqual(result.before);
  });
  it('replays and updates a system ID without replacing its row or artifact references', () => {
    expect(run('replay')).toMatchObject({
      responses: [{ ok: true }, { ok: true }, { ok: true }],
      rows: [{ id: 'system-1', content: 'updated notice' }],
      integrity: { foreignKeys: [], artifacts: [{ message_id: 'system-1' }], fts: [{ content: 'updated notice' }] },
    });
  });
  it.each(['user', 'assistant'])('retains canonical tuple identity and optional metadata for %s', (role) => {
    expect(run('canonical', role)).toMatchObject({
      responses: [{ ok: true }, { ok: true }],
      rows: [
        {
          id: 'canonical-1',
          content: 'updated canonical',
          model: 'fixture-model',
          thinking_content: 'stored thinking',
        },
      ],
      integrity: {
        foreignKeys: [],
        artifacts: [{ message_id: 'canonical-1' }],
        fts: [{ content: 'updated canonical' }],
        duplicates: [],
      },
    });
  });
  it.each(['system', 'user', 'assistant'].flatMap((role) => ['task', 'session', 'role'].map((kind) => [role, kind])))(
    'rejects reuse of a %s ID with a different %s even when the target tuple exists',
    (role, kind) => {
      const result = run('collision', role, kind);
      expect(result.responses).toEqual([{ ok: true }, { ok: true }, { ok: false, error: expect.any(String) }]);
      expect(result.after).toEqual(result.before);
      expect(result.integrity).toMatchObject({ foreignKeys: [], duplicates: [] });
    },
  );
  it.each(['system', 'user', 'assistant'])('isolates %s messages by task and session', (role) => {
    expect(run('isolation', role)).toMatchObject({
      responses: [{ ok: true }, { ok: true }, { ok: true }],
      rows: [{}, {}, {}],
      integrity: { foreignKeys: [], duplicates: [] },
    });
  });
});
