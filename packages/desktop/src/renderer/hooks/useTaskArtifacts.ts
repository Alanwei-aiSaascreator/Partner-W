import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Artifact, IpcResult } from '@clawwork/shared';
import { useFileStore } from '@/stores/fileStore';
import { useTaskStore } from '@/stores/taskStore';
import { groupArtifactVersions } from '@/lib/artifact-versions';

/**
 * 聊天里的产物卡数据源（Codex 审核 P1-4，2026-10-08）。
 *
 * ## 为什么不能只用 `fileStore.artifacts`
 *
 * store 是全局视图（App 订阅 `artifact:saved` 做全库 upsert），但每行的 `availability`
 * 是**保存那一刻**算的：盘拔了 / 文件被删 / 网关没连上，store 里那行还停在旧结论。
 * 拿它单独渲染 = 用过期结论冒充"还能打开"。所以每次**任务级**
 * `window.clawwork.listArtifacts(taskId)` 拿一遍逐行实时算过的 availability，
 * 与 store 合并（规则见下）。
 *
 * ## 为什么不能"每次挂载都查一遍"
 *
 * 一轮任务收尾会连发 N 条 `artifact:saved`，聊天里也可能同时挂 N 张卡；
 * 一次 `artifact:list` 是主进程里的全表 + 逐行 realpath/stat。所以查询按
 * `${epoch}::${taskId}` **共享**：同一任务同一时刻**至多一个在途查询**，
 * 结果进模块级快照，所有消费者共享同一份。
 *
 * ## 规则（每条都有钉子用例：`test/use-task-artifacts.test.tsx`）
 *
 * 1. **fresh 优先**（取消 store 无条件胜出）：查询落定时若该任务的 store 指纹没变，
 *    新查询的字段（availability/filePath…）**压过** store 行；
 * 2. **期间有修订 ⇒ 本轮作废 + 一次跟进**：结论早于保存，压过就错了 ⇒ 丢弃本轮（不覆盖 store）、
 *    以 store 现状展示，并排队**一次**跟进重查。**三条落定路径（ok / !ok / throw）都要比指纹**——
 *    失败路径不比就把"修订触发"吞掉了（订阅者当时看到的是"在途"，不会重查）；
 *    失败本身**不自旋**（无修订即止）；
 * 3. **合并**：union by id；只在 store 里、不在 fresh 结果里的行保留（fetch 开始后才保存的）；
 * 4. **两个 20s 节拍**：①结果里还有 `unknown`（助手根解析的负缓存时长）⇒ 挂载期间每 20s 再核验；
 *    ②**已核验快照本身也有 20s 时效**（`VERIFIED_TTL_MS`）—— 否则磁盘上删了/恢复了文件，
 *    切回任务仍发布保存那一刻的旧结论。过期只在 ensureFetch 路径上被发现，不轮询；
 *    `artifact:saved`（= 该任务的 store 变更）触发快照失效并重查；
 * 5. **归属守卫**：迟到响应校验 epoch + 请求序号 + 仍在缓存里；epoch 变化即弃缓存；
 * 6. **失败可重试**：`IpcResult` 非 ok / throw ⇒ 保留现有快照、pending 照常落定；
 *    再挂载 / `artifact:saved` / TTL 都能重试；
 * 7. **宿主没有这条通道**（旧 preload / pwa / 测试环境守卫）⇒ 直接以 store 行落定，不抛。
 *
 * ⚠️ 快照缓存是**模块级**的（跨组件、跨挂载共享），所以任何"该任务在 store 里变了"的
 *    判定都必须现算现比（下面用该任务行的**内容指纹**，不用计数器 —— 计数器会被
 *    store 订阅者的注册顺序坑到：组件可能比计数器先看到新状态）。
 */

/** 主进程助手根解析的负缓存时长（`main/artifact/agent-workspace.ts`）：unknown 按这个节拍再核验。 */
const UNKNOWN_RECHECK_MS = 20_000;

/**
 * **已核验快照**的时效（与 unknown 节拍一致）。
 *
 * 没有它快照就是永久有效：磁盘上的文件被删/被恢复后切回任务，仍发布"保存那一刻"的旧结论。
 * 过期只在 `ensureFetch` 路径上被发现（挂载 / 该任务的 store 修订 / unknown 定时器），
 * **不轮询**、也不为它单独起定时器。
 */
const VERIFIED_TTL_MS = 20_000;

interface TaskArtifactEntry {
  key: string;
  epoch: number;
  taskId: string;
  /** 共享在途查询（同任务同时刻至多一个）。 */
  promise: Promise<void> | null;
  /** 已核验快照：仅当查询期间该任务的 store 指纹未变时才更新。 */
  rows: Artifact[] | null;
  /** 快照落定时的任务 store 指纹（现指纹相等 ⇒ 快照仍权威）。 */
  signature: string;
  fetchedAt: number;
  /** 该 epoch 内首次查询是否已落定（`pending` 判据）。 */
  settled: boolean;
  /** 请求序号（迟到响应守卫）。 */
  sequence: number;
  subscribers: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<string, TaskArtifactEntry>();
const listeners = new Map<string, Set<() => void>>();
const NO_ARTIFACTS: Artifact[] = [];

/** 组件本地的 fresh 镜像：`key` = 这份行属于哪个 `${epoch}::${taskId}`。 */
interface FreshMirror {
  key: string;
  rows: Artifact[] | null;
}

function entryKey(epoch: number, taskId: string): string {
  return `${epoch}::${taskId}`;
}

/**
 * `contentText` 的廉价指纹（FNV-1a 32 位 + 长度）。
 *
 * 渲染层从不渲染它（全库零消费），但它属于行的**内容身份**（自动抽取按它去重），
 * 变了同样意味着"该任务发生了修订"；正文可能很大，所以只带指纹、不搬全文。
 */
function contentFingerprint(text: string | undefined): string {
  if (!text) return '';
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

/**
 * 该任务在 store 里的**内容指纹**（等价于规则里的"该任务 store 变更计数"）。
 *
 * 刻意不用计数器：计数器要靠 store 订阅去加，而组件的重渲染与计数器自增谁先谁后
 * 取决于订阅注册顺序 —— 用现算现比的指纹就没有这个时序假设（变没变当场说了算）。
 *
 * 字段口径 = **一切决定身份/展示语义的列，一个不漏**：`reconcile.ts:776/912` 的正式路径
 * 是"同 ID、同 createdAt、等长文件覆盖，只变 `sourceKey`" —— 漏了它就会把旧修订当新修订
 * 发布（或把新修订的核验吞掉）。`contentText` 走指纹（见上）。
 */
function taskSignature(artifacts: readonly Artifact[], taskId: string): string {
  let signature = '';
  for (const artifact of artifacts) {
    if (artifact.taskId !== taskId) continue;
    signature += [
      artifact.id,
      artifact.sourceKey ?? '',
      artifact.availability,
      artifact.filePath,
      artifact.localPath,
      artifact.name,
      artifact.mimeType,
      artifact.type,
      artifact.messageId,
      artifact.size,
      artifact.createdAt,
      artifact.root ?? '',
      contentFingerprint(artifact.contentText),
    ].join('\u0001');
    signature += '\u0002';
  }
  return signature;
}

function sortByCreatedAtDesc(rows: Iterable<Artifact>): Artifact[] {
  return [...rows].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/** union by id：fresh 有效时同 id 以 fresh 为准；只在 store 里（fetch 开始后才保存）的行保留。 */
function mergeRows(storeRows: readonly Artifact[], freshRows: readonly Artifact[] | null): Artifact[] {
  if (!freshRows || freshRows.length === 0) return sortByCreatedAtDesc(storeRows);
  const merged = new Map<string, Artifact>();
  for (const artifact of storeRows) merged.set(artifact.id, artifact);
  for (const artifact of freshRows) merged.set(artifact.id, artifact);
  return sortByCreatedAtDesc(merged.values());
}

/** 该快照现在还权威吗：epoch 没换、该任务的 store 指纹没变、快照没过期、快照确实在。 */
function usableRows(entry: TaskArtifactEntry, epoch: number, signature: string): Artifact[] | null {
  if (entry.rows === null) return null;
  if (entry.epoch !== epoch) return null;
  if (entry.signature !== signature) return null;
  if (Date.now() - entry.fetchedAt > VERIFIED_TTL_MS) return null;
  return entry.rows;
}

/** 现在需不需要（重新）核验：没有快照 / 指纹变了 / 快照过期。 */
function needsFetch(entry: TaskArtifactEntry, signatureNow: string): boolean {
  if (entry.rows === null) return true;
  if (entry.signature !== signatureNow) return true;
  return Date.now() - entry.fetchedAt > VERIFIED_TTL_MS;
}

function ensureEntry(epoch: number, taskId: string): TaskArtifactEntry {
  const key = entryKey(epoch, taskId);
  const existing = entries.get(key);
  if (existing) return existing;
  const created: TaskArtifactEntry = {
    key,
    epoch,
    taskId,
    promise: null,
    rows: null,
    signature: '',
    fetchedAt: 0,
    settled: false,
    sequence: 0,
    subscribers: 0,
    timer: null,
  };
  entries.set(key, created);
  return created;
}

function isCurrentEntry(entry: TaskArtifactEntry): boolean {
  return entries.get(entry.key) === entry;
}

function clearEntryTimer(entry: TaskArtifactEntry): void {
  if (entry.timer === null) return;
  clearTimeout(entry.timer);
  entry.timer = null;
}

function dropEntry(entry: TaskArtifactEntry): void {
  clearEntryTimer(entry);
  entries.delete(entry.key);
}

/** epoch 变化即弃缓存（旧 epoch 的迟到响应另有归属守卫兜着）。 */
function pruneForeignEpochs(epoch: number): void {
  for (const entry of [...entries.values()]) {
    if (entry.epoch !== epoch) dropEntry(entry);
  }
}

function notify(key: string): void {
  const set = listeners.get(key);
  if (!set) return;
  for (const listener of [...set]) listener();
}

function subscribeKey(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(key);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(key);
  };
}

function hostListArtifacts(): ((taskId?: string) => Promise<IpcResult<Artifact[]>>) | undefined {
  if (typeof window === 'undefined') return undefined;
  const api = window.clawwork as { listArtifacts?: (taskId?: string) => Promise<IpcResult<Artifact[]>> } | undefined;
  return typeof api?.listArtifacts === 'function' ? api.listArtifacts : undefined;
}

/** 有界重查：unknown 挂满一个负缓存窗口（20s）就再核验一次；定时器随卸载/epoch 变化清理。 */
function evaluateUnknownRecheck(entry: TaskArtifactEntry): void {
  if (entry.subscribers <= 0) return;
  const epoch = useTaskStore.getState().workspaceEpoch;
  const signature = taskSignature(useFileStore.getState().artifacts, entry.taskId);
  const rows = mergeRows(
    useFileStore.getState().artifacts.filter((artifact) => artifact.taskId === entry.taskId),
    usableRows(entry, epoch, signature),
  );
  if (!rows.some((artifact) => artifact.availability === 'unknown')) {
    clearEntryTimer(entry);
    return;
  }
  if (entry.timer !== null) return;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (!isCurrentEntry(entry) || entry.subscribers <= 0) return;
    if (useTaskStore.getState().workspaceEpoch !== entry.epoch) return;
    void ensureFetch(entry);
  }, UNKNOWN_RECHECK_MS);
}

function ensureFetch(entry: TaskArtifactEntry): Promise<void> {
  if (entry.promise) return entry.promise;
  return startFetch(entry);
}

function startFetch(entry: TaskArtifactEntry): Promise<void> {
  const read = hostListArtifacts();
  if (!read) {
    // 宿主没有这条通道（旧 preload / pwa / 测试环境守卫）：直接以 store 行落定，不抛。
    entry.settled = true;
    notify(entry.key);
    return Promise.resolve();
  }
  const sequence = ++entry.sequence;
  const signatureAtStart = taskSignature(useFileStore.getState().artifacts, entry.taskId);
  const promise = (async () => {
    /** 落定后要不要补一次跟进（三条路径共用，见下方注释）。 */
    let followUp = false;
    // 归属守卫：迟到响应（epoch 已换 / 缓存已弃 / 已有更新的请求）一律不改共享状态。
    const owned = (): boolean =>
      isCurrentEntry(entry) && sequence === entry.sequence && useTaskStore.getState().workspaceEpoch === entry.epoch;
    /** 请求期间该任务在 store 里发生过修订吗（指纹变了）。 */
    const revisedDuringFlight = (): boolean =>
      taskSignature(useFileStore.getState().artifacts, entry.taskId) !== signatureAtStart;
    try {
      // 调用**同步发出**（挂载即查，不许拖一拍），但包一层 async：宿主若同步抛
      // （不走 Promise），异常会变成 rejection 而不是同步穿透 —— 否则 finally 会
      // 抢在下面 `entry.promise = promise` 之前跑掉，entry 从此钉在一个已死的
      // Promise 上，后续重试全被它挡住。
      const invoke = async (): Promise<IpcResult<Artifact[]>> => read(entry.taskId);
      const result = await invoke();
      if (owned()) {
        if (result?.ok) {
          if (revisedDuringFlight()) {
            // 期间这个任务在 store 里有新保存/更新 ⇒ 本轮结论已过期：作废（不覆盖 store）。
            followUp = true;
          } else {
            const rows = (result.result ?? []).filter((artifact) => artifact.taskId === entry.taskId);
            entry.rows = rows;
            entry.signature = signatureAtStart;
            entry.fetchedAt = Date.now();
          }
        } else if (revisedDuringFlight()) {
          // 失败 + 期间有修订：修订的触发在飞行中被吞了（订阅者看到的是"在途"→ 不重查），
          // 所以失败路径也要补一次 —— 但**失败本身不自旋**（无修订就到此为止）。
          followUp = true;
        }
        // !ok 且无修订 ⇒ 失败可重试：保留现有 rows，什么都不改。
      }
    } catch {
      // 同上：保留现有 rows（失败可重试）；期间有修订才补跟进。
      if (owned() && revisedDuringFlight()) followUp = true;
    } finally {
      entry.promise = null;
      entry.settled = true;
      notify(entry.key);
      evaluateUnknownRecheck(entry);
      if (followUp && entry.subscribers > 0 && isCurrentEntry(entry)) {
        // 有界跟进：同任务同时刻至多一个在途查询；跟进以自己的起点指纹为基线，
        // 期间没有新的保存/更新就必然以"已核验"落定（不会递归打出请求风暴）。
        void ensureFetch(entry);
      }
    }
  })();
  entry.promise = promise;
  return promise;
}

/**
 * 任务级产物：store 全库视图（订阅 `artifact:saved` 的落点）∪ 任务级实时核验快照。
 *
 * - `artifacts` = 合并结果（见文件头规则 1–3），每行带尽可能新鲜的 `availability`；
 * - `pending` = 该任务本轮 epoch 内**首次查询尚未落定**（调用方用它抑制
 *   "暂无产物 → 触发重试"的闪烁；落定后即使数据为空也不再是 pending）。
 */
export function useTaskArtifacts(taskId: string | undefined): { artifacts: Artifact[]; pending: boolean } {
  const storeArtifacts = useFileStore((s) => s.artifacts);
  const workspaceEpoch = useTaskStore((s) => s.workspaceEpoch);
  const [pending, setPending] = useState(true);
  /**
   * 本地镜像：共享快照里"现在权威"的那份 fresh 行（`rows: null` = 没有可用的 fresh）。
   * 带 `key` 标签 —— 换任务/换 epoch 的那一帧里，上一份镜像还没被 effect 清掉，
   * 标签能挡住"B 任务的卡借到 A 任务的行"这种串台。
   */
  const [freshMirror, setFreshMirror] = useState<FreshMirror | null>(null);

  const readFreshRows = useCallback((): FreshMirror | null => {
    if (!taskId) return null;
    const key = entryKey(workspaceEpoch, taskId);
    const entry = entries.get(key);
    if (!entry) return null;
    const signature = taskSignature(useFileStore.getState().artifacts, taskId);
    return { key, rows: usableRows(entry, workspaceEpoch, signature) };
  }, [taskId, workspaceEpoch]);

  /** 内容没变就不换引用（notify 是高频事件，别为同一份行白白重渲染）。 */
  const applyFreshMirror = useCallback((next: FreshMirror | null) => {
    setFreshMirror((prev) =>
      prev === next || (prev !== null && next !== null && prev.key === next.key && prev.rows === next.rows)
        ? prev
        : next,
    );
  }, []);

  // 挂载 / 换任务 / 换 epoch：认领共享查询（或复用已核验快照），各自等同一个 Promise 各自落定。
  useEffect(() => {
    pruneForeignEpochs(workspaceEpoch);
    if (!taskId) return;
    const entry = ensureEntry(workspaceEpoch, taskId);
    entry.subscribers += 1;
    let active = true;
    const unsubscribe = subscribeKey(entry.key, () => {
      if (!active) return;
      applyFreshMirror(readFreshRows());
    });
    setPending(!entry.settled);
    applyFreshMirror(readFreshRows());
    const signatureNow = taskSignature(useFileStore.getState().artifacts, taskId);
    const wait = needsFetch(entry, signatureNow) ? ensureFetch(entry) : null;
    // 发起者先卸载不许卡死后来者：谁挂载谁自己对同一个 Promise await、各自落定。
    const settle = (): void => {
      if (!active) return;
      setPending(false);
      applyFreshMirror(readFreshRows());
    };
    if (wait) {
      // 共享 Promise 按构造不会 reject（失败也走 settle）；这里兜一手是被 await 的链
      // 不该因任何一条监听器抛错而把消费者吊死（宁可落定 + 日志）。
      void wait.then(settle, (error: unknown) => {
        console.error('[useTaskArtifacts] artifact query failed:', error);
        settle();
      });
    }
    evaluateUnknownRecheck(entry);
    return () => {
      active = false;
      unsubscribe();
      entry.subscribers -= 1;
      if (entry.subscribers <= 0) clearEntryTimer(entry);
    };
  }, [taskId, workspaceEpoch, readFreshRows, applyFreshMirror]);

  // 该任务的 store 变更（`artifact:saved` 的落点）= 快照失效 ⇒ 重查 + 重评 unknown 定时器。
  // 依赖是内容指纹：只有该任务真的变了才重查（别的会话存产物不惊动这里）。
  const signature = useMemo(() => (taskId ? taskSignature(storeArtifacts, taskId) : ''), [storeArtifacts, taskId]);
  useEffect(() => {
    if (!taskId) return;
    const entry = entries.get(entryKey(workspaceEpoch, taskId));
    if (!entry) return;
    if (needsFetch(entry, signature)) void ensureFetch(entry);
    applyFreshMirror(readFreshRows());
    evaluateUnknownRecheck(entry);
  }, [signature, taskId, workspaceEpoch, readFreshRows, applyFreshMirror]);

  const artifacts = useMemo(() => {
    if (!taskId) return NO_ARTIFACTS;
    const key = entryKey(workspaceEpoch, taskId);
    const freshRows = freshMirror !== null && freshMirror.key === key ? freshMirror.rows : null;
    return mergeRows(
      storeArtifacts.filter((artifact) => artifact.taskId === taskId),
      freshRows,
    );
  }, [storeArtifacts, taskId, workspaceEpoch, freshMirror]);

  return { artifacts: taskId ? artifacts : NO_ARTIFACTS, pending: taskId ? pending : false };
}

/**
 * 一条聊天消息该展示的产物 = **先对完整任务归并、再按消息分发**。
 *
 * 顺序不能反：先把一切按消息切了再归并，同族的旧版会在它自己那条消息上
 * 冒充"当前版本"（用户看到两条一样的卡片、且旧的那条其实打不开）。
 * 归并后只有 `current` 落在它所属的消息上，旧版/问题文件留在折叠区。
 */
export function selectCurrentArtifactsForMessage(all: readonly Artifact[], messageId: string): Artifact[] {
  return groupArtifactVersions(all).current.filter((artifact) => artifact.messageId === messageId);
}
