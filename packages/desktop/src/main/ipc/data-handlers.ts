import { app, BrowserWindow, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { and, eq, desc } from 'drizzle-orm';
import { getDb, isDbReady } from '../db/index.js';
import { tasks, messages, artifacts, taskRooms, taskRoomSessions, teams, teamAgents } from '../db/schema.js';
import { autoExtractArtifacts } from '../artifact/auto-extract.js';
import { captureTaskArtifactBaseline, reconcileTaskArtifacts, type ArtifactBaseline } from '../artifact/reconcile.js';
import { resolveAgentWorkspace } from '../artifact/agent-workspace.js';
import { generateDocumentsFromMessage } from '../docgen/generate.js';
// ⚠️ 两条线各往这里插了一行，合并时冲突过一次 —— **两个都要**。
//    删掉任何一个，下面各自那个调用点就变成 TS2304（找不到名字）。
import { resolvePptxTemplatesRoot } from '../docgen/pptx-template/locate.js';
import { generateHtmlPagesFromMessage } from '../htmlgen/generate.js';
import { generateSlidesFromMessage } from '../slidegen/generate.js';
import {
  captureDeckFileBaseline,
  changedDeckFiles,
  decksFromFiles,
  type DeckFileBaseline,
} from '../slidegen/deck-file.js';
import {
  DISPLAY_TRUNCATION_MARKER,
  historyFetcherFrom,
  recoverFullReply,
  type ArtifactKind,
  type RecoverResult,
} from '../artifact/recover-full-reply.js';
import {
  checkClaimedFiles,
  EXPECTED_ARTIFACT_LABELS,
  expectedArtifactKindsFromRequest,
  missingExpectedArtifactKinds,
  type ExpectedArtifactKind,
} from '../artifact/claim-guard.js';
import {
  parseAgentIdFromSessionKey,
  type Artifact,
  type ArtifactDeliveryFailure,
  type MessageAttachment,
  type SlidegenFailure,
} from '@clawwork/shared';
import { getWorkspacePath } from '../workspace/config.js';
import { getGatewayClient } from '../ws/index.js';
import { getDebugLogger } from '../debug/index.js';

function ipcError(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : 'unknown' };
}

/**
 * 随包 pptx 模板目录。**算不出来就返回 `undefined`，绝不抛。**
 *
 * 为什么必须这么小心：它跑在**消息收尾路径**上，而那条路径还负责自动抽取、
 * 产物对账、以及把 `docgen:failed` 推给界面 —— 模板定位只是其中一个小分支，
 * 让它把整条收尾掀翻是荒唐的。
 *
 * ⚠️ 这不是假设，是踩过的：`test/data-handlers-artifacts.test.ts` 里
 *    `vi.mock('electron')` 只给了 `ipcMain` 与 `BrowserWindow`，**没有 `app`** ⇒
 *    `app.isPackaged` 抛 `TypeError` ⇒ 三个 `docgen:failed` 用例全红 ——
 *    而症状是"失败事件一次都没推"，看起来像内容校验坏了，跟模板毫无关系。
 *    模板定位失败的正确表现是"这条 deck 报 render-failed"，不是"整条链停摆"。
 */
function pptxTemplatesRoot(): string | undefined {
  try {
    return resolvePptxTemplatesRoot({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    });
  } catch {
    return undefined;
  }
}

function parseTeamAgentSkills(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [];
  } catch {
    return [];
  }
}

/**
 * 第二个根的基线：**助手自己的工作区**（2026-09-27）。
 *
 * 现场：助手用 exec 在它自己的工作区里生成 pptx / html，而产物表从来没有过任何记录
 * （真机 `.clawwork.db` 实测 `COUNT(*) = 0`）—— 任务产物的扫描根一直是
 * `<应用工作区>/<taskId>`，与助手工作区是**兄弟目录**。
 *
 * ⚠️ **可缺**：解析不到助手工作区（网关没连 / agent 没有显式 workspace /
 *    它恰好就是应用工作区）时整个为 `null` —— 那时这一趟**不跑**，
 *    而**不是**回落到应用工作区（回落会把行解析到错误的目录）。
 */
interface AgentRootBaseline {
  workspacePath: string;
  baseline: ArtifactBaseline;
  /**
   * 助手工作区里 `.slidegen` 文件的快照（**这一轮开始之前**那一刻）。
   *
   * 收尾时与它比一遍 ⇒ "这一轮新写出来的版面文件"。见 `slidegen/deck-file.ts`。
   * ⚠️ 与 `baseline` 同刻采集，但**用途完全独立**：那个管"产物面板收哪些文件"，
   *    这个管"拿哪份文本去排 PPT"。
   */
  deckBaseline: DeckFileBaseline | null;
}

interface ArtifactRunContext {
  baseline?: Promise<ArtifactBaseline>;
  /** 见 `AgentRootBaseline`。`null` = 没有第二个根，这趟不跑。 */
  agentBaseline?: Promise<AgentRootBaseline | null>;
  token: string;
  createdAt: number;
  sequence: number;
  expiryTimer: ReturnType<typeof setTimeout>;
  gatewayRunId?: string;
  /** 用户在这一轮明确要求交付的格式；空数组表示普通聊天/格式咨询。 */
  expectedArtifactKinds: ExpectedArtifactKind[];
  state: 'active' | 'canceled' | 'claimed';
  taskId: string;
  sessionKey: string;
}

const artifactRuns = new Map<string, ArtifactRunContext[]>();
const claimedArtifactRuns = new Map<string, ArtifactRunContext>();
const desynchronizedArtifactSessions = new Set<string>();
const completedAssistantMessages = new Map<
  string,
  { state: 'inFlight' | 'completed'; touchedAt: number; sequence: number; taskId: string; sessionKey: string }
>();
const ARTIFACT_RUN_TTL_MS = 15 * 60 * 1000;
const MAX_ARTIFACT_RUNS = 128;
const COMPLETED_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_COMPLETED_MESSAGES = 2048;
let nextArtifactRunSequence = 0;
let nextCompletedMessageSequence = 0;

function artifactRunKey(taskId: string, sessionKey: string): string {
  return `${taskId}\0${sessionKey}`;
}

function hasRunningToolCall(toolCalls: unknown[] | undefined): boolean {
  return Boolean(
    toolCalls?.some(
      (value) =>
        value !== null &&
        typeof value === 'object' &&
        ['pending', 'running'].includes(String((value as { status?: unknown }).status ?? '')),
    ),
  );
}

/**
 * 解析助手工作区并采它的基线；**任何失败都回 `null`，绝不抛**。
 *
 * 它跑在发消息那一刻（与应用根基线并发），所以：
 *   · 网关没连 / RPC 超时 ⇒ `null`（`resolveAgentWorkspace` 自己吞异常并短暂缓存）
 *   · 助手工作区 == 应用工作区 ⇒ `null`（否则同一个目录会被扫两遍、两批产物撞 `local_path`）
 *   · 基线采集本身失败 ⇒ `null`（它跑在一轮消息收尾的产物链上，掀翻代价太大）
 */
async function captureAgentRootBaseline(input: {
  gatewayId: string;
  sessionKey: string;
  taskId: string;
}): Promise<AgentRootBaseline | null> {
  try {
    const agentId = parseAgentIdFromSessionKey(input.sessionKey);
    const workspacePath = await resolveAgentWorkspace({
      gatewayId: input.gatewayId,
      agentId,
      listAgentFiles: (gatewayId, agent) => {
        const client = getGatewayClient(gatewayId);
        // 抛出去由 `resolveAgentWorkspace` 吞掉并回 null —— 那是它写明的契约。
        if (!client) return Promise.reject(new Error('gateway client unavailable'));
        return client.listAgentFiles(agent);
      },
    });
    if (!workspacePath) {
      // ⚠️ 这条**必须留痕**：第二个根是"产物面板为不为空"的**唯一变量**，而它失败的表现
      //    与"这个功能根本没做"**一模一样**（面板就是空的、不报错、不留任何痕）。
      //    这正是本项目反复栽的那类静默形态（`item.status` / `lifecycle` 都栽过）。
      //    ⚠️ 走 debug 级不是 warn：网关没连上时每条消息都会来一次，warn 会刷屏。
      getDebugLogger().debug({
        domain: 'artifact',
        event: 'artifact.agent-workspace.unavailable',
        gatewayId: input.gatewayId,
        data: { agentId, taskId: input.taskId },
      });
      return null;
    }
    if (workspacePath === getWorkspacePath()) {
      // 助手工作区恰好就是应用工作区 ⇒ **故意**不跑第二趟（同一个目录会被扫两遍、
      // 两批产物还会撞 `local_path`）。这条也留痕，免得看起来像"没生效"。
      getDebugLogger().debug({
        domain: 'artifact',
        event: 'artifact.agent-workspace.same-as-workspace',
        gatewayId: input.gatewayId,
        data: { agentId, taskId: input.taskId },
      });
      return null;
    }
    const baseline = await captureTaskArtifactBaseline({
      workspacePath,
      taskId: input.taskId,
      rootKind: 'agent',
    });
    // 同在**这一刻**采版面文件的基线：助手这一轮开始写文件之前。
    // ⚠️ 同步、极便宜（只 stat 一遍 `.slidegen`），失败回 null 由 `captureDeckFileBaseline` 自己处理。
    const deckBaseline = captureDeckFileBaseline(workspacePath);
    return { workspacePath, baseline, deckBaseline };
  } catch (error) {
    console.error('[artifact_agent_baseline_failed]', { taskId: input.taskId, error });
    return null;
  }
}

/**
 * 起一次产物运行。
 *
 * @param opts.gatewayId 网关 id。**只有它才能解析出助手的工作区**（第二个根）。
 *   ⚠️ 省略 ⇒ 第二个根**整个不跑**（不是回落到应用工作区）—— 与"读不到助手工作区"
 *   是同一条处置。生产路径（`beginArtifactRunForGatewayDispatch`）**总是**传它；
 *   省略只出现在测试里。
 */
export function beginArtifactRun(
  workspacePath: string,
  taskId: string,
  sessionKey: string,
  opts?: { gatewayId?: string; userContent?: string },
): string {
  pruneArtifactRuns();
  pruneCompletedAssistantMessages();
  const token = randomUUID();
  const baseline = captureTaskArtifactBaseline({ workspacePath, taskId }).catch((error: unknown) => {
    console.error('[artifact_baseline_failed]', { taskId, error });
    throw error;
  });
  // Attach a rejection handler immediately. The final assistant write may never
  // arrive (cancel/disconnect), and an unobserved baseline rejection must not
  // become an unhandled process rejection.
  void baseline.catch(() => undefined);
  // 第二个根（助手自己的工作区）：同样在这一刻起跑 —— 它要抓的是"这一轮**开始之前**"的快照。
  const gatewayId = opts?.gatewayId;
  const agentBaseline = gatewayId ? captureAgentRootBaseline({ gatewayId, sessionKey, taskId }) : Promise.resolve(null);
  void agentBaseline.catch(() => undefined);
  const key = artifactRunKey(taskId, sessionKey);
  if (desynchronizedArtifactSessions.has(key)) return token;
  while (artifactRunCount() >= MAX_ARTIFACT_RUNS) desynchronizeOldestArtifactSession();
  if (desynchronizedArtifactSessions.has(key)) return token;
  const expiryTimer = setTimeout(() => cancelArtifactRun(taskId, sessionKey, token), ARTIFACT_RUN_TTL_MS);
  expiryTimer.unref?.();
  const queue = artifactRuns.get(key) ?? [];
  queue.push({
    baseline,
    agentBaseline,
    token,
    createdAt: Date.now(),
    sequence: nextArtifactRunSequence++,
    expiryTimer,
    state: 'active',
    expectedArtifactKinds: expectedArtifactKindsFromRequest(opts?.userContent ?? ''),
    taskId,
    sessionKey,
  });
  artifactRuns.set(key, queue);
  return token;
}

export function cancelArtifactRun(taskId: string, sessionKey: string, token: string): void {
  const key = artifactRunKey(taskId, sessionKey);
  const queue = artifactRuns.get(key);
  const index = queue?.findIndex((run) => run.token === token) ?? -1;
  if (!queue || index < 0) {
    const claimed = claimedArtifactRuns.get(token);
    if (claimed?.taskId === taskId && claimed.sessionKey === sessionKey) claimed.state = 'canceled';
    return;
  }
  const run = queue[index];
  run.state = 'canceled';
  run.baseline = undefined;
  clearTimeout(run.expiryTimer);
}

export function bindArtifactRun(taskId: string, sessionKey: string, token: string, gatewayRunId: string): void {
  if (!gatewayRunId) return;
  const run = artifactRuns.get(artifactRunKey(taskId, sessionKey))?.find((candidate) => candidate.token === token);
  if (run) {
    run.gatewayRunId = gatewayRunId;
    if (run.state === 'active') clearTimeout(run.expiryTimer);
  }
}

function claimArtifactRun(taskId: string, sessionKey: string, gatewayRunId?: string): ArtifactRunContext | undefined {
  const key = artifactRunKey(taskId, sessionKey);
  if (desynchronizedArtifactSessions.has(key)) return undefined;
  const queue = artifactRuns.get(key);
  const exactRunIndex = gatewayRunId
    ? (queue?.findIndex((candidate) => candidate.gatewayRunId === gatewayRunId) ?? -1)
    : -1;
  const index = gatewayRunId
    ? exactRunIndex >= 0
      ? exactRunIndex
      : (queue?.findIndex((candidate) => candidate.state === 'canceled' && !candidate.gatewayRunId) ?? -1)
    : queue?.length
      ? 0
      : -1;
  // A terminal carrying a run id only falls back to an unbound canceled
  // tombstone. That is the timeout/uncertain-send case: it preserves the FIFO
  // hole without ever assigning an active baseline to an unrelated run id.
  const run = index >= 0 ? queue?.splice(index, 1)[0] : undefined;
  if (!run || !queue) return undefined;
  clearTimeout(run.expiryTimer);
  if (queue.length === 0) artifactRuns.delete(key);
  if (run.state === 'active') run.state = 'claimed';
  claimedArtifactRuns.set(run.token, run);
  return run;
}

function artifactRunCount(): number {
  let count = claimedArtifactRuns.size;
  for (const queue of artifactRuns.values()) count += queue.length;
  return count;
}

function markArtifactSessionDesynchronized(key: string): void {
  const queue = artifactRuns.get(key) ?? [];
  for (const run of queue) clearTimeout(run.expiryTimer);
  artifactRuns.delete(key);
  for (const [token, run] of claimedArtifactRuns) {
    if (artifactRunKey(run.taskId, run.sessionKey) !== key) continue;
    run.state = 'canceled';
    claimedArtifactRuns.delete(token);
  }
  desynchronizedArtifactSessions.add(key);
}

function desynchronizeOldestArtifactSession(): void {
  let oldest: { key: string; run: ArtifactRunContext } | null = null;
  for (const [key, queue] of artifactRuns) {
    for (const run of queue) {
      if (!oldest || run.sequence < oldest.run.sequence) oldest = { key, run };
    }
  }
  for (const run of claimedArtifactRuns.values()) {
    const key = artifactRunKey(run.taskId, run.sessionKey);
    if (!oldest || run.sequence < oldest.run.sequence) oldest = { key, run };
  }
  if (!oldest) return;
  markArtifactSessionDesynchronized(oldest.key);
}

function pruneArtifactRuns(now = Date.now()): void {
  for (const [key, queue] of artifactRuns) {
    for (const run of [...queue]) {
      if (run.state === 'active' && run.gatewayRunId) continue;
      if (now - run.createdAt < ARTIFACT_RUN_TTL_MS) continue;
      const separator = key.indexOf('\0');
      cancelArtifactRun(key.slice(0, separator), key.slice(separator + 1), run.token);
    }
  }
}

function completedMessageKey(taskId: string, messageId: string): string {
  return `${taskId}\0${messageId}`;
}

function isArtifactRunCanceled(run: ArtifactRunContext): boolean {
  return run.state === 'canceled';
}

function pruneCompletedAssistantMessages(now = Date.now()): void {
  for (const [key, value] of completedAssistantMessages) {
    if (value.state === 'completed' && now - value.touchedAt >= COMPLETED_MESSAGE_TTL_MS) {
      completedAssistantMessages.delete(key);
      markArtifactSessionDesynchronized(artifactRunKey(value.taskId, value.sessionKey));
    }
  }
  if (completedAssistantMessages.size < MAX_COMPLETED_MESSAGES) return;
  const completed = [...completedAssistantMessages.entries()]
    .filter(([, value]) => value.state === 'completed')
    .sort((a, b) => a[1].sequence - b[1].sequence);
  while (completedAssistantMessages.size >= MAX_COMPLETED_MESSAGES && completed.length > 0) {
    const [key, value] = completed.shift()!;
    completedAssistantMessages.delete(key);
    markArtifactSessionDesynchronized(artifactRunKey(value.taskId, value.sessionKey));
  }
}

export function cancelArtifactRunsForSession(sessionKey: string): void {
  for (const [key, queue] of artifactRuns) {
    if (!key.endsWith(`\0${sessionKey}`)) continue;
    for (const run of queue) clearTimeout(run.expiryTimer);
    artifactRuns.delete(key);
  }
  for (const run of claimedArtifactRuns.values()) {
    if (run.sessionKey === sessionKey) run.state = 'canceled';
  }
  for (const key of desynchronizedArtifactSessions) {
    if (key.endsWith(`\0${sessionKey}`)) desynchronizedArtifactSessions.delete(key);
  }
  for (const [key, value] of completedAssistantMessages) {
    if (value.sessionKey === sessionKey) completedAssistantMessages.delete(key);
  }
}

export function cancelArtifactRunsForTask(taskId: string): void {
  for (const [key, queue] of artifactRuns) {
    if (!key.startsWith(`${taskId}\0`)) continue;
    for (const run of queue) clearTimeout(run.expiryTimer);
    artifactRuns.delete(key);
  }
  for (const run of claimedArtifactRuns.values()) {
    if (run.taskId === taskId) run.state = 'canceled';
  }
  for (const key of desynchronizedArtifactSessions) {
    if (key.startsWith(`${taskId}\0`)) desynchronizedArtifactSessions.delete(key);
  }
  for (const [key, value] of completedAssistantMessages) {
    if (value.taskId === taskId) completedAssistantMessages.delete(key);
  }
}

export function beginArtifactRunForGatewayDispatch(input: {
  gatewayId: string;
  sessionKey: string;
  taskId: string;
  /** 必须是即将派发的用户原文；此时用户消息可能还没有落库。 */
  userContent: string;
}): string | null {
  if (!isDbReady()) return null;
  const task = getDb()
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, input.taskId), eq(tasks.gatewayId, input.gatewayId)))
    .get();
  const workspacePath = getWorkspacePath();
  if (!task || !workspacePath) return null;
  return beginArtifactRun(workspacePath, input.taskId, input.sessionKey, {
    gatewayId: input.gatewayId,
    userContent: input.userContent,
  });
}

/**
 * 结构化产物（docgen / slidegen）该用哪一份原文。
 *
 * ## 为什么必须换一份
 *
 * 随包运行时把**单条消息**在投影时截到 **8,000 字符**（末尾追加 `...(truncated)...`）。
 * 一份整册 PPT 的源码远超它 ⇒ 贴进回复就被切断 ⇒ 围栏没闭合 ⇒ 整份丢掉。
 * 真机上**连续四次**这么死。
 *
 * 完整原文还在网关的会话记录里，用 `chat.history` 带 `maxChars` **能取回来**
 * （实测同一条消息 8,018 → 12,414 且截断标记消失）。见 `artifact/recover-full-reply.ts`。
 *
 * ## 三条处置
 *
 * - **没被截断**（显示文本里没有标记）⇒ 直接用，**一次网关请求都不发**（普通回复零成本）。
 * - **取回完整** ⇒ 用取回的那份。
 * - **取不回 / 取回的仍不完整** ⇒ 返回非 `complete`，调用方**不生成**。
 *   ⭐ 宁可什么都没有，也不交付**半份** PPT —— 半份比没有更糟（用户会以为做完了）。
 */
/**
 * 这条回复里**有没有**结构化产物块。
 *
 * ⚠️ 用它做闸门是有意的：取回动作（`structuredReplyContent`）只在"真的可能要解析"
 *    时才该发生。否则一条**很长的普通聊天消息**也会白等一次网关往返，
 *    取不到时还要等满 1.85 秒的重试 —— 那是在收尾路径上，用户直接能感觉到。
 *
 * ⚠️ 只看**开头**围栏：被截断的那份正是"开了头、没有结尾"。
 *    大小写不敏感，但语言标记必须恰好是三种生成围栏之一。
 */
type StructuredFenceKind = 'docgen' | 'slidegen' | 'htmlgen';

function hasStructuredFenceKind(content: string, kind: StructuredFenceKind): boolean {
  return new RegExp('^```[ \\t]*' + kind + '[ \\t]*$', 'im').test(content);
}

function hasStructuredFence(content: string): boolean {
  return (['docgen', 'slidegen', 'htmlgen'] as const).some((kind) => hasStructuredFenceKind(content, kind));
}

async function structuredReplyContent(input: {
  gatewayId?: string;
  sessionKey: string;
  runId?: string;
  content: string;
  artifactKind: ArtifactKind;
}): Promise<RecoverResult> {
  const gateway = input.gatewayId ? getGatewayClient(input.gatewayId) : undefined;
  if (!gateway) {
    // 网关没连上：**没被截断**的回复照旧可用（那种情况本来也不需要取回）；
    // 被截断的则明确回 unavailable —— 不拿截断文本凑一份。
    return input.content.includes(DISPLAY_TRUNCATION_MARKER)
      ? { status: 'unavailable', reason: 'gateway-unavailable' }
      : { status: 'complete', content: input.content };
  }
  return recoverFullReply({
    sessionKey: input.sessionKey,
    currentRunId: input.runId ?? '',
    displayContent: input.content,
    artifactKind: input.artifactKind,
    deps: { fetchHistory: historyFetcherFrom(gateway) },
  });
}

function finalizeAssistantArtifacts(input: {
  workspacePath: string;
  taskId: string;
  sessionKey: string;
  messageId: string;
  runId?: string;
  content: string;
  attachments?: MessageAttachment[];
  gatewayHttpBase?: string;
  gatewayId?: string;
}): void {
  pruneCompletedAssistantMessages();
  const messageKey = completedMessageKey(input.taskId, input.messageId);
  if (completedAssistantMessages.has(messageKey)) return;
  completedAssistantMessages.set(messageKey, {
    state: 'inFlight',
    touchedAt: Date.now(),
    sequence: nextCompletedMessageSequence++,
    taskId: input.taskId,
    sessionKey: input.sessionKey,
  });
  const run = claimArtifactRun(input.taskId, input.sessionKey, input.runId);
  if (!run) {
    completedAssistantMessages.set(messageKey, {
      state: 'completed',
      touchedAt: Date.now(),
      sequence: nextCompletedMessageSequence++,
      taskId: input.taskId,
      sessionKey: input.sessionKey,
    });
    return;
  }
  void (async () => {
    const deliveryFailure: ArtifactDeliveryFailure = {
      taskId: input.taskId,
      sessionKey: input.sessionKey,
      messageId: input.messageId,
      missing: [],
    };
    // 只记真实生成器或基线对账认出来的本轮文件。auto-extract 的 snippet.md / preview.html
    // 故意不记：代码片段不能冒充用户明确要的 Office/PDF 交付物。
    const producedArtifactNames = new Set<string>();
    const rememberProduced = (artifact: { name?: string; localPath?: string }): void => {
      const name = artifact.name ?? artifact.localPath;
      if (name) producedArtifactNames.add(name);
    };
    const notifyReconciledArtifacts = (result: { saved: Artifact[]; updated?: Artifact[] }): void => {
      const changed = new Map([...result.saved, ...(result.updated ?? [])].map((artifact) => [artifact.id, artifact]));
      for (const artifact of changed.values()) {
        rememberProduced(artifact);
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send('artifact:saved', artifact);
      }
    };
    try {
      await autoExtractArtifacts({
        workspacePath: input.workspacePath,
        taskId: input.taskId,
        messageId: input.messageId,
        content: input.content,
        attachments: input.attachments,
        gatewayHttpBase: input.gatewayHttpBase,
      });
    } catch (error) {
      console.error('[auto-extract]', error);
    }
    // ⭐ 结构化产物的**原文**：docgen 与 slidegen 共用这一次取回。
    //    被显示层截断时（8,000 那条）去网关按 runId 要回完整原文；
    //    没被截断就直接用 `input.content`（一次请求都不发）。
    //    ⚠️ 只在回复里**真的有**结构化块时才取 —— 见 `hasStructuredFence` 的理由。
    const structured: RecoverResult =
      hasStructuredFence(input.content) ||
      (run.expectedArtifactKinds.length > 0 && input.content.includes(DISPLAY_TRUNCATION_MARKER))
        ? await structuredReplyContent({
            gatewayId: input.gatewayId,
            sessionKey: input.sessionKey,
            runId: input.runId,
            content: input.content,
            artifactKind: 'docgen',
          })
        : { status: 'complete', content: input.content };
    try {
      // ⭐ 文档生成：助手在回复里给出 ```` ```docgen ```` 块（内容 schema 见
      //    `main/docgen/request.ts`），这里渲染成真 pptx / docx / xlsx 并**走现成的产物通道**
      //    存下来（`saveArtifactFromBuffer` 会写进任务目录 + 写库），然后把事件推给界面。
      //    放在 autoExtract 之前：产物先落库，后面的抽取与 reconcile 就不会重复登记。
      //    内部自己吞异常（一份坏请求不影响其它），这里再包一层只是防它自己坏掉。
      const documents =
        structured.status === 'complete'
          ? await generateDocumentsFromMessage({
              workspacePath: input.workspacePath,
              taskId: input.taskId,
              messageId: input.messageId,
              content: structured.content,
              templatesRoot: pptxTemplatesRoot(),
            })
          : {
              saved: [],
              // ⚠️ **只在回复里真的有 `docgen` 围栏时才报这条**。
              //    否则一条只写了 PPT 的长回复会连带弹一句"文件没能生成" ——
              //    用户压根没要文件，那是**假失败**。
              failed: hasStructuredFenceKind(input.content, 'docgen')
                ? [
                    structured.status === 'incomplete'
                      ? ({ code: 'docgen-reply-incomplete' } as const)
                      : ({ code: 'docgen-reply-unavailable' } as const),
                  ]
                : [],
            };
      for (const artifact of documents.saved) {
        rememberProduced(artifact);
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send('artifact:saved', artifact);
      }
      // ⭐ 没生成出来的那一份也要说。原来这里只把 `failed` 收进局部变量就丢掉 ——
      //    界面上一个字都没有，于是"排不下所以拒了"和"我们坏了"在用户眼里长得一样，
      //    而两者都长得像"它说做好了，但产物里什么都没有"。
      //    **一次消息只推一次**：九个失败弹九个 toast 是另一种坏体验。
      if (documents.failed.length > 0) {
        deliveryFailure.docFailures = documents.failed;
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send('docgen:failed', documents.failed);
      }
    } catch (error) {
      console.error('[docgen]', error);
    }
    try {
      // ⭐ 网页生成：助手给出 ```` ```htmlgen ```` 块（结构化内容，**不是** HTML 源码，
      //    schema 见 `main/htmlgen/request.ts`），这里排成一份离线自包含的 .html 并走
      //    同一条产物通道存下来。与 docgen 各管各的：一条坏了不影响另一条。
      const pages =
        structured.status === 'complete'
          ? await generateHtmlPagesFromMessage({
              workspacePath: input.workspacePath,
              taskId: input.taskId,
              messageId: input.messageId,
              content: structured.content,
            })
          : {
              saved: [],
              failed: hasStructuredFenceKind(input.content, 'htmlgen')
                ? ([{ code: 'htmlgen-block-invalid' }] as const)
                : [],
            };
      for (const artifact of pages.saved) {
        rememberProduced(artifact);
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send('artifact:saved', artifact);
      }
      if (pages.failed.length > 0) {
        deliveryFailure.htmlFailures = [...pages.failed];
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send('htmlgen:failed', pages.failed);
      }
    } catch (error) {
      console.error('[htmlgen]', error);
    }
    try {
      // ⭐ 幻灯片生成：助手给出 ```` ```slidegen ```` 块（**JSX + CSS 的版面源码**，
      //    不是填格子；见 `main/slidegen/`）。
      //
      //    与上一条的本质差别：这条通道允许模型**写版面本身**，客户端拿真浏览器
      //    （Electron 隐藏窗口）排版、量出每个元素的最终矩形，再写回成
      //    **真文字、可编辑**的 pptx。
      //
      //    ⚠️ 失败与**警告**分开推：版式有毛病（元素冲出画布 / 文字被盖住）
      //       **不挡交付** —— 文件照样在产物里，只是要告诉用户哪一页哪里不对。
      //       把警告当成失败，就回到了"内容多一点 = 零输出"那条老路（`docgen` 踩过）。
      // ── 版面源码**优先取文件**，取不到才回落聊天正文 ──────────────────────
      //
      // ⭐ 2026-09-28 定的：网关把**单条消息**截在 8,000 字符，所以"整份写进回复里"
      //    真机四次都死在 8,000。而**写文件拿得到全文**（13,052 字节那份在盘上是完整的）。
      //    ⇒ 有合格文件就以文件为准，**截断不再决定出不出片**。
      //
      // 「合格文件」= 助手工作区里、文件名含 `.slidegen`、且相对**这一轮开始那一刻**是新的
      // （新增 / size 变 / mtime 变，同名覆盖也算）。判据与理由见 `slidegen/deck-file.ts`。
      const agentRoot = await run.agentBaseline;
      const deckFiles = agentRoot?.deckBaseline
        ? changedDeckFiles(agentRoot.deckBaseline, agentRoot.workspacePath)
        : [];
      let slideContent: string | null = null;
      let deckFileFailures: SlidegenFailure[] = [];
      if (agentRoot && deckFiles.length > 0) {
        const fromFiles = decksFromFiles({ root: agentRoot.workspacePath, relatives: deckFiles });
        slideContent = fromFiles.text;
        deckFileFailures = fromFiles.failures;
        // ⚠️ 必须留痕：这条路"没出片"时，日志里要能分辨是**文件路**走的还是**聊天路**走的。
        getDebugLogger().info({
          domain: 'artifact',
          event: 'slidegen.deck-files-used',
          gatewayId: input.gatewayId,
          data: { taskId: input.taskId, files: deckFiles, failures: deckFileFailures.map((f) => f.code) },
        });
      } else {
        // 聊天这条路：用**取回的完整原文**（被截断时见 `structuredReplyContent`）。
        //
        // ⚠️ 取不回 / 取回的仍不完整 ⇒ **一份都不生成**。
        //    宁可什么都没有，也不交付半份 deck —— 半份比没有更糟（用户以为做完了）。
        getDebugLogger().info({
          domain: 'artifact',
          event: 'slidegen.reply-content',
          gatewayId: input.gatewayId,
          data: {
            taskId: input.taskId,
            status: structured.status,
            ...(structured.status === 'complete' ? {} : { reason: structured.reason }),
          },
        });
        if (structured.status === 'complete') slideContent = structured.content;
      }

      if (slideContent === null) {
        // 没拿到可用的原文 ⇒ 只推失败，不进排版。
        // ⚠️ 这里**不能 `return`**：这一整个是收尾 IIFE 的一段，后面还有产物对账 ——
        //    提前 return 会让这一轮的产物**整个不被收集**（那正是我们要消灭的静默）。
        // ⚠️ 同上：**只在回复里真有 `slidegen` 围栏时才报**（免得给没要演示的用户弹假失败）。
        if (hasStructuredFenceKind(input.content, 'slidegen')) {
          const failure: SlidegenFailure =
            structured.status === 'incomplete'
              ? { code: 'slidegen-reply-incomplete' }
              : { code: 'slidegen-reply-unavailable' };
          getDebugLogger().warn({
            domain: 'artifact',
            event: 'slidegen.reply-content-unusable',
            gatewayId: input.gatewayId,
            data: { taskId: input.taskId, status: structured.status },
          });
          for (const win of BrowserWindow.getAllWindows()) win.webContents.send('slidegen:failed', [failure]);
          deliveryFailure.slideFailures = [failure];
        }
      } else {
        const decks = await generateSlidesFromMessage({
          workspacePath: input.workspacePath,
          taskId: input.taskId,
          messageId: input.messageId,
          content: slideContent,
        });
        // 文件那条路自己判出来的失败（没围栏 / 读不动）**也要上屏** —— 否则又回到
        // "产物空、日志空、界面说已完成"那类静默。放前面：它比排版层的失败更根本。
        decks.failed.unshift(...deckFileFailures);
        for (const artifact of decks.saved) {
          rememberProduced(artifact);
          for (const win of BrowserWindow.getAllWindows()) win.webContents.send('artifact:saved', artifact);
        }
        if (decks.failed.length > 0) {
          deliveryFailure.slideFailures = decks.failed;
          for (const win of BrowserWindow.getAllWindows()) win.webContents.send('slidegen:failed', decks.failed);
        }
        if (decks.warnings.length > 0) {
          for (const win of BrowserWindow.getAllWindows()) win.webContents.send('slidegen:warned', decks.warnings);
        }
      }
    } catch (error) {
      console.error('[slidegen]', error);
      deliveryFailure.slideFailures = [{ code: 'slidegen-render-failed' }];
    }
    // ⚠️ 外层这一 try **只为了那个 finally**：清理（解除认领 + 标完成）必须把
    //    下面**两条** reconcile 都罩住。上一版把 finally 挂在了第二条上，于是
    //    第一条里那个 `return`（取消 / 没有基线）会**跳过清理**，认领项要等 TTL 才回收。
    //    缩进由 prettier 规整 —— 这里先保证括号配平。
    try {
      try {
        if (isArtifactRunCanceled(run) || !run.baseline) return;
        const baseline = await run.baseline;
        if (isArtifactRunCanceled(run)) return;
        const result = await reconcileTaskArtifacts({
          workspacePath: input.workspacePath,
          taskId: input.taskId,
          messageId: input.messageId,
          baseline,
        });
        notifyReconciledArtifacts(result);
      } catch (error) {
        console.error('[artifact_reconcile_failed]', { taskId: input.taskId, messageId: input.messageId, error });
      }
      // ⭐ 第二个根：**助手自己的工作区**（2026-09-27）。
      //
      // 现场：助手用 exec 在它自己的工作区里生成 pptx / html，产物面板却是空的 ——
      // 真机 `.clawwork.db` 实测 `SELECT COUNT(*) FROM artifacts` = **0**。
      // 上面那条 reconcile 扫的是 `<应用工作区>/<taskId>`，与助手工作区是**兄弟目录**。
      //
      // ⚠️ 与上面那条**完全独立**：各自的基线、各自的前缀、各自的行、各自的 try
      //    —— 任一条坏了都不影响另一条，也不影响再上面的 auto-extract / docgen / htmlgen / slidegen。
      try {
        const agentRoot = run.agentBaseline ? await run.agentBaseline : null;
        // 没有第二个根只是「这趟不扫助手工作区」，不能 `return`：后面的结果/声称守卫仍要跑。
        if (!isArtifactRunCanceled(run) && agentRoot) {
          const agentResult = await reconcileTaskArtifacts({
            workspacePath: agentRoot.workspacePath,
            taskId: input.taskId,
            messageId: input.messageId,
            baseline: agentRoot.baseline,
            rootKind: 'agent',
          });
          // ⭐ **正面证据**：真机排障时唯一能回答"这个功能跑没跑、找到了几条"的一行。
          //    没有它，用户说"产物还是空的"时只能猜：是没扫到？根没接上？还是真没文件？
          getDebugLogger().info({
            domain: 'artifact',
            event: 'artifact.agent-reconcile.done',
            taskId: input.taskId,
            data: {
              workspacePath: agentRoot.workspacePath,
              saved: agentResult.saved.length,
              existing: agentResult.existing.length,
              skipped: agentResult.skipped.length,
            },
          });
          notifyReconciledArtifacts(agentResult);
        }
      } catch (error) {
        console.error('[artifact_agent_reconcile_failed]', {
          taskId: input.taskId,
          messageId: input.messageId,
          error,
        });
      }
      // ⭐ P0 守卫：「声称成功但没产物」—— 从回复里抠出提到的产物文件名，逐个查存在性。
      //    声称了但不存在 ⇒ 报一条失败，让界面说人话（而不是"已完成"然后一片空白）。
      //    判据是「东西真的在」，不是「流程跑完了」。
      //    跨所有产物类功能（slidegen / docgen / htmlgen / 助手直接写文件），不是 PPT 专属。
      try {
        const roots = [input.workspacePath];
        const agentWs = (await run.agentBaseline)?.workspacePath;
        if (agentWs && !roots.includes(agentWs)) roots.push(agentWs);
        // ⭐ `sinceMs` 是**必需**的，不是可选项：只查名字的话，**上一轮留下的同名文件**
        //    会满足本轮的声称 ⇒「让助手再改一版」这种最常见的用法依然静默。
        //    `run.createdAt` 是这一轮开始（= 快照基线）的时刻，本轮写的文件必然比它新。
        const claimResult = checkClaimedFiles(input.content, roots, { sinceMs: run.createdAt });
        const missingExpected = missingExpectedArtifactKinds(run.expectedArtifactKinds, [...producedArtifactNames]);
        const missing = [
          ...new Set([
            ...claimResult.missing.map((file) => file.name),
            ...missingExpected.map((kind) => EXPECTED_ARTIFACT_LABELS[kind]),
          ]),
        ];
        if (missing.length > 0) {
          getDebugLogger().warn({
            domain: 'artifact',
            event: 'artifact.claim-guard.missing',
            taskId: input.taskId,
            data: {
              missing,
              present: claimResult.present.map((f) => f.name),
              expectedKinds: run.expectedArtifactKinds,
              missingExpectedKinds: missingExpected,
              produced: [...producedArtifactNames],
            },
          });
          deliveryFailure.missing = missing;
        }
      } catch (error) {
        console.error('[artifact_claim_guard_failed]', { taskId: input.taskId, error });
      }
    } finally {
      claimedArtifactRuns.delete(run.token);
      completedAssistantMessages.set(messageKey, {
        state: 'completed',
        touchedAt: Date.now(),
        sequence: nextCompletedMessageSequence++,
        taskId: input.taskId,
        sessionKey: input.sessionKey,
      });
      pruneCompletedAssistantMessages();
      if (
        !isArtifactRunCanceled(run) &&
        (deliveryFailure.missing.length ||
          deliveryFailure.slideFailures?.length ||
          deliveryFailure.docFailures?.length ||
          deliveryFailure.htmlFailures?.length)
      ) {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('artifact:claim-violation', deliveryFailure);
        }
      }
    }
  })();
}

export function registerDataHandlers(): void {
  ipcMain.handle(
    'data:create-task',
    (
      _event,
      task: {
        id: string;
        sessionKey: string;
        sessionId: string;
        title: string;
        status: string;
        ensemble?: boolean;
        model?: string;
        modelProvider?: string;
        thinkingLevel?: string;
        inputTokens?: number;
        outputTokens?: number;
        contextTokens?: number;
        teamId?: string;
        createdAt: string;
        updatedAt: string;
        tags: string[];
        artifactDir: string;
        gatewayId: string;
      },
    ) => {
      if (!isDbReady()) return ipcError(new Error('database not ready'));
      try {
        const db = getDb();
        db.insert(tasks)
          .values({
            id: task.id,
            sessionKey: task.sessionKey,
            sessionId: task.sessionId,
            title: task.title,
            status: task.status,
            ensemble: task.ensemble ?? false,
            model: task.model,
            modelProvider: task.modelProvider,
            thinkingLevel: task.thinkingLevel,
            inputTokens: task.inputTokens,
            outputTokens: task.outputTokens,
            contextTokens: task.contextTokens,
            teamId: task.teamId ?? null,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            tags: JSON.stringify(task.tags),
            artifactDir: task.artifactDir,
            gatewayId: task.gatewayId,
          })
          .run();
        return { ok: true };
      } catch (err) {
        console.error('[data] create-task failed:', err);
        return ipcError(err);
      }
    },
  );

  ipcMain.handle(
    'data:update-task',
    (
      _event,
      params: {
        id: string;
        title?: string;
        status?: string;
        ensemble?: boolean;
        model?: string;
        modelProvider?: string;
        thinkingLevel?: string;
        inputTokens?: number;
        outputTokens?: number;
        contextTokens?: number;
        teamId?: string | null;
        /**
         * 改任务的会话指针（多模型对比采纳后指到赢的那条会话）。
         * ⚠️ 只改**指针**：这条会话在网关侧本来就在，不新建也不删。
         */
        sessionKey?: string;
        /**
         * 置顶时间（ISO）。`null` = 取消置顶。
         * ⚠️ 与 `updatedAt` **无关**：置顶不是"活动"，不该刷新更新时间 ——
         * 否则取消置顶的瞬间，它会凭着一个假的新鲜度插回列表最前面。
         */
        pinnedAt?: string | null;
        updatedAt: string;
      },
    ) => {
      if (!isDbReady()) return ipcError(new Error('database not ready'));
      try {
        const db = getDb();
        const updates: Record<string, string | number | boolean | null | undefined> = { updatedAt: params.updatedAt };
        if (params.title !== undefined) updates.title = params.title;
        if (params.status !== undefined) updates.status = params.status;
        if (params.ensemble !== undefined) updates.ensemble = params.ensemble;
        if (params.model !== undefined) updates.model = params.model;
        if (params.modelProvider !== undefined) updates.modelProvider = params.modelProvider;
        if (params.thinkingLevel !== undefined) updates.thinkingLevel = params.thinkingLevel;
        if (params.inputTokens !== undefined) updates.inputTokens = params.inputTokens;
        if (params.outputTokens !== undefined) updates.outputTokens = params.outputTokens;
        if (params.contextTokens !== undefined) updates.contextTokens = params.contextTokens;
        if (params.teamId !== undefined) updates.teamId = params.teamId;
        if (params.sessionKey !== undefined) updates.sessionKey = params.sessionKey;
        if (params.pinnedAt !== undefined) updates.pinnedAt = params.pinnedAt;
        db.update(tasks).set(updates).where(eq(tasks.id, params.id)).run();
        return { ok: true };
      } catch (err) {
        console.error('[data] update-task failed:', err);
        return ipcError(err);
      }
    },
  );

  ipcMain.handle(
    'data:create-message',
    (
      _event,
      msg: {
        id: string;
        taskId: string;
        role: string;
        content: string;
        timestamp: string;
        sessionKey?: string;
        agentId?: string;
        runId?: string;
        attachments?: unknown[];
        toolCalls?: unknown[];
        thinkingContent?: string;
        model?: string;
      },
    ) => {
      if (!isDbReady()) return ipcError(new Error('database not ready'));
      try {
        const db = getDb();
        let resolvedSessionKey = msg.sessionKey;
        if (!resolvedSessionKey) {
          const task = db.select({ sk: tasks.sessionKey }).from(tasks).where(eq(tasks.id, msg.taskId)).get();
          resolvedSessionKey = task?.sk ?? '';
        }
        db.insert(messages)
          .values({
            id: msg.id,
            taskId: msg.taskId,
            role: msg.role,
            content: msg.content,
            timestamp: msg.timestamp,
            sessionKey: resolvedSessionKey,
            agentId: msg.agentId ?? null,
            runId: msg.runId ?? null,
            attachments: msg.attachments?.length ? JSON.stringify(msg.attachments) : null,
            toolCalls: msg.toolCalls?.length ? JSON.stringify(msg.toolCalls) : null,
            thinkingContent: msg.thinkingContent ?? null,
            model: msg.model ?? null,
          })
          .onConflictDoUpdate({
            target: [messages.taskId, messages.sessionKey, messages.role, messages.timestamp],
            set: {
              content: msg.content,
              agentId: msg.agentId ?? null,
              runId: msg.runId ?? null,
              attachments: msg.attachments?.length ? JSON.stringify(msg.attachments) : null,
              toolCalls: msg.toolCalls?.length ? JSON.stringify(msg.toolCalls) : null,
              // ⚠️ 故意「有空才覆盖」而不是 `?? null`：工具调用等中途落库若不带思考，
              // 不该把已经存下来的推理抹掉（其它字段没这个问题 —— 它们是同一个值的更新）。
              ...(msg.thinkingContent ? { thinkingContent: msg.thinkingContent } : {}),
              // 同上：模型只在**这条写入自己带**的时候覆盖。工具调用/推理那些中途
              // upsert 拿不到它，写成 `?? null` 会把已落库的模型抹掉，重载后徽章消失。
              ...(msg.model ? { model: msg.model } : {}),
            },
          })
          .run();
        const persisted = db
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.taskId, msg.taskId),
              eq(messages.sessionKey, resolvedSessionKey),
              eq(messages.role, msg.role),
              eq(messages.timestamp, msg.timestamp),
            ),
          )
          .get();
        const persistedMessageId = persisted?.id ?? msg.id;
        const workspacePath = getWorkspacePath();
        if (
          workspacePath &&
          msg.role === 'assistant' &&
          !hasRunningToolCall(msg.toolCalls) &&
          (msg.content.length > 0 || (msg.attachments?.length ?? 0) > 0 || (msg.toolCalls?.length ?? 0) > 0)
        ) {
          const run = artifactRuns.get(artifactRunKey(msg.taskId, resolvedSessionKey));
          if (run) {
            const taskRow = db.select({ gid: tasks.gatewayId }).from(tasks).where(eq(tasks.id, msg.taskId)).get();
            const gatewayHttpBase = taskRow ? getGatewayClient(taskRow.gid)?.httpBase : undefined;
            finalizeAssistantArtifacts({
              workspacePath,
              taskId: msg.taskId,
              sessionKey: resolvedSessionKey,
              messageId: persistedMessageId,
              runId: msg.runId,
              content: msg.content,
              attachments: msg.attachments as MessageAttachment[] | undefined,
              gatewayHttpBase,
              gatewayId: taskRow?.gid,
            });
          } else {
            // Legacy/history hydration still needs attachment and fenced-code
            // extraction. Reconciliation deliberately fails closed without a
            // trusted user-turn baseline so old workspace files are not claimed.
            autoExtractArtifacts({
              workspacePath,
              taskId: msg.taskId,
              messageId: persistedMessageId,
              content: msg.content,
              attachments: msg.attachments as MessageAttachment[] | undefined,
            }).catch((err: unknown) => console.error('[auto-extract]', err));
          }
        }
        return { ok: true };
      } catch (err) {
        console.error('[data] create-message failed:', err);
        return ipcError(err);
      }
    },
  );

  ipcMain.handle('data:delete-task', (_event, params: { id: string }) => {
    cancelArtifactRunsForTask(params.id);
    if (!isDbReady()) return ipcError(new Error('database not ready'));
    try {
      const db = getDb();
      db.delete(taskRoomSessions).where(eq(taskRoomSessions.taskId, params.id)).run();
      db.delete(taskRooms).where(eq(taskRooms.taskId, params.id)).run();
      db.delete(artifacts).where(eq(artifacts.taskId, params.id)).run();
      db.delete(messages).where(eq(messages.taskId, params.id)).run();
      db.delete(tasks).where(eq(tasks.id, params.id)).run();
      return { ok: true };
    } catch (err) {
      console.error('[data] delete-task failed:', err);
      return ipcError(err);
    }
  });

  ipcMain.handle('data:list-tasks', () => {
    if (!isDbReady()) return { ok: true, rows: [] };
    try {
      const db = getDb();
      const rows = db.select().from(tasks).orderBy(desc(tasks.createdAt)).all();
      return {
        ok: true,
        rows: rows.map((r) => {
          let tags: string[] = [];
          try {
            tags = JSON.parse(r.tags as string);
          } catch {}
          return { ...r, tags };
        }),
      };
    } catch (err) {
      console.error('[data] list-tasks failed:', err);
      return ipcError(err);
    }
  });

  ipcMain.handle('data:list-messages', (_event, params: { taskId: string }) => {
    if (!isDbReady()) return { ok: true, rows: [] };
    try {
      const db = getDb();
      const rows = db
        .select()
        .from(messages)
        .where(eq(messages.taskId, params.taskId))
        .orderBy(messages.timestamp)
        .all();
      return {
        ok: true,
        rows: rows.map((r) => {
          let attachments: unknown[] | undefined;
          let toolCalls: unknown[] | undefined;
          if (r.attachments) {
            try {
              attachments = JSON.parse(r.attachments as string);
            } catch {}
          }
          if (r.toolCalls) {
            try {
              toolCalls = JSON.parse(r.toolCalls as string);
            } catch {}
          }
          return { ...r, attachments, toolCalls };
        }),
      };
    } catch (err) {
      console.error('[data] list-messages failed:', err);
      return ipcError(err);
    }
  });

  ipcMain.handle(
    'data:persist-room',
    (
      _event,
      params: {
        taskId: string;
        status: string;
        conductorReady: boolean;
      },
    ) => {
      if (!isDbReady()) return ipcError(new Error('database not ready'));
      try {
        const db = getDb();
        db.insert(taskRooms)
          .values({
            taskId: params.taskId,
            status: params.status,
            conductorReady: params.conductorReady,
          })
          .onConflictDoUpdate({
            target: [taskRooms.taskId],
            set: {
              status: params.status,
              conductorReady: params.conductorReady,
            },
          })
          .run();
        return { ok: true };
      } catch (err) {
        console.error('[data] persist-room failed:', err);
        return ipcError(err);
      }
    },
  );

  ipcMain.handle('data:load-room', (_event, params: { taskId: string }) => {
    if (!isDbReady()) return { ok: true, room: null, performers: [] };
    try {
      const db = getDb();
      const room = db.select().from(taskRooms).where(eq(taskRooms.taskId, params.taskId)).get();
      const performers = db.select().from(taskRoomSessions).where(eq(taskRoomSessions.taskId, params.taskId)).all();
      return { ok: true, room: room ?? null, performers };
    } catch (err) {
      console.error('[data] load-room failed:', err);
      return ipcError(err);
    }
  });

  ipcMain.handle(
    'data:persist-performer',
    (
      _event,
      params: {
        taskId: string;
        sessionKey: string;
        agentId: string;
        agentName: string;
        emoji?: string;
        verifiedAt: string;
      },
    ) => {
      if (!isDbReady()) return ipcError(new Error('database not ready'));
      try {
        const db = getDb();
        db.insert(taskRoomSessions)
          .values({
            sessionKey: params.sessionKey,
            taskId: params.taskId,
            agentId: params.agentId,
            agentName: params.agentName,
            emoji: params.emoji ?? null,
            verifiedAt: params.verifiedAt,
          })
          .onConflictDoUpdate({
            target: [taskRoomSessions.sessionKey],
            set: {
              agentId: params.agentId,
              agentName: params.agentName,
              emoji: params.emoji ?? null,
              verifiedAt: params.verifiedAt,
            },
          })
          .run();
        return { ok: true };
      } catch (err) {
        console.error('[data] persist-performer failed:', err);
        return ipcError(err);
      }
    },
  );

  ipcMain.handle('data:delete-room', (_event, params: { taskId: string }) => {
    if (!isDbReady()) return ipcError(new Error('database not ready'));
    try {
      const db = getDb();
      db.delete(taskRoomSessions).where(eq(taskRoomSessions.taskId, params.taskId)).run();
      db.delete(taskRooms).where(eq(taskRooms.taskId, params.taskId)).run();
      return { ok: true };
    } catch (err) {
      console.error('[data] delete-room failed:', err);
      return ipcError(err);
    }
  });

  ipcMain.handle('data:teams-list', () => {
    if (!isDbReady()) return { ok: true, result: [] };
    try {
      const db = getDb();
      const rows = db.select().from(teams).orderBy(desc(teams.createdAt)).all();
      const agentRows = db.select().from(teamAgents).all();
      const agentsByTeam = new Map<
        string,
        Array<{
          agentId: string;
          role: string | null;
          isManager: boolean | null;
          skillsJson: string | null;
          position: string | null;
        }>
      >();
      for (const a of agentRows) {
        let list = agentsByTeam.get(a.teamId);
        if (!list) {
          list = [];
          agentsByTeam.set(a.teamId, list);
        }
        list.push({
          agentId: a.agentId,
          role: a.role,
          isManager: a.isManager,
          skillsJson: a.skillsJson,
          position: a.position,
        });
      }
      return {
        ok: true,
        result: rows.map((r) => ({
          ...r,
          agents: (agentsByTeam.get(r.id) ?? []).map((a) => ({
            agentId: a.agentId,
            role: a.role ?? '',
            isManager: a.isManager ?? false,
            skills: parseTeamAgentSkills(a.skillsJson),
            position: a.position ?? '',
          })),
        })),
      };
    } catch (err) {
      console.error('[data] teams-list failed:', err);
      return ipcError(err);
    }
  });

  ipcMain.handle('data:team-get', (_event, params: { id: string }) => {
    if (!isDbReady()) return ipcError(new Error('database not ready'));
    try {
      const db = getDb();
      const row = db.select().from(teams).where(eq(teams.id, params.id)).get();
      if (!row) return { ok: true, result: null };
      const agents = db
        .select()
        .from(teamAgents)
        .where(eq(teamAgents.teamId, params.id))
        .all()
        .map((a) => ({
          agentId: a.agentId,
          role: a.role ?? '',
          isManager: a.isManager ?? false,
          skills: parseTeamAgentSkills(a.skillsJson),
          position: a.position ?? '',
        }));
      return { ok: true, result: { ...row, agents } };
    } catch (err) {
      console.error('[data] team-get failed:', err);
      return ipcError(err);
    }
  });

  ipcMain.handle(
    'data:team-persist',
    (
      _event,
      params: {
        id: string;
        name: string;
        emoji?: string;
        description?: string;
        gatewayId: string;
        source?: string;
        version?: string;
        hubSlug?: string;
        agents: Array<{
          agentId: string;
          role?: string;
          isManager?: boolean;
          skills?: string[];
          /** 讨论职位（圆桌用）。'' = 用户没选。 */
          position?: string;
        }>;
        createdAt: string;
        updatedAt: string;
      },
    ) => {
      if (!isDbReady()) return ipcError(new Error('database not ready'));
      try {
        const db = getDb();
        db.transaction((tx) => {
          tx.insert(teams)
            .values({
              id: params.id,
              name: params.name,
              emoji: params.emoji ?? '',
              description: params.description ?? '',
              gatewayId: params.gatewayId,
              source: params.source ?? 'local',
              version: params.version ?? '',
              hubSlug: params.hubSlug ?? '',
              createdAt: params.createdAt,
              updatedAt: params.updatedAt,
            })
            .onConflictDoUpdate({
              target: [teams.id],
              set: {
                name: params.name,
                emoji: params.emoji ?? '',
                description: params.description ?? '',
                gatewayId: params.gatewayId,
                source: params.source ?? 'local',
                version: params.version ?? '',
                hubSlug: params.hubSlug ?? '',
                updatedAt: params.updatedAt,
              },
            })
            .run();
          tx.delete(teamAgents).where(eq(teamAgents.teamId, params.id)).run();
          for (const agent of params.agents) {
            tx.insert(teamAgents)
              .values({
                teamId: params.id,
                agentId: agent.agentId,
                role: agent.role ?? '',
                isManager: agent.isManager ?? false,
                skillsJson: JSON.stringify(agent.skills ?? []),
                // 讨论职位。空串 = 用户没选，读的时候由 normalizePosition 兜底 ——
                // 这里**不**替它填默认值，否则分不清"没选"和"选了领域专家"。
                position: agent.position ?? '',
              })
              .run();
          }
        });
        return { ok: true };
      } catch (err) {
        console.error('[data] team-persist failed:', err);
        return ipcError(err);
      }
    },
  );

  ipcMain.handle('data:team-delete', (_event, params: { id: string }) => {
    if (!isDbReady()) return ipcError(new Error('database not ready'));
    try {
      const db = getDb();
      db.transaction((tx) => {
        tx.delete(teamAgents).where(eq(teamAgents.teamId, params.id)).run();
        tx.delete(teams).where(eq(teams.id, params.id)).run();
      });
      return { ok: true };
    } catch (err) {
      console.error('[data] team-delete failed:', err);
      return ipcError(err);
    }
  });
}
