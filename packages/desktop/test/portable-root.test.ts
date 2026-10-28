import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BUG-041 ①：**唯一**的"盘上运行"根路径解析器。
 *
 * 起错名的老函数 `getPortableWorkspaceRoot()` 实际返回的是**盘根**（`E:\`），
 * 而真正的"工作区"是 `<盘根>\Partner-W工作区\` —— 名字把两件事搅在一起过。
 * 现在统一从这里出：判定仍由 `detectPortableRun`（单一判据），其余路径全是
 * 从盘根**派生**的常量（数据/状态/缓存/日志/临时），不再各写各的。
 *
 * ⚠️ 判据里的"盘根"必须是**真的卷根**（`depth<=2` 那条），临时目录里造的假盘根
 *    不会命中交付夹形状 —— 所以下面用 subst 造一块真盘来测（Windows only）。
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => 'C:\\fake\\userdata') },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false), encryptString: vi.fn(), decryptString: vi.fn() },
}));

import {
  PORTABLE_CACHE_DIR_NAME,
  getPortableRoots,
  resolvePortableRoots,
  resetPortableRootsCache,
  rootsForVolumeRoot,
  setPortableRoots,
  setPortableVolumeRoot,
} from '../src/main/runtime/portable-root.js';
import { getPortableWorkspaceRoot, setPortableWorkspaceRoot } from '../src/main/workspace/config.js';

let root = '';
let drive: string | null = null;
const subst = (args: string[]): void => {
  execFileSync('subst', args, { windowsHide: true, stdio: 'ignore' });
};

beforeEach(() => {
  resetPortableRootsCache();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-root-test-'));
});

afterEach(() => {
  resetPortableRootsCache();
  vi.restoreAllMocks();
  if (drive) {
    try {
      subst(['/d', drive]);
    } catch {
      /* 没建上就算了 */
    }
    drive = null;
  }
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()))) fs.rmSync(root, { recursive: true, force: true });
});

/** 造一块真盘（subst），返回盘根（`W:\`）；建不上返回 null（环境限制）。 */
function fakeDisk(): string | null {
  if (process.platform !== 'win32') return null;
  const target = path.join(root, 'disk');
  fs.mkdirSync(target, { recursive: true });
  for (const letter of ['W:', 'V:', 'U:']) {
    try {
      subst([letter, target]);
      drive = letter;
      return `${letter}\\`;
    } catch {
      /* 这个盘符被占了，换一个 */
    }
  }
  return null;
}

describe('resolvePortableRoots（判定 + 派生）', () => {
  it.runIf(process.platform === 'win32')('⭐ 交付夹形状 ⇒ 八个根全派生出来，且冻结', () => {
    const volumeRoot = fakeDisk();
    if (!volumeRoot) return;
    const programDir = path.join(volumeRoot, 'Partner-W');
    const resourcesPath = path.join(programDir, 'resources');
    const manifest = path.join(resourcesPath, 'runtime', 'openclaw-runtime-manifest.json');
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, '{}');

    const roots = resolvePortableRoots({
      exePath: path.join(programDir, 'Partner-W.exe'),
      resourcesPath,
      removableDrives: [],
      exists: (p) => fs.existsSync(p),
    });

    expect(roots).not.toBeNull();
    const expected = rootsForVolumeRoot(volumeRoot, programDir);
    expect(roots).toEqual(expected);
    expect(roots).toMatchObject({
      dataRoot: path.join(volumeRoot, 'Partner-W-运行数据'),
      stateRoot: path.join(volumeRoot, 'Partner-W-运行数据', 'state'),
      workspaceRoot: path.join(volumeRoot, 'Partner-W工作区'),
      cacheRoot: path.join(volumeRoot, 'Partner-W-运行数据', PORTABLE_CACHE_DIR_NAME),
      logsRoot: path.join(volumeRoot, 'Partner-W-运行数据', 'logs'),
      tempRoot: path.join(volumeRoot, 'Partner-W-运行数据', 'tmp'),
    });
    expect(Object.isFrozen(roots)).toBe(true);
  });

  it.runIf(process.platform === 'win32')(
    '⭐ 只有盘根 marker 也算盘上（认盘只认 marker 与 DriveType，不认卷标）',
    () => {
      const volumeRoot = fakeDisk();
      if (!volumeRoot) return;
      fs.writeFileSync(path.join(volumeRoot, 'openclaw-runtime-manifest.json'), '{}');
      const roots = resolvePortableRoots({
        exePath: path.join(volumeRoot, '程序', 'Partner-W.exe'),
        resourcesPath: null,
        removableDrives: [],
        exists: (p) => fs.existsSync(p),
      });
      expect(roots?.dataRoot).toBe(path.join(volumeRoot, 'Partner-W-运行数据'));
    },
  );

  it('非盘上形态 ⇒ null（本机安装/dev 一步都不派生）', () => {
    expect(
      resolvePortableRoots({
        exePath: path.join(root, 'somewhere', 'app.exe'),
        resourcesPath: null,
        removableDrives: [],
        exists: () => false,
      }),
    ).toBeNull();
  });
});

describe('进程内缓存与 config 的**兼容壳**', () => {
  it('⭐ setPortableRoots 之后 getPortableRoots 返回同一份（判定只做一次）', () => {
    const roots = rootsForVolumeRoot('E:\\', 'E:\\Partner-W');
    setPortableRoots(roots);
    expect(getPortableRoots()).toBe(roots);
  });

  it('⭐ 显式判成"不是盘上"（null）⇒ 不再惰性重算（否则启动时说 not portable、后面又变 portable）', () => {
    setPortableRoots(null);
    expect(getPortableRoots()).toBeNull();
  });

  it('⭐ 起错名的 getPortableWorkspaceRoot() 实际=**盘根**（薄壳，别再让调用方猜）', () => {
    setPortableWorkspaceRoot('E:\\');
    expect(getPortableWorkspaceRoot()).toBe('E:\\');
    // 真工作区在 roots 里是另一个名字 —— 两者不许再混。
    expect(getPortableRoots()?.workspaceRoot).toBe('E:\\Partner-W工作区');
    expect(getPortableRoots()?.dataRoot).toBe('E:\\Partner-W-运行数据');
  });

  it('setPortableVolumeRoot(null) ⇒ 盘根为空（工作区默认值回落到本机 homedir 那份）', () => {
    setPortableVolumeRoot(null);
    expect(getPortableWorkspaceRoot()).toBeNull();
    expect(getPortableRoots()).toBeNull();
  });
});
