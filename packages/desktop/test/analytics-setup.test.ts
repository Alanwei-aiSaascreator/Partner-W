import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rpcMock = vi.fn();
const getPathMock = vi.fn();
const getVersionMock = vi.fn();

vi.mock('electron', () => ({
  app: { getPath: getPathMock, getVersion: getVersionMock },
}));

// 只保留「连没连上商业客户端」这一个语义：连上了就交给我们控制的 rpc
vi.mock('../src/main/commercial/client.js', () => ({
  getCommercialClient: () => ({ rpc: rpcMock }),
}));

vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

/**
 * `setup.ts` 没有导出 sendBatch / withTimeout，所以这里**从行为上**验证它：
 * 拿假定时器把上报周期推着走，看 `analytics_track` 到底被调了几次。
 *
 * 两个被钉住的不变量（都是"静默永久失效"级别的）：
 *   · rpc 永不 settle 时，flush 必须**超时收场** —— 否则单飞标志永久为 true，
 *     这之后每一次 flush（含 60 秒定时器）都是空转，**本进程再也不发任何埋点且不报错**；
 *   · 只有 `invalid_event` / `invalid_payload` 算永久拒绝（丢批），
 *     `rate_limited` 这类临时失败必须留着下次再发（否则一次限流白丢一批数据）。
 *
 * ⚠️ 每个用例都要一份**新的模块实例**：`initAnalyticsReporter` 是模块级单例，
 *    第二次调用会直接返回旧实例（队列/定时器全是上一个用例的）。
 */
const roots: string[] = [];

/** 上报周期（reporter 里的 INTERVAL_MS）与单次发送超时（setup 里的 SEND_TIMEOUT_MS）。 */
const TICK_MS = 60_000;
const SEND_TIMEOUT_MS = 20_000;

async function freshSetup() {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'clawwork-analytics-setup-'));
  roots.push(root);
  getPathMock.mockReturnValue(root); // 队列真的落盘在这个临时目录里
  getVersionMock.mockReturnValue('0.0.0-test');
  return import('../src/main/analytics/setup.js');
}

describe('analytics setup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rpcMock.mockReset();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('★ rpc 永不 settle 时 flush 会超时收场：单飞标志复位，下个周期**还会再发**', async () => {
    rpcMock.mockReturnValue(new Promise(() => {})); // 永不 settle —— 本仓库有过这种挂死
    const { setupAnalytics } = await freshSetup();

    setupAnalytics(); // 入队 app_launch，并起 60 秒定时器

    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(rpcMock).toHaveBeenCalledTimes(1); // 第一次 flush 真的发出去了，只是永远等不到回话

    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS); // 超时到点 ⇒ 这一次 flush 必须收场
    await vi.advanceTimersByTimeAsync(TICK_MS); // 下一个周期

    expect(rpcMock).toHaveBeenCalledTimes(2);
  });

  it('invalid_event 是永久拒绝：丢掉这批，之后不再重试', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'invalid_event' } });
    const { setupAnalytics, teardownAnalytics } = await freshSetup();

    setupAnalytics();
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(rpcMock).toHaveBeenCalledTimes(1);

    // 落库字段名要与迁移 49 的 RPC 参数逐字对上（错一个 PostgREST 直接 404）
    const [fn, args] = rpcMock.mock.calls[0] as [string, { p_events: Array<Record<string, unknown>> }];
    expect(fn).toBe('analytics_track');
    expect(args.p_events).toHaveLength(1);
    expect(args.p_events[0]).toMatchObject({ event: 'app_launch', platform: process.platform });

    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(rpcMock).toHaveBeenCalledTimes(1); // 队列已经空了

    teardownAnalytics();
  });

  it('★ rate_limited 是**临时**失败：条目留在队列里，下个周期继续发', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'rate_limited' } });
    const { setupAnalytics, teardownAnalytics } = await freshSetup();

    setupAnalytics();
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(rpcMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(rpcMock).toHaveBeenCalledTimes(2);

    teardownAnalytics();
  });

  it('★ teardown 会把队列里剩下的发出去（退出前那次 flush 不是摆设）', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'rate_limited' } });
    const { setupAnalytics, teardownAnalytics } = await freshSetup();

    setupAnalytics();
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(rpcMock).toHaveBeenCalledTimes(1); // 限流：条目留在队列里

    rpcMock.mockResolvedValue({ data: 1, error: null });
    teardownAnalytics();
    await vi.advanceTimersByTimeAsync(1); // 让 teardown 里那次 void flush 跑完
    expect(rpcMock).toHaveBeenCalledTimes(2); // 队列已经排空
  });
});
