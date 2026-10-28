import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T31 · 缺口 1：`repair/backup.ts` 只写不读（`index.json` 没有消费者、没有 `restore()`）。
 *
 * ⚠️ `engine.ts` 经 `items/plugin-paths.ts` 拉进 `electron`（同 `repair-engine.test.ts` 的手法），
 *    纯函数那一半其实不需要这个 mock，这里给整个文件装上只是为了让 import 链成立。
 */
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '') },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    decryptString: vi.fn((buffer: Buffer) => buffer.toString()),
  },
}));

const { RepairBackup, readRepairBackupIndex, restoreRepairBackup } = await import('../src/main/repair/backup.js');
const { createRepairSession } = await import('../src/main/repair/engine.js');
const { appOwnedRoots, isPathWithinAnyRoot, resolveRepairTargets } = await import('../src/main/repair/targets.js');

let root: string;

/**
 * 纯函数那一半只测"写回"这件事本身：目标白名单在这里放开。
 * ⚠️ 生产路径**不允许**这样调 —— `isAllowedTarget` 是必填的（见下面那个 describe 的反例）。
 */
const ALLOW_ALL = { isAllowedTarget: () => true };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'partner-w-restore-test-'));
});

afterEach(() => {
  if (root.startsWith(path.join(os.tmpdir(), 'partner-w-restore-test-'))) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * 造一轮真实的备份（复用生产那条 `RepairBackup`，不是手搓 index.json）。
 *
 * ⚠️ `base` 是**原文件落在哪个根下** —— 它决定还原时那条目标能不能过 `appOwnedRoots()`
 *    白名单。纯函数那一半（`ALLOW_ALL`）用默认的 `<root>/originals`；引擎那一半必须把
 *    原文件放进**真实会被备份的根**（`stateDir` / `workspaceRoot`），否则测的就是假失败。
 */
function makeRound(
  files: Record<string, string>,
  base = path.join(root, 'originals'),
): { dir: string; logsRoot: string } {
  const logsRoot = path.join(root, 'logs');
  const backup = new RepairBackup(logsRoot, '20261016T101112');
  for (const [name, content] of Object.entries(files)) {
    const original = path.join(base, name);
    fs.mkdirSync(path.dirname(original), { recursive: true });
    fs.writeFileSync(original, content, 'utf8');
    expect(backup.backupFile(original)).not.toBeNull();
  }
  return { dir: backup.dir, logsRoot };
}

function original(name: string, base = path.join(root, 'originals')): string {
  return path.join(base, name);
}

/** 一轮备份里放**多个根下**的文件（`makeRound` 的 base 单一，这个按绝对路径收）。 */
function makeRoundOf(specs: Array<{ path: string; content: string }>): { dir: string } {
  const backup = new RepairBackup(path.join(root, 'logs'), '20261016T101112');
  for (const { path: filePath, content } of specs) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    expect(backup.backupFile(filePath)).not.toBeNull();
  }
  return { dir: backup.dir };
}

describe('修复备份 · 索引与还原（T31 缺口 1）', () => {
  it('把备份写回原路径（原文件被改过 ⇒ 还原成备份那一刻的字节）', () => {
    const { dir } = makeRound({ 'a.txt': 'V1', 'nested/b.txt': 'B1' });
    fs.writeFileSync(original('a.txt'), 'V2-USER-EDIT', 'utf8');
    fs.rmSync(original('nested/b.txt'));

    const report = restoreRepairBackup(dir, ALLOW_ALL);

    expect(report.indexMissing).toBe(false);
    expect(report.total).toBe(2);
    expect(report.restored.length).toBe(2);
    expect(report.failed).toEqual([]);
    expect(report.refused).toEqual([]);
    expect(fs.readFileSync(original('a.txt'), 'utf8')).toBe('V1');
    // 原文件被删掉 ⇒ 还原要把它**重新建出来**（连父目录）
    expect(fs.readFileSync(original('nested/b.txt'), 'utf8')).toBe('B1');
  });

  it('索引里的备份副本已经不在了 ⇒ 如实进 missing，不当成功', () => {
    const { dir } = makeRound({ 'a.txt': 'V1', 'b.txt': 'B1' });
    const index = readRepairBackupIndex(dir)!;
    const gone = Object.keys(index).find((name) => index[name] === original('b.txt'))!;
    fs.rmSync(path.join(dir, gone));

    const report = restoreRepairBackup(dir, ALLOW_ALL);

    expect(report.total).toBe(2);
    expect(report.restored.length).toBe(1);
    expect(report.missing).toEqual([original('b.txt')]);
  });

  it('原路径现在**不是普通文件**（目录 / 链接）⇒ 拒绝覆盖，进 refused', () => {
    const { dir } = makeRound({ 'a.txt': 'V1' });
    fs.rmSync(original('a.txt'));
    fs.mkdirSync(original('a.txt'));

    const report = restoreRepairBackup(dir, ALLOW_ALL);

    expect(report.restored).toEqual([]);
    expect(report.refused).toEqual([original('a.txt')]);
    expect(fs.statSync(original('a.txt')).isDirectory()).toBe(true);
  });

  it('没有 index.json 的目录 ⇒ indexMissing（不是"还原了 0 个"）', () => {
    const report = restoreRepairBackup(path.join(root, 'not-a-backup'), ALLOW_ALL);
    expect(report.indexMissing).toBe(true);
    expect(report.total).toBe(0);
    expect(report.restored).toEqual([]);
  });

  it('索引里的**相对路径**一律不认（索引是盘上的不可信输入）', () => {
    const { dir } = makeRound({ 'a.txt': 'V1' });
    const realName = Object.keys(readRepairBackupIndex(dir)!)[0]!;
    fs.writeFileSync(
      path.join(dir, 'index.json'),
      JSON.stringify({ [realName]: original('a.txt'), 'deadbeef-a.txt': 'relative/escape.txt' }),
      'utf8',
    );

    const report = restoreRepairBackup(dir, ALLOW_ALL);

    expect(report.total).toBe(1);
    expect(report.restored).toEqual([original('a.txt')]);
  });
});

describe('修复引擎 · restore()（T31 缺口 1 的真实消费者）', () => {
  const dataRootOf = (): string => path.join(root, 'Partner-W-运行数据');
  const workspaceRootOf = (): string => path.join(root, 'Partner-W工作区');
  const programDirOf = (): string => path.join(root, 'Partner-W');
  const stateDirOf = (): string => path.join(dataRootOf(), 'state', '0123456789abcdef01234567');

  function session(live: { alive: boolean; pid: number } | null) {
    // 整棵临时树就是"那块交付盘"⇒ `root` = volumeRoot，`dataRoot`/`workspaceRoot` 是它的子目录。
    const volumeRoot = root;
    const dataRoot = dataRootOf();
    const stateRoot = path.join(dataRoot, 'state');
    const stateDir = stateDirOf();
    fs.mkdirSync(path.join(stateDir, 'tmp', 'openclaw'), { recursive: true });
    fs.mkdirSync(path.join(dataRoot, 'logs'), { recursive: true });
    return createRepairSession({
      targets: resolveRepairTargets({
        userDataDir: dataRoot,
        programDir: programDirOf(),
        portableRoots: {
          volumeRoot,
          programDir: programDirOf(),
          dataRoot,
          stateRoot,
          workspaceRoot: workspaceRootOf(),
          logsRoot: path.join(dataRoot, 'logs'),
        },
      }),
      appVersion: '1.0.8-test',
      bundledRuntimeRoot: null,
      isPackaged: true,
      now: () => new Date(2026, 9, 16, 10, 11, 12),
      liveInstance: { ownerAlive: () => live, portListener: () => null },
    });
  }

  it('本机有一份在跑 ⇒ 还原一律拒绝（与 apply 同一条纪律），一个字节都不写', () => {
    const base = stateDirOf();
    const { dir } = makeRound({ 'openclaw.json': 'V1' }, base);
    fs.writeFileSync(original('openclaw.json', base), 'V2-USER-EDIT', 'utf8');
    const repair = session({ alive: true, pid: 4242 });
    repair.scan();

    const result = repair.restore(dir);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('blocked-live-instance');
    expect(fs.readFileSync(original('openclaw.json', base), 'utf8')).toBe('V2-USER-EDIT');
  });

  it('没人占用 ⇒ 还原这一轮的备份并如实报数', () => {
    const base = stateDirOf();
    const { dir } = makeRound({ 'openclaw.json': 'V1', 'nested/extra.json': 'B1' }, base);
    fs.writeFileSync(original('openclaw.json', base), 'V2-USER-EDIT', 'utf8');
    fs.rmSync(original('nested/extra.json', base));
    const repair = session(null);
    repair.scan();

    const result = repair.restore(dir);

    expect(result.ok).toBe(true);
    expect(result.reason).toBe('restored');
    expect(result.restored).toBe(2);
    expect(fs.readFileSync(original('openclaw.json', base), 'utf8')).toBe('V1');
    // 原文件被删掉 ⇒ 还原要把它**重新建出来**（连父目录）
    expect(fs.readFileSync(original('nested/extra.json', base), 'utf8')).toBe('B1');
  });

  it('⭐ 反例①：索引里塞一条**盘根下的越界绝对路径** ⇒ refused，那个路径一个字节都没被写', () => {
    // 收窄前 `volumeRoot`（= 整块盘根）在名单里 ⇒ 这些路径会被放行（任意文件覆写）。
    const base = stateDirOf();
    const { dir } = makeRound({ 'openclaw.json': 'V1' }, base);
    const realName = Object.keys(readRepairBackupIndex(dir)!)[0]!;

    // 三条越界目标：① 盘根下的既有文件 ② 盘根下的新文件 ③ 程序目录（`programDir`，同样被收掉）
    const victimAtVolumeRoot = path.join(root, '越界-用户文档.txt');
    const absentAtVolumeRoot = path.join(root, '越界-新文件.txt');
    const victimInProgramDir = path.join(programDirOf(), '越界-安装目录文件.txt');
    fs.writeFileSync(victimAtVolumeRoot, 'UNTOUCHED', 'utf8');
    fs.mkdirSync(path.dirname(victimInProgramDir), { recursive: true });
    fs.writeFileSync(victimInProgramDir, 'UNTOUCHED', 'utf8');
    for (const name of ['deadbeef-v.txt', 'deadbeef-a.txt', 'deadbeef-p.txt']) {
      fs.copyFileSync(original('openclaw.json', base), path.join(dir, name));
    }
    fs.writeFileSync(
      path.join(dir, 'index.json'),
      JSON.stringify({
        [realName]: original('openclaw.json', base),
        'deadbeef-v.txt': victimAtVolumeRoot,
        'deadbeef-a.txt': absentAtVolumeRoot,
        'deadbeef-p.txt': victimInProgramDir,
      }),
      'utf8',
    );

    const repair = session(null);
    repair.scan();
    const result = repair.restore(dir);

    // 三条越界目标全被挡（不管原路径存不存在 —— 挡的是**目标白名单**，不是"副本缺失"）
    expect(result.refused).toBe(3);
    expect(result.restored).toBe(1);
    // 而且**一个字节都没被写**：既有文件原样、新文件根本没被创建
    expect(fs.readFileSync(victimAtVolumeRoot, 'utf8')).toBe('UNTOUCHED');
    expect(fs.readFileSync(victimInProgramDir, 'utf8')).toBe('UNTOUCHED');
    expect(fs.existsSync(absentAtVolumeRoot)).toBe(false);
  });

  it('⭐ 反例①（附）：索引里塞一条**应用之外的绝对路径** ⇒ refused，那个路径一个字节都没被写', () => {
    // 用另一个临时目录冒充"系统目录"（绝不真碰 System32）
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'partner-w-outside-'));
    const victim = path.join(outside, 'victim.txt');
    const absent = path.join(outside, 'never-created.txt');
    try {
      const base = stateDirOf();
      const { dir } = makeRound({ 'openclaw.json': 'V1' }, base);
      const realName = Object.keys(readRepairBackupIndex(dir)!)[0]!;
      fs.copyFileSync(original('openclaw.json', base), path.join(dir, 'deadbeef-victim.txt'));
      fs.copyFileSync(original('openclaw.json', base), path.join(dir, 'deadbeef-absent.txt'));
      fs.writeFileSync(victim, 'UNTOUCHED', 'utf8');
      fs.writeFileSync(
        path.join(dir, 'index.json'),
        JSON.stringify({
          [realName]: original('openclaw.json', base),
          'deadbeef-victim.txt': victim,
          'deadbeef-absent.txt': absent,
        }),
        'utf8',
      );

      const repair = session(null);
      repair.scan();
      const result = repair.restore(dir);

      expect(result.refused).toBe(2);
      expect(result.restored).toBe(1);
      expect(fs.readFileSync(victim, 'utf8')).toBe('UNTOUCHED');
      expect(fs.existsSync(absent)).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('⭐ 反例②：真实备份点（state 目录 / 助手工作区）照常还原 —— 防"收窄过头"的假失败', () => {
    // 两类真实落点各一条：state 目录里的配置、主助手 workspace 里的 AGENTS.md。
    const stateBase = stateDirOf();
    const wsBase = workspaceRootOf();
    const stateFile = original('openclaw.json', stateBase);
    const wsFile = original('AGENTS.md', wsBase);
    const round = makeRoundOf([
      { path: stateFile, content: 'CFG-V1' },
      { path: wsFile, content: 'BLOCK-V1' },
    ]);
    fs.writeFileSync(stateFile, 'CFG-V2-USER', 'utf8');
    fs.writeFileSync(wsFile, 'BLOCK-V2', 'utf8');

    const repair = session(null);
    repair.scan();
    const result = repair.restore(round.dir);

    // 两条都必成（收窄不许误伤真实备份点）
    expect(result.ok).toBe(true);
    expect(result.restored).toBe(2);
    expect(fs.readFileSync(stateFile, 'utf8')).toBe('CFG-V1');
    expect(fs.readFileSync(wsFile, 'utf8')).toBe('BLOCK-V1');
  });
});

describe('修复 · appOwnedRoots 收窄（T31 安全边界 · reveal 与 restore 共用的同一份判据）', () => {
  it('只列真实备份点 + 备份目录根；不含 volumeRoot（整盘根）与 programDir', () => {
    const volumeRoot = root;
    const dataRoot = path.join(volumeRoot, 'Partner-W-运行数据');
    const stateRoot = path.join(dataRoot, 'state');
    const stateDir = path.join(stateRoot, '0123456789abcdef01234567');
    const workspaceRoot = path.join(volumeRoot, 'Partner-W工作区');
    const logsRoot = path.join(dataRoot, 'logs');
    const programDir = path.join(volumeRoot, 'Partner-W');
    fs.mkdirSync(path.join(stateDir, 'tmp', 'openclaw'), { recursive: true });

    const targets = resolveRepairTargets({
      userDataDir: dataRoot,
      programDir,
      portableRoots: { volumeRoot, programDir, dataRoot, stateRoot, workspaceRoot, logsRoot },
    });
    const roots = appOwnedRoots(targets);
    const allowed = (candidate: string): boolean => isPathWithinAnyRoot(candidate, roots);

    // 保留：真实备份落点 + 备份目录的家
    expect(roots).toContain(dataRoot);
    expect(roots).toContain(workspaceRoot);
    expect(roots).toContain(stateDir);
    expect(roots).toContain(logsRoot);
    // 收掉：整盘根（任意文件覆写面）与程序目录
    expect(roots).not.toContain(volumeRoot);
    expect(roots).not.toContain(programDir);

    // 真实还原目标 / reveal 目标（备份目录）都仍被放行
    expect(allowed(path.join(stateDir, 'openclaw.json'))).toBe(true);
    expect(allowed(path.join(workspaceRoot, 'AGENTS.md'))).toBe(true);
    expect(allowed(path.join(logsRoot, 'repair-20261016T101112'))).toBe(true);
    // 盘根下 / 程序目录下的任意位置一律拒绝
    expect(allowed(path.join(volumeRoot, '任意文档.txt'))).toBe(false);
    expect(allowed(path.join(programDir, '任意文件.txt'))).toBe(false);
  });
});

/**
 * 2026-10-17 统一审核 §T33（第一件）：**本机安装形态**（`portableRoots: null` ⇒
 * `workspaceRoot = null`）下，主助手 `AGENTS.md` 的落点是否仍在保留根内。
 *
 * 收据（实测）：本机安装形态下 `openclaw.json` 的
 * `agents.entries.main.workspace` = **`<stateDir>/workspace`**（真值见
 * `C:\Users\digua\AppData\Roaming\@clawwork\desktop\openclaw-state\openclaw.json`），
 * 而 `stateDir = <userData>/openclaw-state`、`dataRoot = userData` ⇒ 主助手工作区
 * **⊆ dataRoot**（保留根内）。这两条用例把它钉死，防将来回归成"合法 AGENTS.md 还原被误拒"。
 */
describe('修复 · 本机安装形态（workspaceRoot=null）· 主助手 workspace 落在保留根内', () => {
  const programDirLocal = (): string => path.join(root, 'Program Files', 'Partner-W');
  const userDataLocal = (): string => path.join(root, 'AppData', '@clawwork', 'desktop');
  const stateDirLocal = (): string => path.join(userDataLocal(), 'openclaw-state');
  /** 与实测一致：主助手工作区 = `<stateDir>/workspace`（运行时默认值就是它）。 */
  const mainWorkspaceLocal = (): string => path.join(stateDirLocal(), 'workspace');

  function localTargets() {
    fs.mkdirSync(stateDirLocal(), { recursive: true });
    if (!fs.existsSync(path.join(stateDirLocal(), 'openclaw.json'))) {
      fs.writeFileSync(
        path.join(stateDirLocal(), 'openclaw.json'),
        JSON.stringify({ agents: { entries: { main: { workspace: mainWorkspaceLocal() } } } }),
        'utf8',
      );
    }
    // 本机安装形态：**没有** portableRoots。
    return resolveRepairTargets({ userDataDir: userDataLocal(), programDir: programDirLocal(), portableRoots: null });
  }

  it('appOwnedRoots 含主助手 workspace（= <stateDir>/workspace ⊆ dataRoot）；不含盘根 / 程序目录', () => {
    const targets = localTargets();
    expect(targets.portable).toBe(false);
    expect(targets.workspaceRoot).toBeNull(); // 本机形态没有独立的 workspaceRoot
    expect(targets.dataRoot).toBe(userDataLocal());
    const roots = appOwnedRoots(targets);
    expect(roots).toContain(userDataLocal());
    expect(roots).not.toContain(root); // 系统盘根不在（收窄保留）
    expect(roots).not.toContain(programDirLocal());
    // ⭐ 主助手 AGENTS.md 的落点在保留根内 ⇒ 不会被误拒。
    expect(isPathWithinAnyRoot(path.join(mainWorkspaceLocal(), 'AGENTS.md'), roots)).toBe(true);
  });

  it('⭐ 真实备份点（主助手 AGENTS.md）在本机安装形态下照常还原（防"收窄过头"假失败）', () => {
    const wsFile = path.join(mainWorkspaceLocal(), 'AGENTS.md');
    const round = makeRoundOf([{ path: wsFile, content: 'BLOCK-V1' }]);
    fs.writeFileSync(wsFile, 'BLOCK-V2-USER', 'utf8');
    const repair = createRepairSession({
      targets: localTargets(),
      appVersion: '1.0.8-test',
      bundledRuntimeRoot: null,
      isPackaged: true,
      now: () => new Date(2026, 9, 16, 10, 11, 12),
      liveInstance: { ownerAlive: () => null, portListener: () => null },
    });
    repair.scan();

    const result = repair.restore(round.dir);

    expect(result.ok).toBe(true);
    expect(result.restored).toBe(1);
    expect(result.refused).toBe(0);
    expect(fs.readFileSync(wsFile, 'utf8')).toBe('BLOCK-V1');
  });
});
