import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolCall } from '@clawwork/shared';
import { AlertCircle, CheckCircle, ChevronDown, ChevronRight, Loader } from 'lucide-react';
import { ToolCallCard } from './ToolCallCard';

interface ToolCallsGroupProps {
  toolCalls: ToolCall[];
  /**
   * 定稿消息：running/declared/awaitingApproval/dispatched 投影为「未收到结果」。
   *
   * ⚠️ 桌面端 `ToolCallSummary` 的 `settled` 同语义：历史/定稿里的工具调用不会再有
   * 帧来收场，还停在 running/declared 就是「没收到结果」——继续转圈是在编「还在执行」。
   * 手机端同步来的电脑端历史**全部**是定稿消息（2026-10-21 真机：电脑端工具早结束、
   * 手机端永远「正在执行」，就是这个投影缺了）。流式（StreamingMessage）不传 ⇒ false。
   */
  settled?: boolean;
}

type GroupStatus = 'running' | 'error' | 'unreported' | 'done';

type DisplayStatus = ToolCall['status'] | 'unreported';
type DisplayToolCall = Omit<ToolCall, 'status'> & { status: DisplayStatus };

/** 还没结束的状态 —— 桌面端 `isUnfinished` 同桶（running/dispatched/declared/awaitingApproval）。 */
const UNFINISHED = new Set<ToolCall['status']>(['running', 'dispatched', 'declared', 'awaitingApproval']);

/**
 * 展示副本（对齐桌面端 `markUnreportedCalls`）：已定稿的消息里还停在未结束状态的调用
 * ⇒ `unreported`（未收到结果）。**不改写原始数据**。`result` 只在空白时补一句产品文案。
 */
function projectSettled(
  toolCalls: readonly ToolCall[],
  settled: boolean,
  fallbackResult: string,
): DisplayToolCall[] {
  if (!settled) return toolCalls.map((call) => ({ ...call }));
  return toolCalls.map((call): DisplayToolCall => {
    if (!UNFINISHED.has(call.status)) return call;
    return {
      ...call,
      status: 'unreported',
      ...(call.result?.trim() ? {} : { result: fallbackResult }),
    };
  });
}

/**
 * 工具调用组（对齐桌面端 `ToolCallSummary` 的形态与判据，
 * 见 desktop/renderer/components/ToolCallSummary.tsx）：
 *
 * - **运行期强制展开**：未定稿还有在跑 / 已声明未执行的调用时不给"收起"——否则要点两次
 *   才看得到"到底在干什么"（桌面端 2026-10-08 对话可视化改造的结论）。
 * - **定稿后压缩成一个小框**：一行摘要（状态图标 + 数量 + 失败/未收到结果数）＋ 右侧箭头，
 *   点一下展开看逐个 `ToolCallCard`；多于一跳时框后露两层"纸叠"，提示压着一串调用。
 * - 失败数常驻在收起态的表头上（红字）——折叠不许把失败藏起来。
 */
export function ToolCallsGroup({ toolCalls, settled = false }: ToolCallsGroupProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const shown = useMemo(
    () => projectSettled(toolCalls, settled, t('tools.unreported')),
    [toolCalls, settled, t],
  );

  const stats = useMemo(() => {
    let running = 0;
    let error = 0;
    let unreported = 0;
    let done = 0;
    let latestActive: DisplayToolCall | null = null;
    for (const call of shown) {
      if (call.status === 'running' || call.status === 'dispatched') {
        running += 1;
        latestActive = call;
      } else if (call.status === 'declared' || call.status === 'awaitingApproval') {
        // 未定稿时声明/等批准也算"没结束"（桌面端同桶）；定稿后它们已被投影成 unreported。
        running += 1;
      } else if (call.status === 'error') {
        error += 1;
      } else if (call.status === 'unreported') {
        unreported += 1;
      } else {
        done += 1;
      }
    }
    return { running, error, unreported, done, latestActive, total: shown.length };
  }, [shown]);

  if (shown.length === 0) return null;

  // 桌面端判据：error 优先（失败不许藏），其次 unreported（如实说一句），其次运行中。
  const status: GroupStatus =
    stats.error > 0 ? 'error' : stats.unreported > 0 ? 'unreported' : stats.running > 0 ? 'running' : 'done';
  // 运行期强制展开；定稿后 unreported/失败也强制可见（但不再转圈、不再说"执行中"）。
  const forcedOpen = stats.running > 0 || stats.error > 0 || stats.unreported > 0;
  const open = forcedOpen || expanded;

  const StatusIcon = status === 'running' ? Loader : status === 'error' ? AlertCircle : CheckCircle;
  const statusColor =
    status === 'error' ? 'var(--danger)' : status === 'unreported' ? 'var(--text-muted)' : 'var(--accent)';

  const latestTitle = stats.latestActive?.title?.trim() || stats.latestActive?.name || '';
  const label = stats.running > 0
    ? t('tools.groupRunning', { title: latestTitle || `${stats.running}` })
    : stats.unreported > 0
      ? t('tools.groupUnreported', { count: stats.unreported })
      : t('tools.groupSummary', { count: stats.total });

  return (
    <div className="relative mt-2">
      {/* 折叠态的"纸叠"：多于一跳才画，纯视觉提示，不接事件 */}
      {!open && stats.total > 1 && (
        <>
          <div
            aria-hidden="true"
            className="absolute inset-x-2 -bottom-1 h-3 rounded-b-xl"
            style={{ backgroundColor: 'var(--bg-secondary)', opacity: 0.45 }}
          />
          <div
            aria-hidden="true"
            className="absolute inset-x-4 -bottom-2 h-3 rounded-b-xl"
            style={{ backgroundColor: 'var(--bg-secondary)', opacity: 0.25 }}
          />
        </>
      )}

      <div className="relative overflow-hidden rounded-xl" style={{ backgroundColor: 'var(--bg-secondary)' }}>
        <button
          type="button"
          onClick={() => {
            if (forcedOpen) return;
            setExpanded((prev) => !prev);
          }}
          disabled={forcedOpen}
          aria-expanded={open}
          aria-label={`${label}${stats.error > 0 ? `，${stats.error} 个失败` : ''}`}
          className="flex w-full items-center gap-2 px-3 text-left"
          style={{ minHeight: 40, cursor: forcedOpen ? 'default' : 'pointer' }}
        >
          <StatusIcon
            size={13}
            className={status === 'running' ? 'animate-spin' : undefined}
            style={{ color: statusColor, flex: '0 0 auto' }}
            aria-hidden="true"
          />
          <span className="type-support flex-1 truncate" style={{ color: 'var(--text-secondary)' }}>
            {label}
          </span>
          {stats.error > 0 && (
            <span
              className="type-support shrink-0 rounded-md px-1.5 py-0.5"
              style={{
                color: 'var(--danger)',
                backgroundColor: 'color-mix(in srgb, var(--danger) 12%, transparent)',
              }}
            >
              {t('tools.groupFailed', { count: stats.error })}
            </span>
          )}
          {!forcedOpen &&
            (expanded ? (
              <ChevronDown size={14} style={{ color: 'var(--text-muted)' }} aria-hidden="true" />
            ) : (
              <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} aria-hidden="true" />
            ))}
        </button>

        {open && (
          <div className="space-y-1 px-2 pb-2">
            {shown.map((toolCall) => (
              <ToolCallCard key={toolCall.id} toolCall={toolCall} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
