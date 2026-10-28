import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * E2E 的**统一临时根** + **junction-safe 删除**。
 *
 * ## 为什么需要这个文件（2026-09-13 事故）
 *
 * 打包态 E2E 的场景全部走 `mkdtemp(os.tmpdir())`，每次都会在一个**全新 profile** 里
 * 重新部署一遍完整运行时（node.exe + node_modules + state + sqlite + 日志）。
 * 而多数 spec 的 `finally` 只收进程、**不收目录**。于是一天下来的结果是：
 *
 * ```
 * %TEMP%\clawwork-*  →  261 个目录  →  ~86 GB  →  C 盘只剩 14.9 GB
 * ```
 *
 * ## ⚠️ 删除是这里最危险的动作（有过真实事故）
 *
 * profile 里存在**目录 junction**（`node_modules/openclaw` 等）。Git Bash 的
 * `rm -rf` 会**跟进 junction**，把链接指向的**真实目录**删掉 —— 项目里已经因此
 * 删过一次 `node_modules/openclaw`。所以本文件：
 *
 *   - 自己走目录树，**只认 `lstatSync`**（`lstat` 不跟随链接）
 *   - 遇到 reparse point（junction / symlink / mountpoint）**只删链接本身**
 *   - **绝不**调用 `rm -rf`，**绝不**用 `fs.rmSync(..., {recursive:true})`
 *     （后者对 junction 的行为不在我们掌控之内）
 *
 * 语义与验证见 `e2e/packaged/temp-root.test.ts` 的 negative control：
 * 在 profile 里放一个指向**外部 sentinel 目录**的 junction，清理后
 * sentinel 必须**逐字节不变**。
 *
 * ## 根目录选择顺序
 *
 * 1. `CLAWWORK_E2E_TEMP_ROOT`（显式指定优先，CI 用）
 * 2. Windows 上优先 `D:\clawwork-e2e-temp`（存在且可写）—— 别再把 C 盘跑爆
 * 3. 兜底 `os.tmpdir()/clawwork-e2e`
 */

export const DEFAULT_WINDOWS_ROOT = 'D:\\clawwork-e2e-temp';

/** 单个 profile 的目录名前缀 —— 所有 E2E 产物都用它，便于扫描与清理。 */
export const PROFILE_PREFIX = 'clawwork-';

/** 目录候选里的「名字必须长这样」判据。**防御性**：绝不误删非 profile 目录。 */
export function isProfileName(name: string): boolean {
  return name.startsWith(PROFILE_PREFIX) && !name.includes('..') && name.length > PROFILE_PREFIX.length;
}

function isWritableDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

let cachedRoot: string | null = null;

/** 解析统一临时根（结果缓存）。 */
export function resolveE2ETempRoot(): string {
  if (cachedRoot) return cachedRoot;

  const envRoot = process.env.CLAWWORK_E2E_TEMP_ROOT?.trim();
  if (envRoot) {
    if (!isWritableDir(envRoot)) {
      throw new Error(`CLAWWORK_E2E_TEMP_ROOT 不可写：${envRoot}`);
    }
    cachedRoot = path.resolve(envRoot);
    return cachedRoot;
  }

  if (process.platform === 'win32' && isWritableDir(DEFAULT_WINDOWS_ROOT)) {
    cachedRoot = DEFAULT_WINDOWS_ROOT;
    return cachedRoot;
  }

  const fallback = path.join(os.tmpdir(), 'clawwork-e2e');
  if (!isWritableDir(fallback)) {
    throw new Error(`连兜底临时根都建不出来：${fallback}`);
  }
  cachedRoot = fallback;
  return cachedRoot;
}

/** 测试用：清掉缓存，让下一次解析重新读环境变量。 */
export function resetE2ETempRootCache(): void {
  cachedRoot = null;
}

/**
 * 在统一根下开一个**全新** profile。
 *
 * ⚠️ 必须用 `mkdtempSync` 的随机后缀：并发跑同一 tag 的两个场景时，
 * 固定名字会互相踩（E2E 是 `workers: 1`，但手工并发跑是常见操作）。
 */
export function freshProfile(tag: string): string {
  const root = resolveE2ETempRoot();
  const safeTag = tag.replace(/[^a-zA-Z0-9_-]/g, '-');
  return fs.mkdtempSync(path.join(root, `${PROFILE_PREFIX}${safeTag}-`));
}

// ---------------------------------------------------------------- junction-safe 删除

/** 判断一个路径是不是 reparse point（junction / symlink / mountpoint）。 */
export function isReparsePoint(target: string): boolean {
  try {
    // ⚠️ 只认 lstat：它**不跟随**链接。stat 会跟，绝对不能用来做这个判断。
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

/** 读链接指向哪里（不是链接就返回 null）。**只读，不进入。** */
export function readLinkTarget(target: string): string | null {
  try {
    return fs.readlinkSync(target);
  } catch {
    return null;
  }
}

/**
 * 安全地删掉一棵目录树。**唯一允许的删除入口。**
 *
 * 语义（每一条都有对应的回归测试）：
 * - 普通文件        → 删
 * - 普通目录        → 递归
 * - reparse point   → **只删链接本身**，绝不进入 target
 *
 * 实现刻意不用 `fs.rmSync(recursive)` —— 它对 junction 的跟随行为不由我们决定。
 */
export function safeRemoveTree(target: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  // ① reparse point：只摘链接。unlink 对目录 junction 有效；个别平台/版本
  //    只认 rmdir，所以留一条退路 —— 两条都**不会**进入 target。
  if (st.isSymbolicLink()) {
    try {
      fs.unlinkSync(target);
    } catch {
      fs.rmdirSync(target);
    }
    return;
  }

  // ② 普通文件
  if (!st.isDirectory()) {
    fs.unlinkSync(target);
    return;
  }

  // ③ 普通目录：先删孩子，再删自己
  for (const entry of fs.readdirSync(target)) {
    safeRemoveTree(path.join(target, entry));
  }

  // ④ 删自己之前**再确认一次**它不是链接 —— 防御性：万一上面把某层
  //    建成了 junction，rmdir 也不会跟进 target。
  if (isReparsePoint(target)) {
    try {
      fs.unlinkSync(target);
    } catch {
      fs.rmdirSync(target);
    }
    return;
  }
  fs.rmdirSync(target);
}

/**
 * **一次性**清理：除了最新的 `keepNewest` 个，其余全删（不看年龄）。
 *
 * 与 `sweepStaleProfiles` 的区别是**故意的**：
 *   - `sweepStaleProfiles` 是 suite 每次启动自动跑的，**保守**（只动 24h 以上的）
 *   - 本函数是人**显式**要求"我现在就要腾空间"时用的，所以不设年龄门槛
 *
 * 两者都：跳过被进程占用的、跳过非 profile 目录、走 junction-safe 删除。
 */
export function purgeProfiles(
  opts: { root?: string; keepNewest?: number; log?: (m: string) => void; measureBytes?: boolean } = {},
): SweepResult {
  const root = opts.root ?? resolveE2ETempRoot();
  const keepNewest = opts.keepNewest ?? 3;
  const log = opts.log ?? ((): void => {});
  // ⚠️ 量字节要对 5 百多万个文件各 stat 一次（实测十几分钟）。一次性腾空间时
  //    直接看磁盘剩余差值更划算 ⇒ 允许关掉。
  const measureBytes = opts.measureBytes ?? true;

  const ranked = listProfiles(root, measureBytes); // 已按最近写入倒序
  const victims = ranked.slice(keepNewest);
  const removed: string[] = [];
  const kept: string[] = ranked.slice(0, keepNewest).map((p) => p.path);
  let freedBytes = 0;

  const inUse = profilesInUse(victims.map((p) => p.path));
  for (const p of victims) {
    if (inUse.has(p.path)) {
      kept.push(p.path);
      log(`[e2e-purge] 保留（有进程在用）：${p.path}`);
      continue;
    }
    safeRemoveTree(p.path);
    removed.push(p.path);
    freedBytes += p.bytes;
  }
  return { removed, kept, freedBytes };
}

// ---------------------------------------------------------------- 只读扫描

export interface ReparseEntry {
  path: string;
  target: string | null;
}

/**
 * 列出目录树里所有 reparse point（**不进入 target**）。
 *
 * 排障用：profile 迁移/清理之前，先看清楚有没有指向项目主目录或真实运行时的链接。
 */
export function findReparsePoints(root: string, limit = 200): ReparseEntry[] {
  const out: ReparseEntry[] = [];
  const stack = [root];
  while (stack.length > 0 && out.length < limit) {
    const cur = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      // ⚠️ 用 Dirent 判断，**不要**对每个条目再 `lstatSync` —— 一个 profile 有
      //    几万个文件，逐条 stat 会把一次审计拖到几十分钟（实测）。
      //    `Dirent.isSymbolicLink()` 对目录 junction **也是 true**（有回归测试钉着）。
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isSymbolicLink()) {
        out.push({ path: full, target: readLinkTarget(full) });
        continue; // ⛔ 不进入
      }
      if (e.isDirectory()) stack.push(full);
    }
  }
  return out;
}

/** 目录占用（字节）。**跳过 reparse point**，否则会把 target 算进来。 */
export function dirSizeBytes(root: string): number {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      // Dirent.isSymbolicLink() 对 junction **也是 true**（实测，见回归测试）。
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        stack.push(full);
      } else {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* 竞态：文件刚好没了 */
        }
      }
    }
  }
  return total;
}

// ---------------------------------------------------------------- 进程占用

interface ProcInfo {
  pid: number;
  exe: string;
  cmd: string;
}

/** 一次把所有进程的 (pid, exe, 命令行) 捞回来 —— 逐目录查会慢到不可用。 */
function snapshotProcesses(): ProcInfo[] | null {
  try {
    const ps = [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)|$($_.CommandLine)" }`,
    ];
    const out = execFileSync('powershell', ps, { encoding: 'utf-8', timeout: 30_000, windowsHide: true });
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [pid, exe, ...rest] = l.split('|');
        return { pid: Number(pid), exe: exe ?? '', cmd: rest.join('|') };
      })
      .filter((p) => Number.isFinite(p.pid));
  } catch {
    return null;
  }
}

/**
 * 判断一批 profile 里哪些**仍被进程占着**。
 *
 * ⚠️ 判据必须**精确到"这个 profile"**，不能用"命令行里包含这个路径" ——
 * 那条会把**查询进程自己**也算进去（PowerShell 的命令行里就有这个路径），
 * 于是永远返回"在用"，清理永远不生效（写这文件时实测踩到，被回归测试 E 抓到）。
 *
 * 只认两种铁证：
 *   ① 进程的**可执行文件**在这个 profile 里（部署出来的 node.exe 就是这样）
 *   ② 命令行里带 `--user-data-dir=<这个 profile>`（应用自己）
 *
 * 拿不到进程表时**保守返回"全部在用"** —— 宁可留着，也别删掉正在跑的东西。
 */
export function profilesInUse(dirs: string[]): Set<string> {
  const inUse = new Set<string>();
  if (dirs.length === 0) return inUse;
  const procs = snapshotProcesses();
  if (procs === null) {
    for (const d of dirs) inUse.add(d);
    return inUse;
  }
  for (const dir of dirs) {
    const prefix = dir.toLowerCase().replace(/\\/g, '/');
    const hit = procs.some((p) => {
      const exe = p.exe.toLowerCase().replace(/\\/g, '/');
      if (exe && exe.startsWith(prefix.endsWith('/') ? prefix : prefix + '/')) return true;
      const cmd = p.cmd.toLowerCase().replace(/\\/g, '/');
      return cmd.includes(`--user-data-dir=${prefix}`);
    });
    if (hit) inUse.add(dir);
  }
  return inUse;
}

// ---------------------------------------------------------------- 保留策略

export interface ProfileEntry {
  path: string;
  mtimeMs: number;
  bytes: number;
}

/** 列出根目录下的 profile（按最近写入倒序）。 */
export function listProfiles(root = resolveE2ETempRoot(), withSize = true): ProfileEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: ProfileEntry[] = [];
  for (const name of names) {
    if (!isProfileName(name)) continue;
    const full = path.join(root, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    out.push({ path: full, mtimeMs: st.mtimeMs, bytes: withSize ? dirSizeBytes(full) : 0 });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export interface SweepOptions {
  root?: string;
  /** 无条件保留最新的几个（默认 3）—— 最近的失败证据不能删。 */
  keepNewest?: number;
  /** 比这还老、又没进程在用 ⇒ 可以删。 */
  staleHours?: number;
  /** 保留集的总大小上限，超了从最旧的开始删（默认 5 GiB）。 */
  maxRetainBytes?: number;
  log?: (msg: string) => void;
}

export interface SweepResult {
  removed: string[];
  kept: string[];
  freedBytes: number;
}

const GIB = 1024 ** 3;

/**
 * 清理**上一次**跑残留的 profile。
 *
 * 为什么必须有这一步：`finally` 兜不住 `Ctrl+C`、终端被关、Playwright 超时、
 * 机器重启 —— 那些情况下 profile 永远留在盘上。所以**每次 suite 启动前**扫一遍。
 */
export function sweepStaleProfiles(opts: SweepOptions = {}): SweepResult {
  const root = opts.root ?? resolveE2ETempRoot();
  const keepNewest = opts.keepNewest ?? 3;
  const staleHours = opts.staleHours ?? 24;
  const maxRetainBytes = opts.maxRetainBytes ?? 5 * GIB;
  const log = opts.log ?? ((): void => {});

  const profiles = listProfiles(root);
  const removed: string[] = [];
  const kept: string[] = [];
  let freedBytes = 0;

  const now = Date.now();
  // 先挑候选（受保护 / 还新的直接留下），再用**一次**进程快照判断谁在用。
  const candidates = profiles.filter((p, index) => {
    if (index < keepNewest) {
      kept.push(p.path);
      return false;
    }
    const ageHours = (now - p.mtimeMs) / 3_600_000;
    if (ageHours < staleHours) {
      kept.push(p.path);
      log(`[e2e-clean] 保留（还新，${ageHours.toFixed(1)}h）：${p.path}`);
      return false;
    }
    return true;
  });

  const inUse = profilesInUse(candidates.map((p) => p.path));
  for (const p of candidates) {
    if (inUse.has(p.path)) {
      kept.push(p.path);
      log(`[e2e-clean] 保留（有进程在用）：${p.path}`);
      continue;
    }
    safeRemoveTree(p.path);
    removed.push(p.path);
    freedBytes += p.bytes;
  }

  // 保留集超出上限 ⇒ 从最旧的开始继续删（仍然跳过"在用"的）
  const retained = listProfiles(root);
  let retainedBytes = retained.reduce((sum, p) => sum + p.bytes, 0);
  if (retainedBytes > maxRetainBytes) {
    const overBy = retained.filter((p) => !profilesInUse([p.path]).has(p.path));
    for (let i = overBy.length - 1; i >= 0 && retainedBytes > maxRetainBytes; i--) {
      const p = overBy[i] as ProfileEntry;
      safeRemoveTree(p.path);
      removed.push(p.path);
      freedBytes += p.bytes;
      retainedBytes -= p.bytes;
    }
  }

  return { removed, kept, freedBytes };
}
