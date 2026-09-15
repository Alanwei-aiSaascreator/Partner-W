import { useState, useEffect, useCallback, useRef } from 'react';
import { CreditCard, LogOut, Loader2, RefreshCw, User as UserIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  CUSTOM_RECHARGE_MAX_CENTS,
  CUSTOM_RECHARGE_MIN_CENTS,
  parseRechargeYuanToCents,
  type CommercialAccountOverview,
} from '@clawwork/shared';
import type { RechargeOrderHandle, RechargeSku } from '../../../../preload/clawwork';
import { toast } from '@/lib/toast';
import { formatCredits } from '@/lib/utils';
import { deriveQuotaDisplay } from '@/lib/quota-display';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
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

/**
 * ⚠️ 这个是**真实货币**（充值赠送金额，单位分），不是额度。
 *    额度用 `formatCredits`（微积分 → 积分）。两者差 1e6 倍，
 *    混用不会报错、只会静默错账 —— 所以刻意保留两个不同的函数名。
 */
function formatCents(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}

function QuotaBar({ used, total }: { used: number; total: number }) {
  const { t } = useTranslation();
  const { remaining, remainingPercent } = deriveQuotaDisplay(total, used);
  return (
    <div className="space-y-2">
      <div
        className="h-2 overflow-hidden rounded-full bg-[var(--bg-hover)]"
        role="progressbar"
        aria-label={t('dashboard.remainingCredits')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(remainingPercent)}
      >
        <div
          className="h-full rounded-full bg-[var(--accent)] transition-all duration-300"
          style={{ width: `${remainingPercent}%` }}
        />
      </div>
      <div className="flex items-center justify-between type-support text-[var(--text-muted)]">
        <span className="type-mono-data text-[var(--text-secondary)]">
          {t('dashboard.remainingCredits')} {formatCredits(remaining)} / {formatCredits(total)} {t('usage.creditsUnit')}
        </span>
        <span>{remainingPercent.toFixed(1)}%</span>
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
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundAgreed, setRefundAgreed] = useState(false);
  const [skus, setSkus] = useState<RechargeSku[]>([]);
  const [selectedSku, setSelectedSku] = useState('');
  // 自定义金额与档位互斥：选中一个就清掉另一个，避免「选了 ¥100 档又填了 ¥5」
  // 这种说不清以哪个为准的状态。
  const [useCustomAmount, setUseCustomAmount] = useState(false);
  const [customAmount, setCustomAmount] = useState('');
  const [placing, setPlacing] = useState(false);
  const [pending, setPending] = useState<RechargeOrderHandle | null>(null);
  const [placeError, setPlaceError] = useState('');
  const watchRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCountRef = useRef(0);
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

  const stopWatch = useCallback(() => {
    if (watchRef.current) {
      clearInterval(watchRef.current);
      watchRef.current = null;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void window.clawwork.commercialRechargeSkus().then((res) => {
      if (!mountedRef.current || !res.ok || !res.result?.length) return;
      setSkus(res.result);
      setSelectedSku((current) => current || res.result![0].sku);
    });
  }, []);

  useEffect(() => () => stopWatch(), [stopWatch]);

  useEffect(() => {
    if (!pending) return;
    const onFocus = () => {
      void window.clawwork.commercialRechargeOrder(pending.orderNo).then((res) => {
        if (mountedRef.current && res.result?.status === 'paid') {
          stopWatch();
          setPending(null);
          toast.success(t('account.rechargePaid'));
          void load();
        }
      });
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load, pending, stopWatch, t]);

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

  const closeRefund = useCallback(() => {
    setRefundOpen(false);
    setRefundAgreed(false);
    setPlaceError('');
    setUseCustomAmount(false);
    setCustomAmount('');
  }, []);

  const startWatch = useCallback(
    (orderNo: string) => {
      stopWatch();
      pollCountRef.current = 0;

      const poll = async () => {
        pollCountRef.current += 1;
        const res = await window.clawwork.commercialRechargeOrder(orderNo);
        if (!mountedRef.current) {
          stopWatch();
          return;
        }
        const state = res.result?.status;
        if (state === 'paid') {
          stopWatch();
          setPending(null);
          toast.success(t('account.rechargePaid'));
          void load();
          return;
        }
        if (state === 'cancelled' || state === 'failed') {
          stopWatch();
          setPending(null);
          toast.warning(t('account.rechargeClosed'));
          return;
        }
        if (pollCountRef.current >= 40) stopWatch();
      };

      void poll();
      watchRef.current = setInterval(() => void poll(), 3000);
    },
    [load, stopWatch, t],
  );

  const confirmRecharge = useCallback(async () => {
    if (placing) return;

    // null 表示「填的东西不能当金额用」——空、非数字、超范围都算。
    // 服务端还会再校验一次，这里只是省掉一次无谓的往返。
    const customCents = useCustomAmount ? parseRechargeYuanToCents(customAmount) : null;
    if (useCustomAmount ? customCents === null : !selectedSku) return;

    setPlacing(true);
    setPlaceError('');
    try {
      const res =
        customCents !== null
          ? await window.clawwork.commercialRechargeCreateCustom(customCents)
          : await window.clawwork.commercialRechargeCreate(selectedSku);
      if (!res.ok || !res.result) {
        setPlaceError(t('account.rechargeFailed'));
        return;
      }
      setRefundOpen(false);
      setRefundAgreed(false);
      setUseCustomAmount(false);
      setCustomAmount('');
      setPending(res.result);
      window.open(res.result.payUrl, '_blank');
      startWatch(res.result.orderNo);
    } catch {
      setPlaceError(t('account.rechargeFailed'));
    } finally {
      setPlacing(false);
    }
  }, [customAmount, placing, selectedSku, startWatch, t, useCustomAmount]);

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
  const quotaTotal = license?.tokenQuotaMicros ?? 0;
  const quotaUsed = license?.tokenUsedMicros ?? 0;
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
            <img src={account.avatar} alt="" className="h-12 w-12 flex-shrink-0 rounded-full object-cover" />
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
            <span className="type-body text-[var(--text-muted)]">{t('account.quotaPending')}</span>
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
            <span className="type-mono-data select-all text-[var(--text-secondary)]">{device.shortFingerprint}</span>
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
          onClick={() => setRefundOpen(true)}
          disabled={Boolean(pending)}
          className="gap-1.5"
        >
          {pending ? <Loader2 size={14} className="animate-spin" /> : <CreditCard size={14} />}
          {pending ? t('account.rechargeWaiting') : t('account.recharge')}
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

      <Dialog open={refundOpen} onOpenChange={(next) => !next && closeRefund()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('account.refundTitle')}</DialogTitle>
            <DialogDescription>{t('account.refundNotice')}</DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-2">
            <p className="type-label text-[var(--text-primary)]">{t('account.rechargePickAmount')}</p>
            {skus.length === 0 ? (
              <LoadingBlock label={t('common.loading')} />
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {skus.map((item) => {
                  const active = item.sku === selectedSku;
                  return (
                    <button
                      key={item.sku}
                      type="button"
                      onClick={() => {
                        setSelectedSku(item.sku);
                        setUseCustomAmount(false);
                      }}
                      className={
                        'rounded-lg border px-3 py-2.5 text-left transition-colors ' +
                        (active
                          ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                          : 'border-[var(--border)] hover:border-[var(--border-accent)]')
                      }
                    >
                      <span className="type-label block text-[var(--text-primary)]">{item.label}</span>
                      {item.bonusCents > 0 && (
                        <span className="type-support block text-[var(--accent)]">
                          {t('account.rechargeBonus', { amount: formatCents(item.bonusCents) })}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* 自定义金额。与档位互斥：选了它，档位选择就失效。 */}
            <button
              type="button"
              onClick={() => {
                setUseCustomAmount(true);
                setSelectedSku('');
              }}
              className={
                'w-full rounded-lg border px-3 py-2.5 text-left transition-colors ' +
                (useCustomAmount
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                  : 'border-[var(--border)] hover:border-[var(--border-accent)]')
              }
            >
              <span className="type-label block text-[var(--text-primary)]">{t('account.rechargeCustom')}</span>
            </button>

            {useCustomAmount && (
              <div className="space-y-1">
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 type-body text-[var(--text-muted)]">
                    ¥
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    autoFocus
                    value={customAmount}
                    disabled={placing}
                    onChange={(e) => setCustomAmount(e.target.value.replace(/[^\d.]/g, '').slice(0, 7))}
                    placeholder={t('account.rechargeCustomPlaceholder', {
                      min: CUSTOM_RECHARGE_MIN_CENTS / 100,
                      max: CUSTOM_RECHARGE_MAX_CENTS / 100,
                    })}
                    aria-label={t('account.rechargeCustom')}
                    className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-input)] py-2.5 pl-8 pr-4 type-body text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition-colors focus:border-[var(--accent)] disabled:opacity-60"
                  />
                </div>
                {customAmount.trim() !== '' && parseRechargeYuanToCents(customAmount) === null && (
                  <p className="type-support text-[var(--danger)]" role="alert">
                    {t('account.rechargeCustomInvalid', {
                      min: CUSTOM_RECHARGE_MIN_CENTS / 100,
                      max: CUSTOM_RECHARGE_MAX_CENTS / 100,
                    })}
                  </p>
                )}
              </div>
            )}
          </div>

          <label className="mt-4 flex items-start gap-2 type-support text-[var(--text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              checked={refundAgreed}
              onChange={(e) => setRefundAgreed(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
            />
            {t('account.refundAgree')}
          </label>

          {placeError && (
            <p className="mt-2 type-support text-[var(--danger)]" role="alert">
              {placeError}
            </p>
          )}

          <DialogFooter className="mt-6">
            <Button variant="outline" onClick={closeRefund} disabled={placing}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={
                !refundAgreed ||
                placing ||
                (useCustomAmount ? parseRechargeYuanToCents(customAmount) === null : !selectedSku)
              }
              onClick={() => void confirmRecharge()}
            >
              {placing ? <Loader2 size={14} className="animate-spin" /> : <CreditCard size={14} />}
              {t('account.rechargeConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
