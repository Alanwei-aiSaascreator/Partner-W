import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

interface ArtifactRow {
  id: string;
  name: string;
  type: string;
  localPath: string;
  mimeType: string;
  size: number;
}

interface ReconcileResult {
  saved: ArtifactRow[];
  existing: ArtifactRow[];
  updated: ArtifactRow[];
  missing: ArtifactRow[];
  skipped: string[];
  budgetExhausted: boolean;
}

const require = createRequire(import.meta.url);
const electronPath = require('electron') as string;
const probePath = fileURLToPath(new URL('./helpers/artifact-reconcile-probe.ts', import.meta.url));
const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
const packageDir = dirname(packagePath);
let runnerDir: string;
let compiledProbePath: string;

function runProbe(workspacePath: string, scenario: string): Record<string, unknown> {
  const child = spawnSync(electronPath, [compiledProbePath, workspacePath, scenario], {
    cwd: packageDir,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 30_000,
  });
  if (child.error) throw new Error(`Artifact probe failed to start: ${child.error.message}\nstderr:\n${child.stderr}`);
  if (child.status !== 0) {
    throw new Error(`Artifact probe exited with status ${child.status}\nstderr:\n${child.stderr}`);
  }
  const line = child.stdout.split(/\r?\n/).find((value) => value.startsWith('ARTIFACT_RECONCILE_RESULT='));
  if (!line) throw new Error(`Artifact probe did not return a result:\n${child.stdout}\nstderr:\n${child.stderr}`);
  return JSON.parse(line.slice('ARTIFACT_RECONCILE_RESULT='.length)) as Record<string, unknown>;
}

describe('artifact reconciliation', () => {
  let workspacePath: string;

  beforeAll(async () => {
    runnerDir = mkdtempSync(join(packageDir, '.artifact-reconcile-probe-'));
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

  afterAll(() => rmSync(runnerDir, { recursive: true, force: true }));
  beforeEach(() => {
    workspacePath = mkdtempSync(join(tmpdir(), 'clawwork-artifact-reconcile-'));
  });
  afterEach(() => rmSync(workspacePath, { recursive: true, force: true }));

  it('registers only new stable generated files and is idempotent', () => {
    const result = runProbe(workspacePath, 'lifecycle') as unknown as {
      first: ReconcileResult;
      second: ReconcileResult;
      count: { count: number };
    };
    expect(result.first.saved).toEqual([
      expect.objectContaining({
        name: '总结.docx',
        type: 'file',
        localPath: 'task-1/总结.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ]);
    expect(result.first.skipped).toEqual(expect.arrayContaining(['.secret.txt', 'draft.tmp', 'empty.pdf', 'inbox']));
    expect(result.second.saved).toEqual([]);
    expect(result.second.existing).toEqual([expect.objectContaining({ localPath: 'task-1/总结.docx' })]);
    expect(result.count).toEqual({ count: 1 });
  });

  it('does not register a file that existed unchanged in the run baseline', () => {
    const { result } = runProbe(workspacePath, 'baseline') as unknown as { result: ReconcileResult };
    expect(result.saved).toEqual([]);
  });

  it('captures an empty baseline for a new task before its output directory exists', () => {
    expect(runProbe(workspacePath, 'new-task-baseline')).toEqual({ baseline: {} });
  });

  it('fails closed for an outside task junction or symlink', () => {
    const result = runProbe(workspacePath, 'task-link') as { supported: boolean; error?: string };
    if (!result.supported) return;
    expect(result.error).toMatch(/trusted task output/i);
  });

  it('reports database artifacts whose files are now missing', () => {
    const { result } = runProbe(workspacePath, 'missing') as unknown as { result: ReconcileResult };
    expect(result.missing).toEqual([
      expect.objectContaining({ id: 'artifact-missing', localPath: 'task-1/deleted.pdf' }),
    ]);
  });

  it('does not register a file that changes during stability verification', () => {
    const { result } = runProbe(workspacePath, 'changing') as unknown as { result: ReconcileResult };
    expect(result.saved).toEqual([]);
    expect(result.skipped).toContain('changing.txt');
  });

  it('retries stability verification once from the trusted root and registers a file that then settles', () => {
    const { result, checks } = runProbe(workspacePath, 'changing-once') as unknown as {
      result: ReconcileResult;
      checks: number;
    };
    expect(checks).toBe(2);
    expect(result.saved).toEqual([expect.objectContaining({ name: 'changing-once.txt' })]);
  });

  it('does not let unchanged baseline files consume the generated-result budget', () => {
    const { result } = runProbe(workspacePath, 'old-files-budget') as unknown as { result: ReconcileResult };
    expect(result.saved).toEqual([expect.objectContaining({ name: 'z-result.txt' })]);
  });

  it('fails closed when the run baseline was truncated', () => {
    const { result } = runProbe(workspacePath, 'truncated-baseline') as unknown as { result: ReconcileResult };
    expect(result.saved).toEqual([]);
    expect(result.budgetExhausted).toBe(true);
  });

  it('bounds traversal and reports exhaustion without scanning the whole task tree', () => {
    const { result } = runProbe(workspacePath, 'budget') as unknown as { result: ReconcileResult };
    expect(result.budgetExhausted).toBe(true);
    expect(result.saved.length).toBeLessThanOrEqual(2);
  });

  it('keeps concurrent reconciliation idempotent for the same task path', () => {
    const result = runProbe(workspacePath, 'concurrent') as unknown as {
      left: ReconcileResult;
      right: ReconcileResult;
      count: { count: number };
    };
    expect([...result.left.saved, ...result.right.saved]).toHaveLength(1);
    expect(result.count).toEqual({ count: 1 });
  });

  it('updates metadata in place when an already registered output changes', () => {
    const result = runProbe(workspacePath, 'updated') as unknown as {
      first: ReconcileResult;
      second: ReconcileResult;
      count: { count: number };
      stored: { size: number };
    };
    expect(result.second.updated).toEqual([expect.objectContaining({ id: result.first.saved[0].id, size: 14 })]);
    expect(result.count).toEqual({ count: 1 });
    expect(result.stored).toEqual({ size: 14 });
  });

  it('updates an artifact when the path is replaced with the same size and mtime', () => {
    const { first, second } = runProbe(workspacePath, 'replaced-same-metadata') as unknown as {
      first: ReconcileResult;
      second: ReconcileResult;
    };
    expect(second.updated).toEqual([expect.objectContaining({ id: first.saved[0].id })]);
  });

  it('does not rewrite an artifact already registered by attachment extraction', () => {
    const { result, stored } = runProbe(workspacePath, 'attachment') as unknown as {
      result: ReconcileResult;
      stored: { source_key: string; content_text: string };
    };
    expect(result.updated).toEqual([]);
    expect(result.existing).toEqual([expect.objectContaining({ id: 'attachment-artifact' })]);
    expect(stored).toEqual({ source_key: 'attachment:0:image.png', content_text: 'preserve me' });
  });

  it('excludes nested symlinks and never scans another task', () => {
    const probe = runProbe(workspacePath, 'nested-link') as unknown as {
      supported: boolean;
      result?: ReconcileResult;
    };
    if (!probe.supported) return;
    expect(probe.result?.saved.map((artifact) => artifact.name)).toEqual(['own.pdf']);
    expect(probe.result?.skipped).toContain('linked');
  });

  it('upgrades a legacy database by keeping the newest valid duplicate artifact metadata', () => {
    const { rows } = runProbe(workspacePath, 'legacy-artifact-upgrade') as {
      rows: Array<{ id: string; size: number; source_key: string }>;
    };
    expect(rows).toEqual([{ id: 'new-valid', size: 42, source_key: 'workspace-file:report.txt:new' }]);
  });
});
