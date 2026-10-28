// @vitest-environment jsdom
/**
 * BUG-081 / C-A（2026-10-15）——充值弹窗必须把「人民币金额」和「到账积分」绑在一起：
 *   ① 弹窗固定显示「充值比例：1元=100积分」；
 *   ② 每个套餐卡显示 支付金额 + 到账积分（按 1 分 = 1 积分；用户口径不显示赠送）；
 *   ③ 自定义合法金额显示预计到账积分；
 *   ④ 确认付款按钮区域复用同一份「金额/到账」摘要。
 *
 * 用真实 AccountSection 组件渲染（真实 i18n 文案取自 zh.json；仅对话框外壳、
 * 账本 IPC 与 toast 用测试替身）。仓库没有 @testing-library/react（lockfile 零命中），
 * 沿用仓库既有 createRoot + act 的 jsdom 渲染模式。
 */
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import zh from '../src/renderer/i18n/locales/zh.json';

function lookup(locale: unknown, key: string): string {
  let node: unknown = locale;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return key;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : key;
}

/** 与 i18next 行为一致的最小子集：查 zh 词表 + {{param}} 插值。 */
function translate(key: string, params?: Record<string, unknown>): string {
  let text = lookup(zh, key);
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{{${name}}}`).join(String(value));
    }
  }
  return text;
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: 'zh' } }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/renderer/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import AccountSection from '../src/renderer/layouts/Settings/sections/AccountSection';
import { toast } from '../src/renderer/lib/toast';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 服务端 SKU 的三条形态：无赠送、有赠送（用户口径：不显示）、大额。 */
const SKUS = [
  { sku: 'topup-1', label: '¥1', amountCents: 100, bonusCents: 0 },
  { sku: 'topup-10', label: '¥10', amountCents: 1000, bonusCents: 100 },
  { sku: 'topup-100', label: '¥100', amountCents: 10000, bonusCents: 0 },
];

const OVERVIEW = {
  account: { id: 'user-1', phone: '8618338607148', nickname: '测试用户', avatar: null, email: null },
  org: null,
  license: {
    activated: true,
    licenseId: 'license-1',
    orgId: 'org-1',
    licenseKey: 'RY-TEST-0001',
    sku: 'USB-内测版',
    status: 'active',
    expiresAt: null,
    tokenQuotaMicros: 1_000_000_000,
    tokenUsedMicros: 0,
  },
  device: { shortFingerprint: 'DEV-1234' },
  fetchedAt: '2026-10-15T00:00:00.000Z',
};

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(text));
  if (!button) throw new Error(`button containing "${text}" not found`);
  return button as HTMLButtonElement;
}

async function renderWithDialogOpen(): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<AccountSection onboardingProfile={null} />));
  await flushAsync();
  await flushAsync();
  await flushAsync();
  act(() => findButton(host, zh.account.recharge).click());
  const dialog = host.querySelector('[role="dialog"]');
  if (!dialog) throw new Error('充值对话框应已打开');
  return dialog as HTMLDivElement;
}

function setCustomAmount(container: HTMLElement, value: string): void {
  const input = container.querySelector('input[type="text"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const ORDER_HANDLE = { orderNo: 'order-1', amountCents: 100, payUrl: 'https://pay.example/x', expiresAt: null };

function installClawwork(overrides: Record<string, unknown> = {}): void {
  (globalThis.window as unknown as Window & typeof globalThis & { clawwork: Record<string, unknown> }).clawwork = {
    commercialAccountOverview: vi.fn().mockResolvedValue({ ok: true, result: OVERVIEW }),
    commercialRechargeSkus: vi.fn().mockResolvedValue({ ok: true, result: SKUS }),
    commercialRechargeCreate: vi.fn().mockResolvedValue({ ok: true, result: ORDER_HANDLE }),
    commercialRechargeCreateCustom: vi.fn().mockResolvedValue({ ok: true, result: ORDER_HANDLE }),
    commercialRechargeOrder: vi
      .fn()
      .mockResolvedValue({ ok: true, result: { ...ORDER_HANDLE, status: 'pending', paidAt: null } }),
    ...overrides,
  } as unknown as Window['clawwork'] & Record<string, unknown>;
}

/** 让 `commercialRechargeOrder` 按调用序号依次返回不同状态（末项重复）。 */
function orderStatusSequence(...statuses: string[]): ReturnType<typeof vi.fn> {
  let index = 0;
  return vi.fn().mockImplementation(() => {
    const status = statuses[Math.min(index, statuses.length - 1)];
    index += 1;
    return Promise.resolve({ ok: true, result: { ...ORDER_HANDLE, status, paidAt: null } });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  installClawwork();
  // jsdom 没有真实浏览器窗口：`window.open` 只被充值流程用来打开收银台。
  vi.spyOn(window, 'open').mockImplementation(() => null);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** 勾选退款说明 → 点「继续充值」，走一次完整的下单动作。 */
async function agreeAndConfirm(dialog: HTMLElement): Promise<void> {
  const checkbox = dialog.querySelector('input[type="checkbox"]') as HTMLInputElement;
  const checkedSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked')?.set;
  await act(async () => {
    checkedSetter?.call(checkbox, true);
    checkbox.dispatchEvent(new Event('click', { bubbles: true }));
  });
  await act(async () => {
    findButton(dialog, zh.account.rechargeConfirm).click();
  });
  await flushAsync();
}

describe('充值弹窗：金额 ↔ 到账积分对照（BUG-081 / C-A）', () => {
  it('① 弹窗固定显示「充值比例：1元=100积分」', async () => {
    const dialog = await renderWithDialogOpen();
    expect(dialog.textContent).toContain('充值比例：1元=100积分');
  });

  it('② 每个套餐卡显示支付金额与到账积分（漏送不算数、赠送不上屏）', async () => {
    const dialog = await renderWithDialogOpen();
    const text = dialog.textContent ?? '';
    // ¥1 = 100 分 = 100 积分
    expect(text).toContain('支付 ¥1.00，到账 100 积分');
    // 该档服务端标了 bonusCents=100 —— 用户口径：界面只按比例算，赠送不显示
    expect(text).toContain('支付 ¥10.00，到账 1,000 积分');
    expect(text).toContain('支付 ¥100.00，到账 10,000 积分');
    expect(text).not.toContain('赠送');
  });

  it('③ 自定义合法金额显示预计到账积分（¥1.23 → 123 积分）', async () => {
    const dialog = await renderWithDialogOpen();
    act(() => findButton(dialog, zh.account.rechargeCustom).click());
    setCustomAmount(dialog, '1.23');
    expect(dialog.textContent).toContain('支付 ¥1.23，预计到账 123 积分');
  });

  it('④ 确认付款区域有金额/到账摘要，并随所选档位更新', async () => {
    const dialog = await renderWithDialogOpen();
    const summary = dialog.querySelector('[data-recharge-summary]');
    expect(summary, '确认区应有金额/到账摘要').not.toBeNull();
    // 默认选中第一档（¥1 → 100 积分）
    expect(summary?.textContent).toContain('支付 ¥1.00，到账 100 积分');

    act(() => findButton(dialog, '¥100').click());
    expect(dialog.querySelector('[data-recharge-summary]')?.textContent).toContain('支付 ¥100.00，到账 10,000 积分');

    // 切到自定义 ¥1.23：摘要必须跟着换成自定义金额
    act(() => findButton(dialog, zh.account.rechargeCustom).click());
    setCustomAmount(dialog, '1.23');
    expect(dialog.querySelector('[data-recharge-summary]')?.textContent).toContain('支付 ¥1.23，到账 123 积分');
  });

  it('⑤ 非法金额沿用既有校验：给出错误提示且不出现积分预估/摘要', async () => {
    const dialog = await renderWithDialogOpen();
    act(() => findButton(dialog, zh.account.rechargeCustom).click());
    setCustomAmount(dialog, '0.99');
    const text = dialog.textContent ?? '';
    expect(text).toContain('请输入 ¥1 – ¥500 之间的金额');
    expect(text).not.toContain('预计到账');
    expect(dialog.querySelector('[data-recharge-summary]')).toBeNull();
  });
});

/**
 * BUG-081 / C-A 续（2026-10-15 A owner）：充值流程的三类**未覆盖**缺口。
 *
 * ① **充到哪张卡**：`recharge_no_license_target` 这条失败码的存在证明"目标卡"是
 *    真实业务概念，但弹窗里从头到尾没有一处写明这次充值的钱落到哪张卡 / 哪个组织 /
 *    哪个账号 —— 用户只能在付款后从失败提示里反推。
 * ② **结局可区分**：取消与失败原先共用一句"订单已关闭"，且结局只以 3 秒后就消失的
 *    toast 呈现，页面上没有留痕；同一订单被两条触发路径（轮询 / 回前台）同时读到终态
 *    时，会连播两条"支付成功"——即"重复回调在 UI 上看起来像成功"。
 * ③ **人民币不要被档位标签带偏**：档位卡的价签取服务端 `label`，而摘要取
 *    `amountCents`；两者不一致时同一张卡会同时显示两个价格。
 */
describe('充值弹窗：目标卡 / 结局状态 / 价格口径（BUG-081 续）', () => {
  const OVERVIEW_WITH_ORG = {
    ...OVERVIEW,
    org: { id: 'org-1', name: '我的空间', plan: 'pro', role: 'owner' },
  };

  it('⑥ 弹窗写明这次充值落在哪张卡（账号 / 组织 / 卡的关系）', async () => {
    installClawwork({
      commercialAccountOverview: vi.fn().mockResolvedValue({ ok: true, result: OVERVIEW_WITH_ORG }),
    });
    const dialog = await renderWithDialogOpen();
    const target = dialog.querySelector('[data-recharge-target]');
    expect(target, '充值弹窗必须写明充到哪张卡').not.toBeNull();
    expect(target?.textContent, '目标卡（sku）').toContain('USB-内测版');
    expect(target?.textContent, '绑定组织').toContain('我的空间');
  });

  it('⑥b 卡密不在弹窗里明文回显', async () => {
    installClawwork({
      commercialAccountOverview: vi.fn().mockResolvedValue({ ok: true, result: OVERVIEW_WITH_ORG }),
    });
    const dialog = await renderWithDialogOpen();
    const target = dialog.querySelector('[data-recharge-target]');
    expect(target?.textContent ?? '', '卡密不得明文上屏').not.toContain('RY-TEST-0001');
  });

  it('⑦ 没绑卡时弹窗先讲清"要先绑卡"，而不是让用户付完才发现', async () => {
    installClawwork({
      commercialAccountOverview: vi.fn().mockResolvedValue({
        ok: true,
        result: { ...OVERVIEW, license: null, org: null },
      }),
    });
    const dialog = await renderWithDialogOpen();
    const target = dialog.querySelector('[data-recharge-target]');
    expect(target?.textContent, '无卡态必须给出可执行下一步').toContain(zh.account.rechargeCardRequired);
  });

  it('⑧ 取消与失败是两种可区分的结局，且结局面在页面上留痕（不是只飘 3 秒）', async () => {
    installClawwork({ commercialRechargeOrder: orderStatusSequence('cancelled') });
    const dialog = await renderWithDialogOpen();
    await agreeAndConfirm(dialog);

    const cancelled = host.querySelector('[data-recharge-status]');
    expect(cancelled, '结局必须在页面上留痕，不能只有 toast').not.toBeNull();
    const cancelledText = cancelled?.textContent ?? '';
    expect(cancelledText).toContain(zh.account.rechargeClosed);

    // 换一场：失败。文案必须与"取消"不同。
    await act(async () => root!.unmount());
    root = undefined;
    host?.remove();
    document.body.innerHTML = '';
    vi.clearAllMocks();
    installClawwork({ commercialRechargeOrder: orderStatusSequence('failed') });
    const dialog2 = await renderWithDialogOpen();
    await agreeAndConfirm(dialog2);

    const failed = host.querySelector('[data-recharge-status]');
    expect(failed, '失败也要留痕').not.toBeNull();
    const failedText = failed?.textContent ?? '';
    expect(failedText, '取消与失败不能是同一句话').not.toBe(cancelledText);
    // 2026-10-16（Lead 集成）：失败态文案由 `account.rechargeFailed`（"发起支付失败，请重试"，
    // 语义偏"发起"）换成 A4 建议、Lead 已补九语言键位的 `account.rechargeOrderFailed`
    // （"这笔支付失败了，积分未到账"）。断言随之改指新键；本用例的原意（失败与取消不是同一句话、
    // 失败不得显示成成功）逐条保持。
    expect(failedText).toContain(zh.account.rechargeOrderFailed);
    expect(failedText, '失败不得显示成支付成功').not.toContain(zh.account.rechargePaid);
  });

  it('⑧b 成功结局显示"已到账"，且与取消/失败不同', async () => {
    installClawwork({ commercialRechargeOrder: orderStatusSequence('paid') });
    const dialog = await renderWithDialogOpen();
    await agreeAndConfirm(dialog);

    const paid = host.querySelector('[data-recharge-status]');
    expect(paid?.textContent).toContain(zh.account.rechargePaid);
    expect(paid?.textContent).not.toContain(zh.account.rechargeClosed);
  });

  it('⑨ ⭐同一订单被两条触发路径同时读到终态 → 只结算一次，不重复播报成功', async () => {
    // 首次（下单后的立即轮询）仍是 pending，于是"回前台"监听器被挂上；
    // 之后两条路径在同一时刻读到 paid —— 这正是 `商业回调重复` 在客户端的形态。
    installClawwork({ commercialRechargeOrder: orderStatusSequence('pending', 'paid') });
    const dialog = await renderWithDialogOpen();
    await agreeAndConfirm(dialog);

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
    });
    await flushAsync();

    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('⑩ 档位价签以服务端金额为准，不被 label 带偏（人民币口径唯一）', async () => {
    installClawwork({
      commercialRechargeSkus: vi.fn().mockResolvedValue({
        ok: true,
        // label 与 amountCents 不一致：若直接渲染 label，同一张卡会显示两个价格。
        result: [{ sku: 'odd', label: '¥1', amountCents: 1000, bonusCents: 0 }],
      }),
    });
    const dialog = await renderWithDialogOpen();
    const price = dialog.querySelector('[data-sku-price="odd"]');
    expect(price, '档位价签必须有可定位的金额节点').not.toBeNull();
    expect(price?.textContent, '价签必须来自 amountCents（¥10.00），不是 label（¥1）').toContain('¥10.00');
    expect(dialog.textContent).toContain('支付 ¥10.00，到账 1,000 积分');
  });
});
