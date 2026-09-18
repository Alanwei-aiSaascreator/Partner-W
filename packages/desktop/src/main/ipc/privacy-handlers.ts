import { ipcMain } from 'electron';
import type { IpcResult } from '@clawwork/shared';
import { DELETION_REQUEST_NOTE, normalizePrivacyState } from '@clawwork/core';
import { getCommercialClient } from '../commercial/client.js';
import { buildLocalExport, saveExportFile } from '../privacy/export-local.js';
import type { LocalExport } from '../privacy/export-local.js';

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
  // ⚠️ `getCommercialClient()` 自己也**可能抛**（supabase-js 在 URL 非法时构造即抛），
  //    所以它必须在 try 里面：否则异常直接穿透 IPC，渲染层看到的是
  //    `Error invoking remote method '...': Invalid supabaseUrl` 这种英文原文。
  let client: RpcLike | null;
  try {
    client = getCommercialClient() as RpcLike | null;
  } catch (error) {
    console.error('[privacy] getCommercialClient failed:', error);
    return { ok: false, errorCode: 'unknown' };
  }
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

/** 下载导出的返回形状（R3：截断说明要跟着一起回去，界面才提示得出"这不是完整历史"）。 */
export interface DownloadExportResult {
  path: string;
  /** true = 本地或服务端那份因为上限退化了（界面据此提示）。 */
  truncated: boolean;
  /** 本地组装过程中的如实说明（含截断原因、坏配置降级等）。 */
  notes: string[];
}

/**
 * 本地那份的截断信息。
 * 用 `Partial` 读是为了**边界防御**：这一层不该因为本地组装返回了个缺字段的对象
 * 而再抛一次异常（真抛了就会被上面那句 `local_export_failed` 兜住，
 * 但用户拿到的就是"失败了"，而这本可以是"成功但截断"）。
 */
function localTruncation(local: Partial<LocalExport> | null | undefined): {
  truncated: boolean;
  notes: string[];
} {
  const notes = local?.notes;
  return {
    truncated: local?.meta?.truncated === true,
    notes: Array.isArray(notes) ? notes.filter((note) => typeof note === 'string') : [],
  };
}

/** 下载的**单飞**：双击 / 两个窗口同时点只跑一次（见 `privacy:download-export`）。 */
let downloadInFlight: Promise<IpcResult<DownloadExportResult>> | null = null;

/** 把上一步的失败原样往前带（只带错误字段：`result` 在失败路径上没有意义）。 */
function forwardFailure<T>(failure: {
  errorCode?: string;
  error?: string;
  errorDetails?: Record<string, unknown>;
}): IpcResult<T> {
  return {
    ok: false,
    errorCode: failure.errorCode,
    error: failure.error,
    errorDetails: failure.errorDetails,
  };
}

async function runDownloadExport(): Promise<IpcResult<DownloadExportResult>> {
  // `map` 直接把 id 抽出来：失败路径由 `forwardFailure` 收敛成下载的返回形状
  const requested = await callRpc('privacy_request_export', {}, (d) => d as { id?: string } | null);
  if (!requested.ok) return forwardFailure(requested);

  const id = requested.result?.id;
  if (!id) return { ok: false as const, errorCode: 'unknown' };

  const snapshot = await callRpc('privacy_export_download', { p_id: id }, (d) => d ?? null);
  if (!snapshot.ok) return forwardFailure(snapshot);

  // 本地那一半：**读库 / 写盘**失败与"RPC 失败"是两回事，错误码必须分开 ——
  // 磁盘满、无权限、保存位置不可写说成"网络连接失败"，用户只会去反复重试网络。
  let local: LocalExport;
  try {
    local = await buildLocalExport();
  } catch (error) {
    console.error('[privacy] buildLocalExport failed:', error);
    return { ok: false as const, errorCode: 'local_export_failed' };
  }

  try {
    const path = await saveExportFile({
      format: 'rongying-mofang-export@1',
      exported_at: new Date().toISOString(),
      server: snapshot.result,
      local,
    });
    const { truncated, notes } = localTruncation(local);
    return { ok: true as const, result: { path, truncated, notes } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 用户在保存对话框点了取消：不是错误，如实回一个码让界面安静收场
    if (message === 'cancelled') return { ok: false as const, errorCode: 'cancelled' };
    console.error('[privacy] saveExportFile failed:', error);
    return { ok: false as const, errorCode: 'local_export_failed' };
  }
}

export function registerPrivacyHandlers(): void {
  // `privacy_my_state()` 返回的是 snake_case + 可能被序列化成字符串的字节数 ⇒
  // **必须**过 core 的归一化（渲染层直接读 camelCase 与真布尔）。
  ipcMain.handle('privacy:state', () => callRpc('privacy_my_state', {}, (d) => normalizePrivacyState(d)));

  ipcMain.handle('privacy:request-export', () => callRpc('privacy_request_export', {}, (d) => d ?? null));

  // ⚠️ 审计口径 = **固定机器码**（`DELETION_REQUEST_NOTE`），**不是**界面文案：以前渲染层把
  //    `privacy.deletionReason`（当前语言的 UI 文案）当数据发上来 ⇒ 用户换个语言，运营在
  //    后台看到的"理由"也跟着变（审计口径不该随界面语言漂）。机器码在**这一层**戳上去：
  //    渲染层传什么都改不动它。用户自述理由（`reason`，可选）拼在机器码后面；界面目前不
  //    收集它 ⇒ 让出。分隔符固定且不进 i18n —— 它同样是审计数据的一部分。
  ipcMain.handle('privacy:request-deletion', (_e, payload?: { reason?: string }) => {
    const note = [DELETION_REQUEST_NOTE, payload?.reason]
      .filter((part): part is string => typeof part === 'string' && part !== '')
      .join(' | ');
    return callRpc('privacy_request_deletion', { p_reason: note }, (d) => d ?? null);
  });

  ipcMain.handle('privacy:cancel-deletion', (_e, payload?: { id?: string }) =>
    callRpc('privacy_cancel_deletion', { p_id: payload?.id ?? null }, () => null),
  );

  // 导出 = 服务端快照 + 本地数据，合成**一个** JSON 落盘。
  //
  // ⚠️ 这里先调 `privacy_request_export`（RPC 自己幂等：已有还能下载的未结单会复用），
  //    再拿**服务端回的 id** 去下载 —— 不接渲染层传来的 id：那个 id 可能是上一单、
  //    也可能已经被驳回/清快照，拿它下载只会拿到 request_not_downloadable。
  //
  // ⚠️ **单飞**：下载要弹系统保存对话框、还要跑十秒级的本地组装。双击（或两个窗口
  //    同时点）会并发跑两遍 —— 服务端幂等所以数据不坏，但用户会看到两个对话框、
  //    主进程叠两次阻塞。跑着的时候再点就共享那一条链（`inFlight` 形状与 Stage 2C 的
  //    relay bootstrap 同款，只是这里**不需要**补跑：用户再点一次本来就会重来）。
  ipcMain.handle('privacy:download-export', () => {
    if (downloadInFlight) return downloadInFlight;
    // ⚠️ 从这一行到 `downloadInFlight = ...` 之间**没有 await** ⇒ 相对其它任务原子：
    //    要么后来者看见 inFlight（于是共享），要么它自己成为 inFlight。
    const run = runDownloadExport().catch((error): IpcResult<DownloadExportResult> => {
      // runDownloadExport 内部已经收敛了所有异常；这一层只是不让"意外泄漏的异常"
      // 变成 IPC 的英文原文穿透到界面。
      console.error('[privacy] download-export failed:', error);
      return { ok: false, errorCode: 'unknown' };
    });
    downloadInFlight = run.finally(() => {
      downloadInFlight = null;
    });
    return downloadInFlight;
  });
}
