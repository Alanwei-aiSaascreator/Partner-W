import { app, BrowserWindow, ipcMain } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { and, eq, desc, sql } from 'drizzle-orm';
import { getDb, getSqlite, isDbReady } from '../db/index.js';
import { nativeTaskControl } from '../docgen/native-task-control.js';
import { nativeInputFromCompletedWrites } from '../docgen/native-tool-input.js';
import { renderNativePptFile } from '../docgen/native-file.js';
import { readSlideGenerationReceipt } from '../slidegen/receipt.js';
import { readWorkspaceBytes } from '../slidegen/source-file.js';
import { reviewNativePpt, type NativeVisualReview } from '../docgen/native-review.js';
import { nativeReviewPorts } from '../docgen/native-review-runtime.js';
import { tasks, messages, artifacts, taskRooms, taskRoomSessions, teams, teamAgents } from '../db/schema.js';
import { autoExtractArtifacts } from '../artifact/auto-extract.js';
import { saveArtifact } from '../artifact/save.js';
import { forgetTaskDeliveryActivities } from '../artifact/delivery-activity.js';
import { captureArtifactDeliveryOperation } from '../artifact/delivery-operation.js';
import { captureArtifactWorkspaceOwner } from '../artifact/workspace-owner.js';
import { subscribeWorkspaceScope } from '../workspace/scope.js';
import { captureTaskArtifactBaseline, reconcileTaskArtifacts, type ArtifactBaseline } from '../artifact/reconcile.js';
import { resolveAgentWorkspace } from '../artifact/agent-workspace.js';
import { generateDocumentsFromMessage } from '../docgen/generate.js';
// ⚠️ 两条线各往这里插了一行，合并时冲突过一次 —— **两个都要**。
//    删掉任何一个，下面各自那个调用点就变成 TS2304（找不到名字）。
import { resolvePptxTemplatesRoot } from '../docgen/pptx-template/locate.js';
import { generateHtmlPagesFromMessage } from '../htmlgen/generate.js';
import { generateSlidesFromMessage } from '../slidegen/generate.js';
import {
  collectToolSlideReceipts,
  hasUnconfirmedSlideToolOutput,
  isToolSlideOutputCurrent,
  type ToolSlideReceipt,
  reuseToolSlideDeck,
} from '../slidegen/tool-receipts.js';
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
  claimedFilesRejectedByIntegrity,
  EXPECTED_ARTIFACT_LABELS,
  expectedArtifactKindsFromRequest,
  missingExpectedArtifactKinds,
  type ExpectedArtifactKind,
} from '../artifact/claim-guard.js';
import {
  isDeckRevisionRequest,
  isDeckWorkRequest,
  isFreshDeckRequest,
  parseAgentIdFromSessionKey,
  type Artifact,
  type ArtifactDeliveryFailure,
  type ArtifactDeliverySettled,
  type MessageAttachment,
  type SlidegenFailure,
  type SlidegenWarning,
  type ToolCall,
} from '@clawwork/shared';
import { getWorkspacePath } from '../workspace/config.js';
import { getGatewayClient } from '../ws/index.js';
import { getDebugLogger } from '../debug/index.js';
import { withTeamMeetingTaskDeletion } from './team-meeting-handlers.js';

function ipcError(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : 'unknown' };
}

function mediaDownloadResolver(gatewayId: string | undefined, sessionKey: string) {
  return async (attachment: MessageAttachment): Promise<string | null> => {
    const gateway = gatewayId ? getGatewayClient(gatewayId) : undefined;
    if (!gateway || !attachment.artifactId?.startsWith('artifact_managed_media_')) return null;
    if (attachment.mimeType !== 'video/mp4' && attachment.mimeType !== 'video/webm') return null;
    try {
      const base = new URL(gateway.httpBase);
      const original = new URL(attachment.dataUrl);
      const route = original.pathname.match(/^\/api\/chat\/media\/outgoing\/([^/]+)\/([^/]+)\/full$/);
      if (
        original.origin !== base.origin ||
        original.username ||
        original.password ||
        original.hash ||
        original.search ||
        !route ||
        decodeURIComponent(route[1]) !== sessionKey
      )
        return null;
      const response = await gateway.sendReq('artifacts.download', { sessionKey, artifactId: attachment.artifactId });
      const artifact = response.artifact;
      if (
        !artifact ||
        typeof artifact !== 'object' ||
        !('id' in artifact) ||
        artifact.id !== attachment.artifactId ||
        !('sessionKey' in artifact) ||
        artifact.sessionKey !== sessionKey ||
        !('source' in artifact) ||
        artifact.source !== 'session-transcript' ||
        !('download' in artifact)
      )
        return null;
      const download = artifact.download;
      if (
        !download ||
        typeof download !== 'object' ||
        !('mode' in download) ||
        download.mode !== 'url' ||
        typeof response.url !== 'string'
      )
        return null;
      const ticket = new URL(response.url, base);
      if (
        ticket.origin !== base.origin ||
        ticket.pathname !== original.pathname ||
        ticket.username ||
        ticket.password ||
        ticket.hash
      )
        return null;
      return ticket.toString();
    } catch {
      return null;
    }
  };
}

function failedMediaSources(
  attachments: MessageAttachment[] | undefined,
  failures: NonNullable<ArtifactDeliveryFailure['mediaFailures']>,
  exactSources?: string[],
): string[] {
  if (exactSources) return exactSources;
  return (attachments ?? [])
    .filter((attachment) =>
      failures.some(
        (failure) =>
          failure.fileName ===
          (attachment.fileName?.replaceAll('\\', '/').split('/').at(-1)?.trim() ||
            `video.${attachment.mimeType === 'video/webm' ? 'webm' : 'mp4'}`),
      ),
    )
    .map(
      (attachment) =>
        `attachment:${createHash('sha256')
          .update(attachment.sourcePath ?? attachment.dataUrl)
          .digest('hex')
          .slice(0, 16)}`,
    );
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

/**
 * `child` 是否落在 `parent` 里（含相等）。
 *
 * ⚠️ Windows 上按**大小写不敏感**比：这里比的是"文件在不在这个目录下"，
 *    而两边可能一个来自 `realpathSync`（规范形态）、一个来自 `resolve`（用户书写形态）——
 *    大小写不同会把"在里面"判成"在外面"，方向是**多搬一份**（多余的动作），但一样要避免。
 */
function isWithinDirectory(parent: string, child: string): boolean {
  const base = resolve(parent);
  const target = resolve(child);
  const [left, right] = process.platform === 'win32' ? [base.toLowerCase(), target.toLowerCase()] : [base, target];
  return right === left || right.startsWith(left + sep);
}

/** 两个路径是不是同一个东西（同上，Windows 大小写不敏感）。 */
function isSamePath(left: string, right: string): boolean {
  const [base, target] = [resolve(left), resolve(right)];
  return process.platform === 'win32' ? base.toLowerCase() === target.toLowerCase() : base === target;
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
  /**
   * ⭐ **助手工作区 == 应用工作区**（便携单根 —— 真机 U 盘的主要形态，2026-10-08 真机）。
   *
   * 只影响一件事：收尾时**第二条 reconcile（agent 链）不跑**（同一目录会被扫两遍、
   * 两批产物撞 `local_path`）。收据确认 / 规范落位登记**照常** —— 那是这条链存在的理由，
   * 与"扫不扫第二遍"无关。旧行为在这里整体 return null，把确认链一起拆掉了（真机：
   * 原生成品+收据都在盘上，产物面板却是空的 + 假"未能自动确认"）。
   */
  sameAsWorkspace?: boolean;
}

interface ArtifactRunContext {
  baseline?: Promise<ArtifactBaseline>;
  /** 见 `AgentRootBaseline`。`null` = 没有第二个根，这趟不跑。 */
  agentBaseline?: Promise<AgentRootBaseline | null>;
  /**
   * **应用工作区根层**（第三个根）在这一轮开始之前的快照。
   *
   * ⚠️ `null` = 基线没采到 ⇒ 这一趟**不扫**（绝无基线裸扫）。它与 `baseline` 是
   *    两份独立的快照：那个记的是 `<工作区>/<taskId>` 里的文件，这个记的是**根层**的。
   */
  workspaceRootBaseline?: Promise<ArtifactBaseline | null>;
  /**
   * ⭐ 这一轮用户要的是"给人看的演示"（"另做一份PPT / 改稿 / 美化"——与 native 门同一批正则，
   * 在 `beginArtifactRun` 那一瞬定下）。见 H0 硬门：docgen 的 `kind:"pptx"` 会被拦下并导流。
   */
  deckIntent?: boolean;
  token: string;
  createdAt: number;
  sequence: number;
  expiryTimer: ReturnType<typeof setTimeout>;
  gatewayRunId?: string;
  /** 用户在这一轮明确要求交付的格式；空数组表示普通聊天/格式咨询。 */
  expectedArtifactKinds: ExpectedArtifactKind[];
  state: 'active' | 'canceled' | 'claimed';
  nativeControlled?: boolean;
  /** Parent fencing is established at dispatch, even before a PPT tool is selected. */
  nativeFenced?: boolean;
  nativePreviousReceipt?: string;
  taskId: string;
  sessionKey: string;
}

const artifactRuns = new Map<string, ArtifactRunContext[]>();
const claimedArtifactRuns = new Map<string, ArtifactRunContext>();
const desynchronizedArtifactSessions = new Set<string>();
const completedAssistantMessages = new Map<
  string,
  {
    state: 'inFlight' | 'completed';
    touchedAt: number;
    sequence: number;
    taskId: string;
    sessionKey: string;
    mediaRetrySucceeded?: boolean;
    mediaRetryRequiredSources?: string[];
    mediaRetrySettlement?: ArtifactDeliverySettled;
  }
>();
const ARTIFACT_RUN_TTL_MS = 15 * 60 * 1000;
const MAX_ARTIFACT_RUNS = 128;
const COMPLETED_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_COMPLETED_MESSAGES = 2048;
let nextArtifactRunSequence = 0;
let nextCompletedMessageSequence = 0;

subscribeWorkspaceScope(() => {
  for (const run of [...artifactRuns.values()].flat().concat([...claimedArtifactRuns.values()])) {
    run.state = 'canceled';
    clearTimeout(run.expiryTimer);
  }
  artifactRuns.clear();
  claimedArtifactRuns.clear();
  desynchronizedArtifactSessions.clear();
  completedAssistantMessages.clear();
});

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
      // 助手工作区恰好就是应用工作区 ⇒ **便携单根**（真机 U 盘的主要形态）。
      //
      // ⚠️ 2026-10-08 真机（W: 人工实测，用户原话"生成到盘里面了，但是产物显示是空的"）：
      //    旧行为这里 `return null`，把**收据确认 + 规范落位登记**整条链一起拆掉了 ——
      //    原生 PPT 渲染成功、成品与收据都在盘上，产物面板却永远是空的，还附带一句
      //    "演示文稿未能自动确认"（fail-closed 假失败）。**根没接上 ≠ 收据不存在。**
      //    ⇒ 基线照采（其余的消费者都要用），只把"**再扫一遍目录**"留给调用方跳过
      //      （`sameAsWorkspace` ⇒ 收尾时第二条 reconcile 不跑，避免双扫/撞 local_path）。
      getDebugLogger().debug({
        domain: 'artifact',
        event: 'artifact.agent-workspace.same-as-workspace',
        gatewayId: input.gatewayId,
        data: { agentId, taskId: input.taskId },
      });
      const baseline = await captureTaskArtifactBaseline({
        workspacePath,
        taskId: input.taskId,
        rootKind: 'agent',
      });
      return { workspacePath, baseline, deckBaseline: captureDeckFileBaseline(workspacePath), sameAsWorkspace: true };
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
  opts?: {
    gatewayId?: string;
    userContent?: string;
    nativeAutomaticFrom?: string;
    /** Internal automatic continuation: null means this run explicitly has no parent. */
    nativeParentReceipt?: string | null;
  },
): string {
  pruneArtifactRuns();
  pruneCompletedAssistantMessages();
  const token = randomUUID();
  const expectedKinds = expectedArtifactKindsFromRequest(opts?.userContent ?? '');
  const userContent = opts?.userContent ?? '';
  // ⚠️ 2026-10-09（只读复审 P1）：判据**唯一真源在 `@clawwork/shared`** —— 此前主进程
  //    与渲染层各写一份词表，两个方向各漏一类：首次制作（「把材料做成一份 PPT」）渲染层
  //    命中而这里不命中 ⇒ 硬门不生效；首次改稿（「美化这个 PPT」）这里命中而渲染层不命中
  //    ⇒ 不走 DeepSeek。现在两边 import 同一组函数（改一处、两处同时生效）。
  //    `newDeckIntent` 仍是**窄口径**（"另/新的 + 演示词"）：它服务受控 native 链的
  //    收据语义（这一轮要不要抛弃上一份收据、开启新 deck），不要把制作动词并进来。
  const newDeckIntent = isFreshDeckRequest(userContent);
  const revisionIntent = isDeckRevisionRequest(userContent) && !newDeckIntent;
  // ⭐ **演示意图**（H0 硬门，2026-10-07）：用户这一轮要的是"给人看的演示"。
  //    在**这一瞬**定下来存进 run：收尾时用户请求早就不在手上了，现场重算只会算错。
  //    它管的是 docgen 的 pptx 请求（拦下并导流去「幻灯版面」）—— 与 native 那套
  //    正交：受控模式里 docgen pptx 本来就是静默跳过，两个旗标同时成立时受控优先。
  //    ⇒ 判据 = 制作 ∨ 改稿 ∨ 全新的（与渲染层 deck 路由同一个出口）。
  const deckIntent = isDeckWorkRequest(userContent);
  let nativePreviousReceipt: string | undefined;
  let nativeFenced = false;
  let nativeControlled =
    process.env.ROYIN_NATIVE_PPT_VALIDATION === '1' && (expectedKinds.includes('pptx') || !!opts?.nativeAutomaticFrom);
  if (process.env.ROYIN_NATIVE_PPT_VALIDATION === '1') {
    const db = getSqlite();
    if (!db) throw Error('native-task-state-unavailable');
    if (db) {
      const control = nativeTaskControl(db);
      const lastReceipt = control.get(taskId)?.last_receipt ?? undefined;
      nativePreviousReceipt = opts?.nativeAutomaticFrom
        ? opts.nativeParentReceipt === undefined
          ? lastReceipt
          : (opts.nativeParentReceipt ?? undefined)
        : newDeckIntent
          ? undefined
          : lastReceipt;
      nativeControlled ||= !!nativePreviousReceipt && revisionIntent;
      nativeFenced = nativeControlled || !!nativePreviousReceipt;
      // Reserve this run's token now. Finalization must never beginUser and revive a stopped or newer run.
      if (nativeFenced) {
        if (opts?.nativeAutomaticFrom) {
          if (!control.beginAutomatic(taskId, opts.nativeAutomaticFrom, token))
            throw Error('native-auto-limit-or-stopped');
        } else control.beginUser(taskId, token);
      }
    }
  }
  const baseline = captureTaskArtifactBaseline({ workspacePath, taskId }).catch((error: unknown) => {
    console.error('[artifact_baseline_failed]', { taskId, error });
    throw error;
  });
  // Attach a rejection handler immediately. The final assistant write may never
  // arrive (cancel/disconnect), and an unobserved baseline rejection must not
  // become an unhandled process rejection.
  void baseline.catch(() => undefined);
  // ⭐ 第三个根：**应用工作区的根层**（2026-10-07）。与上面那条同刻起跑 ——
  //    它要抓的是"这一轮开始之前，根层就有哪些文件"，晚一刻就会把用户自己的文件
  //    当成这一轮的产物。现场：模型用 exec / CLI 把成品写到
  //    `荣盈魔方工作区\荣盈互动公司介绍-v2-ade3018a.pptx`，前两条链一条扫任务目录、
  //    一条扫助手工作区，根层文件谁都不收 ⇒ "生成成功了、面板里却没有"。
  //    ⚠️ 采不到（根不可信/IO 出错）⇒ `null` ⇒ 这一趟**不扫**（绝无基线裸扫）；
  //    与"没有第二个根"同一条处置，绝不掀翻整轮收尾。
  const workspaceRootBaseline = captureTaskArtifactBaseline({
    workspacePath,
    taskId,
    rootKind: 'workspace-root',
  }).catch((error: unknown) => {
    console.error('[artifact_workspace_root_baseline_failed]', { taskId, error });
    return null;
  });
  void workspaceRootBaseline.catch(() => undefined);
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
  if (process.env.ROYIN_NATIVE_PPT_VALIDATION === '1') {
    // A newer dispatch retires only requests still waiting to be accepted.
    // Keep the old token canceled even after the newer request has completed.
    for (const previous of queue) {
      if (!previous.gatewayRunId && previous.state === 'active') cancelArtifactRun(taskId, sessionKey, previous.token);
    }
  }
  queue.push({
    baseline,
    agentBaseline,
    workspaceRootBaseline,
    deckIntent,
    token,
    createdAt: Date.now(),
    sequence: nextArtifactRunSequence++,
    expiryTimer,
    state: 'active',
    expectedArtifactKinds: nativeControlled ? [...new Set([...expectedKinds, 'pptx' as const])] : expectedKinds,
    nativeControlled,
    nativeFenced,
    nativePreviousReceipt,
    taskId,
    sessionKey,
  });
  artifactRuns.set(key, queue);
  return token;
}

/** Read-only fence for a controlled dispatch resuming after asynchronous budget verification. */
export function isArtifactRunPendingCurrent(taskId: string, sessionKey: string, token: string): boolean {
  const queue = artifactRuns.get(artifactRunKey(taskId, sessionKey));
  const run = queue?.find((candidate) => candidate.token === token);
  return !!(run && run.state === 'active' && !run.gatewayRunId && queue?.at(-1) === run && !isArtifactRunCanceled(run));
}

function cancelNativeRun(run: ArtifactRunContext): void {
  run.state = 'canceled';
  if (!run.nativeFenced) return;
  const db = getSqlite();
  if (db) nativeTaskControl(db).cancel(run.taskId, run.token);
}

export function cancelArtifactRun(taskId: string, sessionKey: string, token: string): void {
  const key = artifactRunKey(taskId, sessionKey);
  const queue = artifactRuns.get(key);
  const index = queue?.findIndex((run) => run.token === token) ?? -1;
  if (!queue || index < 0) {
    const claimed = claimedArtifactRuns.get(token);
    if (claimed?.taskId === taskId && claimed.sessionKey === sessionKey) cancelNativeRun(claimed);
    return;
  }
  const run = queue[index];
  cancelNativeRun(run);
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
  for (const run of queue) {
    clearTimeout(run.expiryTimer);
    cancelNativeRun(run);
  }
  artifactRuns.delete(key);
  for (const [token, run] of claimedArtifactRuns) {
    if (artifactRunKey(run.taskId, run.sessionKey) !== key) continue;
    cancelNativeRun(run);
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
  if (run.state === 'canceled') return true;
  if (!run.nativeFenced) return false;
  const db = getSqlite(),
    state = db ? nativeTaskControl(db).get(run.taskId) : undefined;
  return !state || state.canceled === 1 || state.active_token !== run.token;
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
    for (const run of queue) {
      clearTimeout(run.expiryTimer);
      cancelNativeRun(run);
    }
    artifactRuns.delete(key);
  }
  for (const run of claimedArtifactRuns.values()) {
    if (run.sessionKey === sessionKey) cancelNativeRun(run);
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
    for (const run of queue) {
      clearTimeout(run.expiryTimer);
      cancelNativeRun(run);
    }
    artifactRuns.delete(key);
  }
  for (const run of claimedArtifactRuns.values()) {
    if (run.taskId === taskId) cancelNativeRun(run);
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

/**
 * ⭐ BUG-038：本任务**已经登记成产物**的文件名（`Set`，小写）。
 *
 * 判据的读者是 `checkClaimedFiles` 的 `isRegisteredName` —— 已登记名不算 "missing"。
 * 理由与边界（为什么不是放松守卫）见 `artifact/claim-guard.ts` 的选项注释。
 *
 * ⚠️ 读不到库（冷启动 / 无 sqlite / 查询失败）⇒ 回 `null` = **老判据一字不变**（宁可真报，不可漏判）。
 *    与 `artifact/claim-guard.ts` 的"读不到就当没有"同一条纪律：**不抛、不打 console.error**
 *    —— 这是守卫的旁路配套、不是主路径，为它污染错误通道只会掩盖真正的故障。
 * ⚠️ 名字统一小写比对：落盘层在 Windows 上不区分大小写，模型写的 `Report.DOCX`
 *    与登记行 `report.docx` 是同一个文件；这里只做**已登记名**的匹配，不会让新名字蒙混过关。
 */
function registeredArtifactNames(taskId: string): Set<string> | null {
  try {
    const sqlite = getSqlite();
    if (!sqlite) return null;
    const rows = sqlite.prepare('SELECT name FROM artifacts WHERE task_id = ?').all(taskId) as Array<{
      name?: unknown;
    }>;
    return new Set(
      rows
        .map((row) => (typeof row.name === 'string' ? row.name.trim().toLowerCase() : ''))
        .filter((name) => name.length > 0),
    );
  } catch {
    return null;
  }
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
  toolCalls?: unknown[];
}): void {
  const owner = captureArtifactWorkspaceOwner();
  if (!owner.current()) return;
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
  const activity = captureArtifactDeliveryOperation(input);
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
    const slideWarnings: SlidegenWarning[] = [];
    let confirmedSlides: ToolSlideReceipt[] = [];
    const nativeReviews: NativeVisualReview[] = [];
    let nativeDiagnostics: unknown[] = [];
    let nativeRegisteredReceipt: string | undefined;
    let requirePptProof = !!run.nativeControlled;
    const supersededNativeFiles = new Set<string>();
    let confirmedSlideWorkspace = '';
    const isRunCurrent = () => owner.current() && !isArtifactRunCanceled(run);
    let pipelineFailed = false;
    const rememberProduced = (artifact: { name?: string; localPath?: string }): void => {
      const name = artifact.name ?? artifact.localPath;
      if (name) producedArtifactNames.add(name);
    };
    const notifyReconciledArtifacts = (result: { saved: Artifact[]; updated?: Artifact[] }): void => {
      if (!owner.current()) return;
      const changed = new Map([...result.saved, ...(result.updated ?? [])].map((artifact) => [artifact.id, artifact]));
      for (const artifact of changed.values()) {
        rememberProduced(artifact);
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send('artifact:saved', artifact);
      }
    };
    try {
      const extraction = await autoExtractArtifacts({
        workspacePath: input.workspacePath,
        taskId: input.taskId,
        messageId: input.messageId,
        content: input.content,
        attachments: input.attachments,
        gatewayHttpBase: input.gatewayHttpBase,
        resolveMediaDownload: mediaDownloadResolver(input.gatewayId, input.sessionKey),
        onActivity: activity.phase,
      });
      if (!owner.current()) return;
      if (extraction?.mediaFailures.length) deliveryFailure.mediaFailures = extraction.mediaFailures;
      const completed = completedAssistantMessages.get(messageKey);
      if (completed)
        completed.mediaRetryRequiredSources = failedMediaSources(
          input.attachments,
          extraction?.mediaFailures ?? [],
          extraction?.failedMediaSourceKeys,
        );
    } catch (error) {
      if (!owner.current()) return;
      pipelineFailed = true;
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
    if (!owner.current()) return;
    const agentRoot = await run.agentBaseline;
    if (!owner.current()) return;
    const tools = (input.toolCalls ?? []).filter(
      (tool): tool is ToolCall =>
        typeof tool === 'object' &&
        tool !== null &&
        !Array.isArray(tool) &&
        'id' in tool &&
        typeof tool.id === 'string' &&
        'name' in tool &&
        typeof tool.name === 'string' &&
        'startedAt' in tool &&
        typeof tool.startedAt === 'string' &&
        'status' in tool &&
        ['running', 'done', 'error', 'awaitingApproval'].includes(String(tool.status)) &&
        (!('result' in tool) || tool.result === undefined || typeof tool.result === 'string') &&
        (!('args' in tool) ||
          tool.args === undefined ||
          (tool.args !== null && typeof tool.args === 'object' && !Array.isArray(tool.args))),
    );
    // ⭐ BUG-057（2026-10-09 只读复审）：助手目录**解析失败**（RPC 超时 / 网关离线）
    //    不许把收据确认整条链拆掉 —— 收据与成品可能就躺在应用工作区（它本来就是
    //    被允许的根之一）。根解析不出来 ≠ 收据不存在：主根回落到应用工作区，
    //    照常逐项校验收据与文件（哈希 / 目录身份 / 来源一个不松，只是换了读的起点）。
    const receiptWorkspace = agentRoot?.workspacePath ?? input.workspacePath;
    const confirmed = collectToolSlideReceipts({
      workspacePath: receiptWorkspace,
      taskId: input.taskId,
      sessionKey: input.sessionKey,
      runId: input.runId,
      allowNative: process.env.ROYIN_NATIVE_PPT_VALIDATION === '1',
      /**
       * ⭐ B 包（2026-10-07）：**还允许从应用工作区读收据**。
       *
       * 现场：模型把 CLI 的 cwd 设成了应用工作区（根层或子目录），收据与成品都在那儿 ——
       * 只认助手工作区的话那条收据永远读不回来 ⇒ 一份**真产出**被判成
       * `slidegen-output-unconfirmed`（假失败），而它其实就在盘上。
       * ⚠️ 只交**我们自己的根**（应用工作区）；报告里编出来的路径不作数（见 `reportOutputDir`）。
       */
      allowedReceiptRoots: [input.workspacePath],
      isNativeParentCurrent: (fileName) => {
        const parent = getDb()
          .select({ filePath: artifacts.filePath })
          .from(artifacts)
          .where(
            and(eq(artifacts.taskId, input.taskId), eq(artifacts.root, 'agent'), eq(artifacts.localPath, fileName)),
          )
          .get();
        if (!parent) return false;
        const expected = resolve(receiptWorkspace, fileName),
          actual = resolve(parent.filePath);
        return process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
      },
      messages: [
        {
          taskId: input.taskId,
          sessionKey: input.sessionKey,
          runId: input.runId,
          role: 'assistant',
          toolCalls: tools,
        },
      ],
    });
    const toolProofs = [...confirmed.receipts];
    const hasNativeProof = confirmed.receipts.some((entry) => entry.receipt.sourceFormat === 'native-template-v5');
    let currentNativeInput: string | undefined;
    if (agentRoot && run.nativeFenced && !hasNativeProof && isRunCurrent()) {
      try {
        // ⭐ BUG-046 ③：判据重定义——mtime 优先 + 本轮 edit 也算当前源（见
        //    `native-tool-input.ts`）；sinceMs=run 起点 ⇒ 旧文件永不冒充新产物。
        currentNativeInput =
          nativeInputFromCompletedWrites(agentRoot.workspacePath, tools, { sinceMs: run.createdAt }) ?? undefined;
      } catch {
        if (run.nativeControlled) nativeDiagnostics = [{ code: 'native-current-input-unavailable' }];
      }
    }
    // A same-task parent alone does not turn weather or plain chat into PPT work. Actual current-run evidence does.
    if (run.nativeFenced && (hasNativeProof || currentNativeInput) && isRunCurrent()) {
      run.nativeControlled = true;
      run.expectedArtifactKinds = [...new Set([...run.expectedArtifactKinds, 'pptx' as const])];
    }
    requirePptProof ||= process.env.ROYIN_NATIVE_PPT_VALIDATION === '1' && hasNativeProof;
    requirePptProof ||= !!run.nativeControlled;
    let managedRevision = false;
    if (run.nativeControlled && run.nativePreviousReceipt && agentRoot && isRunCurrent()) {
      const candidates = confirmed.receipts.filter((entry) => entry.receipt.sourceFormat === 'native-template-v5');
      const unlinked = candidates.find((entry) => entry.receipt.previousReceiptFile !== run.nativePreviousReceipt);
      if (unlinked) {
        try {
          if (candidates.length !== 1 || unlinked.receipt.revision !== 0)
            throw Error('native-revision-parent-mismatch');
          activity.phase('generating-presentation');
          const generated = await renderNativePptFile(unlinked.receipt.sourceFile, agentRoot.workspacePath, {
            enabled: true,
            templatesRoot: pptxTemplatesRoot(),
            sourceReceipt: unlinked.receiptFile,
            previous: run.nativePreviousReceipt,
            onPage: (p) => activity.phase('generating-presentation', { completed: p.completed, total: p.total }),
            isCurrent: () => owner.current() && !isArtifactRunCanceled(run),
          });
          if (generated.fileCreated && generated.receiptFile && isRunCurrent()) {
            // ⭐ **父链真的成了才退役 standalone 候选**（2026-10-04 真机事故）：原先在重渲染
            //    **之前**就把候选从 confirmed 移除并标 superseded ⇒ 一旦重渲染被拒（当时是数字
            //    守卫把目录序号 07/08 误当业务事实），物理文件还在盘上，却既不算本轮成果也不能
            //    被 reconcile 收走，界面最后只剩一句「工作区里没有这些文件」。失败必须保留文件
            //    与诊断：候选留在 confirmed，照常被审查/登记，诊断进自动纠正通道。
            managedRevision = true;
            confirmed.receipts = confirmed.receipts.filter((entry) => !candidates.includes(entry));
            for (const entry of candidates) supersededNativeFiles.add(entry.receipt.fileName);
            const receipt = readSlideGenerationReceipt(agentRoot.workspacePath, generated.receiptFile);
            confirmed.receipts.push({
              receiptFile: generated.receiptFile,
              receipt,
              source: readWorkspaceBytes(agentRoot.workspacePath, receipt.sourceFile, 1024 * 1024).toString('utf8'),
            });
          } else if (generated.fileCreated && generated.receiptFile) {
            // 文件已落盘但任务在这一刻不再是最新（被取消/被新轮替换）：保留文件，不退役、不登记。
            nativeDiagnostics = [{ code: 'native-task-canceled' }];
          } else nativeDiagnostics = generated.diagnostics ?? [{ code: 'native-revision-failed' }];
        } catch {
          nativeDiagnostics = [{ code: 'native-revision-parent-mismatch' }];
        }
      }
    }
    if (
      run.nativeControlled &&
      agentRoot &&
      isRunCurrent() &&
      !managedRevision &&
      !confirmed.receipts.some((entry) => entry.receipt.sourceFormat === 'native-template-v5')
    ) {
      try {
        const source = currentNativeInput;
        if (source) {
          activity.phase('generating-presentation');
          const generated = await renderNativePptFile(source, agentRoot.workspacePath, {
            enabled: true,
            templatesRoot: pptxTemplatesRoot(),
            onPage: (p) => activity.phase('generating-presentation', { completed: p.completed, total: p.total }),
            previous: run.nativePreviousReceipt,
            isCurrent: () => owner.current() && !isArtifactRunCanceled(run),
          });
          if (generated.fileCreated && generated.receiptFile) {
            const receipt = readSlideGenerationReceipt(agentRoot.workspacePath, generated.receiptFile);
            confirmed.receipts.push({
              receiptFile: generated.receiptFile,
              receipt,
              source: readWorkspaceBytes(agentRoot.workspacePath, receipt.sourceFile, 1024 * 1024).toString('utf8'),
            });
          } else nativeDiagnostics = generated.diagnostics ?? [{ code: 'native-generation-failed' }];
        } else if (!registeredArtifactNames(input.taskId)?.size) {
          // ⭐ BUG-046 ③ 判据重定义（用户三情形）：
          //   A 本轮要求"新生成"且任务从未登记过任何产物 ⇒ 必须有本轮 write/register 证据；
          //   B/C 任务已有登记产物（修改既有 PPT / 只是引用）⇒ 缺"本轮 current write"
          //       **本身不是失败**——真实文件存在 + 正确版本 + 成功登记 + 可重读
          //       （claim-guard 的 sinceMs/isRegisteredName 已分别守住 freshness 与豁免），
          //       不再注入 `native-current-write-required` 假诊断把模型带偏。
          //   ⚠️ 读不到库（registeredArtifactNames 回 null）⇒ 按 A 走（宁可真报，不可漏判）。
          nativeDiagnostics = [{ code: 'native-current-write-required' }];
        }
      } catch {
        nativeDiagnostics = [{ code: 'native-current-input-unavailable' }];
      }
    }
    for (const entry of confirmed.receipts.filter((entry) => entry.receipt.sourceFormat === 'native-template-v5')) {
      if (!agentRoot || !owner.current() || isArtifactRunCanceled(run)) break;
      const current = () => owner.current() && !isArtifactRunCanceled(run);
      activity.phase('reconciling-artifacts');
      const review = await reviewNativePpt(
        agentRoot.workspacePath,
        entry.receiptFile,
        nativeReviewPorts(
          agentRoot.workspacePath,
          { taskId: input.taskId, sessionKey: input.sessionKey, runId: input.runId },
          current,
        ),
        current,
      );
      nativeReviews.push(review);
      // 追加而不是覆盖：受管修订失败时那条诊断（如 native-revision-data-changed）必须活到
      // 自动纠正通道，不能被本轮的审查问题顶掉 —— 否则模型永远收不到真正的失败原因。
      if (review.status === 'needs-revision')
        nativeDiagnostics = [...nativeDiagnostics, ...(review.pages?.filter((p) => p.issues.length) ?? [])];
    }
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
              ...(run.nativeControlled ||
              confirmed.receipts.some((entry) => entry.receipt.sourceFormat === 'native-template-v5')
                ? { skipPptx: true }
                : {}),
              // ⭐ H0 硬门（2026-10-07）：演示意图 ⇒ docgen 的 pptx 请求一律不出片，
              //    改回一条诊断把模型导流到「幻灯版面（自己排）」。**提示词拦不住绕道，
              //    这一层才拦得住**（模型不读技能也逃不掉）。
              //    ⚠️ 上面那个 `skipPptx` 是受控跳过的旗标；两个同时成立时由 docgen 侧
              //    的分支顺序判"受控优先"（静默），这里只如实上报两个事实。
              reroutePptxToSlidegen: run.deckIntent === true,
              onActivity: activity.phase,
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
      if (!owner.current()) return;
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
      if (!owner.current()) return;
      pipelineFailed = true;
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
              onActivity: activity.phase,
            })
          : {
              saved: [],
              failed: hasStructuredFenceKind(input.content, 'htmlgen')
                ? ([{ code: 'htmlgen-block-invalid' }] as const)
                : [],
            };
      if (!owner.current()) return;
      for (const artifact of pages.saved) {
        rememberProduced(artifact);
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send('artifact:saved', artifact);
      }
      if (pages.failed.length > 0) {
        deliveryFailure.htmlFailures = [...pages.failed];
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send('htmlgen:failed', pages.failed);
      }
    } catch (error) {
      if (!owner.current()) return;
      pipelineFailed = true;
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
      if (!owner.current()) return;
      confirmedSlides = confirmed.receipts;
      confirmedSlideWorkspace = agentRoot?.workspacePath ?? '';
      const deckFiles = agentRoot?.deckBaseline
        ? changedDeckFiles(agentRoot.deckBaseline, agentRoot.workspacePath)
        : [];
      const sourceFiles =
        run.nativeControlled || confirmed.receipts.some((entry) => entry.receipt.sourceFormat === 'native-template-v5')
          ? []
          : [
              ...new Set([
                ...deckFiles,
                ...confirmed.receipts
                  .filter((entry) => entry.receipt.sourceFormat !== 'native-template-v5')
                  .map((entry) => entry.receipt.sourceFile),
              ]),
            ];
      let slideContent: string | null = null;
      let deckFileFailures: SlidegenFailure[] = [];
      if (agentRoot && sourceFiles.length > 0) {
        const fromFiles = decksFromFiles({ root: agentRoot.workspacePath, relatives: sourceFiles });
        slideContent = fromFiles.text;
        deckFileFailures = fromFiles.failures;
        // ⚠️ 必须留痕：这条路"没出片"时，日志里要能分辨是**文件路**走的还是**聊天路**走的。
        getDebugLogger().info({
          domain: 'artifact',
          event: 'slidegen.deck-files-used',
          gatewayId: input.gatewayId,
          data: {
            taskId: input.taskId,
            files: sourceFiles,
            confirmed: confirmed.receipts.length,
            rejected: confirmed.rejected,
            failures: deckFileFailures.map((f) => f.code),
          },
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
        if (structured.status === 'complete')
          slideContent =
            run.nativeControlled ||
            confirmed.receipts.some((entry) => entry.receipt.sourceFormat === 'native-template-v5')
              ? ''
              : structured.content;
      }

      if (confirmed.rejected > 0 || hasUnconfirmedSlideToolOutput(tools, [...toolProofs, ...confirmed.receipts])) {
        requirePptProof = process.env.ROYIN_NATIVE_PPT_VALIDATION === '1';
        const failure: SlidegenFailure = { code: 'slidegen-output-unconfirmed' };
        deliveryFailure.slideFailures = [failure];
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send('slidegen:failed', [failure]);
      } else if (slideContent === null) {
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
          onActivity: activity.phase,
          reuseExisting: agentRoot
            ? (deck) => reuseToolSlideDeck(agentRoot.workspacePath, confirmed.receipts, deck)
            : undefined,
        });
        if (!owner.current()) return;
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
        slideWarnings.push(...decks.warnings);
      }
    } catch (error) {
      if (!owner.current()) return;
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
        if (!owner.current()) return;
        if (isArtifactRunCanceled(run)) return;
        activity.phase('reconciling-artifacts');
        const result = await reconcileTaskArtifacts({
          workspacePath: input.workspacePath,
          taskId: input.taskId,
          messageId: input.messageId,
          baseline,
          isCandidateCurrent: (file) => {
            if (!isRunCurrent()) return false;
            if (process.env.ROYIN_NATIVE_PPT_VALIDATION === '1' && file.endsWith('.native-ppt.json')) return false;
            if (!requirePptProof || !/\.pptx$/i.test(file)) return true;
            // A copied file with the same name/hash has no authority from an agent-root receipt.
            const candidate = resolve(input.workspacePath, input.taskId, file);
            return confirmedSlides.some((entry) => {
              try {
                const actual = realpathSync.native(candidate);
                const proven = realpathSync.native(resolve(confirmedSlideWorkspace, entry.receipt.fileName));
                const samePath =
                  process.platform === 'win32' ? actual.toLowerCase() === proven.toLowerCase() : actual === proven;
                return (
                  samePath &&
                  isToolSlideOutputCurrent(confirmedSlideWorkspace, confirmedSlides, entry.receipt.fileName, true)
                );
              } catch {
                return false;
              }
            });
          },
        });
        if (!owner.current()) return;
        notifyReconciledArtifacts(result);
      } catch (error) {
        if (!owner.current()) return;
        pipelineFailed = true;
        console.error('[artifact_reconcile_failed]', { taskId: input.taskId, messageId: input.messageId, error });
      }
      // ⭐ 第三个根：**应用工作区的根层**（2026-10-07）。
      //
      // 现场：模型绕过 docgen / slidegen，用 exec / CLI 把成品直接写在
      // `荣盈魔方工作区\荣盈互动公司介绍-v2-ade3018a.pptx`。上面那条扫的是
      // `<工作区>/<taskId>`、下面那条扫助手工作区 —— 根层文件**两条都不覆盖**
      // ⇒ 文件真的生成了，产物面板里什么都没有，而且**连失败提示都没有**
      // （claim-guard 找得到那份文件，所以它不算"丢了"，只是从来没被登记过）。
      //
      // ⚠️ 与上面两条**完全独立**：各自的基线、各自的前缀、各自的行、各自的 try。
      // ⚠️ `isCandidateCurrent` **必须是根层版**：这一趟的相对路径是**裸文件名**，
      //    应用根那条闭包里的 `resolve(workspacePath, taskId, file)` 对它是错的
      //    （不报错，只是永远匹配不上 ⇒ 该收的收不进来）。这里只保留"这一轮还算不算数"。
      try {
        const rootBaseline = run.workspaceRootBaseline ? await run.workspaceRootBaseline : null;
        if (!owner.current()) return;
        // 没采到根层基线只是「这趟不扫根层」，不能 `return`：后面的结果/声称守卫仍要跑。
        if (!isArtifactRunCanceled(run) && rootBaseline) {
          activity.phase('reconciling-artifacts');
          const workspaceRootResult = await reconcileTaskArtifacts({
            workspacePath: input.workspacePath,
            taskId: input.taskId,
            messageId: input.messageId,
            baseline: rootBaseline,
            rootKind: 'workspace-root',
            isCandidateCurrent: (file) => {
              if (!isRunCurrent()) return false;
              if (process.env.ROYIN_NATIVE_PPT_VALIDATION === '1' && file.endsWith('.native-ppt.json')) return false;
              // 受控验收里"未经排版收据证明的 pptx"一律不收（与上面应用根同一条纪律）：
              // 根层文件**不可能**有收据（收据指向助手工作区），所以这里直接拒——
              // 宁可这趟少一份，也不给受控链引入没有来源的行。
              if (requirePptProof && /\.pptx$/i.test(file)) return false;
              return true;
            },
          });
          if (!owner.current()) return;
          // ⭐ 正面证据：真机排障时唯一能回答"这个功能跑没跑、找到了几条"的一行
          //    （没有它，用户说"根层的文件还是不进来"时只能猜：没扫到？基线没采到？真没文件？
          //    与 `artifact.agent-reconcile.done` 同一个理由）。
          getDebugLogger().info({
            domain: 'artifact',
            event: 'artifact.workspace-root-reconcile.done',
            taskId: input.taskId,
            data: {
              workspacePath: input.workspacePath,
              saved: workspaceRootResult.saved.length,
              existing: workspaceRootResult.existing.length,
              // ⚠️ `updated` 在老调用点/桩里可以缺（`notifyReconciledArtifacts` 也是这么处理的）——
              //    这一趟是**兜底**链，绝不能因为一条诊断字段的可缺性把整轮判成失败。
              updated: (workspaceRootResult.updated ?? []).length,
              skipped: workspaceRootResult.skipped.length,
            },
          });
          notifyReconciledArtifacts(workspaceRootResult);
        }
      } catch (error) {
        if (!owner.current()) return;
        pipelineFailed = true;
        console.error('[artifact_workspace_root_reconcile_failed]', {
          taskId: input.taskId,
          messageId: input.messageId,
          error,
        });
      }
      // ⭐ B 包（2026-10-07）：**渲到哪都算** —— 已确认的收据指向的那份成品若**没有被登记**
      // （模型把 CLI 的 cwd 设成了应用工作区的子目录、任何扫描根都覆盖不到的地方），
      // 就把它**复制进任务目录并登记**（`saveArtifact` = 现成的"复制 + 登记"通道），
      // 让它跟别的产物一样出现在面板里、出现在任务目录里。
      //
      // 为什么放在这里（应用根 / 工作区根层两条扫描之后、助手根那条之前）：
      //   · 那两条扫描都跑完了 ⇒ "登记上了没有"这个问题此刻有确定答案；
      //   · 助手根那条要判"已确认的稿子登记上了没有"（`staleSlideNames`）——
      //     跨根的稿子在助手根那趟**永远找不到**，本步骤的结果就是它的正面答案。
      // ⚠️ 判据是**"库里有没有一份指向这个文件的产物"**，不是"路径在不在扫描根里"：
      //    后者要复刻扫描器的全部排除规则（inbox / 点开头 / 脚本 / 保留名 / 深度），
      //    抄一份必然漂移 —— 少抄一条就会**重复登记**（同一份文件两行）。
      // ⚠️ 落点必须是我们自己的根（应用工作区）：报告/收据那一路给出的路径只在
      //    `allowedReceiptRoots` 之内才被认（见 `tool-receipts.ts` 的 `reportOutputDir`）。
      const relocatedDecks = new Map<string, Artifact>();
      let realWorkspace = '';
      try {
        // ⚠️ 拿不到工作区的真实路径 ⇒ **整步跳过**（不是失败）：工作区定位坏了时，
        //    上面的基线/扫描两条链早就在报自己的错了，这里再补一条"交付失败"只会把
        //    "环境没准备好"说成"这份稿子坏了"。
        realWorkspace = realpathSync.native(input.workspacePath);
      } catch {
        realWorkspace = '';
      }
      /** 库里有没有一份**指向这个文件**的产物行（= 用户已经能在面板里看到它）。 */
      const isRegisteredDeck = (absolutePath: string): boolean => {
        const sqlite = getSqlite();
        if (!sqlite) return false;
        try {
          const rows = sqlite.prepare('SELECT file_path FROM artifacts WHERE task_id = ?').all(input.taskId) as Array<{
            file_path: string;
          }>;
          return rows.some((row) => isSamePath(row.file_path, absolutePath));
        } catch {
          // 查不动就当"没登记"：宁可多搬一份（多余动作），不可漏掉（用户什么都看不到）。
          return false;
        }
      };
      try {
        // ⚠️ 2026-10-08 真机教训：这条链的每个 `continue` 原来都是**静默**的 ——
        //    真机上"产物面板为什么是空的"查不到任何一行证据。跳过可以，但必须留痕。
        const logRelocateSkip = (name: string, reason: string): void => {
          getDebugLogger().debug({
            domain: 'artifact',
            event: 'artifact.slidegen-deck-relocate-skipped',
            taskId: input.taskId,
            data: { name, reason },
          });
        };
        if (realWorkspace && isRunCurrent() && confirmedSlides.length > 0) {
          for (const entry of confirmedSlides) {
            const outputDir = entry.outputDir ?? agentRoot?.workspacePath ?? '';
            if (!outputDir) {
              logRelocateSkip(entry.receipt.fileName, 'no-output-dir');
              continue;
            }
            const source = resolve(outputDir, entry.receipt.fileName);
            // 已经登记过 ⇒ **一步都不动**（三个根里任何一个收了它，或上一轮已搬过）
            if (isRegisteredDeck(source)) continue;
            // 只在应用工作区里搬：别的目录不是我们的地盘（那正是 `saveArtifact` 的边界）
            let realSource = '';
            try {
              realSource = realpathSync.native(source);
            } catch {
              logRelocateSkip(entry.receipt.fileName, 'unresolvable');
              continue;
            }
            if (!isWithinDirectory(realWorkspace, realSource)) {
              logRelocateSkip(entry.receipt.fileName, 'outside-workspace');
              continue;
            }
            // 收据自己带着成品的哈希与字节数 —— 复制**之前**先按它核一遍，
            // 保证我们搬的是那份被证明过的字节（不是同名同路径的别的文件）。
            let bytes: Buffer;
            try {
              bytes = readFileSync(realSource);
            } catch {
              continue;
            }
            if (
              bytes.length !== entry.receipt.bytes ||
              createHash('sha256').update(bytes).digest('hex') !== entry.receipt.outputSha256
            ) {
              getDebugLogger().warn({
                domain: 'artifact',
                event: 'artifact.slidegen-deck-relocate-mismatch',
                taskId: input.taskId,
                data: { name: entry.receipt.fileName, outputDir },
              });
              continue;
            }
            const artifact = await saveArtifact({
              workspacePath: input.workspacePath,
              taskId: input.taskId,
              messageId: input.messageId,
              sourcePath: realSource,
              fileName: entry.receipt.fileName,
              sourceKey: `slidegen-cli:${entry.receiptFile}`,
            });
            if (!owner.current()) return;
            relocatedDecks.set(entry.receiptFile, artifact);
            rememberProduced(artifact);
            for (const win of BrowserWindow.getAllWindows()) win.webContents.send('artifact:saved', artifact);
            // ⭐ 正面证据：真机排障时唯一能回答"这份稿子渲到哪儿去了、我们搬了没有"的一行。
            getDebugLogger().info({
              domain: 'artifact',
              event: 'artifact.slidegen-deck-relocated',
              taskId: input.taskId,
              data: { name: artifact.name, localPath: artifact.localPath, outputDir },
            });
          }
        }
      } catch (error) {
        if (!owner.current()) return;
        // 搬不动**不是**交付失败：稿子还在盘上、收据也在（面板那行由扫描兜底）。
        // 但必须留痕 —— 静默是这一类问题的老毛病。
        pipelineFailed = true;
        console.error('[artifact_slidegen_relocate_failed]', {
          taskId: input.taskId,
          messageId: input.messageId,
          error,
        });
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
        if (!owner.current()) return;
        // 没有第二个根只是「这趟不扫助手工作区」，不能 `return`：后面的结果/声称守卫仍要跑。
        if (!isArtifactRunCanceled(run) && agentRoot) {
          activity.phase('reconciling-artifacts');
          const staleSlideNames = new Set<string>();
          // ⭐ 便携单根（助手工作区 == 应用工作区）：**这一趟不扫** —— 同一个目录已经被
          //    "应用工作区根层"那条链扫过，两批产物会撞 `local_path`（原注释写明的理由）。
          //    登记由"收据规范落位"那一步负责（confirmedSlides → 复制进任务目录 + 登记）。
          //    ⚠️ 只跳过**扫描**，不跳过下面的核对/留痕（它们吃的是空结果，行为不变）。
          const agentResult = agentRoot.sameAsWorkspace
            ? { saved: [], existing: [], updated: [], skipped: [], missing: [], budgetExhausted: false }
            : await reconcileTaskArtifacts({
                workspacePath: agentRoot.workspacePath,
                taskId: input.taskId,
                messageId: input.messageId,
                baseline: agentRoot.baseline,
                rootKind: 'agent',
                isCandidateCurrent: (file) => {
                  if (!isRunCurrent()) return false;
                  if (supersededNativeFiles.has(file)) return false;
                  if (process.env.ROYIN_NATIVE_PPT_VALIDATION === '1' && file.endsWith('.native-ppt.json'))
                    return false;
                  if (agentRoot.workspacePath === confirmedSlideWorkspace) {
                    const current = requirePptProof
                      ? isToolSlideOutputCurrent(agentRoot.workspacePath, confirmedSlides, file, true)
                      : isToolSlideOutputCurrent(agentRoot.workspacePath, confirmedSlides, file);
                    if (!current) {
                      staleSlideNames.add(file);
                      return false;
                    }
                  }
                  return true;
                },
              });
          if (!owner.current()) return;
          if (isRunCurrent()) {
            const indexed = [...agentResult.saved, ...agentResult.existing, ...(agentResult.updated ?? [])];
            for (const entry of confirmedSlides) {
              const expectedPath = resolve(agentRoot.workspacePath, entry.receipt.fileName);
              const matchesPath = (value: string) =>
                process.platform === 'win32'
                  ? value.toLowerCase() === expectedPath.toLowerCase()
                  : value === expectedPath;
              // ⭐ B 包：跨根的稿子（渲在应用工作区，不走助手工作区）在**这一趟里永远找不到** ——
              //    它由上一步"规范落位"复制进任务目录并登记（`relocatedDecks`），
              //    这里按那份登记核（名字 + 字节数，诚实核对，不因为"搬过"就当它合格）。
              const relocated = relocatedDecks.get(entry.receiptFile);
              const registered =
                relocated !== undefined
                  ? relocated.taskId === input.taskId &&
                    relocated.messageId === input.messageId &&
                    relocated.size === entry.receipt.bytes &&
                    relocated.name === entry.receipt.fileName
                  : indexed.some(
                      (artifact) =>
                        artifact.taskId === input.taskId &&
                        artifact.messageId === input.messageId &&
                        artifact.root === 'agent' &&
                        artifact.size === entry.receipt.bytes &&
                        matchesPath(resolve(artifact.filePath)) &&
                        matchesPath(resolve(agentRoot.workspacePath, artifact.localPath)),
                    );
              if (
                !registered ||
                !isToolSlideOutputCurrent(agentRoot.workspacePath, confirmedSlides, entry.receipt.fileName)
              )
                staleSlideNames.add(entry.receipt.fileName);
            }
          }
          if (staleSlideNames.size) {
            const normalized = (name: string) => (process.platform === 'win32' ? name.toLowerCase() : name);
            const stale = new Set([...staleSlideNames].map(normalized));
            const kept = slideWarnings.filter(
              (warning) => !warning.artifactName || !stale.has(normalized(warning.artifactName)),
            );
            slideWarnings.splice(0, slideWarnings.length, ...kept);
            if (!deliveryFailure.slideFailures?.some((failure) => failure.code === 'slidegen-output-unconfirmed')) {
              deliveryFailure.slideFailures = [
                ...(deliveryFailure.slideFailures ?? []),
                { code: 'slidegen-output-unconfirmed' },
              ];
              for (const win of BrowserWindow.getAllWindows())
                win.webContents.send('slidegen:failed', deliveryFailure.slideFailures);
            }
          }
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
          if (run.nativeControlled) {
            const latest = confirmedSlides
              .filter((entry) => entry.receipt.sourceFormat === 'native-template-v5')
              .at(-1);
            const registered =
              latest &&
              ([...agentResult.saved, ...agentResult.existing].some((a) => a.localPath === latest.receipt.fileName) ||
                // 便携单根：agent 链不扫（空结果）⇒ 登记形态是"规范落位"搬出来的那一行。
                relocatedDecks.has(latest.receiptFile));
            const db = getSqlite();
            if (db && latest && registered && !staleSlideNames.has(latest.receipt.fileName)) {
              nativeTaskControl(db).remember(input.taskId, run.token, latest.receiptFile);
              const current = nativeTaskControl(db).get(input.taskId);
              if (
                current?.active_token === run.token &&
                !current.canceled &&
                current.last_receipt === latest.receiptFile
              )
                nativeRegisteredReceipt = latest.receiptFile;
            }
          }
        }
      } catch (error) {
        if (!owner.current()) return;
        pipelineFailed = true;
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
        if (!owner.current()) return;
        if (agentWs && !roots.includes(agentWs)) roots.push(agentWs);
        // ⭐ `sinceMs` 是**必需**的，不是可选项：只查名字的话，**上一轮留下的同名文件**
        //    会满足本轮的声称 ⇒「让助手再改一版」这种最常见的用法依然静默。
        //    `run.createdAt` 是这一轮开始（= 快照基线）的时刻，本轮写的文件必然比它新。
        // ⭐ BUG-038（2026-10-08 亲验的**假失败**）：已登记名豁免 —— 模型在后续轮次里
        //    引用**本任务已登记的产物名**（"已生成 report.docx，在上一版基础上补充…"）时，
        //    那份文件本来就不该在本轮变新；旧判据拿 mtime 一把否定 ⇒ 每轮弹「说好的文件不在」。
        //    登记本身就是"东西存在"的证据（比 mtime 更硬）。守卫强度对**未登记**的名字一字未松
        //    （freshness 判据原样，见 `checkClaimedFiles` 的 `isRegisteredName`）。
        const registeredNames = registeredArtifactNames(input.taskId);
        const claimResult = checkClaimedFiles(input.content, roots, {
          sinceMs: run.createdAt,
          ...(registeredNames ? { isRegisteredName: (name: string) => registeredNames.has(name.toLowerCase()) } : {}),
        });
        // ⭐ BUG-042-c（静默丢弃）：声称了、**盘上有**、字节却不是那份格式的（JSON 改名成 .docx…）。
        //    只在"这一轮什么都没登记上"时判 —— 有真产物时这条不抢戏，也不把正常轮次拖进额外读盘。
        const invalidClaimed =
          producedArtifactNames.size === 0 && claimResult.present.length > 0
            ? claimedFilesRejectedByIntegrity(claimResult.present, roots, { sinceMs: run.createdAt })
            : [];
        const invalidArtifacts = [...new Set(invalidClaimed.map((file) => file.name))];
        const missingExpected = missingExpectedArtifactKinds(run.expectedArtifactKinds, [...producedArtifactNames]);
        // ⭐ 两种「缺」不混成一句话（2026-10-04 真机）：claimResult.missing 是**物理上找不到**
        //    声称的文件；missingExpected 是**成果列表里没登记到**该格式 —— 文件可能就在盘上，
        //    只是版本关联/登记没走完。旧代码把两者拼成一个 missing 列表，于是界面把后者也说成
        //    「工作区里没有这些文件」（当时两份改稿其实都在盘上）。分开报，守卫强度不变：
        //    freshness、版本证明、注册要求全部照旧。
        const missing = [...new Set(claimResult.missing.map((file) => file.name))];
        // ⭐ BUG-042-c：`invalidArtifacts` 非空 ⇒ **不再叠** missingKinds。两者说的是同一件事的
        //    两层（"要求的格式没登记" + "没登记的原因是那份文件根本不是有效文档"），
        //    一起报只会先弹一句更含糊的「成果没有登记」。取舍写在案：含义更准的那条胜出；
        //    被压掉的那层仍在下面的日志里（`missingExpectedKinds`）。
        const missingKinds =
          invalidArtifacts.length > 0 ? [] : missingExpected.map((kind) => EXPECTED_ARTIFACT_LABELS[kind]);
        if (invalidArtifacts.length > 0) {
          getDebugLogger().warn({
            domain: 'artifact',
            event: 'artifact.claim-guard.invalid-artifact',
            taskId: input.taskId,
            data: {
              invalidArtifacts,
              reasons: invalidClaimed.map((file) => ({ name: file.name, reason: file.reason })),
              produced: [...producedArtifactNames],
              missingExpectedKinds: missingExpected,
            },
          });
          deliveryFailure.invalidArtifacts = invalidArtifacts;
        }
        if (missing.length > 0 || missingKinds.length > 0) {
          getDebugLogger().warn({
            domain: 'artifact',
            event: 'artifact.claim-guard.missing',
            taskId: input.taskId,
            data: {
              missing,
              missingKinds,
              present: claimResult.present.map((f) => f.name),
              // ⭐ BUG-038：被"已登记名"豁免的（不是 missing，但排障时要看得见）。
              registered: (claimResult.registered ?? []).map((f) => f.name),
              expectedKinds: run.expectedArtifactKinds,
              missingExpectedKinds: missingExpected,
              produced: [...producedArtifactNames],
            },
          });
          if (missing.length > 0) deliveryFailure.missing = missing;
          if (missingKinds.length > 0) deliveryFailure.missingKinds = missingKinds;
        }
      } catch (error) {
        if (!owner.current()) return;
        pipelineFailed = true;
        console.error('[artifact_claim_guard_failed]', { taskId: input.taskId, error });
      }
    } finally {
      if (owner.current()) {
        const requiredMediaSources = completedAssistantMessages.get(messageKey)?.mediaRetryRequiredSources;
        if (completedAssistantMessages.get(messageKey)?.mediaRetrySucceeded) deliveryFailure.mediaFailures = undefined;
        completedAssistantMessages.set(messageKey, {
          state: 'completed',
          touchedAt: Date.now(),
          sequence: nextCompletedMessageSequence++,
          taskId: input.taskId,
          sessionKey: input.sessionKey,
          mediaRetryRequiredSources: requiredMediaSources,
        });
        pruneCompletedAssistantMessages();
        const failed = Boolean(
          pipelineFailed ||
          deliveryFailure.missing.length ||
          deliveryFailure.missingKinds?.length ||
          // ⭐ BUG-042-c：写出来的不是有效文档 = 这一轮**没交付**（不是 needs-review）。
          deliveryFailure.invalidArtifacts?.length ||
          deliveryFailure.slideFailures?.length ||
          deliveryFailure.docFailures?.length ||
          deliveryFailure.htmlFailures?.length ||
          deliveryFailure.mediaFailures?.length,
        );
        const canceled = isArtifactRunCanceled(run);
        const hasWarnings = !canceled && slideWarnings.length > 0;
        const nativeNeedsReview =
          !canceled &&
          confirmedSlides.some((entry) => entry.receipt.sourceFormat === 'native-template-v5') &&
          (nativeReviews.length === 0 || nativeReviews.some((review) => review.status !== 'passed'));
        const settlement: ArtifactDeliverySettled = {
          taskId: input.taskId,
          sessionKey: input.sessionKey,
          messageId: input.messageId,
          status: canceled
            ? 'canceled'
            : failed
              ? 'failed'
              : hasWarnings || nativeNeedsReview
                ? 'needs-review'
                : 'succeeded',
          ...(hasWarnings ? { slideWarnings } : {}),
        };
        const nonMediaFailed = Boolean(
          pipelineFailed ||
          deliveryFailure.missing.length ||
          deliveryFailure.missingKinds?.length ||
          deliveryFailure.invalidArtifacts?.length ||
          deliveryFailure.slideFailures?.length ||
          deliveryFailure.docFailures?.length ||
          deliveryFailure.htmlFailures?.length,
        );
        let correctionToken: string | undefined;
        if (run.nativeControlled && !canceled && nativeDiagnostics.length && input.gatewayId) {
          try {
            const { requireNativeTestBudget } = await import('../docgen/native-dispatch-guard.js');
            await requireNativeTestBudget();
            if (owner.current() && !isArtifactRunCanceled(run)) {
              const gw = getGatewayClient(input.gatewayId);
              if (gw?.isConnected) {
                const token = beginArtifactRun(input.workspacePath, input.taskId, input.sessionKey, {
                  gatewayId: input.gatewayId,
                  userContent: 'Revise the PPT',
                  nativeAutomaticFrom: run.token,
                  nativeParentReceipt: nativeRegisteredReceipt ?? run.nativePreviousReceipt ?? null,
                });
                correctionToken = token;
                const state = getSqlite();
                const current = state ? nativeTaskControl(state).get(input.taskId) : undefined;
                if (owner.current() && current && !current.canceled && current.active_token === token) {
                  const reply = await gw.sendChatMessage(
                    input.sessionKey,
                    'Controlled native PPT correction. Read presentation-deck-v2/CONTROLLED-VALIDATION.md. Fix only the reported pages or capacity errors; preserve supplied facts and chart data. Write the source and run the native helper. Diagnostics: ' +
                      JSON.stringify(nativeDiagnostics),
                  );
                  if (typeof reply?.runId === 'string')
                    bindArtifactRun(input.taskId, input.sessionKey, token, reply.runId);
                } else cancelArtifactRun(input.taskId, input.sessionKey, token);
              }
            }
          } catch {
            if (correctionToken) cancelArtifactRun(input.taskId, input.sessionKey, correctionToken);
            // Keep current files and pending quality status when budget, stop or correction limit blocks continuation.
          }
        }
        if (owner.current()) {
          const canceledAfterContinuation =
            run.state === 'canceled' || (!correctionToken && isArtifactRunCanceled(run));
          if (canceledAfterContinuation) {
            settlement.status = 'canceled';
            delete settlement.slideWarnings;
          }
          activity.finish(settlement.status);
          const completedMessage = completedAssistantMessages.get(messageKey);
          if (completedMessage)
            completedMessage.mediaRetrySettlement = {
              ...settlement,
              status: canceledAfterContinuation
                ? 'canceled'
                : nonMediaFailed
                  ? 'failed'
                  : hasWarnings || nativeNeedsReview
                    ? 'needs-review'
                    : 'succeeded',
            };
          for (const win of BrowserWindow.getAllWindows()) {
            if (!canceledAfterContinuation && hasWarnings) win.webContents.send('slidegen:warned', slideWarnings);
            win.webContents.send('artifact:delivery-settled', settlement);
          }
          if (
            !isArtifactRunCanceled(run) &&
            (deliveryFailure.missing.length ||
              deliveryFailure.missingKinds?.length ||
              deliveryFailure.invalidArtifacts?.length ||
              deliveryFailure.slideFailures?.length ||
              deliveryFailure.docFailures?.length ||
              deliveryFailure.htmlFailures?.length ||
              deliveryFailure.mediaFailures?.length)
          ) {
            for (const win of BrowserWindow.getAllWindows()) {
              win.webContents.send('artifact:claim-violation', deliveryFailure);
            }
          }
        }
      }
    }
  })()
    .catch((error: unknown) => {
      activity.finish('failed');
      console.error('[artifact] delivery pipeline failed:', error);
    })
    .finally(() => {
      claimedArtifactRuns.delete(run.token);
      activity.finish('failed');
    });
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
        mode?: string;
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
            mode: task.mode ?? null,
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
        mode?: string;
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
        /** deck 路由标记（演示文稿 → DeepSeek 的粘性开关）；见 `Task.deckRouted`。 */
        deckRouted?: boolean;
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
        if (params.mode !== undefined) updates.mode = params.mode;
        if (params.model !== undefined) updates.model = params.model;
        if (params.modelProvider !== undefined) updates.modelProvider = params.modelProvider;
        if (params.thinkingLevel !== undefined) updates.thinkingLevel = params.thinkingLevel;
        if (params.inputTokens !== undefined) updates.inputTokens = params.inputTokens;
        if (params.outputTokens !== undefined) updates.outputTokens = params.outputTokens;
        if (params.contextTokens !== undefined) updates.contextTokens = params.contextTokens;
        if (params.teamId !== undefined) updates.teamId = params.teamId;
        if (params.sessionKey !== undefined) updates.sessionKey = params.sessionKey;
        if (params.pinnedAt !== undefined) updates.pinnedAt = params.pinnedAt;
        if (params.deckRouted !== undefined) updates.deckRouted = params.deckRouted;
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
        const existing = db
          .select({ taskId: messages.taskId, sessionKey: messages.sessionKey, role: messages.role })
          .from(messages)
          .where(eq(messages.id, msg.id))
          .get();
        if (
          existing &&
          (existing.taskId !== msg.taskId || existing.sessionKey !== resolvedSessionKey || existing.role !== msg.role)
        ) {
          throw new Error('message id belongs to a different task, session or role');
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
            target:
              msg.role === 'system'
                ? messages.id
                : [messages.taskId, messages.sessionKey, messages.role, messages.timestamp],
            ...(msg.role !== 'system' ? { targetWhere: sql`role <> 'system'` } : {}),
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
            msg.role === 'system'
              ? eq(messages.id, msg.id)
              : and(
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
          if (run && !completedAssistantMessages.has(completedMessageKey(msg.taskId, persistedMessageId))) {
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
              toolCalls: msg.toolCalls,
            });
          } else {
            // Legacy/history hydration still needs attachment and fenced-code
            // extraction. Reconciliation deliberately fails closed without a
            // trusted user-turn baseline so old workspace files are not claimed.
            const owner = captureArtifactWorkspaceOwner();
            const taskRow = db.select({ gid: tasks.gatewayId }).from(tasks).where(eq(tasks.id, msg.taskId)).get();
            const gatewayHttpBase = taskRow ? getGatewayClient(taskRow.gid)?.httpBase : undefined;
            const activity = captureArtifactDeliveryOperation({
              taskId: msg.taskId,
              sessionKey: resolvedSessionKey,
              messageId: persistedMessageId,
              runId: msg.runId,
            });
            let activityOutcome: ArtifactDeliverySettled['status'] = 'failed';
            autoExtractArtifacts({
              workspacePath,
              taskId: msg.taskId,
              messageId: persistedMessageId,
              content: msg.content,
              attachments: msg.attachments as MessageAttachment[] | undefined,
              gatewayHttpBase,
              resolveMediaDownload: mediaDownloadResolver(taskRow?.gid, resolvedSessionKey),
              onActivity: activity.phase,
            })
              .then((result) => {
                if (!owner.current() || getDb() !== db || getWorkspacePath() !== workspacePath) return;
                const currentMessage = db
                  .select({ taskId: messages.taskId, sessionKey: messages.sessionKey, runId: messages.runId })
                  .from(messages)
                  .where(eq(messages.id, persistedMessageId))
                  .get();
                if (
                  currentMessage?.taskId !== msg.taskId ||
                  currentMessage.sessionKey !== resolvedSessionKey ||
                  (currentMessage.runId ?? undefined) !== (msg.runId ?? undefined)
                )
                  return;
                const completed = completedAssistantMessages.get(completedMessageKey(msg.taskId, persistedMessageId));
                activityOutcome = result?.mediaFailures.length
                  ? 'failed'
                  : (completed?.mediaRetrySettlement?.status ?? 'succeeded');
                const incomingVideoSources = new Set(
                  (msg.attachments as MessageAttachment[] | undefined)
                    ?.filter(
                      (attachment) => attachment.mimeType === 'video/mp4' || attachment.mimeType === 'video/webm',
                    )
                    .map(
                      (attachment) =>
                        `attachment:${createHash('sha256')
                          .update(attachment.sourcePath ?? attachment.dataUrl)
                          .digest('hex')
                          .slice(0, 16)}`,
                    ),
                );
                if (completed?.mediaRetryRequiredSources)
                  completed.mediaRetryRequiredSources = completed.mediaRetryRequiredSources.filter(
                    (key) => !incomingVideoSources.has(key) || !result?.savedMediaSourceKeys?.includes(key),
                  );
                if (completed?.mediaRetryRequiredSources?.length) activityOutcome = 'failed';
                if (!result?.mediaFailures.length) {
                  const savedSource = (msg.attachments as MessageAttachment[] | undefined)?.some(
                    (attachment) =>
                      (attachment.mimeType === 'video/mp4' || attachment.mimeType === 'video/webm') &&
                      result?.savedMediaSourceKeys?.includes(
                        `attachment:${createHash('sha256')
                          .update(attachment.sourcePath ?? attachment.dataUrl)
                          .digest('hex')
                          .slice(0, 16)}`,
                      ),
                  );
                  if (!savedSource) return;
                  if (completed) {
                    if (!completed.mediaRetryRequiredSources) return;
                    if (completed.mediaRetryRequiredSources.length) return;
                  }
                  if (completed?.state === 'inFlight') {
                    completed.mediaRetrySucceeded = true;
                    return;
                  }
                  if (completed && !completed.mediaRetrySettlement) return;
                  for (const win of BrowserWindow.getAllWindows()) {
                    win.webContents.send('artifact:delivery-settled', {
                      taskId: msg.taskId,
                      sessionKey: resolvedSessionKey,
                      messageId: persistedMessageId,
                      status: 'succeeded',
                      ...completed?.mediaRetrySettlement,
                    });
                  }
                  return;
                }
                const failure: ArtifactDeliveryFailure = {
                  taskId: msg.taskId,
                  sessionKey: resolvedSessionKey,
                  messageId: persistedMessageId,
                  missing: [],
                  mediaFailures: result.mediaFailures,
                };
                const messageKey = completedMessageKey(msg.taskId, persistedMessageId);
                pruneCompletedAssistantMessages();
                if (completed)
                  completed.mediaRetryRequiredSources = [
                    ...new Set([
                      ...(completed.mediaRetryRequiredSources ?? []),
                      ...failedMediaSources(
                        msg.attachments as MessageAttachment[] | undefined,
                        result.mediaFailures,
                        result.failedMediaSourceKeys,
                      ),
                    ]),
                  ];
                if (!completedAssistantMessages.has(messageKey))
                  completedAssistantMessages.set(messageKey, {
                    state: 'completed',
                    touchedAt: Date.now(),
                    sequence: nextCompletedMessageSequence++,
                    taskId: msg.taskId,
                    sessionKey: resolvedSessionKey,
                    mediaRetryRequiredSources: failedMediaSources(
                      msg.attachments as MessageAttachment[] | undefined,
                      result.mediaFailures,
                      result.failedMediaSourceKeys,
                    ),
                    mediaRetrySettlement: {
                      taskId: msg.taskId,
                      sessionKey: resolvedSessionKey,
                      messageId: persistedMessageId,
                      status: 'succeeded',
                    },
                  });
                for (const win of BrowserWindow.getAllWindows()) {
                  win.webContents.send('artifact:claim-violation', failure);
                  win.webContents.send('artifact:delivery-settled', {
                    taskId: msg.taskId,
                    sessionKey: resolvedSessionKey,
                    messageId: persistedMessageId,
                    status: 'failed',
                  });
                }
              })
              .catch((err: unknown) => {
                activityOutcome = 'failed';
                console.error('[auto-extract]', err);
              })
              .finally(() => activity.finish(activityOutcome));
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
    if (!isDbReady()) return ipcError(new Error('database not ready'));
    try {
      const db = getDb();
      withTeamMeetingTaskDeletion(params.id, () => {
        db.delete(taskRoomSessions).where(eq(taskRoomSessions.taskId, params.id)).run();
        db.delete(taskRooms).where(eq(taskRooms.taskId, params.id)).run();
        db.delete(artifacts).where(eq(artifacts.taskId, params.id)).run();
        db.delete(messages).where(eq(messages.taskId, params.id)).run();
        db.delete(tasks).where(eq(tasks.id, params.id)).run();
      });
      forgetTaskDeliveryActivities(params.id);
      cancelArtifactRunsForTask(params.id);
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
