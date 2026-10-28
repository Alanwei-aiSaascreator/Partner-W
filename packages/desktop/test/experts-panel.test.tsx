// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => `${key}${opts ? JSON.stringify(opts) : ''}`,
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import ExpertsPanel from '../src/renderer/layouts/ExpertsPanel';
import { EXPERT_CATALOG } from '../src/renderer/lib/expert-catalog';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 专家库页面（2026-10-16，全量总单第 24 行）。
 *
 * ## 这一份测的**不是**"渲染出来了"
 *
 * 测的是两件用户会真的碰到的事：
 * ① **点谁就是谁** —— 卡片上的按钮必须把**这一位**专家的名字带进要发出去的那句话；
 *    点错了人 = 开了个不是用户想要的任务，而界面看起来完全正常。
 * ② **筛选不骗人** —— 选「工程」就只能看到工程专家（这条最容易在加了第 19 个专家时悄悄坏掉）。
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(element: ReactElement): void {
  act(() => {
    root.render(element);
  });
}

function cards(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-expert-card]')];
}

function clickLaunch(card: HTMLElement): void {
  const button = card.querySelector<HTMLButtonElement>('[data-expert-launch]');
  if (!button) throw new Error('这张卡片没有「开任务」按钮');
  act(() => {
    button.click();
  });
}

/** 2026-10-17：点「开个任务」先弹一句"要做什么"，确认后才开任务并自动发送。 */
function submitLaunch(card: HTMLElement, request = '帮我写一份记录'): void {
  clickLaunch(card);
  const input = document.querySelector<HTMLTextAreaElement>('[data-testid="expert-request-input"]');
  if (!input) throw new Error('没有出现"要做什么"的输入框');
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setValue?.call(input, request);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const start = document.querySelector<HTMLButtonElement>('[data-testid="expert-request-start"]');
  if (!start) throw new Error('没有「开始」按钮');
  act(() => {
    start.click();
  });
}

describe('专家库：布局（滚动）', () => {
  // 2026-10-19 用户实测（1.0.10）：专家库只能看到前几排，滚不动。
  // 根因：`MainArea` 用 `<div className="flex-1 min-h-0">`（block）包住本面板，
  // 而根节点写的是 `flex-1` —— flex 增长只在 **flex 父容器**里生效，这个包装层不是 flex，
  // 于是面板高度=内容高度，`ScrollArea` 的视口永远和内容一样高，**内部没有可滚动区域**。
  // 与「欢迎屏滚动」同一类 bug（2026-10-18）：flex 子项没有 `min-h-0` / 没有确定高度。
  it('⭐ 根容器必须有确定高度（h-full + min-h-0），不能只靠 flex-1', () => {
    render(<ExpertsPanel onStartTask={vi.fn()} />);
    const rootElement = container.firstElementChild as HTMLElement | null;
    expect(rootElement).not.toBeNull();
    expect(rootElement?.className).toContain('h-full');
    expect(rootElement?.className).toContain('min-h-0');
  });
});

describe('专家库：卡片渲染', () => {
  it('⭐ 不筛选时，每一位登记的专家都有一张卡', () => {
    render(<ExpertsPanel onStartTask={vi.fn()} />);
    expect(cards().length).toBe(EXPERT_CATALOG.length);
  });

  it('⭐ 每张卡都带名字、一句话能力和头像字（缺一个就是白板卡）', () => {
    render(<ExpertsPanel onStartTask={vi.fn()} />);
    for (const card of cards()) {
      const id = card.getAttribute('data-expert-card');
      const expert = EXPERT_CATALOG.find((entry) => entry.id === id);
      expect(expert, `卡片 ${id} 不在登记表里`).toBeTruthy();
      expect(card.textContent, `${id} 没显示名字`).toContain(expert?.name);
      expect(card.textContent, `${id} 没显示能力说明`).toContain(expert?.capability);
      expect(card.querySelector('[data-expert-avatar]')?.textContent, `${id} 没有头像字`).toContain(expert?.glyph);
    }
  });

  it('⭐ 页面明说"专家能力要靠已安装的技能"（否则用户点了没反应只会以为坏了）', () => {
    render(<ExpertsPanel onStartTask={vi.fn()} />);
    const hint = container.querySelector('[data-testid="experts-install-hint"]');
    expect(hint, '没有"技能未装怎么办"的提示').toBeTruthy();
    expect(hint?.textContent ?? '').toContain('experts.installHint');
  });

  it('⭐ 卡片顺序稳定（每次渲染都一样，不许随机）', () => {
    render(<ExpertsPanel onStartTask={vi.fn()} />);
    const first = cards().map((card) => card.getAttribute('data-expert-card'));
    render(<ExpertsPanel onStartTask={vi.fn()} />);
    const second = cards().map((card) => card.getAttribute('data-expert-card'));
    expect(second).toEqual(first);
  });
});

describe('专家库：点谁就是谁', () => {
  it('⭐ 点第一位专家 ⇒ 回传的话里是**第一位**的名字', () => {
    const onStartTask = vi.fn();
    render(<ExpertsPanel onStartTask={onStartTask} />);
    const first = cards()[0];
    const expert = EXPERT_CATALOG.find((entry) => entry.id === first.getAttribute('data-expert-card'));
    submitLaunch(first);
    expect(onStartTask).toHaveBeenCalledTimes(1);
    expect(onStartTask.mock.calls[0][0]).toContain(expert?.name);
    // 用户在弹窗里写的要求必须原样带上（否则专家收到一句没有任务的空指令）。
    expect(onStartTask.mock.calls[0][0]).toContain('帮我写一份记录');
  });

  it('⭐ 点第 N 位专家 ⇒ 名字也是第 N 位的（不是永远第一位）', () => {
    const onStartTask = vi.fn();
    render(<ExpertsPanel onStartTask={onStartTask} />);
    const target = cards()[5];
    const expert = EXPERT_CATALOG.find((entry) => entry.id === target.getAttribute('data-expert-card'));
    submitLaunch(target);
    expect(onStartTask.mock.calls[0][0]).toContain(expert?.name);
    expect(onStartTask.mock.calls[0][0]).not.toContain(EXPERT_CATALOG[0].name);
  });

  it('⭐ 没写要做什么 ⇒「开始」置灰（不替用户凭空发一条）', () => {
    const onStartTask = vi.fn();
    render(<ExpertsPanel onStartTask={onStartTask} />);
    clickLaunch(cards()[0]);
    const start = document.querySelector<HTMLButtonElement>('[data-testid="expert-request-start"]');
    expect(start?.disabled).toBe(true);
    expect(onStartTask).not.toHaveBeenCalled();
  });

  it('⭐ 一次点击只发一次（重复触发会开出两个任务）', () => {
    const onStartTask = vi.fn();
    render(<ExpertsPanel onStartTask={onStartTask} />);
    submitLaunch(cards()[0]);
    expect(onStartTask).toHaveBeenCalledTimes(1);
  });
});

describe('专家库：技能闭环（2026-10-19）', () => {
  /**
   * 这一页过去只说一句"请使用你已安装的技能 X"，**既不显示装没装、也不校验**。
   * 技能没装时用户点了会跑，助手却看不到该技能 —— 这是"有页面没闭环"。
   * 现在：列表来自真实 `listOurSkills`，未装的卡上给一键安装；装完再刷新状态。
   */
  it('⭐ 未安装的专家必须有「装上」入口，点击走真实 IPC，装完状态刷新', async () => {
    const expert = EXPERT_CATALOG[0];
    const listOurSkills = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        result: {
          managedDirKnown: true,
          skills: [{ slug: expert.skillSlug, installed: false }],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          managedDirKnown: true,
          skills: [{ slug: expert.skillSlug, installed: true }],
        },
      });
    const installOurSkill = vi.fn(async () => ({ ok: true, result: {} }));
    (window as unknown as { clawwork: Record<string, unknown> }).clawwork = { listOurSkills, installOurSkill };

    render(<ExpertsPanel onStartTask={vi.fn()} gatewayId="gw-1" />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const card = container.querySelector<HTMLElement>(`[data-expert-card="${expert.id}"]`);
    const install = card?.querySelector<HTMLButtonElement>('[data-expert-install]');
    expect(install, '未安装的专家没有「装上」按钮').toBeTruthy();

    await act(async () => {
      install?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(installOurSkill).toHaveBeenCalledWith('gw-1', expert.skillSlug);
    expect(card?.querySelector('[data-expert-install]')).toBeNull();
  });

  it('没有网关时不做任何"装没装"的断言（不把不知道说成没装）', async () => {
    render(<ExpertsPanel onStartTask={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-expert-install]')).toBeNull();
    expect(container.querySelector('[data-expert-installed]')).toBeNull();
  });
});

describe('专家库：筛选', () => {
  it('⭐ 默认展示全部（用户不该先学会筛选才看得到人）', () => {
    render(<ExpertsPanel onStartTask={vi.fn()} />);
    const all = cards().length;
    expect(all).toBe(EXPERT_CATALOG.length);
    expect(all).toBeGreaterThan(0);
  });

  it('⭐ 切到某个领域，只剩这个领域的专家', () => {
    render(<ExpertsPanel onStartTask={vi.fn()} />);
    const design = container.querySelector<HTMLButtonElement>('[data-expert-domain="design"]');
    expect(design, '没有「设计」这个筛选入口').toBeTruthy();
    act(() => {
      design?.click();
    });
    const shown = cards().map((card) => card.getAttribute('data-expert-card'));
    const expected = EXPERT_CATALOG.filter((expert) => expert.domain === 'design').map((expert) => expert.id);
    expect(shown.sort()).toEqual(expected.sort());
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(EXPERT_CATALOG.length);
  });

  it('⭐ 能切回全部', () => {
    render(<ExpertsPanel onStartTask={vi.fn()} />);
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-expert-domain="news"]')?.click();
    });
    expect(cards().length).toBe(EXPERT_CATALOG.filter((expert) => expert.domain === 'news').length);
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-expert-domain="all"]')?.click();
    });
    expect(cards().length).toBe(EXPERT_CATALOG.length);
  });
});
