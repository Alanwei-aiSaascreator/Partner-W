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
        'bounty.tab': '悬赏',
        'bounty.empty': '还没有悬赏，发一个试试',
        'bounty.meta': '奖励 {{reward}} 成长值 · {{status}}',
        'bounty.status_open': '待领取',
        'bounty.status_claimed': '进行中',
        'growth.reason_check_in': '每日签到',
        'growth.reason_bounty_escrow': '发布悬赏托管',
        'growth.dailyTasks': '今日任务',
        'growth.task_publish': '发布一个悬赏',
        'growth.task_submit': '交付一个悬赏',
        'growth.task_accept': '验收一个悬赏',
        'growth.taskClaim': '领取',
        'growth.taskClaimed': '已领取',
        'growth.taskTodo': '未完成',
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

  /**
   * ⭐ **与悬赏打通**（2026-09-27）。
   *
   * 成长值的大头进出都在悬赏上（发布扣托管、验收发放、取消退回），
   * 而成长中心原先只显示一串流水 —— 用户看到"-100 发布悬赏托管"却不知道那是**哪一条**。
   * 现在把"我的悬赏"摆在同一屏，流水和它的来源对得上。
   */
  describe('悬赏摘要', () => {
    const bountyRow = (over: Record<string, unknown>) => ({
      id: 'b1',
      title: '做个封面',
      description: '',
      reward: 100,
      status: 'open',
      author_id: 'u1',
      author_name: '我',
      claimant_id: null,
      claimant_name: null,
      submitted_note: '',
      created_at: '2026-09-17T10:00:00Z',
      accepted_at: null,
      is_mine: false,
      is_claimed_by_me: false,
      can_claim: false,
      can_release: false,
      can_submit: false,
      can_accept: false,
      can_reject: false,
      can_cancel: false,
      ...over,
    });

    function withBounties(rows: unknown[]): void {
      Object.assign(window.clawwork, { bountyList: vi.fn(async () => ({ ok: true, result: rows })) });
    }

    it('⭐ **只列我发布或我领取的**（别人的在这里是噪音）', async () => {
      withBounties([
        bountyRow({ id: 'mine-posted', title: '我发布的', is_mine: true }),
        bountyRow({ id: 'mine-claimed', title: '我领取的', is_claimed_by_me: true }),
        bountyRow({ id: 'someone-else', title: '别人的悬赏', is_mine: false, is_claimed_by_me: false }),
      ]);

      const view = await render();
      const rows = [...view.container.querySelectorAll('[data-bounty]')];

      expect(rows.map((el) => el.getAttribute('data-bounty'))).toEqual(['mine-posted', 'mine-claimed']);
      expect(view.container.textContent).toContain('我发布的');
      expect(view.container.textContent).not.toContain('别人的悬赏');
      view.unmount();
    });

    it('一条都没有 ⇒ 空态文案（不是一块空白）', async () => {
      withBounties([]);
      const view = await render();
      expect(view.container.textContent).toContain('还没有悬赏，发一个试试');
      view.unmount();
    });

    it('⭐ 悬赏这一路拿不到（旧预加载没有这个入口）⇒ **不把整页打成错误态**', async () => {
      // 夹具/旧版本里 `bountyList` 可能压根不存在，直接调会 TypeError。
      // 那是夹具差异，不该让**成长主卡片**跟着崩 —— 主数据是好的。
      const view = await render();
      expect(view.container.querySelector('[data-field="error"]')).toBeNull();
      expect(view.container.textContent).toContain('240');
      view.unmount();
    });
  });

  /**
   * ⭐ **每日任务**（迁移 065，2026-09-27）。
   *
   * 成长值原先只有两条来路：每日签到（固定 +20）和悬赏（大进大出）。
   * 悬赏那条对**新手**是空的 —— 手里没有可发的、也没人发给他领，
   * 于是"成长中心"整个是静的。每日任务补的是这一段：
   * 把**今天本来就要做的动作**（发悬赏 / 交付 / 验收）接上成长值。
   *
   * ⚠️ 服务端的目录是唯一的一份（`daily_task_catalog()`），客户端**不硬编码清单**：
   *    任务文案走 `growth.task_<键>`，服务端加一个任务界面照样显示得出来。
   */
  describe('每日任务', () => {
    const taskRow = (over: Record<string, unknown> = {}) => ({
      task: 'publish',
      reward: 10,
      done: false,
      claimed: false,
      ...over,
    });

    /**
     * 两个入口一起造。
     *
     * ⚠️ 只造 `growthDailyTaskList` 是不够的：`claim` 那条漏了的话，
     *    点按钮会 `TypeError`（不是断言失败，是**测的东西根本没跑**）——
     *    本文件第一版就是这么写的，红在 "undefined is not a spy"。
     */
    function withTasks(rows: unknown[]): void {
      Object.assign(window.clawwork, {
        growthDailyTaskList: vi.fn(async () => ({ ok: true, result: rows })),
        growthDailyTaskClaim: vi.fn(async () => ({ ok: true, result: { awarded: 10 } })),
      });
    }

    /**
     * ⭐⭐ 三种状态**必须在界面上分得开**，而且"能不能领"只看 `done && !claimed`。
     *
     * 这是整个特性的用户侧全部体验：合成一个布尔会让用户看到
     * "完成了但按钮点不动"，却不知道为什么。
     */
    it('⭐⭐ 三态分得开：未完成 / 可领 / 已领', async () => {
      withTasks([
        taskRow({ task: 'publish', done: false }),
        taskRow({ task: 'submit', done: true, claimed: false }),
        taskRow({ task: 'accept', done: true, claimed: true }),
      ]);
      const view = await render();

      const state = (task: string) =>
        view.container.querySelector(`[data-task="${task}"]`)?.getAttribute('data-task-state');

      expect(state('publish')).toBe('todo');
      expect(state('submit')).toBe('ready');
      expect(state('accept')).toBe('claimed');
      view.unmount();
    });

    /**
     * 🔴 **只有 ready 才有领取按钮。**
     *
     * 给 `todo` 也画一个按钮的话，用户点下去后端会回 `task_not_done`
     * （迁移 065 里防白送的那道闸）—— 界面上表现成"点了没反应"，
     * 而正确做法是**根本不给点**。
     */
    it('⭐🔴 只有「做完了没领」那颗才有领取按钮', async () => {
      withTasks([
        taskRow({ task: 'publish', done: false }),
        taskRow({ task: 'submit', done: true, claimed: false }),
        taskRow({ task: 'accept', done: true, claimed: true }),
      ]);
      const view = await render();

      expect(
        view.container.querySelectorAll('button[data-action="claim-task"]').length,
        '领取按钮的条数应当恰好等于 status=ready 的任务数',
      ).toBe(1);
      expect(view.container.querySelector('button[data-action="claim-task"]')?.getAttribute('data-task')).toBe(
        'submit',
      );
      view.unmount();
    });

    it('任务文案按服务端的键走 i18n（清单外的键退回键名，不渲染成空）', async () => {
      withTasks([taskRow({ task: 'publish' }), taskRow({ task: 'future_task' })]);
      const view = await render();

      expect(view.container.textContent).toContain('发布一个悬赏');
      expect(view.container.textContent).toContain('future_task');
      view.unmount();
    });

    it('点领取 ⇒ 调后端并刷新（余额/等级要跟着变）', async () => {
      withTasks([taskRow({ task: 'publish', done: true, claimed: false })]);
      const view = await render();

      const before = (window.clawwork.growthSummary as ReturnType<typeof vi.fn>).mock.calls.length;
      await act(async () => {
        (view.container.querySelector('button[data-action="claim-task"]') as HTMLButtonElement).click();
      });

      expect(window.clawwork.growthDailyTaskClaim).toHaveBeenCalledWith({ task: 'publish' });
      expect(
        (window.clawwork.growthSummary as ReturnType<typeof vi.fn>).mock.calls.length,
        '领完必须重拉成长值 —— 否则领了 10 分余额还是旧的',
      ).toBeGreaterThan(before);
      view.unmount();
    });

    it('★ 领取失败 ⇒ 中文原因，不出现机器码', async () => {
      withTasks([taskRow({ task: 'publish', done: true, claimed: false })]);
      Object.assign(window.clawwork, {
        growthDailyTaskClaim: vi.fn(async () => ({ ok: false, errorCode: 'task_not_done' })),
      });
      const view = await render();
      await act(async () => {
        (view.container.querySelector('button[data-action="claim-task"]') as HTMLButtonElement).click();
      });

      const { toast } = await import('sonner');
      await vi.waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith('这件事今天还没做过 —— 做完再来领。', expect.anything()),
      );
      expect(view.container.textContent).not.toContain('task_not_done');
      view.unmount();
    });

    /**
     * ⭐ 旧预加载里没有 `growthDailyTaskList` ⇒ 直接调会 TypeError。
     *    那是夹具/版本差异，不该把**成长主卡片**一起打成错误态（主数据是好的）。
     *    ⚠️ 这条其实是**默认夹具**：文件顶上的 beforeEach 就没造这个入口。
     */
    it('⭐ 这一路拿不到（旧预加载）⇒ 不把整页打成错误态，整块不出现', async () => {
      const view = await render();
      expect(view.container.querySelector('[data-field="error"]')).toBeNull();
      expect(view.container.textContent).toContain('240');
      expect(view.container.querySelector('[data-field="daily-tasks"]')).toBeNull();
      view.unmount();
    });

    it('一条任务都没有 ⇒ 整块不出现（不留一个空盒子）', async () => {
      withTasks([]);
      const view = await render();
      expect(view.container.querySelector('[data-field="daily-tasks"]')).toBeNull();
      view.unmount();
    });
  });
});
