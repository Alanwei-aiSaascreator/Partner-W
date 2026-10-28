import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageCircleQuestion } from 'lucide-react';
import type { PendingQuestion } from '@clawwork/core';
import { useQuestionStore } from '../stores/questionStore';
import { useTaskStore } from '../stores/hooks';

/**
 * 手机版询问面板（对齐桌面端 QuestionPanel）。
 *
 * agent 调用 `ask_user` 时网关发 `question.requested`，这里把结构化问题渲染在
 * 输入框上方：选项点选 + 全部必答选完才能提交；提交失败卡片保持可见可重答。
 */
export function QuestionPanel() {
  const { t } = useTranslation();
  const activeTaskId = useTaskStore((s) => s.activeTaskId);
  const pending = useQuestionStore((s) => s.pendingQuestions);
  const resolveQuestion = useQuestionStore((s) => s.resolveQuestion);
  const cancelQuestion = useQuestionStore((s) => s.cancelQuestion);

  const request = useMemo(() => {
    // 优先挂到当前任务；⚠️ 配不上任务时**不能丢**——`question.requested` 只在那一刻来一次，
    // 丢掉就等于手机永远等不到回答（就是「#7 询问没同步」的现场）。退路：认不出任务的问题
    // 也照常显示（手机上只有一个操作用户，宁可多显示一条，不可静默丢弃）。
    const exact = pending.find((question) => question.taskId !== null && question.taskId === activeTaskId);
    if (exact) return exact;
    return pending.find((question) => question.taskId === null) ?? null;
  }, [pending, activeTaskId]);

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

  if (!request) return null;

  const selection: Record<string, string[]> = {};
  for (const question of request.questions) {
    const custom = (customPicks[question.questionId] ?? '').trim();
    selection[question.questionId] = custom ? [custom] : (optionPicks[question.questionId] ?? []);
  }

  const missing = (() => {
    const out: string[] = [];
    for (const question of request.questions) {
      const values = selection[question.questionId] ?? [];
      if (values.length === 0) out.push(question.header);
    }
    return out;
  })();

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

  const handleSubmit = async (): Promise<void> => {
    if (missing.length > 0) {
      setHint(t('question.answerAllRequired', { headers: missing.join('、') }));
      return;
    }
    setSubmitting(true);
    const ok = await resolveQuestion(request.id, selection);
    setSubmitting(false);
    if (!ok) setHint(t('question.resolveFailed'));
  };

  return (
    <div
      className="mx-3 mb-2 rounded-2xl border p-3"
      style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-secondary)' }}
    >
      <div className="mb-2.5 flex items-start gap-2">
        <MessageCircleQuestion size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--accent)' }} />
        <div className="min-w-0 flex-1">
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
          return (
            <div key={question.questionId}>
              <p className="type-label" style={{ color: 'var(--text-primary)' }}>
                {question.header}
              </p>
              <p className="type-support mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                {question.question}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {question.options.map((option) => {
                  const selected = picked.includes(option.label);
                  return (
                    <button
                      key={option.label}
                      onClick={() => pickOption(question, option.label)}
                      className="rounded-lg border px-2.5 py-1.5"
                      style={{
                        borderColor: selected ? 'var(--accent)' : 'var(--border-subtle)',
                        background: selected ? 'var(--accent-dim)' : 'var(--bg-primary)',
                        color: 'var(--text-primary)',
                        minHeight: 34,
                      }}
                    >
                      <span className="type-support">{option.label}</span>
                    </button>
                  );
                })}
              </div>
              {question.isOther && (
                <input
                  type="text"
                  value={customPicks[question.questionId] ?? ''}
                  onChange={(event) => {
                    setHint(null);
                    setOptionPicks((prev) => ({ ...prev, [question.questionId]: [] }));
                    setCustomPicks((prev) => ({ ...prev, [question.questionId]: event.target.value }));
                  }}
                  placeholder={t('question.otherPlaceholder')}
                  className="mt-1.5 w-full rounded-lg border px-2.5 py-1.5 type-support outline-none"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    background: 'var(--bg-primary)',
                    color: 'var(--text-primary)',
                    minHeight: 38,
                  }}
                />
              )}
            </div>
          );
        })}
      </div>

      {hint && (
        <p className="type-support mt-2" style={{ color: 'var(--danger)' }}>
          {hint}
        </p>
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <button
          onClick={() => cancelQuestion(request.id)}
          className="rounded-xl px-3 py-2 type-support"
          style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)', minHeight: 40 }}
        >
          {t('question.skip')}
        </button>
        <button
          onClick={() => void handleSubmit()}
          disabled={submitting}
          className="flex-1 rounded-xl py-2 type-label"
          style={{ backgroundColor: 'var(--accent)', color: 'var(--accent-foreground)', minHeight: 40 }}
        >
          {submitting ? t('question.submitting', { defaultValue: '提交中…' }) : t('question.submit')}
        </button>
      </div>
    </div>
  );
}
