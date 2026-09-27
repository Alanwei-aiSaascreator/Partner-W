// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 成长中心面板。
 *
 * ⚠️ 断言写**中文原文**而不是 `translate('growth.title')`：面板文案还没落地时，
 *    两边都会退化成键名 ⇒ 断言变成空对空的假绿（i18n 键与组件在同一个提交里加）。
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const table: Record<string, string> = {
        'growth.title': '成长中心',
        'growth.level': 'Lv.{{level}}',
        'growth.totalEarned': '累计获得 {{value}}',
        'growth.toNext': '距离下一级还需 {{value}}',
        'growth.checkIn': '每日签到 +20',
        'growth.checkedIn': '今日已签到',
        'growth.badges': '我的徽章',
        'growth.noBadges': '完成任务就能点亮徽章',
        'growth.history': '成长明细',
        'growth.emptyHistory': '还没有记录',
        'growth.badge_check_in_7': '坚持一周',
        'growth.badge_bounty_3': '完成三个悬赏',
        'growth.badge_growth_500': '累计 500 成长值',
        'growth.reason_check_in': '每日签到',
        'growth.reason_bounty_escrow': '发布悬赏托管',
      };
      const raw = table[key] ?? key;
      return raw.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(values?.[name] ?? ''));
    },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('../src/renderer/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import GrowthPanel from '../src/renderer/layouts/GrowthPanel';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ⚠️ summary 是**单个对象**（IPC 那层已经取过首行了），不是数组
const summaryRow = {
  balance: 240,
  total_earned: 440,
  level: 3,
  to_next_level: 160,
  checked_in_today: false,
  badges: ['check_in_7'],
};
const historyRows = [
  { id: 'e1', amount: -100, reason: 'bounty_escrow', ref_id: 'b1', note: '', created_at: '2026-09-17T10:00:00Z' },
  { id: 'e2', amount: 20, reason: 'check_in', ref_id: '2026-09-17', note: '', created_at: '2026-09-17T09:00:00Z' },
];

async function render(): Promise<{ container: HTMLDivElement; unmount: () => void }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<GrowthPanel />);
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('GrowthPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(window, {
      clawwork: {
        growthSummary: vi.fn(async () => ({ ok: true, result: summaryRow })),
        growthCheckIn: vi.fn(async () => ({
          ok: true,
          result: { ...summaryRow, balance: 260, checked_in_today: true },
        })),
        growthHistory: vi.fn(async () => ({ ok: true, result: historyRows })),
      },
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('显示余额、等级、累计获得、距下一级与徽章', async () => {
    const view = await render();
    expect(view.container.textContent).toContain('240');
    expect(view.container.textContent).toContain('Lv.3');
    expect(view.container.textContent).toContain('累计获得 440');
    expect(view.container.textContent).toContain('距离下一级还需 160');
    expect(view.container.textContent).toContain('坚持一周');
    view.unmount();
  });

  it('未签到 ⇒ 可点；点完调用后端并刷新', async () => {
    const view = await render();
    const button = view.container.querySelector('button[data-action="check-in"]') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(window.clawwork.growthCheckIn).toHaveBeenCalledTimes(1);
    expect(window.clawwork.growthSummary).toHaveBeenCalledTimes(2); // 初次 + 签到后
    view.unmount();
  });

  it('已签到 ⇒ 按钮禁用并显示已签到', async () => {
    (window.clawwork.growthSummary as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      result: { ...summaryRow, checked_in_today: true },
    });
    const view = await render();
    const button = view.container.querySelector('button[data-action="check-in"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(view.container.textContent).toContain('今日已签到');
    view.unmount();
  });

  it('★ 签到失败 ⇒ 中文原因，不出现机器码', async () => {
    (window.clawwork.growthCheckIn as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      errorCode: 'not_authenticated',
    });
    const view = await render();
    await act(async () => {
      (view.container.querySelector('button[data-action="check-in"]') as HTMLButtonElement).click();
    });
    const { toast } = await import('sonner');
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith('请先登录再试。', expect.anything()));
    expect(view.container.textContent).not.toContain('not_authenticated');
    view.unmount();
  });

  it('明细：正数带 + 号、负数带 - 号、原因翻成中文', async () => {
    const view = await render();
    expect(view.container.textContent).toContain('+20');
    expect(view.container.textContent).toContain('-100');
    expect(view.container.textContent).toContain('发布悬赏托管');
    view.unmount();
  });

  it('明细为空 ⇒ 空态文案', async () => {
    (window.clawwork.growthHistory as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, result: [] });
    const view = await render();
    expect(view.container.textContent).toContain('还没有记录');
    view.unmount();
  });

  it('拉取失败 ⇒ 中文错误，不出现机器码', async () => {
    (window.clawwork.growthSummary as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, errorCode: 'network' });
    const view = await render();
    await vi.waitFor(() => expect(view.container.textContent).toContain('连不上服务器，请检查网络后重试。'));
    expect(view.container.textContent).not.toContain('network');
    view.unmount();
  });

  /**
   * ⭐ **徽章墙**（2026-09-27）。
   *
   * 原先只列**已点亮**的徽章，"一个都没点亮"时整块是一句灰话 ——
   * 用户根本不知道自己**还能拿什么**，也就没有任何去点亮的动机。
   * 这正是"游戏化"要解决的事，而它当时是缺的。
   */
  it('⭐ 没点亮的徽章**也在墙上**（带 data-earned="false"），条件写在徽章名里', async () => {
    const view = await render();
    const wall = [...view.container.querySelectorAll('[data-badge]')];

    expect(
      wall.map((el) => el.getAttribute('data-badge')),
      '徽章墙应当三格全在',
    ).toEqual(['check_in_7', 'bounty_3', 'growth_500']);
    // 夹具里 summary.badges 只有 check_in_7
    expect(wall.map((el) => el.getAttribute('data-earned'))).toEqual(['true', 'false', 'false']);
    // 未点亮的**必须也看得见条件**，否则"还能拿什么"仍然是个谜
    expect(view.container.textContent).toContain('完成三个悬赏');
    expect(view.container.textContent).toContain('累计 500 成长值');
    view.unmount();
  });

  it('⭐ 服务端回了清单外的徽章 ⇒ 照样渲染（不然新徽章会**静默消失**）', async () => {
    (window.clawwork.growthSummary as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      result: { ...summaryRow, badges: ['check_in_7', 'future_badge'] },
    });
    const view = await render();
    const wall = [...view.container.querySelectorAll('[data-badge]')];

    expect(
      wall.map((el) => el.getAttribute('data-badge')),
      '清单外的徽章被丢了 —— 服务端加新徽章时用户将完全看不到',
    ).toContain('future_badge');
    // 没有对应文案时退回键名，不许渲染成空
    expect(view.container.textContent).toContain('future_badge');
    view.unmount();
  });

  it('等级进度给出分子分母（光有进度条看不出"还差多少"）', async () => {
    const view = await render();
    // total_earned 440、to_next_level 160 ⇒ 本级已得 200 - 160 = 40
    expect(view.container.querySelector('[data-field="level-progress"]')).not.toBeNull();
    expect(view.container.textContent).toContain('40 / 200');
    view.unmount();
  });
});
