/**
 * 「盘上运行」判定 + 工作区**盘符自愈**的候选顺序（T-U1）。
 *
 * 目标形态：插上 U 盘 → 双击盘根启动器 → 直接进登录 → 用。不安装、不选盘、
 * 换机器/换盘符也不许打不开。
 *
 * ⚠️ 本模块**全是纯函数**：`exePath` / 可移动盘列表 / `exists` 全部注入 ——
 *    本机没有 U 盘可插（也没法在单测里换盘符），「静默用了错的那个工作区」
 *    只有把判定顺序钉死才查得出来。写法沿用 `runtime/locate.ts`。
 *
 * ⚠️ 认盘只认 **marker 文件**与 **DriveType=2**，不认卷标、不认目录名：
 *    卷标是用户随便改的（`locate.ts` 里同样的理由）。
 */

import path from 'node:path';
import { RUNTIME_MANIFEST_FILE, resolveBundledRuntimeRoot } from '../runtime/locate.js';

/** 盘上运行时工作区目录名（`<盘根>\荣盈魔方工作区\`）。 */
export const PORTABLE_WORKSPACE_DIR_NAME = '荣盈魔方工作区';

/**
 * 工作区**自身**的标记文件：写在 `<工作区>/.clawwork-workspace.json`。
 *
 * 盘根 marker 只能证明"这个卷是我们的盘"，证明不了"这个目录是那份工作区"。
 * 两个判据是**或**的关系：老工作区（本功能之前建的）没有自身标记，靠盘根 marker 认；
 * 盘根没放运行时的普通 U 盘（用户自己选的工作区目录），靠自身标记认。
 */
export const WORKSPACE_MARKER_FILE = '.clawwork-workspace.json';

/**
 * 路径风格：Windows 上按 `win32` 解析盘符，其它平台按 `posix`。
 *
 * ⚠️ 不写死 `win32`：本模块要能在 POSIX 上跑单测（`listRemovableDrives` 在非 win32
 *    返回空数组 ⇒ 自愈只剩"同盘符"一条，行为自然退化，不会假装自愈过）。
 * ⚠️ 每次**现取**、不在模块加载时定死：测试里用
 *    `vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')`（仓库里既有写法）
 *    就能在任意平台跑盘符相关的用例 —— 盘符自愈是这个产品的主场景，不能靠"跳过"。
 */
function P(): typeof path.win32 {
  return process.platform === 'win32' ? path.win32 : path.posix;
}

function foldForCompare(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** `'E:'` / `'E:\'` / `'e:/'` → `'E:\'`；给不出盘根返回 null。 */
export function normalizeVolumeRoot(letter: string): string | null {
  const trimmed = letter.trim();
  if (!trimmed) return null;
  const normalized = P().parse(trimmed.endsWith('\\') || trimmed.endsWith('/') ? trimmed : `${trimmed}\\`).root;
  if (!normalized) return null;
  return normalized.endsWith('\\') || normalized.endsWith('/') ? normalized : `${normalized}\\`;
}

/** 绝对路径所在**卷根**（`E:\a\b` → `E:\`）；相对路径/空字符串返回 null。 */
export function volumeRootOf(target: string): string | null {
  if (!target) return null;
  const parsed = P().parse(target);
  if (!parsed.root) return null;
  return normalizeVolumeRoot(parsed.root);
}

/** 该卷根是不是"可移动盘"（调用方注入的枚举结果，大小写不敏感，接受 `E:` 或 `E:\`）。 */
export function isRemovableVolume(volumeRoot: string | null, removableDrives: readonly string[]): boolean {
  if (!volumeRoot) return false;
  const needle = foldForCompare(normalizeVolumeRoot(volumeRoot) ?? volumeRoot);
  return removableDrives.some((drive) => {
    const root = normalizeVolumeRoot(drive);
    return root !== null && foldForCompare(root) === needle;
  });
}

/** 交付夹最多埋在卷根下**几层**（我们的包 1 层；手工压的包多一层包装夹 = 2 层）。 */
export const MAX_DELIVERY_DEPTH = 2;

/** 安装形态的常见位置：命中任一段就不算交付夹（哪怕深度够浅、哪怕夹子里带着运行时）。 */
const INSTALL_DIR_SEGMENTS: readonly RegExp[] = [/^program files( \(x86\))?$/i, /^programs$/i, /^appdata$/i];

/** 同一卷根吗（大小写不敏感，Windows 语义）。 */
export function sameVolumeRoot(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ra = normalizeVolumeRoot(a);
  const rb = normalizeVolumeRoot(b);
  return ra !== null && rb !== null && foldForCompare(ra) === foldForCompare(rb);
}

/** 随包运行时清单的绝对路径：`<resources>\runtime\openclaw-runtime-manifest.json`。 */
function bundledRuntimeManifestPath(resourcesPath: string): string | undefined {
  const root = resolveBundledRuntimeRoot({ isPackaged: true, resourcesPath });
  return root ? P().join(root, RUNTIME_MANIFEST_FILE) : undefined;
}

export interface DeliveryLayoutInput {
  /** 打包态是 `process.execPath`（exe）。 */
  exePath: string;
  /** 打包态的 `<resources>`（真机上是 `process.resourcesPath`）。不给就判否。 */
  resourcesPath?: string | null;
  exists: (p: string) => boolean;
}

/**
 * 交付形态判据：exe 就在**我们自己那份交付夹**里吗（盘上运行的第 3 条判据）。
 *
 * 为什么必须有（2026-09-20 同事那份交付包暴露出来的"判据全落空"）：
 * 交付说明让用户"解压到 U 盘根目录"，而很多 U 盘/移动固态/读卡器把 `DriveType` 报成
 * **3（固定盘）** ⇒ `listRemovableDrives()` 永远不命中；盘根 marker 又是说明里
 * 叮嘱"千万别拷"的那个文件 ⇒ 两条判据全落空，数据与工作区都留在本机，
 * 换台机器/换个 USB 口就是「找不到工作区」。
 *
 * 认的是**我们自己的交付形状**（实测于真交付包 `荣盈魔方U盘交付-0.0.24\荣盈魔方\`：
 * exe 旁边就是 `resources\runtime\openclaw-runtime-manifest.json`），四条一起成立才算：
 *
 * ① `resourcesPath` 就是**这个 exe 自己那份**（`dirname(resourcesPath) === exe 所在目录`）
 *    —— 否则"带着运行时"可以来自任何地方，判据就不是这个夹子的形状了；
 * ② 程序目录埋在卷根下 **≤ `MAX_DELIVERY_DEPTH` 层** —— 交付说明是"解压到盘根"
 *    （我们的包 1 层、手工压的包 2 层）；本机开发树/构建产物都在更深的目录里，
 *    这条同时挡住"dev/CI 被误判成盘上形态"；
 * ③ 路径里没有安装形态的常见段（`Program Files` / `Programs` / `AppData`）
 *    —— 用户完全可能把安装版装在 `D:\Program Files\荣盈魔方`，那时深度也够浅；
 * ④ 夹子里**真带着我们那份随包运行时**（`<resources>\runtime\openclaw-runtime-manifest.json`）
 *    —— 只认这一份文件，不认目录名、不认卷标（与"认盘只认 marker 与 DriveType"同一条纪律）。
 */
export function isDeliveryLayout(input: DeliveryLayoutInput): boolean {
  const volumeRoot = volumeRootOf(input.exePath);
  if (!volumeRoot) return false;
  if (!input.resourcesPath) return false;

  const appDir = P().dirname(input.exePath);
  if (foldForCompare(P().dirname(input.resourcesPath)) !== foldForCompare(appDir)) return false;

  const rel = P().relative(volumeRoot, appDir);
  if (!rel || rel.startsWith('..') || P().isAbsolute(rel)) return false;
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0 || segments.length > MAX_DELIVERY_DEPTH) return false;
  if (segments.some((segment) => INSTALL_DIR_SEGMENTS.some((re) => re.test(segment)))) return false;

  const manifest = bundledRuntimeManifestPath(input.resourcesPath);
  return Boolean(manifest && input.exists(manifest));
}

export interface PortableRunInput {
  /** 打包态是 `process.execPath`（exe），dev 是 electron 的 exe。 */
  exePath: string;
  /** `listRemovableDrives()` 的结果（DriveType=2 的盘符）。 */
  removableDrives: readonly string[];
  exists: (p: string) => boolean;
  /** 盘根 marker 名，默认 `openclaw-runtime-manifest.json`。 */
  volumeMarker?: string | null;
  /** 打包态的 `<resources>`（真机上是 `process.resourcesPath`）—— 交付形态判据要用。 */
  resourcesPath?: string | null;
}

export type PortableRunReason = 'delivery-layout' | 'removable-drive' | 'volume-marker';

export interface PortableRunDetection {
  portable: boolean;
  volumeRoot: string | null;
  /** 命中的判据（日志/对话框里要说清"凭什么认为是盘上运行"）。 */
  reason: PortableRunReason | null;
}

/**
 * 「是不是从盘上运行」——判定顺序：
 *
 * ① `exePath` 自己那份交付夹的形状（`isDeliveryLayout`）⇒ 是；
 * ② `exePath` 所在卷在**可移动盘**列表里（DriveType=2）⇒ 是；
 * ③ 该卷**根目录**存在盘根 marker（`openclaw-runtime-manifest.json`）⇒ 是；
 * ④ 否则不是（本机安装形态 / dev）。
 *
 * ⚠️ ①排在最前：它最具体（"这就是我们发出去的那个夹子"），而且**不依赖枚举**
 *    —— `DriveType=3` 的盘上 ② 永远不命中，②③ 都会把它判成安装形态。
 * ⚠️ ③不能省：`listRemovableDrives()` 是靠 PowerShell 枚举的，**失败时返回空数组**
 *    （枚举失败不是错误，见 `locate.ts`）—— 少了 ③ 的话，一旦枚举失败，
 *    盘上运行会被误判成安装形态，用户又回到"要选盘"。
 */
export function detectPortableRun(input: PortableRunInput): PortableRunDetection {
  const volumeRoot = volumeRootOf(input.exePath);
  if (!volumeRoot) return { portable: false, volumeRoot: null, reason: null };

  if (isDeliveryLayout({ exePath: input.exePath, resourcesPath: input.resourcesPath, exists: input.exists })) {
    return { portable: true, volumeRoot, reason: 'delivery-layout' };
  }

  if (isRemovableVolume(volumeRoot, input.removableDrives)) {
    return { portable: true, volumeRoot, reason: 'removable-drive' };
  }

  const marker = input.volumeMarker || RUNTIME_MANIFEST_FILE;
  if (input.exists(P().join(volumeRoot, marker))) {
    return { portable: true, volumeRoot, reason: 'volume-marker' };
  }

  return { portable: false, volumeRoot, reason: null };
}

/** 判定结果只要布尔时用这个（`detectPortableRun` 的薄包装）。 */
export function isPortableRun(input: PortableRunInput): boolean {
  return detectPortableRun(input).portable;
}

/** 盘上运行时工作区 = `<盘根>\荣盈魔方工作区\`。 */
export function portableWorkspacePathFor(volumeRoot: string): string {
  const root = normalizeVolumeRoot(volumeRoot) ?? volumeRoot;
  return P().join(root, PORTABLE_WORKSPACE_DIR_NAME);
}

/** 相对盘根的路径（`E:\荣盈魔方工作区` → `荣盈魔方工作区`）；推不出来返回 null。 */
export function deriveWorkspaceRelPath(workspacePath: string): string | null {
  const volumeRoot = volumeRootOf(workspacePath);
  if (!volumeRoot) return null;
  const rel = P().relative(volumeRoot, workspacePath);
  if (!rel || rel.startsWith('..') || P().isAbsolute(rel)) return null;
  return rel;
}

/**
 * 把配置里记的 `workspaceRelPath` **当相对路径**解析到某个卷根下（R1，2026-10-10）。
 *
 * ⚠️ 只在"用 relPath 做恢复"时调用（候选构造）；别拿去给其它地方做一般路径规整。
 *
 * 为什么必须有一层窄校验（集中终审 §3 反例③）：旧实现是
 * `P().join(volumeRoot, relPath.replace(/^[\\/]+/, ''))` —— 先**剥掉前导斜杠再假装
 * 它是相对路径**，且 `..\private` 这类上级路径会被 `path.join` 静默归一成卷根下的
 * 另一个目录（`F:\private`）。坏线索（手改配置/历史残留）于是能把"恢复"变成
 * "在盘根猜一个目录打开"。
 *
 * 判据（全部拒绝，返回 null）：
 * - 空串 / 含 NUL；
 * - 绝对路径、带盘符的根（`C:\x`、`\x`、`\\server\share`、`C:foo`）；
 * - 任何一段为空（连续分隔符/尾分隔符）、`.`、`..`、或含 `:`；
 * - 解析结果不落在目标卷根之下（防御性复验，正常输入不会触发）。
 */
export function resolveWorkspaceRelative(root: string, raw: string): string | null {
  if (!raw || raw.includes('\0') || P().isAbsolute(raw) || P().parse(raw).root) return null;
  const segments = raw.split(/[\\/]/);
  if (segments.some((part) => !part || part === '.' || part === '..' || part.includes(':'))) return null;
  const base = P().resolve(root);
  const target = P().resolve(base, raw);
  const relative = P().relative(base, target);
  if (!relative || relative === '..' || relative.startsWith('..' + P().sep) || P().isAbsolute(relative)) return null;
  return target;
}

export interface WorkspaceLocationDescription {
  workspaceRelPath?: string;
  volumeMarker?: string;
  /** 归属（B1）：记线索时一并记下"这份工作区是否随盘走"。 */
  workspaceBinding?: 'app-volume' | 'explicit-path';
}

/**
 * 为工作区**补记**迁移线索（`workspaceRelPath` + `volumeMarker`），供下次自愈用。
 *
 * 记的条件（两条**或**）：工作区在**可移动盘**上，或者工作区在**程序自己运行的那块盘**上
 * （`runVolumeRoot`，= 盘上运行时判定出来的卷根）。
 *
 * ⚠️ 第二条是 2026-09-20 补的（同事那份交付包暴露的）：交付形态判据认出来的盘
 *    （`DriveType=3` 的 U 盘/移动固态/读卡器）**不在**可移动盘列表里 ⇒ 老判据一条线索
 *    都不记 ⇒ 工作区明明在盘上，换个 USB 口（盘符变了）却零候选，又是「找不到工作区」。
 *    工作区落在"程序自己所在的那块盘"上，语义上就等于"这块盘会被插到别的口/别的机器"
 *    —— 正是该记线索的那种工作区。
 *
 * ⚠️ **本机安装形态一条都不记**（`runVolumeRoot` 为 null、也不在可移动盘上）：本机固定盘
 *    （`C:\Users\…`）的工作区目录被删了，旧行为是"悄悄重建"，不该因为多记了一条相对路径
 *    就变成"弹框让你选盘"。这条边界是刻意的 —— 记了就代表"这份工作区在某个盘上，下次得去找它"。
 */
export function describeWorkspaceLocation(input: {
  workspacePath: string;
  removableDrives: readonly string[];
  exists: (p: string) => boolean;
  volumeMarker?: string | null;
  /** 应用**自己运行所在**的卷根（启动时判出来的 `portableRoot`；非盘上运行时给 null）。 */
  runVolumeRoot?: string | null;
  /** 归属（B1）：自动盘上工作区=app-volume；用户显式选择=explicit-path。 */
  binding?: 'app-volume' | 'explicit-path';
}): WorkspaceLocationDescription {
  const volumeRoot = volumeRootOf(input.workspacePath);
  if (!volumeRoot) return {};
  const onRunVolume = sameVolumeRoot(volumeRoot, input.runVolumeRoot);
  if (!onRunVolume && !isRemovableVolume(volumeRoot, input.removableDrives)) return {};

  const rel = deriveWorkspaceRelPath(input.workspacePath);
  if (!rel) return {};

  const marker = input.volumeMarker || RUNTIME_MANIFEST_FILE;
  return {
    workspaceRelPath: rel,
    volumeMarker: input.exists(P().join(volumeRoot, marker)) ? marker : undefined,
    // binding 只在"记了盘上线索"时有意义（B1）：非盘上工作区不写归属，判定按老行为。
    ...(input.binding ? { workspaceBinding: input.binding } : {}),
  };
}

/**
 * 写进配置的那一小块（`updateConfig`/`writeConfig` 的补丁）。
 *
 * ⚠️ 两个键**总是显式出现**（没有线索时是 `undefined`）：工作区从 U 盘换到本机目录时，
 *    旧的 `workspaceRelPath` 必须被清掉 —— 只写 `{...location}` 会把上次的线索留着，
 *    下次启动会拿它去扫盘、扫不到就弹框。
 */
export function workspaceLocationPatch(input: {
  workspacePath: string;
  removableDrives: readonly string[];
  exists: (p: string) => boolean;
  volumeMarker?: string | null;
  runVolumeRoot?: string | null;
  binding?: 'app-volume' | 'explicit-path';
}): { workspaceRelPath?: string; volumeMarker?: string; workspaceBinding?: 'app-volume' | 'explicit-path' } {
  const location = describeWorkspaceLocation(input);
  return { workspaceRelPath: undefined, volumeMarker: undefined, workspaceBinding: undefined, ...location };
}

/**
 * 候选是怎么被找到的：
 * - `same-letter`：记录里那个盘符还在，按相对路径找回来；
 * - `run-volume`：**应用自己运行所在的那块盘**（盘列表为空/报成固定盘时的救命判据）；
 * - `removable-scan`：扫可移动盘列表。
 */
export type WorkspaceHealOrigin = 'same-letter' | 'run-volume' | 'removable-scan';

export type WorkspaceCandidateEvidence = 'volume-marker' | 'workspace-marker';

export interface WorkspaceHealCandidate {
  path: string;
  origin: WorkspaceHealOrigin;
  /** 凭什么认它是那份工作区。 */
  evidence: WorkspaceCandidateEvidence;
}

export interface WorkspaceHealInput {
  /** 配置里记的绝对路径（现在不存在了）。 */
  recordedPath: string;
  /** 配置里记的相对盘根路径。**没记 = 不自愈**（见下）。 */
  relPath?: string | null;
  volumeMarker?: string | null;
  removableDrives: readonly string[];
  /**
   * 应用**自己运行所在**的卷根（盘上运行时 = `detectPortableRun().volumeRoot`）。
   *
   * ⚠️ 为什么必须有这一条（2026-09-18 实机复现）：Windows 把不少 U 盘/SSD/读卡器报成
   *    **固定盘**（DriveType=3），枚举可移动盘是空数组；那时"记录里的盘符变了"就两条
   *    判据全落空 —— 尽管盘根本人就在眼前（应用正跑在上面，盘根 marker 与工作区都在）。
   *    结果用户换了个 USB 口就弹「找不到工作区」。
   */
  runVolumeRoot?: string | null;
  exists: (p: string) => boolean;
}

/**
 * 自愈候选，**顺序即优先级**：
 *
 * ① `same-letter`     —— 同一盘符按相对路径找（盘符没变、只是目录被删/被改名的情形）
 * ② `removable-scan`  —— 扫所有可移动盘，`<盘根>\<相对路径>` 且
 *                        （盘根 marker **或** 工作区自身 marker）才算命中
 *
 * ⚠️ **两条都要佐证**（marker 至少命中一个）：同盘符**不等于**同一块盘。盘符是
 *    插拔时随手分配的 —— 今天的 `E:` 可能就是同事那块盘、或是用户自己另一个同名目录。
 *    没有佐证就"静默改配置过去"，等于把用户带到别人的数据上，而且是**无声**的
 *    （候选恰好唯一 ⇒ 连对话框都不弹）。佐证缺失时退化成"零命中 ⇒ 问用户"，这是对的。
 *
 * ⚠️ 按路径**去重**：可移动盘列表里就包含 ① 那个盘符时，同一条路径会被数两次 ⇒
 *    本该"唯一命中静默自愈"的场景变成"多命中弹框"。
 *
 * ⚠️ 没记 `relPath` 就直接返回空：靠 `C:\Users\…\ClawWork-Workspace` 反推出的
 *    相对路径（`Users\…\ClawWork-Workspace`）去扫 U 盘是**猜**，不是找。
 */
export function buildWorkspaceHealCandidates(input: WorkspaceHealInput): WorkspaceHealCandidate[] {
  // ⚠️ R1（2026-10-10 集中终审 §3）：**不剥前导斜杠、不做任何"规整"** ——
  //    relPath 要么是合法相对路径（逐段过 `resolveWorkspaceRelative`），
  //    要么一个候选都不给（走进 decide 的 ask-user）。坏线索不许悄悄变成"猜一个目录"。
  const rel = input.relPath ?? null;
  /**
   * 没记 `relPath` 时的退路（2026-09-20 外部审计实机撞到）：
   *
   * 机器上留着**更老版本**写的配置（`workspacePath` 指向一块已不存在的盘、**没有**
   * `workspaceRelPath` —— 那个字段是 2026-09-18 的 T-U1 才加的），换盘符后原来直接
   * `return []` ⇒ 弹框让用户手选，而盘上明明躺着 `E:\荣盈魔方工作区\.clawwork-workspace.json`
   * （我们自己写的标记）。用户随手建个空目录，看到的就是"历史数据没了"。
   *
   * ⚠️ 退路**必须窄**，否则就变成"猜"（下面那条 `C:\Users\…` 的测试守的就是这个）：
   *    只找**我们自己的默认目录名**这一个常量，**且必须有工作区标记**作证。
   */
  const relCandidates: string[] = rel ? [rel] : [PORTABLE_WORKSPACE_DIR_NAME];
  const requireWorkspaceMarker = !rel;

  const marker = input.volumeMarker || RUNTIME_MANIFEST_FILE;
  const out: WorkspaceHealCandidate[] = [];
  const seen = new Set<string>();

  const push = (candidate: WorkspaceHealCandidate): void => {
    const key = foldForCompare(candidate.path);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(candidate);
  };

  /**
   * 佐证：目录里有没有我们的工作区标记 / 盘根有没有运行时 marker。都没有 ⇒ 不认。
   * ⚠️ `requireWorkspaceMarker`（= 没记 relPath 的退路）下**只认工作区标记**：
   *    那时的目录名只是个常量，盘根 marker 说的是"这块盘上放着运行时"，与"这是谁的
   *    工作区"无关 —— 单靠它会把别人同名的目录认成用户的工作区。
   */
  const evidenceOf = (candidate: string, volumeRoot: string): WorkspaceCandidateEvidence | null => {
    const hasWorkspaceMarker = input.exists(P().join(candidate, WORKSPACE_MARKER_FILE));
    if (requireWorkspaceMarker) return hasWorkspaceMarker ? 'workspace-marker' : null;
    if (input.exists(P().join(volumeRoot, marker))) return 'volume-marker';
    if (hasWorkspaceMarker) return 'workspace-marker';
    return null;
  };

  // ① 同盘符
  const volumeRoot = volumeRootOf(input.recordedPath);
  if (volumeRoot) {
    for (const candidateRel of relCandidates) {
      const candidate = resolveWorkspaceRelative(volumeRoot, candidateRel);
      if (!candidate || !input.exists(candidate)) continue;
      const evidence = evidenceOf(candidate, volumeRoot);
      if (evidence) push({ path: candidate, origin: 'same-letter', evidence });
    }
  }

  // ② 应用**自己运行所在的那块盘**（排在扫盘之前：它比"别的某块盘"更像答案）。
  //    盘列表为空/报成固定盘时，这是唯一还能救命的判据。
  if (input.runVolumeRoot) {
    const root = normalizeVolumeRoot(input.runVolumeRoot);
    if (root) {
      for (const candidateRel of relCandidates) {
        const candidate = resolveWorkspaceRelative(root, candidateRel);
        if (!candidate || !input.exists(candidate)) continue;
        const evidence = evidenceOf(candidate, root);
        if (evidence) push({ path: candidate, origin: 'run-volume', evidence });
      }
    }
  }

  // ③ 扫可移动盘
  for (const drive of input.removableDrives) {
    const root = normalizeVolumeRoot(drive);
    if (!root) continue;

    for (const candidateRel of relCandidates) {
      const candidate = resolveWorkspaceRelative(root, candidateRel);
      if (!candidate || !input.exists(candidate)) continue;

      const evidence = evidenceOf(candidate, root);
      if (!evidence) continue;

      push({ path: candidate, origin: 'removable-scan', evidence });
    }
  }

  return out;
}

export interface WorkspaceStartupInput {
  /** 配置里的工作区绝对路径（null/空 = 首启）。 */
  recordedPath?: string | null;
  recordedRelPath?: string | null;
  volumeMarker?: string | null;
  /** 盘上运行时的卷根（`detectPortableRun().volumeRoot`，非盘上给 null）。 */
  portableRoot?: string | null;
  /**
   * 配置里记的工作区归属（B1 修复合同）：
   * - `app-volume`：随盘移动的自动工作区 —— 按**当前运行卷** + 合法相对路径解析，
   *   发现旧卷上的同名字目录**不切回旧卷**；
   * - `explicit-path`：用户显式选择的外部目录 —— 遵从用户选择；
   * - `null/undefined`：老记录。记过 `recordedRelPath`（盘上线索）的按 app-volume 保守处理，
   *   否则按 explicit 处理（老行为）。
   */
  workspaceBinding?: 'app-volume' | 'explicit-path' | null;
  /** 首启且非盘上时使用的默认位置（`getDefaultWorkspacePath()`）。 */
  defaultPath: string;
  removableDrives: readonly string[];
  exists: (p: string) => boolean;
}

export type WorkspaceStartupDecision =
  /** 记录的位置还在 —— 什么都不用做。 */
  | { kind: 'configured'; path: string }
  /** 唯一命中 ⇒ 静默改配置并继续。 */
  | { kind: 'healed'; path: string; from: string; via: WorkspaceHealCandidate }
  /** 本机目录被删（卷还在、又不是盘上工作区）⇒ 就地重建，与旧行为一致。 */
  | { kind: 'recreated'; path: string }
  /** 首启 + 盘上运行 ⇒ 自动设为 `<盘根>\荣盈魔方工作区\`，不弹选择框。 */
  | { kind: 'auto-portable'; path: string; volumeRoot: string }
  /** 首启 + 非盘上 ⇒ 默认位置（Setup 里仍可改，与旧行为一致）。 */
  | { kind: 'default'; path: string }
  /** 零命中或多命中 ⇒ 必须让用户决定，**绝不退出**。 */
  | { kind: 'ask-user'; recordedPath: string; candidates: WorkspaceHealCandidate[] };

/**
 * 启动时该用哪个工作区 —— 判定顺序（钉死，改动必须同时改测试）：
 *
 * ```
 * 有记录：
 *   exists(记录) 且（非 app-volume，或记录卷 == 当前运行卷）⇒ configured
 *   explicit-path 且记录不存在           ⇒ ask-user（绝不静默跨卷自愈/改归属，R1）
 *   候选 === 1 且（非 app-volume，或候选在运行卷上，或运行卷未知）⇒ healed（静默）
 *   候选 === 1 但 app-volume 候选在别的卷 ⇒ ask-user（唯一候选不许从旧卷静默胜出，R1）
 *   候选 > 1                            ⇒ ask-user（多命中不许猜）
 *   候选 === 0 且 记过 relPath（盘上）   ⇒ ask-user（盘不在，不能拿别的卷顶）
 *   候选 === 0 且 卷都还在（本机目录）   ⇒ recreated（就地重建，旧行为）
 * 首启：
 *   盘上运行                            ⇒ auto-portable
 *   否则                                ⇒ default
 * ```
 */
export function decideWorkspaceStartup(input: WorkspaceStartupInput): WorkspaceStartupDecision {
  const recorded = input.recordedPath?.trim();
  if (recorded) {
    /**
     * B1（2026-10 基线审查 P1）：`exists(recorded)` **不是**"这份工作区属于当前盘"的证明。
     * 旧盘符上的同名字目录还在时（换了盘符的新盘 + 旧盘也插着/旧目录没清），老行为
     * 直接 `configured(旧路径)` —— 启动成功，但**用的不是当前盘的数据**。
     *
     * 归属：app-volume（新记录显式声明；老记录记过盘上相对路径的按此保守处理）按
     * "跟当前运行卷 + 合法相对路径"解析；explicit-path（用户显式选的外部目录）遵从用户。
     */
    const binding = input.workspaceBinding ?? null;
    const appVolume = binding === 'app-volume' || (binding === null && Boolean(input.recordedRelPath));
    /** R1：显式选择的外部位置 —— 缺失时只许走 ask-user（用户确认），绝不静默改指。 */
    const explicitPath = binding === 'explicit-path';
    const recordedExists = input.exists(recorded);
    const runVolume = input.portableRoot ? (normalizeVolumeRoot(input.portableRoot) ?? input.portableRoot) : null;

    if (recordedExists) {
      if (!appVolume) return { kind: 'configured', path: recorded };
      const recordedVolume = volumeRootOf(recorded);
      if (!runVolume || !recordedVolume || sameVolumeRoot(recordedVolume, runVolume)) {
        return { kind: 'configured', path: recorded };
      }
      // 记录的卷 ≠ 当前运行卷：不早退，落入下面的候选流程 —— 无证据的旧卷同名目录
      // 会被候选构造拒绝（唯一 F 命中 ⇒ healed）；两卷都有证据 ⇒ ask-user（绝不猜）。
    }

    const candidates = buildWorkspaceHealCandidates({
      recordedPath: recorded,
      relPath: input.recordedRelPath,
      volumeMarker: input.volumeMarker,
      removableDrives: input.removableDrives,
      // 盘上运行时把"自己在的那块盘"也当候选（固定盘/枚举失败时的唯一活路）
      runVolumeRoot: input.portableRoot ?? null,
      exists: input.exists,
    });

    /**
     * R1（2026-10-10 集中终审 §3）：explicit-path 的原始目录不在了 ⇒ 一律 ask-user。
     * 候选照摆（用户可以从里面确认一个），但**未经确认不跨卷、不改归属** ——
     * 旧行为会静默 opened(F) 并把归属改记成 app-volume，等于替用户换掉了工作区。
     */
    if (explicitPath && !recordedExists) {
      return { kind: 'ask-user', recordedPath: recorded, candidates };
    }

    if (candidates.length === 1) {
      /**
       * R1：app-volume 的唯一候选只有在**当前运行卷**上时才允许静默胜出 ——
       * 旧卷/其他卷的唯一候选（旧盘还插着、marker 都在）是"别人家的同一份"，
       * 摆给用户确认；当前运行卷没有合法目标时同样要问。
       * ⚠️ 运行卷未知（非盘上启动）时保持旧的静默自愈 —— 没有"当前卷"可比，
       *    唯一带证据的候选仍是 2026-09-18 实机那条救命路径（见该用例）。
       */
      const viaVolume = volumeRootOf(candidates[0].path);
      if (appVolume && runVolume && !sameVolumeRoot(viaVolume, runVolume)) {
        return { kind: 'ask-user', recordedPath: recorded, candidates };
      }
      return { kind: 'healed', path: candidates[0].path, from: recorded, via: candidates[0] };
    }
    if (candidates.length > 1) {
      return { kind: 'ask-user', recordedPath: recorded, candidates };
    }

    // 零命中：记过 relPath 说明这份工作区在**某个盘**上（可能没插）—— 拿本机随便一个
    // 卷重建会在错误的位置造出一份空工作区，用户会以为数据丢了。必须问。
    const volumeRoot = volumeRootOf(recorded);
    const onVolume = Boolean(input.recordedRelPath);
    if (onVolume || !volumeRoot || !input.exists(volumeRoot)) {
      return { kind: 'ask-user', recordedPath: recorded, candidates: [] };
    }
    return { kind: 'recreated', path: recorded };
  }

  if (input.portableRoot) {
    return {
      kind: 'auto-portable',
      path: portableWorkspacePathFor(input.portableRoot),
      volumeRoot: input.portableRoot,
    };
  }

  return { kind: 'default', path: input.defaultPath };
}
