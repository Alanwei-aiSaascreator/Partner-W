/**
 * 盘上运行时：**应用数据跟着盘走**（把 userData 指到 U 盘里）。
 *
 * 为什么是产品行为而不是可选项（三条一起看才成立）：
 *
 * ① **数据跟盘走**。改之前：工作区在盘上（对的），可 userData 一直留在
 *    `%APPDATA%\@clawwork\desktop` —— 登录态、设备私钥、日志、Chromium 缓存
 *    全在本机。换台机器 = 重新登录 + 日志断档，且本机上永远留着一份残留。
 * ② **便携版与安装版不再抢同一个实例**。单实例锁是**按 userData 目录**算的，
 *    两份共用一个 userData ⇒ 先开的那份活着时，双击 U 盘里那份**静默退出**
 *    （点了没反应）。这也正是交付包里那个 `.bat` 唯一在做的事（它拿 tasklist
 *    查一遍再给一句人话）。userData 分开之后，双份可以并存，`.bat` 就没有存在
 *    的理由了 —— 用户直接双击 `荣盈魔方\荣盈魔方.exe` 即可。
 * ③ **运行时只部署一次**。`computeDeploymentKey()` 只由「运行时版本 + node 版本
 *    + 平台」决定，**与机器无关**（见 `runtime/manifest.ts`）——部署在盘上，
 *    此后换任何机器都不用再解压那 20 万个文件（改之前是每台机器重来一遍）。
 *
 * ⚠️ 与 `user-data-override.ts` 的分工（**别把两者合并**）：
 *    那个是 dev/test 的隔离后门，硬要求"打包后一律不认"；这个是打包后的盘上形态。
 *
 * ⚠️ 判定**必须**在所有依赖路径的代码之前（`app.ready` 之前、建窗口之前、
 *    建数据库之前）—— 见 `index.ts` 里的调用点注释。
 *
 * ⚠️ 认盘判据的顺序是**刻意的**：先两条纯文件检查，最后才枚举可移动盘。
 *    枚举是一次 PowerShell 调用（秒级），而它的结果在别处（`removable-drives.ts`）
 *    会被进程内记住 —— 这里少做一次，启动就少等一次。
 *    `detectPortableRun()` 的顺序是"先枚举、后 marker"，那里不能懒（它要一个
 *    确定的 `reason`），本模块要的是"最快能定下来的那个判据"，所以各写各的。
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  isDeliveryLayout,
  isRemovableVolume,
  normalizeVolumeRoot,
  PORTABLE_WORKSPACE_DIR_NAME,
  volumeRootOf,
  WORKSPACE_MARKER_FILE,
} from '../workspace/portable.js';
import { RUNTIME_MANIFEST_FILE } from './locate.js';

/**
 * 盘上运行时应用数据目录名（`<盘根>\荣盈魔方-运行数据\`）。
 *
 * ⚠️ **故意不放进** `荣盈魔方工作区\`：那里是用户的资料，会被文件索引/搜索扫到，
 *    而这里装的是 Chromium 缓存（上万个小文件）、日志、以及 500MB+ 的运行时部署。
 * ⚠️ **故意不放进** `荣盈魔方\`（程序目录）：便携版更新就是把这个目录整个换掉
 *    （`update/portable-swap.ts`），数据放进去会被连带替换掉。
 */
export const PORTABLE_APP_DATA_DIR_NAME = '荣盈魔方-运行数据';

/** 凭什么认为"这是盘上运行"。与 `PortableRunReason` 同名同义（便于日志对照）。 */
export type PortableAppDataReason = 'delivery-layout' | 'removable-drive' | 'volume-marker' | 'workspace-marker';

export interface PortableAppDataInput {
  /** 打包态是 `process.execPath`。 */
  exePath: string;
  isPackaged: boolean;
  /** 当前的 userData（要搬走的那个）。 */
  defaultUserData: string;
  /**
   * 系统的盘（`process.env.SystemDrive`，形如 `'C:'`）。同一个盘 ⇒ 安装形态。
   *
   * ⚠️ 这一条是**性能闸门**，不是判据：C 盘上装的正式版每次启动都不该为了
   *    "看看是不是 U 盘"去开一个 PowerShell。
   */
  systemDrive?: string | null;
  exists: (p: string) => boolean;
  /** 打包态的 `<resources>`（真机上是 `process.resourcesPath`）—— 交付形态判据要用。 */
  resourcesPath?: string | null;
  /** **惰性**的可移动盘列表：只有前几条判据都没命中时才会被调用。 */
  removableDrives: () => readonly string[];
}

export interface PortableAppDataDecision {
  /** 要改成的目录；null = 保持本机 userData 不动。 */
  target: string | null;
  /** exe 所在卷根（找不到盘根时为 null）—— 只为日志说清"看的是哪块盘"。 */
  volumeRoot: string | null;
  reason: PortableAppDataReason | null;
}

function P(): typeof path.win32 {
  return process.platform === 'win32' ? path.win32 : path.posix;
}

/** 盘上应用数据目录 = `<盘根>\荣盈魔方-运行数据\`。 */
export function portableAppDataPathFor(volumeRoot: string): string {
  const root = normalizeVolumeRoot(volumeRoot) ?? volumeRoot;
  return P().join(root, PORTABLE_APP_DATA_DIR_NAME);
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string =>
    P()
      .normalize(p)
      .replace(/[\\/]+$/, '');
  const [x, y] = [norm(a), norm(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** 工作区**自身**的标记文件绝对路径（盘根 → 默认工作区目录）。 */
function workspaceMarkerPathFor(volumeRoot: string): string {
  return P().join(volumeRoot, PORTABLE_WORKSPACE_DIR_NAME, WORKSPACE_MARKER_FILE);
}

function notPortable(volumeRoot: string | null): PortableAppDataDecision {
  return { target: null, volumeRoot, reason: null };
}

/**
 * 该不该把应用数据放到 exe 所在的那块盘上 —— 判定顺序（钉死，改动必须同时改测试）：
 *
 * ```
 * 非打包态                                    ⇒ 不动（dev/CI）
 * exe 推不出盘根                              ⇒ 不动
 * exe 就在系统盘上                            ⇒ 不动（连文件都不看）
 * 盘根有 openclaw-runtime-manifest.json       ⇒ 放盘里（volume-marker）
 * 盘里已有 荣盈魔方工作区\.clawwork-workspace.json ⇒ 放盘里（workspace-marker）
 * exe 自己那份交付夹的形状（isDeliveryLayout）⇒ 放盘里（delivery-layout）
 * exe 的盘在可移动盘列表里                    ⇒ 放盘里（removable-drive）
 * 否则                                        ⇒ 不动
 * ```
 *
 * ⚠️ `delivery-layout` 排在枚举**之前**：它是纯文件检查（不花钱），而枚举是一次
 *    PowerShell（秒级）；更关键的是 `DriveType=3` 的 U 盘/移动固态/读卡器上枚举
 *    **永远不命中** —— 那些盘的判据只剩前面几条（2026-09-20 同事那份交付包的症状链）。
 *
 * ⚠️ `workspace-marker` 那一条是**换盘符之后的主判据**：它由我们自己写（工作区
 *    初始化时），不依赖卷标、不依赖 DriveType、也不依赖盘根那份运行时 ——
 *    盘根 marker 一旦被用户删掉（或那份交付包压根没带），第一次之后仍认得出。
 */
export function decidePortableAppData(input: PortableAppDataInput): PortableAppDataDecision {
  if (!input.isPackaged) return notPortable(null);

  const volumeRoot = volumeRootOf(input.exePath);
  if (!volumeRoot) return notPortable(null);

  const systemRoot = input.systemDrive ? normalizeVolumeRoot(input.systemDrive) : null;
  if (systemRoot && samePath(volumeRoot, systemRoot)) return notPortable(volumeRoot);

  const reason = classify(input, volumeRoot);
  if (!reason) return notPortable(volumeRoot);

  const target = portableAppDataPathFor(volumeRoot);
  // 目标就是当前 userData（例如有人显式 `--user-data-dir=E:\荣盈魔方-运行数据`）
  // ⇒ 不必 setPath，但"这是盘上形态"这个结论仍然报出去（日志要能读明白）。
  if (samePath(target, input.defaultUserData)) return { target: null, volumeRoot, reason };

  return { target, volumeRoot, reason };
}

/** 认盘（顺序见 `decidePortableAppData` 的注释）；认不出来返回 null。 */
function classify(input: PortableAppDataInput, volumeRoot: string): PortableAppDataReason | null {
  if (input.exists(P().join(volumeRoot, RUNTIME_MANIFEST_FILE))) return 'volume-marker';
  if (input.exists(workspaceMarkerPathFor(volumeRoot))) return 'workspace-marker';
  if (isDeliveryLayout({ exePath: input.exePath, resourcesPath: input.resourcesPath, exists: input.exists })) {
    return 'delivery-layout';
  }
  if (isRemovableVolume(volumeRoot, input.removableDrives())) return 'removable-drive';
  return null;
}

export interface PortableAppDataApplyInput extends Omit<PortableAppDataInput, 'defaultUserData'> {
  app: {
    // ⚠️ 只声明真正用到的那三个 path 名（签名宽了 strictFunctionTypes 下传不进真 app）。
    getPath: (name: 'userData') => string;
    setPath: (name: 'userData' | 'sessionData' | 'logs', value: string) => void;
  };
  /** 建目录（注入：测"只读盘"这条退路）。 */
  mkdir?: (dir: string) => void;
}

export interface PortableAppDataApplyResult {
  target: string | null;
  volumeRoot: string | null;
  reason: PortableAppDataReason | null;
  /** 目标建不出来时的人话原因（只进日志，不弹框）。 */
  failed?: string;
}

/**
 * 应用判定（副作用）。返回实际生效的目录，没生效则 `target: null`。
 *
 * ⚠️ **未判定为盘上形态时一次 `setPath` 都不调用** —— 与 `user-data-override.ts`
 *    同一条硬要求（安装形态的启动路径不许被这里碰到）。
 *
 * ⚠️ 建目录失败（只读盘、没权限、盘满了）**不是错误**：回落本机默认目录继续启动，
 *    只把原因记进日志。为了"数据跟盘走"让用户打不开程序，是更坏的结果。
 */
export function applyPortableAppData(opts: PortableAppDataApplyInput): PortableAppDataApplyResult {
  const decision = decidePortableAppData({
    exePath: opts.exePath,
    isPackaged: opts.isPackaged,
    defaultUserData: opts.app.getPath('userData'),
    systemDrive: opts.systemDrive,
    exists: opts.exists,
    resourcesPath: opts.resourcesPath,
    removableDrives: opts.removableDrives,
  });
  if (!decision.target) {
    return { target: null, volumeRoot: decision.volumeRoot, reason: decision.reason };
  }

  const target = decision.target;
  const logsDir = P().join(target, 'logs');
  const mkdir = opts.mkdir ?? ((dir: string): void => void mkdirSync(dir, { recursive: true }));
  try {
    // ⚠️ `setPath` 要求目录**已经存在**（Electron 对不存在的路径会抛）——logs 同样。
    mkdir(target);
    mkdir(logsDir);
  } catch (err) {
    return {
      target: null,
      volumeRoot: decision.volumeRoot,
      reason: decision.reason,
      failed: err instanceof Error ? err.message : String(err),
    };
  }

  opts.app.setPath('userData', target);
  // `sessionData`（Chromium 的 Cache/Storage）默认跟着 userData —— 显式写出来，
  // 免得日后有人只改 userData 却发现缓存还留在本机。
  opts.app.setPath('sessionData', target);
  opts.app.setPath('logs', logsDir);

  return { target, volumeRoot: decision.volumeRoot, reason: decision.reason };
}
