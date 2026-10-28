import { ipcMain } from 'electron';
import { PUBLIC_MARKET_CLOSED, PUBLIC_MARKET_CLOSED_CODE } from '@clawwork/shared';
import type { IpcResult } from '@clawwork/shared';
import { getCommercialClient } from '../commercial/client.js';
import { localTemplateDetail, localTemplateSummaries } from '../market/local-templates.js';

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
  // ⚠️ 公开市场的**浏览与详情**随市场关闭一起守卫（W07-57）：主进程是接口边界，
  //    界面关掉不算关 —— 这里关了，绕过界面直接调 IPC 也拿不到公开内容。
  //    私有面（`market:mine`/create/update/delete）**不在这里**，照常开放。
  ipcMain.handle('market:templates', (_e, payload?: { category?: string | null; query?: string | null }) => {
    if (PUBLIC_MARKET_CLOSED) return { ok: false, errorCode: PUBLIC_MARKET_CLOSED_CODE };
    // 本地部署（未接商业层，无 Supabase 客户端）⇒ 公开市场退回内置本地模板，
    // 让「浏览 + 详情 + 在助手中使用」整条链路照常可用（见 local-templates.ts）。
    if (!getCommercialClient()) return { ok: true, result: localTemplateSummaries(payload) };
    return callRpc(
      'market_templates',
      { p_category: payload?.category ?? null, p_query: payload?.query ?? null },
      (data) => rows(data),
    );
  });

  ipcMain.handle('market:detail', (_e, payload: { id?: string }) => {
    if (PUBLIC_MARKET_CLOSED) return { ok: false, errorCode: PUBLIC_MARKET_CLOSED_CODE };
    // 同上：本地部署时详情也来自内置模板；找不到按 not_found 收敛。
    if (!getCommercialClient()) {
      const row = localTemplateDetail(payload?.id ?? '');
      return row ? { ok: true, result: row } : { ok: false, errorCode: 'not_found' };
    }
    return callRpc('market_template_detail', { p_id: payload?.id ?? null }, (data) => firstRow(data));
  });

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

  ipcMain.handle('market:set-status', (_e, payload: { id?: string; status?: string }) => {
    // 上架公开 = 创作者的"公开入口"，随市场一起关；
    // **下架/归档照常** —— 创作者必须能把已经公开的东西收回来（关新不关旧）。
    if (PUBLIC_MARKET_CLOSED && payload?.status === 'published') {
      return { ok: false, errorCode: PUBLIC_MARKET_CLOSED_CODE };
    }
    return callRpc(
      'creator_template_set_status',
      { p_id: payload?.id ?? null, p_status: payload?.status ?? 'draft' },
      () => null,
    );
  });

  ipcMain.handle('market:delete', (_e, payload: { id?: string }) =>
    callRpc('creator_template_delete', { p_id: payload?.id ?? null }, () => null),
  );
}
