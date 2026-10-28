import { randomUUID } from 'node:crypto';
import type { BigIntStats, Dirent } from 'node:fs';
import { hasStrongIdentity, identityKey, identityOf, sameIdentity } from '../util/file-identity.js';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Artifact, ArtifactAvailability, ArtifactRootKind } from '@clawwork/shared';
import { getSqlite } from '../db/index.js';
import { validateImportTaskId } from '../context/file-import.js';
import { ensureTaskDir } from '../workspace/init.js';
import { captureArtifactWorkspaceOwner } from './workspace-owner.js';
import { isIntermediateArtifactName } from './extract.js';
import { artifactFromRow } from './row.js';
import { isVerifiedFileName, verifyArtifactBuffer } from './verify.js';

const DEFAULT_BUDGETS = Object.freeze({
  maxDepth: 4,
  maxVisited: 1_000,
  maxResults: 100,
  maxTotalBytes: 512 * 1024 * 1024,
});
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const STABILITY_DELAY_MS = 250;

const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.py': 'text/x-python',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
};

export type ArtifactBaseline = Record<string, string>;
const BASELINE_COMPLETE = Symbol('artifactBaselineComplete');
type TrackedArtifactBaseline = ArtifactBaseline & { [BASELINE_COMPLETE]?: boolean };

export interface ArtifactScanBudgets {
  maxDepth: number;
  maxVisited: number;
  maxResults: number;
  maxTotalBytes: number;
}

export interface ReconcileTaskArtifactsInput {
  /**
   * 扫描根。
   *
   * ⚠️ **含义随 `rootKind` 变**：
   *    - 缺省 / `'workspace'`：**应用工作区**，扫描根是 `<workspacePath>/<taskId>`
   *    - `'agent'`：**助手自己的工作区**，扫描根就是它本身
   *    - `'workspace-root'`：**应用工作区的根层**，扫描根就是它本身（深度 0，不递归）
   */
  workspacePath: string;
  taskId: string;
  messageId: string;
  baseline: ArtifactBaseline;
  /** 见 `workspacePath`。缺省 = `'workspace'`（老行为）。 */
  rootKind?: ArtifactRootKind;
  /**
   * 候选落库前的一道闸（调用方按"这一轮是不是还算数"给）。
   *
   * ⚠️ 参数是**相对本条根的**路径（由 `normalizedRelativePath(root.realTask, …)` 得来）。
   *    第三个根的相对路径是**裸文件名** —— 调用方**不能**拿 `<workspacePath>/<taskId>/<file>`
   *    那套拼接去解析它（解析结果是错的，而且不报错，只是永远匹配不上）。
   */
  isCandidateCurrent?: (relativePath: string) => boolean;
}

export interface ReconcileTaskArtifactsResult {
  saved: Artifact[];
  existing: Artifact[];
  updated: Artifact[];
  missing: Artifact[];
  skipped: string[];
  budgetExhausted: boolean;
}

interface ReconcileHooks {
  beforeSecondSnapshot?: (input: { absolutePath: string; relativePath: string }) => void | Promise<void>;
  /**
   * 完整性读（`readFileSync`）**之前**的一瞬。只给测试用：真机上的"读失败"
   * （EBUSY/EACCES/杀软隔离/U 盘拔出）没法在 NTFS 上确定性复现，而它恰恰是
   * P1-1 那条判据（读失败 ≠ 结构损坏）的分界点 —— 探针在这里制造读失败。
   */
  beforeIntegrityRead?: (input: { absolutePath: string; relativePath: string }) => void | Promise<void>;
  budgets?: Partial<ArtifactScanBudgets>;
  stabilityDelayMs?: number;
}

interface CaptureBaselineHooks {
  budgets?: Partial<ArtifactScanBudgets>;
}

interface TrustedTaskRoot {
  workspacePath: string;
  taskPath: string;
  realWorkspace: string;
  realTask: string;
  workspaceIdentity: BigIntStats;
  taskIdentity: BigIntStats;
}

interface Candidate {
  absolutePath: string;
  relativePath: string;
  stats: BigIntStats;
  mimeType: string;
}

class UnstableArtifactError extends Error {}

/**
 * 身份判定一律走 `util/file-identity.ts`（bigint，逐位比）。
 *
 * ⚠️ 这段原来的守卫是 `Number.isFinite(dev) && Number.isFinite(ino) && dev > 0 && ino > 0`，
 *    **挡不住丢精度**：`ino` 是 64 位，Number 在超过 2^53 后会把**相邻的两个值**舍入成同一个
 *    ⇒ 两个不同的文件被判成「同一个」。而这里几处全是**变更检测 / 防掉包**
 *    （「扫描期间这个文件/目录被换过吗」），误判 = **fail-open**：
 *    把变了的当成没变 ⇒ 索引到陈旧内容、或把别的内容当成用户那份，**不报错、只出错**。
 */
function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameIdentity(identityOf(left), identityOf(right)) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function samePath(left: string, right: string): boolean {
  return relative(resolve(left), resolve(right)) === '';
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function trustedTaskRoot(workspacePath: string, taskIdValue: string): TrustedTaskRoot {
  const taskId = validateImportTaskId(taskIdValue);
  try {
    const workspaceIdentity = lstatSync(workspacePath, { bigint: true });
    const realWorkspace = realpathSync.native(workspacePath);
    const taskPath = join(workspacePath, taskId);
    const taskIdentity = lstatSync(taskPath, { bigint: true });
    const realTask = realpathSync.native(taskPath);
    if (
      workspaceIdentity.isSymbolicLink() ||
      taskIdentity.isSymbolicLink() ||
      !workspaceIdentity.isDirectory() ||
      !taskIdentity.isDirectory() ||
      !hasStrongIdentity(identityOf(workspaceIdentity)) ||
      !hasStrongIdentity(identityOf(taskIdentity)) ||
      !isWithin(realWorkspace, realTask) ||
      !samePath(realTask, resolve(realWorkspace, taskId))
    ) {
      throw new Error();
    }
    return { workspacePath, taskPath, realWorkspace, realTask, workspaceIdentity, taskIdentity };
  } catch {
    throw new Error('trusted task output directory is unavailable');
  }
}

/**
 * 受信根：**一个已知的、非符号链接、有强身份的目录**（第二 / 第三个根的公共形状）。
 *
 * ## ⚠️ 这里刻意让 `taskPath === workspacePath`
 *
 * 那个"任务根"的形状是下游十几个守卫的**共同前提**（`collectPaths` 的 `isWithin`、
 * `stableCandidateOnce` 的 realpath 比对、`verifyTrustedRoot` 的身份复核、
 * `normalizedRelativePath`）。把两个字段都指到同一个目录，这些守卫就**一字不改**地生效 ——
 * 它们本来要的就是"一个已知的、非符号链接、有强身份的目录"。
 *
 * ⚠️ **不建目录**（与 `trustedTaskRoot` 的调用方不同）：这两个根都不是"我们的任务目录"，
 *    我们只读。不存在就是"读不到"，由调用方回落成"没有这个根"。
 *
 * ⚠️ 两个根共用这一份实现（而不是各写一遍）：这是**安全路径**，抄一份就意味着
 *    以后一处补了守卫、另一处漏了 —— 差别只在失败时抛出的那句话（`failureMessage`）。
 */
function trustedDirectoryRoot(directoryPath: string, failureMessage: string): TrustedTaskRoot {
  try {
    const identity = lstatSync(directoryPath, { bigint: true });
    const real = realpathSync.native(directoryPath);
    if (identity.isSymbolicLink() || !identity.isDirectory() || !hasStrongIdentity(identityOf(identity))) {
      throw new Error();
    }
    return {
      workspacePath: directoryPath,
      taskPath: directoryPath,
      realWorkspace: real,
      realTask: real,
      workspaceIdentity: identity,
      taskIdentity: identity,
    };
  } catch {
    throw new Error(failureMessage);
  }
}

/**
 * 受信根：**助手自己的工作区**（第二个根，2026-09-27）。
 *
 * ## 为什么需要它
 *
 * 助手把它生成的文件写在**它自己的工作区**里（网关 `agents.entries.<id>.workspace`），
 * 而任务产物的扫描根一直是 `<应用工作区>/<taskId>` —— 两者是**兄弟目录**，永不重叠
 * ⇒ 通道外生成的文件从来没进过产物表（真机 `.clawwork.db` 实测 `COUNT(*) = 0`）。
 */
function trustedAgentWorkspaceRoot(agentWorkspacePath: string): TrustedTaskRoot {
  return trustedDirectoryRoot(agentWorkspacePath, 'trusted agent workspace is unavailable');
}

/**
 * 受信根：**应用工作区的根层**（第三个根，2026-10-07）。
 *
 * ## 为什么需要它
 *
 * 模型绕过 docgen/slidegen，用 exec / CLI 把成品直接写在 `Partner-W工作区\` 的**根**上
 * （真机形态：`Partner-W工作区\Partner-W互动公司介绍-v2-ade3018a.pptx`）。前两个根一个扫
 * `<应用工作区>/<taskId>`、一个扫助手工作区 —— 根层文件**谁都不扫**，
 * 于是"文件真的生成了，产物面板里却什么都没有"，而且**连失败提示都没有**
 * （claim-guard 找得到那份文件 ⇒ 它不算"丢了"，只是从来没被登记过）。
 *
 * ⚠️ 与应用根是**父子**关系，但必须是**独立的一趟**（不能并进 `'workspace'` 那趟）：
 *    `reconcileTaskArtifacts` 用 `local_path` 前缀判"这行归不归我"（`:641-648`），
 *    根层文件的 `local_path` 是**裸名**，混进任务目录那趟会被判成 `missing` ⇒ 界面一片红。
 */
function trustedWorkspaceRoot(workspacePath: string): TrustedTaskRoot {
  return trustedDirectoryRoot(workspacePath, 'trusted workspace root is unavailable');
}

/**
 * `source_key` 前缀。
 *
 * ⚠️ 三个根**必须两两不同**：`reconcileTaskArtifacts` 用"前缀是不是我的"来判
 *    「这行归不归我改」—— 共用前缀会让后跑的那趟把先跑那趟的行**当成自己的**改写掉。
 *    （测试钉在 `test/artifact-reconcile-signature.test.ts`。）
 */
const WORKSPACE_SOURCE_PREFIX = 'workspace-file:';
const AGENT_SOURCE_PREFIX = 'agent-workspace-file:';
/**
 * 第三个根（应用工作区**根层**）。刻意**不是** `workspace-file:` 的前缀变体：
 * 那两个前缀之间没有"谁是谁的前缀"关系，归属判定才可能是纯字符串 `startsWith`。
 */
const WORKSPACE_ROOT_SOURCE_PREFIX = 'workspace-root-file:';

/** 一趟 reconcile 的全部"根相关"取值，集中在一处，免得散落五六个分支。 */
interface ReconcileScope {
  root: TrustedTaskRoot;
  rootKind: ArtifactRootKind;
  /** 落库 `local_path` 的前缀。应用根是 `<taskId>/`（既有约定，不改）；另两个根是空串。 */
  localPrefix: string;
  sourcePrefix: string;
  /**
   * **根目录那一层**要跳过的名字（小写）。
   *
   * 只在这一层排除：助手工作区根下的 `SOUL.md` / `IDENTITY.md` / `memory/` 是
   * **助手自己的东西**，不是产物。把它们登记进去，每个任务面板里会永远躺着几十条噪音。
   * （更深层的同名文件是助手生成的，归 `excludedName` 与 MIME 表管。）
   */
  topLevelExclude: ReadonlySet<string>;
  /**
   * 这一趟允许的**最大深度上限**（硬顶，调用方只能收紧）。
   *
   * ⚠️ 深度是**根的结构属性**：第三个根是 **0** —— 只收根层文件，**绝不递归**。
   *    它的根层里躺着 `<taskId>/` 与 `partner-w-agents/` 两片目录，
   *    一旦递归就会把别人的产物、助手的配置当成本根层的东西收进来。
   */
  maxDepthLimit: number;
  /**
   * **正向**扩展名白名单（`undefined` = MIME 表里的都收，另两个根的老口径）。
   *
   * ⚠️ 第三个根刻意**收窄**：根层是**用户与模型共用**的一片（用户自己拷进来的文件、
   *    别的任务的痕迹都在这一层），所以只收"明确的交付物"格式；`.txt/.csv/.json/.css/.ts/.zip`
   *    这些在任务目录里收得了的，在这一层不收（宁可漏，不可把用户的杂物当产物）。
   *    脚本类（`.js/.cjs/.mjs/.py`）与另外两个根同一口径排除（`SCRIPT_EXTENSIONS`）。
   */
  allowedExtensions?: ReadonlySet<string>;
}

/**
 * 助手工作区**根目录**下属于"助手自己"的名字 —— 不是产物。
 *
 * ⚠️ 这是用户当初选「只要交付物」时点名排除的那一批
 *    （原话的选项写着「不进：SOUL.md / IDENTITY.md（助手自己的配置）」）。
 *    漏掉的后果不是"少一条"，是**每个任务的产物面板里都堆满同一批配置噪音**。
 */
const AGENT_WORKSPACE_RESERVED: ReadonlySet<string> = new Set([
  'soul.md',
  'identity.md',
  'agents.md',
  'user.md',
  'dreams.md',
  'memory.md',
  'memory',
  'skills',
  'inbox',
]);

/**
 * 应用工作区**根层**里属于"应用自己"的名字（小写）—— 不是产物。
 *
 * ⚠️ 这三条**本来就是**应用自己的东西：库（`.clawwork.db`）、工作区标记
 *    （`.clawwork-workspace.json`）、助手工作区（`partner-w-agents/`）。
 *    点开头那两个已被 `excludedName` 挡下、`partner-w-agents/` 是目录（depth 0 已被截断）——
 *    这里**再点名一遍**是刻意的：这一层的"哪些不是产物"要**写出来**，
 *    而不是靠三条分散的隐式规则凑出来（改任意一条规则都会悄悄改变这一层的语义）。
 */
const WORKSPACE_ROOT_RESERVED: ReadonlySet<string> = new Set([
  '.clawwork.db',
  '.clawwork-workspace.json',
  'partner-w-agents',
]);

/**
 * 第三个根的**正向**扩展名白名单（见 `ReconcileScope.allowedExtensions`）。
 *
 * 文档 / 演示 / 表格 / 网页 / 图片，加上视频（`.mp4/.webm`，与另外两个根同一口径）。
 *
 * ⚠️ `.md` **在**名单里（这是刻意定的策，不是漏）：模型把交付说明写成 Markdown 是常见形态，
 *    而且 `<taskId>` 那趟本来就收 `.md` —— 根层不收它，只会让同一个用户看到两种口径。
 *    代价是根层的模型笔记也会进来；与"生成了必进产物"比，这个方向的错更可接受。
 * ⚠️ 老式二进制 Office（`.doc/.xls/.ppt`）**不在**名单里：随包的工具链产不出现代格式以外的
 *    交付物，而这一层宁可漏也不收杂物。
 */
const WORKSPACE_ROOT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pptx',
  '.docx',
  '.xlsx',
  '.pdf',
  '.html',
  '.md',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.mp4',
  '.webm',
]);

function scopeFor(input: { workspacePath: string; taskId: string; rootKind?: ArtifactRootKind }): ReconcileScope {
  if (input.rootKind === 'agent') {
    return {
      root: trustedAgentWorkspaceRoot(input.workspacePath),
      rootKind: 'agent',
      localPrefix: '',
      sourcePrefix: AGENT_SOURCE_PREFIX,
      // ⭐ 助手工作区根下有助手自己的配置 —— 那些不是产物（见 `AGENT_WORKSPACE_RESERVED`）。
      topLevelExclude: AGENT_WORKSPACE_RESERVED,
      maxDepthLimit: DEFAULT_BUDGETS.maxDepth,
    };
  }
  if (input.rootKind === 'workspace-root') {
    return {
      root: trustedWorkspaceRoot(input.workspacePath),
      rootKind: 'workspace-root',
      localPrefix: '',
      sourcePrefix: WORKSPACE_ROOT_SOURCE_PREFIX,
      topLevelExclude: WORKSPACE_ROOT_RESERVED,
      // ⭐ **绝不递归**：这一层的 `<taskId>/` 与 `partner-w-agents/` 是**别人的**产物与配置。
      maxDepthLimit: 0,
      allowedExtensions: WORKSPACE_ROOT_EXTENSIONS,
    };
  }
  return {
    root: trustedTaskRoot(input.workspacePath, input.taskId),
    rootKind: 'workspace',
    localPrefix: `${input.taskId}/`,
    sourcePrefix: WORKSPACE_SOURCE_PREFIX,
    // 应用根的"任务目录"里**没有**助手配置，保持原样（一个名字都不多排除）。
    topLevelExclude: EMPTY_EXCLUDE,
    maxDepthLimit: DEFAULT_BUDGETS.maxDepth,
  };
}

const EMPTY_EXCLUDE: ReadonlySet<string> = new Set();

/**
 * 一趟扫描的预算：默认 → 再叠加**本根**的上限（只收不放）→ 再叠加调用方（测试）的覆盖。
 *
 * ⚠️ `maxDepth` 用 `min` 收口而不是直接覆盖：调用方可以**收紧**（测试里就是这么做的），
 *    但**不能**突破本趟的硬顶 —— 第三个根的 0 是安全属性，不是默认值。
 */
function scanBudgets(
  scope: ReconcileScope,
  hooks: Partial<ArtifactScanBudgets> = {},
  overrides: Partial<ArtifactScanBudgets> = {},
): ArtifactScanBudgets {
  const merged = { ...DEFAULT_BUDGETS, ...hooks, ...overrides };
  return { ...merged, maxDepth: Math.min(merged.maxDepth, scope.maxDepthLimit) };
}

function verifyTrustedRoot(root: TrustedTaskRoot): void {
  try {
    const workspaceIdentity = lstatSync(root.workspacePath, { bigint: true });
    const taskIdentity = lstatSync(root.taskPath, { bigint: true });
    if (
      workspaceIdentity.isSymbolicLink() ||
      taskIdentity.isSymbolicLink() ||
      !workspaceIdentity.isDirectory() ||
      !taskIdentity.isDirectory() ||
      !sameIdentity(identityOf(workspaceIdentity), identityOf(root.workspaceIdentity)) ||
      !sameIdentity(identityOf(taskIdentity), identityOf(root.taskIdentity)) ||
      !samePath(realpathSync.native(root.workspacePath), root.realWorkspace) ||
      !samePath(realpathSync.native(root.taskPath), root.realTask)
    ) {
      throw new Error();
    }
  } catch {
    throw new Error('trusted task output directory changed');
  }
}

function normalizedRelativePath(taskPath: string, absolutePath: string): string {
  return relative(taskPath, absolutePath).split(sep).join('/');
}

/**
 * 基线签名。⚠️ 身份部分必须用 `identityKey`（bigint 的精确值）：
 *    这里比的是「内容没变就跳过」，用 Number 版的身份会让两个**不同**文件的签名相同
 *    ⇒ 该处理的被跳过 ⇒ **陈旧数据**。
 * ⚠️ 换格式会让**旧基线一次性作废**（多跑一轮全量），方向是安全的（多做不会漏）。
 */
function signature(stats: BigIntStats): string {
  return `${identityKey(identityOf(stats))}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

function excludedName(name: string): boolean {
  return name.startsWith('.') || isIntermediateArtifactName(name);
}

/**
 * **代码脚本不进产物**（2026-10-06，用户反馈 #9："重新生成 docx：桌面出现 js 文件"）。
 *
 * 模型干活时会往工作区里写自己的作业脚本（调试 `debug.js`、生成器 `generate.cjs`、
 * 临时 `probe.py`…）。自动收编把它们当"新文件"登记进产物列表 —— 用户要的是**交付物**，
 * 不是模型的中间作业。
 *
 * ⚠️ 只管**自动扫描登记**这一条路：显式保存（`saveArtifact*`，含"围栏代码块 ⇒ code 产物"）
 *    完全不经过本扫描 —— 用户点名要的代码仍然进得了列表。
 * ⚠️ 三个根（应用根 / 助手根 / 应用工作区根层）**同一口径**：按根分叉只会让同一份文件在两处表现不一致，
 *    而这三个根都没有"脚本算交付物"的场景。
 * ⚠️ 只排除这四类**脚本**；`.ts/.json/.md/.html/.css` 与 pptx/docx/xlsx/pdf/图片/视频
 *    一律照旧 —— 边界是"模型自己跑过的作业文件"，不是"所有文本/代码"。
 */
const SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set(['.js', '.cjs', '.mjs', '.py']);
function excludedScriptName(name: string): boolean {
  return SCRIPT_EXTENSIONS.has(extname(name).toLowerCase());
}

function mimeTypeFor(name: string): string | null {
  return MIME_TYPES[extname(name).toLowerCase()] ?? null;
}

function artifactType(mimeType: string): Artifact['type'] {
  // BUG-120（2026-10-17）：视频按 mime 认成 `'video'`。
  // 扫描登记这条路（本文件）与 videogen 显式保存那条路必须**同一口径** ——
  // 同一份 `.mp4` 不该因为"走哪条登记路径"就换一个类型。
  if (mimeType.startsWith('video/')) return 'video';
  return mimeType.startsWith('image/') ? 'image' : 'file';
}

function safeDirectoryEntries(directoryPath: string, taskRoot: string): Dirent[] {
  const before = lstatSync(directoryPath, { bigint: true });
  const realDirectory = realpathSync.native(directoryPath);
  const canonical = statSync(realDirectory, { bigint: true });
  if (
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    !sameIdentity(identityOf(before), identityOf(canonical)) ||
    !isWithin(taskRoot, realDirectory) ||
    !samePath(realDirectory, directoryPath)
  ) {
    throw new Error('task output directory identity changed');
  }
  const directory = opendirSync(directoryPath);
  const entries: Dirent[] = [];
  try {
    while (true) {
      const entry = directory.readSync();
      if (!entry) break;
      entries.push(entry);
    }
    const after = lstatSync(directoryPath, { bigint: true });
    if (
      !sameIdentity(identityOf(before), identityOf(after)) ||
      !samePath(realpathSync.native(directoryPath), realDirectory)
    ) {
      throw new Error('task output directory identity changed');
    }
    directory.closeSync();
    return entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  } catch (error) {
    try {
      directory.closeSync();
    } catch {
      throw new Error('unable to close task output directory');
    }
    throw error;
  }
}

function collectPaths(
  root: TrustedTaskRoot,
  budgets: ArtifactScanBudgets,
  baseline?: ArtifactBaseline,
  /** 根目录那一层要跳过的名字（小写）；见 `ReconcileScope.topLevelExclude`。 */
  topLevelExclude: ReadonlySet<string> = new Set(),
  /** 正向扩展名白名单；`undefined` = MIME 表里的都收。见 `ReconcileScope.allowedExtensions`。 */
  allowedExtensions?: ReadonlySet<string>,
): {
  candidates: Candidate[];
  skipped: string[];
  budgetExhausted: boolean;
} {
  const candidates: Candidate[] = [];
  const skipped: string[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: root.realTask, depth: 0 }];
  let visited = 0;
  let totalBytes = 0;
  let budgetExhausted = false;

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const entry of safeDirectoryEntries(current.path, root.realTask)) {
      if (visited >= budgets.maxVisited) {
        budgetExhausted = true;
        break;
      }
      visited += 1;
      const absolutePath = join(current.path, entry.name);
      const relativePath = normalizedRelativePath(root.realTask, absolutePath);
      const lowerName = entry.name.toLowerCase();
      if (
        (current.depth === 0 && (lowerName === 'inbox' || topLevelExclude.has(lowerName))) ||
        excludedName(entry.name)
      ) {
        skipped.push(relativePath);
        continue;
      }
      let stats: BigIntStats;
      try {
        stats = lstatSync(absolutePath, { bigint: true });
      } catch {
        skipped.push(relativePath);
        continue;
      }
      if (stats.isSymbolicLink()) {
        skipped.push(relativePath);
        continue;
      }
      if (stats.isDirectory()) {
        if (current.depth >= budgets.maxDepth) {
          // ⚠️ 深度截断是**确定性范围**，不是"预算耗尽"（2026-10-05）：基线与复核用同一条
          //    `maxDepth` 扫同一棵树 ⇒ 被截掉的那一层在两趟里都确定不在范围内，不会把基线
          //    漏掉的文件在复核时误判成"本轮新增"。原先在这里置 exhausted ⇒
          //    `BASELINE_COMPLETE=false` ⇒ `reconcileTaskArtifacts` 整趟早退
          //    （saved/existing/skipped 全空、零日志）。真机形态：
          //    `partner-w-agents/<id>/memory/dreaming/{deep,light,rem}` 这类超深目录
          //    让产物登记永远空转。只有 maxVisited / maxResults / maxTotalBytes
          //    真把**范围内**的文件半途丢掉才算耗尽（见下方两个分支）。
          skipped.push(relativePath);
        } else {
          const realDirectory = realpathSync.native(absolutePath);
          if (isWithin(root.realTask, realDirectory) && samePath(realDirectory, absolutePath)) {
            queue.push({ path: realDirectory, depth: current.depth + 1 });
          } else {
            skipped.push(relativePath);
          }
        }
        continue;
      }
      // ⭐ 代码脚本（模型自己的作业文件）不进产物 —— 只对**文件**生效（同名目录照常遍历）。
      if (excludedScriptName(entry.name)) {
        skipped.push(relativePath);
        continue;
      }
      const mimeType = mimeTypeFor(entry.name);
      const size = Number(stats.size);
      if (
        !stats.isFile() ||
        !mimeType ||
        // ⭐ 正向白名单（第三个根）：MIME 表认得 ≠ 这一层收（见 `ReconcileScope.allowedExtensions`）。
        (allowedExtensions !== undefined && !allowedExtensions.has(extname(entry.name).toLowerCase())) ||
        !hasStrongIdentity(identityOf(stats)) ||
        size <= 0 ||
        size > MAX_FILE_BYTES
      ) {
        skipped.push(relativePath);
        continue;
      }
      if (baseline?.[relativePath] === signature(stats)) continue;
      if (candidates.length >= budgets.maxResults || totalBytes + size > budgets.maxTotalBytes) {
        budgetExhausted = true;
        skipped.push(relativePath);
        continue;
      }
      candidates.push({ absolutePath, relativePath, stats, mimeType });
      totalBytes += size;
    }
    if (budgetExhausted && visited >= budgets.maxVisited) break;
  }
  return { candidates, skipped, budgetExhausted };
}

function listTaskArtifacts(taskId: string): Artifact[] {
  const sqlite = getSqlite();
  if (!sqlite) throw new Error('database not ready');
  return (
    sqlite.prepare('SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at, id').all(taskId) as Record<
      string,
      unknown
    >[]
  ).map(artifactFromRow);
}

export async function captureTaskArtifactBaseline(
  input: {
    workspacePath: string;
    taskId: string;
    /** 见 `ReconcileTaskArtifactsInput.workspacePath`。缺省 = `'workspace'`。 */
    rootKind?: ArtifactRootKind;
  },
  hooks: CaptureBaselineHooks = {},
): Promise<ArtifactBaseline> {
  validateImportTaskId(input.taskId);
  // ⚠️ 建任务目录**只在应用根**做：助手的工作区（网关的沙箱）与应用工作区的**根层**
  //    （第三个根扫的就是这一层）都只读 —— 绝不因为它们不存在就往里建东西。
  if (
    input.rootKind !== 'agent' &&
    input.rootKind !== 'workspace-root' &&
    !existsSync(join(input.workspacePath, input.taskId))
  ) {
    ensureTaskDir(input.workspacePath, input.taskId);
  }
  const scope = scopeFor(input);
  const root = scope.root;
  // 基线要"看得见范围内**所有**候选"，所以结果数/字节数放到预算之外（只留 visited 把关）。
  const budgets = scanBudgets(scope, hooks.budgets, {
    maxResults: DEFAULT_BUDGETS.maxVisited,
    maxTotalBytes: Number.MAX_SAFE_INTEGER,
  });
  const { candidates, budgetExhausted } = collectPaths(
    root,
    budgets,
    undefined,
    scope.topLevelExclude,
    scope.allowedExtensions,
  );
  verifyTrustedRoot(root);
  const baseline = Object.fromEntries(
    candidates.map((candidate) => [candidate.relativePath, signature(candidate.stats)]),
  ) as TrackedArtifactBaseline;
  Object.defineProperty(baseline, BASELINE_COMPLETE, { value: !budgetExhausted });
  return baseline;
}

async function stableCandidateOnce(
  root: TrustedTaskRoot,
  candidate: Candidate,
  hooks: ReconcileHooks,
): Promise<{ candidate: Candidate; fd: number; stats: BigIntStats } | null> {
  let fd = -1;
  try {
    fd = openSync(candidate.absolutePath, 'r');
    const opened = fstatSync(fd, { bigint: true });
    const pathStats = lstatSync(candidate.absolutePath, { bigint: true });
    const realFile = realpathSync.native(candidate.absolutePath);
    if (
      pathStats.isSymbolicLink() ||
      !opened.isFile() ||
      !sameSnapshot(candidate.stats, opened) ||
      !sameSnapshot(opened, pathStats) ||
      !isWithin(root.realTask, realFile) ||
      !samePath(realFile, candidate.absolutePath)
    ) {
      closeSync(fd);
      return null;
    }
    await hooks.beforeSecondSnapshot?.({ absolutePath: candidate.absolutePath, relativePath: candidate.relativePath });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, hooks.stabilityDelayMs ?? STABILITY_DELAY_MS));
    const secondHandle = fstatSync(fd, { bigint: true });
    const secondPath = lstatSync(candidate.absolutePath, { bigint: true });
    if (!sameSnapshot(opened, secondHandle) || !sameSnapshot(opened, secondPath)) {
      closeSync(fd);
      return null;
    }
    return { candidate, fd, stats: secondHandle };
  } catch {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {}
    }
    return null;
  }
}

function refreshCandidate(root: TrustedTaskRoot, relativePath: string): Candidate | null {
  try {
    verifyTrustedRoot(root);
    const absolutePath = resolve(root.realTask, relativePath);
    const stats = lstatSync(absolutePath, { bigint: true });
    const mimeType = mimeTypeFor(relativePath);
    if (
      !mimeType ||
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      !hasStrongIdentity(identityOf(stats)) ||
      Number(stats.size) <= 0 ||
      Number(stats.size) > MAX_FILE_BYTES ||
      !isWithin(root.realTask, absolutePath) ||
      !samePath(realpathSync.native(absolutePath), absolutePath)
    ) {
      return null;
    }
    return { absolutePath, relativePath, stats, mimeType };
  } catch {
    return null;
  }
}

async function stableCandidate(
  root: TrustedTaskRoot,
  candidate: Candidate,
  hooks: ReconcileHooks,
): Promise<{ candidate: Candidate; fd: number; stats: BigIntStats } | null> {
  let current: Candidate | null = candidate;
  for (let attempt = 0; attempt < 2 && current; attempt += 1) {
    const stable = await stableCandidateOnce(root, current, hooks);
    if (stable) return stable;
    current = refreshCandidate(root, candidate.relativePath);
  }
  return null;
}

function localPathFor(localPrefix: string, relativePath: string): string {
  return `${localPrefix}${relativePath}`;
}

/**
 * 落库的来源键。⚠️ 身份部分是 `artifacts` 表里用来判「同一个来源文件」的，
 *    同样必须精确 —— 否则两个不同文件会被认成同一个来源（去重错误）。
 *
 * ⚠️ 前缀**按根变**：同一个 `reconcileTaskArtifacts` 既跑应用根也跑助手根，
 *    而它用"前缀是不是我的"判「这行归不归我改」—— 共用前缀会让后跑的那趟
 *    把先跑那趟的行当成自己的改写掉。
 *
 * 前缀单独传（而不是收整个 `ReconcileScope`）：这个函数只用到前缀，
 * 而它又是**唯一按函数级钉身份精度**的入口（见 `__testing`）。
 */
function sourceKeyFor(sourcePrefix: string, relativePath: string, stats: BigIntStats): string {
  return `${sourcePrefix}${relativePath}:${identityKey(identityOf(stats))}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

export async function reconcileTaskArtifacts(
  input: ReconcileTaskArtifactsInput,
  hooks: ReconcileHooks = {},
): Promise<ReconcileTaskArtifactsResult> {
  const owner = captureArtifactWorkspaceOwner();
  const scope = scopeFor(input);
  const root = scope.root;
  const budgets = scanBudgets(scope, hooks.budgets);
  // ⚠️ 只认**本根**的行。一个任务会同时挂两批产物（应用根 + 助手根），
  //    混在一起算 `missing` 会把另一批整个判成"文件不见了"（在界面上就是一片红）。
  const existingRows = listTaskArtifacts(input.taskId).filter(
    (artifact) => (artifact.root ?? 'workspace') === scope.rootKind,
  );
  const missing = existingRows.filter(
    (artifact) =>
      !artifact.localPath.startsWith(scope.localPrefix) ||
      getArtifactAvailability(artifact.localPath, input.workspacePath) !== 'available',
  );
  const saved: Artifact[] = [];
  const existing: Artifact[] = [];
  const updated: Artifact[] = [];
  if ((input.baseline as TrackedArtifactBaseline)[BASELINE_COMPLETE] === false) {
    verifyTrustedRoot(root);
    return { saved, existing, updated, missing, skipped: [], budgetExhausted: true };
  }
  const discovered = collectPaths(root, budgets, input.baseline, scope.topLevelExclude, scope.allowedExtensions);
  // Open and verify candidates in parallel so the stability window is paid
  // once per reconciliation, not once per output file. The result budget caps
  // the number of simultaneously open read-only handles.
  const stableCandidates = await Promise.all(
    discovered.candidates.map(async (candidate) => {
      const stable = await stableCandidate(root, candidate, hooks);
      if (!stable) discovered.skipped.push(candidate.relativePath);
      return stable;
    }),
  );

  try {
    owner.assertCurrent();
    for (const stable of stableCandidates) {
      if (!stable) continue;
      const { candidate } = stable;
      try {
        verifyTrustedRoot(root);
        const finalHandle = fstatSync(stable.fd, { bigint: true });
        const finalPath = lstatSync(candidate.absolutePath, { bigint: true });
        if (!sameSnapshot(stable.stats, finalHandle) || !sameSnapshot(stable.stats, finalPath)) {
          discovered.skipped.push(candidate.relativePath);
          continue;
        }
        const sqlite = getSqlite();
        if (!sqlite) throw new Error('database not ready');
        const storedLocalPath = localPathFor(scope.localPrefix, candidate.relativePath);
        const now = new Date().toISOString();
        const artifact: Artifact = {
          id: randomUUID(),
          taskId: input.taskId,
          messageId: input.messageId,
          type: artifactType(candidate.mimeType),
          name: candidate.relativePath.split('/').at(-1)!,
          filePath: candidate.absolutePath,
          localPath: storedLocalPath,
          root: scope.rootKind,
          mimeType: candidate.mimeType,
          size: Number(stable.stats.size),
          sourceKey: sourceKeyFor(scope.sourcePrefix, candidate.relativePath, stable.stats),
          contentText: '',
          createdAt: now,
          availability: 'available',
        };
        // M1 登记前置门（2026-10-06）：截断/未写完的 PPTX / 文本改名的假 DOCX 不许进库
        // （图14/16"打不开"族 + 反馈 #9"新 docx 打不开/乱码"）。
        // 不登记 = 用户不受打扰；坏文件本体留在盘上供诊断（skipped 与"不稳定"同语义）。
        if (isVerifiedFileName(candidate.relativePath)) {
          // ⚠️ 判据的**分界线**（2026-10-07 体检 P1-1）：**读失败 ≠ 结构损坏**。
          //    `readFileSync` 抛错只说明"这一瞬读不到"（EBUSY/EACCES/杀软隔离/U 盘拔出），
          //    文件本体可能完好 —— 旧实现把两者一起判成损坏、顺手 DELETE 掉登记行，
          //    而下一轮基线按签名跳过（同一路径不再当候选）⇒ 列表里那份**永久消失且不可自愈**。
          //    现在只有"读得到**且**判据明确说结构坏"才允许动登记；读不到只 skip。
          const prior = sqlite
            .prepare('SELECT id, source_key FROM artifacts WHERE task_id = ? AND root = ? AND local_path = ? LIMIT 1')
            .get(input.taskId, scope.rootKind, storedLocalPath) as { id: string; source_key: string } | undefined;
          await hooks.beforeIntegrityRead?.({
            absolutePath: candidate.absolutePath,
            relativePath: candidate.relativePath,
          });
          let integrity: ReturnType<typeof verifyArtifactBuffer> | null = null;
          try {
            integrity = verifyArtifactBuffer(candidate.relativePath, readFileSync(candidate.absolutePath));
          } catch {
            integrity = null; // 读不到 ⇒ 未知（不登记、也不删行）
          }
          if (integrity === null || !integrity.ok) {
            if (integrity !== null && prior) {
              // ⭐ 2026-10-06（原地改坏）：文件**曾经合法登记过**、现在读得出来且结构确认坏了 ——
              //    只 skip 不够：旧行还赖在产物列表里，用户点开就是坏字节（"能点开但打不开"）
              //    ⇒ 清掉那行陈旧登记。
              // ⚠️ 进事务 + **按行身份复核**（2026-10-07 体检 P3-10）：并发的那趟如果已经把这行
              //    换成了新登记（新 id / 新 source_key），这里必须**一个字节都不动** ——
              //    旧实现按 (task_id, root, local_path) 删、且在 persist 事务外，
              //    会把别趟刚登记的好行连带抹掉。
              const prune = sqlite.transaction(() => {
                sqlite.prepare('DELETE FROM artifacts WHERE id = ? AND source_key = ?').run(prior.id, prior.source_key);
              });
              prune();
            }
            discovered.skipped.push(candidate.relativePath);
            continue; // 外层 finally 统一 closeSync(stable.fd)
          }
        }
        const persist = sqlite.transaction((): { kind: 'saved' | 'existing' | 'updated'; artifact: Artifact } => {
          if (input.isCandidateCurrent && !input.isCandidateCurrent(candidate.relativePath))
            throw new UnstableArtifactError();
          const beforeHandle = fstatSync(stable.fd, { bigint: true });
          const beforePath = lstatSync(candidate.absolutePath, { bigint: true });
          if (!sameSnapshot(stable.stats, beforeHandle) || !sameSnapshot(stable.stats, beforePath)) {
            throw new UnstableArtifactError();
          }
          const prior = sqlite
            .prepare('SELECT * FROM artifacts WHERE task_id = ? AND root = ? AND local_path = ? LIMIT 1')
            .get(input.taskId, scope.rootKind, storedLocalPath) as Record<string, unknown> | undefined;
          let result: { kind: 'saved' | 'existing' | 'updated'; artifact: Artifact };
          if (prior) {
            const previous = artifactFromRow(prior);
            if (
              !previous.sourceKey?.startsWith(scope.sourcePrefix) ||
              (previous.sourceKey === artifact.sourceKey &&
                previous.size === artifact.size &&
                previous.mimeType === artifact.mimeType)
            ) {
              result = { kind: 'existing', artifact: previous };
            } else {
              const changed = { ...artifact, id: previous.id, createdAt: previous.createdAt };
              sqlite
                .prepare(
                  `UPDATE artifacts
                 SET message_id = @messageId, type = @type, name = @name, file_path = @filePath,
                     local_path = @localPath, root = @root,
                     mime_type = @mimeType, size = @size, source_key = @sourceKey, content_text = @contentText
                 WHERE id = @id`,
                )
                .run(changed);
              result = { kind: 'updated', artifact: changed };
            }
          } else {
            const insert = sqlite
              .prepare(
                `INSERT INTO artifacts
               (id, task_id, message_id, type, name, file_path, local_path, root, mime_type, size, source_key,
                content_text, created_at)
               VALUES (@id, @taskId, @messageId, @type, @name, @filePath, @localPath, @root, @mimeType, @size,
                       @sourceKey, @contentText, @createdAt)
               ON CONFLICT(task_id, root, local_path) DO NOTHING`,
              )
              .run(artifact);
            if (insert.changes === 1) result = { kind: 'saved', artifact };
            else {
              const winner = sqlite
                .prepare('SELECT * FROM artifacts WHERE task_id = ? AND root = ? AND local_path = ? LIMIT 1')
                .get(input.taskId, scope.rootKind, storedLocalPath) as Record<string, unknown>;
              result = { kind: 'existing', artifact: artifactFromRow(winner) };
            }
          }
          if (input.isCandidateCurrent && !input.isCandidateCurrent(candidate.relativePath))
            throw new UnstableArtifactError();
          const afterHandle = fstatSync(stable.fd, { bigint: true });
          const afterPath = lstatSync(candidate.absolutePath, { bigint: true });
          if (!sameSnapshot(stable.stats, afterHandle) || !sameSnapshot(stable.stats, afterPath)) {
            throw new UnstableArtifactError();
          }
          return result;
        });
        try {
          const result = persist();
          if (result.kind === 'saved') saved.push(result.artifact);
          else if (result.kind === 'updated') updated.push(result.artifact);
          else existing.push(result.artifact);
        } catch (error) {
          if (!(error instanceof UnstableArtifactError)) throw error;
          discovered.skipped.push(candidate.relativePath);
        }
      } finally {
        closeSync(stable.fd);
        stable.fd = -1;
      }
    }
  } finally {
    for (const stable of stableCandidates) {
      if (!stable || stable.fd < 0) continue;
      try {
        closeSync(stable.fd);
      } catch {}
      stable.fd = -1;
    }
  }
  verifyTrustedRoot(root);
  return {
    saved,
    existing,
    updated,
    missing,
    skipped: [...new Set(discovered.skipped)].sort(),
    budgetExhausted: discovered.budgetExhausted,
  };
}

export function getArtifactAvailability(localPathValue: string, workspacePath: string): ArtifactAvailability {
  if (!localPathValue || isAbsolute(localPathValue) || localPathValue.includes('\0')) return 'unsafe';
  try {
    const absolutePath = resolve(workspacePath, localPathValue);
    const realWorkspace = realpathSync.native(workspacePath);
    const realFile = realpathSync.native(absolutePath);
    const linkStats = lstatSync(absolutePath, { bigint: true });
    const canonicalStats = statSync(realFile, { bigint: true });
    // ⚠️ 2026-10-06 真机回归（"S: 盘整版被拦截"）：这里**不要**判 `samePath(realFile, absolutePath)`。
    //    subst/junction 工作区（U 盘/受控测试的标准形态）里，字面路径与 canonical 路径必然不同名，
    //    那条例会把**全部**产物误判 unsafe。防护由下面两条承担：
    //    · 文件本体符号链接 → `isSymbolicLink`（越界链接的文件到不了这里）；
    //    · realpath 越界 → `isWithin(realWorkspace, realFile)`（outside-junction 用例钉住）。
    if (
      linkStats.isSymbolicLink() ||
      !linkStats.isFile() ||
      !hasStrongIdentity(identityOf(linkStats)) ||
      !sameIdentity(identityOf(linkStats), identityOf(canonicalStats)) ||
      !isWithin(realWorkspace, realFile)
    ) {
      return 'unsafe';
    }
    return 'available';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unsafe';
  }
}

/**
 * 只给测试用。
 *
 * ⚠️ 为什么必须把它们露出来：`signature` / `sourceKey` 的**身份部分**是否精确，
 *    用**真文件**测不出来 —— 真文件上没法造出"只有 dev/ino 不同、size/mtime/ctime 全一样"
 *    的形态（ctime 改不了，它总会在签名里兜住）。而恰恰是"两个不同的文件签名相同"
 *    才会导致"该重建的跳过 ⇒ 陈旧数据"。所以只能在函数层面用合成的 bigint stats 钉。
 */
export const __testing = Object.freeze({
  signature,
  sourceKeyFor,
  WORKSPACE_SOURCE_PREFIX,
  AGENT_SOURCE_PREFIX,
  WORKSPACE_ROOT_SOURCE_PREFIX,
});
