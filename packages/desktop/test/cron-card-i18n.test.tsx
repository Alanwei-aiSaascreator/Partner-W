// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { CronJob } from '@clawwork/shared';

/**
 * `t` 用**真实的中文词表**来查 —— 这样断言看到的就是**用户实际看到的字**。
 *
 * ⚠️ 别改成"把键吐出来"那种 mock：那样 `cron.target.isolated` 会把英文
 *    `isolated` 带进文本，让"没露英文"的断言**假红**（我第一版就这么写错的）。
 *
 * ⚠️ 键查不到就**原样返回键名** —— 这样"漏翻"会以 `cron.xxx.yyy` 的形状出现在文本里，
 *    而不是静默变成空字符串。
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const raw = key.split('.').reduce<unknown>((acc, part) => {
        if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[part];
        return undefined;
      }, zhLocale as unknown);
      if (typeof raw !== 'string') return key;
      if (!opts) return raw;
      return raw.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(opts[name] ?? ''));
    },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactElement }) => children,
  TooltipTrigger: ({ children }: { children: ReactElement }) => children,
  TooltipContent: ({ children }: { children: ReactElement }) => children,
  TooltipProvider: ({ children }: { children: ReactElement }) => children,
}));

import zhLocale from '../src/renderer/i18n/locales/zh.json';
import CronJobCard from '../src/renderer/layouts/CronPanel/CronJobCard';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(ui: ReactElement): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const NOW = Date.now();
const mk = (over: Partial<CronJob>): CronJob =>
  ({
    id: 'j1',
    name: 'heartbeat-main',
    enabled: true,
    schedule: { kind: 'every', everyMs: 30 * 60_000 },
    payload: { kind: 'heartbeat' },
    sessionTarget: 'isolated',
    state: { lastRunAtMs: NOW - 4 * 3600_000, nextRunAtMs: NOW + 21 * 60_000 },
    ...over,
  }) as unknown as CronJob;

function draw(job: CronJob, agentLabelOf?: (agentId: string) => string | undefined) {
  const noop = vi.fn();
  return render(
    <CronJobCard
      job={job}
      agentLabelOf={agentLabelOf}
      onToggleEnabled={noop}
      onEdit={noop}
      onDelete={noop}
      onRunNow={noop}
      onShowHistory={noop}
    />,
  );
}

/**
 * 定时任务卡片的**汉化**（2026-09-19 用户报「汉化没做好」）。
 *
 * ## 这条用例守的是什么
 *
 * 这一段原来把英文**写死在纯函数里**（`in 21m` / `every 30m` / `interval` / `isolated`），
 * 中文界面上整片露英文。修法是把文案改成走 i18n。
 *
 * ⚠️ 所以下面**既断言"用的是哪个键"，也断言"没有漏出原始英文"** ——
 *    只断言前者的话，将来有人把 `t()` 挪走了、旁边又留个英文兜底，照样能过。
 */
describe('CronJobCard 文案：走 i18n，屏幕上看到中文', () => {
  it('⭐ 间隔 / 相对时间 / 目标 / 载荷类型都渲染成中文', () => {
    const { container, unmount } = draw(mk({}));
    const text = container.textContent ?? '';

    expect(text).toContain('间隔'); // 计划角标
    expect(text).toContain('每 30 分钟'); // every 30m
    expect(text).toContain('4 小时前'); // 上次运行
    expect(text).toContain('21 分钟后'); // 下次运行
    expect(text).toContain('心跳'); // payload.kind = heartbeat
    expect(text).toContain('独立会话'); // sessionTarget = isolated
    unmount();
  });

  it('⛔ 不再漏出原始英文', () => {
    const { container, unmount } = draw(mk({}));
    const text = container.textContent ?? '';

    for (const leaked of ['every 30m', '4h ago', 'in 21m', 'interval', 'isolated']) {
      expect(text).not.toContain(leaked);
    }
    unmount();
  });

  it('⛔ 也没有"漏翻"（漏翻时键名会原样出现）', () => {
    const { container, unmount } = draw(mk({}));
    // 词表里查不到时 mock 会把键吐出来 ⇒ 文本里出现 `cron.` 就是漏翻
    expect(container.textContent ?? '').not.toContain('cron.');
    unmount();
  });

  it('cron 表达式与一次性任务：角标是中文，表达式本身原样显示', () => {
    const cron = draw(mk({ schedule: { kind: 'cron', expr: '0 3 * * *' } as never }));
    expect(cron.container.textContent).toContain('定时');
    expect(cron.container.textContent).toContain('0 3 * * *'); // 表达式是数据，不该翻译
    cron.unmount();

    const at = draw(mk({ schedule: { kind: 'at', at: NOW } as never }));
    expect(at.container.textContent).toContain('一次性');
    at.unmount();
  });

  it('⚠️ 认不出的 target / payload.kind 要**原样显示**，不能空着也不能崩', () => {
    const { container, unmount } = draw(
      mk({ sessionTarget: 'something-new' as never, payload: { kind: 'brandNewKind' } as never }),
    );
    const text = container.textContent ?? '';

    expect(text).toContain('something-new');
    expect(text).toContain('brandNewKind');
    unmount();
  });
});

/**
 * 卡片**标题**：网关自动建的那几个任务在界面上是英文名（T-a4）。
 *
 * ⚠️ 这一条守的是**接线**（`CronJobCard` 有没有真的去调那个映射）。
 *    纯函数的规则由 `test/cron-job-label.test.ts` 守，两者缺一不可 ——
 *    光有对的规则而展示层不调用，用户看到的还是 `heartbeat-main`。
 */
describe('CronJobCard 标题：系统任务的英文名换成中文', () => {
  it('⭐ 心跳任务显示「助手心跳检查」，不再露 `heartbeat-main`', () => {
    const { container, unmount } = draw(mk({ name: 'heartbeat-main' }));
    const text = container.textContent ?? '';

    expect(text).toContain('助手心跳检查');
    expect(text).not.toContain('heartbeat-main');
    unmount();
  });

  it('⭐ 技能库巡检带上**这个助手的中文名**（不然用户不知道是给谁建的）', () => {
    const { container, unmount } = draw(mk({ name: 'skill-collection-review-partner-w-tpl-78b62899' }), (id) =>
      id === 'partner-w-tpl-78b62899' ? '爆款内容教练' : undefined,
    );
    const text = container.textContent ?? '';

    expect(text).toContain('技能库巡检');
    expect(text).toContain('爆款内容教练');
    unmount();
  });

  it('⭐ 用户自己改过名的任务**原样显示** —— 宁可又是英文，也不能张冠李戴', () => {
    const { container, unmount } = draw(mk({ name: '我的周报提醒' }));
    const text = container.textContent ?? '';

    expect(text).toContain('我的周报提醒');
    expect(text).not.toContain('助手心跳检查');
    unmount();
  });

  it('⭐ 系统任务的载荷改说「它干什么」—— 不再把内部标记串/英文长文甩给用户', () => {
    // 实测（2026-09-20）三个任务的真载荷：
    //   heartbeat → 没有正文；memoryDreaming → `__openclaw_..._dream__` 这种内部标记；
    //   skillReview → 一整段英文指令（截断后只剩 "Review this agent's Skill Workshop as a…"）
    const memory = draw(
      mk({
        name: 'Memory Dreaming Promotion',
        payload: { kind: 'agentTurn', message: '__openclaw_memory_core_short_term_promotion_dream__' } as never,
      }),
    );
    expect(memory.container.textContent).toContain('记忆整理');
    expect(memory.container.textContent).toContain('整理助手的长期记忆');
    expect(memory.container.textContent).not.toContain('__openclaw_');
    memory.unmount();

    const review = draw(
      mk({
        name: 'skill-collection-review-x',
        payload: { kind: 'agentTurn', message: "Review this agent's Skill Workshop as a collection" } as never,
      }),
    );
    expect(review.container.textContent).toContain('审阅这个助手的技能库');
    expect(review.container.textContent).not.toContain("Review this agent's");
    review.unmount();
  });

  it('⭐ 非系统任务**照常显示原文载荷**（改的只是系统任务那三种，不是全局屏蔽）', () => {
    const { container, unmount } = draw(
      mk({ name: '我的提醒', payload: { kind: 'agentTurn', message: '记得给客户回电话' } as never }),
    );
    expect(container.textContent).toContain('记得给客户回电话');
    unmount();
  });
});
