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

function draw(job: CronJob) {
  const noop = vi.fn();
  return render(
    <CronJobCard job={job} onToggleEnabled={noop} onEdit={noop} onDelete={noop} onRunNow={noop} onShowHistory={noop} />,
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
