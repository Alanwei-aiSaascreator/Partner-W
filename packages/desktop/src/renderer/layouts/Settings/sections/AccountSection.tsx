import { useState, useEffect, useCallback, useRef } from 'react';
import { CreditCard, LogOut, Loader2, Pencil, RefreshCw, User as UserIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CUSTOM_RECHARGE_MAX_CENTS, CUSTOM_RECHARGE_MIN_CENTS, parseRechargeYuanToCents } from '@clawwork/shared';
import type { RechargeOrderHandle, RechargeSku } from '../../../../preload/clawwork';
import { toast } from '@/lib/toast';
import { formatCreditsPrecise } from '@/lib/utils';
import { deriveQuotaDisplay } from '@/lib/quota-display';
// C-A（BUG-081，2026-10-15）充值显示：金额（分）→ 到账积分文案。
// 纯函数与单测见 lib/recharge-display.ts；只服务下方充值对话框区域。
import { customRechargeCreditsText, rechargeCreditsText } from '@/lib/recharge-display';
import { useCommercialStore } from '@/stores/commercialStore';
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
import type { OnboardingProfile } from '@/lib/user-onboarding';

/**
 * C2（R1 终审 §9，2026-10-10）：主进程分类出的充值失败码 → 可行动的本地化文案。
 * 不在表里的码回落到通用 `rechargeFailed`（"请重试"）。
 */
const RECHARGE_ERROR_KEYS: Record<string, string> = {
  recharge_no_license_target: 'account.rechargeCardRequired',
  recharge_card_unavailable: 'account.rechargeCardUnavailable',
  client_upgrade_required: 'account.rechargeClientUpgrade',
};

/*
 * ⚠️ 本页**不再持有自己的余额快照**（BUG-082 / C-B §3）。
 *
 * 原先这里有一份 `cw:account-overview` 的本地缓存 + 自己的 `overview/status`
 * 状态，于是同一时刻屏幕上有两个真源：账户页一个、顶栏/总览（commercialStore）另一个。
 * 两边各自刷新、各自失败，能同时显示两个不同的余额 —— 而且账户页那份**永不自愈**，
 * 只能靠"重新进这一页/重开"。
 *
 * 现在统一读 `commercialStore` 的账号快照（含它的缓存与 offline 兜底）：账户页、
 * 聊天顶栏、总览看的是**同一份**数据、同一个 `fetchedAt`；刷新调度与代次守卫也只剩一套。
 */

function maskPhone(phone: string | null): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  // Supabase stores E.164 without the plus, e.g. 8618338607148.
  const local = digits.startsWith('86') && digits.length === 13 ? digits.slice(2) : digits;
  if (local.length !== 11) return phone;
  return `${local.slice(0, 3)}****${local.slice(-4)}`;
}

/**
 * ⚠️ 这个是**真实货币**（充值支付金额，单位分），不是额度。
 *    额度用 `formatCredits`（微积分 → 积分）。两者差 1e6 倍，
 *    混用不会报错、只会静默错账 —— 所以刻意保留两个不同的函数名。
 *    （2026-10-15 C-A/BUG-081：原注释写作「充值赠送金额」；赠送展示已按用户
 *      口径下线，本函数现在只服务支付金额。到账积分换算见 lib/recharge-display。）
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
          {t('dashboard.remainingCredits')} {formatCreditsPrecise(remaining)} / {formatCreditsPrecise(total)}{' '}
          {t('usage.creditsUnit')}
        </span>
        <span>{remainingPercent.toFixed(1)}%</span>
      </div>
    </div>
  );
}

interface AccountSectionProps {
  onboardingProfile?: OnboardingProfile | null;
  onEditProfile?: () => void;
}

export default function AccountSection({ onboardingProfile = null, onEditProfile }: AccountSectionProps) {
  const { t } = useTranslation();
  // 账号快照的唯一真源（BUG-082）：与顶栏/总览共用同一份。
  const overview = useCommercialStore((s) => s.overview);
  const status = useCommercialStore((s) => s.status);
  const load = useCommercialStore((s) => s.load);
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

  const stopWatch = useCallback(() => {
    if (watchRef.current) {
      clearInterval(watchRef.current);
      watchRef.current = null;
    }
  }, []);

  useEffect(() => {
    // 每次打开账户页都重读一次（与旧行为一致）：打开是一次**有意图**的动作，
    // 拉到最新比省一次请求重要；失败时 store 会保留最近一次成功的值。
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
    // ⚠️ 闸门用的那份缓存（cw:commercial-overview）必须一起清：它现在**能授权发送**
    //    （读失败时用旧快照放行），留着就会让下一个登录的账号用到上一个人的许可证。
    //    内存里的状态会被下面的 reload 抹掉，但 localStorage 不会。
    useCommercialStore.getState().clearCache();
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
        // C2（R1 终审 §9，2026-10-10）：把主进程分类出来的 errorCode 翻成**可行动的
        // 本地化入口文案** —— 不再统一吞成 rechargeFailed（"请重试"对"没有卡/卡不可用/
        // 版本过旧"都是误导：重试一百次也没用）。
        setPlaceError(t(RECHARGE_ERROR_KEYS[res.errorCode ?? ''] ?? 'account.rechargeFailed'));
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

  if (!overview && status !== 'offline') {
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

  // ── C-A（BUG-081，2026-10-15）充值区派生值 START ─────────────────────────
  // 「支付金额 → 到账积分」展示口径（纯函数与单测见 lib/recharge-display.ts）。
  // 只服务下方充值对话框（确认区摘要 + 每档/自定义的到账行）；
  // 余额读取与刷新逻辑不在此边界内（C-B 域）。
  const rechargeCustomCents = useCustomAmount ? parseRechargeYuanToCents(customAmount) : null;
  const rechargeSkuCents = useCustomAmount
    ? null
    : (skus.find((item) => item.sku === selectedSku)?.amountCents ?? null);
  const rechargeConfirmCents = useCustomAmount ? rechargeCustomCents : rechargeSkuCents;
  const rechargeConfirmAmountText = rechargeConfirmCents === null ? null : formatCents(rechargeConfirmCents);
  const rechargeConfirmCreditsText = rechargeCreditsText(rechargeConfirmCents);
  // ── C-A 充值区派生值 END ─────────────────────────────────────────────────

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

      {onboardingProfile && (
        <SettingGroup title={t('account.workProfile')}>
          <div className="space-y-3 px-5 py-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="type-label text-[var(--text-primary)]">
                  {onboardingProfile.role === 'custom' && onboardingProfile.customRole
                    ? onboardingProfile.customRole
                    : t(`onboarding.roles.${onboardingProfile.role ?? 'custom'}.title`)}
                </p>
                <p className="type-support mt-1 text-[var(--text-muted)]">
                  {onboardingProfile.useCases
                    .filter((useCase) => useCase !== 'general')
                    .map((useCase) => t(`onboarding.useCases.${useCase}.title`))
                    .join(' · ') || t('account.workProfileUnset')}
                </p>
              </div>
              {onEditProfile && (
                <Button
                  data-account-purpose-edit
                  variant="outline"
                  size="sm"
                  className="flex-shrink-0 gap-1.5"
                  onClick={onEditProfile}
                >
                  <Pencil size={13} />
                  {t('account.editWorkProfile')}
                </Button>
              )}
            </div>
            {onboardingProfile.customGoal && (
              <p className="type-body rounded-lg bg-[var(--bg-tertiary)] px-3 py-2.5 text-[var(--text-secondary)]">
                {onboardingProfile.customGoal}
              </p>
            )}
          </div>
        </SettingGroup>
      )}

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

      {/* 余额的**可信度**（BUG-082 / C-B §3）：显示的值永远是"最近一次成功读到的"
          那份（读失败不归零、不清空），这里如实给出它的时间；读不到时上面那条
          `account.offline` 通知同时亮着。 */}
      <p className="type-support text-[var(--text-muted)]" data-account-synced-at>
        {t('account.updatedAt', { time: new Date(overview.fetchedAt).toLocaleTimeString() })}
      </p>

      {/* ══ C-A（BUG-081，2026-10-15）充值对话区域改动边界 START ══
          C-A 只修改本对话框内部（比例说明 / 档位到账行 / 自定义预估 / 确认区摘要）。
          余额区、刷新 hook、commercialStore 属 C-B 域，不在此边界内。 */}
      <Dialog open={refundOpen} onOpenChange={(next) => !next && closeRefund()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('account.refundTitle')}</DialogTitle>
            <DialogDescription>{t('account.refundNotice')}</DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-2">
            <p className="type-label text-[var(--text-primary)]">{t('account.rechargePickAmount')}</p>
            {/* 固定比例说明。与 lib/recharge-display.ts 的换算同源（1 分 = 1 积分），
                不随所选档位变化 —— BUG-081 的起点就是"金额和积分对不上"。 */}
            <p className="type-support text-[var(--text-muted)]">{t('account.rechargeRate')}</p>
            {skus.length === 0 ? (
              <LoadingBlock label={t('common.loading')} />
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {skus.map((item) => {
                  const active = item.sku === selectedSku;
                  // 到账积分 = 支付金额（分）× 1；脏数据返回 null 时只留 label。
                  const creditsText = rechargeCreditsText(item.amountCents);
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
                      {/* 支付金额 + 到账积分。用户口径（2026-10-15）：赠送（bonusCents）
                          先不上屏，只按 1元=100积分 展示 —— 所以这里不渲染赠送行。 */}
                      {creditsText !== null && (
                        <span className="type-support mt-0.5 block text-[var(--text-secondary)]">
                          {t('account.rechargeSummary', {
                            amount: formatCents(item.amountCents),
                            credits: creditsText,
                          })}
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
                {/* 合法金额的到账预估（复用 parseRechargeYuanToCents 的同一判据）。 */}
                {rechargeCustomCents !== null && (
                  <p className="type-support text-[var(--text-secondary)]">
                    {t('account.rechargeCustomEstimate', {
                      amount: formatCents(rechargeCustomCents),
                      credits: customRechargeCreditsText(customAmount),
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

          {/* 确认付款区摘要：与档位卡复用同一「支付金额/到账积分」文案。
              合法金额（档位或自定义）才出现；非法/未选时不渲染。 */}
          {rechargeConfirmAmountText !== null && rechargeConfirmCreditsText !== null && (
            <p data-recharge-summary className="mt-4 type-label text-[var(--text-primary)]">
              {t('account.rechargeSummary', {
                amount: rechargeConfirmAmountText,
                credits: rechargeConfirmCreditsText,
              })}
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
      {/* ══ C-A（BUG-081）充值对话区域改动边界 END ══ */}
    </div>
  );
}
