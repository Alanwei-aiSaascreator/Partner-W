// @vitest-environment jsdom
/**
 * BUG-088 / BUG-082 续（2026-10-16，C owner）——账户页两处终态语义。
 *
 * ## ① BUG-088：跨订单迟到回包不许吞掉新订单的真实终态
 *
 * 原先的幂等闸门是全组件一个 `boolean`：轮询与「回前台」两条路径共用它，
 * 但**它不认识订单号**。于是「订单一的迟到回包」会重新关闸、停掉订单二的轮询、
 * 清空 pending —— 订单二真实的 `failed` 被直接丢在地上，屏幕上留下订单一的假成功。
 * 实测（离线反例）：`paidToasts=2 / failedToasts=0`，而 HEAD 同序列是 `failedToasts=1`。
 *
 * 现在闸门带**订单身份**（订单号 + 代次），结算一次即作废；任何对不上身份的回包
 * 一律丢弃，既不播报也不关闸。本文件锁住：新单失败必须播报，旧单迟到回包不许污染。
 *
 * ## ② BUG-082 续：held 口径不可判定时不许显示确定余额
 *
 * 后端明确说 `heldComplete: false`（读不全 hold 源）时，可用额度是**未知**的。
 * 旧实现把未知当 0，照常显示 `quota − used` —— 用户以为还有额度、发起请求却被拒。
 *
 * ⚠️ 真实支付 / 真实后端 held = NOT RUN；这里用替身 IPC 锁语义。
 */
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import zh from '../src/renderer/i18n/locales/zh.json';

function translate(key: string, params?: Record<string, unknown>): string {
  let value: unknown = zh;
  for (const part of key.split('.')) {
    value = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[part] : key;
  }
  let text = typeof value === 'string' ? value : key;
  for (const [name, replacement] of Object.entries(params ?? {})) {
    text = text.split(`{{${name}}}`).join(String(replacement));
  }
  return text;
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: 'zh' } }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

vi.mock('../src/renderer/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) => (open ? <div role="dialog">{children}</div> : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import AccountSection from '../src/renderer/layouts/Settings/sections/AccountSection';
import { useCommercialStore } from '../src/renderer/stores/commercialStore';
import { useMessageStore } from '../src/renderer/stores/messageStore';
import { toast } from '../src/renderer/lib/toast';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CREDIT = 1_000_000;

function overview(id = 'A', credits = 1000.4, extra: Record<string, unknown> = {}) {
  return {
    account: { userId: id, phone: null, nickname: id, email: null, avatar: null },
    org: { id: `org-${id}`, name: `${id}空间`, plan: 'pro', role: 'owner' },
    license: {
      activated: true,
      licenseId: id,
      orgId: `org-${id}`,
      licenseKey: `RY-AUDIT-${id}`,
      sku: 'audit',
      status: 'active',
      expiresAt: null,
      tokenQuotaMicros: 2000 * CREDIT,
      tokenUsedMicros: (2000 - credits) * CREDIT,
      ...extra,
    },
    device: { fingerprint: 'audit', shortFingerprint: 'audit' },
    fetchedAt: new Date().toISOString(),
  };
}

function snapshot(id = 'A', credits = 1000.4) {
  const full = overview(id, credits);
  return { ok: true, result: { org: full.org, license: full.license, fetchedAt: full.fetchedAt } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function handle(orderNo: string) {
  return { orderNo, amountCents: 100, payUrl: `https://audit.invalid/pay/${orderNo}`, expiresAt: null };
}

function order(orderNo: string, status: string) {
  return { ok: true, result: { ...handle(orderNo), status, paidAt: null } };
}

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
const quotaMock = vi.fn();
const overviewMock = vi.fn();
const readOrderMock = vi.fn();
const createOrderMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  localStorage.clear();
  useCommercialStore.getState().clearCache();
  useMessageStore.setState({ processingBySession: new Set<string>() });
  overviewMock.mockReset().mockResolvedValue({ ok: true, result: overview() });
  quotaMock.mockReset().mockResolvedValue(snapshot());
  readOrderMock.mockReset().mockResolvedValue(order('one', 'pending'));
  createOrderMock.mockReset().mockResolvedValue({ ok: true, result: handle('one') });
  window.clawwork = {
    commercialAccountOverview: overviewMock,
    commercialQuotaSnapshot: quotaMock,
    commercialRechargeSkus: vi.fn().mockResolvedValue({ ok: true, result: [{ sku: 'one', label: '¥1', amountCents: 100, bonusCents: 0 }] }),
    commercialRechargeCreate: createOrderMock,
    commercialRechargeCreateCustom: createOrderMock,
    commercialRechargeOrder: readOrderMock,
  } as unknown as Window['clawwork'];
  vi.spyOn(window, 'open').mockImplementation(() => null);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  useCommercialStore.getState().clearCache();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<AccountSection />));
}

function button(text: string, parent: HTMLElement = host) {
  const found = [...parent.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`button absent: ${text}`);
  return found;
}

async function place() {
  await act(async () => button(zh.account.recharge).click());
  const dialog = host.querySelector('[role="dialog"]') as HTMLElement;
  await act(async () => (dialog.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
  await act(async () => button(zh.account.rechargeConfirm, dialog).click());
}

function rechargeStatus() {
  return host.querySelector('[data-recharge-status]')?.getAttribute('data-recharge-status') ?? null;
}

describe('充值订单终态的身份核对（BUG-088）', () => {
  it('订单一的迟到回包不许吞掉订单二的失败', async () => {
    const first = deferred<ReturnType<typeof order>>();
    const lateOld = deferred<ReturnType<typeof order>>();
    const second = deferred<ReturnType<typeof order>>();
    readOrderMock.mockImplementation((id: string) => {
      if (id === 'two') return second.promise;
      return readOrderMock.mock.calls.filter(([n]) => n === 'one').length === 1 ? first.promise : lateOld.promise;
    });
    createOrderMock
      .mockResolvedValueOnce({ ok: true, result: handle('one') })
      .mockResolvedValueOnce({ ok: true, result: handle('two') });

    await mount();
    await place();
    // 「回前台」是第二条独立路径：与轮询同时在途读同一张单。
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(readOrderMock.mock.calls.map(([id]) => id)).toEqual(['one', 'one']);

    await act(async () => first.resolve(order('one', 'paid')));
    await place();
    expect(readOrderMock).toHaveBeenLastCalledWith('two');
    expect(rechargeStatus()).toBe('waiting');

    // 订单二在途时，订单一的迟到回包到达。
    await act(async () => lateOld.resolve(order('one', 'paid')));
    expect(rechargeStatus()).toBe('waiting');

    await act(async () => second.resolve(order('two', 'failed')));
    expect(rechargeStatus()).toBe('failed');
    expect(toast.warning).toHaveBeenCalledTimes(1);
    // 旧单的回包不许再播一次「支付成功」（HEAD 同序列是 2 次）。
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('同一单的重复终态只播报一次（轮询 + 回前台都读到）', async () => {
    const poll = deferred<ReturnType<typeof order>>();
    const focus = deferred<ReturnType<typeof order>>();
    readOrderMock
      .mockImplementationOnce(() => poll.promise)
      .mockImplementationOnce(() => focus.promise);

    await mount();
    await place();
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(readOrderMock).toHaveBeenCalledTimes(2);

    await act(async () => poll.resolve(order('one', 'paid')));
    await act(async () => focus.resolve(order('one', 'paid')));

    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(rechargeStatus()).toBe('paid');
  });

  it('旧单回包不得在新单落单后重新关闸（新单轮询继续跑到自己的终态）', async () => {
    const first = deferred<ReturnType<typeof order>>();
    const lateOld = deferred<ReturnType<typeof order>>();
    const second = deferred<ReturnType<typeof order>>();
    readOrderMock.mockImplementation((id: string) => {
      if (id === 'two') return second.promise;
      return readOrderMock.mock.calls.filter(([n]) => n === 'one').length === 1 ? first.promise : lateOld.promise;
    });
    createOrderMock
      .mockResolvedValueOnce({ ok: true, result: handle('one') })
      .mockResolvedValueOnce({ ok: true, result: handle('two') });

    await mount();
    await place();
    await act(async () => window.dispatchEvent(new Event('focus')));
    await act(async () => first.resolve(order('one', 'cancelled')));
    await place();
    await act(async () => lateOld.resolve(order('one', 'paid')));

    // 新单仍在途：仍处在等待态，且没被旧单的「支付成功」改写。
    expect(rechargeStatus()).toBe('waiting');
    await act(async () => second.resolve(order('two', 'cancelled')));
    expect(rechargeStatus()).toBe('cancelled');
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledTimes(2);
  });

  it('换卡后旧订单的迟到终态不许播报（r14 返工：订单绑定下单时的当前卡）', async () => {
    const late = deferred<ReturnType<typeof order>>();
    readOrderMock.mockReturnValue(late.promise);

    await mount();
    await place();
    // 下单之后当前卡被换掉（激活新卡 / 切账号 ⇒ store 里的卡身份变了）。
    await act(async () => {
      useCommercialStore.setState({ overview: overview('B', 1000.4) as never });
    });
    await act(async () => late.resolve(order('one', 'paid')));

    // 这单是在 A 卡上下单的，终态不再属于当前展示的 B 卡 ⇒ 不播报、不改写结局。
    expect(toast.success).not.toHaveBeenCalled();
    expect(rechargeStatus()).toBe('waiting');
  });
});

describe('在途预占（held）在账户页的展示（BUG-082 续）', () => {
  it('heldComplete=false（未知）不许显示成确定余额', async () => {
    overviewMock.mockResolvedValue({ ok: true, result: overview('A', 1000.4, { heldComplete: false, tokenHeldMicros: 12 * CREDIT }) });
    await mount();

    expect(host.textContent).not.toContain('1,000.40');
    expect(host.textContent).not.toContain('988.40');
    expect(host.querySelector('[data-quota-held]')).toBeNull();
    expect(host.querySelector('[data-quota-held-unknown]')?.textContent).toContain(translate('account.quotaHeldUnknown'));
  });

  it('后端报了确定预占 ⇒ 独立行显示并从可用里扣掉', async () => {
    overviewMock.mockResolvedValue({ ok: true, result: overview('A', 1000.4, { tokenHeldMicros: 50 * CREDIT, heldComplete: true }) });
    await mount();

    expect(host.querySelector('[data-quota-held]')?.textContent).toContain('50.00');
    expect(host.textContent).toContain('950.40');
    expect(host.querySelector('[data-quota-held-unknown]')).toBeNull();
  });

  it('后端没报预占读数（老后端 / relay 不可达）⇒ 不给确定余额（r14 返工）', async () => {
    overviewMock.mockResolvedValue({ ok: true, result: overview('A', 1000.4) });
    await mount();

    // ⚠️ 旧版这里期待"沿用 quota − used 旧口径、显示确定的 1,000.40、不显示未知"。
    //    r14 独审判定那正是缺陷：客户端**分不清**"老后端不返回字段"与"这次读取失败"，
    //    于是 relay 返 503 时界面照样显示一个可能偏高的确定余额。现在读数缺省一律按未知展示。
    expect(host.textContent).not.toContain('1,000.40');
    expect(host.querySelector('[data-quota-held]')).toBeNull();
    expect(host.querySelector('[data-quota-held-unknown]')?.textContent).toContain(translate('account.quotaHeldUnknown'));
  });

  it('后端明确报了"没有预占"（读数为 0）⇒ 才给确定余额（不显示未知）', async () => {
    overviewMock.mockResolvedValue({ ok: true, result: overview('A', 1000.4, { tokenHeldMicros: 0, heldComplete: true }) });
    await mount();

    expect(host.textContent).toContain('1,000.40');
    expect(host.querySelector('[data-quota-held-unknown]')).toBeNull();
    expect(host.querySelector('[data-quota-held]')).toBeNull();
  });
});
