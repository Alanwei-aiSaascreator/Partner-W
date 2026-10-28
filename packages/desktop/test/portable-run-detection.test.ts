/**
 * 「是不是从盘上运行」的判定（T-U1）。
 *
 * ⚠️ 全部是纯函数（`exists` / 盘列表 / exe 路径注入）—— 本机插不了 U 盘，
 *    也不能在单测里换盘符。用虚拟文件系统（一个路径集合）代替真盘。
 * ⚠️ `vi.spyOn(process, 'platform')` 把路径风格钉成 win32（仓库里既有的写法，
 *    见 `workspace-init.test.ts`）：盘符判据是 Windows 专有的，不能在别的平台"跳过"。
 */

import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detectPortableRun,
  isPortableRun,
  portableWorkspacePathFor,
  deriveWorkspaceRelPath,
  describeWorkspaceLocation,
  volumeRootOf,
  WORKSPACE_MARKER_FILE,
  PORTABLE_WORKSPACE_DIR_NAME,
} from '../src/main/workspace/portable.js';

const MANIFEST = 'openclaw-runtime-manifest.json';
const WIN = path.win32;
const DRIVE_E = 'E:\\';
const DRIVE_C = 'C:\\';
const exeOn = (drive: string): string => WIN.join(drive, 'Partner-W便携版', 'Partner-W.exe');

/** 虚拟文件系统：只回答"这个路径在不在"。 */
function vfs(paths: readonly string[]): (p: string) => boolean {
  const set = new Set(paths.map((p) => WIN.normalize(p).toLowerCase()));
  return (p) => set.has(WIN.normalize(p).toLowerCase());
}

describe('detectPortableRun', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('① exe 在可移动盘上 ⇒ 盘上运行（DriveType=2）', () => {
    const result = detectPortableRun({
      exePath: exeOn(DRIVE_E),
      removableDrives: ['E:'],
      exists: vfs([]),
    });

    expect(result).toEqual({ portable: true, volumeRoot: 'E:\\', reason: 'removable-drive' });
  });

  it('② 盘根有 marker ⇒ 盘上运行（哪怕盘列表是空的）', () => {
    // 这一条是**枚举失败**的兜底：listRemovableDrives() 出错时返回空数组，
    // 少了 ② 就会被误判成安装形态，用户又回到"要选盘"。
    const result = detectPortableRun({
      exePath: exeOn(DRIVE_E),
      removableDrives: [],
      exists: vfs([WIN.join(DRIVE_E, MANIFEST)]),
    });

    expect(result).toEqual({ portable: true, volumeRoot: 'E:\\', reason: 'volume-marker' });
  });

  it('③ marker 只在子目录、不在盘根 ⇒ 不算（认盘必须认盘根）', () => {
    const result = detectPortableRun({
      exePath: exeOn(DRIVE_E),
      removableDrives: [],
      exists: vfs([WIN.join(DRIVE_E, 'Partner-W便携版', MANIFEST)]),
    });

    expect(result.portable).toBe(false);
    expect(result.reason).toBeNull();
  });

  it('④ 本机安装形态（C 盘 exe，盘根也没有 marker）⇒ 不是盘上运行', () => {
    const result = detectPortableRun({
      exePath: WIN.join(DRIVE_C, 'Users', 'u', 'AppData', 'Local', 'Programs', 'partner-w', 'Partner-W.exe'),
      removableDrives: ['E:', 'F:'],
      exists: vfs([WIN.join(DRIVE_C, 'Windows')]),
    });

    expect(result).toEqual({ portable: false, volumeRoot: 'C:\\', reason: null });
  });

  it('⑤ dev 形态（C 盘上的 electron.exe）⇒ 不是盘上运行', () => {
    expect(
      isPortableRun({
        exePath: WIN.join(DRIVE_C, 'proj', 'node_modules', 'electron', 'dist', 'electron.exe'),
        removableDrives: [],
        exists: vfs([]),
      }),
    ).toBe(false);
  });

  it('盘列表写成 `E:` 或 `E:\\` 都认（枚举结果的大小写也不敏感）', () => {
    for (const drives of [['E:'], ['E:\\'], ['e:'], ['E:\\', 'F:']]) {
      expect(detectPortableRun({ exePath: exeOn(DRIVE_E), removableDrives: drives, exists: vfs([]) }).portable).toBe(
        true,
      );
    }
  });

  it('exe 路径给不出盘根（相对路径）⇒ 判否、且不误报 volumeRoot', () => {
    expect(detectPortableRun({ exePath: 'relative\\app.exe', removableDrives: ['E:'], exists: vfs([]) })).toEqual({
      portable: false,
      volumeRoot: null,
      reason: null,
    });
  });

  it('盘上工作区路径 = <盘根>\\Partner-W工作区', () => {
    expect(portableWorkspacePathFor('E:\\')).toBe(WIN.join('E:\\', PORTABLE_WORKSPACE_DIR_NAME));
    expect(portableWorkspacePathFor('E:')).toBe(WIN.join('E:\\', PORTABLE_WORKSPACE_DIR_NAME));
  });
});

/**
 * 交付形态判据（`delivery-layout`）—— 治的是**判据全落空**这件事。
 *
 * 现场（2026-09-20 同事那份 0.0.24 交付包）：交付说明让用户"解压到 U 盘根目录"，
 * 而不少 U 盘/移动固态/读卡器报 `DriveType=3`（固定盘）⇒ "枚举可移动盘"那一条
 * **永远不命中**；盘根 marker 又是说明里叮嘱"千万别拷"的文件 ⇒ 两条判据全落空，
 * 数据与工作区都留在本机，换台机器/换个口就是「找不到工作区」。
 *
 * 这一条只认**我们自己的交付夹形状**（实测于真交付包
 * `…\Partner-WU盘交付-0.0.24\Partner-W\`：exe 旁边就是 `resources\runtime\openclaw-runtime-manifest.json`），
 * 不认卷标、不认目录名 —— 与既有的"认盘只认 marker 与 DriveType"同一条纪律。
 */
describe('交付形态判据（delivery-layout）', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const deliveredExe = (drive: string, wrapper?: string): string =>
    WIN.join(drive, ...(wrapper ? [wrapper] : []), 'Partner-W', 'Partner-W.exe');
  const resourcesOf = (exePath: string): string => WIN.join(WIN.dirname(exePath), 'resources');
  const bundledManifestOf = (exePath: string): string => WIN.join(resourcesOf(exePath), 'runtime', MANIFEST);

  it('① 交付夹在盘根下一层、夹子里带着随包运行时 ⇒ 盘上运行（DriveType≠2 的盘也能认）', () => {
    const exePath = deliveredExe(DRIVE_E);
    const result = detectPortableRun({
      exePath,
      removableDrives: [],
      resourcesPath: resourcesOf(exePath),
      exists: vfs([bundledManifestOf(exePath)]),
    });

    expect(result).toEqual({ portable: true, volumeRoot: 'E:\\', reason: 'delivery-layout' });
  });

  it('② 套一层包装夹（同事那份 zip 解压出来的形状）也算', () => {
    const exePath = deliveredExe(DRIVE_E, 'Partner-WU盘交付-0.0.24');
    const result = detectPortableRun({
      exePath,
      removableDrives: [],
      resourcesPath: resourcesOf(exePath),
      exists: vfs([bundledManifestOf(exePath)]),
    });

    expect(result.portable).toBe(true);
    expect(result.reason).toBe('delivery-layout');
  });

  it('③ 埋得太深（≥3 层）⇒ 不算：交付说明是"解压到盘根"，本机开发树/构建产物也都在深目录里', () => {
    const exePath = deliveredExe(DRIVE_E, WIN.join('下载', '解压到这里'));
    const result = detectPortableRun({
      exePath,
      removableDrives: [],
      resourcesPath: resourcesOf(exePath),
      exists: vfs([bundledManifestOf(exePath)]),
    });

    expect(result.portable).toBe(false);
    expect(result.reason).toBeNull();
  });

  it('④ 装到电脑的常见位置（Program Files / AppData\\…\\Programs）⇒ 不算，哪怕夹子里带着随包运行时', () => {
    for (const dir of [
      WIN.join(DRIVE_C, 'Program Files', 'Partner-W'),
      WIN.join(DRIVE_C, 'Program Files (x86)', 'Partner-W'),
      WIN.join(DRIVE_C, 'Users', 'u', 'AppData', 'Local', 'Programs', 'Partner-W'),
      // 非系统盘上的 Program Files：系统盘闸门救不了它，靠位置判据
      WIN.join('E:\\', 'Program Files', 'Partner-W'),
    ]) {
      const exePath = WIN.join(dir, 'Partner-W.exe');
      const result = detectPortableRun({
        exePath,
        removableDrives: [],
        resourcesPath: resourcesOf(exePath),
        exists: vfs([bundledManifestOf(exePath)]),
      });
      expect(result.portable).toBe(false);
    }
  });

  it('⑤ 夹子里**没有**随包运行时（只是碰巧同名/壳）⇒ 不算（不猜）', () => {
    const exePath = deliveredExe(DRIVE_E);
    const result = detectPortableRun({
      exePath,
      removableDrives: [],
      resourcesPath: resourcesOf(exePath),
      exists: vfs([WIN.join(DRIVE_E, 'Windows')]),
    });

    expect(result.portable).toBe(false);
  });

  it('⑥ 没给 resourcesPath ⇒ 不算（看不见自己那份运行时就不认，不靠路径名猜）', () => {
    const exePath = deliveredExe(DRIVE_E);
    const result = detectPortableRun({
      exePath,
      removableDrives: [],
      exists: vfs([bundledManifestOf(exePath)]),
    });

    expect(result.portable).toBe(false);
  });

  it('⑦ resourcesPath 指的不是 exe 自己那份（父子关系不成立）⇒ 不算', () => {
    const exePath = deliveredExe(DRIVE_E);
    const result = detectPortableRun({
      exePath,
      removableDrives: [],
      resourcesPath: WIN.join(DRIVE_E, '别的地方', 'resources'),
      exists: vfs([WIN.join(DRIVE_E, '别的地方', 'resources', 'runtime', MANIFEST)]),
    });

    expect(result.portable).toBe(false);
  });

  it('⑧ 判据优先级：交付夹形状也在可移动盘上时，reason 说"交付夹"（更具体的那条）', () => {
    const exePath = deliveredExe(DRIVE_E);
    const result = detectPortableRun({
      exePath,
      removableDrives: ['E:'],
      resourcesPath: resourcesOf(exePath),
      exists: vfs([bundledManifestOf(exePath)]),
    });

    expect(result.reason).toBe('delivery-layout');
  });
});

describe('工作区位置线索（workspaceRelPath / volumeMarker）', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const workspaceOnE = WIN.join('E:\\', PORTABLE_WORKSPACE_DIR_NAME);

  it('可移动盘上的工作区：补记相对路径 + 盘根 marker', () => {
    const location = describeWorkspaceLocation({
      workspacePath: workspaceOnE,
      removableDrives: ['E:'],
      exists: vfs([WIN.join('E:\\', MANIFEST)]),
    });

    expect(location).toEqual({ workspaceRelPath: PORTABLE_WORKSPACE_DIR_NAME, volumeMarker: MANIFEST });
  });

  it('盘根没有 marker 时只记相对路径（不假装记了一个不存在的 marker）', () => {
    const location = describeWorkspaceLocation({
      workspacePath: workspaceOnE,
      removableDrives: ['E:'],
      exists: vfs([]),
    });

    expect(location.workspaceRelPath).toBe(PORTABLE_WORKSPACE_DIR_NAME);
    expect(location.volumeMarker).toBeUndefined();
  });

  it('本机固定盘上的工作区：**不记**线索（否则删了目录会变成"让你选盘"）', () => {
    const location = describeWorkspaceLocation({
      workspacePath: WIN.join('C:\\', 'Users', 'u', 'ClawWork-Workspace'),
      removableDrives: ['E:'],
      exists: vfs([WIN.join('E:\\', MANIFEST)]),
    });

    expect(location).toEqual({});
  });

  it('工作区在「程序自己运行的那块盘」上（交付形态、DriveType≠2）⇒ 也记线索', () => {
    // 为什么不记就是 bug：交付形态判出来 portable 之后，工作区就落在 `<盘根>\Partner-W工作区\`，
    // 而这时的 `removableDrives` 是**空数组**（DriveType=3）⇒ 老判据一条线索都不记
    // ⇒ 换个 USB 口（盘符变了）就是零候选 ⇒ 又是「找不到工作区」。这正是同事那份的症状链。
    const location = describeWorkspaceLocation({
      workspacePath: workspaceOnE,
      removableDrives: [],
      runVolumeRoot: 'E:\\',
      exists: vfs([]),
    });

    expect(location).toEqual({ workspaceRelPath: PORTABLE_WORKSPACE_DIR_NAME });
  });

  it('工作区不在「程序自己运行的那块盘」上 ⇒ 仍不记（可移动盘判据照旧）', () => {
    const location = describeWorkspaceLocation({
      workspacePath: workspaceOnE,
      removableDrives: [],
      runVolumeRoot: 'F:\\',
      exists: vfs([]),
    });

    expect(location).toEqual({});
  });

  it('本机安装形态（portableRoot 为 null）+ 工作区在本机固定盘 ⇒ 一个字段都不记（边界不动）', () => {
    const location = describeWorkspaceLocation({
      workspacePath: WIN.join('C:\\', 'Users', 'u', 'ClawWork-Workspace'),
      removableDrives: [],
      runVolumeRoot: null,
      exists: vfs([]),
    });

    expect(location).toEqual({});
  });

  it('相对路径推导：深层目录也算得出来', () => {
    expect(deriveWorkspaceRelPath(WIN.join('E:\\', 'a', 'b'))).toBe(WIN.join('a', 'b'));
    expect(deriveWorkspaceRelPath(WIN.join('E:\\', PORTABLE_WORKSPACE_DIR_NAME))).toBe(PORTABLE_WORKSPACE_DIR_NAME);
  });

  it('工作区自身标记文件名与盘根 marker 是两个不同的判据', () => {
    expect(WORKSPACE_MARKER_FILE).toBe('.clawwork-workspace.json');
    expect(WORKSPACE_MARKER_FILE).not.toBe(MANIFEST);
  });

  it('volumeRootOf', () => {
    expect(volumeRootOf(WIN.join('E:\\', 'a', 'b'))).toBe('E:\\');
    expect(volumeRootOf('E:')).toBe('E:\\');
    expect(volumeRootOf('')).toBeNull();
  });
});
