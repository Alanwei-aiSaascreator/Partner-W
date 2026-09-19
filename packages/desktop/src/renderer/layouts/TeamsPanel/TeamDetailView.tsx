import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ArrowLeft,
  MessageSquare,
  Pencil,
  Check,
  X,
  Loader2,
  Puzzle,
  Package,
  Sparkles,
  Square,
  Users,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import type { Team } from '@clawwork/shared';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import ConfirmDialog from '@/components/semantic/ConfirmDialog';
import { useResizePanel } from '@/hooks/useResizePanel';
import { useUiStore } from '@/stores/uiStore';
import { cn } from '@/lib/utils';
import TeamFileTree, { type TreeFile } from './TeamFileTree';

interface SkillEntry {
  id: string;
  name: string;
}

interface TeamDetailViewProps {
  team: Team;
  onBack: () => void;
  onStartChat: () => void;
  onEdit: () => void;
  /** 开始一轮圆桌讨论（问题由这一层收集，跑由上层编排）。 */
  onStartRoundtable: (question: string) => void;
  /** 停止当前这一轮：不再往下发，并中断正在说的那一位。 */
  onStopRoundtable: () => void;
  /** 正在跑时禁用按钮，避免重复开一轮（每一轮都是真花钱）。 */
  roundtableRunning?: boolean;
}

export default function TeamDetailView({
  team,
  onBack,
  onStartChat,
  onEdit,
  onStartRoundtable,
  onStopRoundtable,
  roundtableRunning,
}: TeamDetailViewProps) {
  const { t } = useTranslation();
  const [roundtableQuestion, setRoundtableQuestion] = useState('');
  const memberCount = team.agents.length;
  // ⚠️ 这里**不**再判 `!roundtableRunning`：跑的时候渲染的是「停止」按钮，
  //    开始按钮压根不在 DOM 里 —— 加了就是死条件（变异验证实测：去掉它测试全绿）。
  const canStartRoundtable = memberCount >= 2 && roundtableQuestion.trim().length > 0;
  const agentCatalog = useUiStore((s) => s.agentCatalogByGateway[team.gatewayId]);
  const catalogById = useMemo(
    () => new Map((agentCatalog?.agents ?? []).map((a) => [a.id, a])),
    [agentCatalog?.agents],
  );
  const [selectedFile, setSelectedFile] = useState<TreeFile | null>(null);
  const [agentFilesMap, setAgentFilesMap] = useState<Record<string, { name: string }[]>>({});
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);
  const [discardTarget, setDiscardTarget] = useState<TreeFile | null>(null);
  const fetchedFiles = useRef(new Set<string>());
  const loadSeq = useRef(0);

  useEffect(() => {
    setSelectedFile({ id: 'team-md', label: 'TEAM.md', kind: 'team-md' });
    setEditingContent(null);
    fetchedFiles.current.clear();
  }, [team.id]);

  useEffect(() => {
    if (selectedFile?.kind === 'team-md') {
      setFileContent(team.description || '');
    }
  }, [team.id, team.description, selectedFile?.kind]);

  useEffect(() => {
    for (const agent of team.agents) {
      if (fetchedFiles.current.has(agent.agentId)) continue;
      fetchedFiles.current.add(agent.agentId);
      const agentId = agent.agentId;
      window.clawwork.listAgentFiles(team.gatewayId, agentId).then((res) => {
        if (!res.ok || !res.result) {
          fetchedFiles.current.delete(agentId);
          return;
        }
        const data = res.result as { files: { name: string }[] };
        setAgentFilesMap((prev) => ({ ...prev, [agentId]: data.files ?? [] }));
      });
    }
  }, [team.agents, team.gatewayId]);

  const agentNodes = useMemo(
    () =>
      team.agents.map((a) => {
        const catalog = catalogById.get(a.agentId);
        return {
          agentId: a.agentId,
          name: catalog?.name ?? a.agentId,
          role: a.role,
          isManager: a.isManager,
          model: catalog?.model?.primary,
          files: (agentFilesMap[a.agentId] ?? []).map((f) => ({
            id: `agent-file-${a.agentId}-${f.name}`,
            label: f.name,
            kind: 'agent-file' as const,
            agentId: a.agentId,
          })),
          skillCount: (a.skills ?? []).length,
        };
      }),
    [team.agents, agentFilesMap, catalogById],
  );

  const allSkills = useMemo(() => {
    const seen = new Set<string>();
    const result: SkillEntry[] = [];
    for (const agent of team.agents) {
      for (const skill of agent.skills ?? []) {
        if (seen.has(skill)) continue;
        seen.add(skill);
        result.push({ id: skill, name: skill });
      }
    }
    return result;
  }, [team.agents]);

  const isDirty = editingContent !== null && editingContent !== fileContent;
  const {
    width: fileTreeWidth,
    isDragging: isFileTreeDragging,
    handleMouseDown: handleFileTreeResizeStart,
  } = useResizePanel({
    defaultWidth: 220,
    minWidth: 192,
    maxWidth: 420,
    storageKey: 'clawwork:team-file-tree-width',
    side: 'left',
  });

  const loadFile = useCallback(
    async (file: TreeFile) => {
      setSelectedFile(file);
      setEditingContent(null);
      if (file.kind === 'team-md') {
        setFileContent(team.description || '');
        return;
      }
      if (file.kind === 'agent-file' && file.agentId) {
        const seq = ++loadSeq.current;
        setLoadingContent(true);
        const res = await window.clawwork.getAgentFile(team.gatewayId, file.agentId, file.label);
        if (seq !== loadSeq.current) return;
        setLoadingContent(false);
        const data = res.ok ? (res.result as { file?: { content?: string } }) : null;
        setFileContent(data?.file?.content ?? '');
        return;
      }
      setFileContent(null);
    },
    [team.gatewayId, team.description],
  );

  const handleSelectFile = useCallback(
    (file: TreeFile) => {
      if (isDirty) {
        setDiscardTarget(file);
        return;
      }
      loadFile(file);
    },
    [isDirty, loadFile],
  );

  const confirmDiscard = useCallback(() => {
    if (discardTarget) loadFile(discardTarget);
    setDiscardTarget(null);
  }, [discardTarget, loadFile]);

  const cancelDiscard = useCallback(() => {
    setDiscardTarget(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!selectedFile?.agentId || selectedFile.kind !== 'agent-file' || editingContent === null) return;
    setSaving(true);
    try {
      const res = await window.clawwork.setAgentFile(
        team.gatewayId,
        selectedFile.agentId,
        selectedFile.label,
        editingContent,
      );
      if (res.ok) {
        toast.success(t('teams.detail.fileSaved'));
        setFileContent(editingContent);
        setEditingContent(null);
      } else {
        toast.error(res.error ?? t('teams.detail.fileSaveFailed'));
      }
    } finally {
      setSaving(false);
    }
  }, [selectedFile, editingContent, team.gatewayId, t]);

  const agentSkills = useMemo<SkillEntry[]>(() => {
    if (selectedFile?.kind !== 'agent-skills' || !selectedFile.agentId) return [];
    const agent = team.agents.find((a) => a.agentId === selectedFile.agentId);
    return (agent?.skills ?? []).map((skill) => ({ id: skill, name: skill }));
  }, [selectedFile, team.agents]);
  const skillDetail = useMemo(() => {
    if (selectedFile?.kind !== 'skill-item' || !selectedFile.skillId) return null;
    return allSkills.find((skill) => skill.id === selectedFile.skillId) ?? null;
  }, [selectedFile, allSkills]);

  const isEditable = selectedFile?.kind === 'agent-file';
  const isEditing = editingContent !== null;

  return (
    <div className="flex h-full flex-col">
      <header className="titlebar-drag flex items-center border-b border-[var(--border)] px-5 h-[var(--density-toolbar-height)] flex-shrink-0">
        <div className="titlebar-no-drag flex items-center gap-2 min-w-0">
          <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label={t('common.back')}>
            <ArrowLeft size={16} />
          </Button>
          <span className="type-body text-[var(--text-muted)]">{team.name}</span>
        </div>
      </header>

      <div className="border-b border-[var(--border)] px-6 py-5 space-y-3 flex-shrink-0">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-4 min-w-0">
            <span className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-2xl bg-[var(--bg-tertiary)]">
              <span className="emoji-lg">{team.emoji}</span>
            </span>
            <div className="min-w-0 space-y-1.5">
              <h2 className="type-page-title text-[var(--text-primary)]">{team.name}</h2>
              {team.version && (
                <span className="type-meta flex items-center gap-1 text-[var(--text-muted)]">
                  <Package size={12} />v{team.version}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <Button variant="ghost" size="sm" onClick={onEdit}>
              <Pencil size={14} />
              {t('teams.editTeam')}
            </Button>
            <Button size="sm" variant="soft" onClick={onStartChat}>
              <MessageSquare size={14} />
              {t('teams.startChat')}
            </Button>
          </div>
        </div>
        {team.description && <p className="type-body text-[var(--text-secondary)]">{team.description}</p>}

        {/*
          一起讨论：成员按**职位顺序**依次发言，后面的人能看到前面所有人的原话
          （顺序与拼装见 `lib/team-roundtable.ts`）。
          ⚠️ 代价提示刻意**不报份数**：报"约消耗 4 份积分"会变成账单。这里只说
             "几位助手一起做、可能稍高一些"，既诚实又不吓人（用户 2026-09-20 拍板）。
        */}
        <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-3">
          <div className="flex items-center gap-2">
            <Users size={14} className="text-[var(--accent)]" />
            <span className="type-body font-semibold text-[var(--text-primary)]">{t('teams.roundtable.title')}</span>
          </div>
          <p className="type-support mt-1 text-[var(--text-muted)]">
            {memberCount < 2
              ? t('teams.roundtable.needTwo')
              : roundtableRunning
                ? t('teams.roundtable.running', { done: 0, total: memberCount })
                : t('teams.roundtable.hint', { count: memberCount })}
          </p>
          <div className="mt-2 flex items-end gap-2">
            <textarea
              value={roundtableQuestion}
              onChange={(e) => setRoundtableQuestion(e.target.value.slice(0, 500))}
              placeholder={t('teams.roundtable.empty')}
              rows={2}
              maxLength={500}
              disabled={roundtableRunning}
              data-field="roundtable-question"
              className="type-body min-h-0 flex-1 resize-none rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] disabled:opacity-60"
            />
            {roundtableRunning ? (
              // 跑的时候必须给出口 —— 一轮要花好几份积分，用户想停就得能停。
              <Button size="sm" variant="outline" onClick={onStopRoundtable} data-action="stop-roundtable">
                <Square size={14} />
                {t('teams.roundtable.stop')}
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={!canStartRoundtable}
                onClick={() => onStartRoundtable(roundtableQuestion.trim())}
                data-action="start-roundtable"
              >
                <Sparkles size={14} />
                {t('teams.roundtable.start')}
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        <TeamFileTree
          agents={agentNodes}
          skills={allSkills}
          selectedFileId={selectedFile?.id ?? null}
          onSelectFile={handleSelectFile}
          width={fileTreeWidth}
          isDragging={isFileTreeDragging}
          onResizeStart={handleFileTreeResizeStart}
        />

        <div className="flex flex-1 flex-col min-w-0">
          {selectedFile && (
            <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2 flex-shrink-0">
              <span className="type-support text-[var(--text-muted)] truncate">{selectedFile.label}</span>
              {isEditable && !isEditing && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setEditingContent(fileContent ?? '')}
                  aria-label={t('common.edit')}
                >
                  <Pencil size={13} />
                </Button>
              )}
              {isEditing && (
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setEditingContent(null)}
                    disabled={saving}
                    aria-label={t('common.cancel')}
                  >
                    <X size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={handleSave}
                    disabled={saving}
                    aria-label={t('common.save')}
                  >
                    {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                  </Button>
                </div>
              )}
            </div>
          )}

          <ScrollArea className="flex-1 p-4">
            {loadingContent && (
              <div className="flex items-center gap-2 text-[var(--text-muted)]">
                <Loader2 size={14} className="animate-spin" />
                <span className="type-body">{t('common.loading')}</span>
              </div>
            )}

            {!loadingContent &&
              (selectedFile?.kind === 'team-md' || (selectedFile?.kind === 'agent-file' && !isEditing)) &&
              fileContent !== null && (
                <pre className="type-mono-data whitespace-pre-wrap break-words text-[var(--text-secondary)]">
                  {fileContent || (selectedFile.kind === 'team-md' ? t('teams.detail.noDescription') : '')}
                </pre>
              )}

            {!loadingContent && selectedFile?.kind === 'agent-file' && isEditing && (
              <textarea
                value={editingContent ?? ''}
                onChange={(e) => setEditingContent(e.target.value)}
                className={cn(
                  'type-mono-data h-full w-full resize-none overflow-auto whitespace-pre-wrap break-words',
                  'rounded-lg border border-[var(--border)] bg-[var(--bg-tertiary)] p-3',
                  'text-[var(--text-secondary)] outline-none ring-accent-focus',
                )}
              />
            )}

            {!loadingContent && selectedFile?.kind === 'agent-skills' && (
              <div className="space-y-2">
                {agentSkills.length === 0 ? (
                  <p className="type-body text-[var(--text-muted)]">{t('teams.detail.noSkills')}</p>
                ) : (
                  agentSkills.map((skill) => (
                    <div key={skill.id} className="flex items-start gap-3 rounded-lg border border-[var(--border)] p-3">
                      <Puzzle size={14} className="mt-0.5 flex-shrink-0 text-[var(--text-muted)]" />
                      <div className="min-w-0">
                        <p className="type-support font-medium text-[var(--text-primary)]">{skill.name || skill.id}</p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {!loadingContent && selectedFile?.kind === 'skill-item' && skillDetail && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Puzzle size={16} className="text-[var(--text-muted)]" />
                  <h3 className="type-section-title text-[var(--text-primary)]">
                    {skillDetail.name || skillDetail.id}
                  </h3>
                </div>
                <div className="type-meta text-[var(--text-muted)]">
                  ID: <span className="type-code-inline">{skillDetail.id}</span>
                </div>
              </div>
            )}

            {!loadingContent && !selectedFile && (
              <p className="type-body text-[var(--text-muted)]">{t('teams.detail.selectFile')}</p>
            )}
          </ScrollArea>
        </div>
      </div>
      <ConfirmDialog
        open={!!discardTarget}
        variant="danger"
        title={t('teams.detail.unsavedTitle')}
        description={t('teams.detail.unsavedDesc')}
        onConfirm={confirmDiscard}
        onCancel={cancelDiscard}
      />
    </div>
  );
}
