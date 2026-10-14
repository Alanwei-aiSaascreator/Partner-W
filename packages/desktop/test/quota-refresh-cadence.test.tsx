// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QUOTA_BUSY_POLL_MS,
  QUOTA_FOLLOW_UP_MAX,
  QUOTA_FOLLOW_UP_MS,
  QUOTA_SETTLE_MS,
  useQuotaRefreshOnTurnEnd,
} from '../src/renderer/hooks/useQuotaRefreshOnTurnEnd';
import { useMessageStore } from '../src/renderer/stores/messageStore';
import { useCommercialStore } from '../src/renderer/stores/commercialStore';

/**
 * BUG-082（C-B §2）：余额的**主动刷新调度**。
 *
 * 要锁住的性质：
 *   · 消费进行中（busy）+ 界面可见 ⇒ 有界节奏刷新（不是无限轮询，也不是只在回合结束）
 *   · 回合结束仍然"先上报用量、再拉额度"（顺序纪律，别在重构里丢掉）
 *   · "响应结束早于入账"窗口 ⇒ **有界追读**，值一变就停
 *   · 失败退避（有界），不把服务端打爆
 *   · 窗口不可见 ⇒ 不打点；回前台 ⇒ 立刻补一次
 *   · 登出/切号 ⇒ 旧调度全停
 */

function quotaResult(usedMicros: number) {
  return {
    ok: true as const,
    result: {
      license: {
        activated: true,
        licenseId: 'l1',
        orgId: 'o1',
        licenseKey: 'RY-1',
        sku: 's',
        status: 'active',
        expiresAt: null,
        tokenQuotaMicros: 1_000_000_000,
        tokenUsedMicros: usedMicros,
      },
      org: { id: 'o1', name: 'org', plan: 'pro', role: 'owner' },
      fetchedAt: '2026-10-15T10:00:00.000Z',
    },
  };
}

function seededOverview() {
  return {
    account: { userId: 'u1', phone: null, email: null, nickname: null, avatar: null },
    org: { id: 'o1', name: 'org', plan: 'pro', role: 'owner' },
    license: quotaResult(100_000_000).result.license,
    device: { fingerprint: 'fp', shortFingerprint: 'fp' },
    fetchedAt: '2026-10-15T09:00:00.000Z',
  };
}

function Probe() {
  useQuotaRefreshOnTurnEnd();
  return null;
}

let container: HTMLDivElement;
let root: Root;
let calls: string[];
let usedMicros: number;
let quotaOk: boolean;

function setDocumentVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  usedMicros = 100_000_000;
  quotaOk = true;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  (globalThis as unknown as { window: Window }).window.clawwork = {
    commercialUsageReport: vi.fn(async () => {
      calls.push('report');
      return 0;
    }),
    commercialQuotaSnapshot: vi.fn(async () => {
      calls.push('quota');
      return quotaOk ? quotaResult(usedMicros) : { ok: false, error: 'network down' };
    }),
  } as unknown as Window['clawwork'];

  useCommercialStore.setState({ overview: seededOverview() as never, status: 'ready', errorMessage: '' });
  useMessageStore.setState({ processingBySession: new Set<string>() });

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setDocumentVisibility('visible');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setBusy(busy: boolean) {
  act(() => {
    useMessageStore.setState({ processingBySession: busy ? new Set(['sess-1']) : new Set<string>() });
  });
}

async function flush(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('消费进行中的有界主动刷新（BUG-082）', () => {
  it('⭐ 消费进行中（busy）时按节奏刷新 —— 不必等回合结束', async () => {
    act(() => root.render(<Probe />));
    setBusy(true);
    await flush(100);
    expect(calls).toEqual([]);

    await flush(QUOTA_BUSY_POLL_MS + 50);
    expect(calls).toEqual(['quota']);

    await flush(QUOTA_BUSY_POLL_MS);
    expect(calls).toEqual(['quota', 'quota']);
  });

  it('⭐ 空闲时不做任何轮询（会长任务之外没有请求）', async () => {
    act(() => root.render(<Probe />));
    await flush(QUOTA_BUSY_POLL_MS * 6);
    expect(calls).toEqual([]);
  });

  it('⭐ 回合结束：先上报用量、再拉额度（顺序纪律不变）', async () => {
    act(() => root.render(<Probe />));
    setBusy(true);
    await flush(100);
    setBusy(false);

    await flush(QUOTA_SETTLE_MS + 50);
    expect(calls.slice(0, 2)).toEqual(['report', 'quota']);
  });

  it('⭐ 有界追读：账本晚到（值没变）会追几次，但**有上限**，不是无限轮询', async () => {
    act(() => root.render(<Probe />));
    setBusy(true);
    await flush(100);
    setBusy(false);

    await flush(QUOTA_SETTLE_MS + 50);
    expect(calls).toEqual(['report', 'quota']);

    // 账本一直没提交（服务端还是旧值）⇒ 追读
    await flush(QUOTA_FOLLOW_UP_MS * QUOTA_FOLLOW_UP_MAX + 50);
    expect(calls.filter((call) => call === 'quota').length).toBe(1 + QUOTA_FOLLOW_UP_MAX);

    // 追读次数用尽 ⇒ 停下；期间不再有第二次用量上报
    const settled = calls.length;
    await flush(QUOTA_FOLLOW_UP_MS * QUOTA_FOLLOW_UP_MAX);
    expect(calls.length).toBe(settled);
    expect(calls.filter((call) => call === 'report').length).toBe(1);
  });

  it('⭐ 追读在读到新值后立刻停止（已结算就不再多打）', async () => {
    act(() => root.render(<Probe />));
    setBusy(true);
    await flush(100);
    setBusy(false);

    await flush(QUOTA_SETTLE_MS + 50); // 第一次读到旧值
    expect(calls.filter((call) => call === 'quota').length).toBe(1);

    usedMicros = 130_000_000; // 账本提交了
    await flush(QUOTA_FOLLOW_UP_MS + 50); // 追读一次 → 值变了
    expect(calls.filter((call) => call === 'quota').length).toBe(2);

    await flush(QUOTA_FOLLOW_UP_MS * (QUOTA_FOLLOW_UP_MAX + 1));
    expect(calls.filter((call) => call === 'quota').length).toBe(2);
  });

  it('⭐ 失败退避：连续失败时节奏翻倍拉长（有界），恢复后回到基准', async () => {
    act(() => root.render(<Probe />));
    setBusy(true);
    quotaOk = false;

    await flush(QUOTA_BUSY_POLL_MS + 50);
    expect(calls.filter((call) => call === 'quota').length).toBe(1);

    // 退避到 10 秒：原节奏点（+5s）不该再有请求
    await flush(QUOTA_BUSY_POLL_MS - 100);
    expect(calls.filter((call) => call === 'quota').length).toBe(1);

    await flush(QUOTA_BUSY_POLL_MS + 100);
    expect(calls.filter((call) => call === 'quota').length).toBe(2);
  });

  it('⭐ 窗口不可见时不打点；回到前台立刻补一次（并恢复节奏）', async () => {
    act(() => root.render(<Probe />));
    setBusy(true);
    setDocumentVisibility('hidden');

    await flush(QUOTA_BUSY_POLL_MS * 3);
    expect(calls).toEqual([]);

    setDocumentVisibility('visible');
    await flush(50);
    expect(calls).toEqual(['quota']);
  });

  it('⭐ 回前台连按（alt-tab 抖动）合并成一次：同一节奏内不重复补读', async () => {
    act(() => root.render(<Probe />));

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush(50);
    expect(calls).toEqual(['quota']);

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush(50);
    expect(calls).toEqual(['quota']);

    await flush(QUOTA_BUSY_POLL_MS);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush(50);
    expect(calls).toEqual(['quota', 'quota']);
  });

  it('⭐ 登出/切号（快照被清）后旧调度全停，不再产生请求', async () => {
    act(() => root.render(<Probe />));
    setBusy(true);
    await flush(QUOTA_BUSY_POLL_MS + 50);
    expect(calls).toEqual(['quota']);

    act(() => {
      useCommercialStore.getState().clearCache();
    });
    await flush(QUOTA_BUSY_POLL_MS * 4);
    expect(calls).toEqual(['quota']);
  });
});
