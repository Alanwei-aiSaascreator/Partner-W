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
  /** 换成会抛的工厂，钉"客户端构造失败不许穿透 IPC"（F4）。 */
  clientFactory: null as null | (() => unknown),
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
  getCommercialClient: () => (mocks.clientFactory ? mocks.clientFactory() : mocks.client),
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

/** 本地组装的最小真实形状（含 `meta` / `notes`：下载的返回要靠它们带截断信息）。 */
function localExport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tasks: [],
    sessions: [],
    messages: [],
    artifacts: [],
    settings: null,
    meta: { counts: { tasks: 0, sessions: 0, messages: 0, artifacts: 0 }, limits: {}, truncated: false },
    notes: [],
    ...overrides,
  };
}

describe('privacy IPC handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` 只清调用记录，**不清** `mockResolvedValue` 这类实现
    // （上一条用例留下的默认实现会漏到下一条，让断言数对不上）
    mocks.rpc.mockReset();
    mocks.handlers.clear();
    mocks.client = { rpc: mocks.rpc };
    mocks.clientFactory = null;
    mocks.buildLocal.mockResolvedValue(localExport());
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
    // 返回形状：路径 + 截断信息（R3 —— 只回 path 的话界面提示不出"这不是完整历史"）
    expect(res.result).toEqual({ path: 'exports/export.json', truncated: false, notes: [] });

    // 落盘的必须是**一个** JSON：服务端快照 + 本地数据，且带格式版本号
    const [payload] = mocks.saveJson.mock.calls[0] as [Record<string, unknown>];
    expect(payload.format).toBe('rongying-mofang-export@1');
    expect(payload.server).toEqual({ account: { id: 'u1' } });
    expect(payload.local).toEqual(localExport());
    expect(typeof payload.exported_at).toBe('string');
  });

  it('导出：本地那份被截断 ⇒ truncated / notes 一起回给界面（R3）', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: { id: 'e1', status: 'ready' }, error: null })
      .mockResolvedValueOnce({ data: { account: { id: 'u1' } }, error: null });
    mocks.saveJson.mockResolvedValue('exports/export.json');
    mocks.buildLocal.mockResolvedValue(
      localExport({
        meta: {
          counts: { tasks: 1, sessions: 1, messages: 500_001, artifacts: 0 },
          limits: { maxMessages: 500_000, maxBytes: 200 },
          truncated: true,
        },
        notes: ['本地消息共 500001 条，超过上限 500000 条：本次只导出计数与索引'],
      }),
    );

    const res = (await call('privacy:download-export')) as Result;

    expect(res.ok).toBe(true);
    expect(res.result).toEqual({
      path: 'exports/export.json',
      truncated: true,
      notes: ['本地消息共 500001 条，超过上限 500000 条：本次只导出计数与索引'],
    });
  });

  it('导出：本地那份缺 meta/notes 也不许炸（边界防御，最坏退化成"未截断 + 无说明"）', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: { id: 'e1', status: 'ready' }, error: null })
      .mockResolvedValueOnce({ data: { account: { id: 'u1' } }, error: null });
    mocks.saveJson.mockResolvedValue('exports/export.json');
    mocks.buildLocal.mockResolvedValue({ tasks: [], messages: [] });

    const res = (await call('privacy:download-export')) as Result;

    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ path: 'exports/export.json', truncated: false, notes: [] });
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

  it('本地组装抛异常（读库失败）⇒ local_export_failed，**不是 network**', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: { id: 'e1', status: 'ready' }, error: null })
      .mockResolvedValueOnce({ data: { account: { id: 'u1' } }, error: null });
    mocks.buildLocal.mockRejectedValue(new Error('SQLITE_IOERR: disk I/O error'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = (await call('privacy:download-export')) as Result;

    expect(res.ok).toBe(false);
    // 说成 network 会让用户去反复重试网络，而真正该做的是换保存位置/清磁盘
    expect(res.errorCode).toBe('local_export_failed');
    expect(mocks.saveJson).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('落盘失败（磁盘满 / 无权限）⇒ local_export_failed，而 RPC 失败仍是 network', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mocks.rpc
      .mockResolvedValueOnce({ data: { id: 'e1', status: 'ready' }, error: null })
      .mockResolvedValueOnce({ data: { account: { id: 'u1' } }, error: null });
    mocks.saveJson.mockRejectedValue(new Error('ENOSPC: no space left on device'));

    const writeFailure = (await call('privacy:download-export')) as Result;
    expect(writeFailure.errorCode).toBe('local_export_failed');

    // 对照：RPC 那一步挂掉仍然是 network（两件事不许合并）
    mocks.rpc.mockReset();
    mocks.rpc.mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED'));
    const rpcFailure = (await call('privacy:download-export')) as Result;
    expect(rpcFailure.errorCode).toBe('network');

    errorSpy.mockRestore();
  });

  it('RPC 客户端构造就抛（URL 非法）⇒ 干净的错误码，不让英文原文穿透 IPC', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.client = null;
    mocks.clientFactory = () => {
      throw new Error('Invalid supabaseUrl: Must be a valid HTTP or HTTPS URL.');
    };

    for (const channel of [
      'privacy:state',
      'privacy:request-export',
      'privacy:request-deletion',
      'privacy:cancel-deletion',
      'privacy:download-export',
    ]) {
      const res = (await call(channel)) as Result;
      expect(res.ok, channel).toBe(false);
      // 之前这个异常直接穿透 IPC ⇒ 渲染层看到 "Error invoking remote method ... Invalid supabaseUrl"
      expect(res.errorCode, channel).toBe('unknown');
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('导出单飞：并发两次只跑一次（一次 RPC 序列 + 一个保存对话框），跑完能再来一次', async () => {
    mocks.rpc.mockResolvedValue({ data: { id: 'e1', account: { id: 'u1' } }, error: null });
    mocks.saveJson.mockResolvedValue('exports/export.json');

    // 同一个 tick 内点两次 = 双击（对话框弹之前就并发进来了）
    const first = call('privacy:download-export');
    const second = call('privacy:download-export');
    const [a, b] = (await Promise.all([first, second])) as [Result, Result];

    expect(mocks.rpc).toHaveBeenCalledTimes(2); // request + download，不是 4
    expect(mocks.buildLocal).toHaveBeenCalledTimes(1);
    expect(mocks.saveJson).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);

    // 守卫必须被释放：跑完之后再点一次要能重新跑（否则导出就永久坏了）
    const third = (await call('privacy:download-export')) as Result;
    expect(third.ok).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledTimes(4);
    expect(mocks.saveJson).toHaveBeenCalledTimes(2);
  });

  it('导出单飞：前一次失败之后也放行（不把用户锁死）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.rpc
      .mockResolvedValueOnce({ data: { id: 'e1', status: 'ready' }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'snapshot_missing' } })
      .mockResolvedValueOnce({ data: { id: 'e2', status: 'ready' }, error: null })
      .mockResolvedValueOnce({ data: { account: { id: 'u1' } }, error: null });
    mocks.saveJson.mockResolvedValue('exports/export.json');

    const failed = (await call('privacy:download-export')) as Result;
    expect(failed.errorCode).toBe('snapshot_missing');

    const retried = (await call('privacy:download-export')) as Result;
    expect(retried.ok).toBe(true);
    // 两次各自跑完整的 2 步（request + download）—— 失败那次没有把守卫焊死
    expect(mocks.rpc).toHaveBeenCalledTimes(4);
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
