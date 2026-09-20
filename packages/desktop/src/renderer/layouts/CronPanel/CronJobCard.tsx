import { useTranslation } from 'react-i18next';
import { Play, Clock, Pencil, Trash2, Loader2, AlertTriangle } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { TFunction } from 'i18next';
import type { CronJob } from '@clawwork/shared';
import { cronPayloadPreview } from './payload.js';
import { systemJobDescription, systemJobLabel } from '@/lib/cron-job-label';

interface CronJobCardProps {
  job: CronJob;
  /** 把 agent id 翻成中文名 —— 系统任务「技能库巡检（{{agent}}）」要用。 */
  agentLabelOf?: (agentId: string) => string | undefined;
  onToggleEnabled: (job: CronJob) => void;
  onEdit: (job: CronJob) => void;
  onDelete: (job: CronJob) => void;
  onRunNow: (job: CronJob) => void;
  onShowHistory: (job: CronJob) => void;
}

/**
 * ⚠️⚠️ **这一段原来把英文写死在纯函数里**（`in 21m` / `every 30m` / `interval` / `isolated`），
 *      中文界面上整片露英文（2026-09-19 用户报「汉化没做好」）。
 *
 * 修法：纯函数只算**判别式**，文案在下面用**带引号的字面量键**取。
 * ⚠️ **不要改成 `cron.rel.${unit}` 那种拼串** —— `check:i18n` 只认带引号的字面量键。
 *    （见 `scripts/lib/i18n-usage.mjs` 的头注释：模板键会让整组键被当成"未使用"从而**静默漏掉**）。
 */
type RelUnit = 'ltMinute' | 'minute' | 'hour' | 'day';

function relativeUnit(ms: number, now = Date.now()): { future: boolean; unit: RelUnit; n: number } {
  const diff = ms - now;
  const absDiff = Math.abs(diff);
  const future = diff > 0;
  if (absDiff < 60_000) return { future, unit: 'ltMinute', n: 0 };
  if (absDiff < 3600_000) return { future, unit: 'minute', n: Math.round(absDiff / 60_000) };
  if (absDiff < 86400_000) return { future, unit: 'hour', n: Math.round(absDiff / 3600_000) };
  return { future, unit: 'day', n: Math.round(absDiff / 86400_000) };
}

type EveryUnit = 'second' | 'minute' | 'hour' | 'day';

function everyUnit(ms: number): { unit: EveryUnit; n: number } {
  if (ms >= 86400_000) return { unit: 'day', n: Math.round(ms / 86400_000) };
  if (ms >= 3600_000) return { unit: 'hour', n: Math.round(ms / 3600_000) };
  if (ms >= 60_000) return { unit: 'minute', n: Math.round(ms / 60_000) };
  return { unit: 'second', n: Math.round(ms / 1000) };
}

/** 计划的**表达式部分**（不含角标文案 —— 那要靠 `t` 取）。 */
function scheduleExpr(schedule: CronJob['schedule']): { text: string } | { every: { unit: EveryUnit; n: number } } {
  switch (schedule.kind) {
    case 'cron':
      return { text: schedule.tz ? `${schedule.expr} (${schedule.tz})` : schedule.expr };
    case 'every':
      return { every: everyUnit(schedule.everyMs) };
    case 'at':
      return { text: new Date(schedule.at).toLocaleString() };
  }
}

function payloadPreview(payload: CronJob['payload']): string {
  // 取文本的逻辑在 ./payload.ts —— 那里的注释记着它为什么要容错
  //（网关会发我们的类型里没有的 kind，旧实现直接 undefined.length 把面板打白屏）。
  const raw = cronPayloadPreview(payload);
  return raw.length > 60 ? `${raw.slice(0, 57)}...` : raw;
}

// ── 以下是"判别式 → 文案"的取词层 ─────────────────────────────────
// ⚠️ 全部用**字面量键**。拼串会让 `check:i18n` 静默漏掉整组键（见文件上方注释）。

function relativeText(t: TFunction, ms: number): string {
  const { future, unit, n } = relativeUnit(ms);
  if (unit === 'ltMinute') return future ? t('cron.rel.inLessThanMinute') : t('cron.rel.lessThanMinuteAgo');
  if (unit === 'minute') return future ? t('cron.rel.inMinutes', { n }) : t('cron.rel.minutesAgo', { n });
  if (unit === 'hour') return future ? t('cron.rel.inHours', { n }) : t('cron.rel.hoursAgo', { n });
  return future ? t('cron.rel.inDays', { n }) : t('cron.rel.daysAgo', { n });
}

function everyText(t: TFunction, every: { unit: EveryUnit; n: number }): string {
  switch (every.unit) {
    case 'day':
      return t('cron.every.days', { n: every.n });
    case 'hour':
      return t('cron.every.hours', { n: every.n });
    case 'minute':
      return t('cron.every.minutes', { n: every.n });
    case 'second':
      return t('cron.every.seconds', { n: every.n });
  }
}

function scheduleBadgeText(t: TFunction, kind: CronJob['schedule']['kind']): string {
  switch (kind) {
    case 'cron':
      return t('cron.scheduleKind.cron');
    case 'every':
      return t('cron.scheduleKind.every');
    case 'at':
      return t('cron.scheduleKind.at');
  }
}

/** ⚠️ 认不出的 target **原样显示**（与 `payload.ts` 同一条纪律：显示原文比空白有用）。 */
function targetText(t: TFunction, target: CronJob['sessionTarget']): string {
  switch (target) {
    case 'main':
      return t('cron.target.main');
    case 'isolated':
      return t('cron.target.isolated');
    case 'current':
      return t('cron.target.current');
    default:
      return String(target);
  }
}

/** ⚠️ 同上：认不出的 kind 原样显示（网关会发我们类型里没有的 kind）。 */
function payloadKindText(t: TFunction, kind: string): string {
  switch (kind) {
    case 'agentTurn':
      return t('cron.payloadKind.agentTurn');
    case 'heartbeat':
      return t('cron.payloadKind.heartbeat');
    case 'systemEvent':
      return t('cron.payloadKind.systemEvent');
    default:
      return kind;
  }
}

const STATUS_DOT: Record<string, string> = {
  ok: 'bg-[var(--accent)]',
  error: 'bg-[var(--danger)]',
  skipped: 'bg-[var(--text-muted)]',
};

export default function CronJobCard({
  job,
  agentLabelOf,
  onToggleEnabled,
  onEdit,
  onDelete,
  onRunNow,
  onShowHistory,
}: CronJobCardProps) {
  const { t } = useTranslation();
  // 网关自动建的那几个任务在界面上是英文名（`heartbeat-main` 之类）——
  // 认得出就换中文，认不出（包括用户自己改过名的）**原样显示**。
  const displayName = systemJobLabel(job.name, t, agentLabelOf) ?? job.name;
  const systemJobDesc = systemJobDescription(job.name, job.payload, t);
  const expr = scheduleExpr(job.schedule);
  const schedText = 'every' in expr ? everyText(t, expr.every) : expr.text;
  const schedBadge = scheduleBadgeText(t, job.schedule.kind);
  const preview = payloadPreview(job.payload);
  const targetLabel = targetText(t, job.sessionTarget);
  const { state } = job;

  return (
    <TooltipProvider delayDuration={300}>
      <div
        className={cn(
          'rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3 transition-opacity',
          !job.enabled && 'opacity-50',
        )}
      >
        <div className="flex items-start gap-3">
          <div className="pt-0.5">
            <Switch
              checked={job.enabled}
              onCheckedChange={() => onToggleEnabled(job)}
              aria-label={t('cron.toggleEnabled')}
            />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="type-label truncate text-[var(--text-primary)]">{displayName}</span>
              <div className="flex items-center gap-2 shrink-0">
                {state.runningAtMs && <Loader2 size={14} className="animate-spin text-[var(--accent)]" />}
                {state.lastRunStatus && (
                  <span
                    className={cn(
                      'inline-block h-2 w-2 rounded-full',
                      STATUS_DOT[state.lastRunStatus] ?? 'bg-[var(--text-muted)]',
                    )}
                  />
                )}
                {!state.lastRunStatus && !state.runningAtMs && (
                  <span className="inline-block h-2 w-2 rounded-full bg-[var(--text-muted)]" />
                )}
                {state.lastRunAtMs && (
                  <span className="type-support text-[var(--text-muted)]">{relativeText(t, state.lastRunAtMs)}</span>
                )}
              </div>
            </div>

            <div className="flex items-center gap-1.5 mt-1">
              <span className="type-badge rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[var(--text-muted)]">
                {schedBadge}
              </span>
              <span className="type-mono-data truncate text-[var(--text-secondary)]">{schedText}</span>
            </div>

            {/* 系统任务的载荷是人看不懂的：`heartbeat` 没有正文，
                另外两个一个是内部标记串（`__openclaw_..._dream__`）、
                一个是整段英文指令。认得出是系统任务时改说**它干什么**，
                原文仍然留在编辑对话框里（那里是数据，一个字都不动）。 */}
            <div className="type-support mt-1 truncate text-[var(--text-secondary)]">
              {systemJobDesc ? (
                systemJobDesc
              ) : (
                <>
                  <span className="text-[var(--text-muted)]">{payloadKindText(t, job.payload.kind)}:</span> {preview}
                </>
              )}
            </div>

            <div className="flex items-center gap-2 mt-1 type-support text-[var(--text-muted)]">
              <span>{targetLabel}</span>
              {state.nextRunAtMs && (
                <>
                  <span>&middot;</span>
                  <span>
                    {t('cron.nextRun')}: {relativeText(t, state.nextRunAtMs)}
                  </span>
                </>
              )}
            </div>

            {(state.consecutiveErrors ?? 0) > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="type-support mt-1.5 inline-flex items-center gap-1 text-[var(--danger)]">
                    <AlertTriangle size={12} />
                    <span>
                      {state.consecutiveErrors} {t('cron.consecutiveErrors')}
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs break-words">
                  {state.lastError ?? t('cron.unknownError')}
                </TooltipContent>
              </Tooltip>
            )}

            <div className="flex items-center gap-1 mt-2 border-t border-[var(--border)] pt-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={() => onRunNow(job)} aria-label={t('cron.runNow')}>
                    <Play size={14} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('cron.runNow')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onShowHistory(job)}
                    aria-label={t('cron.history')}
                  >
                    <Clock size={14} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('cron.history')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={() => onEdit(job)} aria-label={t('common.edit')}>
                    <Pencil size={14} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('cron.edit')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-[var(--danger)] hover:text-[var(--danger)]"
                    onClick={() => onDelete(job)}
                  >
                    <Trash2 size={14} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('cron.delete')}</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
