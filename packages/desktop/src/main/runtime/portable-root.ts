/**
 * 「盘上运行」的**唯一**根路径解析器（BUG-041 ①）。
 *
 * 背景（为什么要有这个文件）：同一个"盘根"以前被好几处各算各的 ——
 * `workspace/config.ts` 里那个 `getPortableWorkspaceRoot()` 起的其实是**盘根**的名字
 * （`E:\`），真工作区是 `<盘根>\Partner-W工作区\`；应用数据、state、缓存、日志、临时
 * 目录又各自在别的模块里现拼。名字一混，调用方就会把"盘根"当成"工作区"用。
 *
 * 现在：**判定仍然只有一处** —— `workspace/portable.ts` 的 `detectPortableRun`
 * （交付夹形状 / DriveType=2 / 盘根 marker，三条判据的顺序与理由见那个文件）；
 * 本模块只做两件事：① 把判定结果固化成一组**冻结**的根；② 进程内缓存一次。
 *
 * ```
 * volumeRoot     E:\
 * programDir     E:\Partner-W
 * dataRoot       E:\Partner-W-运行数据            （userData/sessionData/logs/temp 的家）
 * stateRoot      E:\Partner-W-运行数据\state      （各身份 state 的父目录）
 * workspaceRoot  E:\Partner-W工作区              （用户资料，**不是** dataRoot）
 * cacheRoot      E:\Partner-W-运行数据\portable-runtime-cache（随包运行时的部署缓存）
 * logsRoot       E:\Partner-W-运行数据\logs
 * tempRoot       E:\Partner-W-运行数据\tmp       （网关子进程的 TEMP/TMP，见 gateway-process）
 * ```
 *
 * ⚠️ 惰性计算（没人显式 set 过时）**不枚举可移动盘**：那是一次 PowerShell（秒级），
 *    而权威判定发生在 `workspace/startup.ts`（那里才 enumeration）。这里的兜底只为
 *    "有人没等启动就把默认值读走了"这种边角 —— 盘根 marker/交付夹形状两条纯文件判据
 *    已经覆盖绝大多数盘。
 */

import fs from 'node:fs';
import path from 'node:path';
import { PORTABLE_APP_DATA_DIR_NAME } from './portable-app-data.js';
import {
  detectPortableRun,
  normalizeVolumeRoot,
  PORTABLE_WORKSPACE_DIR_NAME,
  type PortableRunInput,
} from '../workspace/portable.js';

/** 便携运行时部署缓存目录名（`runtime/cache-scope.ts` 的 `runtimeCacheScopeDir` 同款）。 */
export const PORTABLE_CACHE_DIR_NAME = 'portable-runtime-cache';

export interface PortableRoots {
  volumeRoot: string;
  programDir: string;
  dataRoot: string;
  stateRoot: string;
  workspaceRoot: string;
  cacheRoot: string;
  logsRoot: string;
  tempRoot: string;
}

function P(): typeof path.win32 {
  return process.platform === 'win32' ? path.win32 : path.posix;
}

/** 盘根 + 程序目录 ⇒ 八个根（**纯派生**，判定在外面做）。 */
export function rootsForVolumeRoot(volumeRoot: string, programDir: string): PortableRoots {
  const root = normalizeVolumeRoot(volumeRoot) ?? volumeRoot;
  const join = (...parts: string[]): string => P().join(...parts);
  const dataRoot = join(root, PORTABLE_APP_DATA_DIR_NAME);

  return Object.freeze({
    volumeRoot: root,
    programDir,
    dataRoot,
    stateRoot: join(dataRoot, 'state'),
    workspaceRoot: join(root, PORTABLE_WORKSPACE_DIR_NAME),
    cacheRoot: join(dataRoot, PORTABLE_CACHE_DIR_NAME),
    logsRoot: join(dataRoot, 'logs'),
    tempRoot: join(dataRoot, 'tmp'),
  });
}

/**
 * 判定 + 派生（**纯函数**：`exePath` / `resourcesPath` / 盘列表 / `exists` 全注入）。
 * 不是盘上形态 ⇒ `null`（本机安装与 dev 形态一步都不派生）。
 */
export function resolvePortableRoots(input: PortableRunInput): PortableRoots | null {
  const detection = detectPortableRun(input);
  if (!detection.portable || !detection.volumeRoot) return null;
  return rootsForVolumeRoot(detection.volumeRoot, P().dirname(input.exePath));
}

/** `null` + `resolved` 一起记：显式判成"不是盘上"之后**不许**再惰性重算。 */
let cached: PortableRoots | null = null;
let resolved = false;

/** 显式灌入判定结果（`workspace/startup.ts` 在启动时调；也是最权威的那一次）。 */
export function setPortableRoots(roots: PortableRoots | null): void {
  cached = roots;
  resolved = true;
}

/**
 * 只给"盘根"时的薄封装（老调用点 `setPortableWorkspaceRoot(root)` 走这里）：
 * 其余根一律从盘根派生，避免调用方各自拼路径。
 */
export function setPortableVolumeRoot(volumeRoot: string | null): void {
  setPortableRoots(volumeRoot ? rootsForVolumeRoot(volumeRoot, P().dirname(process.execPath)) : null);
}

/** 盘上运行的根（进程内缓存一次）；不是盘上形态 ⇒ `null`。 */
export function getPortableRoots(): PortableRoots | null {
  if (resolved) return cached;
  resolved = true;
  cached = resolvePortableRoots({
    exePath: process.execPath,
    resourcesPath: process.resourcesPath ?? null,
    // ⚠️ 惰性兜底**不枚举盘**（PowerShell 秒级）；权威判定在 startup.ts。
    removableDrives: [],
    exists: (p) => fs.existsSync(p),
  });
  return cached;
}

/** 只给测试：清掉缓存，回到"还没判过"的状态。 */
export function resetPortableRootsCache(): void {
  cached = null;
  resolved = false;
}
