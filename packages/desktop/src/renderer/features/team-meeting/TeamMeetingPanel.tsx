import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessagesSquare, Square, ArrowUpRight } from 'lucide-react';
import { isTeamMeetingActive } from '@clawwork/shared';
import type { TeamMeetingRecord } from '@clawwork/shared';
import { Button } from '@/components/ui/button';
import { useTaskStore } from '@/platform';
import type { MeetingMember } from './plan';
import { vendorsDistinct } from './vendor';

interface Props {
  members: MeetingMember[];
  models: string[];
  records: TeamMeetingRecord[];
  connected: boolean;
  errors?: Record<string, string>;
  onStart: (question: string, members: MeetingMember[]) => Promise<void>;
  onStop: (id: string) => void;
  onOpenTask: (taskId: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export default function TeamMeetingPanel(props: Props) {
  const { t } = useTranslation();
  const [question, setQuestion] = useState('');
  const [selected, setSelected] = useState(() => props.members.slice(0, 3).map((member) => member.agentId));
  const [models, setModels] = useState<Record<string, string>>({});
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tasks = useTaskStore((state) => state.tasks);
  const active = props.records.some((record) => isTeamMeetingActive(record));
  // 审核（第 2 位）没手选模型时自动换到另一家厂商 —— 审核必须换厂商，别让用户踩坑。
  const selectedMembers = (() => {
    const chosen: MeetingMember[] = [];
    for (const id of selected) {
      const member = props.members.find((candidate) => candidate.agentId === id);
      if (!member) continue;
      let model = models[id] ?? member.model;
      if (chosen.length === 1 && !models[id] && !vendorsDistinct(chosen[0].model, model)) {
        const alternative = props.models.find((candidate) => vendorsDistinct(chosen[0].model, candidate));
        if (alternative) model = alternative;
      }
      chosen.push({ ...member, model });
    }
    return chosen;
  })();
  const selectionChanged = selectedMembers.length !== selected.length;
  const unavailable = !props.connected || props.members.length < 2;
  const canStart =
    !unavailable &&
    !selectionChanged &&
    !active &&
    !starting &&
    question.trim().length > 0 &&
    [2, 3].includes(selectedMembers.length) &&
    selectedMembers.every((member) => props.models.includes(member.model));
  const start = async () => {
    if (!canStart) return;
    setStarting(true);
    setError(null);
    try {
      await props.onStart(question.trim(), selectedMembers);
      setQuestion('');
      props.onDirtyChange?.(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('meeting.failed'));
    } finally {
      setStarting(false);
    }
  };
  return (
    <section className="space-y-4" aria-label={t('meeting.title')}>
      {/* 描述由对话框头 TeamMeetingEntry 的 DialogDescription 渲染（aria-describedby），此处不得重复 */}
      <p className="type-meta text-[var(--text-muted)]">{t('meeting.costWarning')}</p>
      {unavailable && (
        <p role="status" className="type-support text-[var(--text-muted)]">
          {t('meeting.unavailable')}
        </p>
      )}
      {selectionChanged && (
        <div role="status" className="type-support">
          <p>{t('meeting.selectionChanged')}</p>
          <Button
            variant="outline"
            disabled={starting || active}
            onClick={() => setSelected(props.members.slice(0, 3).map((member) => member.agentId))}
          >
            {t('meeting.reselect')}
          </Button>
        </div>
      )}
      <fieldset disabled={starting || active} className="space-y-2">
        <legend className="type-support mb-2 text-[var(--text-primary)]">{t('meeting.members')}</legend>
        {props.members.map((member) => (
          <div
            key={member.agentId}
            className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--border)] p-2"
          >
            <label className="flex min-w-0 flex-1 items-center gap-2 type-support">
              <input
                type="checkbox"
                checked={selected.includes(member.agentId)}
                disabled={!selected.includes(member.agentId) && selected.length >= 3}
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? [...selected, member.agentId]
                      : selected.filter((id) => id !== member.agentId),
                  )
                }
              />
              <span className="truncate">{member.name}</span>
            </label>
            <select
              aria-label={t('meeting.memberModel', { name: member.name })}
              className="max-w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-1 type-meta"
              value={models[member.agentId] ?? member.model}
              onChange={(event) => setModels({ ...models, [member.agentId]: event.target.value })}
            >
              <option value="">{t('meeting.chooseModel')}</option>
              {[...new Set([...props.models, models[member.agentId] ?? member.model].filter(Boolean))].map((model) => (
                <option key={model} value={model} disabled={!props.models.includes(model)}>
                  {model}
                  {!props.models.includes(model) ? ` (${t('meeting.modelUnavailable')})` : ''}
                </option>
              ))}
            </select>
          </div>
        ))}
        <label className="block type-support text-[var(--text-primary)]">
          {t('meeting.question')}
          <textarea
            value={question}
            onChange={(event) => {
              setQuestion(event.target.value);
              props.onDirtyChange?.(event.target.value.trim().length > 0);
            }}
            rows={3}
            className="mt-2 w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-3 outline-none ring-accent-focus"
          />
        </label>
      </fieldset>
      {error && (
        <p role="alert" className="type-support text-[var(--text-primary)]">
          {error}
        </p>
      )}
      <Button disabled={!canStart} onClick={() => void start()}>
        <MessagesSquare size={15} />
        {t(starting ? 'meeting.starting' : 'meeting.start')}
      </Button>
      <div className="space-y-3" aria-live="polite">
        {props.records.map((record) => (
          <article key={record.id} className="rounded-xl border border-[var(--border)] p-3 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="type-support font-medium break-words">{record.question}</h3>
                <p className="type-meta text-[var(--text-muted)]">{t(`meeting.status.${record.status}`)}</p>
              </div>
              {(['draft', 'running', 'stopping'].includes(record.status) ||
                ((record.status === 'interrupted' || record.status === 'stopped') &&
                  (record.abortStatus === 'unconfirmed' || record.abortStatus === 'requested'))) && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={record.status === 'stopping'}
                  onClick={() => props.onStop(record.id)}
                >
                  <Square size={12} />
                  {t('meeting.stop')}
                </Button>
              )}
            </div>
            <ol className="grid gap-2 sm:grid-cols-3">
              {record.turns.map((turn) => (
                <li key={turn.id} className="min-w-0">
                  <button
                    className="w-full rounded-lg border border-[var(--border)] p-2 text-left hover:bg-[var(--bg-hover)]"
                    disabled={record.missingTaskIds?.includes(turn.taskId)}
                    onClick={() => props.onOpenTask(turn.taskId)}
                  >
                    <span className="type-meta flex items-center justify-between gap-1">
                      {t(`meeting.stage.${turn.stage}`)}
                      <ArrowUpRight size={12} />
                    </span>
                    <span className="type-support block truncate">{turn.agentName}</span>
                    {(() => {
                      const task = tasks.find((row) => row.id === turn.taskId);
                      if (!task?.model) return null;
                      return (
                        <span className="type-meta text-[var(--text-muted)] block truncate">
                          {t('meeting.turnUsage', {
                            model: task.model,
                            input: task.inputTokens ?? 0,
                            output: task.outputTokens ?? 0,
                          })}
                        </span>
                      );
                    })()}
                    <span className="type-meta text-[var(--text-muted)]">{t(`meeting.turn.${turn.status}`)}</span>
                  </button>
                  {turn.failure && <p className="type-meta break-words mt-1">{turn.failure}</p>}
                </li>
              ))}
            </ol>
            {record.abortStatus && <p className="type-meta">{t(`meeting.abort.${record.abortStatus}`)}</p>}
            {props.errors?.[record.id] && (
              <p role="alert" className="type-support break-words">
                {props.errors[record.id]}
              </p>
            )}
            {['interrupted', 'stopped', 'failed'].includes(record.status) && (
              <p className="type-meta text-[var(--text-muted)]">{t('meeting.noAutoResume')}</p>
            )}
            <p className="type-meta text-[var(--text-muted)]">{t('meeting.artifactsHint')}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
