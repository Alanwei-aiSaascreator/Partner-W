import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 隐私工单的 IPC 层（P4 Task 13）。
 *
 * 这一层只做四件事，各自都有必须钉住的理由：
 *   ① **没有登录态时必须给 `not_authenticated`**，而不是让异常穿透 IPC
 *      （穿透的表现是 renderer 里一句 "Error invoking remote method"）；
 *   ② **RPC 的异常要收敛成错误码**（网络挂了给 `network`，别把英文原文带出去）；
 *   ③ 参数名要翻：renderer 传驼峰，RPC 只认 `p_*`；
 *   ④ `privacy_my_state` 的返回**必须过 core 的归一化**（snake→camel、
 *      `snapshot_bytes` 字符串→数字、`cancellable` 只认真布尔）—— 渲染层
 *      直接读 camelCase，漏了归一化界面上就是一片 undefined。
 *
 * ⚠️ 权限/冷却期/状态机**不在这里测** —— 那是数据库 definer RPC 的职责
 *    （`scripts/tests/privacy.sql`）。这里再实现一遍只会造出第二套真相。
 */
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  rpc: vi.fn(),
  client: null as null | { rpc: (...args: unknown[]) => unknown },
  buildLocal: vi.fn(),
  saveJson: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, fn);
    },
  },
}));

vi.mock('../src/main/commercial/client.js', () => ({
  getCommercialClient: () => mocks.client,
}));

vi.mock('../src/main/privacy/export-local.js', () => ({
  buildLocalExport: mocks.buildLocal,
  saveExportFile: mocks.saveJson,
}));

import { registerPrivacyHandlers } from '../src/main/ipc/privacy-handlers.js';

function call(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = mocks.handlers.get(channel);
  if (!fn) throw new Error(`no handler registered for ${channel}`);
  return Promise.resolve(fn({}, ...args));
}

type Result = { ok: boolean; result?: unknown; errorCode?: string };

describe('privacy IPC handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.client = { rpc: mocks.rpc };
    mocks.buildLocal.mockResolvedValue({ tasks: [], messages: [] });
    registerPrivacyHandlers();
  });

  it('未登录（拿不到商业客户端）⇒ not_authenticated，且不抛异常', async () => {
    mocks.client = null;
    for (const channel of [
      'privacy:state',
      'privacy:request-export',
      'privacy:request-deletion',
      'privacy:cancel-deletion',
      'privacy:download-export',
    ]) {
      const res = (await call(channel)) as Result;
      expect(res.ok, channel).toBe(false);
      expect(res.errorCode, channel).toBe('not_authenticated');
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('state 过 core 的归一化：snake→camel、字节数字、cancellable 只认真布尔', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        export: {
          id: 'e1',
          status: 'ready',
          requested_at: '2026-09-18T00:00:00Z',
          // PostgREST 会把 int 序列化成字符串
          snapshot_bytes: '2048',
        },
        deletion: {
          id: 'd1',
          status: 'pending',
          requested_at: '2026-09-18T00:00:00Z',
          scheduled_for: '2026-09-25T00:00:00Z',
          cancellable: true,
        },
      },
      error: null,
    });

    const res = (await call('privacy:state')) as Result;
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({
      export: {
        id: 'e1',
        status: 'ready',
        requestedAt: '2026-09-18T00:00:00Z',
        snapshotBytes: 2048,
      },
      deletion: {
        id: 'd1',
        status: 'pending',
        requestedAt: '2026-09-18T00:00:00Z',
        scheduledFor: '2026-09-25T00:00:00Z',
        cancellable: true,
      },
    });
  });

  it('state 的脏数据降级成 unknown / null，不把哨兵值透给界面', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        export: { id: 'e1', status: 'weird', requested_at: null, snapshot_bytes: 'abc' },
        deletion: { status: 'pending', cancellable: 'true' },
      },
      error: null,
    });

    const res = (await call('privacy:state')) as Result;
    expect(res.result).toEqual({
      export: { id: 'e1', status: 'unknown', requestedAt: '', snapshotBytes: null },
      // 没有 id 的删除单 = 脏行，整体丢弃
      deletion: null,
    });
  });

  it('参数名翻成 p_*', async () => {
    mocks.rpc.mockResolvedValue({ data: { id: 'r1', status: 'pending' }, error: null });

    await call('privacy:request-deletion', { reason: '不想用了' });
    expect(mocks.rpc).toHaveBeenCalledWith('privacy_request_deletion', { p_reason: '不想用了' });

    await call('privacy:cancel-deletion', { id: 'd1' });
    expect(mocks.rpc).toHaveBeenCalledWith('privacy_cancel_deletion', { p_id: 'd1' });
  });

  it('参数缺省时也发合法 RPC（不把 undefined 塞进 params）', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });

    await call('privacy:request-deletion');
    expect(mocks.rpc).toHaveBeenCalledWith('privacy_request_deletion', { p_reason: '' });

    await call('privacy:cancel-deletion');
    expect(mocks.rpc).toHaveBeenCalledWith('privacy_cancel_deletion', { p_id: null });
  });

  it('导出：先取服务端快照，再与本地数据合并写文件', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: { id: 'e1', status: 'ready' }, error: null })
      .mockResolvedValueOnce({ data: { account: { id: 'u1' } }, error: null });
    mocks.saveJson.mockResolvedValue('exports/export.json');

    const res = (await call('privacy:download-export', { id: 'e1' })) as Result;

    expect(res.ok).toBe(true);
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'privacy_request_export', {});
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'privacy_export_download', { p_id: 'e1' });
    expect(mocks.buildLocal).toHaveBeenCalledTimes(1);
    expect(mocks.saveJson).toHaveBeenCalledTimes(1);
    expect(res.result).toEqual({ path: 'exports/export.json' });

    // 落盘的必须是**一个** JSON：服务端快照 + 本地数据，且带格式版本号
    const [payload] = mocks.saveJson.mock.calls[0] as [Record<string, unknown>];
    expect(payload.format).toBe('rongying-mofang-export@1');
    expect(payload.server).toEqual({ account: { id: 'u1' } });
    expect(payload.local).toEqual({ tasks: [], messages: [] });
    expect(typeof payload.exported_at).toBe('string');
  });

  it('导出：服务端快照拿不到 ⇒ 不落盘，错误码原样带出', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: { id: 'e1', status: 'ready' }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'snapshot_missing' } });

    const res = (await call('privacy:download-export')) as Result;

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('snapshot_missing');
    expect(mocks.buildLocal).not.toHaveBeenCalled();
    expect(mocks.saveJson).not.toHaveBeenCalled();
  });

  it('导出：申请那一步失败（超限）⇒ 不落盘，码原样带出', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'export_too_large' } });

    const res = (await call('privacy:download-export')) as Result;

    expect(res.errorCode).toBe('export_too_large');
    expect(mocks.saveJson).not.toHaveBeenCalled();
  });

  it('导出：申请成功但没回 id ⇒ unknown，绝不拿空 id 去下载', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { status: 'ready' }, error: null });

    const res = (await call('privacy:download-export')) as Result;

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('unknown');
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('用户在保存对话框点了取消 ⇒ cancelled（不是 network，界面要安静收场）', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: { id: 'e1', status: 'ready' }, error: null })
      .mockResolvedValueOnce({ data: { account: { id: 'u1' } }, error: null });
    mocks.saveJson.mockRejectedValue(new Error('cancelled'));

    const res = (await call('privacy:download-export')) as Result;

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('cancelled');
  });

  it('本地组装或落盘抛异常 ⇒ network，不让异常穿透 IPC', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: { id: 'e1', status: 'ready' }, error: null })
      .mockResolvedValueOnce({ data: { account: { id: 'u1' } }, error: null });
    mocks.buildLocal.mockRejectedValue(new Error('EACCES: disk on fire'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = (await call('privacy:download-export')) as Result;

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('network');
    expect(mocks.saveJson).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('英文长句错误一律压成 unknown —— 绝不让英文穿透到 toast', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'duplicate key value violates unique constraint "privacy_requests_open_idx"' },
    });

    const res = (await call('privacy:request-export')) as Result;

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('unknown');
  });

  it('RPC 直接抛异常 ⇒ network（含非 Error 抛出物）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.rpc.mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED'));
    expect(((await call('privacy:state')) as Result).errorCode).toBe('network');

    mocks.rpc.mockRejectedValueOnce('boom');
    expect(((await call('privacy:state')) as Result).errorCode).toBe('network');
    errorSpy.mockRestore();
  });

  it('成功时原样带回 RPC 结果（撤回删除给 null）', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: null });
    const res = (await call('privacy:cancel-deletion', { id: 'd1' })) as Result;
    expect(res.ok).toBe(true);
    expect(res.result).toBeNull();
  });

  it('通道名单与 preload 约定一致', () => {
    expect([...mocks.handlers.keys()].sort()).toEqual([
      'privacy:cancel-deletion',
      'privacy:download-export',
      'privacy:request-deletion',
      'privacy:request-export',
      'privacy:state',
    ]);
  });
});
