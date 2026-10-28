import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { build } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { taskContextSources } from '../src/main/db/schema.js';

interface SchemaSnapshot {
  columns: string[];
  indexes: Array<{ name: string; unique: number }>;
  indexColumns: string[];
  tableSql?: string;
}

interface ProbeResult {
  initial: SchemaSnapshot;
  reopened: SchemaSnapshot;
  constraints: {
    insertedKind: string;
    duplicateError?: string;
    invalidKindError?: string;
    sourceCountAfterTaskDelete: number;
  };
}

const require = createRequire(import.meta.url);
const electronPath = require('electron') as string;
const probePath = fileURLToPath(new URL('./helpers/db-context-sources-probe.ts', import.meta.url));
const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
const packageDir = dirname(packagePath);
let runnerDir: string;
let compiledProbePath: string;

function runProbe(workspacePath: string): ProbeResult {
  const child = spawnSync(electronPath, [compiledProbePath, workspacePath], {
    cwd: packageDir,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 30_000,
  });

  if (child.error) {
    throw new Error(`Database probe failed to start: ${child.error.message}\nstderr:\n${child.stderr}`);
  }
  if (child.status !== 0) {
    throw new Error(`Database probe exited with status ${child.status}\nstderr:\n${child.stderr}`);
  }

  const resultLine = child.stdout.split(/\r?\n/).find((line) => line.startsWith('DB_CONTEXT_SOURCES_RESULT='));

  if (!resultLine) {
    throw new Error(`Database probe did not return a result:\n${child.stdout}\nstderr:\n${child.stderr}`);
  }
  return JSON.parse(resultLine.slice('DB_CONTEXT_SOURCES_RESULT='.length)) as ProbeResult;
}

describe('task context source database migration', () => {
  let workspacePath: string;

  beforeAll(async () => {
    runnerDir = mkdtempSync(join(packageDir, '.db-context-probe-'));
    compiledProbePath = join(runnerDir, 'probe.mjs');
    await build({
      configFile: false,
      logLevel: 'silent',
      root: packageDir,
      ssr: { noExternal: true, external: ['better-sqlite3'] },
      build: {
        emptyOutDir: true,
        minify: false,
        outDir: runnerDir,
        ssr: probePath,
        rollupOptions: { output: { entryFileNames: 'probe.mjs' } },
      },
    });
  }, 30_000);

  afterAll(() => {
    rmSync(runnerDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    workspacePath = mkdtempSync(join(tmpdir(), 'clawwork-db-context-sources-'));
  });

  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true });
  });

  it('creates the expected table and unique index and remains idempotent after reopening', () => {
    const result = runProbe(workspacePath);
    const expectedColumns = ['id', 'task_id', 'kind', 'absolute_path', 'display_name', 'created_at', 'last_seen_at'];

    expect(result.initial.columns).toEqual(expectedColumns);
    expect(result.initial.tableSql).toContain("CHECK (kind = 'folder')");
    expect(result.initial.indexes).toContainEqual(
      expect.objectContaining({ name: 'task_context_sources_task_path', unique: 1 }),
    );
    expect(result.initial.indexColumns).toEqual(['task_id', 'absolute_path']);
    expect(result.constraints.insertedKind).toBe('folder');
    expect(result.constraints.duplicateError).toContain(
      'UNIQUE constraint failed: task_context_sources.task_id, task_context_sources.absolute_path',
    );
    expect(result.constraints.invalidKindError).toContain('CHECK constraint failed');
    expect(result.constraints.sourceCountAfterTaskDelete).toBe(0);
    expect(result.reopened).toEqual(result.initial);
  });

  it('declares the folder-only kind constraint in the Drizzle schema', () => {
    expectTypeOf<typeof taskContextSources.$inferInsert.kind>().toEqualTypeOf<'folder'>();
    expect(getTableConfig(taskContextSources).checks.map((constraint) => constraint.name)).toContain(
      'task_context_sources_kind_check',
    );
  });
});
