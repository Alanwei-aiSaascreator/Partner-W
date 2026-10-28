/**
 * M3（BUG-034）renderer 侧合同：画像保存成功后的 session DOMStorage 刷新请求。
 *
 * 覆盖（先 RED 后实现）：
 *  - 成功路径：请求口**恰好一次**、**不传参数**（渠道不收 partition/path），诊断记 `requested:true`；
 *  - 明确失败（如主进程判非受信 sender）：`errorCode` 原样透传，**绝不**冒充成功；
 *  - 请求口同步抛错 / promise reject：绝不外抛、绝不留悬空拒绝，留诊断；
 *  - 回执形状残缺（`ok:true` 但没有 `requested:true`）：按"未发起"处理，不当成功；
 *  - 无桥（老 preload / 测试桩 / node）：静默降级，不抛；
 *  - 默认出口 = `window.clawwork.requestProfileStorageFlush`（`this` 绑定 bridge）+ 默认诊断出口；
 *  - 匿名：诊断只落账号指纹，不含明文 userId。
 *
 * ⚠️ `requested:true` 只代表"已发起刷新请求"——Electron 34 `flushStorageData()` 是 void，
 *    没有物理落盘回执。本档断言的是**调用/诊断事实**，不是落盘成功；不许拿它当 durability 保证。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  anonymousAccountFingerprint,
  reportOnboardingProfileFlush,
  requestOnboardingProfileStorageFlush,
  type ProfileStorageFlushRequest,
} from '../src/renderer/lib/user-onboarding';

type ReportEvent = { domain: string; event: string; data?: Record<string, unknown> };

/** 等实现里的 `.then` 诊断链落地（异步回执走微任务；用宏任务兜底）。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requestOnboardingProfileStorageFlush（保存成功后的刷新请求）', () => {
  it('成功路径：请求口恰好一次、无参数，诊断记 requested:true（只落匿名指纹）', async () => {
    const report = vi.fn<(event: ReportEvent) => void>();
    const request = vi.fn<ProfileStorageFlushRequest>(async () => ({ ok: true, result: { requested: true } }));
    requestOnboardingProfileStorageFlush('user-secret-id', { source: 'entry-complete', request, report });
    expect(request).toHaveBeenCalledTimes(1);
    // 渠道无参数：不收 partition/path —— 目标 session 只由主进程从 sender 解析。
    expect(request).toHaveBeenCalledWith();
    // 回执是异步的：同步段不许抢报"已刷新"。
    expect(report).not.toHaveBeenCalled();
    await settle();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]![0]).toMatchObject({
      domain: 'renderer',
      event: 'onboarding.profile.flush',
      data: {
        ok: true,
        requested: true,
        source: 'entry-complete',
        account: anonymousAccountFingerprint('user-secret-id'),
      },
    });
    expect(JSON.stringify(report.mock.calls)).not.toContain('user-secret-id');
  });

  it('主进程明确失败（非受信 sender）：错误码原样透传，不冒充成功', async () => {
    const report = vi.fn<(event: ReportEvent) => void>();
    const request = vi.fn(async () => ({
      ok: false,
      error: 'untrusted sender',
      errorCode: 'profile-flush-untrusted-sender',
    }));
    requestOnboardingProfileStorageFlush('user-1', { request, report });
    await settle();
    expect(report.mock.calls[0]![0].data).toMatchObject({
      ok: false,
      errorCode: 'profile-flush-untrusted-sender',
      account: anonymousAccountFingerprint('user-1'),
    });
  });

  it('ok:true 但缺 requested:true 的回执：按未发起处理，不当成功', async () => {
    const report = vi.fn<(event: ReportEvent) => void>();
    const request = vi.fn(async () => ({ ok: true }));
    requestOnboardingProfileStorageFlush('user-1', { request, report });
    await settle();
    expect(report.mock.calls[0]![0].data).toMatchObject({ ok: false, errorCode: 'profile-flush-not-requested' });
  });

  it('请求口同步抛错：绝不外抛，同步留诊断（errorCode=profile-flush-request-threw）', () => {
    const report = vi.fn<(event: ReportEvent) => void>();
    const request = vi.fn(() => {
      throw new DOMException('no bridge', 'NotSupportedError');
    });
    expect(() => requestOnboardingProfileStorageFlush('user-1', { request, report })).not.toThrow();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]![0].data).toMatchObject({
      ok: false,
      errorCode: 'profile-flush-request-threw',
      errorKind: 'NotSupportedError',
    });
  });

  it('promise reject：绝不外抛、不留悬空拒绝，留诊断（errorCode=profile-flush-rejected）', async () => {
    const report = vi.fn<(event: ReportEvent) => void>();
    const request = vi.fn(() => Promise.reject(new DOMException('ipc gone', 'Error')));
    requestOnboardingProfileStorageFlush('user-1', { request, report });
    await settle();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]![0].data).toMatchObject({ ok: false, errorCode: 'profile-flush-rejected' });
  });

  it('无桥（老 preload / 测试桩 / node）：静默降级，不抛、不报', () => {
    vi.stubGlobal('window', {});
    const report = vi.fn<(event: ReportEvent) => void>();
    expect(() => requestOnboardingProfileStorageFlush('user-1', { report })).not.toThrow();
    expect(report).not.toHaveBeenCalled();
  });

  it('默认出口 = window.clawwork.requestProfileStorageFlush（this 绑定 bridge），诊断走默认出口', async () => {
    let observedThis: unknown = 'unset';
    const bridge = {
      marker: 'bridge',
      requestProfileStorageFlush(this: unknown) {
        observedThis = (this as { marker?: string }).marker;
        return Promise.resolve({ ok: true, result: { requested: true } });
      },
      reportDebugEvent: vi.fn<(event: ReportEvent) => void>(),
    };
    vi.stubGlobal('window', { clawwork: bridge });
    requestOnboardingProfileStorageFlush('user-1', { source: 'entry-complete' });
    // 未 bind 时 this=undefined —— 本断言是绑定行为的直接反例。
    expect(observedThis).toBe('bridge');
    await settle();
    expect(bridge.reportDebugEvent).toHaveBeenCalledTimes(1);
    expect(bridge.reportDebugEvent.mock.calls[0]![0].data).toMatchObject({
      ok: true,
      requested: true,
      source: 'entry-complete',
    });
  });
});

describe('reportOnboardingProfileFlush（诊断出口）', () => {
  it('成功报 requested:true；失败报 errorCode（+可选异常名），账号只落指纹', () => {
    const sink = vi.fn<(event: ReportEvent) => void>();
    expect(reportOnboardingProfileFlush({ ok: true, requested: true }, 'user-1', { report: sink })).toBe(true);
    expect(sink.mock.calls[0]![0]).toMatchObject({
      domain: 'renderer',
      event: 'onboarding.profile.flush',
      data: { ok: true, requested: true, account: anonymousAccountFingerprint('user-1') },
    });
    const failSink = vi.fn<(event: ReportEvent) => void>();
    reportOnboardingProfileFlush({ ok: false, errorCode: 'profile-flush-failed', errorKind: 'Error' }, 'user-1', {
      report: failSink,
    });
    expect(failSink.mock.calls[0]![0].data).toMatchObject({
      ok: false,
      errorCode: 'profile-flush-failed',
      errorKind: 'Error',
    });
  });

  it('出口缺失或抛错：返回 false，绝不外抛', () => {
    expect(reportOnboardingProfileFlush({ ok: true, requested: true }, 'user-1', { report: null })).toBe(false);
    const throwing = vi.fn(() => {
      throw new Error('sink exploded');
    });
    expect(reportOnboardingProfileFlush({ ok: true, requested: true }, 'user-1', { report: throwing })).toBe(false);
  });
});
