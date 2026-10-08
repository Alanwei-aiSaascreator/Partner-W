import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildElectronProbe, runElectronProbe, type ElectronProbe } from './helpers/electron-probe.js';

/**
 * 产物登记的**唯一索引语义**（2026-10-07 体检 P2-2 / P2-4）——真 SQLite + 真文件系统。
 *
 * 两条唯一索引（`artifacts_source_dedup` / `artifacts_task_local_path`）的冲突处理
 * 只有在真索引上才测得准：`uniqueFileNameIn` **只查磁盘不查库**，"有行无文件 ⇒ 复用同名
 * ⇒ 撞唯一约束 ⇒ 旧实现把刚写的好文件 unlink 掉"这条链在 mock 里根本走不到
 * （见 `artifact-save.test.ts` 顶部的说明与那里的 mock 用例 —— 两者互补）。
 *
 * ⚠️ 探针跑在 `ELECTRON_RUN_AS_NODE` 的 electron 里（`better-sqlite3` 是 Electron ABI）。
 */

const probePath = fileURLToPath(new URL('./helpers/artifact-save-probe.ts', import.meta.url));
const packageDir = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const privateProbeRoot = process.env.CLAW_ARTIFACT_PROBE_ROOT;

interface SaveProbeResult {
  first: { id: string; name: string; localPath: string; filePath: string };
  replay: { id: string; name: string };
  afterReplay: { fileCount: number; rows: Array<{ id: string; local_path: string }> };
  fileGoneBeforeSecondSave: boolean;
  revived: { id: string; name: string; localPath: string };
  rows: Array<{ id: string; name: string; local_path: string; size: number }>;
  files: string[];
  revivedContent: string;
}

let electronProbe: ElectronProbe;
let workspacePath: string;
let result: SaveProbeResult;

beforeAll(async () => {
  electronProbe = await buildElectronProbe({ probePath, packageDir, privateProbeRoot });
  workspacePath = mkdtempSync(join(privateProbeRoot ?? tmpdir(), 'clawwork-artifact-save-'));
  result = runElectronProbe({
    compiledProbePath: electronProbe.compiledProbePath,
    packageDir,
    workspacePath,
    scenario: 'save-index-semantics',
    privateProbeRoot,
  }) as unknown as SaveProbeResult;
}, 60_000);

afterAll(() => {
  electronProbe.cleanup();
  rmSync(workspacePath, { recursive: true, force: true });
});

describe('产物登记的唯一索引语义（真 SQLite + 真文件系统）', () => {
  it('⭐ 同 message 同 sourceKey 重放 ⇒ 返回既有行、只落一份文件、不报假失败', () => {
    expect(result.replay.id).toBe(result.first.id);
    expect(result.replay.name).toBe(result.first.name);
    // 只有一份文件（重放在**写盘之前**结算；不是"写完第二份再删"）
    expect(result.afterReplay.fileCount).toBe(1);
    // 库里也只有一行
    expect(result.afterReplay.rows).toHaveLength(1);
    expect(result.afterReplay.rows[0]).toMatchObject({ local_path: 'task-1/report.md' });
  });

  it('⭐ "有行无文件"占着落点名 ⇒ 清旧行、登记新文件（名字不再被永久毒化）', () => {
    expect(result.fileGoneBeforeSecondSave, '前置条件：文件确实被外部删掉了').toBe(false);
    // 旧实现：INSERT 撞 artifacts_task_local_path ⇒ catch 里 unlink 刚写的好文件 ⇒ 抛错。
    expect(result.revived.localPath).toBe('task-1/report.md');
    expect(result.revived.id).not.toBe(result.first.id);
    expect(result.revivedContent).toBe('second-pass');
    expect(result.files).toEqual(['report.md']);
    // 库与磁盘一致：该落点只有一行，且这行是新登记
    const rows = result.rows.filter((row) => row.local_path === 'task-1/report.md');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(result.revived.id);
    expect(rows[0].size).toBe('second-pass'.length);
  });
});
