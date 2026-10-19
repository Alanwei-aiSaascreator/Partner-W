// @vitest-environment jsdom
/**
 * BUG-082 / C-B 续（2026-10-15 A owner）：账户页的**持续更新**与**预占/已消费区分**。
 *
 * 已有覆盖（不重复）：
 *   · `account-balance-shared-snapshot.test.tsx` —— 共用快照、不写自己的缓存、
 *     读失败保留最近成功值、小数可见；
 *   · `quota-refresh-cadence.test.tsx` —— App 级 hook 的回合结束/忙时 5 秒/回前台。
 *
 * 本文件补的是那两者都盖不到的两段：
 *   ① **停在设置页、空闲、没有任何回合在跑**时，余额不会自己更新 ——
 *      别的设备/另一个窗口消费、或者服务端账本晚于追读窗口才提交，页面就永远停在旧值，
 *      直到用户切页/重开。断网后同理：恢复联网也不会自愈。
 *   ② **预占（held）与已消费**：`CommercialLicenseSummary` 目前**没有**这个字段，
 *      所以客户端**不许**估算 —— 本文件锁住"读不到就什么都不显示、余额不做任何
 *      本地推算"，同时锁住"字段一旦就绪，剩余额度必须把预占扣掉"。
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
  useTranslation: () => ({
    t: translate,
    i18n: { language: 'zh', exists: (key: string) => key in (zh as Record<string, unknown>) },
  }),
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

import AccountSection, { ACCOUNT_IDLE_REFRESH_MS } from '../src/renderer/layouts/Settings/sections/AccountSection';
import { useCommercialStore } from '../src/renderer/stores/commercialStore';
import { useMessageStore } from '../src/renderer/stores/messageStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CREDIT = 1_000_000;
const QUOTA = 2000 * CREDIT;

/**
 * 总额 2000 积分；`remainingCredits` 反推已用。
 *
 * ⚠️ r14 返工：默认带上**一次成功读到的预占读数**（明确报了"没有预占"= 0）。
 *    读数缺省（老后端 / relay 不可达）现在**不再是**"确定没有预占"，界面会显示
 *    "暂不可用"而不是余额 —— 所以"要断言确定余额"的夹具必须显式给出读数。
 */
function overviewWith(remainingCredits: number, extraLicense: Record<string, unknown> = {}) {
  return {
    account: { userId: 'u1', phone: '8618338607148', nickname: '测试用户', avatar: null, email: null },
    org: { id: 'o1', name: '我的空间', plan: 'pro', role: 'owner' },
    license: {
      activated: true,
      licenseId: 'l1',
      orgId: 'o1',
      licenseKey: 'RY-1',
      sku: 'USB-内测版',
      status: 'active',
      expiresAt: null,
      tokenQuotaMicros: QUOTA,
      tokenUsedMicros: (2000 - remainingCredits) * CREDIT,
      tokenHeldMicros: 0,
      heldComplete: true,
      ...extraLicense,
    },
    device: { fingerprint: 'fp', shortFingerprint: 'DEV-1234' },
    fetchedAt: '2026-10-15T10:00:00.000Z',
  };
}

/** 读数缺省（老后端 / relay 不可达）的那张卡：**没有** held 读数。 */
function licenseWithoutHeldReading() {
  const license: Record<string, unknown> = { ...overviewWith(1000.4).license };
  delete license.tokenHeldMicros;
  delete license.heldComplete;
  return license;
}

/** 只读额度通道的返回体（`CommercialQuotaSnapshot`）。 */
function quotaSnapshot(remainingCredits: number, fetchedAt = '2026-10-15T11:00:00.000Z') {
  const full = overviewWith(remainingCredits);
  return { ok: true, result: { license: full.license, org: full.org, fetchedAt } };
}

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
const quotaMock = vi.fn();

function installClawwork(license: Record<string, unknown> = {}): void {
  (globalThis.window as unknown as Window & typeof globalThis & { clawwork: Record<string, unknown> }).clawwork = {
    // ⚠️ 挂载时那次 `load()` 会用这里的返回覆盖 store —— 所以持有 held 字段的场景
    //    必须连**概览**通道一起给出同一张卡，否则挂载瞬间就把 held 抹掉了。
    commercialAccountOverview: vi.fn().mockResolvedValue({ ok: true, result: overviewWith(1000.4, license) }),
    commercialQuotaSnapshot: quotaMock,
    commercialRechargeSkus: vi.fn().mockResolvedValue({ ok: true, result: [] }),
    commercialRechargeOrder: vi.fn().mockResolvedValue({ ok: true, result: null }),
  } as unknown as Window['clawwork'] & Record<string, unknown>;
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** 渲染账户页，并把 store 预置成"已登录 + 已有一份快照"。 */
async function renderPanel(license: Record<string, unknown> = {}): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<AccountSection onboardingProfile={null} />));
  await flushAsync();
  await flushAsync();
  await flushAsync();
  void license;
  return host;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  try {
    localStorage.clear();
  } catch {
    // jsdom 里一定有；这一层只是防御
  }
  quotaMock.mockResolvedValue(quotaSnapshot(1000.4));
  installClawwork();
  useCommercialStore.setState({ overview: overviewWith(1000.4) as never, status: 'ready', errorMessage: '' });
  useMessageStore.setState({ processingBySession: new Map() } as never);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await flushAsync();
}

describe('账户页持续更新：空闲 / 断网恢复 / 不可见（BUG-082 续）', () => {
  it('⭐ 停在设置页且没有回合在跑时，余额照样自己更新', async () => {
    const panel = await renderPanel();
    expect(panel.textContent).toContain('1,000.40');

    // 别的设备/窗口消费后，服务端余额变了（本地没有任何回合在跑）
    quotaMock.mockResolvedValue(quotaSnapshot(940.4));
    await advance(ACCOUNT_IDLE_REFRESH_MS);

    expect(quotaMock, '空闲也要按节奏读一次只读额度通道').toHaveBeenCalled();
    expect(panel.textContent, '页面必须显示新余额').toContain('940.40');
  });

  it('⭐ 断网后恢复：读到失败保留旧值，联网后自己回到新值（不用切页/重开）', async () => {
    quotaMock.mockResolvedValue({ ok: false, error: 'network down' });
    const panel = await renderPanel();

    // 第一次节奏读失败 → 离线，但旧值仍在
    await advance(ACCOUNT_IDLE_REFRESH_MS);
    expect(panel.textContent).toContain('1,000.40');
    expect(panel.textContent).toContain(zh.account.offline);

    // 网络恢复 → 下一次节奏读拿到新值（失败会退避，所以逐步推进时钟）
    quotaMock.mockResolvedValue(quotaSnapshot(880.1));
    for (let i = 0; i < 10; i += 1) await advance(ACCOUNT_IDLE_REFRESH_MS);

    expect(panel.textContent, '恢复后必须自愈到新值').toContain('880.10');
    expect(panel.textContent, '恢复后离线提示要消失').not.toContain(zh.account.offline);
  });

  it('窗口不可见时一个额度请求都不打（回前台由全局钩子补）', async () => {
    const original = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    try {
      await renderPanel();
      await advance(ACCOUNT_IDLE_REFRESH_MS * 4);
      expect(quotaMock, '不可见时不打点').not.toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(document, 'visibilityState', original);
    }
  });

  it('消费进行中不叠加第二条节奏（交给 5 秒忙时轮询）', async () => {
    useMessageStore.setState({ processingBySession: new Map([['s1', true]]) } as never);
    await renderPanel();
    await advance(ACCOUNT_IDLE_REFRESH_MS * 2);
    expect(quotaMock, '忙时由 useQuotaRefreshOnTurnEnd 覆盖，账户页不另开一条节奏').not.toHaveBeenCalled();
  });
});

describe('预占（held）与已消费：读不到就不显示，绝不本地估算（BUG-082 续）', () => {
  // ⚠️ r14 返工：这条原先期待"读不到 held 就沿用 quota − used 显示 1,000.40"。
  //    独审判定那是把"读不到"伪装成"确定没有预占"（relay 返 503 时界面照样显示确定余额）。
  //    现在读数缺省 = **不可判定** ⇒ 不显示预占行、也不给确定余额。
  it('⭐ 读不到 held 读数（老后端 / relay 不可达）：不显示预占行，也不给确定余额', async () => {
    const license = licenseWithoutHeldReading();
    installClawwork();
    (window.clawwork.commercialAccountOverview as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      result: { ...overviewWith(1000.4), license },
    });
    useCommercialStore.setState({ overview: { ...overviewWith(1000.4), license } as never, status: 'ready', errorMessage: '' });
    const panel = await renderPanel();

    expect(panel.querySelector('[data-quota-held]'), '字段不存在就不许有预占行').toBeNull();
    expect(panel.querySelector('[data-quota-held-unknown]')?.textContent).toContain(translate('account.quotaHeldUnknown'));
    // 2000 总额 − 已用 999.6 = 1000.40 是"本地推算"，读数不可判定时**不许**上屏。
    expect(panel.textContent).not.toContain('1,000.40');
  });


  // ⚠️ 本轮**只**做到"值层面区分"（可用额度已扣掉预占）。
  //    要把预占**单列一行**（与"已用"分开上屏）需要新键位 `account.quotaHeld`，
  //    而 locales 归 Lead —— i18n 门禁要求"代码里的字面键必须在 en.json 里"，
  //    所以那一行随键位一起交付，见交回报告的 patch 建议。下面锁住的是已交付的部分。
  it('⭐ held 字段就绪后：可用额度必须把预占扣掉（值层面与"已用"区分）', async () => {
    // 预占 50 积分（= 50e6 微积分）；已用仍是 999.6 → 可用必须是 2000 − 999.6 − 50
    const held = { tokenHeldMicros: 50 * CREDIT };
    installClawwork(held);
    quotaMock.mockResolvedValue({
      ok: true,
      result: { license: overviewWith(1000.4, held).license, org: null, fetchedAt: '2026-10-15T11:00:00.000Z' },
    });
    const panel = await renderPanel();

    expect(panel.textContent, '可用额度已扣除预占').toContain('950.40');
    expect(panel.textContent, '总额不变').toContain('2,000.00');
  });

  it('held 为 0 时一律等同于"没有预占"（不显示、不扣减）', async () => {
    installClawwork({ tokenHeldMicros: 0 });
    const zero = await renderPanel();
    expect(zero.textContent).toContain('1,000.40');
    expect(zero.querySelector('[data-quota-held]')).toBeNull();
  });

  // ⚠️ r14 返工：非法读数（负数 / NaN / 字符串）**不是**"读到 0"，它是"没有可信读数"
  //    ⇒ 按不可判定处理。旧版期待"当 0 忽略、照常显示确定余额 1,000.40"。
  it('held 非法值（负数 / NaN / 字符串）不参与任何计算，也不伪装成确定读数', async () => {
    for (const bad of [-1, Number.NaN, '50']) {
      await act(async () => root?.unmount());
      root = undefined;
      host?.remove();
      document.body.innerHTML = '';
      vi.clearAllMocks();
      useCommercialStore.setState({ overview: overviewWith(1000.4) as never, status: 'ready', errorMessage: '' });
      installClawwork({ tokenHeldMicros: bad });
      const panel = await renderPanel();
      expect(panel.querySelector('[data-quota-held]'), `held=${String(bad)} 不能被当成一个读数`).toBeNull();
      expect(panel.textContent, `held=${String(bad)} 不许显示确定余额`).not.toContain('1,000.40');
      expect(panel.querySelector('[data-quota-held-unknown]')).not.toBeNull();
    }
  });

  it('页面上不出现裸翻译键（新增文案必须等九语言就绪才上屏）', async () => {
    installClawwork({ tokenHeldMicros: 50 * CREDIT });
    const panel = await renderPanel();
    expect(panel.textContent ?? '').not.toMatch(/\baccount\.[a-zA-Z]+\b/);
  });
});
