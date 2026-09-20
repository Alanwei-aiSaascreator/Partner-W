// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillStatusReport } from '@clawwork/shared';

/**
 * 设置 → 「技能」那一页的**接线**测试（不是纯函数测试）：
 * 光有 `gatewaySkillLabel` 不代表这一页真的用了它 —— 忘接线是这类改动最常见的死法。
 *
 * `t` 用**真实的中文词表**来查（同 `cron-card-i18n.test.tsx`）：这样断言的
 * "看到的是中文"就是用户实际看到的字；漏翻的键会以 `gatewaySkill.xxx.yyy` 的形状
 * 出现在文本里（`read` 查不到就原样返回键名），不会静默变成空字符串。
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

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

vi.mock('../src/renderer/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock('../src/renderer/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p {...props}>{children}</p>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import zhLocale from '../src/renderer/i18n/locales/zh.json';
import SkillsSection from '../src/renderer/layouts/Settings/sections/SkillsSection';
import { useUiStore } from '../src/renderer/stores/uiStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GATEWAY = 'gw-1';

/** 网关实测报出来的英文原文（2026-09-20 `skills status --agent main`）。 */
const WEATHER_EN =
  'Current weather and forecasts with web_fetch, falling back to wttr.in curl for locations, rain, temperature, travel planning.';
const WEATHER_EN_CHANGED = `${WEATHER_EN} Now with hourly data.`;

const REPORT: SkillStatusReport = {
  workspaceDir: '/tmp/ws',
  managedSkillsDir: '/tmp/skills',
  skills: [
    {
      name: 'weather',
      description: WEATHER_EN,
      source: 'openclaw-bundled',
      bundled: true,
      filePath: '/tmp/skills/weather/SKILL.md',
      baseDir: '/tmp/skills/weather',
      skillKey: 'weather',
      emoji: '☔',
      always: false,
      disabled: false,
      blockedByAllowlist: false,
      eligible: true,
      requirements: { bins: [], anyBins: [], env: [], config: [], os: [] },
      missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
      configChecks: [],
      install: [],
    },
    {
      // 我们自己的市场技能：**不在**映射表里 ⇒ 原样显示
      name: 'meeting-minutes',
      description: '把会议记录整理成结构化纪要',
      source: 'openclaw-managed',
      bundled: false,
      filePath: '/tmp/skills/meeting-minutes/SKILL.md',
      baseDir: '/tmp/skills/meeting-minutes',
      skillKey: 'meeting-minutes',
      always: false,
      disabled: false,
      blockedByAllowlist: false,
      eligible: true,
      requirements: { bins: [], anyBins: [], env: [], config: [], os: [] },
      missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
      configChecks: [],
      install: [],
    },
  ],
};

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

function seed(report: SkillStatusReport): void {
  useUiStore.setState({
    gatewayStatusMap: { [GATEWAY]: 'connected' },
    gatewayInfoMap: {},
    defaultGatewayId: GATEWAY,
    skillsStatusByGateway: { [GATEWAY]: report },
  });
}

const zhName = (gatewaySkill: string): string =>
  (zhLocale as unknown as { gatewaySkill: Record<string, { name: string }> }).gatewaySkill[gatewaySkill].name;
const zhDescription = (gatewaySkill: string): string =>
  (zhLocale as unknown as { gatewaySkill: Record<string, { description: string }> }).gatewaySkill[gatewaySkill]
    .description;

describe('设置 → 「技能」：网关自带技能的显示名', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('⭐ 网关自带技能显示的是中文名与中文描述（页面上的英文原文不见了）', () => {
    seed(REPORT);
    const { container, unmount } = render(<SkillsSection />);

    const text = container.textContent ?? '';
    expect(text).toContain(zhName('weather'));
    expect(text).toContain(zhDescription('weather'));
    expect(text, '英文原文不该再出现在页面上').not.toContain(WEATHER_EN);

    unmount();
  });

  it('⭐ 不在表里的技能（我们自己的市场技能）**原样显示**，不被我们改名', () => {
    seed(REPORT);
    const { container, unmount } = render(<SkillsSection />);

    const text = container.textContent ?? '';
    expect(text).toContain('meeting-minutes');
    expect(text).toContain('把会议记录整理成结构化纪要');

    unmount();
  });

  it('⭐ 网关改了描述 ⇒ 那一条退回英文原文（宁可显示英文，也不要显示过期的中文）', () => {
    seed({
      ...REPORT,
      skills: [{ ...REPORT.skills[0], description: WEATHER_EN_CHANGED }, REPORT.skills[1]],
    });
    const { container, unmount } = render(<SkillsSection />);

    const text = container.textContent ?? '';
    expect(text).toContain(WEATHER_EN_CHANGED);
    expect(text).not.toContain(zhDescription('weather'));

    unmount();
  });
});
