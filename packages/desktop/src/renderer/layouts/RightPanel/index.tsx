import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, FileText, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTaskStore } from '@/stores/taskStore';
import { useMessageStore } from '@/stores/messageStore';
import { useFileStore } from '@/stores/fileStore';
import { useUiStore } from '@/stores/uiStore';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { Artifact } from '@clawwork/shared';
import PanelHeader from '@/components/semantic/PanelHeader';
import ArtifactCard from '@/components/ArtifactCard';
import FilePreview from '@/components/FilePreview';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { buildArtifactHistory } from '@/lib/artifact-history';
import { groupArtifactVersions } from '@/lib/artifact-versions';
import { clearArtifactPreviewFocusTarget, requestArtifactPreview } from '@/lib/artifact-preview-navigation';
import { toast } from '@/lib/toast';
import { useTeamMeetingStore } from '@/features/team-meeting/instance';

function sortArtifacts(artifacts: Artifact[]) {
  return [...artifacts].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/**
 * 一次预览选择的**权威查询归属**（H4b，2026-10-09 复审）。
 *
 * 旧实现只拿"旧快照属于当前任务"（`artifactScopeKey === scopeKey`）就敢判"这个 ID 不存在"
 * ⇒ 新卡刚出现、右栏还没刷到它时，点击会被判成"跨任务残留"清回列表。
 *
 * 现在：每次选择都有 `selectionKey`（范围 + 选中 ID + 第几次进入），并发起**一次覆盖它**
 * 的刷新；只有"同一选择 + 序号 ≥ 要求"的回包才能回答它。等待期间显示加载窗格。
 */
interface PreviewResolution {
  selectionKey: string;
  querySequence: number;
  status: 'pending' | 'resolved' | 'missing' | 'unavailable' | 'error';
}

export default function RightPanel() {
  const { t } = useTranslation();
  const translate = useRef(t);
  translate.current = t;
  const activeTaskId = useTaskStore((s) => s.activeTaskId);
  const workspaceEpoch = useTaskStore((s) => s.workspaceEpoch);
  const tasks = useTaskStore((s) => s.tasks);
  const setActiveTask = useTaskStore((s) => s.setActiveTask);
  const setHighlightedMessage = useMessageStore((s) => s.setHighlightedMessage);
  const setMainView = useUiStore((s) => s.setMainView);
  const selectedArtifactId = useFileStore((s) => s.selectedArtifactId);
  const artifactPanelMode = useUiStore((s) => s.artifactPanelMode);
  const setArtifactPanelMode = useUiStore((s) => s.setArtifactPanelMode);
  const meetings = useTeamMeetingStore((s) => s.records);
  const meeting = meetings.find((record) => record.turns.some((turn) => turn.taskId === activeTaskId));
  const scopeIds = useMemo(
    () => (meeting ? meeting.turns.map((turn) => turn.taskId) : activeTaskId ? [activeTaskId] : []),
    [meeting, activeTaskId],
  );
  const scopeKey = JSON.stringify([workspaceEpoch, activeTaskId, meeting?.id, scopeIds]);
  const currentScopeKey = useRef(scopeKey);
  currentScopeKey.current = scopeKey;

  const [taskArtifacts, setTaskArtifacts] = useState<Artifact[]>([]);
  const [artifactScopeKey, setArtifactScopeKey] = useState<string | null>(null);
  /** ⚠️ 条件表达式必须包在 useMemo 里：否则每个 render 产出新数组引用，
   *  下游 useMemo（versions / 预览解析）的依赖恒变、memo 白白失效（exhaustive-deps）。 */
  const currentTaskArtifacts = useMemo(
    () => (artifactScopeKey === scopeKey ? taskArtifacts : []),
    [artifactScopeKey, scopeKey, taskArtifacts],
  );
  /** 全库产物（跨会话）。与 `taskArtifacts` 是两条查询：一个查会话内、一个查全部。 */
  const [allArtifacts, setAllArtifacts] = useState<Artifact[]>([]);
  const [historyWorkspaceEpoch, setHistoryWorkspaceEpoch] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** 历史与问题文件（同任务的旧版本 + unsafe/missing）：默认折叠（图16 修复）。 */
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshSequence = useRef(0);
  /** 已排进当前帧的刷新（P3-9：一轮收尾会连发 N 条 artifact:saved）。 */
  const scheduledFrame = useRef<number | null>(null);

  // ── H4b：这次预览选择的身份与"覆盖它的那次查询" ────────────────────────────────
  /**
   * 选择的身份 = 范围 + 选中 ID + 「第几次进入预览」。
   *
   * ⚠️ nonce 是**渲染期推进的本地引用缓存**（不是 state、不持久化）：它只用来让
   *    "退出去再点进来同一份文件"也算一次**新选择**（要重新拿权威答案）。
   * ⚠️ 这样派生是安全的：React 渲染是纯的，nonce 只单调递增、不参与输出结构。
   */
  const previewSelectionRef = useRef<{
    pair: string | null;
    nonce: number;
    key: string | null;
    artifactId: string | null;
  }>({ pair: null, nonce: 0, key: null, artifactId: null });
  const selectionPair =
    artifactPanelMode === 'preview' && selectedArtifactId !== null
      ? JSON.stringify([scopeKey, selectedArtifactId])
      : null;
  if (previewSelectionRef.current.pair !== selectionPair) {
    const nonce = previewSelectionRef.current.nonce + 1;
    previewSelectionRef.current = {
      pair: selectionPair,
      nonce,
      key: selectionPair === null ? null : JSON.stringify([selectionPair, nonce]),
      artifactId: selectionPair === null ? null : selectedArtifactId,
    };
  }
  const selection = previewSelectionRef.current;
  const selectionKey = selection.key;

  const [resolution, setResolution] = useState<PreviewResolution | null>(null);
  /** 本次选择要求的最低查询序号（在发请求**之前**记录 —— 早于它的回包没资格回答）。 */
  const requiredQuerySequence = useRef(0);

  /**
   * 把某次查询的答案落到"它启动时的那次选择"上。
   * 要求：选择没变、序号够新、且不比已经落定的更新答案更旧（老回包不许盖掉新答案）。
   */
  const settlePreviewResolution = useCallback(
    (querySelectionKey: string, sequence: number, status: 'resolved' | 'missing' | 'unavailable' | 'error'): void => {
      if (previewSelectionRef.current.key !== querySelectionKey) return;
      if (sequence < requiredQuerySequence.current) return;
      setResolution((previous) => {
        if (previous && previous.selectionKey === querySelectionKey && previous.querySequence > sequence) {
          return previous;
        }
        return { selectionKey: querySelectionKey, querySequence: sequence, status };
      });
    },
    [],
  );

  const refreshArtifacts = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    /** 这次查询启动时的选择：回包只回答它（期间换了选择 ⇒ 不作数）。 */
    const querySelection = previewSelectionRef.current;
    const ownsScope = () => {
      const current = useTaskStore.getState();
      return (
        sequence === refreshSequence.current &&
        current.workspaceEpoch === workspaceEpoch &&
        current.activeTaskId === activeTaskId &&
        currentScopeKey.current === scopeKey
      );
    };
    setRefreshing(true);
    try {
      const [current, all] = await Promise.all([
        activeTaskId ? window.clawwork.listArtifacts(activeTaskId) : Promise.resolve({ ok: true, result: [] }),
        window.clawwork.listArtifacts(),
      ]);
      if (!ownsScope()) return;
      if (!current.ok || !all.ok) throw new Error('artifact refresh failed');
      const scoped = meeting
        ? (all.result ?? []).filter((artifact) => scopeIds.includes(artifact.taskId))
        : (current.result ?? []);
      setTaskArtifacts(sortArtifacts([...new Map(scoped.map((artifact) => [artifact.id, artifact])).values()]));
      setArtifactScopeKey(scopeKey);
      setAllArtifacts(all.result ?? []);
      setHistoryWorkspaceEpoch(workspaceEpoch);
      // ⭐ 这次回包**同时回答**它启动时的那次选择：查到了 ⇒ 按 availability 落定；
      //    查不到 ⇒ 权威地说"不存在"（此前任何旧列表都不能下这个结论）。
      if (querySelection.key !== null && querySelection.artifactId !== null) {
        const answer = scoped.find((artifact) => artifact.id === querySelection.artifactId) ?? null;
        settlePreviewResolution(
          querySelection.key,
          sequence,
          answer === null ? 'missing' : answer.availability === 'available' ? 'resolved' : 'unavailable',
        );
      }
    } catch {
      if (ownsScope()) {
        toast.error(translate.current('artifactCard.error'));
        // 覆盖本次选择的查询失败了 ⇒ 明确落定（结束 pending），不做无限 retry。
        if (querySelection.key !== null) settlePreviewResolution(querySelection.key, sequence, 'error');
      }
    } finally {
      if (ownsScope()) setRefreshing(false);
    }
  }, [activeTaskId, meeting, scopeIds, scopeKey, workspaceEpoch, settlePreviewResolution]);

  /**
   * 把一次刷新**合并进当前帧**（2026-10-07 体检 P3-9）。
   *
   * 一轮任务收尾会连着发 N 条 `artifact:saved`（自动抽取是逐个产物发的），
   * 每条都整轮刷新 = **2 次 `artifact:list`**（全表扫描 + 逐行 realpath/stat）——
   * 连存 20 个产物就是 40 次全表扫描，白烧在"同一瞬间到达的同一批数据"上。
   * 按帧合并：同一帧里到的信号只刷一次；跨帧的（用户真在连续操作）照旧各自刷。
   */
  const scheduleRefresh = useCallback(() => {
    if (scheduledFrame.current !== null) return;
    scheduledFrame.current = window.requestAnimationFrame(() => {
      scheduledFrame.current = null;
      void refreshArtifacts();
    });
  }, [refreshArtifacts]);

  useEffect(() => {
    void refreshArtifacts();

    const handleArtifactSaved = (artifact: Artifact) => {
      // ⚠️ 别的会话存了产物也要刷新历史区 —— 这正是"跨对话"要看见的东西
      //    （以前这里 `return` 掉，于是历史区要等下一次 mount 才更新）。
      void artifact;
      scheduleRefresh();
    };
    const cleanup = window.clawwork.onArtifactSaved(handleArtifactSaved);
    return () => {
      if (scheduledFrame.current !== null) window.cancelAnimationFrame(scheduledFrame.current);
      scheduledFrame.current = null;
      refreshSequence.current += 1;
      cleanup();
    };
  }, [activeTaskId, refreshArtifacts, scheduleRefresh]);

  /**
   * ⭐ H4b：**每次新的预览选择**都发起一次覆盖它的权威查询（一次，不重试）。
   *
   * - 已经有答案落在这次选择上（resolved/missing/unavailable/error）⇒ 什么都不做，
   *   绝不无限 query；
   * - 已有 RAF 里排队的刷新（artifact:saved 的合并刷）取消掉、合并进这一次 ——
   *   那次刷新的"起点"早于这次选择，不够资格回答它；
   * - `requiredQuerySequence` 在**发请求之前**记下：之后回包必须 ≥ 它才有资格。
   */
  useEffect(() => {
    if (selectionKey === null) return;
    if (resolution !== null && resolution.selectionKey === selectionKey) return;
    if (scheduledFrame.current !== null) {
      window.cancelAnimationFrame(scheduledFrame.current);
      scheduledFrame.current = null;
    }
    const required = refreshSequence.current + 1;
    requiredQuerySequence.current = required;
    setResolution({ selectionKey, querySequence: required, status: 'pending' });
    void refreshArtifacts();
  }, [selectionKey, resolution, refreshArtifacts]);

  /**
   * 历史产物（跨会话）：
   * 当前会话的那些**不进这里**（主列表已经有了），其余按来源会话分组、时间倒序、最多 50 条。
   */
  const history = useMemo(
    () =>
      buildArtifactHistory(
        historyWorkspaceEpoch === workspaceEpoch
          ? allArtifacts.filter((artifact) => !scopeIds.includes(artifact.taskId))
          : [],
        activeTaskId,
      ),
    [allArtifacts, activeTaskId, scopeIds, historyWorkspaceEpoch, workspaceEpoch],
  );
  /** 图16（2026-10-06）：同任务默认只展示**每族最新可用版本**；旧版/问题文件折叠。 */
  const versions = useMemo(() => groupArtifactVersions(currentTaskArtifacts), [currentTaskArtifacts]);
  /** 从**当前任务/会议范围**的成果集合里按 ID 找（不用全库、不拿历史 filePath 重造）。 */
  const previewMatch = useMemo(() => {
    if (artifactPanelMode !== 'preview' || !selectedArtifactId) return null;
    return currentTaskArtifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null;
  }, [artifactPanelMode, selectedArtifactId, currentTaskArtifacts]);

  /**
   * 这次选择的权威答案是否已经记在**它自己**身上：同一选择 + 序号 ≥ 要求的查询。
   * 旧查询的回包（哪怕是刚刚才到）不具资格回答新选择。
   * ⚠️ `pending` 也算"记在它身上"（那次查询已经发出）——所以"等待"与"落定"要分开判。
   */
  const answerOwnsSelection =
    resolution !== null &&
    selectionKey !== null &&
    resolution.selectionKey === selectionKey &&
    resolution.querySequence >= requiredQuerySequence.current;

  /** 这次选择已经**有终局答案**（不是还在等）。 */
  const previewAnswerSettled = answerOwnsSelection && resolution.status !== 'pending';

  /**
   * 预览对象 = 权威集合里的可用成果。**匹配 available 才挂 FilePreview**
   * （文件已不在/不让读 ⇒ 拿"越界读取"去试是错的；`unknown` 同样不放行）。
   */
  const previewArtifactResolved =
    answerOwnsSelection && resolution.status === 'resolved' && previewMatch?.availability === 'available'
      ? previewMatch
      : null;

  /**
   * ⭐ H4b 复位判据（替换旧的「只要解析不到就 clear」）：
   *
   * - 没有选中对象 ⇒ 复位（没有主语时不该占着预览态）；
   * - 本次选择已经**出终局**、却不是 resolved（missing/unavailable/error）⇒ 复位；
   * - 终局为 resolved 但集合里解不出可用实例（被上面两条覆盖，防御性兜底）⇒ 复位。
   *
   * ⚠️ **等待期间（pending）绝不复位**：旧列表里没有这个 ID 不代表它不存在 ——
   *    那正是 H4b 的假失败。等待时渲染加载窗格；复位后仍**保底**防幽灵抽屉（模式回 list）。
   */
  const shouldResetPreview =
    artifactPanelMode === 'preview' &&
    (selectedArtifactId === null || (previewAnswerSettled && previewArtifactResolved === null));

  useEffect(() => {
    if (shouldResetPreview) setArtifactPanelMode('list');
  }, [shouldResetPreview, setArtifactPanelMode]);

  /** 预览态但答案未落定（或落定前的一帧）⇒ 渲染加载窗格，**绝不把列表装进预览窗格**。 */
  const previewPending = artifactPanelMode === 'preview' && previewArtifactResolved === null;
  const taskTitles = useMemo(() => new Map(tasks.map((task) => [task.id, task.title])), [tasks]);

  /**
   * 跳回来源会话 —— 与「文件」主视图里那条"跳转到源消息"同一套动作。
   *
   * ⭐ H5：**先关抽屉再切会话**，顺序固定：
   * ① 清掉焦点入口引用 —— 这是"去来源"，关闭后不该把焦点还给旧卡；
   * ② 置回列表模式 —— 窄窗抽屉是在 `artifactPanelMode === 'preview'` 下渲染的；
   *    只切 `mainView`（本来就是 chat）不会关掉它，目标对话会继续被盖住；
   * ③④⑤ 再切任务/高亮/主视图。
   */
  const jumpToTask = useCallback(
    (taskId: string, messageId: string) => {
      const current = useTaskStore.getState();
      if (current.workspaceEpoch !== workspaceEpoch || current.activeTaskId !== activeTaskId) return;
      clearArtifactPreviewFocusTarget();
      setArtifactPanelMode('list');
      setActiveTask(taskId);
      setHighlightedMessage(messageId);
      setMainView('chat');
    },
    [setArtifactPanelMode, setActiveTask, setHighlightedMessage, setMainView, workspaceEpoch, activeTaskId],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[var(--density-toolbar-height)] items-center border-b border-[var(--border)] px-5 shrink-0">
        <PanelHeader
          title={t('rightPanel.artifacts')}
          className="w-full items-center"
          actions={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('artifactCard.refresh')}
              title={t('artifactCard.refresh')}
              disabled={refreshing}
              onClick={() => void refreshArtifacts()}
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin motion-reduce:animate-none' : undefined} />
            </Button>
          }
        />
      </div>

      {previewArtifactResolved ? (
        <div className="flex min-h-0 flex-1 flex-col" data-testid="artifact-preview-pane">
          <div className="flex shrink-0 items-center border-b border-[var(--border)] px-2 py-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-action="artifact-preview-back"
              className="gap-1.5"
              onClick={() => setArtifactPanelMode('list')}
            >
              <ArrowLeft size={14} />
              {t('rightPanel.backToList')}
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            <FilePreview artifact={previewArtifactResolved} onNavigateToTask={jumpToTask} />
          </div>
        </div>
      ) : previewPending ? (
        /* ⭐ H4b：这次选择的权威查询还没落定 —— 加载窗格（不是列表：列表装进预览抽屉
           就是"幽灵抽屉"的观感）。给返回入口，用户不被困在这儿。 */
        <div className="flex min-h-0 flex-1 flex-col" data-testid="artifact-preview-pending">
          <div className="flex shrink-0 items-center border-b border-[var(--border)] px-2 py-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-action="artifact-preview-back"
              className="gap-1.5"
              onClick={() => setArtifactPanelMode('list')}
            >
              <ArrowLeft size={14} />
              {t('rightPanel.backToList')}
            </Button>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <Loader2 size={20} className="animate-spin text-[var(--text-muted)] motion-reduce:animate-none" />
          </div>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-2.5 px-3 py-3">
            {versions.current.length === 0 && versions.archived.length === 0 ? (
              <div className="flex items-center gap-2 px-2 py-1.5 text-[var(--text-muted)]">
                <FileText size={14} className="shrink-0 text-[var(--text-muted)]" />
                <span className="type-support">{t('common.noFiles')}</span>
              </div>
            ) : (
              <div className="space-y-2">
                {versions.current.map((a) => {
                  const selected = a.taskId === activeTaskId && a.id === selectedArtifactId;
                  return (
                    <div
                      key={a.id}
                      aria-current={selected ? 'true' : undefined}
                      data-selected={selected ? 'true' : undefined}
                      className={cn(
                        'rounded-xl border border-transparent transition-colors',
                        selected && 'border-[var(--border-accent)]',
                      )}
                    >
                      {meeting && a.taskId !== activeTaskId && (
                        <button
                          data-meeting-source={a.taskId}
                          className="type-meta px-2 py-1 text-[var(--text-muted)]"
                          onClick={() => jumpToTask(a.taskId, a.messageId)}
                        >
                          {taskTitles.get(a.taskId) ?? t('rightPanel.historyUnknownTask')}
                        </button>
                      )}
                      <ArtifactCard
                        artifact={a}
                        compact
                        onSelectMessage={(messageId) => jumpToTask(a.taskId, messageId)}
                        onPreview={requestArtifactPreview}
                      />
                    </div>
                  );
                })}
              </div>
            )}

            {/* ── 历史与问题文件（同任务，图16）：默认折叠，不许铺满主列表 ── */}
            {versions.archived.length > 0 && (
              <div className="mt-1 border-t border-[var(--border)] pt-2" data-testid="artifact-archived">
                <button
                  type="button"
                  data-action="toggle-artifact-archived"
                  aria-expanded={archiveOpen}
                  onClick={() => setArchiveOpen((open) => !open)}
                  className="glow-focus flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                >
                  {archiveOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span className="type-support">
                    {t('rightPanel.archivedArtifacts')} ({versions.archived.length})
                  </span>
                </button>
                {archiveOpen && (
                  <div className="mt-1.5 space-y-2">
                    {versions.archived.map((a) => (
                      <ArtifactCard
                        key={a.id}
                        artifact={a}
                        compact
                        onSelectMessage={(messageId) => jumpToTask(a.taskId, messageId)}
                        onPreview={requestArtifactPreview}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── 历史产物（跨会话）：没有就整块不渲染 ── */}
            {history.groups.length > 0 && (
              <div className="mt-1 border-t border-[var(--border)] pt-2" data-testid="artifact-history">
                <button
                  type="button"
                  data-action="toggle-artifact-history"
                  aria-expanded={historyOpen}
                  onClick={() => setHistoryOpen((open) => !open)}
                  className="glow-focus flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                >
                  {historyOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span className="type-support">
                    {t('rightPanel.historyArtifacts')} ({history.shown})
                  </span>
                </button>

                {historyOpen && (
                  <div className="mt-1.5 space-y-3">
                    {history.groups.map((group) => (
                      <div key={group.taskId} data-history-task={group.taskId}>
                        <button
                          type="button"
                          data-action="jump-to-task"
                          onClick={() => jumpToTask(group.taskId, group.artifacts[0].messageId)}
                          className="glow-focus block w-full truncate rounded-md px-2 py-0.5 text-left type-meta text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        >
                          {taskTitles.get(group.taskId) ?? t('rightPanel.historyUnknownTask')}
                        </button>
                        <div className="mt-1 space-y-2">
                          {group.artifacts.map((a) => (
                            <div key={a.id} className="rounded-xl border border-transparent">
                              {/* ⚠️ 历史产物**不接预览**（独立复核 2026-10-09）：预览只从当前任务
                                  权威集合按 ID 解出，历史项跨任务 ⇒ 点了是静默空操作。这里保留
                                  回源动作；要看它就先"跳到来源会话"（那时它成为当前任务成果）。 */}
                              <ArtifactCard
                                artifact={a}
                                compact
                                onSelectMessage={(messageId) => jumpToTask(a.taskId, messageId)}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                    {history.hidden > 0 && (
                      <p className="type-meta px-2 text-[var(--text-muted)]">
                        {t('rightPanel.historyMore', { count: history.hidden })}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
