import { ipcMain } from 'electron';
import type { IpcResult } from '@clawwork/shared';
import { getCommercialClient } from '../commercial/client.js';
import { trackOnSuccess } from '../analytics/reporter.js';

/**
 * 成长值 / 悬赏的 IPC。
 *
 * 与 `market-handlers.ts` 同构：复用 `commercial/client.ts` 那条已登录的 Supabase
 * 会话，**鉴权、可见性、状态机一律由迁移 45/46/47 里的 definer RPC 判定**
 * （`scripts/tests/bounty_growth.sql` 逐条钉过 75 条断言），这一层只负责
 * 参数改名、异常收敛成错误码、绝不让异常穿透 IPC。
 */

interface RpcLike {
  rpc: (fn: string, params?: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }>;
}

/** 只放行裸机器码；英文长句一律压成 unknown，免得顺着 toast 摆到用户面前。 */
function rpcErrorCode(message: string | undefined): string {
  const text = (message ?? '').trim();
  if (!text) return 'unknown';
  return /^[a-z][a-z0-9_]{0,63}$/.test(text) ? text : 'unknown';
}

async function callRpc<T>(
  fn: string,
  params: Record<string, unknown>,
  map: (data: unknown) => T,
): Promise<IpcResult<T>> {
  const client = getCommercialClient() as RpcLike | null;
  if (!client) return { ok: false, errorCode: 'not_authenticated' };

  try {
    const res = await client.rpc(fn, params);
    if (res.error) return { ok: false, errorCode: rpcErrorCode(res.error.message) };
    return { ok: true, result: map(res.data) };
  } catch (error) {
    console.error(`[growth] ${fn} failed:`, error);
    return { ok: false, errorCode: 'network' };
  }
}

const rows = (data: unknown): unknown[] => (Array.isArray(data) ? data : data == null ? [] : [data]);
const firstRow = (data: unknown): unknown => rows(data)[0] ?? null;

export function registerGrowthHandlers(): void {
  // ── 成长值 ──────────────────────────────────────────────────────
  ipcMain.handle('growth:summary', () => callRpc('growth_summary', {}, firstRow));

  ipcMain.handle('growth:check-in', () =>
    callRpc('growth_check_in', {}, firstRow).then((res) => trackOnSuccess(res, 'daily_check_in')),
  );

  ipcMain.handle('growth:history', (_e, payload?: { limit?: number; before?: string | null }) =>
    callRpc('growth_history', { p_limit: payload?.limit ?? 50, p_before: payload?.before ?? null }, rows),
  );

  // ── 悬赏 ────────────────────────────────────────────────────────
  ipcMain.handle('bounty:list', (_e, payload?: { status?: string | null }) =>
    callRpc('bounty_list', { p_status: payload?.status ?? null }, rows),
  );

  ipcMain.handle('bounty:create', (_e, payload: { title?: string; description?: string; reward?: number }) =>
    callRpc(
      'bounty_create',
      {
        p_title: payload?.title ?? '',
        p_description: payload?.description ?? '',
        p_reward: payload?.reward ?? 50,
      },
      firstRow,
    ).then((res) => trackOnSuccess(res, 'bounty_published')),
  );

  ipcMain.handle('bounty:claim', (_e, payload: { id?: string }) =>
    callRpc('bounty_claim', { p_id: payload?.id ?? null }, () => null),
  );

  ipcMain.handle('bounty:release', (_e, payload: { id?: string }) =>
    callRpc('bounty_release', { p_id: payload?.id ?? null }, () => null),
  );

  ipcMain.handle('bounty:submit', (_e, payload: { id?: string; note?: string }) =>
    callRpc('bounty_submit', { p_id: payload?.id ?? null, p_note: payload?.note ?? '' }, () => null),
  );

  ipcMain.handle('bounty:accept', (_e, payload: { id?: string }) =>
    callRpc('bounty_accept', { p_id: payload?.id ?? null }, () => null),
  );

  ipcMain.handle('bounty:reject', (_e, payload: { id?: string; note?: string }) =>
    callRpc('bounty_reject', { p_id: payload?.id ?? null, p_note: payload?.note ?? '' }, () => null),
  );

  ipcMain.handle('bounty:cancel', (_e, payload: { id?: string }) =>
    callRpc('bounty_cancel', { p_id: payload?.id ?? null }, () => null),
  );
}
