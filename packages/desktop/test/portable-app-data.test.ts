/**
 * 盘上运行时：**应用数据跟着盘走**（T-U3）。
 *
 * 为什么单独立这个模块（而不是塞进 `user-data-override.ts`）：
 * 那个模块是 **dev/test 的隔离后门**，硬要求"打包后一律不认环境变量"；
 * 这个是**产品行为**（打包后的盘上形态就该这么跑）。两者混在一起，
 * 下一个人会把其中一条当成另一条的例外去改。
 *
 * ⚠️ 全是纯函数（`exists` / 盘列表 / 盘符全部注入）——本机插不了 U 盘、
 *    也不能在单测里换盘符。写法沿用 `portable-run-detection.test.ts`。
 * ⚠️ `vi.spyOn(process, 'platform')` 钉成 win32：盘符判据是 Windows 专有的。
 */

import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyPortableAppData,
  decidePortableAppData,
  PORTABLE_APP_DATA_DIR_NAME,
} from '../src/main/runtime/portable-app-data.js';
import {
  PORTABLE_WORKSPACE_DIR_NAME,
  detectPortableRun,
  WORKSPACE_MARKER_FILE,
} from '../src/main/workspace/portable.js';

const WIN = path.win32;
const MANIFEST = 'openclaw-runtime-manifest.json';
const DRIVE_E = 'E:\\';
const DRIVE_C = 'C:\\';

const exeOn = (drive: string): string => WIN.join(drive, '荣盈魔方', '荣盈魔方.exe');
const appDataOn = (drive: string): string =>
  WIN.join(drive, 'Users', 'u', 'AppData', 'Roaming', '@clawwork', 'desktop');
const appDataDirOn = (drive: string): string => WIN.join(drive, PORTABLE_APP_DATA_DIR_NAME);
const workspaceMarkerOn = (drive: string): string =>
  WIN.join(drive, PORTABLE_WORKSPACE_DIR_NAME, WORKSPACE_MARKER_FILE);

/** 虚拟文件系统：只回答"这个路径在不在"。 */
function vfs(paths: readonly string[]): (p: string) => boolean {
  const set = new Set(paths.map((p) => WIN.normalize(p).toLowerCase()));
  return (p) => set.has(WIN.normalize(p).toLowerCase());
}

function decide(over: Partial<Parameters<typeof decidePortableAppData>[0]> = {}) {
  return decidePortableAppData({
    exePath: exeOn(DRIVE_E),
    isPackaged: true,
    defaultUserData: appDataOn(DRIVE_C),
    systemDrive: DRIVE_C,
    exists: () => false,
    removableDrives: () => [],
    ...over,
  });
}

describe('decidePortableAppData', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('① 盘根有运行时 marker ⇒ 数据放盘里，且**不枚举**可移动盘', () => {
    const drives = vi.fn(() => [DRIVE_E]);
    const result = decide({ exists: vfs([WIN.join(DRIVE_E, MANIFEST)]), removableDrives: drives });

    expect(result.target).toBe(appDataDirOn(DRIVE_E));
    expect(result.volumeRoot).toBe(DRIVE_E);
    expect(result.reason).toBe('volume-marker');
    expect(drives).not.toHaveBeenCalled();
  });

  it('② 只有我们自己的工作区标记也认（盘根没放运行时、或枚举失败时的救命判据）', () => {
    const drives = vi.fn(() => []);
    const result = decide({ exists: vfs([workspaceMarkerOn(DRIVE_E)]), removableDrives: drives });

    expect(result.target).toBe(appDataDirOn(DRIVE_E));
    expect(result.reason).toBe('workspace-marker');
    expect(drives).not.toHaveBeenCalled();
  });

  it('③ 两条 marker 都没有 ⇒ 才去枚举可移动盘（DriveType=2）', () => {
    const drives = vi.fn(() => [DRIVE_E]);
    const result = decide({ exists: () => false, removableDrives: drives });

    expect(result.target).toBe(appDataDirOn(DRIVE_E));
    expect(result.reason).toBe('removable-drive');
    expect(drives).toHaveBeenCalledTimes(1);
  });

  it('④ 枚举出来也不是盘（本机安装形态）⇒ 一个字节都不改', () => {
    const result = decide({ exists: () => false, removableDrives: () => [] });

    expect(result.target).toBeNull();
    expect(result.reason).toBeNull();
    expect(result.volumeRoot).toBe(DRIVE_E);
  });

  it('⑤ exe 在系统盘上 ⇒ 连文件都不看、枚举更不做（安装形态的启动不许被拖慢）', () => {
    const exists = vi.fn(() => true);
    const drives = vi.fn(() => [DRIVE_C]);
    const result = decide({
      exePath: exeOn(DRIVE_C),
      exists,
      removableDrives: drives,
    });

    expect(result.target).toBeNull();
    expect(result.reason).toBeNull();
    expect(drives).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
  });

  it('⑥ 非打包态（dev/CI，exe 是 electron 本体）⇒ 一律不动', () => {
    const drives = vi.fn(() => [DRIVE_E]);
    const exists = vi.fn(() => true);
    const result = decide({ isPackaged: false, exists, removableDrives: drives });

    expect(result.target).toBeNull();
    expect(drives).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
  });

  it('⑦ 算出来的目标就是当前 userData ⇒ 不改（不无谓 setPath）', () => {
    const result = decide({
      defaultUserData: appDataDirOn(DRIVE_E),
      exists: vfs([WIN.join(DRIVE_E, MANIFEST)]),
    });

    expect(result.target).toBeNull();
    expect(result.reason).toBe('volume-marker');
  });

  it('⑧ 相对路径 / 推不出盘根 ⇒ 不动', () => {
    expect(decide({ exePath: '荣盈魔方.exe' }).target).toBeNull();
  });
});

/**
 * 交付形态判据（`delivery-layout`）—— 与 `workspace/portable.ts` 的
 * `detectPortableRun` **同一份事实、同一个结论**（两边打架过一次，别再来）。
 *
 * 为什么必须有它：`DriveType=3` 的 U 盘/移动固态/读卡器上，"枚举可移动盘"永远不命中，
 * 盘根 marker 又是交付说明里叮嘱不要拷的文件 ⇒ 判据全落空 ⇒ 数据留在本机，
 * 用户换台机器就是"东西不见了"。
 */
describe('decidePortableAppData：交付形态判据', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const deliveredExe = (drive: string, wrapper?: string): string =>
    WIN.join(drive, ...(wrapper ? [wrapper] : []), '荣盈魔方', '荣盈魔方.exe');
  const resourcesOf = (exePath: string): string => WIN.join(WIN.dirname(exePath), 'resources');
  const bundledManifestOf = (exePath: string): string => WIN.join(resourcesOf(exePath), 'runtime', MANIFEST);

  it('⑫ 交付夹在盘根下一层、带着随包运行时 ⇒ 数据放盘里，且**不枚举**可移动盘', () => {
    const exePath = deliveredExe(DRIVE_E);
    const drives = vi.fn(() => []);
    const result = decide({
      exePath,
      resourcesPath: resourcesOf(exePath),
      exists: vfs([bundledManifestOf(exePath)]),
      removableDrives: drives,
    });

    expect(result.target).toBe(appDataDirOn(DRIVE_E));
    expect(result.reason).toBe('delivery-layout');
    expect(drives).not.toHaveBeenCalled();
  });

  it('⑬ 交付夹套一层包装夹（同事那份 zip 解压出来的形状）也认', () => {
    const exePath = deliveredExe(DRIVE_E, '荣盈魔方U盘交付-0.0.24');
    const result = decide({
      exePath,
      resourcesPath: resourcesOf(exePath),
      exists: vfs([bundledManifestOf(exePath)]),
      removableDrives: () => [],
    });

    expect(result.reason).toBe('delivery-layout');
  });

  it('⑭ 系统盘上的交付夹 ⇒ 仍不动（系统盘闸门在判据**之前**，一个文件都不看）', () => {
    const exePath = deliveredExe(DRIVE_C);
    const exists = vi.fn(() => true);
    const result = decide({ exePath, resourcesPath: resourcesOf(exePath), exists, removableDrives: () => [] });

    expect(result.target).toBeNull();
    expect(result.reason).toBeNull();
    expect(exists).not.toHaveBeenCalled();
  });

  it('⑮ 埋得太深 / 装在 Program Files ⇒ 不动（交付说明是"解压到盘根"）', () => {
    for (const dir of [
      WIN.join('E:\\', '下载', '解压到这里', '荣盈魔方'),
      WIN.join('E:\\', 'Program Files', '荣盈魔方'),
    ]) {
      const exePath = WIN.join(dir, '荣盈魔方.exe');
      const result = decide({
        exePath,
        resourcesPath: resourcesOf(exePath),
        exists: vfs([bundledManifestOf(exePath)]),
        removableDrives: () => [],
      });
      expect(result.target).toBeNull();
    }
  });

  it('⑯ 两份判据不许打架：同一组事实，数据侧与工作区侧结论必须一致', () => {
    const exePath = deliveredExe(DRIVE_E);
    const facts = vfs([bundledManifestOf(exePath)]);
    const data = decidePortableAppData({
      exePath,
      isPackaged: true,
      defaultUserData: appDataOn(DRIVE_C),
      systemDrive: DRIVE_C,
      resourcesPath: resourcesOf(exePath),
      exists: facts,
      removableDrives: () => [],
    });
    const run = detectPortableRun({
      exePath,
      removableDrives: [],
      resourcesPath: resourcesOf(exePath),
      exists: facts,
    });

    expect(run.portable).toBe(true);
    expect(data.target).not.toBeNull();
  });
});

describe('applyPortableAppData', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeApp() {
    const setPath = vi.fn();
    return {
      setPath,
      app: { getPath: vi.fn(() => appDataOn(DRIVE_C)), setPath },
    };
  }

  it('⑨ 生效时把 userData / sessionData / logs 都指到盘上，且先把目录建出来', () => {
    const mkdir = vi.fn();
    const { app, setPath } = makeApp();
    const result = applyPortableAppData({
      app,
      exePath: exeOn(DRIVE_E),
      isPackaged: true,
      systemDrive: DRIVE_C,
      exists: vfs([WIN.join(DRIVE_E, MANIFEST)]),
      removableDrives: () => [],
      mkdir,
    });

    const target = appDataDirOn(DRIVE_E);
    expect(result.target).toBe(target);
    // ⚠️ `setPath` 要求目录**已经存在**（Electron 会抛）——logs 也是。
    expect(mkdir.mock.calls.map((c) => c[0])).toEqual([target, WIN.join(target, 'logs')]);
    expect(setPath.mock.calls).toEqual([
      ['userData', target],
      ['sessionData', target],
      ['logs', WIN.join(target, 'logs')],
    ]);
  });

  it('⑩ 目录建不出来（只读盘/没权限）⇒ 回落本机默认，不抛、也不 setPath', () => {
    const mkdir = vi.fn(() => {
      throw new Error('EPERM: read-only file system');
    });
    const { app, setPath } = makeApp();
    const result = applyPortableAppData({
      app,
      exePath: exeOn(DRIVE_E),
      isPackaged: true,
      systemDrive: DRIVE_C,
      exists: vfs([WIN.join(DRIVE_E, MANIFEST)]),
      removableDrives: () => [],
      mkdir,
    });

    expect(result.target).toBeNull();
    expect(result.failed).toContain('EPERM');
    expect(setPath).not.toHaveBeenCalled();
  });

  it('⑪ 非盘上形态 ⇒ 一次 setPath 都不调用（与 user-data-override 同一条硬要求）', () => {
    const mkdir = vi.fn();
    const { app, setPath } = makeApp();
    const result = applyPortableAppData({
      app,
      exePath: exeOn(DRIVE_C),
      isPackaged: true,
      systemDrive: DRIVE_C,
      exists: () => false,
      removableDrives: () => [],
      mkdir,
    });

    expect(result.target).toBeNull();
    expect(setPath).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ 这条钉的是**真机上的那条路**：`index.ts` 传进来的就是 `process.resourcesPath`，
   *    而交付形态（盘根没 marker）**只能**靠它认出来。少了这个透传，同事那块盘上
   *    userData 仍旧留在本机（登录态/设备私钥/日志/缓存全在本机，换台机器就要重新登录）
   *    —— 其余用例走的都是盘根 marker，测不到这个透传。
   */
  it('⑰ 交付形态（盘根没 marker）+ resourcesPath ⇒ 一样把 userData 搬上盘', () => {
    const mkdir = vi.fn();
    const { app, setPath } = makeApp();
    const exePath = WIN.join(DRIVE_E, '荣盈魔方U盘交付-0.0.24', '荣盈魔方', '荣盈魔方.exe');
    const resourcesPath = WIN.join(WIN.dirname(exePath), 'resources');

    const result = applyPortableAppData({
      app,
      exePath,
      isPackaged: true,
      systemDrive: DRIVE_C,
      resourcesPath,
      exists: vfs([WIN.join(resourcesPath, 'runtime', MANIFEST)]),
      removableDrives: () => [],
      mkdir,
    });

    const target = appDataDirOn(DRIVE_E);
    expect(result.reason).toBe('delivery-layout');
    expect(result.target).toBe(target);
    expect(setPath.mock.calls).toEqual([
      ['userData', target],
      ['sessionData', target],
      ['logs', WIN.join(target, 'logs')],
    ]);
  });
});
