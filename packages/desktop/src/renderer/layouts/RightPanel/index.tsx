import { useCallback, useEffect, useMemo, useState } from 'react';
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

function sortArtifacts(artifacts: Artifact[]) {
  return [...artifacts].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export default function RightPanel() {
  const { t } = useTranslation();
  const activeTaskId = useTaskStore((s) => s.activeTaskId);
  const tasks = useTaskStore((s) => s.tasks);
  const setActiveTask = useTaskStore((s) => s.setActiveTask);
  const setHighlightedMessage = useMessageStore((s) => s.setHighlightedMessage);
  const setMainView = useUiStore((s) => s.setMainView);
  const selectedArtifactId = useFileStore((s) => s.selectedArtifactId);

  const [taskArtifacts, setTaskArtifacts] = useState<Artifact[]>([]);
  /** 全库产物（跨会话）。与 `taskArtifacts` 是两条查询：一个查会话内、一个查全部。 */
  const [allArtifacts, setAllArtifacts] = useState<Artifact[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const refreshArtifacts = useCallback(async () => {
    if (!activeTaskId) {
      setTaskArtifacts([]);
    } else {
      setRefreshing(true);
      try {
        const res = await window.clawwork.listArtifacts(activeTaskId);
        if (res.ok && res.result) setTaskArtifacts(sortArtifacts(res.result));
      } finally {
        setRefreshing(false);
      }
    }
    // 全库那条**不受"当前会话"影响**：它要的就是别的会话产出的东西。
    const all = await window.clawwork.listArtifacts();
    if (all.ok && all.result) setAllArtifacts(all.result);
  }, [activeTaskId]);

  useEffect(() => {
    void refreshArtifacts();

    const handleArtifactSaved = (artifact: Artifact) => {
      // ⚠️ 别的会话存了产物也要刷新历史区 —— 这正是"跨对话"要看见的东西
      //    （以前这里 `return` 掉，于是历史区要等下一次 mount 才更新）。
      void refreshArtifacts();
      void artifact;
    };
    const cleanup = window.clawwork.onArtifactSaved(handleArtifactSaved);
    return () => {
      cleanup();
    };
  }, [activeTaskId, refreshArtifacts]);

  /**
   * 历史产物（跨会话）：
   * 当前会话的那些**不进这里**（主列表已经有了），其余按来源会话分组、时间倒序、最多 50 条。
   */
  const history = useMemo(() => buildArtifactHistory(allArtifacts, activeTaskId), [allArtifacts, activeTaskId]);
  const taskTitles = useMemo(() => new Map(tasks.map((task) => [task.id, task.title])), [tasks]);

  /** 跳回来源会话 —— 与「文件」主视图里那条"跳转到源消息"同一套动作。 */
  const jumpToTask = useCallback(
    (taskId: string, messageId: string) => {
      setActiveTask(taskId);
      setHighlightedMessage(messageId);
      setMainView('chat');
    },
    [setActiveTask, setHighlightedMessage, setMainView],
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
              disabled={!activeTaskId || refreshing}
              onClick={() => void refreshArtifacts()}
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin motion-reduce:animate-none' : undefined} />
            </Button>
          }
        />
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2.5 px-3 py-3">
          {taskArtifacts.length === 0 ? (
            <div className="flex items-center gap-2 px-2 py-1.5 text-[var(--text-muted)]">
              <FileText size={14} className="shrink-0 text-[var(--text-muted)]" />
              <span className="type-support">{t('common.noFiles')}</span>
            </div>
          ) : (
            <div className="space-y-2">
              {taskArtifacts.map((a) => {
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
                    <ArtifactCard artifact={a} compact onSelectMessage={setHighlightedMessage} />
                  </div>
                );
              })}
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
                            <ArtifactCard artifact={a} compact onSelectMessage={setHighlightedMessage} />
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
