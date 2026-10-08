import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTaskStore } from '@/stores/taskStore';
import { useMessageStore } from '@/stores/messageStore';
import { useFileStore } from '@/stores/fileStore';
import { useUiStore } from '@/stores/uiStore';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { Artifact } from '@clawwork/shared';
import PanelHeader from '@/components/semantic/PanelHeader';
import ArtifactCard from '@/components/ArtifactCard';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { buildArtifactHistory } from '@/lib/artifact-history';
import { groupArtifactVersions } from '@/lib/artifact-versions';
import { toast } from '@/lib/toast';
import { useTeamMeetingStore } from '@/features/team-meeting/instance';

function sortArtifacts(artifacts: Artifact[]) {
  return [...artifacts].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
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
  const currentTaskArtifacts = artifactScopeKey === scopeKey ? taskArtifacts : [];
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

  const refreshArtifacts = useCallback(async () => {
    const sequence = ++refreshSequence.current;
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
    } catch {
      if (ownsScope()) toast.error(translate.current('artifactCard.error'));
    } finally {
      if (ownsScope()) setRefreshing(false);
    }
  }, [activeTaskId, meeting, scopeIds, scopeKey, workspaceEpoch]);

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
  const taskTitles = useMemo(() => new Map(tasks.map((task) => [task.id, task.title])), [tasks]);

  /** 跳回来源会话 —— 与「文件」主视图里那条"跳转到源消息"同一套动作。 */
  const jumpToTask = useCallback(
    (taskId: string, messageId: string) => {
      const current = useTaskStore.getState();
      if (current.workspaceEpoch !== workspaceEpoch || current.activeTaskId !== activeTaskId) return;
      setActiveTask(taskId);
      setHighlightedMessage(messageId);
      setMainView('chat');
    },
    [setActiveTask, setHighlightedMessage, setMainView, workspaceEpoch, activeTaskId],
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
    </div>
  );
}
