import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepairItemReport, RepairScanReport } from '@clawwork/shared';

/**
 * ⚠️ `items/plugin-paths.ts` 复用 `runtime/state-config.ts` 的合并函数，而那一支
 *    经 `workspace/config.js` 拉进 `electron`。修复引擎本身不碰 electron，
 *    这个 mock 只是让 import 链在 node 环境里成立（同 `runtime-state-config.test.ts` 的手法）。
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
const { resolveRepairTargets, discoverStateDirs } = await import('../src/main/repair/targets.js');
const { capabilityBoundaryStartMarker, capabilityBoundaryEndMarker } = await import('@clawwork/core');
const { parseCentralDirectory } = await import('../src/main/runtime/zip.js');
const { buildZip, normalizeEntryName, toDosDateTime } = await import('../src/main/repair/zip-write.js');

const APP_VERSION = '1.0.8-repair-test';
const FIXED_NOW = new Date(2026, 9, 16, 10, 11, 12);

/** 一台"盘上运行"的假机器。 */
interface Fixture {
  root: string;
  volumeRoot: string;
  dataRoot: string;
  logsRoot: string;
  stateRoot: string;
  stateDir: string;
  workspaceRoot: string;
  agentWorkspace: string;
}

let fixture: Fixture;

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rongying-repair-test-'));
  const volumeRoot = path.join(root, 'V');
  const dataRoot = path.join(volumeRoot, '荣盈魔方-运行数据');
  const stateRoot = path.join(dataRoot, 'state');
  const stateDir = path.join(stateRoot, '0123456789abcdef01234567');
  const workspaceRoot = path.join(volumeRoot, '荣盈魔方工作区');
  const agentWorkspace = path.join(workspaceRoot, '默认助手');
  fs.mkdirSync(path.join(stateDir, 'tmp', 'openclaw'), { recursive: true });
  fs.mkdirSync(agentWorkspace, { recursive: true });
  fs.mkdirSync(path.join(dataRoot, 'logs'), { recursive: true });
  return {
    root,
    volumeRoot,
    dataRoot,
    logsRoot: path.join(dataRoot, 'logs'),
    stateRoot,
    stateDir,
    workspaceRoot,
    agentWorkspace,
  };
}

function targetsFor(f: Fixture) {
  return resolveRepairTargets({
    userDataDir: f.dataRoot,
    programDir: path.join(f.volumeRoot, '荣盈魔方'),
    portableRoots: {
      volumeRoot: f.volumeRoot,
      programDir: path.join(f.volumeRoot, '荣盈魔方'),
      dataRoot: f.dataRoot,
      stateRoot: f.stateRoot,
      workspaceRoot: f.workspaceRoot,
      logsRoot: f.logsRoot,
    },
  });
}

function writeConfig(config: Record<string, unknown>): void {
  fs.writeFileSync(path.join(fixture.stateDir, 'openclaw.json'), JSON.stringify(config, null, 2), 'utf8');
}

/** 假进程表：不在表里的 pid 一律"已退出"。 */
function fakeProbe(alive: Record<number, number | null>) {
  return {
    liveness: (pid: number): 'alive' | 'gone' | 'unknown' => (pid === 999999 ? 'unknown' : pid in alive ? 'alive' : 'gone'),
    startTime: (pid: number): number | null => (pid in alive ? (alive[pid] ?? null) : null),
  };
}

function session(over: Partial<Parameters<typeof createRepairSession>[0]> = {}) {
  return createRepairSession({
    targets: targetsFor(fixture),
    appVersion: APP_VERSION,
    bundledRuntimeRoot: null,
    isPackaged: false,
    now: () => FIXED_NOW,
    liveInstance: { ownerAlive: () => null, portListener: () => null },
    ...over,
  });
}

function itemOf(report: RepairScanReport, id: RepairItemReport['id']): RepairItemReport {
  const found = report.items.find((item) => item.id === id);
  if (!found) throw new Error(`missing item ${id}`);
  return found;
}

/** 整棵树的内容快照（用来证明"全检零修改"）。 */
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

beforeEach(() => {
  fixture = makeFixture();
  writeConfig({ gateway: { auth: { mode: 'token', token: 'x' } } });
});

afterEach(() => {
  if (fixture.root.startsWith(path.join(os.tmpdir(), 'rongying-repair-test-'))) {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

describe('修复引擎 · 活锁保护（SPEC 四）', () => {
  it('本机有一份在跑 ⇒ 会改文件的动作全部 skipped，且一个字节都不写', () => {
    fs.writeFileSync(path.join(fixture.stateDir, 'tmp', 'openclaw', 'gateway.deadbeef.lock'), '{ broken', 'utf8');
    const before = treeSnapshot(fixture.root);
    const repair = session({ liveInstance: { ownerAlive: () => ({ alive: true, pid: 4242 }), portListener: () => null } });
    const report = repair.scan();
    expect(report.liveInstance?.code).toBe('live.instance-owner');

    const durable = report.items
      .flatMap((item) => item.actions)
      .filter((action) => action.backup)
      .map((action) => action.actionId);
    expect(durable.length).toBeGreaterThan(0);
    const result = repair.apply(durable);
    expect(result.outcomes.every((outcome) => outcome.status === 'skipped')).toBe(true);
    expect(result.outcomes.every((outcome) => outcome.message.code === 'apply.blocked-live-instance')).toBe(true);
    expect(result.backupDir).toBeNull();
    expect(treeSnapshot(fixture.root)).toEqual(before);
  });

  it('活锁下**只**放行诊断包（只新建一个文件的白名单），且不改任何既有内容', () => {
    fs.writeFileSync(path.join(fixture.stateDir, 'tmp', 'openclaw', 'gateway.deadbeef.lock'), '{ broken', 'utf8');
    const repair = session({ liveInstance: { ownerAlive: () => null, portListener: () => 777 } });
    const report = repair.scan();
    const before = treeSnapshot(fixture.root);

    const result = repair.apply(['diagnostics-pack:export']);
    expect(result.outcomes[0]?.status).toBe('applied');
    // 唯一的磁盘变化 = 多了一个新的 zip + 一条修复记录（锁、配置一字未动）
    const after = treeSnapshot(fixture.root).filter(
      (line) => !line.includes('诊断包') && !line.includes('repair-20'),
    );
    expect(after).toEqual(before);
    expect(fs.existsSync(path.join(fixture.stateDir, 'tmp', 'openclaw', 'gateway.deadbeef.lock'))).toBe(true);
    expect(report.liveInstance?.code).toBe('live.port-listener');
  });

  it('18789 上有监听也算"在跑"', () => {
    const repair = session({ liveInstance: { ownerAlive: () => null, portListener: () => 777 } });
    expect(repair.scan().liveInstance?.code).toBe('live.port-listener');
  });

  it('扫到一把实锤在跑的网关锁也算"在跑"', () => {
    fs.writeFileSync(
      path.join(fixture.stateDir, 'tmp', 'openclaw', 'gateway.live.lock'),
      JSON.stringify({ pid: 100, startTime: 5_000 }),
      'utf8',
    );
    const repair = session({
      liveInstance: { ownerAlive: () => null, portListener: () => null },
      lockProbe: fakeProbe({ 100: 5_000 }),
    });
    expect(repair.scan().liveInstance?.code).toBe('live.gateway-lock');
  });
});

describe('修复项 #1 · 坏锁 / 半写锁', () => {
  const lockPath = (): string => path.join(fixture.stateDir, 'tmp', 'openclaw', 'gateway.abc.lock');

  it('RED→GREEN：非 JSON 的半写锁 → 扫描报 action → 执行后隔离、有备份；再跑一遍不再动任何东西', () => {
    fs.writeFileSync(lockPath(), '{"pid": 123, "owner', 'utf8');
    const repair = session({ lockProbe: fakeProbe({}) });

    const first = repair.scan();
    const locks = itemOf(first, 'gateway-locks');
    expect(locks.severity).toBe('attention');
    expect(locks.actions).toHaveLength(1);
    expect(locks.findings[0]?.code).toBe('lock.corrupt.not-json');

    const applied = repair.apply(locks.actions.map((action) => action.actionId));
    expect(applied.outcomes[0]?.status).toBe('applied');
    expect(fs.existsSync(lockPath())).toBe(false);
    const quarantined = fs
      .readdirSync(path.join(fixture.stateDir, 'tmp', 'openclaw'))
      .filter((name) => name.startsWith('gateway.abc.lock.corrupt-'));
    expect(quarantined).toHaveLength(1);
    // SPEC 二·1「保留现场」：隔离文件的内容逐字等于原锁
    expect(fs.readFileSync(path.join(fixture.stateDir, 'tmp', 'openclaw', quarantined[0] as string), 'utf8')).toBe(
      '{"pid": 123, "owner',
    );
    expect(applied.backupDir).not.toBeNull();
    expect(fs.existsSync(applied.logPath as string)).toBe(true);

    // 幂等：第二遍扫描没有动作，apply 也不留下第二个备份目录
    const second = session({ lockProbe: fakeProbe({}) });
    const again = second.scan();
    expect(itemOf(again, 'gateway-locks').actions).toHaveLength(0);
    expect(second.apply([locks.actions[0]?.actionId as string]).outcomes).toHaveLength(0);
    expect(
      fs.readdirSync(fixture.logsRoot).filter((name) => name.startsWith('repair-')),
    ).toHaveLength(1);
  });

  it('pid 已经不活着（死锁）→ 可隔离', () => {
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: 12345, startTime: 1 }), 'utf8');
    const repair = session({ lockProbe: fakeProbe({}) });
    const locks = itemOf(repair.scan(), 'gateway-locks');
    expect(locks.actions).toHaveLength(1);
    expect(locks.findings[0]?.code).toBe('lock.stale.pid-gone');
  });

  it('pid 活着但 startTime 对不上（pid 被复用）→ 判为死锁', () => {
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: 500, startTime: 1_000 }), 'utf8');
    const repair = session({ lockProbe: fakeProbe({ 500: 9_999_999 }) });
    expect(itemOf(repair.scan(), 'gateway-locks').findings[0]?.code).toBe('lock.stale.pid-reused');
  });

  it('真活锁（pid 在、startTime 对得上）→ 一个字都不动', () => {
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: 500, startTime: 1_000 }), 'utf8');
    const repair = session({
      liveInstance: { ownerAlive: () => null, portListener: () => null },
      lockProbe: fakeProbe({ 500: 1_000 }),
    });
    const locks = itemOf(repair.scan(), 'gateway-locks');
    expect(locks.actions).toHaveLength(0);
    expect(locks.findings[0]?.code).toBe('lock.live.start-time-match');
  });

  it('核验不了（锁里没有 startTime / pid 探不动）→ 保守当活锁', () => {
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: 999999 }), 'utf8');
    const repair = session({ lockProbe: fakeProbe({}) });
    const locks = itemOf(repair.scan(), 'gateway-locks');
    expect(locks.actions).toHaveLength(0);
    expect(locks.findings[0]?.code).toBe('lock.live.unverifiable');
  });

  it('⭐ junction/symlink 红线：锁是一个**链接**（或目录）时，拒绝改名，链接原样不动', () => {
    // 现场背景：state 目录在 Windows 上可能含 junction 指向真实 node_modules。
    // 对链接改名 = 把不属于我们的东西挪走 —— 所以写动作前一律先 lstat 查链接。
    const dirLink = path.join(fixture.stateDir, 'tmp', 'openclaw', 'gateway.junction.lock');
    fs.symlinkSync(fixture.agentWorkspace, dirLink, 'junction');
    const repair = session({ lockProbe: fakeProbe({}) });

    const locks = itemOf(repair.scan(), 'gateway-locks');
    expect(locks.actions.length).toBeGreaterThan(0);
    const applied = repair.apply(locks.actions.map((action) => action.actionId));
    expect(applied.outcomes[0]?.status).toBe('failed');
    expect(applied.outcomes[0]?.message.code).toBe('apply.unsafe-target-link');
    // 链接本身**原样还在**（没有被改名、没有被删）
    expect(fs.lstatSync(dirLink).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(dirLink)).toBe(fixture.agentWorkspace);
  });

  it('缺 pid 字段 → 判为坏锁', () => {
    fs.writeFileSync(lockPath(), JSON.stringify({ ownerId: 'x' }), 'utf8');
    const repair = session({ lockProbe: fakeProbe({}) });
    expect(itemOf(repair.scan(), 'gateway-locks').findings[0]?.code).toBe('lock.corrupt.bad-pid');
  });

  it('扫描与点击之间锁变成活锁 ⇒ 拒绝隔离（以当下盘面为准）', () => {
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: 12345, startTime: 1 }), 'utf8');
    const repair = session({ lockProbe: fakeProbe({}) });
    const action = itemOf(repair.scan(), 'gateway-locks').actions[0];
    // 扫描之后，"应用被打开了"：那把锁现在是活的
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: 500, startTime: 1_000 }), 'utf8');
    const live = session({
      liveInstance: { ownerAlive: () => null, portListener: () => null },
      lockProbe: fakeProbe({ 500: 1_000 }),
    });
    // 用新 session 重扫（它认得那把活锁），再用旧 actionId 执行
    const outcome = live.apply([action?.actionId as string]);
    expect(outcome.outcomes).toHaveLength(0);
    expect(fs.existsSync(lockPath())).toBe(true);
  });
});

describe('修复项 #2 · 失效插件路径（换盘符砖盘）', () => {
  it('RED→GREEN：历史盘符的死条目被剔掉、当前盘条目并进来', () => {
    const dead =
      'G:\\荣盈魔方-运行数据\\state\\aaa\\policies\\rongying-inbox-readonly';
    writeConfig({
      gateway: { auth: { mode: 'token', token: 'x' } },
      plugins: { load: { paths: [dead] }, entries: { 'rongying-inbox-readonly': { enabled: true } } },
    });

    const repair = session({ lockProbe: fakeProbe({}) });
    const plugins = itemOf(repair.scan(), 'plugin-paths');
    expect(plugins.severity).toBe('attention');
    expect(plugins.actions).toHaveLength(1);
    expect(plugins.findings[0]?.code).toBe('plugin.own-dead-path');

    const applied = repair.apply(plugins.actions.map((action) => action.actionId));
    expect(applied.outcomes[0]?.status).toBe('applied');

    const after = JSON.parse(fs.readFileSync(path.join(fixture.stateDir, 'openclaw.json'), 'utf8')) as {
      plugins: { load: { paths: string[] } };
    };
    expect(after.plugins.load.paths).not.toContain(dead);
    expect(after.plugins.load.paths.some((p) => p.startsWith(fixture.stateDir))).toBe(true);
    // 死条目指的那个目录真的被建出来了（否则就是把"死盘符"换成"还没建"，网关一样拒启）
    for (const p of after.plugins.load.paths) expect(fs.existsSync(p)).toBe(true);

    // 幂等：第二遍零动作
    const second = session({ lockProbe: fakeProbe({}) });
    expect(itemOf(second.scan(), 'plugin-paths').actions).toHaveLength(0);
  });

  it('不碰别人的死路径：只报告，不给动作', () => {
    writeConfig({
      gateway: { auth: { mode: 'token', token: 'x' } },
      plugins: { load: { paths: ['D:\\somewhere-else\\my-plugin'] } },
    });
    const repair = session({ lockProbe: fakeProbe({}) });
    const plugins = itemOf(repair.scan(), 'plugin-paths');
    expect(plugins.actions).toHaveLength(0);
    expect(plugins.blocked[0]?.code).toBe('plugin.foreign-dead-path');
    expect(plugins.severity).toBe('broken');
  });
});

describe('修复项 #3 · 提示词区块陈旧', () => {
  const agentFile = (): string => path.join(fixture.agentWorkspace, 'AGENTS.md');
  const withWorkspace = (): void => {
    writeConfig({
      gateway: { auth: { mode: 'token', token: 'x' } },
      agents: { entries: { main: { workspace: fixture.agentWorkspace } } },
    });
  };

  it('RED→GREEN：v0 陈旧区块 → 升级到当前版本，且区块外一字不动', () => {
    withWorkspace();
    const body = '# 我的笔记\n\n这段是用户自己写的。\n';
    const staleBlock = `<!-- mofang-capability-boundary:0:begin -->\nold\n<!-- mofang-capability-boundary:0:end -->\n`;
    fs.writeFileSync(agentFile(), `${body}${staleBlock}`, 'utf8');

    const repair = session({ lockProbe: fakeProbe({}) });
    const capability = itemOf(repair.scan(), 'capability-block');
    expect(capability.severity).toBe('attention');
    expect(capability.findings[0]?.code).toBe('capability.block-stale');

    const applied = repair.apply(capability.actions.map((action) => action.actionId));
    expect(applied.outcomes[0]?.status).toBe('applied');
    const after = fs.readFileSync(agentFile(), 'utf8');
    // 区块外一字不动（SPEC：不碰用户的东西）
    expect(after.startsWith(body)).toBe(true);
    expect(after).not.toContain('mofang-capability-boundary:0:begin');
    expect(after).toContain(capabilityBoundaryStartMarker().slice('<!-- '.length));
    expect(after.trimEnd().endsWith(capabilityBoundaryEndMarker())).toBe(true);

    // 幂等：第二遍零动作、零写盘
    const second = session({ lockProbe: fakeProbe({}) });
    expect(itemOf(second.scan(), 'capability-block').actions).toHaveLength(0);
  });

  it('标记只写了一半（半写）→ 判为坏区块', () => {
    withWorkspace();
    fs.writeFileSync(agentFile(), `<!-- mofang-capability-boundary:3:begin -->\nno end marker\n`, 'utf8');
    const repair = session({ lockProbe: fakeProbe({}) });
    expect(itemOf(repair.scan(), 'capability-block').findings[0]?.code).toBe('capability.block-corrupt');
  });

  it('区块版本比当前代码新 ⇒ 只报告，**不降级**', () => {
    withWorkspace();
    const newer = '<!-- mofang-capability-boundary:99:begin -->\nx\n<!-- mofang-capability-boundary:99:end -->\n';
    fs.writeFileSync(agentFile(), newer, 'utf8');
    const repair = session({ lockProbe: fakeProbe({}) });
    const capability = itemOf(repair.scan(), 'capability-block');
    expect(capability.actions).toHaveLength(0);
    expect(capability.findings[0]?.code).toBe('capability.block-newer');
    expect(capability.skipped[0]?.code).toBe('capability.no-downgrade');
  });

  it('压根没写过 AGENTS.md ⇒ skipped，不是"坏"', () => {
    withWorkspace();
    const repair = session({ lockProbe: fakeProbe({}) });
    const capability = itemOf(repair.scan(), 'capability-block');
    expect(capability.skipped[0]?.code).toBe('capability.no-file');
  });
});

describe('修复项 #4 · 运行环境自查（只报告）', () => {
  it('永不给动作，坏的地方进 blocked 指引', () => {
    const repair = session({ lockProbe: fakeProbe({}) });
    const environment = itemOf(repair.scan(), 'environment');
    expect(environment.actions).toHaveLength(0);
    expect(environment.findings.some((finding) => finding.code === 'env.data-root-writable')).toBe(true);
  });
});

describe('修复项 #5 · 诊断包', () => {
  it('导出的 zip 能被自家解析器读懂，且凭据被抹掉', () => {
    writeConfig({
      gateway: { auth: { mode: 'token', token: 'rly_supersecret_value_1234567890' } },
      relay: { apiKey: 'sk-should-not-leak-1234567890' },
    });
    fs.writeFileSync(path.join(fixture.logsRoot, 'app.log'), 'token "token":"rly_leakme_1234567890"\n', 'utf8');

    const repair = session({ lockProbe: fakeProbe({}) });
    repair.scan();
    const result = repair.exportDiagnostics();
    expect(result.ok).toBe(true);

    const zip = fs.readFileSync(result.path as string);
    const eocdOffset = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const cdSize = zip.readUInt32LE(eocdOffset + 12);
    const cdOffset = zip.readUInt32LE(eocdOffset + 16);
    const entries = parseCentralDirectory(zip.subarray(cdOffset, cdOffset + cdSize));
    const names = entries.map((entry) => entry.name);
    expect(names).toContain('meta.json');
    expect(names).toContain('scan.json');
    expect(names.some((name) => name.startsWith('state/'))).toBe(true);

    const text = zip.toString('utf8');
    expect(text).not.toContain('rly_supersecret_value_1234567890');
    expect(text).not.toContain('sk-should-not-leak-1234567890');
    expect(text).not.toContain('rly_leakme_1234567890');
    expect(text).toContain('<redacted>');
  });
});

describe('对照试验 · 无故障盘全检 = 全绿且零修改（SPEC 四）', () => {
  it('干净盘：除"诊断包待办"外零动作，且整棵树逐字不变', () => {
    writeConfig({
      gateway: { auth: { mode: 'token', token: 'x' } },
      agents: { entries: { main: { workspace: fixture.agentWorkspace } } },
    });
    const before = treeSnapshot(fixture.root);
    const repair = session({ lockProbe: fakeProbe({}) });
    const report = repair.scan();

    const durable = ['gateway-locks', 'plugin-paths', 'capability-block'] as const;
    for (const id of durable) expect(itemOf(report, id).actions).toHaveLength(0);
    expect(itemOf(report, 'environment').actions).toHaveLength(0);
    // 唯一允许存在的待办是"导出诊断包"（它不修改任何东西，只是新建一个包）
    expect(itemOf(report, 'diagnostics-pack').actions).toHaveLength(1);
    expect(treeSnapshot(fixture.root)).toEqual(before);
  });
});

describe('目录发现', () => {
  it('认"里面有 openclaw.json"的目录', () => {
    const empty = path.join(fixture.stateRoot, 'empty-identity');
    fs.mkdirSync(empty, { recursive: true });
    const found = discoverStateDirs({ candidates: [fixture.stateRoot] });
    expect(found).toContain(fixture.stateDir);
    expect(found).not.toContain(empty);
  });

  it('⭐ 配置没了、只剩网关锁的目录**也要认出来**（否则坏锁永远修不了）', () => {
    // 端到端实测抓到的真 bug：只看 openclaw.json 会把"配置被删/还没写、只剩锁"的
    // 现场整支无视 —— 扫描报"没有状态目录"，等于什么都没修。
    const lockOnly = path.join(fixture.stateRoot, 'lock-only-identity');
    fs.mkdirSync(path.join(lockOnly, 'tmp', 'openclaw'), { recursive: true });
    fs.writeFileSync(path.join(lockOnly, 'tmp', 'openclaw', 'gateway.x.lock'), '{ broken', 'utf8');
    const found = discoverStateDirs({ candidates: [fixture.stateRoot] });
    expect(found).toContain(lockOnly);
  });

  it('不把身份目录的**父目录**（state 容器）误报成 state', () => {
    const found = discoverStateDirs({ candidates: [fixture.stateRoot] });
    expect(found).not.toContain(fixture.stateRoot);
  });
});

describe('红线：修复工具**从不递归删**（junction 事故的同款防线）', () => {
  it('引擎源码里一个删除 API 都没有（只有 rename / copy / write）', () => {
    const dir = path.join(__dirname, '../src/main/repair');
    const files: string[] = [];
    const walk = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else if (entry.name.endsWith('.ts')) files.push(absolute);
      }
    };
    walk(dir);
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const api of ['unlinkSync', 'rmSync', 'rmdirSync', 'promises.rm']) {
        expect(source, `${path.basename(file)} 用了 ${api}`).not.toContain(`${api}(`);
      }
    }
  });
});

describe('zip 写的边角', () => {
  it('空条目表也产出合法的空 zip（只有 22 字节的 EOCD）', () => {
    const zip = buildZip([], FIXED_NOW);
    expect(zip.length).toBe(22);
    expect(zip.readUInt32LE(0)).toBe(0x06054b50);
    expect(zip.readUInt16LE(8)).toBe(0);
    expect(zip.readUInt16LE(10)).toBe(0);
  });

  it('条目名统一正斜杠、去掉前导斜杠', () => {
    expect(normalizeEntryName('\\logs\\a.log')).toBe('logs/a.log');
    expect(normalizeEntryName('/meta.json')).toBe('meta.json');
  });

  it('1980 年之前的日期按 1980-01-01 处理（zip 的老格式）', () => {
    expect(toDosDateTime(new Date(1970, 0, 1))).toEqual({ time: 0, date: 0x0021 });
  });
});
