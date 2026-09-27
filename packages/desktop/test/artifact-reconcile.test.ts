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
      // ⭐ A 方案的 spike 2：**生成的 .pptx 会被登记成产物**（类型 file、PPTX 的 MIME）。
      //    这条是「助手做不出 PPT」那件事补完后的落点 —— 文件写进任务目录就会被列出来，
      //    不需要新 UI（见 docs/superpowers/specs/2026-09-24-local-docgen-design.md §2）。
      expect.objectContaining({
        name: '汇报.pptx',
        type: 'file',
        localPath: 'task-1/汇报.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      }),
    ]);
    expect(result.first.skipped).toEqual(expect.arrayContaining(['.secret.txt', 'draft.tmp', 'empty.pdf', 'inbox']));
    expect(result.second.saved).toEqual([]);
    expect(result.second.existing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ localPath: 'task-1/总结.docx' }),
        expect.objectContaining({ localPath: 'task-1/汇报.pptx' }),
      ]),
    );
    expect(result.count).toEqual({ count: 2 });
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

  /**
   * ⭐ **第二个受信根**：助手自己的工作区（2026-09-27）。
   *
   * 现场：用户让助手做 PPT / HTML，文件确实生成了、躺在助手的工作区里，
   * 而产物面板是空的 —— 真机 `.clawwork.db` 里 `SELECT COUNT(*) FROM artifacts` = **0**，
   * 因为扫描根一直是 `<应用工作区>/<taskId>`，与助手工作区是**兄弟目录**。
   *
   * ⚠️ 注意 `legacy-artifact-upgrade` 那条**顺带**验了老库迁移：
   *    探针里那张老 `artifacts` 表**没有 `root` 列**，而它照样通过。
   */
  it('⭐ 助手自己的工作区：新文件进产物，且不建任务目录、不干扰应用根那批', () => {
    const probe = runProbe(workspacePath, 'agent-root') as {
      createdTaskDirInsideAgentWs: boolean;
      agentResult: ReconcileResult;
      appResult: ReconcileResult;
      rows: Array<{ name: string; local_path: string; root: string; source_key: string }>;
    };

    // ① 助手根里新出现的文件被登记了
    expect(probe.agentResult.saved.map((artifact) => artifact.name)).toEqual(['deck.pptx']);
    expect(probe.rows).toHaveLength(1);
    expect(probe.rows[0]).toMatchObject({ name: 'deck.pptx', root: 'agent' });
    // ⭐ `local_path` **不带任务前缀** —— 它是相对**助手工作区**的
    expect(probe.rows[0]?.local_path).toBe('deck.pptx');
    expect(probe.rows[0]?.source_key.startsWith('agent-workspace-file:')).toBe(true);

    // ② 不许在助手工作区里建任务目录：那是**网关的**目录，我们只读
    expect(probe.createdTaskDirInsideAgentWs, '在助手工作区里建了 task-1/').toBe(false);

    // ③ 之后跑的应用根那趟**不该**把助手根的行判成 missing
    //    （两批产物各行其是；混着算就会在界面上显示成"文件不见了"）
    expect(probe.appResult.missing).toEqual([]);
  });
});
