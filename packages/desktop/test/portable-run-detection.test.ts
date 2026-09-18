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
const exeOn = (drive: string): string => WIN.join(drive, '荣盈魔方便携版', '荣盈魔方.exe');

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
      exists: vfs([WIN.join(DRIVE_E, '荣盈魔方便携版', MANIFEST)]),
    });

    expect(result.portable).toBe(false);
    expect(result.reason).toBeNull();
  });

  it('④ 本机安装形态（C 盘 exe，盘根也没有 marker）⇒ 不是盘上运行', () => {
    const result = detectPortableRun({
      exePath: WIN.join(DRIVE_C, 'Users', 'u', 'AppData', 'Local', 'Programs', 'rongying', '荣盈魔方.exe'),
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

  it('盘上工作区路径 = <盘根>\\荣盈魔方工作区', () => {
    expect(portableWorkspacePathFor('E:\\')).toBe(WIN.join('E:\\', PORTABLE_WORKSPACE_DIR_NAME));
    expect(portableWorkspacePathFor('E:')).toBe(WIN.join('E:\\', PORTABLE_WORKSPACE_DIR_NAME));
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
