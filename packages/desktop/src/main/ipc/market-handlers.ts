import { ipcMain } from 'electron';
import type { IpcResult } from '@clawwork/shared';
import { getCommercialClient } from '../commercial/client.js';

/**
 * 助手市场 / 创作者中心的 IPC。
 *
 * 与 `community-handlers.ts` 同构：复用 `commercial/client.ts` 那条已登录的 Supabase
 * 会话，**权限与可见性一律由迁移 40 里的 definer RPC 判定**
 * （`scripts/tests/agent_templates.sql` 逐条钉过），这一层只负责
 * 参数改名、异常收敛成错误码、绝不让异常穿透 IPC。
 *
 * ⚠️ **安装动作不在这里** —— 真安装要在本地网关建 agent，那是渲染进程通过
 *    `window.clawwork` 做的（与六个预置助手同一条链，见 `useTemplateInstall`）。
 *    这里只有"记账"那一步（`market:installed`）。
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
    console.error(`[market] ${fn} failed:`, error);
    return { ok: false, errorCode: 'network' };
  }
}

const rows = (data: unknown): unknown[] => (Array.isArray(data) ? data : data == null ? [] : [data]);
const firstRow = (data: unknown): unknown => rows(data)[0] ?? null;
const asNumber = (value: unknown): number => (typeof value === 'number' ? value : Number(value) || 0);

export function registerMarketHandlers(): void {
  ipcMain.handle('market:templates', (_e, payload?: { category?: string | null; query?: string | null }) =>
    callRpc('market_templates', { p_category: payload?.category ?? null, p_query: payload?.query ?? null }, (data) =>
      rows(data),
    ),
  );

  ipcMain.handle('market:detail', (_e, payload: { id?: string }) =>
    callRpc('market_template_detail', { p_id: payload?.id ?? null }, (data) => firstRow(data)),
  );

  // 记账：单对象，在这一层就翻成驼峰（与 community 的约定一致）
  ipcMain.handle('market:installed', (_e, payload: { id?: string }) =>
    callRpc('market_template_installed', { p_id: payload?.id ?? null }, (data) => {
      const row = firstRow(data);
      const record = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
      return { installCount: asNumber(record.install_count) };
    }),
  );

  ipcMain.handle('market:mine', () => callRpc('creator_templates_mine', {}, (data) => rows(data)));

  ipcMain.handle(
    'market:create',
    (_e, payload: { name?: string; description?: string; category?: string; emoji?: string; instructions?: string }) =>
      callRpc(
        'creator_template_create',
        {
          p_name: payload?.name ?? '',
          p_description: payload?.description ?? '',
          p_category: payload?.category ?? 'other',
          p_emoji: payload?.emoji ?? '🧩',
          p_instructions: payload?.instructions ?? '',
        },
        (data) => firstRow(data),
      ),
  );

  ipcMain.handle(
    'market:update',
    (
      _e,
      payload: {
        id?: string;
        name?: string;
        description?: string;
        category?: string;
        emoji?: string;
        instructions?: string;
      },
    ) =>
      callRpc(
        'creator_template_update',
        {
          p_id: payload?.id ?? null,
          p_name: payload?.name ?? '',
          p_description: payload?.description ?? '',
          p_category: payload?.category ?? 'other',
          p_emoji: payload?.emoji ?? '🧩',
          p_instructions: payload?.instructions ?? '',
        },
        () => null,
      ),
  );

  ipcMain.handle('market:set-status', (_e, payload: { id?: string; status?: string }) =>
    callRpc(
      'creator_template_set_status',
      { p_id: payload?.id ?? null, p_status: payload?.status ?? 'draft' },
      () => null,
    ),
  );

  ipcMain.handle('market:delete', (_e, payload: { id?: string }) =>
    callRpc('creator_template_delete', { p_id: payload?.id ?? null }, () => null),
  );
}
