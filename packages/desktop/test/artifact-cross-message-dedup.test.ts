import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildElectronProbe, runElectronProbe, type ElectronProbe } from './helpers/electron-probe.js';

/**
 * ⭐ T20（2026-10-16 本地全量执行 · Owner D）：**跨 assistant 消息的同源去重**。
 *
 * 现场线索：`finish_reason` 续写会创建新的 assistant 消息（新 messageId）。若同一套牌
 * 在两条消息里各出现一次，登记的**两条唯一约束都不触发**：
 *   · `artifacts_source_dedup(message_id, source_key)` ⇒ message_id 不同；
 *   · `artifacts_task_local_path(task_id, root, local_path)` ⇒ `uniqueFileNameIn` 只看磁盘，
 *     第一份文件还在 ⇒ 第二份退到带随机后缀的名字 ⇒ local_path 不同。
 * ⇒ 同一套牌被登记两次、落两份文件（用户成果列表里出现两份重复的"季度汇报.pptx"）。
 *
 * 本档跑在真 SQLite + 真文件系统（`ELECTRON_RUN_AS_NODE` 的 electron）。
 */

const probePath = fileURLToPath(new URL('./helpers/artifact-save-probe.ts', import.meta.url));
const packageDir = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const privateProbeRoot = process.env.CLAW_ARTIFACT_PROBE_ROOT;

interface CrossMessageProbeResult {
  first: { id: string; name: string };
  continuation: { id: string; name: string };
  rows: Array<{ id: string; name: string; local_path: string; message_id: string; source_key: string }>;
  files: string[];
  rowCount: number;
  fileCount: number;
  revised: { id: string; name: string };
  filesAfterRevised: string[];
}

let electronProbe: ElectronProbe;
let workspacePath: string;
let result: CrossMessageProbeResult;

beforeAll(async () => {
  electronProbe = await buildElectronProbe({ probePath, packageDir, privateProbeRoot });
  workspacePath = mkdtempSync(join(privateProbeRoot ?? tmpdir(), 'clawwork-artifact-xmsg-'));
  result = runElectronProbe({
    compiledProbePath: electronProbe.compiledProbePath,
    packageDir,
    workspacePath,
    scenario: 'save-cross-message-replay',
    privateProbeRoot,
  }) as unknown as CrossMessageProbeResult;
}, 60_000);

afterAll(() => {
  electronProbe.cleanup();
  rmSync(workspacePath, { recursive: true, force: true });
});

describe('⭐ T20 · 跨消息同源去重（真 SQLite + 真文件系统）', () => {
  it('⭐ 同 task 同 sourceKey、不同 messageId（续写）⇒ 只登记一行、只落一份文件', () => {
    // 反例：旧实现给出 2 行 / 2 文件（重复登记）。
    expect(result.rowCount).toBe(1);
    expect(result.fileCount).toBe(1);
    expect(result.continuation.id).toBe(result.first.id);
    expect(result.continuation.name).toBe(result.first.name);
    expect(result.files).toEqual([result.first.name]);
    const names = result.rows.map((row) => row.name);
    expect(new Set(names).size).toBe(1);
  });

  it('⭐ 保护面：同 task **不同 sourceKey**（改稿）⇒ 照常产新版（跨消息去重不误伤）', () => {
    expect(result.revised.id).not.toBe(result.first.id);
    expect(result.revised.name).not.toBe(result.first.name);
    expect(result.filesAfterRevised.length).toBe(2);
  });
});
