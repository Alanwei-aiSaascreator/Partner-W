import { CUSTOM_RECHARGE_MAX_CENTS, CUSTOM_RECHARGE_MIN_CENTS, type IpcResult } from '@clawwork/shared';
import { getCommercialClient } from './client.js';
import { readLicenseStatus } from './license.js';
import { readConfig } from '../workspace/config.js';

/**
 * Recharge flow, main-process side.
 *
 * The renderer never sees the access token or the payment service URL: it asks
 * for a SKU list, asks to start an order, and polls for the outcome. Everything
 * that touches money or credentials stays on this side of the IPC boundary.
 */

const DEFAULT_PAYMENT_BASE_URL = 'https://rongyinghudong.com';
const CREATE_TIMEOUT_MS = 15_000;
const ORDER_POLL_AFTER_MS = 20_000;

export interface RechargeSku {
  sku: string;
  label: string;
  amountCents: number;
  bonusCents: number;
}

export interface RechargeOrderHandle {
  orderNo: string;
  amountCents: number;
  payUrl: string;
  expiresAt: string | null;
}

export interface RechargeOrderStatus {
  orderNo: string;
  status: string;
  amountCents: number;
  paidAt: string | null;
}

function fail<T = unknown>(error: unknown, errorCode: string): IpcResult<T> {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: message, errorCode };
}

function paymentBaseUrl(): string {
  const configured = readConfig()?.commercial?.paymentBaseUrl;
  return (configured || DEFAULT_PAYMENT_BASE_URL).replace(/\/+$/, '');
}

export async function readRechargeSkus(): Promise<IpcResult<RechargeSku[]>> {
  const supabase = getCommercialClient();
  if (!supabase) {
    return { ok: false, error: 'Commercial backend is not configured', errorCode: 'not_configured' };
  }

  try {
    const { data, error } = await supabase
      .from('recharge_skus')
      .select('sku, label, amount_cents, bonus_cents')
      .eq('active', true)
      .order('sort_order', { ascending: true });

    if (error) return fail(error, 'recharge_skus_read_failed');

    const skus = (data ?? []).map((row) => ({
      sku: row.sku as string,
      label: (row.label as string) ?? '',
      amountCents: Number(row.amount_cents ?? 0),
      bonusCents: Number(row.bonus_cents ?? 0),
    }));

    return { ok: true, result: skus };
  } catch (error) {
    return fail(error, 'recharge_skus_read_failed');
  }
}

type CommercialClient = NonNullable<ReturnType<typeof getCommercialClient>>;

/**
 * C2（2026-10-10 基线审查）：当前应计费卡 —— 充值订单的**目标卡**。
 *
 * 复用 `readLicenseStatus` 的解析链（存储卡 → 账号 → owner 校验）；解析不到返回 null。
 * **绝不**拿"最早的卡 / 余额最大的卡"凑一个目标 —— 旧链正是因此在
 * 「当前卡扣费、钱加到另一张卡」上两张皮。
 */
async function currentLicenseTarget(): Promise<string | null> {
  try {
    const status = await readLicenseStatus();
    return status.ok && status.result?.licenseId ? status.result.licenseId : null;
  } catch {
    return null;
  }
}

/**
 * Maps an RPC failure message to a code the renderer can localise.
 *
 * C2（R1 终审 §9，2026-10-10）：migration 58 的新签名把「目标卡」错误做成
 * **可分类的文案**（fail-closed）——这里逐条映射成语义码，renderer 再翻成
 * 本地化入口文案（只改这里不够，AccountSection 也要接 errorCode）。
 */
function classifyCreateError(message: string): string {
  if (message.includes('not signed in')) return 'not_signed_in';
  if (message.includes('no organization')) return 'no_organization';
  if (message.includes('out of range')) return 'recharge_amount_out_of_range';
  if (message.includes('unknown or inactive sku')) return 'recharge_sku_unknown';
  // —— 目标卡族（migration 58 的 raise 文案，逐字匹配）——
  if (message.includes('license target is required')) return 'recharge_no_license_target';
  if (message.includes('unknown license target')) return 'recharge_card_unavailable';
  if (message.includes('license target is not owned by this user')) return 'recharge_card_unavailable';
  if (message.includes('license target is not active')) return 'recharge_card_unavailable';
  if (message.includes('license target is expired')) return 'recharge_card_unavailable';
  // —— 旧客户端撞上新 SQL 的 fail-closed 指引（migration 58 两条旧签名）——
  if (message.includes('client-upgrade-required')) return 'client_upgrade_required';
  return 'recharge_create_failed';
}

/**
 * Turns an already-created order into a checkout URL.
 *
 * Shared by both order paths. Note what is *not* here: the amount. The payment
 * service reads it from the order row with service_role, so neither the
 * renderer nor this process can influence what the user is charged.
 */
async function openCheckout(supabase: CommercialClient, orderNo: string): Promise<IpcResult<RechargeOrderHandle>> {
  const { data: session } = await supabase.auth.getSession();
  const token = session?.session?.access_token;
  if (!token) {
    return { ok: false, error: 'Not signed in', errorCode: 'not_signed_in' };
  }

  const boundary = paymentBaseUrl();
  const response = await withTimeout(
    fetch(`${boundary}/payment-order/alipay/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ orderNo }),
    }),
    CREATE_TIMEOUT_MS,
  );

  if (!response) return fail(new Error('timed out'), 'payment_service_down');
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    return fail(
      new Error(body?.error?.message ?? `payment service responded ${response.status}`),
      'payment_service_down',
    );
  }

  const payload = (await response.json()) as RechargeOrderHandle;
  if (!payload?.payUrl) {
    return fail(new Error('payment service returned no pay URL'), 'payment_service_down');
  }

  return {
    ok: true,
    result: {
      orderNo: payload.orderNo ?? orderNo,
      amountCents: Number(payload.amountCents ?? 0),
      payUrl: payload.payUrl,
      expiresAt: payload.expiresAt ?? null,
    },
  };
}

function readOrderNo(order: unknown): string {
  return String((order as { orderNo?: unknown })?.orderNo ?? '');
}

export async function createRechargeOrder(sku: string): Promise<IpcResult<RechargeOrderHandle>> {
  const supabase = getCommercialClient();
  if (!supabase) {
    return { ok: false, error: 'Commercial backend is not configured', errorCode: 'not_configured' };
  }

  const trimmed = sku.trim();
  if (!trimmed) {
    return { ok: false, error: 'SKU is empty', errorCode: 'empty_sku' };
  }

  try {
    // C2：订单固化**当前应计费卡**（与扣费身份一致；履约只加目标卡）。
    // 解析不到当前卡 ⇒ 不创建订单（宁缺毋错）——绝不拿别的卡凑目标。
    const licenseTarget = await currentLicenseTarget();
    if (!licenseTarget) {
      return { ok: false, error: 'Recharge needs an active license target', errorCode: 'recharge_no_license_target' };
    }
    // Amount comes from the pricing table inside the RPC. The renderer only
    // picks which tier, never how much.
    const { data: order, error } = await supabase.rpc('create_recharge_order', {
      p_sku: trimmed,
      p_license_id: licenseTarget,
    });
    if (error) return fail(error, classifyCreateError(String(error.message ?? '')));

    const orderNo = readOrderNo(order);
    if (!orderNo) {
      return { ok: false, error: 'Order was created without an order number', errorCode: 'recharge_create_failed' };
    }
    return openCheckout(supabase, orderNo);
  } catch (error) {
    return fail(error, 'recharge_create_failed');
  }
}

/**
 * Free-form recharge, ¥1–¥500.
 *
 * The renderer picks the amount here, which the tier path deliberately forbids.
 * That is safe because the amount is not what the balance is computed from:
 * fulfillment grants `order.amount_cents`, and the notification is rejected
 * unless the money actually paid equals it. Nobody can pay ¥1 and receive ¥500.
 * The part that must stay server-side is the *bonus*, and the RPC pins that to
 * zero by using a SKU that is absent from `recharge_skus`.
 *
 * The range check below is for the user's benefit only — the RPC is the
 * authority and rejects anything out of bounds regardless.
 */
export async function createCustomRechargeOrder(amountCents: number): Promise<IpcResult<RechargeOrderHandle>> {
  const supabase = getCommercialClient();
  if (!supabase) {
    return { ok: false, error: 'Commercial backend is not configured', errorCode: 'not_configured' };
  }

  if (
    !Number.isInteger(amountCents) ||
    amountCents < CUSTOM_RECHARGE_MIN_CENTS ||
    amountCents > CUSTOM_RECHARGE_MAX_CENTS
  ) {
    return {
      ok: false,
      error: 'Custom amount is out of range',
      errorCode: 'recharge_amount_out_of_range',
    };
  }

  try {
    // C2：同档位路径 —— 目标卡必须显式绑定当前应计费卡。
    const licenseTarget = await currentLicenseTarget();
    if (!licenseTarget) {
      return { ok: false, error: 'Recharge needs an active license target', errorCode: 'recharge_no_license_target' };
    }
    const { data: order, error } = await supabase.rpc('create_recharge_order_custom', {
      p_amount_cents: amountCents,
      p_license_id: licenseTarget,
    });
    if (error) return fail(error, classifyCreateError(String(error.message ?? '')));

    const orderNo = readOrderNo(order);
    if (!orderNo) {
      return { ok: false, error: 'Order was created without an order number', errorCode: 'recharge_create_failed' };
    }
    return openCheckout(supabase, orderNo);
  } catch (error) {
    return fail(error, 'recharge_create_failed');
  }
}

export async function readRechargeOrder(orderNo: string): Promise<IpcResult<RechargeOrderStatus>> {
  const supabase = getCommercialClient();
  if (!supabase) {
    return { ok: false, error: 'Commercial backend is not configured', errorCode: 'not_configured' };
  }

  const trimmed = orderNo.trim();
  if (!trimmed) {
    return { ok: false, error: 'Order number is empty', errorCode: 'empty_order_no' };
  }

  try {
    const read = async () =>
      supabase
        .from('orders')
        .select('order_no, status, amount_cents, paid_at, created_at')
        .eq('order_no', trimmed)
        .maybeSingle();

    // 拆开取而不是 `let { data, error } = await read()`：`data` 在下面会被
    // 重新赋值（查到 stale 订单后会再读一次），`error` 不会 —— 一起用 let
    // 会让 lint 的 prefer-const 报 error 那一半。
    const first = await read();
    if (first.error) return fail(first.error, 'recharge_order_read_failed');
    if (!first.data) {
      return { ok: false, error: 'Order not found', errorCode: 'recharge_order_not_found' };
    }
    let data = first.data;

    // A pending order that has had time to be paid may have lost its
    // notification. Ask the payment service to query Alipay before answering,
    // so the panel does not sit on a stale "pending" while the user watches.
    const createdAt = data.created_at ? Date.parse(data.created_at as string) : 0;
    const stale = data.status === 'pending' && Date.now() - createdAt > ORDER_POLL_AFTER_MS;
    if (stale) {
      await queryPaymentService(trimmed);
      const refreshed = await read();
      if (!refreshed.error && refreshed.data) {
        data = refreshed.data;
      }
    }

    return {
      ok: true,
      result: {
        orderNo: data.order_no as string,
        status: (data.status as string) ?? 'pending',
        amountCents: Number(data.amount_cents ?? 0),
        paidAt: (data.paid_at as string) ?? null,
      },
    };
  } catch (error) {
    return fail(error, 'recharge_order_read_failed');
  }
}

async function queryPaymentService(orderNo: string): Promise<void> {
  try {
    const supabase = getCommercialClient();
    if (!supabase) return;
    const { data: session } = await supabase.auth.getSession();
    const token = session?.session?.access_token;
    if (!token) return;

    await withTimeout(
      fetch(`${paymentBaseUrl()}/payment-order/alipay/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ orderNo }),
      }),
      8_000,
    );
  } catch {
    // Best-effort: the order row is the source of truth and the service sweeps
    // on its own schedule regardless.
  }
}

async function withTimeout(work: Promise<Response>, ms: number): Promise<Response | null> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    handle = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } catch {
    return null;
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}
