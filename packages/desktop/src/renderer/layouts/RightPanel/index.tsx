import { useCallback, useEffect, useState } from 'react';
import { FileText, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTaskStore } from '@/stores/taskStore';
import { useMessageStore } from '@/stores/messageStore';
import { useFileStore } from '@/stores/fileStore';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { Artifact } from '@clawwork/shared';
import PanelHeader from '@/components/semantic/PanelHeader';
import ArtifactCard from '@/components/ArtifactCard';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

function sortArtifacts(artifacts: Artifact[]) {
  return [...artifacts].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export default function RightPanel() {
  const { t } = useTranslation();
  const activeTaskId = useTaskStore((s) => s.activeTaskId);
  const setHighlightedMessage = useMessageStore((s) => s.setHighlightedMessage);
  const selectedArtifactId = useFileStore((s) => s.selectedArtifactId);

  const [taskArtifacts, setTaskArtifacts] = useState<Artifact[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const refreshArtifacts = useCallback(async () => {
    if (!activeTaskId) {
      setTaskArtifacts([]);
      return;
    }
    setRefreshing(true);
    try {
      const res = await window.clawwork.listArtifacts(activeTaskId);
      if (res.ok && res.result) setTaskArtifacts(sortArtifacts(res.result));
    } finally {
      setRefreshing(false);
    }
  }, [activeTaskId]);

  useEffect(() => {
    if (!activeTaskId) {
      setTaskArtifacts([]);
      return;
    }
    void refreshArtifacts();

    const handleArtifactSaved = (artifact: Artifact) => {
      if (artifact.taskId !== activeTaskId) return;
      void refreshArtifacts();
    };
    const cleanup = window.clawwork.onArtifactSaved(handleArtifactSaved);
    return () => {
      cleanup();
    };
  }, [activeTaskId, refreshArtifacts]);

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
        </div>
      </ScrollArea>
    </div>
  );
}
