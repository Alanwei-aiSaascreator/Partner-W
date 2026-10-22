import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldAlert } from 'lucide-react';
import { useApprovalStore } from '../stores/approvalStore';

/**
 * 手机版执行授权弹层（对齐桌面端 ApprovalDialog）。
 *
 * 挂在 DrawerLayout 顶层：exec 审批可能发生在任意页面（不止对话），
 * 且**不依赖 activeTask**——审批到达时哪怕用户停在别处也必须能批。
 */
export function ApprovalDialog() {
  const { t } = useTranslation();
  const pendingApprovals = useApprovalStore((s) => s.pendingApprovals);
  const resolveApproval = useApprovalStore((s) => s.resolveApproval);
  const current = pendingApprovals[0];
  const [denying, setDenying] = useState(false);

  // 审批过期前自动收起（store 侧也有 expireTimers，这里是保险）
  const [remaining, setRemaining] = useState(0);
  const expiresAtMs = current?.expiresAtMs ?? 0;

  useEffect(() => {
    if (!current) return;
    const tick = () => setRemaining(Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [current, expiresAtMs]);

  const pct = useMemo(() => Math.min(100, (remaining / 120) * 100), [remaining]);
  const color = remaining > 60 ? 'var(--accent)' : remaining > 20 ? 'var(--warning)' : 'var(--danger)';

  if (!current) return null;

  const { id, request } = current;
  const risk =
    request.security === 'full'
      ? { label: t('approval.riskHigh'), color: 'var(--danger)', bg: 'color-mix(in srgb, var(--danger) 12%, transparent)' }
      : { label: t('approval.riskMedium'), color: 'var(--text-secondary)', bg: 'var(--bg-tertiary)' };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      style={{ backgroundColor: 'color-mix(in srgb, #000 45%, transparent)' }}
      role="dialog"
      aria-modal="true"
      aria-label={t('approval.title')}
    >
      <div
        className="safe-area-bottom w-full max-w-md rounded-t-2xl border-t border-x px-4 pb-4 pt-3"
        style={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border)', maxHeight: '82%', overflowY: 'auto' }}
      >
        <div className="mx-auto mb-2 h-1 w-10 rounded-full" style={{ backgroundColor: 'var(--border)' }} aria-hidden="true" />

        <div className="mb-2.5 flex items-start gap-2">
          <ShieldAlert size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--warning)' }} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="type-label" style={{ color: 'var(--text-primary)' }}>
              {t('approval.title')}
            </p>
            <p className="type-support" style={{ color: 'var(--text-secondary)' }}>
              {t('approval.newRequest')}
            </p>
          </div>
          <span className="type-support shrink-0 rounded-md px-1.5 py-0.5" style={{ color: risk.color, backgroundColor: risk.bg }}>
            {risk.label}
          </span>
        </div>

        <p className="type-meta mb-1.5" style={{ color: 'var(--text-secondary)' }}>
          {t('approval.command')}
        </p>
        <pre
          className="type-code-block overflow-x-auto rounded-lg px-3 py-2.5"
          style={{
            backgroundColor: 'var(--bg-primary)',
            color: 'var(--text-primary)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {request.command}
        </pre>

        {(request.cwd || request.host) && (
          <div className="type-support mt-2 flex flex-wrap gap-x-4 gap-y-1" style={{ color: 'var(--text-secondary)' }}>
            {request.cwd && (
              <span>
                {t('approval.cwd')}: <span className="type-code-inline">{request.cwd}</span>
              </span>
            )}
            {request.host && (
              <span>
                {t('approval.host')}: <span className="type-code-inline">{request.host}</span>
              </span>
            )}
          </div>
        )}

        <div className="mt-2.5 space-y-1">
          <span className="type-support" style={{ color: 'var(--text-secondary)' }}>
            {t('approval.expiresIn', { seconds: remaining })}
          </span>
          <div className="h-1 w-full overflow-hidden rounded-full" style={{ backgroundColor: 'var(--bg-primary)' }}>
            <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color }} />
          </div>
        </div>

        {pendingApprovals.length > 1 && (
          <p className="type-support mt-2" style={{ color: 'var(--text-secondary)' }}>
            {t('approval.queueMore', { count: pendingApprovals.length - 1 })}
          </p>
        )}

        <div className="mt-3 grid grid-cols-3 gap-2">
          <button
            type="button"
            disabled={denying}
            onClick={() => {
              setDenying(true);
              void resolveApproval(id, 'deny');
            }}
            className="rounded-xl px-3 py-2 type-label"
            style={{ backgroundColor: 'color-mix(in srgb, var(--danger) 14%, transparent)', color: 'var(--danger)', minHeight: 44 }}
          >
            {t('approval.deny')}
          </button>
          <button
            type="button"
            onClick={() => void resolveApproval(id, 'allow-always')}
            className="rounded-xl px-3 py-2 type-label"
            style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)', minHeight: 44 }}
          >
            {t('approval.allowAlways')}
          </button>
          <button
            type="button"
            onClick={() => void resolveApproval(id, 'allow-once')}
            className="rounded-xl px-3 py-2 type-label"
            style={{ backgroundColor: 'var(--accent)', color: 'var(--accent-foreground)', minHeight: 44 }}
          >
            {t('approval.allowOnce')}
          </button>
        </div>
      </div>
    </div>
  );
}
