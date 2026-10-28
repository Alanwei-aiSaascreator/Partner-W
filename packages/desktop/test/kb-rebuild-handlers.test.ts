import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `kb:rebuild` 的 IPC 面（T-c1 第二条）。
 *
 * 这一层只做三件事，但三件都必须钉住：
 *   ① **通道名对得上** —— 渲染层按名字调，写错了只会在真机上炸（单测全绿）；
 *   ② **`not-ready` 要单独回**，不能顺手回一份全 0 的报告。全 0 的报告在界面上
 *      长得跟"重建完了，0 块"一模一样，用户会以为自己那一库资料是空的；
 *   ③ **`skipped: 'no-engine'` 要原样透出去** —— 它是"我**什么都没做**"的唯一信号，
 *      界面靠它说"没有可用的嵌入模型，重建会丢掉现有向量，已跳过"，而不是报"重建完成"。
 *
 * ⚠️ 与 `analytics-handlers.test.ts` 同款：把 electron 的 `ipcMain.handle` 收进一张表，
 *    直接调注册进来的函数。真实的 `getKbRuntime` 是进程单例、还要读 90MB 模型，
 *    这一层不该被它拖住 —— 所以连运行时一起桩掉，被测的只有"转发与包装"。
 */
const handleMap = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handleMap.set(channel, handler)),
  },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn() },
}));

const getKbRuntime = vi.fn();
vi.mock('../src/main/kb/runtime.js', () => ({
  getKbRuntime: () => getKbRuntime(),
}));

import { registerKbHandlers } from '../src/main/ipc/kb-handlers.js';

function call(params?: unknown): Promise<unknown> {
  const fn = handleMap.get('kb:rebuild');
  if (!fn) throw new Error('没有注册 kb:rebuild 这个通道');
  return Promise.resolve(fn({}, params));
}

const REPORT = { sources: 2, chunks: 40, attempted: 40, embedded: 40, failed: 0, engineError: null };

describe('kb:rebuild IPC', () => {
  beforeEach(() => {
    handleMap.clear();
    getKbRuntime.mockReset();
    registerKbHandlers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runtime 没就绪 ⇒ not-ready（**不是**一份全 0 的报告）', async () => {
    getKbRuntime.mockReturnValue(null);

    const reply = (await call()) as { ok: boolean; code?: string };

    expect(reply.ok).toBe(false);
    expect(reply.code, '全 0 的报告在界面上和"重建完了 0 块"长得一样').toBe('not-ready');
    expect(reply, 'not-ready 时不该带 report').not.toHaveProperty('report');
  });

  it('成功 ⇒ 把 rebuild 的报告原样回给渲染层', async () => {
    const rebuild = vi.fn(async () => REPORT);
    getKbRuntime.mockReturnValue({ service: { rebuild } });

    await expect(call()).resolves.toEqual({ ok: true, report: REPORT });
    expect(rebuild).toHaveBeenCalledWith(undefined);
  });

  it('带了资料 id ⇒ 原样透传给服务（单份资料重建）', async () => {
    const rebuild = vi.fn(async () => REPORT);
    getKbRuntime.mockReturnValue({ service: { rebuild } });

    await call({ sourceId: 'src-1' });

    expect(rebuild).toHaveBeenCalledWith('src-1');
  });

  it("'no-engine' 的跳过信号要原样透出去（界面靠它说实话）", async () => {
    const skipped = {
      sources: 0,
      chunks: 0,
      attempted: 0,
      embedded: 0,
      failed: 0,
      engineError: null,
      skipped: 'no-engine',
    };
    getKbRuntime.mockReturnValue({ service: { rebuild: vi.fn(async () => skipped) } });

    const reply = (await call()) as { ok: boolean; report: { skipped?: string } };

    expect(reply.ok).toBe(true);
    expect(reply.report.skipped, '吞掉它，界面就会把"什么都没做"说成"重建完成"').toBe('no-engine');
  });

  it('服务抛错 ⇒ 包成 ok:false + 可读消息，不让异常穿到 IPC 层', async () => {
    getKbRuntime.mockReturnValue({
      service: {
        rebuild: vi.fn(async () => {
          throw new Error('database is locked');
        }),
      },
    });

    await expect(call()).resolves.toEqual({ ok: false, error: 'database is locked' });
  });
});
