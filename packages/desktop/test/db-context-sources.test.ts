import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface SchemaSnapshot {
  columns: string[];
  indexes: Array<{ name: string; unique: number }>;
  tableSql?: string;
}

interface ProbeResult {
  initial: SchemaSnapshot;
  reopened: SchemaSnapshot;
}

const require = createRequire(import.meta.url);
const electronPath = require('electron') as string;
const vitestPackagePath = require.resolve('vitest/package.json');
const viteNodePath = require.resolve('vite-node/vite-node.mjs', {
  paths: [dirname(vitestPackagePath)],
});
const probePath = fileURLToPath(new URL('./helpers/db-context-sources-probe.ts', import.meta.url));

function runProbe(workspacePath: string): ProbeResult {
  const output = execFileSync(electronPath, [viteNodePath, probePath, workspacePath], {
    cwd: dirname(fileURLToPath(new URL('../package.json', import.meta.url))),
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  const resultLine = output.split(/\r?\n/).find((line) => line.startsWith('DB_CONTEXT_SOURCES_RESULT='));

  if (!resultLine) throw new Error(`Database probe did not return a result:\n${output}`);
  return JSON.parse(resultLine.slice('DB_CONTEXT_SOURCES_RESULT='.length)) as ProbeResult;
}

describe('task context source database migration', () => {
  let workspacePath: string;

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
    expect(result.reopened).toEqual(result.initial);
  });
});
