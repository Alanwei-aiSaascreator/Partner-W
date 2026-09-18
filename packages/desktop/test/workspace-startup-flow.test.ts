/**
 * 启动时的工作区准备 —— **编排层**（T-U1）。
 *
 * 判定逻辑在 `portable.ts`（纯函数，见 `workspace-drive-heal.test.ts`）；
 * 这份测的是"判定之后到底发生了什么"：
 *   · 盘上首启真的把工作区设在盘根、**一个选择框都不弹**
 *   · 盘符变了真的**静默**改配置
 *   · 找不到工作区 / 数据库打不开 ⇒ 中文对话框，**失败路径绝不退出**
 *   · 只有用户在对话框里点了「退出」才调用 `quit()`
 *
 * ⚠️ 本机没有 U 盘可插、单测里也换不了盘符：盘用**虚拟路径集合**（`virtual`）代替，
 *    真盘上的目录用临时目录代替。`exists` 只对临时根做真实文件查询 —— 别的路径
 *    一律不碰真文件系统（也免得本机恰好真有 E: 盘把用例变成假绿）。
 * ⚠️ `vi.spyOn(process, 'platform')` 钉成 win32（`workspace-init.test.ts` 同款）：
 *    盘符语义是 Windows 的，在任何平台上都必须真跑，不许"跳过"。
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB_FILE_NAME } from '@clawwork/shared';

const electronMock = vi.hoisted(() => {
  const state = { userData: '' };
  return {
    state,
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return state.userData;
      throw new Error(`unexpected app path: ${name}`);
    }),
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  };
});

vi.mock('electron', () => ({
  app: { getPath: electronMock.getPath },
  safeStorage: {
    isEncryptionAvailable: electronMock.isEncryptionAvailable,
    encryptString: electronMock.encryptString,
    decryptString: electronMock.decryptString,
  },
}));

// 真数据库模块（better-sqlite3）在这份用例里没有意义：全部经注入的端口使用。
vi.mock('../src/main/db/index.js', () => ({
  initDatabase: vi.fn(),
  reinitDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

import {
  getDefaultWorkspacePath,
  getHomedirWorkspacePath,
  getWorkspacePath,
  isWorkspaceConfigured,
  readConfig,
  setPortableWorkspaceRoot,
  writeConfig,
  type AppConfig,
} from '../src/main/workspace/config.js';
import {
  prepareWorkspaceAtStartup,
  quarantineDatabaseFiles,
  type WorkspaceDatabasePort,
} from '../src/main/workspace/startup.js';

const MANIFEST = 'openclaw-runtime-manifest.json';
const WS_NAME = '荣盈魔方工作区';
const EXE_ON = (drive: string): string => win32.join(drive, '荣盈魔方便携版', '荣盈魔方.exe');
const fold = (p: string): string => win32.normalize(p).toLowerCase();

let userDataDir = '';
let realRoot = '';

interface Harness {
  virtual: Set<string>;
  exists: (p: string) => boolean;
  dialogs: {
    askForMissingWorkspace: ReturnType<typeof vi.fn>;
    browseForDirectory: ReturnType<typeof vi.fn>;
    askForUnusableWorkspace: ReturnType<typeof vi.fn>;
    notifyFatal: ReturnType<typeof vi.fn>;
  };
  database: WorkspaceDatabasePort & { init: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  initWorkspace: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  events: Array<{ event: string; data?: Record<string, unknown> }>;
  run(
    overrides?: Partial<Parameters<typeof prepareWorkspaceAtStartup>[0]>,
  ): ReturnType<typeof prepareWorkspaceAtStartup>;
}

function makeHarness(overrides: Partial<Parameters<typeof prepareWorkspaceAtStartup>[0]> = {}): Harness {
  const virtual = new Set<string>();
  const exists = (p: string): boolean => {
    if (virtual.has(fold(p))) return true;
    return p.toLowerCase().startsWith(realRoot.toLowerCase()) && existsSync(p);
  };
  const events: Harness['events'] = [];
  const workspaceInit = vi.fn((p: string) => {
    virtual.add(fold(p)); // 真 initWorkspace 会 mkdir + 放标记；虚拟盘上只记下"这个目录有了"
  });
  const database = {
    init: vi.fn(() => {}),
    close: vi.fn(() => {}),
  };
  const dialogs = {
    askForMissingWorkspace: vi.fn(async () => ({ kind: 'quit' }) as const),
    browseForDirectory: vi.fn(async () => null),
    askForUnusableWorkspace: vi.fn(async () => 'quit' as const),
    notifyFatal: vi.fn(async () => {}),
  };
  const quit = vi.fn(() => {});

  const run: Harness['run'] = (extra = {}) =>
    prepareWorkspaceAtStartup({
      exePath: EXE_ON('C:\\'),
      dialogs,
      database,
      removableDrives: [],
      exists,
      workspaceInit,
      quit,
      onEvent: (event, data) => events.push({ event, data }),
      ...overrides,
      ...extra,
    });

  return { virtual, exists, dialogs, database, initWorkspace: workspaceInit, quit, events, run };
}

function seedVirtual(h: Harness, ...items: string[]): void {
  for (const item of items) h.virtual.add(fold(item));
}

type SeedConfig = Omit<AppConfig, 'gateways'> & { gateways?: AppConfig['gateways'] };

function seedConfig(partial: SeedConfig): void {
  writeConfig({ gateways: [], ...partial });
}

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'clawwork-startup-'));
  realRoot = mkdtempSync(join(tmpdir(), 'clawwork-ws-'));
  electronMock.state.userData = userDataDir;
  setPortableWorkspaceRoot(null);
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(realRoot, { recursive: true, force: true });
});

describe('盘上首启：不选盘、直接就有工作区', () => {
  it('⭐ 首启自动把工作区设在 `<盘根>\\荣盈魔方工作区`，一个对话框都不弹', async () => {
    const h = makeHarness({
      exePath: EXE_ON('Q:\\'),
      removableDrives: ['Q:'],
    });
    seedVirtual(h, win32.join('Q:\\', MANIFEST));

    const result = await h.run();

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('unreachable');
    expect(result.path).toBe(win32.join('Q:\\', WS_NAME));
    expect(result.portable).toBe(true);
    expect(result.decision.kind).toBe('auto-portable');

    // 一个选择框都没有 —— 这就是「插上就用」的核心。
    expect(h.dialogs.askForMissingWorkspace).not.toHaveBeenCalled();
    expect(h.dialogs.browseForDirectory).not.toHaveBeenCalled();
    expect(h.dialogs.askForUnusableWorkspace).not.toHaveBeenCalled();
    expect(h.quit).not.toHaveBeenCalled();
    expect(h.initWorkspace).toHaveBeenCalledWith(win32.join('Q:\\', WS_NAME));

    const config = readConfig();
    expect(config?.workspacePath).toBe(win32.join('Q:\\', WS_NAME));
    // 迁移线索（下次换盘符靠它找回来）
    expect(config?.workspaceRelPath).toBe(WS_NAME);
    expect(config?.volumeMarker).toBe(MANIFEST);
    // 引导还没走完 ⇒ 首启仍然进 Setup（但跳过选盘那一步）
    expect(config?.portableSetupPending).toBe(true);
    expect(isWorkspaceConfigured()).toBe(false);
    // 渲染进程不用新 IPC 就能分辨这个状态：路径有值 + 未配置 = "盘上已就位、待引导"
    expect(getWorkspacePath()).toBe(win32.join('Q:\\', WS_NAME));
    expect(getDefaultWorkspacePath()).toBe(win32.join('Q:\\', WS_NAME));
  });

  it('第二次启动不再拦（清掉 portableSetupPending），且**不枚举盘**也认得出盘上形态', async () => {
    const h = makeHarness({ exePath: EXE_ON('Q:\\'), removableDrives: ['Q:'] });
    seedVirtual(h, win32.join('Q:\\', MANIFEST));

    const first = await h.run();
    expect(first.kind).toBe('ready');

    // 第二次：可移动盘列表故意给空（枚举失败的样子）—— 盘根 marker 仍然认得出。
    const second = await h.run({ removableDrives: [] });

    expect(second.kind).toBe('ready');
    if (second.kind !== 'ready') throw new Error('unreachable');
    expect(second.decision.kind).toBe('configured');
    expect(second.portable).toBe(true);
    expect(readConfig()?.portableSetupPending).toBe(false);
    expect(isWorkspaceConfigured()).toBe(true);
    expect(getDefaultWorkspacePath()).toBe(win32.join('Q:\\', WS_NAME));
    expect(h.dialogs.askForMissingWorkspace).not.toHaveBeenCalled();
    expect(h.quit).not.toHaveBeenCalled();
  });
});

describe('盘符变了：静默自愈', () => {
  it('⭐ 唯一命中 ⇒ 改配置继续，不弹框、不退出', async () => {
    seedConfig({ workspacePath: win32.join('R:\\', WS_NAME), workspaceRelPath: WS_NAME, volumeMarker: MANIFEST });
    const h = makeHarness({ exePath: EXE_ON('S:\\'), removableDrives: ['S:'] });
    seedVirtual(h, win32.join('S:\\', WS_NAME), win32.join('S:\\', MANIFEST));

    const result = await h.run();

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('unreachable');
    expect(result.path).toBe(win32.join('S:\\', WS_NAME));
    expect(result.decision.kind).toBe('healed');
    if (result.decision.kind !== 'healed') throw new Error('unreachable');
    expect(result.decision.from).toBe(win32.join('R:\\', WS_NAME));
    expect(result.decision.via.evidence).toBe('volume-marker');

    expect(h.dialogs.askForMissingWorkspace).not.toHaveBeenCalled();
    expect(h.quit).not.toHaveBeenCalled();
    expect(readConfig()?.workspacePath).toBe(win32.join('S:\\', WS_NAME));
    expect(readConfig()?.workspaceRelPath).toBe(WS_NAME);
    expect(h.events.map((e) => e.event)).toContain('workspace.healed');
  });

  it('多命中 ⇒ 对话框把候选全部列出来，用户挑一个（不许猜）', async () => {
    seedConfig({ workspacePath: win32.join('R:\\', WS_NAME), workspaceRelPath: WS_NAME, volumeMarker: MANIFEST });
    const h = makeHarness({ exePath: EXE_ON('S:\\'), removableDrives: ['S:', 'T:'] });
    seedVirtual(
      h,
      win32.join('S:\\', WS_NAME),
      win32.join('S:\\', MANIFEST),
      win32.join('T:\\', WS_NAME),
      win32.join('T:\\', MANIFEST),
    );
    h.dialogs.askForMissingWorkspace.mockResolvedValue({ kind: 'use', path: win32.join('T:\\', WS_NAME) });

    const result = await h.run();

    expect(h.dialogs.askForMissingWorkspace).toHaveBeenCalledTimes(1);
    const asked = h.dialogs.askForMissingWorkspace.mock.calls[0][0] as { recordedPath: string; candidates: string[] };
    expect([...asked.candidates].sort()).toEqual([win32.join('S:\\', WS_NAME), win32.join('T:\\', WS_NAME)].sort());
    expect(asked.recordedPath).toBe(win32.join('R:\\', WS_NAME));

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('unreachable');
    expect(result.path).toBe(win32.join('T:\\', WS_NAME));
    expect(readConfig()?.workspacePath).toBe(win32.join('T:\\', WS_NAME));
    expect(h.quit).not.toHaveBeenCalled();
  });

  it('零命中（盘没插）⇒ 问用户；**没选退出就绝不退出**', async () => {
    seedConfig({ workspacePath: win32.join('R:\\', WS_NAME), workspaceRelPath: WS_NAME, volumeMarker: MANIFEST });
    const h = makeHarness({ exePath: EXE_ON('C:\\'), removableDrives: [] });

    const result = await h.run();

    expect(h.dialogs.askForMissingWorkspace).toHaveBeenCalledTimes(1);
    expect(h.dialogs.askForMissingWorkspace).toHaveBeenCalledWith({
      recordedPath: win32.join('R:\\', WS_NAME),
      candidates: [],
    });
    // 用户点了「退出」—— 这是唯一会退出的情形。
    expect(result).toEqual({ kind: 'quit', reason: 'user-chose-quit' });
    expect(h.quit).toHaveBeenCalledTimes(1);
    // 没退出的话，配置与工作区都不该被动过
    expect(readConfig()?.workspacePath).toBe(win32.join('R:\\', WS_NAME));
  });

  it('零命中 + 用户选「新建工作区」⇒ 盘还在就建在原地', async () => {
    seedConfig({ workspacePath: win32.join('R:\\', WS_NAME), workspaceRelPath: WS_NAME, volumeMarker: MANIFEST });
    const h = makeHarness({ exePath: EXE_ON('R:\\'), removableDrives: ['R:'] });
    seedVirtual(h, 'R:\\', win32.join('R:\\', MANIFEST)); // 盘在，工作区目录没了
    h.dialogs.askForMissingWorkspace.mockResolvedValue({ kind: 'create' });

    const result = await h.run();

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('unreachable');
    expect(result.path).toBe(win32.join('R:\\', WS_NAME));
    expect(readConfig()?.workspacePath).toBe(win32.join('R:\\', WS_NAME));
    expect(h.quit).not.toHaveBeenCalled();
  });

  it('零命中 + 用户选「新建工作区」+ 盘也不在 ⇒ 落在本机默认位置（不退出）', async () => {
    seedConfig({ workspacePath: win32.join('R:\\', WS_NAME), workspaceRelPath: WS_NAME, volumeMarker: MANIFEST });
    const h = makeHarness({ exePath: EXE_ON('C:\\'), removableDrives: [] });
    h.dialogs.askForMissingWorkspace.mockResolvedValue({ kind: 'create' });

    const result = await h.run();

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('unreachable');
    expect(result.path).toBe(getHomedirWorkspacePath());
    expect(readConfig()?.workspacePath).toBe(getHomedirWorkspacePath());
    expect(h.quit).not.toHaveBeenCalled();
  });

  it('用户选「选择其它目录」但取消了 ⇒ 再问一次（不是直接退出）', async () => {
    seedConfig({ workspacePath: win32.join('R:\\', WS_NAME), workspaceRelPath: WS_NAME, volumeMarker: MANIFEST });
    const h = makeHarness({ exePath: EXE_ON('C:\\'), removableDrives: [] });
    h.dialogs.askForMissingWorkspace.mockResolvedValueOnce({ kind: 'browse' }).mockResolvedValueOnce({ kind: 'quit' });
    h.dialogs.browseForDirectory.mockResolvedValue(null);

    const result = await h.run();

    expect(h.dialogs.askForMissingWorkspace).toHaveBeenCalledTimes(2);
    expect(h.dialogs.browseForDirectory).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ kind: 'quit', reason: 'user-chose-quit' });
    expect(h.quit).toHaveBeenCalledTimes(1);
  });
});

describe('数据库打不开：三选一，失败路径绝不退出', () => {
  /** 一个真目录（隔离数据库文件用真文件系统 —— 隔离逻辑本身就是文件改名）。 */
  function realWorkspace(): string {
    const dir = mkdtempSync(join(realRoot, 'ws-'));
    writeFileSync(join(dir, DB_FILE_NAME), 'not a database');
    return dir;
  }

  function brokenDatabase(): Harness['database'] {
    // 报错条件就是"库文件还在"：重建（改名挪走）之后自然就好了 —— 与真实场景同形。
    //
    // ⚠️ 这只是**编排层**的替身：它不真开句柄，所以它永远测不出"还开着句柄 ⇒ Windows 上
    //    rename 必 EBUSY"那件事（那正是这条路上真机断掉的地方）。句柄层面的证据在
    //    `workspace-db-rebuild.test.ts`（真 sqlite、真文件、真 rename）。
    return {
      init: vi.fn((p: string) => {
        if (existsSync(join(p, DB_FILE_NAME))) throw new Error('file is not a database');
      }),
      close: vi.fn(() => {}),
    };
  }

  it('⭐ 「重建工作区」必须先放句柄、再改名（顺序错就是真机上的 EBUSY）', async () => {
    const ws = realWorkspace();
    seedConfig({ workspacePath: ws, gateways: [] });
    const h = makeHarness({ exePath: EXE_ON('C:\\') });
    const order: string[] = [];
    h.database.init = vi.fn((p: string) => {
      order.push('init');
      if (existsSync(join(p, DB_FILE_NAME))) throw new Error('file is not a database');
      // 成功路径要**真的把库文件建出来**：否则下面那句「新库建出来了」永远为假
      // （这条测试先前就是这么红的 —— 假库只「不抛」，从不落文件）。
      writeFileSync(join(p, DB_FILE_NAME), 'sqlite');
    });
    h.database.close = vi.fn(() => {
      order.push('close');
    });
    h.dialogs.askForUnusableWorkspace.mockResolvedValue('rebuild');

    const result = await h.run();

    expect(result.kind).toBe('ready');
    // 第一次 init 失败 ⇒ close（放掉句柄）⇒ 改名挪走坏文件 ⇒ 第二次 init 建新库
    expect(order).toEqual(['init', 'close', 'init']);
    expect(existsSync(join(ws, DB_FILE_NAME))).toBe(true); // 新库建出来了
  });

  it('⭐ init 抛错 ⇒ 弹三选一（中文可行动），不是 showErrorBox + 退出', async () => {
    const ws = realWorkspace();
    seedConfig({ workspacePath: ws, gateways: [] });
    const h = makeHarness({ exePath: EXE_ON('C:\\') });
    h.database.init = brokenDatabase().init;
    h.dialogs.askForUnusableWorkspace.mockResolvedValue('rebuild');

    const result = await h.run();

    expect(h.dialogs.askForUnusableWorkspace).toHaveBeenCalledTimes(1);
    expect(h.dialogs.askForUnusableWorkspace).toHaveBeenCalledWith({
      workspacePath: ws,
      message: 'file is not a database',
    });
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('unreachable');
    expect(result.path).toBe(ws);
    expect(h.quit).not.toHaveBeenCalled(); // ← 失败路径**没有**退出
    // 「重建工作区」= 把打不开的库改名挪走（不删用户数据），下一次 init 建新的
    const quarantined = readdirSync(ws).filter((name) => name.includes('.corrupt-'));
    expect(quarantined).toHaveLength(1);
    expect(existsSync(join(ws, DB_FILE_NAME))).toBe(false);
  });

  it('用户选「选择其它目录」⇒ 换到新目录并写进配置（不退出）', async () => {
    const ws = realWorkspace();
    const other = mkdtempSync(join(realRoot, 'other-'));
    seedConfig({ workspacePath: ws, gateways: [] });
    const h = makeHarness({ exePath: EXE_ON('C:\\') });
    h.database.init = brokenDatabase().init;
    h.dialogs.askForUnusableWorkspace.mockResolvedValue('browse');
    h.dialogs.browseForDirectory.mockResolvedValue(other);

    const result = await h.run();

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('unreachable');
    expect(result.path).toBe(other);
    expect(readConfig()?.workspacePath).toBe(other);
    expect(h.quit).not.toHaveBeenCalled();
  });

  it('用户选「退出」⇒ 这时才 quit（恰好一次）', async () => {
    const ws = realWorkspace();
    seedConfig({ workspacePath: ws, gateways: [] });
    const h = makeHarness({ exePath: EXE_ON('C:\\') });
    h.database.init = brokenDatabase().init;
    h.dialogs.askForUnusableWorkspace.mockResolvedValue('quit');

    const result = await h.run();

    expect(result).toEqual({ kind: 'quit', reason: 'user-chose-quit' });
    expect(h.quit).toHaveBeenCalledTimes(1);
    expect(h.database.init).toHaveBeenCalledTimes(1);
  });

  it('一直打不开、用户又一直取消 ⇒ 有上限、给中文提示，绝不抛异常空转', async () => {
    const ws = realWorkspace();
    seedConfig({ workspacePath: ws, gateways: [] });
    const h = makeHarness({ exePath: EXE_ON('C:\\') });
    h.database.init = vi.fn(() => {
      throw new Error('still broken');
    });
    h.dialogs.askForUnusableWorkspace.mockResolvedValue('browse');
    h.dialogs.browseForDirectory.mockResolvedValue(null);

    const result = await h.run();

    expect(result.kind).toBe('quit');
    expect(h.dialogs.askForUnusableWorkspace.mock.calls.length).toBeLessThanOrEqual(5);
    expect(h.dialogs.notifyFatal).toHaveBeenCalledTimes(1);
    const notice = h.dialogs.notifyFatal.mock.calls[0][0] as { title: string; message: string; detail: string };
    expect(notice.title).toContain('工作区');
    expect(notice.message).toContain(ws); // 说清是哪个位置
    // 最后那个提示只有一个「退出」按钮 ⇒ 必须把"关掉就等于退出"说出来
    expect(notice.detail).toContain('退出');
  });

  it('⭐ 重试用尽前仍留一条出路：最后还能「选择其它目录」（不是只剩退出）', async () => {
    const ws = realWorkspace();
    const other = mkdtempSync(join(realRoot, 'rescued-'));
    seedConfig({ workspacePath: ws, gateways: [] });
    const h = makeHarness({ exePath: EXE_ON('C:\\') });
    h.database.init = vi.fn((p: string) => {
      if (p !== other) throw new Error('still broken');
    });
    h.dialogs.askForUnusableWorkspace.mockResolvedValue('browse');
    // 循环里 5 次都取消，最后一次机会（第 6 次）选到一个能用的目录
    let asks = 0;
    h.dialogs.browseForDirectory.mockImplementation(async () => (asks++ < 5 ? null : other));

    const result = await h.run();

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('unreachable');
    expect(result.path).toBe(other);
    expect(readConfig()?.workspacePath).toBe(other);
    expect(h.dialogs.notifyFatal).not.toHaveBeenCalled();
    expect(h.quit).not.toHaveBeenCalled();
  });

  it('quarantineDatabaseFiles 连带 -wal / -shm 一起挪走，且不碰别的文件', () => {
    const dir = mkdtempSync(join(realRoot, 'ws-quarantine-'));
    writeFileSync(join(dir, DB_FILE_NAME), 'x');
    writeFileSync(join(dir, `${DB_FILE_NAME}-wal`), 'x');
    writeFileSync(join(dir, `${DB_FILE_NAME}-shm`), 'x');
    writeFileSync(join(dir, 'notes.md'), 'keep me');

    const moved = quarantineDatabaseFiles(dir);

    expect(moved).toHaveLength(3);
    for (const target of moved) expect(existsSync(target)).toBe(true);
    const names = readdirSync(dir);
    expect(names).toContain('notes.md'); // 只动数据库文件，别的数据一律不碰
    for (const suffix of ['', '-wal', '-shm']) {
      expect(names).not.toContain(`${DB_FILE_NAME}${suffix}`);
    }
  });
});

describe('工作区标记：盘符自愈的第二条线索（真文件系统）', () => {
  it('initWorkspace 建目录 + 放 `.clawwork-workspace.json`，重复调用不改写', async () => {
    const { initWorkspace } = await import('../src/main/workspace/init.js');
    const dir = join(mkdtempSync(join(realRoot, 'ws-marker-')), '荣盈魔方工作区');

    await initWorkspace(dir);
    const marker = join(dir, '.clawwork-workspace.json');
    expect(existsSync(marker)).toBe(true);
    const first = JSON.parse(readFileSync(marker, 'utf8')) as { formatVersion: number; app: string; createdAt: string };
    expect(first.formatVersion).toBe(1);
    expect(first.app).toBe('rongying-cube');
    expect(first.createdAt).toBeTruthy();

    await initWorkspace(dir); // 幂等：已有标记就留着（不刷新时间戳）
    const second = JSON.parse(readFileSync(marker, 'utf8')) as { createdAt: string };
    expect(second.createdAt).toBe(first.createdAt);
  });
});

describe('源码契约：失败路径不许 app.quit()', () => {
  const source = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8');
  // 去掉注释行：这段历史写在注释里（"旧行为是 showErrorBox + app.quit()"），
  // 不剥掉的话契约测试会被自己的说明文字绊倒。
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  const start = code.indexOf('prepareWorkspaceAtStartup({');
  const end = code.indexOf('setupAnalytics();');
  const region = start === -1 || end === -1 ? '' : code.slice(start, end);

  it('启动块里 `app.quit()` 只出现一次，且只是交给对话框的 `quit` 回调', () => {
    expect(start, 'index.ts 里找不到 prepareWorkspaceAtStartup 调用').toBeGreaterThan(-1);
    expect(end, 'index.ts 里找不到 setupAnalytics() 调用').toBeGreaterThan(start);
    expect(region.split('app.quit()').length - 1).toBe(1);
    expect(region).toContain('quit: () => app.quit()');
    // 不许出现**直接调用**（`app.quit();` / `app.quit()` 后面没有逗号的那种）
    expect(region).not.toMatch(/app\.quit\(\)\s*;/);
  });

  it('旧的英文错误框已经删掉（它不会说"怎么办"，而且后面紧跟退出）', () => {
    expect(code).not.toContain('showErrorBox');
  });

  it('工作区准备好**之后**才开窗（先有工作区，再有界面）', () => {
    expect(start).toBeLessThan(code.indexOf('createWindow();'));
  });
});
