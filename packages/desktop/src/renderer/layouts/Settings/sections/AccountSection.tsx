import { useState, useEffect, useCallback, useRef } from 'react';
import {
  CreditCard,
  LogOut,
  Laptop,
  Loader2,
  RefreshCw,
  KeyRound,
  User as UserIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CommercialAccountOverview } from '@clawwork/shared';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import SettingGroup from '@/components/semantic/SettingGroup';
import SettingRow from '@/components/semantic/SettingRow';
import StatusTag from '@/components/semantic/StatusTag';
import InlineNotice from '@/components/semantic/InlineNotice';
import LoadingBlock from '@/components/semantic/LoadingBlock';

type PanelStatus = 'loading' | 'ready' | 'offline';

/** Snapshot cache so the panel can render something useful while offline. */
const CACHE_KEY = 'cw:account-overview';

interface CachedSnapshot {
  overview: CommercialAccountOverview;
  savedAt: string;
}

function readCache(): CommercialAccountOverview | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedSnapshot;
    return parsed?.overview ?? null;
  } catch {
    return null;
  }
}

function writeCache(overview: CommercialAccountOverview): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ overview, savedAt: new Date().toISOString() }));
  } catch {
    // Cache is best-effort; a full quota must not break the panel.
  }
}

function maskPhone(phone: string | null): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  // Supabase stores E.164 without the plus, e.g. 8618338607148.
  const local = digits.startsWith('86') && digits.length === 13 ? digits.slice(2) : digits;
  if (local.length !== 11) return phone;
  return `${local.slice(0, 3)}****${local.slice(-4)}`;
}

function formatCents(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}

/** Presents a "used / total" bar; callers must ensure total > 0. */
function QuotaBar({ used, total }: { used: number; total: number }) {
  const percent = Math.min(100, Math.max(0, (used / total) * 100));
  return (
    <div className="space-y-2">
      <div className="h-2 overflow-hidden rounded-full bg-[var(--bg-hover)]">
        <div
          className="h-full rounded-full bg-[var(--accent)] transition-all duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="flex items-center justify-between type-support text-[var(--text-muted)]">
        <span className="type-mono-data text-[var(--text-secondary)]">
          {formatCents(used)} / {formatCents(total)}
        </span>
        <span>{percent.toFixed(1)}%</span>
      </div>
    </div>
  );
}

export default function AccountSection() {
  const { t } = useTranslation();
  const [overview, setOverview] = useState<CommercialAccountOverview | null>(null);
  const [status, setStatus] = useState<PanelStatus>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setStatus('loading');
    setErrorMessage('');
    try {
      const res = await window.clawwork.commercialAccountOverview();
      if (!mountedRef.current) return;

      if (!res.ok || !res.result) {
        // Fall back to the last good snapshot rather than an empty panel, but
        // say so plainly — never let cached numbers read as live ones.
        const cached = readCache();
        if (cached) {
          setOverview(cached);
          setStatus('offline');
        } else {
          setStatus('offline');
        }
        setErrorMessage(res.error ?? '');
        return;
      }

      setOverview(res.result);
      setStatus('ready');
      writeCache(res.result);
    } catch (err) {
      if (!mountedRef.current) return;
      const cached = readCache();
      if (cached) setOverview(cached);
      setStatus('offline');
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSignOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await window.clawwork.commercialSignOut();
    } catch {
      // Sign-out clears local state first; a network failure must not trap the user.
    }
    try {
      localStorage.removeItem(CACHE_KEY);
    } catch {
      // ignore
    }
    // A reload is the only way to guarantee no store retains a stale session:
    // the auth gate re-runs and routes back to Login.
    window.location.reload();
  }, []);

  if (status === 'loading' && !overview) {
    return (
      <div>
        <h3 className="type-section-title mb-4 text-[var(--text-primary)]">{t('settings.account')}</h3>
        <SettingGroup>
          <LoadingBlock label={t('common.loading')} />
        </SettingGroup>
      </div>
    );
  }

  if (!overview) {
    return (
      <div>
        <h3 className="type-section-title mb-4 text-[var(--text-primary)]">{t('settings.account')}</h3>
        <SettingGroup>
          <div className="px-5 py-4">
            <InlineNotice
              tone="error"
              action={
                <Button variant="outline" size="sm" onClick={() => void load()} className="gap-1.5">
                  <RefreshCw size={14} />
                  {t('common.retry')}
                </Button>
              }
            >
              {t('account.offline')}
            </InlineNotice>
          </div>
        </SettingGroup>
      </div>
    );
  }

  const { account, org, license, device } = overview;
  const displayName = account.nickname || maskPhone(account.phone) || t('settings.account');
  const quotaTotal = license?.tokenQuotaCents ?? 0;
  const quotaUsed = license?.tokenUsedCents ?? 0;
  const hasQuota = quotaTotal > 0;

  return (
    <div className="space-y-5">
      <h3 className="type-section-title text-[var(--text-primary)]">{t('settings.account')}</h3>

      {status === 'offline' && (
        <InlineNotice
          tone="warning"
          action={
            <Button variant="outline" size="sm" onClick={() => void load()} className="gap-1.5">
              <RefreshCw size={14} />
              {t('common.retry')}
            </Button>
          }
        >
          {t('account.offline')}
        </InlineNotice>
      )}

      <SettingGroup>
        <div className="flex items-center gap-4 px-5 py-4">
          {account.avatar ? (
            <img
              src={account.avatar}
              alt=""
              className="h-12 w-12 flex-shrink-0 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
              <UserIcon size={22} />
            </div>
          )}
          <div className="min-w-0">
            <div className="type-label truncate text-[var(--text-primary)]">{displayName}</div>
            <div className="type-support mt-0.5 text-[var(--text-muted)]">
              {account.phone ? `+86 ${maskPhone(account.phone)}` : (account.email ?? '—')}
            </div>
            {org && (
              <div className="type-support mt-0.5 text-[var(--text-muted)]">
                {org.name} · {org.plan}
              </div>
            )}
          </div>
        </div>
      </SettingGroup>

      <SettingGroup title={t('account.tokenQuota')}>
        <div className="px-5 py-4">
          {hasQuota ? (
            <QuotaBar used={quotaUsed} total={quotaTotal} />
          ) : (
            <div className="flex items-center justify-between gap-3">
              <span className="type-body text-[var(--text-muted)]">{t('account.quotaPending')}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => toast(t('account.activateHint'))}
                className="gap-1.5"
              >
                <KeyRound size={14} />
                {t('account.activate')}
              </Button>
            </div>
          )}
        </div>

        {hasQuota && license && (
          <SettingRow label={t('account.plan')}>
            <span className="type-label text-[var(--text-secondary)]">{license.sku ?? '—'}</span>
          </SettingRow>
        )}
      </SettingGroup>

      <SettingGroup title={t('account.device')}>
        <SettingRow
          label={
            <span className="type-mono-data select-all text-[var(--text-secondary)]">
              {device.shortFingerprint}
            </span>
          }
        >
          <StatusTag tone={license?.activated ? 'success' : 'neutral'}>
            {license?.activated ? t('account.activated') : t('account.notActivated')}
          </StatusTag>
        </SettingRow>
      </SettingGroup>

      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => toast(t('account.rechargeHint'))}
          className="gap-1.5"
        >
          <CreditCard size={14} />
          {t('account.recharge')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void handleSignOut()}
          disabled={signingOut}
          className="gap-1.5"
        >
          {signingOut ? <Loader2 size={14} className="animate-spin" /> : <LogOut size={14} />}
          {t('account.signOut')}
        </Button>
      </div>

      {errorMessage && status === 'ready' && (
        <p className="type-support text-[var(--text-muted)]">
          {t('account.updatedAt', { time: new Date(overview.fetchedAt).toLocaleTimeString() })}
        </p>
      )}
    </div>
  );
}
