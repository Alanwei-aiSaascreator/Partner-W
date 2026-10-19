// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 左栏底部「个人资料」（2026-10-17 晚，用户给的设计稿）：
 * 点开后是 用量与积分 / 游戏化中心 / 应用设置 三项。
 */
const mocks = vi.hoisted(() => ({
  overview: null as unknown,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('../src/renderer/stores/commercialStore', () => ({
  useCommercialStore: <T,>(selector: (state: { overview: unknown }) => T) => selector({ overview: mocks.overview }),
}));

import ProfileMenu from '../src/renderer/layouts/LeftNav/ProfileMenu';
import { mbtiAvatarArtworkFor } from '../src/renderer/lib/mbti-artwork';
import { portraitArtworkFor } from '../src/renderer/lib/portrait-artwork';
import {
  saveOnboardingProfile,
  type OnboardingProfile,
} from '../src/renderer/lib/user-onboarding';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function mount(over: Partial<Parameters<typeof ProfileMenu>[0]> = {}): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const ui: ReactElement = (
    <ProfileMenu
      collapsed={false}
      mainView="chat"
      settingsOpen={false}
      hasUpdate={false}
      onSelectView={vi.fn()}
      onOpenSettings={vi.fn()}
      {...over}
    />
  );
  act(() => root.render(ui));
}

function click(el: Element | null): void {
  if (!el) throw new Error('element missing');
  act(() => {
    (el as HTMLElement).click();
  });
}

/** v3 档案的最小合法形状（四件套不能少，否则 `loadOnboardingProfile` 整份拒收）。 */
function profileFor(
  userId: string,
  portrait: { letters: string; role: string; gender?: 'male' | 'female' } | null,
): OnboardingProfile {
  return {
    version: 3,
    userId,
    nickname: '小盈',
    useCases: ['content'],
    customGoal: '',
    completedAt: '2026-10-18T00:00:00.000Z',
    industry: { code: 'C', generalConfirmed: false, source: 'user', catalogVersion: 1 },
    questionnaire: { version: 1, answers: [null, null, null, null] },
    persona: { id: null, source: 'default', ruleVersion: null },
    workMatch: { source: 'basic', profileVersion: 'v1' },
    ...(portrait
      ? {
          portrait: {
            axes: { 外向力: 60, 探索力: 60, 理性力: 60, 条理力: 60, 共情力: 60 },
            letters: portrait.letters,
            role: portrait.role as NonNullable<OnboardingProfile['portrait']>['role'],
            ruleVersion: 'portrait-v1',
            locked: true,
            ...(portrait.gender ? { gender: portrait.gender } : {}),
          },
        }
      : {}),
  };
}

function avatarSrc(): string | null {
  return container.querySelector('[data-testid="profile-avatar"]')?.getAttribute('src') ?? null;
}

beforeEach(() => {
  window.localStorage.clear();
  mocks.overview = {
    account: { userId: 'user-1', nickname: '小盈', avatar: null },
    license: { tokenQuotaMicros: 1_000e6, tokenUsedMicros: 100e6, tokenHeldMicros: 50e6, heldComplete: true },
  };
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('ProfileMenu', () => {
  it('显示账号名；点开后是用量与积分 / 游戏化中心 / 应用设置', () => {
    mount();
    const trigger = container.querySelector('[data-testid="left-nav-profile"]');
    expect(trigger?.textContent).toContain('小盈');

    click(trigger);
    const items = [...document.querySelectorAll('[data-profile-item]')].map((el) => el.getAttribute('data-profile-item'));
    expect(items).toEqual(['usage', 'growth', 'settings']);
  });

  it('用量与积分显示 quota − used − held', () => {
    mount();
    click(container.querySelector('[data-testid="left-nav-profile"]'));
    const usage = document.querySelector('[data-profile-item="usage"]');
    // 1000 - 100 - 50 = 850
    expect(usage?.textContent).toContain('850');
  });

  it('预占口径不可判定 ⇒ 不显示确定数字', () => {
    mocks.overview = {
      account: { nickname: '小盈', avatar: null },
      license: { tokenQuotaMicros: 1_000e6, tokenUsedMicros: 100e6, heldComplete: false },
    };
    mount();
    click(container.querySelector('[data-testid="left-nav-profile"]'));
    const usage = document.querySelector('[data-profile-item="usage"]');
    expect(usage?.textContent).not.toMatch(/\d{2,}/);
  });

  it('点「游戏化中心」切页面，点「应用设置」开设置', () => {
    const onSelectView = vi.fn();
    const onOpenSettings = vi.fn();
    mount({ onSelectView, onOpenSettings });

    click(container.querySelector('[data-testid="left-nav-profile"]'));
    click(document.querySelector('[data-profile-item="growth"]'));
    expect(onSelectView).toHaveBeenCalledWith('growth');

    click(container.querySelector('[data-testid="left-nav-profile"]'));
    click(document.querySelector('[data-profile-item="settings"]'));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it('有更新时个人资料头像上带一个小点（原来在设置项上的角标不丢）', () => {
    mount({ hasUpdate: true });
    expect(container.querySelector('[data-testid="profile-update-dot"]')).not.toBeNull();
  });
});

/**
 * 头像（2026-10-18 用户实测）：「这个头像可以用用户画像，如果用户没有设置就是默认荣盈魔方图标。」
 * 真源 = `rongying-cube:onboarding:v3:<userId>`（只读选择器，没有第二套 store）。
 */
describe('ProfileMenu 头像', () => {
  it('有画像 ⇒ 优先 16 型圆头像（四字码 + 性别都齐）', () => {
    saveOnboardingProfile(profileFor('user-1', { letters: 'ESTJ', role: 'hengchuan', gender: 'female' }));
    mount();
    expect(avatarSrc()).toBe(mbtiAvatarArtworkFor('ESTJ', 'female'));
  });

  it('画像缺性别 / 四字码不完整 ⇒ 退回六角色立绘（旧链原样）', () => {
    saveOnboardingProfile(profileFor('user-1', { letters: 'ESTJ', role: 'baina' }));
    mount();
    expect(avatarSrc()).toBe(portraitArtworkFor('baina'));
  });

  it('没设置画像 ⇒ 荣盈魔方品牌图标（不是默认人形图标）', () => {
    mount();
    expect(avatarSrc()).toBeNull();
    expect(container.querySelector('[data-testid="profile-avatar-brand"]')).not.toBeNull();
  });

  it('个性化中心换头像 ⇒ 当场反映（不靠重挂载）', () => {
    mount();
    expect(container.querySelector('[data-testid="profile-avatar-brand"]')).not.toBeNull();

    act(() => {
      saveOnboardingProfile(profileFor('user-1', { letters: 'ESTJ', role: 'hengchuan', gender: 'female' }));
    });

    expect(avatarSrc()).toBe(mbtiAvatarArtworkFor('ESTJ', 'female'));
    expect(container.querySelector('[data-testid="profile-avatar-brand"]')).toBeNull();
  });

  it('盘上还有别的账号的画像时，当前账号没设置 ⇒ 品牌图标（不拿别人的顶上）', () => {
    saveOnboardingProfile(profileFor('user-2', { letters: 'ENTJ', role: 'yangsheng', gender: 'male' }));
    mount();
    expect(avatarSrc()).toBeNull();
    expect(container.querySelector('[data-testid="profile-avatar-brand"]')).not.toBeNull();
  });

  it('别的账号换了画像不改变当前账号的头像（多账号盘不串）', () => {
    saveOnboardingProfile(profileFor('user-1', { letters: 'ESTJ', role: 'hengchuan', gender: 'female' }));
    mount();
    const before = avatarSrc();
    expect(before).toBe(mbtiAvatarArtworkFor('ESTJ', 'female'));

    act(() => {
      saveOnboardingProfile(profileFor('user-2', { letters: 'ENTJ', role: 'yangsheng', gender: 'male' }));
    });

    expect(avatarSrc()).toBe(before);
  });
});
