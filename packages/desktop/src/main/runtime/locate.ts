/**
 * 找运行时**部署源**（U 盘 / 环境变量 / 配置 / dev 的 `runtime-out/`）。
 *
 * ⚠️ 注意区分两个概念，混起来是最容易出的错：
 *   - **部署源**（本模块）：盘上那份 128MB 的包，只在**首次部署**时读它。
 *   - **本机缓存**（`deploy.ts`）：`deployed/<key>/`，运行期**只用它**。
 * 本模块找的是前者。后者由 `readCurrentDeployment()` 用 `current.json` 定位 ——
 * 那也是「拔盘后继续跑」走的那条路。
 *
 * ⚠️ **靠 marker 文件认盘，不靠卷标、不靠目录名**：卷标是用户随便改的，
 * 目录名在荣盈那代产品里已经变过。`<root>/openclaw-runtime-manifest.json` 存在
 * 才是"这里有一份运行时"。
 *
 * ⚠️ **不用 `wmic`**：Win11 24H2 已移除。用 PowerShell 的 CIM 查询。
 *
 * 本模块的判定逻辑全是纯函数（`exists` 注入）—— 「静默用了错的那份运行时」
 * 只有把顺序钉死才查得出来。
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** 认盘的 marker 文件名（`pack-runtime.mjs` 产出的就是它）。 */
export const RUNTIME_MANIFEST_FILE = 'openclaw-runtime-manifest.json';

/** dev 形态下运行时包所在的目录名（`pack-runtime.mjs` 的默认输出）。 */
export const DEV_RUNTIME_DIR_NAME = 'runtime-out';

/**
 * 候选来源。顺序即优先级，也决定错误措辞。
 *
 * - `env`    —— `CLAWWORK_RUNTIME_DIR`，测试/排障用的最高优先级后门
 * - `config` —— 客户端配置里的 `runtimeDir`
 * - `dev`    —— 从当前目录向上找 `runtime-out/`（**不硬编码层数**）
 * - `drive`  —— 可移动盘根目录（U 盘形态）
 * - `cache`  —— 本机 `current.json` 指向的部署目录（拔盘后走这条）
 */
export type RuntimeRootOrigin = 'env' | 'config' | 'dev' | 'drive' | 'cache';

export interface RuntimeRootCandidate {
  root: string;
  origin: RuntimeRootOrigin;
  /** 该候选上 marker 文件的绝对路径 —— 存在才算命中。 */
  manifestPath: string;
}

function candidate(root: string, origin: RuntimeRootOrigin): RuntimeRootCandidate {
  return { root, origin, manifestPath: path.join(root, RUNTIME_MANIFEST_FILE) };
}

/**
 * 按优先级排出所有部署源候选。
 *
 * ⚠️ 纯函数：调用方把「dev 向上找到的」「枚举出来的盘符」「缓存解析结果」都传进来。
 * 这样"顺序"这件事可以被单测钉死，而不必真的插一个 U 盘。
 */
export function candidateRuntimeRoots(opts: {
  envDir?: string;
  configDir?: string;
  devRoots?: string[];
  drives?: string[];
  cacheRoot?: string;
}): RuntimeRootCandidate[] {
  const out: RuntimeRootCandidate[] = [];
  if (opts.envDir) out.push(candidate(opts.envDir, 'env'));
  if (opts.configDir) out.push(candidate(opts.configDir, 'config'));
  for (const root of opts.devRoots ?? []) out.push(candidate(root, 'dev'));
  for (const root of opts.drives ?? []) out.push(candidate(root, 'drive'));
  if (opts.cacheRoot) out.push(candidate(opts.cacheRoot, 'cache'));
  return out;
}

/** 盘符（`'Z:'`）→ 候选根（`'Z:\'`）。U 盘形态下运行时包**直接放在盘根**。 */
export function buildDriveCandidates(letters: readonly string[]): RuntimeRootCandidate[] {
  return letters.map((letter) => candidate(letter.endsWith('\\') ? letter : `${letter}\\`, 'drive'));
}

/**
 * 从 `startDir` 逐级向上找 `runtime-out/`，**不硬编码层数**。
 *
 * 返回**由近及远**的一串（就近优先）—— 从 `packages/desktop/` 起跑时，
 * 仓库根那份 `runtime-out/` 是第 N 层，写死 N 迟早在重构后失效。
 */
export function findDevRuntimeRoots(startDir: string, exists: (p: string) => boolean = existsSync): string[] {
  const found: string[] = [];
  let dir = path.resolve(startDir);
  for (;;) {
    const root = path.join(dir, DEV_RUNTIME_DIR_NAME);
    if (exists(path.join(root, RUNTIME_MANIFEST_FILE))) found.push(root);

    const parent = path.dirname(dir);
    if (parent === dir) return found; // 到根了
    dir = parent;
  }
}

/** 第一个 marker 真的存在的候选；一个都没有 ⇒ null（调用方据此要求插盘）。 */
export function findRuntimeRoot(
  candidates: readonly RuntimeRootCandidate[],
  exists: (p: string) => boolean = existsSync,
): RuntimeRootCandidate | null {
  for (const c of candidates) {
    if (exists(c.manifestPath)) return c;
  }
  return null;
}

/**
 * 枚举可移动盘（U 盘）盘符，**倒序**（Z → A）。
 *
 * ⚠️ 用 PowerShell 的 CIM 查询，**不能用 `wmic`**（Win11 24H2 已移除，调用会直接失败）。
 * 超时放 5s：这个调用在启动路径上，不能让它拖住窗口。
 *
 * ⚠️ 枚举失败**不是错误**：返回空数组，让调用方继续往下走（后面还有盘符兜底）。
 * 启动路径上的探测器不该让整个启动失败。
 */
export function listRemovableDrives(opts: { timeoutMs?: number } = {}): string[] {
  const { timeoutMs = 5000 } = opts;
  if (process.platform !== 'win32') return [];

  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // DriveType 2 = 可移动磁盘；只要盘符，别的属性一概不要
        'Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -eq 2 } | ForEach-Object { $_.DeviceID }',
      ],
      { encoding: 'utf-8', timeout: timeoutMs, windowsHide: true },
    );
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[A-Za-z]:$/.test(line))
      .sort()
      .reverse(); // Z → A，顺序稳定（枚举顺序本身不保证）
  } catch (err) {
    console.error('[runtime] 枚举可移动盘失败（继续走盘符兜底）:', err);
    return [];
  }
}

/**
 * 盘符兜底：从 Z 倒着找 marker。
 *
 * ⚠️ 只做 `existsSync` 探测，**不列目录、不读盘内容** —— 空的软驱/读卡器槽位
 * 在这个调用上会立刻返回 false，不会卡住。
 */
export function fallbackDriveCandidates(
  exists: (p: string) => boolean = existsSync,
  letters: readonly string[] = 'ZYXWVUTSRQPONMLKJIHGFED'.split(''),
): RuntimeRootCandidate[] {
  return buildDriveCandidates(letters).filter((c) => exists(c.manifestPath));
}
