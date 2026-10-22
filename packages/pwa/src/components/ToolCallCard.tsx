import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolCall } from '@clawwork/shared';
import { Wrench, CheckCircle, Loader, AlertCircle, Clock, ChevronDown, ChevronRight } from 'lucide-react';

interface ToolCallCardProps {
  /** 定稿投影后可能出现第三态 `unreported`（未收到结果），见 ToolCallsGroup。 */
  toolCall: Omit<ToolCall, 'status'> & { status: ToolCall['status'] | 'unreported' };
}

const RESULT_TRUNCATE_LIMIT = 500;

function getStatusIcon(status: ToolCall['status'] | 'unreported') {
  switch (status) {
    case 'done':
      return CheckCircle;
    case 'error':
      return AlertCircle;
    case 'running':
      return Loader;
    // ⭐ V2「调用处理中」（2026-10-13 step 2）：tool/start、item/running —— 转圈
    // （与 running 同视觉；`animate-spin` 判据见下方 className）。
    case 'dispatched':
      return Loader;
    // ⭐ V1「声明态」（2026-10-13）：模型声明、无执行证据 —— 静态 Loader
    // （`animate-spin` 只挂在 running/dispatched 上 ⇒ 声明不转圈）。
    case 'declared':
      return Loader;
    // ⭐ A2「等待批准」：**不转圈** —— 转圈说的是"在动"，而这条恰恰是"没动，在等人"。
    case 'awaitingApproval':
      return Clock;
    // 第三态「未收到结果」（对齐桌面端）：定稿后还没收场 —— 中性提醒，不转圈、不算失败。
    case 'unreported':
      return Clock;
  }
}

function getStatusColor(status: ToolCall['status'] | 'unreported'): string {
  switch (status) {
    case 'done':
      return 'var(--accent)';
    case 'error':
      return 'var(--danger)';
    case 'running':
    case 'dispatched':
    case 'declared':
    case 'awaitingApproval':
    case 'unreported':
      return 'var(--text-muted)';
  }
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const StatusIcon = getStatusIcon(toolCall.status);
  const statusColor = getStatusColor(toolCall.status);

  return (
    <div className="rounded-xl" style={{ backgroundColor: 'var(--bg-secondary)' }}>
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-label={`${toolCall.name} - ${toolCall.status}`}
        className="flex w-full items-center gap-2 px-3 text-left"
        style={{ minHeight: 44 }}
      >
        <Wrench size={14} style={{ color: 'var(--text-muted)' }} aria-hidden="true" />
        <span className="type-label flex-1 truncate" style={{ color: 'var(--text-secondary)' }}>
          {toolCall.name}
        </span>
        <StatusIcon
          size={14}
          style={{ color: statusColor }}
          className={toolCall.status === 'running' || toolCall.status === 'dispatched' ? 'animate-spin' : ''}
          aria-hidden="true"
        />
        {expanded ? (
          <ChevronDown size={14} style={{ color: 'var(--text-muted)' }} aria-hidden="true" />
        ) : (
          <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} aria-hidden="true" />
        )}
      </button>
      {expanded && (
        <div className="px-3 py-2">
          {toolCall.args && (
            <pre className="type-code-inline overflow-x-auto" style={{ color: 'var(--text-muted)' }}>
              {JSON.stringify(toolCall.args, null, 2)}
            </pre>
          )}
          {toolCall.result && (
            <pre className="type-code-inline mt-1 overflow-x-auto" style={{ color: 'var(--text-secondary)' }}>
              {toolCall.result.length > RESULT_TRUNCATE_LIMIT
                ? toolCall.result.slice(0, RESULT_TRUNCATE_LIMIT) + '\u2026'
                : toolCall.result}
            </pre>
          )}
          {!toolCall.args && !toolCall.result && (
            <span className="type-support" style={{ color: 'var(--text-muted)' }}>
              {t('tools.emptyDetails')}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
