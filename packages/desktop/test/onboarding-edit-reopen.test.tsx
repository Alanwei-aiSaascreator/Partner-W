// @vitest-environment jsdom
/**
 * N1（2026-10-16）—— **团队确认不能重开** 的定向验收。
 *
 * 缺陷（Owner F 本轮核实、Owner N 复现）：`mode="edit"` 的 `page` 初始值恒为 `'profile'`，
 * 于是「重开向导」永远从第一页开始，用户**看不到自己确认过的团队**（结果页/团队确认页）。
 * 更糟的是：编辑模式下唯一通往结果页的按钮是「生成我的 AI 团队」，它会把用户确认过的
 * `selectedAssistantIds` 换成当次的本地推荐 —— 也就是说确认过的名单既看不见、又会被覆盖。
 *
 * 本文件锁住修好之后的语义：
 *  ① 已确认档案（v3 + `workMatch`）重开 ⇒ **直接落在团队确认那一步**，且显示的是**档案里
 *     那份名单**（不是重算的推荐）；
 *  ② 确认名单里的 id 即使不在本次本地推荐里也必须出现在屏幕上（否则仍然"看不见"）；
 *  ③ 没走到过团队确认的档案（没有回执）仍旧落在资料页；
 *  ④ 首登（`mode="first-run"`）的既有落点一个字不动（对照用例）；
 *  ⑤ 重开是**只读复核**：不写草稿、不改档案，直到用户自己按保存。
 */
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadOnboardingProfile,
  onboardingDraftScope,
  readOnboardingDraft,
  recommendAssistants,
  type OnboardingProfile,
} from '../src/renderer/lib/user-onboarding';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

import Onboarding from '../src/renderer/layouts/Onboarding';

function render(ui: ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function click(container: HTMLElement, key: string) {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(key));
  expect(button, `Missing button ${key}`).toBeDefined();
  act(() => button!.click());
}

/**
 * 一个**已确认过团队**的 v3 档案：`workMatch` 只在 `confirm()` 里写入 ⇒ 有它就等于用户
 * 走完了「团队确认」。名单特意选成「一个本次本地推荐里没有的 id + 一个推荐里有的 id」，
 * 用来同时压住「落点」和「名单可见」两件事。
 */
function confirmedProfile(overrides: Partial<OnboardingProfile> = {}): OnboardingProfile {
  return {
    version: 3,
    userId: 'user-1',
    nickname: '已确认的昵称',
    introduction: '',
    role: 'finance',
    customRole: '',
    useCases: ['office'],
    customGoal: '',
    selectedAssistantIds: ['family', 'research'],
    responseDetail: 'balanced',
    filePermission: 'ask-every-time',
    completedAt: '2026-10-03T00:00:00.000Z',
    industry: { code: 'H', generalConfirmed: false, source: 'user', catalogVersion: 1 },
    questionnaire: { version: 1, answers: [null, null, null, null] },
    persona: { id: null, source: 'default', ruleVersion: null },
    workMatch: { source: 'basic', profileVersion: 'confirmed-version' },
    ...overrides,
  };
}

afterEach(() => {
  window.sessionStorage.clear();
  loadOnboardingProfile('user-1');
});

describe('N1 · 重开向导回到已确认过的团队确认那一步', () => {
  it('已确认档案重开 ⇒ 直接落在结果页，且显示档案里那份名单（不是重算的推荐）', () => {
    const profile = confirmedProfile();
    // 前提（否则这个用例退化成"推荐里正好有"）：family 不在本次本地推荐里。
    const recommended = recommendAssistants(profile).slice(0, 3).map((item) => item.id);
    expect(recommended).not.toContain('family');
    expect(recommended).toContain('research');

    const view = render(
      <Onboarding userId="user-1" mode="edit" initialProfile={profile} onComplete={vi.fn()} onCancel={vi.fn()} />,
    );

    // ① 落在结果页（团队确认那一步），不是资料页
    expect(view.container.querySelector('[data-result-actions]')).not.toBeNull();
    expect(view.container.querySelector('[data-first-run-nickname]')).toBeNull();
    expect(view.container.querySelector('[data-match-source]')?.getAttribute('data-match-source')).toBe('basic');

    // ② 档案里确认过的两个都在屏上、都是选中态
    expect(view.container.querySelector('[data-assistant="family"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(view.container.querySelector('[data-assistant="research"]')?.getAttribute('aria-pressed')).toBe('true');
    // 没确认过的不出现在这份名单里（推荐里的其它 id 仍然可选，但默认未选）
    expect(view.container.querySelector('[data-assistant="office"]')?.getAttribute('aria-pressed')).toBe('false');
    view.unmount();
  });

  it('没走到过团队确认的档案（没有回执）仍落在资料页', () => {
    const profile = confirmedProfile({ workMatch: undefined, selectedAssistantIds: [] });
    const view = render(
      <Onboarding userId="user-1" mode="edit" initialProfile={profile} onComplete={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(view.container.querySelector('[data-first-run-nickname]')).not.toBeNull();
    expect(view.container.querySelector('[data-result-actions]')).toBeNull();
    view.unmount();
  });

  it.each([
    ['没有行业', { industry: undefined }],
    ['确认名单是空的', { selectedAssistantIds: [] }],
  ])('坏档案（%s）不推一个点不动的复核页：仍落在资料页', (_label, patch) => {
    // 结果页的主按钮走 `confirm()`，缺行业或名单为空时它会**直接 return** ⇒
    // 把人送到那儿等于给一个静默失效的按钮。这类档案一律退回资料页。
    const profile = confirmedProfile(patch as Partial<OnboardingProfile>);
    const onComplete = vi.fn();
    const view = render(
      <Onboarding userId="user-1" mode="edit" initialProfile={profile} onComplete={onComplete} onCancel={vi.fn()} />,
    );
    expect(view.container.querySelector('[data-result-actions]')).toBeNull();
    expect(view.container.querySelector('[data-first-run-nickname]')).not.toBeNull();
    view.unmount();
  });

  it('从重开的结果页能一键回资料页改资料（编辑入口没被吃掉）', () => {
    const view = render(
      <Onboarding userId="user-1" mode="edit" initialProfile={confirmedProfile()} onComplete={vi.fn()} onCancel={vi.fn()} />,
    );
    click(view.container, 'onboarding.firstRun.editProfile');
    expect(view.container.querySelector('[data-first-run-nickname]')).not.toBeNull();
    view.unmount();
  });

  it('重开是只读复核：不写首跑草稿、不改档案，直到用户自己按保存', () => {
    const onComplete = vi.fn();
    const view = render(
      <Onboarding userId="user-1" mode="edit" initialProfile={confirmedProfile()} onComplete={onComplete} onCancel={vi.fn()} />,
    );
    // 编辑模式历来「不读不写」草稿（草稿只会跟真档案打架）——这条不能因为重开落点变化而被破
    expect(readOnboardingDraft(onboardingDraftScope('user-1'))).toBeNull();
    expect(onComplete).not.toHaveBeenCalled();
    // 显式保存才写档案
    click(view.container, 'onboarding.save');
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0]).toMatchObject({
      selectedAssistantIds: ['family', 'research'],
      workMatch: { source: 'basic', profileVersion: 'confirmed-version' },
    });
    view.unmount();
  });

  // ── 对照：首登路径必须一个字不变 ─────────────────────────────────────
  it('对照 · 首登（无草稿）仍旧落在资料页', () => {
    const view = render(<Onboarding userId="user-1" onComplete={vi.fn()} />);
    expect(view.container.querySelector('[data-first-run-nickname]')).not.toBeNull();
    expect(view.container.querySelector('[data-result-actions]')).toBeNull();
    view.unmount();
  });

  it('对照 · 首登草稿停在结果页时仍旧停在结果页', () => {
    const profile = confirmedProfile();
    // 先跑一遍首登到结果页，让草稿落在 result（不确认，草稿就留着）
    const first = render(<Onboarding userId="user-1" onComplete={vi.fn()} />);
    act(() => {
      first.container.querySelector<HTMLButtonElement>('[data-industry="H"]')!.click();
    });
    click(first.container, 'onboarding.firstRun.generate');
    for (let index = 0; index < 4; index += 1) click(first.container, 'onboarding.firstRun.questionSkip');
    click(first.container, 'onboarding.portrait.next');
    expect(first.container.querySelector('[data-result-actions]')).not.toBeNull();
    first.unmount();

    const again = render(<Onboarding userId="user-1" onComplete={vi.fn()} />);
    expect(again.container.querySelector('[data-result-actions]')).not.toBeNull();
    expect(again.container.querySelector('[data-first-run-nickname]')).toBeNull();
    again.unmount();
    // profile 变量只是为了让本用例与上面共用同一份形状认知，断言里不需要它
    expect(profile.version).toBe(3);
  });
});
