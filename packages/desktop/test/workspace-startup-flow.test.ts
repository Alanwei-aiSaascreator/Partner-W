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
// 只取这一个常量：工作区自身的标记文件名（真 `initWorkspace()` 会往工作区里写它）。
import { WORKSPACE_MARKER_FILE } from '../src/main/workspace/portable.js';

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
    // 内置本地网关由主进程自动配置，首启不该把用户送进手工网关表单。
    expect(config?.portableSetupPending).toBe(false);
    expect(isWorkspaceConfigured()).toBe(true);
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

/**
 * 同事那份交付包的**真实形状**（2026-09-20 实机，`荣盈魔方U盘交付-0.0.24`）：
 * 解压到 U 盘根目录 ⇒ `<盘>\荣盈魔方U盘交付-0.0.24\荣盈魔方\荣盈魔方.exe`，
 * exe 旁边是 `resources\`，随包运行时清单在 `resources\runtime\openclaw-runtime-manifest.json`。
 *
 * ⚠️ 那两块盘上**两条老判据同时落空**，这就是「找不到工作区」的来源：
 *    · 盘根**没有** marker —— 交付说明叮嘱那个文件"千万别拷"；
 *    · 很多 U 盘/移动固态/读卡器被 Windows 报成 `DriveType=3`（固定盘）⇒ 枚举永远不命中。
 *    ⇒ 老行为：判成安装形态 ⇒ 工作区设到**本机** homedir、一条迁移线索都不记。
 *
 * 这一组测的是**编排层**（判定逻辑的纯函数单测在 `portable-run-detection.test.ts`）：
 * 判据接上之后，首启 / 换口 / 稳态 / 本机安装四种情形到底发生了什么。
 */
describe('交付形态（DriveType=3 的 U 盘）：同事那份交付包', () => {
  const DELIVERY_DIR = '荣盈魔方U盘交付-0.0.24';
  const deliveryAppDir = (drive: string): string => win32.join(drive, DELIVERY_DIR, '荣盈魔方');
  const deliveryExeOn = (drive: string): string => win32.join(deliveryAppDir(drive), '荣盈魔方.exe');
  const deliveryResourcesOn = (drive: string): string => win32.join(deliveryAppDir(drive), 'resources');
  /** 判据 ④ 认的那一份文件（随包运行时清单）。 */
  const bundledManifestOn = (drive: string): string => win32.join(deliveryResourcesOn(drive), 'runtime', MANIFEST);
  /** 同一份交付包挂在任意盘符上的启动参数。 */
  const deliveryOn = (drive: string): Partial<Parameters<typeof prepareWorkspaceAtStartup>[0]> => ({
    exePath: deliveryExeOn(drive),
    resourcesPath: deliveryResourcesOn(drive),
    // 枚举**空数组**：DriveType=3 的那块盘永远不在列表里 —— 正是判据要补的那个洞。
    removableDrives: [],
  });

  it('⭐ 首启：盘根没 marker、枚举也空 ⇒ 仍然认得出，工作区自动落在盘上、零对话框', async () => {
    const h = makeHarness(deliveryOn('E:\\'));
    seedVirtual(h, bundledManifestOn('E:\\'));

    const result = await h.run();

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('unreachable');
    expect(result.decision.kind).toBe('auto-portable');
    if (result.decision.kind !== 'auto-portable') throw new Error('unreachable');
    expect(result.decision.volumeRoot).toBe('E:\\');
    expect(result.path).toBe(win32.join('E:\\', WS_NAME));
    expect(result.portable).toBe(true);

    // 凭什么认为是盘上运行：日志/诊断 txt 就靠这句说清楚
    expect(h.events).toContainEqual({
      event: 'workspace.portable.detected',
      data: { portable: true, reason: 'delivery-layout' },
    });

    expect(h.dialogs.askForMissingWorkspace).not.toHaveBeenCalled();
    expect(h.dialogs.browseForDirectory).not.toHaveBeenCalled();
    expect(h.dialogs.askForUnusableWorkspace).not.toHaveBeenCalled();
    expect(h.quit).not.toHaveBeenCalled();
    expect(h.initWorkspace).toHaveBeenCalledWith(win32.join('E:\\', WS_NAME));

    const config = readConfig();
    expect(config?.workspacePath).toBe(win32.join('E:\\', WS_NAME));
    // 换口自愈的线索：老行为这里一个字段都没有 ⇒ 换台机器/换个口就是「找不到工作区」
    expect(config?.workspaceRelPath).toBe(WS_NAME);
    // 渲染进程要看到"盘上那份"，而不是本机 homedir
    expect(getDefaultWorkspacePath()).toBe(win32.join('E:\\', WS_NAME));
    // 工作区和内置网关都自动准备：直接进入登录/工作台，不暴露空 token 表单。
    expect(config?.portableSetupPending).toBe(false);
    expect(isWorkspaceConfigured()).toBe(true);
  });

  it('⭐ 换个 USB 口（E: → F:）⇒ 静默找回盘上那份，不弹框、不退出', async () => {
    const first = makeHarness(deliveryOn('E:\\'));
    seedVirtual(first, bundledManifestOn('E:\\'));
    const firstRun = await first.run();
    expect(firstRun.kind).toBe('ready');
    if (firstRun.kind !== 'ready') throw new Error('unreachable');
    expect(firstRun.decision.kind).toBe('auto-portable');
    const legacyConfig = readConfig();
    if (!legacyConfig) throw new Error('首启没有写配置');
    writeConfig({ ...legacyConfig, portableSetupPending: true }); // 模拟 0.0.25 已写下的旧标记

    // 同一个包换到 F: 上。⚠️ 用**另一块虚拟盘**（不是往旧 harness 里加路径）：
    //    换口之后旧盘符整块不在了，E: 上的残留路径不该参与这次判定。
    const second = makeHarness(deliveryOn('F:\\'));
    seedVirtual(
      second,
      bundledManifestOn('F:\\'),
      win32.join('F:\\', WS_NAME),
      win32.join('F:\\', WS_NAME, WORKSPACE_MARKER_FILE), // 真 initWorkspace() 写的那份标记
    );

    const result = await second.run();

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('unreachable');
    expect(result.decision.kind).toBe('healed');
    if (result.decision.kind !== 'healed') throw new Error('unreachable');
    // 候选来自"程序自己运行的那块盘"—— 枚举空数组时的唯一活路
    expect(result.decision.via.origin).toBe('run-volume');
    expect(result.decision.via.evidence).toBe('workspace-marker');
    expect(result.path).toBe(win32.join('F:\\', WS_NAME));

    expect(second.dialogs.askForMissingWorkspace).not.toHaveBeenCalled();
    expect(second.dialogs.browseForDirectory).not.toHaveBeenCalled();
    expect(second.quit).not.toHaveBeenCalled();
    expect(second.events.map((e) => e.event)).toContain('workspace.healed');

    const config = readConfig();
    expect(config?.workspacePath).toBe(win32.join('F:\\', WS_NAME));
    expect(config?.workspaceRelPath).toBe(WS_NAME);
    expect(config?.portableSetupPending).toBe(false);
    expect(isWorkspaceConfigured()).toBe(true);
  });

  it('第二次启动（同一个口）⇒ configured；不枚举盘也仍然认得盘上形态', async () => {
    const h = makeHarness(deliveryOn('E:\\'));
    seedVirtual(h, bundledManifestOn('E:\\'));

    const first = await h.run();
    expect(first.kind).toBe('ready');

    const firstRunEvents = h.events.length;
    const second = await h.run();
    const secondEvents = h.events.slice(firstRunEvents);

    expect(second.kind).toBe('ready');
    if (second.kind !== 'ready') throw new Error('unreachable');
    expect(second.decision.kind).toBe('configured');
    // ⚠️ `portable` 是**第二次判定**的结果：记录的位置还在 ⇒ 只做纯文件检查。
    //    它要还是 true —— 否则设置页/日志会把盘上那份说成"本机默认位置"。
    expect(second.portable).toBe(true);
    expect(getDefaultWorkspacePath()).toBe(win32.join('E:\\', WS_NAME));
    expect(readConfig()?.portableSetupPending).toBe(false);
    expect(isWorkspaceConfigured()).toBe(true);
    // 这条日志只在"纯文件检查没认出来、只好去枚举"之后才写 ⇒ 它不出现 = 一次枚举都没跑
    //（枚举是一次 PowerShell，启动路径上不该有）
    expect(secondEvents.map((e) => e.event)).not.toContain('workspace.portable.detected');
    expect(secondEvents).toContainEqual({ event: 'workspace.startup.decision', data: { kind: 'configured' } });
    expect(h.dialogs.askForMissingWorkspace).not.toHaveBeenCalled();
    expect(h.quit).not.toHaveBeenCalled();
  });

  it('本机安装形态（`C:\\Program Files\\荣盈魔方\\`，运行时也在夹子里）⇒ 不认，别把工作区指到 C 盘盘根', async () => {
    const appDir = win32.join('C:\\', 'Program Files', '荣盈魔方');
    const h = makeHarness({
      exePath: win32.join(appDir, '荣盈魔方.exe'),
      resourcesPath: win32.join(appDir, 'resources'),
      removableDrives: [],
    });
    seedVirtual(h, win32.join(appDir, 'resources', 'runtime', MANIFEST));

    const result = await h.run();

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('unreachable');
    expect(result.decision.kind).toBe('default');
    expect(result.path).toBe(getHomedirWorkspacePath());
    expect(result.portable).toBe(false);
    expect(getDefaultWorkspacePath()).toBe(getHomedirWorkspacePath());
    expect(h.events).toContainEqual({
      event: 'workspace.portable.detected',
      data: { portable: false, reason: null },
    });
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
    expect(region).not.toContain('showErrorBox');
  });

  it('工作区准备好**之后**才开窗（先有工作区，再有界面）', () => {
    expect(start).toBeLessThan(code.indexOf('createWindow();'));
  });

  /**
   * ⚠️ 这两处 `process.resourcesPath` 是**交付形态判据在真机上唯一的入口**（只有打包态
   *    才知道 exe 旁边那份 `resources\` 在哪）。少了任何一处，判据在真机上直接哑掉 ——
   *    而所有单测传的都是注入的路径，测不到"真机上到底传没传"，所以这里读源码钉住
   *    （与上面那条 `app.quit()` 契约同款手法）。
   */
  it('两处调用都把 `process.resourcesPath` 传下去（真机上交付判据的唯一入口）', () => {
    expect(region, 'prepareWorkspaceAtStartup 调用块里没传 resourcesPath').toContain(
      'resourcesPath: process.resourcesPath',
    );

    const appDataStart = code.indexOf('applyPortableAppData({');
    const appDataEnd = code.indexOf('const gotLock');
    expect(appDataStart, 'index.ts 里找不到 applyPortableAppData 调用').toBeGreaterThan(-1);
    expect(appDataEnd).toBeGreaterThan(appDataStart);
    expect(code.slice(appDataStart, appDataEnd), 'applyPortableAppData 调用里没传 resourcesPath').toContain(
      'resourcesPath: process.resourcesPath',
    );
  });

  it('keeps disposable runtime code local while persistent state follows effective portable userData', () => {
    const override = code.indexOf('applyUserDataOverride({');
    const capture = code.indexOf("const localUserDataDir = app.getPath('userData');");
    const portable = code.indexOf('applyPortableAppData({');
    expect(override, 'index.ts 里找不到 applyUserDataOverride 调用').toBeGreaterThan(-1);
    expect(capture, '没有在搬 userData 前保存本机运行时缓存根').toBeGreaterThan(override);
    expect(capture).toBeLessThan(portable);

    const scopedCache = code.indexOf('const runtimeCacheUserDataDir = runtimeCacheScopeDir({');
    const lock = code.indexOf('app.requestSingleInstanceLock()');
    expect(scopedCache, '没有按便携 userData 隔离本机运行时缓存').toBeGreaterThan(portable);
    expect(scopedCache, '缓存作用域必须先定好，再进入同 userData 的单实例保护').toBeLessThan(lock);
    expect(code.slice(scopedCache, lock), '盘上判定失败/未命中时不能误切到便携缓存作用域').toContain(
      'portable: portableAppData.reason !== null && portableAppData.failed === undefined',
    );

    const bootstrapStart = code.indexOf('bootstrapLocalGatewayRuntime({');
    const bootstrapEnd = code.indexOf('});', bootstrapStart);
    expect(bootstrapStart, 'index.ts 里找不到 bootstrapLocalGatewayRuntime 调用').toBeGreaterThan(portable);
    expect(code.slice(bootstrapStart, bootstrapEnd), 'bootstrap 没有收到本机运行时缓存根').toContain(
      'runtimeCacheUserDataDir',
    );
    const bootstrapRegion = code.slice(bootstrapStart, bootstrapEnd);
    expect(bootstrapRegion, 'Persistent OpenClaw state must follow effective portable userData').toContain(
      "stateCacheUserDataDir: app.getPath('userData')",
    );
    expect(bootstrapRegion, 'Local state may only be used as a portable migration source').toContain(
      'legacyStateUserDataDir: portableAppData.target ? localUserDataDir : undefined',
    );
    expect(bootstrapRegion).not.toContain('stateCacheUserDataDir: localUserDataDir');
    expect(bootstrapRegion, 'The managed agent workspace must follow the selected portable workspace').toContain(
      'portableWorkspacePath: workspace.portable ? wsPath : undefined',
    );
  });

  it('把 runtime 内部阶段事件接到 debug 日志（否则真盘只能看到最终失败，定位不了慢在哪）', () => {
    const bootstrapStart = code.indexOf('bootstrapLocalGatewayRuntime({');
    const resultCheck = code.indexOf('if (!runtimeResult.ok)', bootstrapStart);
    expect(bootstrapStart).toBeGreaterThan(-1);
    expect(resultCheck).toBeGreaterThan(bootstrapStart);
    const bootstrapRegion = code.slice(bootstrapStart, resultCheck);
    expect(bootstrapRegion).toContain('deps:');
    expect(bootstrapRegion).toContain('log: (event, data)');
    expect(bootstrapRegion).toContain("domain: 'gateway'");
  });
});
