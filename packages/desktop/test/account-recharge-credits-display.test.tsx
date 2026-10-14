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

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis.window as unknown as Window & typeof globalThis & { clawwork: Record<string, unknown> }).clawwork = {
    commercialAccountOverview: vi.fn().mockResolvedValue({ ok: true, result: OVERVIEW }),
    commercialRechargeSkus: vi.fn().mockResolvedValue({ ok: true, result: SKUS }),
  } as unknown as Window['clawwork'] & Record<string, unknown>;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  document.body.innerHTML = '';
});

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
