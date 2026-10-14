// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommercialAccountOverview } from '@clawwork/shared';
import { QUOTA_SETTLE_MS, useQuotaRefreshOnTurnEnd } from '../src/renderer/hooks/useQuotaRefreshOnTurnEnd';
import { useMessageStore } from '../src/renderer/stores/messageStore';
import { useCommercialStore } from '../src/renderer/stores/commercialStore';

/**
 * 「一轮对话结束后把额度拉新」—— 这条纪律的最早一批断言（2026-09-12）。
 *
 * 这些断言锁的是三件容易在重构里丢掉的事：
 *   ① 挂载时不触发（那一刻并没有「刚结束一轮」）
 *   ② 顺序：先上报本机累计量，**再**拉服务端额度（反了就拿到旧值）
 *   ③ 防抖：短时间内的多次结束只打一次请求（Ensemble 会连续 end）
 *
 * ⚠️ 2026-10-15（BUG-082）之后，拉额度那一步走的是**轻量只读额度通道**
 *    （`commercialQuotaSnapshot`）而不是整份账户概览 —— 断言里的通道名随之改，
 *    三条纪律本身没变。新增的节奏/追读/退避断言在 `quota-refresh-cadence.test.tsx`。
 */

const SETTLE_MS = QUOTA_SETTLE_MS;

function overview(): CommercialAccountOverview {
  return {
    account: { userId: 'u1', phone: null, email: null, nickname: null, avatar: null },
    org: { id: 'o1', name: 'org', plan: 'pro', role: 'owner' },
    license: null,
    device: { fingerprint: 'fp', shortFingerprint: 'fp' },
    fetchedAt: '2026-09-12T00:00:00.000Z',
  };
}

function Probe() {
  useQuotaRefreshOnTurnEnd();
  return null;
}

let container: HTMLDivElement;
let root: Root;
let calls: string[];

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  // 与其它组件测试一致：不设的话 act() 会持续告警
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  (globalThis as unknown as { window: Window }).window.clawwork = {
    commercialUsageReport: vi.fn(async () => {
      calls.push('report');
      return 0;
    }),
    commercialQuotaSnapshot: vi.fn(async () => {
      calls.push('quota');
      const snapshot = overview();
      return {
        ok: true,
        result: { license: snapshot.license, org: snapshot.org, fetchedAt: snapshot.fetchedAt },
      };
    }),
  } as unknown as Window['clawwork'];

  useCommercialStore.setState({ overview: overview(), status: 'ready', errorMessage: '' });
  useMessageStore.setState({ processingBySession: new Set<string>() });

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
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

describe('useQuotaRefreshOnTurnEnd', () => {
  it('挂载时不触发（那一刻没有「刚结束一轮」）', async () => {
    act(() => root.render(<Probe />));
    await flush(SETTLE_MS * 3);
    expect(calls).toEqual([]);
  });

  it('一轮结束（忙→闲）后触发上报，再拉额度', async () => {
    act(() => root.render(<Probe />));
    setBusy(true);
    await flush(100);
    expect(calls).toEqual([]); // 还在跑，不该触发

    setBusy(false);
    await flush(SETTLE_MS + 50);

    // ⭐ 顺序：先上报再拉额度。反了会拉到上一次推送前的旧值。
    expect(calls).toEqual(['report', 'quota']);
  });

  it('⭐ 防抖：连续两轮之间只打一次请求', async () => {
    act(() => root.render(<Probe />));
    setBusy(true);
    setBusy(false);
    await flush(SETTLE_MS - 100); // 还没到点
    setBusy(true); // 下一轮开始 → 取消上一次的定时器
    await flush(SETTLE_MS + 50);
    expect(calls).toEqual([]);

    setBusy(false);
    await flush(SETTLE_MS + 50);
    // 只触发了一轮的量，不是两轮
    expect(calls).toEqual(['report', 'quota']);
  });

  it('未登录（没有 account）时不空跑', async () => {
    useCommercialStore.setState({ overview: null });
    act(() => root.render(<Probe />));
    setBusy(true);
    setBusy(false);
    await flush(SETTLE_MS + 50);
    expect(calls).toEqual([]);
  });

  it('上报失败不阻断拉额度（服务端可能已经自己记了账）', async () => {
    // 要「先记录再失败」而不是直接 reject：后者连调用都没发生，
    // 断言就成了「什么都没做」也能过 —— 空过绿灯。
    (window.clawwork.commercialUsageReport as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      calls.push('report');
      throw new Error('gateway offline');
    });
    act(() => root.render(<Probe />));
    setBusy(true);
    setBusy(false);
    await flush(SETTLE_MS + 50);
    expect(calls).toEqual(['report', 'quota']);
  });
});
