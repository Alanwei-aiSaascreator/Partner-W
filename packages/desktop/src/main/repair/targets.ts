/**
 * 修复工具要看的**目录集合**（FEAT-03 · SPEC 二）。
 *
 * 为什么单独一个模块：修复模式**不走**首启链（不起网关、不做工作区准备），所以
 * `ensureStateConfig` 那条路给不出 stateDir —— 而"要修哪些文件"恰恰全靠它。
 * 这里用**盘上真实存在的东西**倒推（谁是 stateDir = 谁里面有 `openclaw.json`），
 * 而不是把 `state-config.ts` 的推导再抄一遍。抄一遍的代价是：上游改一次目录布局，
 * 修复工具就静默地看一眼空目录、报"全绿"。
 *
 * ⚠️ 纪律：**只读**。本模块不建目录、不写文件；写动作全部在 `apply` 阶段（且先备份）。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * state 目录名 / 配置文件名（与 `runtime/state-config.ts` 同值）。
 *
 * ⚠️ 为什么**不 import** 那两个常量：`state-config.ts` 经 `workspace/config.js`
 *    拉进 `electron`，而修复引擎要能在不起 Electron 的测试里跑。
 *    漂移由 `test/repair-constants-drift.test.ts` **读源码文本**钉住
 *    （同 `runtime-constants-drift.test.ts` 的手法）。
 */
export const STATE_DIR_NAME = 'openclaw-state';
export const STATE_CONFIG_FILE = 'openclaw.json';

/**
 * 盘上形态的 state 父目录名（`<运行数据>/state/<身份>`）。
 *
 * ⚠️ 与 `STATE_DIR_NAME` 是**两个不同的名字**，别混：`state-config.ts` 里
 *    `stateDirFor()` 用 `openclaw-state`，`portableStateDirFor()` 用的是 `state`。
 *    把它们当成一个是本模块第一版的实际 bug（扫了个空目录、报"全绿"）。
 */
export const PORTABLE_STATE_DIR_NAME = 'state';

/** 盘上运行时那套根（`runtime/portable-root.ts` 的 `PortableRoots` 的子集）。 */
export interface PortableRootsLike {
  volumeRoot: string;
  programDir: string;
  dataRoot: string;
  stateRoot: string;
  workspaceRoot: string;
  logsRoot: string;
}

export interface RepairTargets {
  /** 是不是盘上运行（决定界面说"盘"还是"这台电脑"）。 */
  portable: boolean;
  volumeRoot: string | null;
  programDir: string;
  /** 应用数据根（备份与诊断包的落点之一）。 */
  dataRoot: string;
  /** 日志根（备份目录开在这里面）。 */
  logsRoot: string;
  /** 用户资料工作区（盘上形态才有；本机安装形态为 null）。 */
  workspaceRoot: string | null;
  /** 探测到的 state 目录（判据见 `looksLikeStateDir`：有配置**或**有网关锁目录）。 */
  stateDirs: string[];
  /** 探测时看过的全部候选（写进扫描报告，"全绿"因此可证）。 */
  candidateStateRoots: string[];
}

/** 找 state 目录时最多往下走几层（`<data>/state/<id>` 是一层，`<data>/state/state/<id>` 是两层）。 */
const STATE_SEARCH_DEPTH = 2;

/**
 * 盘上形态的候选 state 根（**三处都可能**，因为布局换过）：
 * - `<运行数据>/state/<身份>`       —— 当前 `portableStateDirFor()` 的产出（主用例）
 * - `<运行数据>/state/state/<身份>` —— 幂等兜底：万一哪一版把 stateRoot 又当了一次父目录
 * - `<运行数据>/openclaw-state`     —— 盘上形态下 `stateDirFor()` 的产出（非 split 的那条路）
 */
function portableStateDirCandidates(dataRoot: string): string[] {
  return [
    path.join(dataRoot, PORTABLE_STATE_DIR_NAME),
    path.join(dataRoot, PORTABLE_STATE_DIR_NAME, PORTABLE_STATE_DIR_NAME),
    path.join(dataRoot, STATE_DIR_NAME),
  ];
}

/**
 * 「这看起来是个 state 目录吗」。
 *
 * 两条判据，命中任一即可：
 * ① 有 `openclaw.json`（正常形态）
 * ② 有 `tmp/openclaw/`（网关锁的家）—— **不能只看 ①**：配置文件被删掉/还没写出来时，
 *    目录里恰恰**只剩锁**，而那正是"坏锁卡住整块盘"的现场。第一版就栽在这里：
 *    端到端实测里种下的坏锁被整支工具无视，扫描报"没有状态目录"（等于什么都没修）。
 *
 * ⚠️ 反过来也要收得住：`<运行数据>/state` 这个**容器**两条都不命中（它的子目录才命中），
 *    所以不会把"身份目录的父目录"误报成 state。
 */
function looksLikeStateDir(dir: string): boolean {
  try {
    if (fs.statSync(path.join(dir, STATE_CONFIG_FILE)).isFile()) return true;
  } catch {
    // 没有就没有，接着看第二条
  }
  try {
    return fs.statSync(path.join(dir, 'tmp', 'openclaw')).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 在候选根下面找**像 state 的**目录（深度优先、有界；判据见 `looksLikeStateDir`）。
 *
 * `depth` 从 0 起：0 = 候选根本身，1 = 它的直接子目录，2 = 孙目录。
 * 空目录、半成品目录一律不会误报成 state。
 */
export function discoverStateDirs(opts: { candidates: readonly string[]; depth?: number }): string[] {
  const maxDepth = opts.depth ?? STATE_SEARCH_DEPTH;
  const found: string[] = [];
  const seen = new Set<string>();

  const visit = (dir: string, depth: number): void => {
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (looksLikeStateDir(dir)) {
      found.push(dir);
      return; // 找到就不再往下钻：state 目录不会套 state 目录
    }
    if (depth >= maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      visit(path.join(dir, entry.name), depth + 1);
    }
  };

  for (const candidate of opts.candidates) visit(candidate, 0);
  return found;
}

/**
 * 盘上形态：全部从 `PortableRoots` 派生（**不枚举盘**——那是一次 PowerShell）。
 *
 * ⚠️ 这里不调 `workspace/startup.ts` 的判定：修复工具允许"工作区还没建/建坏了"时
 *    也能跑，而那一步会弹选盘对话框。`getPortableRoots()` 的惰性兜底两条纯文件判据
 *    （盘根 marker / 交付夹形状）已覆盖交付盘的绝大多数形态，判不出来就按本机安装
 *    形态退化成"只看 userData"，如实说，不猜。
 */
export function resolveRepairTargets(opts: {
  userDataDir: string;
  programDir: string;
  portableRoots: PortableRootsLike | null;
}): RepairTargets {
  if (opts.portableRoots) {
    const roots = opts.portableRoots;
    const candidates = portableStateDirCandidates(roots.dataRoot);
    return {
      portable: true,
      volumeRoot: roots.volumeRoot,
      programDir: roots.programDir,
      dataRoot: roots.dataRoot,
      logsRoot: roots.logsRoot,
      workspaceRoot: roots.workspaceRoot,
      stateDirs: discoverStateDirs({ candidates }),
      candidateStateRoots: candidates,
    };
  }

  const candidates = [path.join(opts.userDataDir, STATE_DIR_NAME)];
  return {
    portable: false,
    volumeRoot: null,
    programDir: opts.programDir,
    dataRoot: opts.userDataDir,
    logsRoot: path.join(opts.userDataDir, 'logs'),
    workspaceRoot: null,
    stateDirs: discoverStateDirs({ candidates }),
    candidateStateRoots: candidates,
  };
}

/**
 * 「这条路径是不是**应用自己的**」—— 打开目录 / **还原目标**共用的**唯一**判据。
 *
 * 为什么它必须是一个函数而不是各写各的：还原的目标路径来自盘上的 `index.json`
 * （**不可信输入**），而"只许动我们自己的目录"是本工具**唯一**的安全边界。
 * 两处各写一遍就会漂，漂的那一侧就是一个**任意文件覆写**原语。
 *
 * `null` / 空根一律忽略；比较前统一 `resolve` + 去尾分隔符 + 小写（Windows 大小写不敏感）。
 */
export function isPathWithinAnyRoot(candidate: string, roots: readonly (string | null | undefined)[]): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const normalize = (value: string): string =>
    path
      .resolve(value)
      .replace(/[\\/]+$/, '')
      .toLowerCase();
  const target = normalize(candidate);
  return roots.some((root) => {
    if (typeof root !== 'string' || root.length === 0) return false;
    const base = normalize(root);
    return target === base || target.startsWith(`${base}${path.sep}`);
  });
}

/**
 * 修复工具允许**写回 / 打开**的根 —— **只列真实会被备份的那些**。
 *
 * ⚠️ 这是"应用自己的目录"的**唯一**定义：`ipc/repair-handlers.ts` 的打开白名单与
 *    引擎的还原目标白名单都从这里取（同一份函数、同一份根）。
 *
 * ## 为什么这份清单必须**窄**（T31 复审收敛，2026-10-17）
 *
 * 还原的目标路径直接来自盘上的 `index.json`（**不可信输入**：谁都能改修复备份目录里
 * 那份纯文本）。这一份清单就是"**任意文件覆写**"原语唯一的闸门 —— **多列一个根，
 * 就多放行一整棵子树**。旧实现列了 `volumeRoot`，而盘上形态下它 = **整支 U 盘的根**
 * ⇒ 一条被改写的索引就能"还原"覆写盘上**任意**文件（含 `荣盈魔方工作区` 里的用户文档）。
 * 而按下面四个**全部**备份点的实测，没有一个落在 `volumeRoot` / `programDir` 的
 * 直接子树上 ⇒ 那两个根是**纯冗余授权**，收掉。
 *
 * ## 实测：`repair/` 里**全部**会写备份的地方（`backupFile` 的调用者）
 *
 *  · `items/gateway-locks.ts:197` → `<stateDir>/tmp/openclaw/gateway.*.lock`
 *  · `items/plugin-paths.ts:259`   → `<stateDir>/openclaw.json`
 *  · `items/capability-block.ts:243` → `<main 助手 workspace>/AGENTS.md`
 *  · `engine.ts:308`（技能账迁移） → `<userData>/openclaw.json`
 *
 * （`engine.ts:257` 的诊断包只**新建**一个 zip、不登记进 `index.json`，不参与还原。）
 *
 * 落到根上：
 *  · `stateDirs` —— 锁与 `openclaw.json` 都在里面（**备份目标本身**）；
 *  · `dataRoot` —— 技能账配置文件（`userData = dataRoot`：盘上形态见
 *    `runtime/portable-app-data.ts:213` 的 `setPath('userData', …)`；本机形态见
 *    `resolveRepairTargets()` 的 `dataRoot: opts.userDataDir`），且 `stateDirs ⊆ dataRoot`
 *    （候选全由 `dataRoot` 派生）；
 *  · `workspaceRoot` —— 主助手 `AGENTS.md` 的落点（盘上形态取
 *    `<盘根>\荣盈魔方工作区`，见 `workspace/portable.ts:203` / `runtime/state-config.ts`
 *    的 `mergePortableAgentDefaults(_, portableWorkspacePath)`）；
 *  · `logsRoot` —— 备份目录的家（`<logsRoot>/repair-<时间戳>`），`repair:reveal`
 *    要打开的就是它 ⇒ 保留（它是窄的应用目录，不是"整块盘"）。
 *
 * ## 收窄的**约束**（防"收窄过头"）
 *
 * 收窄过头的后果是"**合法还原被误拒**"（比漏洞更糟）⇒ 这里**只删实测证明确非备份目标**
 * 的根（`volumeRoot` 整盘根 / `programDir` 程序目录），**不动**任何一个真实备份落点。
 * `test/repair-backup-restore.test.ts` 用两侧反例钉死：越界盘根路径必拒、真实备份点
 * （`stateDir` / `workspaceRoot`）照常成功。
 */
export function appOwnedRoots(targets: RepairTargets): string[] {
  return [
    targets.logsRoot,
    targets.dataRoot,
    targets.workspaceRoot,
    ...targets.stateDirs,
  ].filter((root): root is string => typeof root === 'string' && root.length > 0);
}

/**
 * 修复模式该拿哪个目录当"运行数据根"（安装形态）。
 *
 * ⚠️ 2026-10-18 打包态冒烟抓到的真缺陷：修复模式 `app.setName('荣盈魔方 修复工具')`
 *    之后 `app.getPath('userData')` 变成 `%APPDATA%\荣盈魔方 修复工具`（它自己的
 *    Chromium 缓存目录），而正常应用的运行数据在 `%APPDATA%\@clawwork`（产品名）。
 *    用错根 ⇒ `openclaw-state` 永远找不到 ⇒ 面板永远说"没有找到状态目录、这里用不上"
 *    —— 安装版用户点开修复工具等于看一个空目录。
 *
 * 规则：盘上形态以**实际重定向到的目录**为准（`applyPortableAppData` 的 target，
 * 那是正常应用也在用的同一份）；否则用**正常应用**的 userData（`setName` 之前取的）。
 */
export function resolveRepairDataRoot(opts: {
  portableTarget: string | null;
  installedUserDataDir: string;
}): string {
  return opts.portableTarget ?? opts.installedUserDataDir;
}
