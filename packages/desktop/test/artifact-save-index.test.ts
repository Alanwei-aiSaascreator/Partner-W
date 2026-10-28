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

/**
 * ⭐ BUG-058②（2026-10-13 计划 P2）：**源文件那条路**（`saveArtifact`）的同键重放。
 *
 * 为什么必须真索引 + 真文件系统：这一条的行为是"读源之前先只读重放探测"——
 * 源被删、目标缺/坏、异键、坏新源四种形状的正确性全落在**真实 fs 语义**上
 * （mock 里写不出来"源没了但目标还在"这种组合）。
 */
interface SourceReplayProbeResult {
  first: { id: string; name: string; localPath: string };
  replay: { id: string; name: string };
  filesAfterReplay: string[];
  replaySameBytes: boolean;
  rowsAfterReplay: Array<Record<string, unknown>>;
  foreignKey: { ok: boolean; name?: string };
  badNewSource: { ok: boolean; name?: string };
  afterBadNewSource: { rows: Array<Record<string, unknown>>; files: string[]; firstFileStillValid: boolean };
  targetMissing: { ok: boolean; name?: string };
  targetDamaged: { ok: boolean; name?: string };
  replayProbeDamaged: { id: string; name: string } | null;
  replayProbeIntact: { id: string; name: string } | null;
  replayProbeForeign: { id: string; name: string } | null;
  rowsAfterAll: Array<Record<string, unknown>>;
  filesFinal: string[];
}

describe('⭐ BUG-058② · 源已清理的同键重放（真 SQLite + 真文件系统，saveArtifact 本体）', () => {
  let electronProbe: ElectronProbe;
  let workspacePath: string;
  let result: SourceReplayProbeResult;

  beforeAll(async () => {
    electronProbe = await buildElectronProbe({ probePath, packageDir, privateProbeRoot });
    workspacePath = mkdtempSync(join(privateProbeRoot ?? tmpdir(), 'clawwork-artifact-source-replay-'));
    result = runElectronProbe({
      compiledProbePath: electronProbe.compiledProbePath,
      packageDir,
      workspacePath,
      scenario: 'save-source-replay',
      privateProbeRoot,
    }) as unknown as SourceReplayProbeResult;
  }, 60_000);

  afterAll(() => {
    electronProbe.cleanup();
    rmSync(workspacePath, { recursive: true, force: true });
  });

  it('⭐ 首次保存 → 删源 → 同键重放：返回同 id、单行、无复制（旧实现整轮 failed）', () => {
    expect(result.replay.id).toBe(result.first.id);
    expect(result.replay.name).toBe(result.first.name);
    // 只有一份文件，且一个字节都没被改写（重放没有复制任何东西）
    expect(result.filesAfterReplay).toEqual([result.first.name]);
    expect(result.replaySameBytes).toBe(true);
    // 库里也只有一行（没有第二次登记）
    expect(result.rowsAfterReplay).toHaveLength(1);
    expect(result.rowsAfterReplay[0]).toMatchObject({ id: result.first.id, source_key: 'docgen:pptx:hash-1' });
  });

  it('⭐ 异键不豁免：同 message、不同 sourceKey（源已删）⇒ 不返回既有行', () => {
    expect(result.foreignKey.ok).toBe(false);
    expect(result.foreignKey.name).toBe('ArtifactIntegrityError');
  });

  it('⭐ 坏新源不落盘、不删原有效行', () => {
    expect(result.badNewSource.ok).toBe(false);
    expect(result.badNewSource.name).toBe('ArtifactIntegrityError');
    // 原文件一个字节没动、没有多出文件、原行还在
    expect(result.afterBadNewSource.firstFileStillValid).toBe(true);
    expect(result.afterBadNewSource.files).toEqual([result.first.name]);
    expect(result.afterBadNewSource.rows).toHaveLength(1);
    expect(result.afterBadNewSource.rows[0]).toMatchObject({ id: result.first.id });
  });

  it('⭐ 目标也缺 / 目标被改坏（源仍缺）⇒ 如实失败，不伪成功、不重登记', () => {
    expect(result.targetMissing.ok).toBe(false);
    expect(result.targetMissing.name).toBe('ArtifactIntegrityError');
    expect(result.targetDamaged.ok).toBe(false);
    expect(result.targetDamaged.name).toBe('ArtifactIntegrityError');
    // 两次失败都没有留下"第二行/第二份文件"的痕迹
    expect(result.rowsAfterAll).toHaveLength(1);
    expect(result.rowsAfterAll[0]).toMatchObject({ id: result.first.id });
    expect(result.filesFinal).toEqual([result.first.name]);
  });

  it('⭐ findReplayArtifact（视频/付费路径花钱前的探测）同样只认"目标本体有效"', () => {
    // 目标坏 ⇒ null（存坏的 mp4 不许冒充"已交付"）
    expect(result.replayProbeDamaged).toBeNull();
    // 目标恢复有效 ⇒ 返回既有行（同 id）
    expect(result.replayProbeIntact).toEqual({ id: result.first.id, name: result.first.name });
    // 异键 ⇒ null（同 message 也不行）
    expect(result.replayProbeForeign).toBeNull();
  });
});
