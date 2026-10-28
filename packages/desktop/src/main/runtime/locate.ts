/**
 * 找运行时**部署源**（U 盘 / 环境变量 / 配置 / dev 的 `runtime-out/` / 随包那份）。
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
 *
 * ⚠️ **诊断文本是本模块的交付物之一**（`describeRuntimeSearch`）：2026-09-18 那次
 * 「装上装包也起不来」的事故里，日志只有一句笼统的失败，没人能看出**找过哪些地方**。
 * 「一个来源都没命中」时必须能一眼读出：找过谁、谁连候选都没产生、盘符兜底扫没扫。
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** 认盘的 marker 文件名（`pack-runtime.mjs` 产出的就是它）。 */
export const RUNTIME_MANIFEST_FILE = 'openclaw-runtime-manifest.json';

/** dev 形态下运行时包所在的目录名（`pack-runtime.mjs` 的默认输出）。 */
export const DEV_RUNTIME_DIR_NAME = 'runtime-out';

/** 随安装包自带的那份运行时在 **`<resources>` 下的目录名**（T-U0「fat installer」）。 */
export const BUNDLED_RUNTIME_DIR_NAME = 'runtime';

/**
 * 候选来源。顺序即优先级，也决定错误措辞。
 *
 * - `env`     —— `CLAWWORK_RUNTIME_DIR`，测试/排障用的最高优先级后门
 * - `config`  —— 客户端配置里的 `runtimeDir`
 * - `dev`     —— 从当前目录向上找 `runtime-out/`（**不硬编码层数**）
 * - `drive`   —— 可移动盘根目录（U 盘形态）
 * - `bundled` —— 随安装包自带的那份（`<resources>/runtime`）
 * - `cache`   —— 本机 `current.json` 指向的部署目录（拔盘后走这条）
 */
export type RuntimeRootOrigin = 'env' | 'config' | 'dev' | 'drive' | 'bundled' | 'cache';

/**
 * 每个来源的**人话**名字 —— 只进诊断文本（「找过哪些地方」要读得懂）。
 *
 * ⚠️ 这里写的是"这个来源是什么"，不是"这个来源有没有命中"：诊断文本里
 * 命中不了的原因要单独说（见 `describeRuntimeSearch` 的 `absent`）。
 */
export const RUNTIME_ORIGIN_LABELS: Record<RuntimeRootOrigin, string> = {
  env: '环境变量 CLAWWORK_RUNTIME_DIR',
  config: '客户端配置 runtimeDir',
  dev: '开发目录（从 cwd 逐级向上找 runtime-out/）',
  drive: '可移动盘（U 盘）盘根',
  bundled: '随安装包自带（<resources>/runtime）',
  cache: '本机缓存（current.json 指向的部署目录）',
};

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
  /**
   * 随安装包自带的那份（`<resources>/runtime`）。
   * ⚠️ 打包态才有意义 —— 传进来之前先过 `resolveBundledRuntimeRoot()`。
   */
  bundledRoot?: string;
  cacheRoot?: string;
}): RuntimeRootCandidate[] {
  const out: RuntimeRootCandidate[] = [];
  if (opts.envDir) out.push(candidate(opts.envDir, 'env'));
  if (opts.configDir) out.push(candidate(opts.configDir, 'config'));
  for (const root of opts.devRoots ?? []) out.push(candidate(root, 'dev'));
  // 本地部署优先：随包运行时在盘之前。安装版不带盘，直接回落随包那份；
  // 仍保留盘候选以兼容便携形态，但不再优先。
  if (opts.bundledRoot) out.push(candidate(opts.bundledRoot, 'bundled'));
  for (const root of opts.drives ?? []) out.push(candidate(root, 'drive'));
  if (opts.cacheRoot) out.push(candidate(opts.cacheRoot, 'cache'));
  return out;
}

/**
 * 随包运行时的候选根：`<resources>/runtime`（T-U0「fat installer」）。
 *
 * ⚠️ **只在打包态成立**，所以这里拿 `isPackaged` 当闸门：
 * `process.resourcesPath` 在 `electron-vite dev` 下指的是
 * `node_modules/electron/dist/resources` —— 那里永远不会有我们这份运行时。
 * 硬塞进候选只会往「找过哪些地方」里加一条永远不命中的噪音，而那段文本
 * 正是排障时唯一要看的东西。
 *
 * ⇒ dev 下**优雅缺席**：返回 `undefined`，连候选都不产生（诊断文本会写明原因）。
 *
 * ⚠️ 纯函数：`isPackaged` / `resourcesPath` 由调用方给（真机上是
 * `app.isPackaged` / `process.resourcesPath`），本模块不 import electron。
 */
export function resolveBundledRuntimeRoot(opts: { isPackaged: boolean; resourcesPath?: string }): string | undefined {
  if (!opts.isPackaged) return undefined;
  if (!opts.resourcesPath) return undefined;
  return path.join(opts.resourcesPath, BUNDLED_RUNTIME_DIR_NAME);
}

/** 某个来源**连候选都没产生**时的说明 —— 诊断文本里要区分"没得找"和"找了没命中"。 */
export interface AbsentRuntimeOrigin {
  origin: RuntimeRootOrigin;
  why: string;
}

/** 检索输入 —— 全是**环境**（cwd / 盘符 / 打包态），由调用方采集，本模块只做纯计算。 */
export interface RuntimeSearchInputs {
  /** dev 向上找 `runtime-out/` 的起点（真机上是 `process.cwd()`）。 */
  cwd: string;
  envDir?: string;
  configDir?: string;
  /** 已经向上找好的 dev 候选（真机上是 `findDevRuntimeRoots(cwd)`）。 */
  devRoots?: readonly string[];
  /** 已经枚举好的可移动盘盘符（如 `'Z:'`）。本模块**不自己枚举**（那要起 PowerShell）。 */
  driveLetters?: readonly string[];
  /** 打包态判定（真机上是 `app.isPackaged`）—— 决定 bundled 那条到底存不存在。 */
  isPackaged: boolean;
  /** 打包态的 `<resources>` 目录（真机上是 `process.resourcesPath`）。 */
  resourcesPath?: string;
}

/**
 * 把**输入**排成候选清单 + 说清哪些来源没产生候选。
 *
 * 抽成纯函数是为了让"index 那一侧到底有没有把 bundled 接进来"能被单测钉住 ——
 * 只测 `candidateRuntimeRoots` 的话，调用方漏传 `bundledRoot` 不会有测试变红。
 */
export function planRuntimeSearch(inputs: RuntimeSearchInputs): {
  candidates: RuntimeRootCandidate[];
  absent: AbsentRuntimeOrigin[];
} {
  const bundledRoot = resolveBundledRuntimeRoot({
    isPackaged: inputs.isPackaged,
    resourcesPath: inputs.resourcesPath,
  });

  const candidates = candidateRuntimeRoots({
    envDir: inputs.envDir,
    configDir: inputs.configDir,
    devRoots: inputs.devRoots ? [...inputs.devRoots] : undefined,
    // 盘符（`Z:`）→ 候选根（`Z:\`），与 buildDriveCandidates 同一条规则
    drives: inputs.driveLetters?.map((d) => (d.endsWith('\\') ? d : `${d}\\`)),
    bundledRoot,
    // ⚠️ cacheRoot 刻意不给：本机缓存是**热路径**，bootstrap 在部署之前就已经
    // 单独认过它（`readCached`）。这里再放一条只会让"部署源"这个概念变模糊。
  });

  const absent: AbsentRuntimeOrigin[] = [];
  if (!inputs.envDir) absent.push({ origin: 'env', why: '没设 CLAWWORK_RUNTIME_DIR' });
  if (!inputs.configDir) absent.push({ origin: 'config', why: '没有值（本版客户端还没接线到配置里的 runtimeDir）' });
  if (!inputs.devRoots || inputs.devRoots.length === 0) {
    absent.push({ origin: 'dev', why: `从 ${inputs.cwd} 逐级向上都没找到 ${DEV_RUNTIME_DIR_NAME}/` });
  }
  if (!inputs.driveLetters || inputs.driveLetters.length === 0) {
    absent.push({ origin: 'drive', why: '没有枚举到可移动盘（枚举失败不算错，见 listRemovableDrives）' });
  }
  if (!bundledRoot) {
    absent.push({
      origin: 'bundled',
      why: inputs.isPackaged
        ? '打包态但拿不到 process.resourcesPath'
        : '开发态（app.isPackaged=false）—— dev 下 process.resourcesPath 指向 electron 自带的 resources，不会有我们这份',
    });
  }
  return { candidates, absent };
}

/**
 * 「一个都没命中」时的诊断文本。
 *
 * ⚠️ 这段文本是**排障入口**，不是装饰：它必须能回答"找过哪些地方"。
 * 事故形状（2026-09-18）：安装包没带运行时 + 一句笼统的"找不到运行时盘" ⇒
 * 没人看得出到底是"盘没插"还是"包里根本没有"。
 */
export function describeRuntimeSearch(opts: {
  candidates: readonly RuntimeRootCandidate[];
  absent?: readonly AbsentRuntimeOrigin[];
  /** 是否已经扫过盘符兜底（Z: → D: 逐个探 marker）。 */
  fallbackScanned?: boolean;
}): string {
  const lines: string[] = [];
  lines.push(`找不到运行时的部署源（认盘标志：目录根下有 ${RUNTIME_MANIFEST_FILE} 这个文件）。`);

  if (opts.candidates.length === 0) {
    lines.push('一个候选都没有 —— 不是"找不到"，是"没得找"（下面每条都说明了原因）。');
  } else {
    lines.push(`已找过 ${opts.candidates.length} 个位置，全部没有 ${RUNTIME_MANIFEST_FILE}：`);
    for (const c of opts.candidates) lines.push(`  - [${c.origin}] ${c.root}（${RUNTIME_ORIGIN_LABELS[c.origin]}）`);
  }

  if (opts.absent && opts.absent.length > 0) {
    lines.push('没产生候选的来源：');
    for (const a of opts.absent) lines.push(`  - ${a.origin}：${a.why}`);
  }

  if (opts.fallbackScanned) lines.push('盘符兜底扫描（Z: → D: 逐个探 marker）也没命中。');

  lines.push('怎么办：请重新安装应用（安装包应内置运行时），或用 CLAWWORK_RUNTIME_DIR 指定运行时目录。');
  lines.push(
    '若这是刚装好的正式包，上面 bundled 那条本该命中 —— 不命中说明**安装包里没带运行时**（打包时 runtime-out/ 不存在）。',
  );
  return lines.join('\n');
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
