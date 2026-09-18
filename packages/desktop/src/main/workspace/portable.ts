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
import { RUNTIME_MANIFEST_FILE } from '../runtime/locate.js';

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

export interface PortableRunInput {
  /** 打包态是 `process.execPath`（exe），dev 是 electron 的 exe。 */
  exePath: string;
  /** `listRemovableDrives()` 的结果（DriveType=2 的盘符）。 */
  removableDrives: readonly string[];
  exists: (p: string) => boolean;
  /** 盘根 marker 名，默认 `openclaw-runtime-manifest.json`。 */
  volumeMarker?: string | null;
}

export type PortableRunReason = 'removable-drive' | 'volume-marker';

export interface PortableRunDetection {
  portable: boolean;
  volumeRoot: string | null;
  /** 命中的判据（日志/对话框里要说清"凭什么认为是盘上运行"）。 */
  reason: PortableRunReason | null;
}

/**
 * 「是不是从盘上运行」——判定顺序：
 *
 * ① `exePath` 所在卷在**可移动盘**列表里（DriveType=2）⇒ 是；
 * ② 该卷**根目录**存在盘根 marker（`openclaw-runtime-manifest.json`）⇒ 是；
 * ③ 否则不是（本机安装形态 / dev）。
 *
 * ⚠️ ②不能省：`listRemovableDrives()` 是靠 PowerShell 枚举的，**失败时返回空数组**
 *    （枚举失败不是错误，见 `locate.ts`）—— 少了 ② 的话，一旦枚举失败，
 *    盘上运行会被误判成安装形态，用户又回到"要选盘"。
 */
export function detectPortableRun(input: PortableRunInput): PortableRunDetection {
  const volumeRoot = volumeRootOf(input.exePath);
  if (!volumeRoot) return { portable: false, volumeRoot: null, reason: null };

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

export interface WorkspaceLocationDescription {
  workspaceRelPath?: string;
  volumeMarker?: string;
}

/**
 * 为工作区**补记**迁移线索（`workspaceRelPath` + `volumeMarker`），供下次自愈用。
 *
 * ⚠️ **只对可移动盘上的工作区记录**：本机固定盘（`C:\Users\…`）的工作区目录被删了，
 *    旧行为是"悄悄重建"，不该因为多记了一条相对路径就变成"弹框让你选盘"。
 *    这条边界是刻意的 —— 记了就代表"这份工作区在某个盘上，下次得去找它"。
 */
export function describeWorkspaceLocation(input: {
  workspacePath: string;
  removableDrives: readonly string[];
  exists: (p: string) => boolean;
  volumeMarker?: string | null;
}): WorkspaceLocationDescription {
  const volumeRoot = volumeRootOf(input.workspacePath);
  if (!volumeRoot) return {};
  if (!isRemovableVolume(volumeRoot, input.removableDrives)) return {};

  const rel = deriveWorkspaceRelPath(input.workspacePath);
  if (!rel) return {};

  const marker = input.volumeMarker || RUNTIME_MANIFEST_FILE;
  return {
    workspaceRelPath: rel,
    volumeMarker: input.exists(P().join(volumeRoot, marker)) ? marker : undefined,
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
}): { workspaceRelPath?: string; volumeMarker?: string } {
  const location = describeWorkspaceLocation(input);
  return { workspaceRelPath: undefined, volumeMarker: undefined, ...location };
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
  const rel = input.relPath ? input.relPath.replace(/^[\\/]+/, '') : null;
  if (!rel) return [];

  const marker = input.volumeMarker || RUNTIME_MANIFEST_FILE;
  const out: WorkspaceHealCandidate[] = [];
  const seen = new Set<string>();

  const push = (candidate: WorkspaceHealCandidate): void => {
    const key = foldForCompare(candidate.path);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(candidate);
  };

  /** 佐证：目录里有没有我们的工作区标记 / 盘根有没有运行时 marker。都没有 ⇒ 不认。 */
  const evidenceOf = (candidate: string, volumeRoot: string): WorkspaceCandidateEvidence | null => {
    if (input.exists(P().join(volumeRoot, marker))) return 'volume-marker';
    if (input.exists(P().join(candidate, WORKSPACE_MARKER_FILE))) return 'workspace-marker';
    return null;
  };

  // ① 同盘符
  const volumeRoot = volumeRootOf(input.recordedPath);
  if (volumeRoot) {
    const candidate = P().join(volumeRoot, rel);
    if (input.exists(candidate)) {
      const evidence = evidenceOf(candidate, volumeRoot);
      if (evidence) push({ path: candidate, origin: 'same-letter', evidence });
    }
  }

  // ② 应用**自己运行所在的那块盘**（排在扫盘之前：它比"别的某块盘"更像答案）。
  //    盘列表为空/报成固定盘时，这是唯一还能救命的判据。
  if (input.runVolumeRoot) {
    const root = normalizeVolumeRoot(input.runVolumeRoot);
    if (root) {
      const candidate = P().join(root, rel);
      if (input.exists(candidate)) {
        const evidence = evidenceOf(candidate, root);
        if (evidence) push({ path: candidate, origin: 'run-volume', evidence });
      }
    }
  }

  // ③ 扫可移动盘
  for (const drive of input.removableDrives) {
    const root = normalizeVolumeRoot(drive);
    if (!root) continue;
    const candidate = P().join(root, rel);
    if (!input.exists(candidate)) continue;

    const evidence = evidenceOf(candidate, root);
    if (!evidence) continue;

    push({ path: candidate, origin: 'removable-scan', evidence });
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
 *   exists(记录)                        ⇒ configured
 *   候选 === 1                          ⇒ healed（静默）
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
    if (input.exists(recorded)) return { kind: 'configured', path: recorded };

    const candidates = buildWorkspaceHealCandidates({
      recordedPath: recorded,
      relPath: input.recordedRelPath,
      volumeMarker: input.volumeMarker,
      removableDrives: input.removableDrives,
      // 盘上运行时把"自己在的那块盘"也当候选（固定盘/枚举失败时的唯一活路）
      runVolumeRoot: input.portableRoot ?? null,
      exists: input.exists,
    });

    if (candidates.length === 1) {
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
