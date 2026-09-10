import type { IpcResult } from '@clawwork/shared';
import { getCommercialClient } from './client.js';
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
    // Amount comes from the pricing table inside the RPC. The renderer only
    // picks which tier, never how much.
    const { data: order, error: createError } = await supabase.rpc('create_recharge_order', {
      p_sku: trimmed,
    });

    if (createError) {
      const message = String(createError.message ?? '');
      const code = message.includes('not signed in')
        ? 'not_signed_in'
        : message.includes('no organization')
          ? 'no_organization'
          : message.includes('unknown or inactive sku')
            ? 'recharge_sku_unknown'
            : 'recharge_create_failed';
      return { ok: false, error: message, errorCode: code };
    }

    const orderNo = String((order as { orderNo?: unknown })?.orderNo ?? '');
    if (!orderNo) {
      return { ok: false, error: 'Order was created without an order number', errorCode: 'recharge_create_failed' };
    }

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

    let { data, error } = await read();
    if (error) return fail(error, 'recharge_order_read_failed');
    if (!data) {
      return { ok: false, error: 'Order not found', errorCode: 'recharge_order_not_found' };
    }

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
