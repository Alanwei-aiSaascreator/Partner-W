import { ipcMain } from 'electron';
import type { IpcResult } from '@clawwork/shared';
import { normalizePrivacyState } from '@clawwork/core';
import { getCommercialClient } from '../commercial/client.js';
import { buildLocalExport, saveExportFile } from '../privacy/export-local.js';

/**
 * 隐私工单（导出 / 删除）的 IPC。
 *
 * 与 `growth-handlers.ts` / `community-handlers.ts` 同构：复用 `commercial/client.ts`
 * 那条已登录的 Supabase 会话，**鉴权、冷却期、状态机一律由迁移 51 里的 definer RPC
 * 判定**（`scripts/tests/privacy.sql` 逐条钉过），这一层只负责参数改名、异常收敛成
 * 错误码、绝不让异常或英文原文穿透 IPC。
 *
 * ⚠️ 本层**单独抄一份** `callRpc`（与仓库现状一致：market / community / growth 各自
 *    一份）。改这里的错误码处理时，别去动别家那份。
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
    console.error(`[privacy] ${fn} failed:`, error);
    return { ok: false, errorCode: 'network' };
  }
}

export function registerPrivacyHandlers(): void {
  // `privacy_my_state()` 返回的是 snake_case + 可能被序列化成字符串的字节数 ⇒
  // **必须**过 core 的归一化（渲染层直接读 camelCase 与真布尔）。
  ipcMain.handle('privacy:state', () => callRpc('privacy_my_state', {}, (d) => normalizePrivacyState(d)));

  ipcMain.handle('privacy:request-export', () => callRpc('privacy_request_export', {}, (d) => d ?? null));

  ipcMain.handle('privacy:request-deletion', (_e, payload?: { reason?: string }) =>
    callRpc('privacy_request_deletion', { p_reason: payload?.reason ?? '' }, (d) => d ?? null),
  );

  ipcMain.handle('privacy:cancel-deletion', (_e, payload?: { id?: string }) =>
    callRpc('privacy_cancel_deletion', { p_id: payload?.id ?? null }, () => null),
  );

  // 导出 = 服务端快照 + 本地数据，合成**一个** JSON 落盘。
  //
  // ⚠️ 这里先调 `privacy_request_export`（RPC 自己幂等：已有还能下载的未结单会复用），
  //    再拿**服务端回的 id** 去下载 —— 不接渲染层传来的 id：那个 id 可能是上一单、
  //    也可能已经被驳回/清快照，拿它下载只会拿到 request_not_downloadable。
  ipcMain.handle('privacy:download-export', async () => {
    const requested = await callRpc('privacy_request_export', {}, (d) => d ?? null);
    if (!requested.ok) return requested;

    const id = (requested.result as { id?: string } | null)?.id;
    if (!id) return { ok: false as const, errorCode: 'unknown' };

    const snapshot = await callRpc('privacy_export_download', { p_id: id }, (d) => d ?? null);
    if (!snapshot.ok) return snapshot;

    try {
      const local = await buildLocalExport();
      const path = await saveExportFile({
        format: 'rongying-mofang-export@1',
        exported_at: new Date().toISOString(),
        server: snapshot.result,
        local,
      });
      return { ok: true as const, result: { path } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 用户在保存对话框点了取消：不是错误，如实回一个码让界面安静收场
      return { ok: false as const, errorCode: message === 'cancelled' ? 'cancelled' : 'network' };
    }
  });
}
