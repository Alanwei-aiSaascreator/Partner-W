import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepairItemReport, RepairScanReport } from '@clawwork/shared';

/**
 * T31 · 缺口 2（`--repair` 完全不碰 `managedSkillsDir` ⇒ 没有"修复 → 换网关"通路）
 *      + 缺口 3 的修复侧（技能账按 `managedSkillsDir` 做键 ⇒ 键一变就孤儿化）。
 *
 * 测的是**真引擎**（`createRepairSession`），只把技能账读写面与"盘上有没有这个路径"
 * 经真实文件系统接上 —— 不是桩出来的假绿。
 */
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '') },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    decryptString: vi.fn((buffer: Buffer) => buffer.toString()),
  },
}));

const { createRepairSession } = await import('../src/main/repair/engine.js');
const { resolveRepairTargets } = await import('../src/main/repair/targets.js');

const FIXED_NOW = new Date(2026, 9, 16, 10, 11, 12);
const RECORD = `pkg2:${JSON.stringify({ version: 2, packageSha: 'a'.repeat(64), files: { 'SKILL.md': 'b'.repeat(64) } })}`;

interface Fixture {
  root: string;
  volumeRoot: string;
  dataRoot: string;
  logsRoot: string;
  stateRoot: string;
  stateDir: string;
  skillsDir: string;
  configPath: string;
}

let fixture: Fixture;
let records: Record<string, Record<string, string>>;
let writes: number;

function makeFixture(stateDirs: number): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'partner-w-skill-records-'));
  const volumeRoot = path.join(root, 'V');
  const dataRoot = path.join(volumeRoot, 'Partner-W-运行数据');
  const stateRoot = path.join(dataRoot, 'state');
  const stateDir = path.join(stateRoot, '0123456789abcdef01234567');
  fs.mkdirSync(path.join(stateDir, 'tmp', 'openclaw'), { recursive: true });
  for (let index = 1; index < stateDirs; index += 1) {
    fs.mkdirSync(path.join(stateRoot, `second-${index}`, 'tmp', 'openclaw'), { recursive: true });
  }
  fs.mkdirSync(path.join(dataRoot, 'logs'), { recursive: true });
  const configPath = path.join(dataRoot, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ bundledSkillRecords: {} }), 'utf8');
  return {
    root,
    volumeRoot,
    dataRoot,
    logsRoot: path.join(dataRoot, 'logs'),
    stateRoot,
    stateDir,
    skillsDir: path.join(stateDir, 'skills'),
    configPath,
  };
}

function session(over: { stateDirs?: number; live?: boolean; injectRecords?: boolean } = {}) {
  const targets = resolveRepairTargets({
    userDataDir: fixture.dataRoot,
    programDir: path.join(fixture.volumeRoot, 'Partner-W'),
    portableRoots: {
      volumeRoot: fixture.volumeRoot,
      programDir: path.join(fixture.volumeRoot, 'Partner-W'),
      dataRoot: fixture.dataRoot,
      stateRoot: fixture.stateRoot,
      workspaceRoot: path.join(fixture.volumeRoot, 'Partner-W工作区'),
      logsRoot: fixture.logsRoot,
    },
  });
  return createRepairSession({
    targets,
    appVersion: '1.0.8-test',
    bundledRuntimeRoot: null,
    isPackaged: true,
    now: () => FIXED_NOW,
    liveInstance: {
      ownerAlive: () => (over.live ? { alive: true, pid: 4242 } : null),
      portListener: () => null,
    },
    ...(over.injectRecords === false
      ? {}
      : {
          skillRecords: {
            read: () => ({ records, configPath: fixture.configPath }),
            write: (next: Record<string, Record<string, string>>) => {
              writes += 1;
              records = next;
              fs.writeFileSync(fixture.configPath, JSON.stringify({ bundledSkillRecords: next }), 'utf8');
              return true;
            },
          },
        }),
  });
}

function itemOf(report: RepairScanReport, id: RepairItemReport['id']): RepairItemReport {
  const found = report.items.find((item) => item.id === id);
  if (!found) throw new Error(`missing item ${id}`);
  return found;
}

/** 整棵树的内容快照（证明"全检零修改"）。 */
function treeSnapshot(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        out.push(`D ${relative}`);
        visit(absolute);
      } else {
        out.push(`F ${relative} ${fs.statSync(absolute).size}`);
      }
    }
  };
  visit(root);
  return out;
}

/** 一个"已经不在盘上"的旧托管目录。 */
function staleKey(name: string): string {
  return path.join(fixture.dataRoot, 'gone', name, 'skills');
}

beforeEach(() => {
  fixture = makeFixture(1);
  records = {};
  writes = 0;
});

afterEach(() => {
  if (fixture.root.startsWith(path.join(os.tmpdir(), 'partner-w-skill-records-'))) {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

describe('修复项 · 技能安装记录（T31 缺口 2/3）', () => {
  it('孤儿账（旧键目录已不在盘上）⇒ 出动作；apply 把账迁到当前遥控目录并保留备份', () => {
    fs.mkdirSync(path.join(fixture.skillsDir, 'copy-variants'), { recursive: true });
    records = { [staleKey('old-gateway')]: { 'copy-variants': RECORD } };

    const repair = session();
    const report = repair.scan();
    const item = itemOf(report, 'skill-records');

    expect(item.severity).toBe('attention');
    expect(item.actions.map((action) => action.actionId)).toEqual(['skill-records:migrate']);
    expect(item.actions[0]?.params).toMatchObject({ path: fixture.skillsDir, count: 1 });

    const result = repair.apply(['skill-records:migrate']);

    expect(result.outcomes[0]?.status).toBe('applied');
    expect(result.outcomes[0]?.message.code).toBe('apply.skill-migrated');
    // 改的是配置文件 ⇒ 必须先备份（SPEC 三·1）
    expect(result.outcomes[0]?.backupPath).not.toBeNull();
    expect(result.backupDir).not.toBeNull();

    expect(Object.keys(records)).toEqual([fixture.skillsDir]);
    expect(records[fixture.skillsDir]).toEqual({ 'copy-variants': RECORD });
  });

  it('迁完再扫 ⇒ 零动作（幂等；开机每次都会扫）', () => {
    fs.mkdirSync(path.join(fixture.skillsDir, 'copy-variants'), { recursive: true });
    records = { [staleKey('old-gateway')]: { 'copy-variants': RECORD } };
    const repair = session();
    repair.apply(
      repair
        .scan()
        .items.flatMap((item) => item.actions)
        .map((action) => action.actionId),
    );

    const second = repair.scan();

    expect(itemOf(second, 'skill-records').actions).toEqual([]);
    expect(itemOf(second, 'skill-records').severity).toBe('ok');
  });

  it('⭐ 健康盘（账已经在当前键）⇒ 全检零修改：没有动作、一个字节都不写', () => {
    records = { [fixture.skillsDir]: { 'copy-variants': RECORD } };
    const before = treeSnapshot(fixture.root);

    const repair = session();
    const report = repair.scan();

    expect(itemOf(report, 'skill-records').actions).toEqual([]);
    expect(itemOf(report, 'skill-records').severity).toBe('ok');
    expect(treeSnapshot(fixture.root)).toEqual(before);
    expect(writes).toBe(0);
  });

  it('旧键的目录**还在盘上** ⇒ 不认它是孤儿（可能只是这次没连上的另一套 state）', () => {
    const live = path.join(fixture.dataRoot, 'other', 'skills');
    fs.mkdirSync(live, { recursive: true });
    records = { [live]: { 'copy-variants': RECORD } };

    const report = session().scan();

    expect(itemOf(report, 'skill-records').actions).toEqual([]);
    expect(itemOf(report, 'skill-records').severity).toBe('ok');
  });

  it('多个 state 目录且无法判定当前项 ⇒ blocked，账原样不动', () => {
    fixture = makeFixture(3);
    const stale = staleKey('old-gateway');
    records = { [stale]: { 'copy-variants': RECORD } };

    const repair = session();
    const report = repair.scan();
    const item = itemOf(report, 'skill-records');

    expect(item.severity).toBe('blocked');
    expect(item.actions).toEqual([]);
    expect(item.blocked.map((entry) => entry.code)).toEqual(['skill.ambiguous']);
    expect(repair.apply(['skill-records:migrate']).outcomes).toEqual([]);
    expect(records).toEqual({ [stale]: { 'copy-variants': RECORD } });
  });

  it('一个状态目录都没扫到 ⇒ skipped（不猜当前托管目录在哪）', () => {
    fixture = makeFixture(0);
    records = { [staleKey('old-gateway')]: { 'copy-variants': RECORD } };
    // 沙盒里没有 state 目录可发现（tmp/openclaw 没建）
    fs.rmSync(path.join(fixture.stateDir, 'tmp'), { recursive: true, force: true });

    const report = session().scan();

    const item = itemOf(report, 'skill-records');
    expect(item.skipped.map((entry) => entry.code)).toEqual(['skill.no-state']);
    expect(item.actions).toEqual([]);
  });

  it('没接技能账读写面 ⇒ 如实说"这一项没跑"，不当成"没问题"', () => {
    const report = session({ injectRecords: false }).scan();
    const item = itemOf(report, 'skill-records');
    expect(item.severity).toBe('blocked');
    expect(item.skipped.map((entry) => entry.code)).toEqual(['skill.no-access']);
  });

  it('本机有一份在跑 ⇒ 迁移动作被 skipped，账一个字节不动', () => {
    fs.mkdirSync(path.join(fixture.skillsDir, 'copy-variants'), { recursive: true });
    const stale = staleKey('old-gateway');
    records = { [stale]: { 'copy-variants': RECORD } };

    const repair = session({ live: true });
    const report = repair.scan();
    expect(report.liveInstance).not.toBeNull();

    const result = repair.apply(['skill-records:migrate']);

    expect(result.outcomes[0]?.status).toBe('skipped');
    expect(records).toEqual({ [stale]: { 'copy-variants': RECORD } });
    expect(writes).toBe(0);
  });
});
