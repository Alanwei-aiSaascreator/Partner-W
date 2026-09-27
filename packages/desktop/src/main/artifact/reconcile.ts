import { randomUUID } from 'node:crypto';
import type { BigIntStats, Dirent } from 'node:fs';
import { hasStrongIdentity, identityKey, identityOf, sameIdentity } from '../util/file-identity.js';
import { closeSync, existsSync, fstatSync, lstatSync, openSync, opendirSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Artifact, ArtifactAvailability, ArtifactRootKind } from '@clawwork/shared';
import { getSqlite } from '../db/index.js';
import { validateImportTaskId } from '../context/file-import.js';
import { ensureTaskDir } from '../workspace/init.js';

const DEFAULT_BUDGETS = Object.freeze({
  maxDepth: 4,
  maxVisited: 1_000,
  maxResults: 100,
  maxTotalBytes: 512 * 1024 * 1024,
});
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const STABILITY_DELAY_MS = 250;

const MIME_TYPES: Record<string, string> = {
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
   */
  workspacePath: string;
  taskId: string;
  messageId: string;
  baseline: ArtifactBaseline;
  /** 见 `workspacePath`。缺省 = `'workspace'`（老行为）。 */
  rootKind?: ArtifactRootKind;
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
 * 受信根：**助手自己的工作区**（第二个根，2026-09-27）。
 *
 * ## 为什么需要它
 *
 * 助手把它生成的文件写在**它自己的工作区**里（网关 `agents.entries.<id>.workspace`），
 * 而任务产物的扫描根一直是 `<应用工作区>/<taskId>` —— 两者是**兄弟目录**，永不重叠
 * ⇒ 通道外生成的文件从来没进过产物表（真机 `.clawwork.db` 实测 `COUNT(*) = 0`）。
 *
 * ## ⚠️ 这里刻意让 `taskPath === workspacePath`
 *
 * 那个"任务根"的形状是下游十几个守卫的**共同前提**（`collectPaths` 的 `isWithin`、
 * `stableCandidateOnce` 的 realpath 比对、`verifyTrustedRoot` 的身份复核、
 * `normalizedRelativePath`）。把两个字段都指到助手工作区，这些守卫就**一字不改**地生效 ——
 * 它们本来要的就是"一个已知的、非符号链接、有强身份的目录"。
 *
 * ⚠️ **不建目录**（与 `trustedTaskRoot` 的调用方不同）：助手工作区是网关的，
 *    我们只读。不存在就是"读不到"，由调用方回落成"没有这个根"。
 */
function trustedAgentWorkspaceRoot(agentWorkspacePath: string): TrustedTaskRoot {
  try {
    const identity = lstatSync(agentWorkspacePath, { bigint: true });
    const real = realpathSync.native(agentWorkspacePath);
    if (identity.isSymbolicLink() || !identity.isDirectory() || !hasStrongIdentity(identityOf(identity))) {
      throw new Error();
    }
    return {
      workspacePath: agentWorkspacePath,
      taskPath: agentWorkspacePath,
      realWorkspace: real,
      realTask: real,
      workspaceIdentity: identity,
      taskIdentity: identity,
    };
  } catch {
    throw new Error('trusted agent workspace is unavailable');
  }
}

/**
 * `source_key` 前缀。
 *
 * ⚠️ 两个根**必须用不同前缀**：`reconcileTaskArtifacts` 用"前缀是不是我的"来判
 *    「这行归不归我改」—— 共用前缀会让助手根的那一趟把应用根的行**当成自己的**改写掉。
 */
const WORKSPACE_SOURCE_PREFIX = 'workspace-file:';
const AGENT_SOURCE_PREFIX = 'agent-workspace-file:';

/** 一趟 reconcile 的全部"根相关"取值，集中在一处，免得散落五六个分支。 */
interface ReconcileScope {
  root: TrustedTaskRoot;
  rootKind: ArtifactRootKind;
  /** 落库 `local_path` 的前缀。应用根是 `<taskId>/`（既有约定，不改）；助手根是空串。 */
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

function scopeFor(input: { workspacePath: string; taskId: string; rootKind?: ArtifactRootKind }): ReconcileScope {
  if (input.rootKind === 'agent') {
    return {
      root: trustedAgentWorkspaceRoot(input.workspacePath),
      rootKind: 'agent',
      localPrefix: '',
      sourcePrefix: AGENT_SOURCE_PREFIX,
      // ⭐ 助手工作区根下有助手自己的配置 —— 那些不是产物（见 `AGENT_WORKSPACE_RESERVED`）。
      topLevelExclude: AGENT_WORKSPACE_RESERVED,
    };
  }
  return {
    root: trustedTaskRoot(input.workspacePath, input.taskId),
    rootKind: 'workspace',
    localPrefix: `${input.taskId}/`,
    sourcePrefix: WORKSPACE_SOURCE_PREFIX,
    // 应用根的"任务目录"里**没有**助手配置，保持原样（一个名字都不多排除）。
    topLevelExclude: EMPTY_EXCLUDE,
  };
}

const EMPTY_EXCLUDE: ReadonlySet<string> = new Set();

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
  const lower = name.toLowerCase();
  return (
    name.startsWith('.') ||
    name.startsWith('~$') ||
    lower.endsWith('.tmp') ||
    lower.endsWith('.part') ||
    lower.endsWith('.partial') ||
    lower.endsWith('.lock') ||
    lower.endsWith('~')
  );
}

function mimeTypeFor(name: string): string | null {
  return MIME_TYPES[extname(name).toLowerCase()] ?? null;
}

function artifactType(mimeType: string): Artifact['type'] {
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
          skipped.push(relativePath);
          budgetExhausted = true;
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
      const mimeType = mimeTypeFor(entry.name);
      const size = Number(stats.size);
      if (!stats.isFile() || !mimeType || !hasStrongIdentity(identityOf(stats)) || size <= 0 || size > MAX_FILE_BYTES) {
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

function artifactFromRow(row: Record<string, unknown>): Artifact {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    messageId: String(row.message_id),
    type: String(row.type) as Artifact['type'],
    name: String(row.name),
    filePath: String(row.file_path),
    localPath: String(row.local_path),
    // ⚠️ 只认 `'agent'`，其余（含老行的 `'workspace'` 与任何脏值）一律归 `'workspace'` ——
    //    与 `Artifact.root` 是可选字段、缺省即老行为**同一个方向**。
    root: row.root === 'agent' ? 'agent' : 'workspace',
    mimeType: String(row.mime_type),
    size: Number(row.size),
    sourceKey: String(row.source_key),
    contentText: String(row.content_text),
    createdAt: String(row.created_at),
    availability: 'available',
  };
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
  // ⚠️ 建任务目录**只在应用根**做：助手的工作区是**网关的**，我们只读 ——
  //    绝不因为它不存在就往里建东西（那会污染助手的沙箱）。
  if (input.rootKind !== 'agent' && !existsSync(join(input.workspacePath, input.taskId))) {
    ensureTaskDir(input.workspacePath, input.taskId);
  }
  const scope = scopeFor(input);
  const root = scope.root;
  const budgets = {
    ...DEFAULT_BUDGETS,
    maxResults: DEFAULT_BUDGETS.maxVisited,
    maxTotalBytes: Number.MAX_SAFE_INTEGER,
    ...hooks.budgets,
  };
  const { candidates, budgetExhausted } = collectPaths(root, budgets, undefined, scope.topLevelExclude);
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
  const scope = scopeFor(input);
  const root = scope.root;
  const budgets = { ...DEFAULT_BUDGETS, ...hooks.budgets };
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
  const discovered = collectPaths(root, budgets, input.baseline, scope.topLevelExclude);
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
          filePath: '',
          localPath: storedLocalPath,
          root: scope.rootKind,
          mimeType: candidate.mimeType,
          size: Number(stable.stats.size),
          sourceKey: sourceKeyFor(scope.sourcePrefix, candidate.relativePath, stable.stats),
          contentText: '',
          createdAt: now,
          availability: 'available',
        };
        const persist = sqlite.transaction((): { kind: 'saved' | 'existing' | 'updated'; artifact: Artifact } => {
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
    if (
      linkStats.isSymbolicLink() ||
      !linkStats.isFile() ||
      !hasStrongIdentity(identityOf(linkStats)) ||
      !sameIdentity(identityOf(linkStats), identityOf(canonicalStats)) ||
      !isWithin(realWorkspace, realFile) ||
      !samePath(realFile, absolutePath)
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
export const __testing = Object.freeze({ signature, sourceKeyFor, WORKSPACE_SOURCE_PREFIX, AGENT_SOURCE_PREFIX });
