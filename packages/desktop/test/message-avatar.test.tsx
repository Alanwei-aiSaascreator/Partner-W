// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MessageAvatar from '../src/renderer/components/MessageAvatar';
import { saveOnboardingProfile, type OnboardingProfile } from '../src/renderer/lib/user-onboarding';

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

describe('MessageAvatar local avatar lookup', () => {
  const listLocalAvatars = vi.fn();

  beforeEach(() => {
    listLocalAvatars.mockReset();
    window.localStorage.clear();
    Object.defineProperty(window, 'clawwork', {
      configurable: true,
      value: { listLocalAvatars },
    });
  });

  it('does not request a missing local avatar before falling back to the gateway avatar', async () => {
    listLocalAvatars.mockResolvedValue({ ok: true, result: [] });
    const view = render(
      <MessageAvatar
        role="assistant"
        localAvatarUrl="clawwork-avatar://gw/writer"
        gatewayAvatarUrl="https://example.test/writer.png"
      />,
    );

    await act(async () => Promise.resolve());

    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('https://example.test/writer.png');
    expect(view.container.innerHTML).not.toContain('clawwork-avatar://');
    view.unmount();
  });

  it('uses the local protocol URL only after the main process confirms the file exists', async () => {
    listLocalAvatars.mockResolvedValue({ ok: true, result: ['writer'] });
    const view = render(
      <MessageAvatar role="assistant" localAvatarUrl="clawwork-avatar://gw/writer" agentEmoji="✍️" />,
    );

    await act(async () => Promise.resolve());

    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('clawwork-avatar://gw/writer');
    view.unmount();
  });
});

/**
 * 06 头像链：用户头像。有画像角色立绘就渲染 `<img>`（与 `PortraitCard` 同一条素材链），
 * 没有就保持既有 lucide User 图标 —— 两条路都不许破图/崩。
 */
describe('MessageAvatar user portrait artwork', () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window, 'clawwork', {
      configurable: true,
      value: { listLocalAvatars: vi.fn(async () => ({ ok: true, result: [] })) },
    });
  });

  it('renders the persona artwork when the profile role is known (not only zhenshan)', () => {
    const view = render(<MessageAvatar role="user" portraitRole="hewei" />);
    expect(view.container.querySelector('[data-user-portrait]')?.getAttribute('src')).toContain('persona-hewei');
    view.unmount();

    const second = render(<MessageAvatar role="user" portraitRole="baina" />);
    expect(second.container.querySelector('[data-user-portrait]')?.getAttribute('src')).toContain('persona-baina');
    second.unmount();
  });

  it('falls back to the plain user icon when there is no profile portrait', () => {
    const view = render(<MessageAvatar role="user" />);
    expect(view.container.querySelector('[data-user-portrait]')).toBeNull();
    expect(view.container.querySelector('svg')).not.toBeNull();
    view.unmount();
  });

  it('falls back to the icon when the artwork file is broken', () => {
    const view = render(<MessageAvatar role="user" portraitRole="zhiwei" />);
    const artwork = view.container.querySelector('[data-user-portrait]')!;
    act(() => {
      artwork.dispatchEvent(new Event('error'));
    });
    expect(view.container.querySelector('[data-user-portrait]')).toBeNull();
    expect(view.container.querySelector('svg')).not.toBeNull();
    view.unmount();
  });

  it('⭐ without an explicit prop it reads the stored profile once (read-only selector)', () => {
    saveOnboardingProfile(storedProfile('yangsheng'));
    const view = render(<MessageAvatar role="user" />);
    expect(view.container.querySelector('[data-user-portrait]')?.getAttribute('src')).toContain('persona-yangsheng');
    view.unmount();
  });

  it('⭐ 带了 userId 就按账号读（2026-10-07 体检问题 5：两个账号不串立绘）', () => {
    saveOnboardingProfile(storedProfile('yangsheng', 'user-1'));
    saveOnboardingProfile(storedProfile('baina', 'user-2'));

    const second = render(<MessageAvatar role="user" userId="user-2" />);
    expect(second.container.querySelector('[data-user-portrait]')?.getAttribute('src')).toContain('persona-baina');
    second.unmount();

    // 点了名的账号没有档案 ⇒ 退回图标，绝不拿盘上第一份顶上
    const stranger = render(<MessageAvatar role="user" userId="user-3" />);
    expect(stranger.container.querySelector('[data-user-portrait]')).toBeNull();
    stranger.unmount();
  });

  it('an explicit null prop wins over the stored profile (no surprise artwork)', () => {
    saveOnboardingProfile(storedProfile('yangsheng'));
    const view = render(<MessageAvatar role="user" portraitRole={null} />);
    expect(view.container.querySelector('[data-user-portrait]')).toBeNull();
    expect(view.container.querySelector('svg')).not.toBeNull();
    view.unmount();
  });

  it('⭐ 四字码 + 性别都有 ⇒ 优先 16 型圆头像（不是六角色立绘）', () => {
    const view = render(
      <MessageAvatar role="user" portraitRole="hewei" portraitLetters="ENFJ" portraitGender="female" />,
    );
    const img = view.container.querySelector('[data-user-portrait]')!;
    expect(img.getAttribute('src')).toContain('mbti-ENFJ-f-avatar');
    expect(img.hasAttribute('data-mbti-avatar')).toBe(true);
    view.unmount();

    // 男/女真的是两套素材
    const male = render(
      <MessageAvatar role="user" portraitRole="hewei" portraitLetters="ENFJ" portraitGender="male" />,
    );
    expect(male.container.querySelector('[data-user-portrait]')?.getAttribute('src')).toContain('mbti-ENFJ-m-avatar');
    male.unmount();
  });

  it('缺四字码或缺性别就退回六角色立绘（三级降级：16 型 → 立绘 → 图标）', () => {
    // ① 只有角色（旧调用口径）：立绘
    const roleOnly = render(<MessageAvatar role="user" portraitRole="hewei" />);
    expect(roleOnly.container.querySelector('[data-user-portrait]')?.getAttribute('src')).toContain('persona-hewei');
    expect(roleOnly.container.querySelector('[data-mbti-avatar]')).toBeNull();
    roleOnly.unmount();

    // ② 有性别但四字码带跳过位：立绘（不拿半份画像蒙 16 型头像）
    const partial = render(
      <MessageAvatar role="user" portraitRole="hewei" portraitLetters="ENXJ" portraitGender="female" />,
    );
    expect(partial.container.querySelector('[data-user-portrait]')?.getAttribute('src')).toContain('persona-hewei');
    expect(partial.container.querySelector('[data-mbti-avatar]')).toBeNull();
    partial.unmount();

    // ③ 四字码完整但没选性别：立绘
    const noGender = render(<MessageAvatar role="user" portraitRole="hewei" portraitLetters="ENFJ" />);
    expect(noGender.container.querySelector('[data-user-portrait]')?.getAttribute('src')).toContain('persona-hewei');
    expect(noGender.container.querySelector('[data-mbti-avatar]')).toBeNull();
    noGender.unmount();
  });

  it('16 型头像坏图 ⇒ 退回六角色立绘，不许破图', () => {
    const view = render(
      <MessageAvatar role="user" portraitRole="hewei" portraitLetters="ENFJ" portraitGender="male" />,
    );
    const img = view.container.querySelector('[data-user-portrait]')!;
    act(() => {
      img.dispatchEvent(new Event('error'));
    });
    const fallback = view.container.querySelector('[data-user-portrait]');
    expect(fallback).not.toBeNull();
    expect(fallback?.getAttribute('src')).toContain('persona-hewei');
    expect(view.container.querySelector('[data-mbti-avatar]')).toBeNull();
    view.unmount();
  });

  it('不带 props 时从档案里连四字码与性别一起读（只读选择器）', () => {
    saveOnboardingProfile(storedProfile('hewei', 'user-1', { gender: 'female' }));
    const view = render(<MessageAvatar role="user" userId="user-1" />);
    expect(view.container.querySelector('[data-user-portrait]')?.getAttribute('src')).toContain('mbti-ESTJ-f-avatar');
    view.unmount();

    // 旧档案（没有 gender 键）照读：立绘，不假装有 16 型头像
    saveOnboardingProfile(storedProfile('hewei', 'user-2'));
    const legacy = render(<MessageAvatar role="user" userId="user-2" />);
    expect(legacy.container.querySelector('[data-user-portrait]')?.getAttribute('src')).toContain('persona-hewei');
    expect(legacy.container.querySelector('[data-mbti-avatar]')).toBeNull();
    legacy.unmount();
  });

  it('keeps the assistant avatar untouched (no user artwork leaks in)', () => {
    const view = render(<MessageAvatar role="assistant" agentEmoji="✍️" />);
    expect(view.container.querySelector('[data-user-portrait]')).toBeNull();
    expect(view.container.textContent).toContain('✍️');
    view.unmount();
  });
});

/** 一份最小 v3 档案：只有画像角色是这条链关心的（其余四件套是 v3 记录的必填校验）。 */
function storedProfile(
  role: string,
  account = 'user-1',
  extra: { letters?: string; gender?: 'male' | 'female'; age?: number } = {},
): OnboardingProfile {
  return {
    version: 3,
    userId: account,
    nickname: '',
    useCases: [],
    customGoal: '',
    completedAt: '2026-10-05T00:00:00.000Z',
    industry: { code: null, generalConfirmed: true, source: 'user', catalogVersion: 1 },
    questionnaire: { version: 1, answers: [null, null, null, null] },
    persona: { id: null, source: 'default', ruleVersion: null },
    workMatch: { source: 'basic', profileVersion: 'v1' },
    portrait: {
      axes: { 外向力: 60, 探索力: 60, 理性力: 60, 条理力: 60, 共情力: 60 },
      letters: extra.letters ?? 'ESTJ',
      role: role as NonNullable<OnboardingProfile['portrait']>['role'],
      ruleVersion: 'portrait-v1',
      locked: true,
      ...(extra.gender ? { gender: extra.gender } : {}),
      ...(extra.age ? { age: extra.age } : {}),
    },
  };
}
