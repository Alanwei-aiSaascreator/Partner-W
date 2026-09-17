import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageCircleQuestion } from 'lucide-react';
import {
  autofillSelection,
  resolveQuestionSelection,
  type PendingQuestion,
  type QuestionSelection,
} from '@clawwork/core';
import { Button } from '@/components/ui/button';
import { useQuestionStore } from '../../stores/questionStore';
import { useTaskStore } from '../../stores/taskStore';
import { useMessageStore } from '../../stores/messageStore';

/**
 * 网关结构化提问（`ask_user`）的作答面板，**挂在输入框上方**。
 *
 * 为什么必须存在：这条链路以前完全没实现，问题一直挂起，而网关会把该会话里用户
 * 发的任何消息当作「答案」吃掉 —— 2026-09-17 的「Word 任务锁死」就是这么来的。
 * 版式对齐 openclaw 官方 Control UI 的 docked question panel（`docs/tools/ask-user.md`）。
 *
 * 三条硬约束（见 docs/status/2026-09-15-demo-bug-fix-log.md）：
 * 1. **全部必答项选完才允许提交** —— 少一个是网关直接拒，且会连带把用户消息吞掉；
 * 2. 界面**只出现 `header`**，绝不暴露 `doc_type` 这类内部字段名；
 * 3. 提交失败 / 超时后卡片**保持可见**，用户能重答或跳过。
 */
export default function QuestionPanel(): ReactElement | null {
  const { t } = useTranslation();
  const activeTaskId = useTaskStore((s) => s.activeTaskId);
  const pending = useQuestionStore((s) => s.pendingQuestions);
  const resolveQuestion = useQuestionStore((s) => s.resolveQuestion);
  const cancelQuestion = useQuestionStore((s) => s.cancelQuestion);
  const messages = useMessageStore((s) => (activeTaskId ? s.messagesByTask[activeTaskId] : undefined));

  // 网关按 session 只允许一个问题挂起（`session already has a pending agent input request`），
  // 所以同一任务最多出现一张卡片；不属于当前任务的一律不在这里显示。
  const request = useMemo(
    () => pending.find((question) => question.taskId !== null && question.taskId === activeTaskId) ?? null,
    [pending, activeTaskId],
  );

  const [optionPicks, setOptionPicks] = useState<Record<string, string[]>>({});
  const [customPicks, setCustomPicks] = useState<Record<string, string>>({});
  const [hint, setHint] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const requestId = request?.id ?? null;
  useEffect(() => {
    setOptionPicks({});
    setCustomPicks({});
    setHint(null);
  }, [requestId]);

  // 用户在原任务里已经说清楚的选项（例如文案里带了「教案（教学设计）」）就替他选上，
  // 免得明明说过还要再点一遍。只在**唯一命中**时才预选，见 autofillSelection。
  useEffect(() => {
    if (!request) return;
    const lastUserText = [...(messages ?? [])].reverse().find((message) => message.role === 'user')?.content ?? '';
    const seeded = autofillSelection(request.questions, lastUserText);
    if (Object.keys(seeded).length === 0) return;
    setOptionPicks((prev) => ({ ...seeded, ...prev }));
  }, [request, messages]);

  if (!request) return null;

  const selection: QuestionSelection = {};
  for (const question of request.questions) {
    const custom = (customPicks[question.questionId] ?? '').trim();
    selection[question.questionId] = custom ? [custom] : (optionPicks[question.questionId] ?? []);
  }

  const missing = resolveQuestionSelection(request.questions, selection);

  const pickOption = (question: PendingQuestion, label: string): void => {
    setHint(null);
    setCustomPicks((prev) => ({ ...prev, [question.questionId]: '' }));
    setOptionPicks((prev) => {
      const current = prev[question.questionId] ?? [];
      if (question.multiSelect) {
        const next = current.includes(label) ? current.filter((item) => item !== label) : [...current, label];
        return { ...prev, [question.questionId]: next };
      }
      return { ...prev, [question.questionId]: [label] };
    });
  };

  const typeCustom = (question: PendingQuestion, value: string): void => {
    setHint(null);
    setOptionPicks((prev) => ({ ...prev, [question.questionId]: [] }));
    setCustomPicks((prev) => ({ ...prev, [question.questionId]: value }));
  };

  const handleSubmit = async (): Promise<void> => {
    if (!missing.ok) {
      // 拦在本地并**指名道姓**告诉用户还差哪一题；交给网关只会回一句带字段名的英文
      setHint(
        missing.reason === 'single-select'
          ? t('question.singleSelectOnly', { header: missing.errorHeader ?? '' })
          : t('question.answerAllRequired', { headers: missing.missing.join('、') }),
      );
      return;
    }
    setSubmitting(true);
    const ok = await resolveQuestion(request.id, selection);
    setSubmitting(false);
    if (!ok) setHint(t('question.resolveFailed'));
  };

  return (
    <div
      className="mx-5 mb-2 rounded-xl border p-3.5"
      style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-secondary)' }}
      data-testid="question-panel"
    >
      <div className="mb-2.5 flex items-start gap-2">
        <MessageCircleQuestion className="mt-0.5 h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
        <div>
          <p className="type-label" style={{ color: 'var(--text-primary)' }}>
            {t('question.title')}
          </p>
          <p className="type-support" style={{ color: 'var(--text-secondary)' }}>
            {t('question.subtitle')}
          </p>
        </div>
      </div>

      <div className="space-y-3">
        {request.questions.map((question) => {
          const picked = optionPicks[question.questionId] ?? [];
          const unanswered =
            !missing.ok && (missing.missing.includes(question.header) || missing.errorHeader === question.header);
          return (
            <div key={question.questionId} className="space-y-1.5">
              <p className="type-label" style={{ color: unanswered ? 'var(--danger)' : 'var(--text-primary)' }}>
                {question.header}
              </p>
              <p className="type-support" style={{ color: 'var(--text-secondary)' }}>
                {question.question}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {question.options.map((option) => {
                  const selected = picked.includes(option.label);
                  return (
                    <button
                      key={option.label}
                      type="button"
                      aria-pressed={selected}
                      title={option.description}
                      onClick={() => pickOption(question, option.label)}
                      className="rounded-lg border px-2.5 py-1.5 text-left transition-colors"
                      style={{
                        borderColor: selected ? 'var(--accent)' : 'var(--border-subtle)',
                        background: selected ? 'var(--accent-subtle, var(--bg-elevated))' : 'var(--bg-primary)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      <span className="type-support">{option.label}</span>
                      {option.description && (
                        <span className="type-meta block" style={{ color: 'var(--text-muted)' }}>
                          {option.description}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              {question.isOther && (
                <input
                  type="text"
                  value={customPicks[question.questionId] ?? ''}
                  onChange={(event) => typeCustom(question, event.target.value)}
                  placeholder={t('question.otherPlaceholder')}
                  className="type-support h-8 w-full rounded-lg border px-2.5 outline-none"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    background: 'var(--bg-primary)',
                    color: 'var(--text-primary)',
                  }}
                />
              )}
            </div>
          );
        })}
      </div>

      {hint && (
        <p className="type-support mt-2.5" style={{ color: 'var(--danger)' }} data-testid="question-hint">
          {hint}
        </p>
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <Button variant="outline" onClick={() => cancelQuestion(request.id)}>
          {t('question.skip')}
        </Button>
        <Button onClick={handleSubmit} disabled={submitting}>
          {t('question.submit')}
        </Button>
      </div>
    </div>
  );
}
