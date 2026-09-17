import { ipcMain } from 'electron';
import type { IpcResult } from '@clawwork/shared';
import { getCommercialClient } from '../commercial/client.js';

/**
 * 广场 / 团队的 IPC。
 *
 * 复用 `commercial/client.ts` 那条已登录的 Supabase 会话（同一份 JWT、
 * 同一个加密存储），不另建客户端 —— **权限判定全部在数据库的 definer RPC 里**
 * （`scripts/tests/community_team.sql` 逐条钉过），这一层只负责：
 * 参数改名、异常收敛成错误码、绝不让异常穿透 IPC。
 *
 * 返回值约定与 `commercial:*` 一致：`{ok:true, result}` / `{ok:false, errorCode}`。
 *
 * ⚠️ 字段名的翻译规则（有意的不对称，别"顺手统一"）：
 *    · **单对象**（点赞 / 建码 / 加入）在这一层翻成驼峰 DTO；
 *    · **列表**（feed / 成员 / 评论 / 邀请码）保持后端原样，
 *      由 core 的 normalizer 归一，preload 的类型老实写 `unknown[]`。
 *    列表在这里翻一遍等于把 normalizer 抄第二遍，两处会漂。
 */

interface RpcLike {
  rpc: (fn: string, params?: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }>;
}

/**
 * Postgres 抛出的 `raise exception 'post_not_found'` 走到这里就是 message 本身。
 * 只放行**裸机器码**：英文长句（比如约束冲突的原文）一律压成 `unknown`，
 * 免得它顺着 toast 摆到用户面前。
 */
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
    console.error(`[community] ${fn} failed:`, error);
    return { ok: false, errorCode: 'network' };
  }
}

const rows = (data: unknown): unknown[] => (Array.isArray(data) ? data : data == null ? [] : [data]);
const firstRow = (data: unknown): unknown => rows(data)[0] ?? null;

function asRecord(data: unknown): Record<string, unknown> {
  const row = firstRow(data);
  return row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
}
const asNumber = (value: unknown): number => (typeof value === 'number' ? value : Number(value) || 0);
const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

export function registerCommunityHandlers(): void {
  ipcMain.handle('community:info', () => callRpc('team_current', {}, (data) => firstRow(data)));

  ipcMain.handle('community:members', () => callRpc('team_members', {}, (data) => rows(data)));

  ipcMain.handle('community:switch-team', (_e, payload: { orgId?: string }) =>
    callRpc('team_switch', { p_org_id: payload?.orgId ?? null }, () => null),
  );

  ipcMain.handle('community:feed', (_e, payload?: { limit?: number; before?: string | null }) =>
    callRpc('community_feed', { p_limit: payload?.limit ?? 20, p_before: payload?.before ?? null }, (data) =>
      rows(data),
    ),
  );

  ipcMain.handle('community:post-create', (_e, payload: { body?: string; visibility?: string }) =>
    callRpc(
      'community_post_create',
      { p_body: payload?.body ?? '', p_visibility: payload?.visibility ?? 'org' },
      (data) => firstRow(data),
    ),
  );

  ipcMain.handle('community:post-delete', (_e, payload: { postId?: string }) =>
    callRpc('community_post_delete', { p_post_id: payload?.postId ?? null }, () => null),
  );

  ipcMain.handle('community:comments', (_e, payload: { postId?: string; limit?: number }) =>
    callRpc('community_comments', { p_post_id: payload?.postId ?? null, p_limit: payload?.limit ?? 50 }, (data) =>
      rows(data),
    ),
  );

  ipcMain.handle('community:comment-add', (_e, payload: { postId?: string; body?: string }) =>
    callRpc('community_comment_add', { p_post_id: payload?.postId ?? null, p_body: payload?.body ?? '' }, (data) =>
      firstRow(data),
    ),
  );

  ipcMain.handle('community:like-toggle', (_e, payload: { postId?: string }) =>
    callRpc('community_like_toggle', { p_post_id: payload?.postId ?? null }, (data) => {
      const row = asRecord(data);
      return { liked: row.liked === true, likeCount: asNumber(row.like_count) };
    }),
  );

  ipcMain.handle(
    'community:invite-create',
    (_e, payload: { role?: string; maxUses?: number; expiresInHours?: number }) =>
      callRpc(
        'team_invite_create',
        {
          p_role: payload?.role ?? 'member',
          p_max_uses: payload?.maxUses ?? 1,
          p_expires_in_hours: payload?.expiresInHours ?? 72,
        },
        (data) => {
          const row = asRecord(data);
          return { code: asString(row.code), expiresAt: asString(row.expires_at) };
        },
      ),
  );

  ipcMain.handle('community:invite-list', () => callRpc('team_invite_list', {}, (data) => rows(data)));

  ipcMain.handle('community:invite-revoke', (_e, payload: { id?: string }) =>
    callRpc('team_invite_revoke', { p_id: payload?.id ?? null }, () => null),
  );

  ipcMain.handle('community:join', (_e, payload: { code?: string }) =>
    callRpc('team_join_with_code', { p_code: payload?.code ?? '' }, (data) => {
      const row = asRecord(data);
      return { orgId: asString(row.org_id), orgName: asString(row.org_name), role: row.role ?? 'member' };
    }),
  );

  ipcMain.handle('community:member-set-role', (_e, payload: { userId?: string; role?: string }) =>
    callRpc(
      'team_member_set_role',
      { p_user_id: payload?.userId ?? null, p_role: payload?.role ?? 'member' },
      () => null,
    ),
  );

  ipcMain.handle('community:member-remove', (_e, payload: { userId?: string }) =>
    callRpc('team_member_remove', { p_user_id: payload?.userId ?? null }, () => null),
  );

  ipcMain.handle('community:leave', () => callRpc('team_leave', {}, () => null));
}
