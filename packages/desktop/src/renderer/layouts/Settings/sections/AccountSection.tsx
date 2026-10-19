import { useState, useEffect, useCallback, useRef } from 'react';
import { CreditCard, LogOut, Loader2, Pencil, RefreshCw, User as UserIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CUSTOM_RECHARGE_MAX_CENTS, CUSTOM_RECHARGE_MIN_CENTS, parseRechargeYuanToCents } from '@clawwork/shared';
import type { RechargeOrderHandle, RechargeSku } from '../../../../preload/clawwork';
import { toast } from '@/lib/toast';
import { formatCreditsPrecise } from '@/lib/utils';
import { deriveAvailableDisplay, readHeldView } from '@/lib/quota-display';
// C-A（BUG-081，2026-10-15）充值显示：金额（分）→ 到账积分文案。
// 纯函数与单测见 lib/recharge-display.ts；只服务下方充值对话框区域。
import { customRechargeCreditsText, rechargeCreditsText } from '@/lib/recharge-display';
import { useCommercialStore } from '@/stores/commercialStore';
import { useMessageStore } from '@/stores/messageStore';
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

/**
 * 一笔充值订单的**结局**（BUG-081 续，2026-10-15 A owner）。
 *
 * 原先只有三秒就消失的 toast，且 `cancelled` 与 `failed` 共用一句"订单已关闭" ——
 * 屏幕上无法区分"用户自己取消了"和"这笔支付失败了"，页面本身也不留痕。
 * 现在四种结局各有自己的键位，并以 `[data-recharge-status]` 常驻在充值按钮下方。
 *
 * ⚠️ 全部**复用既有键位**，不新增翻译：新增键位要等 Lead 合入九语言，
 *    在那之前 `t()` 会把裸键打到屏幕上 —— 宁可复用语义相近的既有文案。
 *    `waiting`→"等待支付"、`paid`→"支付成功，积分已到账"、
 *    `cancelled`→"订单已关闭"、`failed`→"这笔支付失败了，积分未到账"。
 *    （`account.rechargeOrderFailed` 已由 Lead 于 2026-10-16 补齐九语言键位；
 *      旧 `account.rechargeFailed` 语义偏"发起失败"，保留给其它调用点。）
 */
export type RechargeOutcome = 'idle' | 'waiting' | 'paid' | 'cancelled' | 'failed';

const RECHARGE_OUTCOME_KEYS: Record<Exclude<RechargeOutcome, 'idle'>, string> = {
  waiting: 'account.rechargeWaiting',
  paid: 'account.rechargePaid',
  cancelled: 'account.rechargeClosed',
  failed: 'account.rechargeOrderFailed',
};

const RECHARGE_OUTCOME_CLASS: Record<Exclude<RechargeOutcome, 'idle'>, string> = {
  waiting: 'text-[var(--text-secondary)]',
  paid: 'text-[var(--accent)]',
  cancelled: 'text-[var(--text-warning)]',
  failed: 'text-[var(--text-danger)]',
};

/**
 * 当前在途订单的**身份**：订单号 + 代次（BUG-088，2026-10-16）。
 *
 * 为什么不能用一个全组件布尔闸门：轮询与「回前台」是两条独立路径，同一订单的
 * 终态会被两条都读到（需要幂等去重）；但**跨订单**时，上一单的迟到回包绝不能
 * 替下一单结算。单个 `boolean` 分不清「同一单的第二次回调」与「上一单的迟到回调」，
 * 于是旧单回包会重新关闸、停掉新单的轮询，把新单的真实失败丢在地上（实测
 * `paidToasts=2 / failedToasts=0`，而 HEAD 同序列是 `failedToasts=1`）。
 *
 * 现在每次落单都 +1 代次并记下订单号，任何终态回调都必须**同时**对上订单号与
 * 代次才生效 —— 旧单回包（含"切卡/离页后才回来"的）一律丢弃，既不播报、也不关闸。
 */
interface ActiveOrder {
  handle: RechargeOrderHandle;
  epoch: number;
}

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
 * 卡密在「充值确认」这种扫一眼就过的位置只回显首尾各 4 位。
 *
 * 目的单一：让用户能确认「这次充的是**这张**卡」，同时不把完整凭据摊在屏幕上
 * （截屏 / 投屏 / 远程协助场景下，完整卡密等同现金券）。首尾 4 位足以区分同一
 * 账号下的多张卡，不足以被复制使用。
 */
function maskLicenseKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return trimmed;
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
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

/**
 * 预占（held）的三态判据统一在 `@/lib/quota-display` 的 `readHeldView()` ——
 * 账户页 / Dashboard / 顶栏钱包**共用同一份**，不许各写一套（同一块屏上
 * 一个说"未知"、另一个照给数字，比两边都保守更让用户困惑）。
 * 判据与理由见该函数；这里只消费。
 */

/**
 * 「当前卡」的身份（r14 返工 / BUG-088 二阶）：充值订单的终态只对**下单时那张卡**
 * 有意义。身份取 `licenseId + orgId` —— 两者都是卡与计费组织的稳定标识
 * （`CommercialLicenseSummary.licenseId/orgId`），换卡必然至少变一个。
 *
 * ⚠️ 读的是 **store 的当前值**（不是组件闭包里的 `overview`）：迟到回包在
 *    `then` 里落地时，组件可能还没带着新快照重渲染，闭包会拿到旧身份，
 *    那样"换卡失效"就形同虚设。
 */
function currentCardIdentity(): string {
  const license = useCommercialStore.getState().overview?.license;
  return `${license?.licenseId ?? ''}#${license?.orgId ?? ''}`;
}

function QuotaBar({
  used,
  total,
  held = 0,
  heldUnknown = false,
}: {
  used: number;
  total: number;
  held?: number;
  heldUnknown?: boolean;
}) {
  const { t } = useTranslation();
  // ⚠️ "预占口径不可判定"（后端明说，或这次根本没读到读数）⇒ **可用额度是未知的**。
  //    这里绝不能退回 `quota − used` 的数字：那正是"把未知伪装成确定值"，
  //    用户会以为还有额度、发起请求后却被服务端拒掉。
  if (heldUnknown) {
    return (
      <p data-quota-held-unknown className="type-body text-[var(--text-muted)]">
        {t('account.quotaHeldUnknown')}
      </p>
    );
  }
  // 可用 = 总额 − 已用 − **预占**。预占不是"已消费"（还没结算），但从"还能用多少"
  // 的角度必须先扣掉 —— 否则在途扣费一结算，用户会觉得"额度凭空少了"。
  // ⚠️ 这条算术是**唯一派生点** `deriveAvailableDisplay()`（Dashboard / 顶栏共用同一份）。
  //
  // ⚠️ 预占独立行：`held > 0` 时另起一行显示预占，与"已用"分开 ——
  //    用户才不会把在途扣费误当已消费。
  const { remaining, remainingPercent } = deriveAvailableDisplay(total, used, held);
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
      {held > 0 && (
        <div className="flex items-center type-support text-[var(--text-muted)]">
          <span data-quota-held className="type-mono-data text-[var(--text-secondary)]">
            {t('account.quotaHeld')} {formatCreditsPrecise(held)} {t('usage.creditsUnit')}
          </span>
        </div>
      )}
    </div>
  );
}

interface AccountSectionProps {
  onboardingProfile?: OnboardingProfile | null;
  onEditProfile?: () => void;
}

/**
 * 账户页**可见且空闲**时的自刷新节奏（BUG-082 续，2026-10-15 A owner）。
 *
 * 为什么本页还要自己排一次读：App 级 `useQuotaRefreshOnTurnEnd` 覆盖的是
 * 「回合结束 / 消费进行中 5 秒 / 回前台」——都是**本机会话**在动的时候。
 * 「用户停在账户页、没有任何会话在跑、钱在别处花掉（另一台设备 / 另一个窗口 /
 * 服务端账本晚于追读窗口才提交）」这一段没有任何触发源，页面会永远停在旧值。
 * 断网恢复同理：不排读就不会自愈，只能靠切页/重开。
 *
 * 三条边界（与 App 级 hook 同款纪律）：
 *   · **有界**：只读一次就续下次；失败按指数退避，上限 `ACCOUNT_IDLE_REFRESH_MAX_MS`；
 *   · **不叠加**：真正发请求的是 store 的单飞 `refresh()`；忙时（有会话在跑）
 *     本页**完全不排**，整段交给 5 秒忙时节奏；
 *   · **不重复上报**：只读额度通道，不触发用量上报、不改价格/扣费/账本。
 */
export const ACCOUNT_IDLE_REFRESH_MS = 30_000;
export const ACCOUNT_IDLE_REFRESH_MAX_MS = 120_000;

export default function AccountSection({ onboardingProfile = null, onEditProfile }: AccountSectionProps) {
  const { t } = useTranslation();
  // 账号快照的唯一真源（BUG-082）：与顶栏/总览共用同一份。
  const overview = useCommercialStore((s) => s.overview);
  const status = useCommercialStore((s) => s.status);
  const load = useCommercialStore((s) => s.load);
  const refresh = useCommercialStore((s) => s.refresh);
  /** 任一会话在跑就算忙 —— 忙时本页不排读，避免与 App 级 5 秒节奏重复打点。 */
  const turnBusy = useMessageStore((s) => s.processingBySession.size > 0);
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
  const [pending, setPending] = useState<ActiveOrder | null>(null);
  const [placeError, setPlaceError] = useState('');
  const [orderOutcome, setOrderOutcome] = useState<RechargeOutcome>('idle');
  const watchRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCountRef = useRef(0);
  const mountedRef = useRef(true);
  /** 落单用的代次计数器（单调递增；每下一单 +1）。 */
  const orderEpochRef = useRef(0);
  /**
   * ⭐ 幂等 + 身份闸门（BUG-088）。轮询与「回前台」是两条**独立**的触发路径，同一订单的
   * 终态会被两条都读到；没有这道闸门就会连播两条「支付成功」。而闸门**只有带上订单
   * 身份**才挡得住跨订单的迟到回包：结算一次后这里置空，任何不是"当前在途单"的回调
   * 都对不上、一律丢弃。ref 而不是 state：判定必须发生在同一个渲染批次内
   * （state 更新要等下一次渲染，挡不住同一 tick 的第二条）。
   *
   * `card` = **下单那一刻的当前卡**（r14 返工 / BUG-088 二阶）：订单的终态只对那张卡
   * 有意义。换卡之后旧单的迟到回包对不上身份 ⇒ 同样丢弃（见 `settleOrder`）。
   */
  const activeOrderRef = useRef<{ orderNo: string; epoch: number; card: string } | null>(null);

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

  /**
   * 空闲时的持续更新（见 `ACCOUNT_IDLE_REFRESH_MS` 的说明）。
   *
   * 依赖里放 `overview?.account` 而不是整个 `overview`：每次快照更新都会换对象，
   * 放整个对象会让节奏**每读一次就重排一次**，退避永远停在第一档。
   */
  useEffect(() => {
    // 未登录/已登出：没有快照可写，不排读。
    if (!overview?.account) return;
    // 忙时交给 App 级 `useQuotaRefreshOnTurnEnd` 的 5 秒节奏，本页不另开一条。
    if (turnBusy) return;

    let cancelled = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const visible = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden';

    const schedule = (): void => {
      const delay = Math.min(ACCOUNT_IDLE_REFRESH_MS * 2 ** failures, ACCOUNT_IDLE_REFRESH_MAX_MS);
      timer = setTimeout(tick, delay);
    };
    const tick = (): void => {
      if (cancelled) return;
      if (!visible()) {
        // 不可见时一个请求都不打（省流量/省电），但保持节奏链：
        // 回前台那一刻由 App 级 hook 立刻补一次。
        schedule();
        return;
      }
      // refresh() 是 store 的单飞入口：与回合结束/忙时/回前台三类触发会自动合并，
      // 这里不需要（也不该）自己挡并发。
      void refresh().then(() => {
        if (cancelled) return;
        failures = useCommercialStore.getState().status === 'ready' ? 0 : failures + 1;
        schedule();
      });
    };

    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [overview?.account, refresh, turnBusy]);

  useEffect(() => {
    void window.clawwork.commercialRechargeSkus().then((res) => {
      if (!mountedRef.current || !res.ok || !res.result?.length) return;
      setSkus(res.result);
      setSelectedSku((current) => current || res.result![0].sku);
    });
  }, []);

  useEffect(() => () => stopWatch(), [stopWatch]);

  /**
   * 订单结算 —— **全组件唯一的终态写入口**（幂等 + 身份核对，BUG-088）。
   *
   * 无论终态是从轮询读到的、还是从「回前台」读到的，都必须走这里，并且都要带上
   * **发起那次读取时的那一单**（`orderNo` + `epoch`）：闸门只有一处、且只有一对上
   * 身份才生效，才既挡得住同单重复回调的重复播报，也挡得住旧单迟到回包污染新单。
   */
  const settleOrder = useCallback(
    (outcome: 'paid' | 'cancelled' | 'failed', orderNo: string, epoch: number) => {
      const active = activeOrderRef.current;
      // 不是**当前在途**的这一单（订单号或代次对不上，或已结算过）⇒ 一律丢弃：
      // 既不播报、也不关闸、更不许停新单的轮询。这条同时覆盖三种情形：
      //   · 旧单在用户建了新单之后才回包（跨单串扰）；
      //   · 切卡/离页后旧单迟到；
      //   · 同一单的重复终态（第一次结算就把 activeOrderRef 置空了）。
      if (!active || active.orderNo !== orderNo || active.epoch !== epoch) return;
      // 换卡失效（r14 返工 / BUG-088 二阶）：这一单是在**另一张卡**上下单的，它的终态
      // 不再属于当前展示的这张卡 ⇒ 丢弃（不播报、不写结局、不关闸）。
      // 拿**下单时记下的身份**与**此刻 store 里的当前卡**比对：读 store 而不是闭包里的
      // `overview` —— 迟到回包落地时组件可能还没带着新值重渲染。
      if (active.card !== currentCardIdentity()) return;
      activeOrderRef.current = null;
      stopWatch();
      setPending(null);
      setOrderOutcome(outcome);
      if (outcome === 'paid') {
        toast.success(t('account.rechargePaid'));
        // 支付成功后立刻拉一次余额：到账是服务端写的，本地快照还停在付款前。
        void load();
        return;
      }
      // 取消与失败是两种结局，各有自己的文案 —— 原先共用「订单已关闭」，
      // 用户分不清是自己放弃的还是这笔支付失败了。
      toast.warning(t(RECHARGE_OUTCOME_KEYS[outcome]));
    },
    [load, stopWatch, t],
  );

  useEffect(() => {
    if (!pending) return;
    // 捕获**本单**的身份：回包回来时必须核对的是它，而不是"当时 pending 是什么"。
    const { orderNo, epoch } = { orderNo: pending.handle.orderNo, epoch: pending.epoch };
    const onFocus = () => {
      void window.clawwork.commercialRechargeOrder(orderNo).then((res) => {
        if (!mountedRef.current) return;
        const state = res.result?.status;
        if (state === 'paid' || state === 'cancelled' || state === 'failed') settleOrder(state, orderNo, epoch);
      });
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [pending, settleOrder]);

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
    (orderNo: string, epoch: number) => {
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
        // 三种终态统一交给幂等结算入口：与「回前台」那条路径共用同一道闸门，
        // 且都带上本单身份 —— 旧单的迟到回包不许替新单结算（BUG-088）。
        if (state === 'paid' || state === 'cancelled' || state === 'failed') {
          settleOrder(state, orderNo, epoch);
          return;
        }
        if (pollCountRef.current >= 40) stopWatch();
      };

      void poll();
      watchRef.current = setInterval(() => void poll(), 3000);
    },
    [settleOrder, stopWatch],
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
      // 新订单 ⇒ 新代次：上一单的身份随之作废，任何仍在本地的旧单迟到回包
      // 都对不上（订单号/代次至少一个不符）⇒ 不许替这一单结算（BUG-088）。
      // 同时记下**下单这一刻的当前卡**：换卡之后这单的终态一并失效（r14 返工）。
      const epoch = orderEpochRef.current + 1;
      orderEpochRef.current = epoch;
      activeOrderRef.current = { orderNo: res.result.orderNo, epoch, card: currentCardIdentity() };
      setOrderOutcome('waiting');
      setPending({ handle: res.result, epoch });
      window.open(res.result.payUrl, '_blank');
      startWatch(res.result.orderNo, epoch);
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
  // 预占：读到读数才有值（不在本地估算）；口径不可判定时 `unknown` 为真，
  // 可用额度随之变成**未知**，由 QuotaBar 显示"暂不可用"而不是照常显示数字。
  const heldView = readHeldView(license);

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
            <QuotaBar
              used={quotaUsed}
              total={quotaTotal}
              held={heldView.micros}
              heldUnknown={heldView.unknown}
            />
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

      {/* 充值订单的**结局留痕**（BUG-081 续）：toast 三秒就没了，页面上必须能再看到
          一次 —— 用户回过头来问"我刚才那笔到底成了没有"，答案要在这儿。
          成功 / 等待 / 取消 / 失败是四种不同结局，不共用一句文案。 */}
      {orderOutcome !== 'idle' && (
        <p
          data-recharge-status={orderOutcome}
          role={orderOutcome === 'failed' ? 'alert' : undefined}
          className={`type-support ${RECHARGE_OUTCOME_CLASS[orderOutcome]}`}
        >
          {t(RECHARGE_OUTCOME_KEYS[orderOutcome])}
        </p>
      )}

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

          {/* ⭐ 充到哪张卡（BUG-081 续）。付款前必须让用户看清楚钱落在**哪张卡、
              哪个组织、哪个账号**上：没有这段，用户只能等付款后用
              `recharge_no_license_target` 这类失败码反推自己有没有卡。
              无卡态直接给出可执行的下一步（去「激活」绑卡），而不是让用户先付钱。 */}
          <div data-recharge-target className="mt-4 rounded-lg bg-[var(--bg-tertiary)] px-3 py-2.5">
            {license ? (
              <>
                <p className="type-support text-[var(--text-muted)]">{t('account.plan')}</p>
                <p data-recharge-target-plan className="type-label text-[var(--text-primary)]">
                  {license.sku ?? '—'}
                </p>
                <p data-recharge-target-owner className="type-support mt-0.5 text-[var(--text-secondary)]">
                  {[org?.name, displayName].filter(Boolean).join(' · ')}
                </p>
                {license.licenseKey && (
                  <p data-recharge-target-key className="type-mono-data mt-0.5 text-[var(--text-muted)]">
                    {maskLicenseKey(license.licenseKey)}
                  </p>
                )}
              </>
            ) : (
              // ⚠️ 这里刻意**不加** `role="alert"`：它是常驻的前置条件说明，不是
              //    动态错误。加了会抢走 `[role="alert"]` 的首个位置，把真正的
              //    "发起支付失败" 提示挤到选择器外面（既有失败码端到端测试就锁在这里）。
              <p data-recharge-target-missing className="type-support text-[var(--text-danger)]">
                {t('account.rechargeCardRequired')}
              </p>
            )}
          </div>

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
                  // 到账积分 = 支付金额（分）× 1；脏数据返回 null 时只留金额。
                  const creditsText = rechargeCreditsText(item.amountCents);
                  // ⚠️ 价签取 `amountCents`（**权威金额**），不渲染 `label` 里的价格：
                  //    label 是服务端展示串，与 amountCents 不一致时同一张卡会同时
                  //    出现两个价格（人民币口径必须唯一）。看起来像价格的 label
                  //    （含 ¥/$ 或数字）一律不上屏；纯文字标签（如"新人档"）保留。
                  const labelCaption = /[¥￥$0-9]/.test(item.label) ? null : item.label.trim() || null;
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
                      <span data-sku-price={item.sku} className="type-label block text-[var(--text-primary)]">
                        {formatCents(item.amountCents)}
                      </span>
                      {labelCaption && (
                        <span className="type-support mt-0.5 block text-[var(--text-muted)]">{labelCaption}</span>
                      )}
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
