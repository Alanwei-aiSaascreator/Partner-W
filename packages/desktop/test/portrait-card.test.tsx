// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const translationMode = vi.hoisted(() => ({ real: false }));
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => (translationMode.real ? actual.useTranslation() : { t: (key: string) => key }),
  };
});

/**
 * 立绘表打桩：枕山有图、其余视为素材未就位 —— 「有图 / 缺图 / 坏图」三条路都能确定性复现，
 * 不依赖素材是否已经放进 `assets/personas/`。
 */
vi.mock('@/lib/portrait-artwork', () => ({
  portraitArtworkFor: (code: string) => (code === 'zhenshan' ? '/assets/personas/persona-zhenshan.webp' : null),
}));

/**
 * 16 型素材表同样打桩：只有 ENFJ + 女有图 —— 「有 16 型卡 / 缺 16 型卡退回立绘 / 两者皆缺」
 * 三条路都能确定性复现，不依赖真实素材（真实素材链由 `mbti-artwork.test.ts` 钉住）。
 */
vi.mock('@/lib/mbti-artwork', () => ({
  mbtiCardArtworkFor: (letters: string, gender: string | null | undefined) =>
    letters === 'ENFJ' && gender === 'female' ? '/assets/mbti/mbti-ENFJ-f.webp' : null,
}));

import PortraitCard from '../src/renderer/components/PortraitCard';
import { derivePortrait } from '../src/renderer/lib/user-portrait';

function render(ui: ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    rerender: (next: ReactElement) => {
      act(() => root.render(next));
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const allYes = derivePortrait(['yes', 'yes', 'yes', 'yes']);
const allNo = derivePortrait(['no', 'no', 'no', 'no']);

describe('PortraitCard', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    translationMode.real = false;
  });

  it('keeps result portraits compact without a radar or implicit column span, while full stays the default', () => {
    const view = render(
      <PortraitCard axes={allYes.axes} letters="ENFJ" role="zhenshan" gender="female" variant="compact" />,
    );
    const card = view.container.querySelector('[data-testid="portrait-card"]')!;
    expect(card.getAttribute('data-variant')).toBe('compact');
    expect(card.querySelector('[data-testid="portrait-radar"]')).toBeNull();
    expect(card.querySelector('[data-mbti-artwork]')?.className).toContain('h-40');
    expect(card.querySelector('[class*="col-span"]')).toBeNull();
    act(() => card.querySelector('[data-mbti-artwork]')!.dispatchEvent(new Event('error')));
    expect(card.querySelector('[data-portrait-artwork]')).not.toBeNull();
    view.rerender(<PortraitCard axes={allYes.axes} letters="ESTJ" role="zhenshan" />);
    expect(view.container.querySelector('[data-testid="portrait-card"]')?.getAttribute('data-variant')).toBe('full');
    expect(view.container.querySelector('[data-testid="portrait-radar"]')).not.toBeNull();
    view.unmount();
  });

  it('renders the role artwork when it is available and the placeholder when it is not', () => {
    const withArtwork = render(<PortraitCard axes={allYes.axes} letters={allYes.letters} role="zhenshan" />);
    expect(withArtwork.container.querySelector('[data-portrait-artwork]')).not.toBeNull();
    expect(withArtwork.container.querySelector('[data-portrait-fallback]')).toBeNull();
    withArtwork.unmount();

    const withoutArtwork = render(<PortraitCard axes={allYes.axes} letters={allYes.letters} role="hewei" />);
    expect(withoutArtwork.container.querySelector('[data-portrait-artwork]')).toBeNull();
    expect(withoutArtwork.container.querySelector('[data-portrait-fallback]')?.textContent).toContain(
      'onboarding.firstRun.personaUnavailable',
    );
    withoutArtwork.unmount();
  });

  it('falls back to the placeholder when the artwork file is broken', () => {
    const view = render(<PortraitCard axes={allYes.axes} letters={allYes.letters} role="zhenshan" />);
    const artwork = view.container.querySelector('[data-portrait-artwork]')!;
    act(() => {
      artwork.dispatchEvent(new Event('error'));
    });
    expect(view.container.querySelector('[data-portrait-artwork]')).toBeNull();
    expect(view.container.querySelector('[data-portrait-fallback]')?.textContent).toContain(
      'onboarding.firstRun.personaUnavailable',
    );
    view.unmount();
  });

  it('draws one radar vertex per dimension with the real scores and reshapes when they change', () => {
    const view = render(<PortraitCard axes={allYes.axes} letters={allYes.letters} role="hengchuan" />);
    const radar = view.container.querySelector('[data-testid="portrait-radar"]');
    expect(radar).not.toBeNull();
    const vertices = [...view.container.querySelectorAll('[data-testid="portrait-radar"] circle[data-score]')];
    expect(vertices.map((vertex) => vertex.getAttribute('data-axis'))).toEqual([
      '外向力',
      '探索力',
      '理性力',
      '条理力',
      '共情力',
    ]);
    expect(vertices.map((vertex) => vertex.getAttribute('data-score'))).toEqual(['80', '70', '80', '80', '65']);

    const before = view.container.querySelector('[data-radar-shape]')?.getAttribute('points');
    expect(before).toBeTruthy();
    view.rerender(<PortraitCard axes={allNo.axes} letters={allNo.letters} role="hewei" />);
    expect(view.container.querySelector('[data-radar-shape]')?.getAttribute('points')).not.toBe(before);
    view.unmount();
  });

  it('shows the role name, the one-line description and the four-letter fun code', () => {
    const view = render(<PortraitCard axes={allYes.axes} letters="ESTJ" role="zhenshan" />);
    expect(view.container.querySelector('[data-testid="portrait-card"]')?.getAttribute('data-role')).toBe('zhenshan');
    expect(view.container.textContent).toContain('onboarding.portrait.roles.zhenshan.name');
    expect(view.container.textContent).toContain('onboarding.portrait.roles.zhenshan.description');
    expect(view.container.querySelector('[data-portrait-letters]')?.textContent).toBe('ESTJ');
    expect(view.container.textContent).toContain('onboarding.portrait.letters');
    view.unmount();
  });

  it('shows the 16-type name and one-liner only when all four answers are known', () => {
    const view = render(<PortraitCard axes={allYes.axes} letters="ESTJ" role="hengchuan" />);
    expect(view.container.querySelector('[data-portrait-partial]')).toBeNull();
    expect(view.container.textContent).toContain('onboarding.firstRun.types.ESTJ.name');
    expect(view.container.textContent).toContain('onboarding.firstRun.types.ESTJ.line');
    view.unmount();
  });

  it('marks skipped letters as unknown and refuses to look up a type for a partial code', () => {
    const view = render(<PortraitCard axes={allNo.axes} letters="ENXJ" role="hewei" />);
    expect(view.container.querySelector('[data-portrait-letters]')?.textContent).toBe('EN?J');
    expect(view.container.querySelector('[data-portrait-partial]')?.textContent).toContain(
      'onboarding.firstRun.types.partial',
    );
    // 未作答不许编类型名 / 一句话出来
    expect(view.container.textContent).not.toMatch(/onboarding\.firstRun\.types\.[A-Z]{4}\./);
    view.unmount();
  });
});

/**
 * 16 型形象（2026-10-08）：完整四字码 + 性别 ⇒ 16 型全身卡 + 卡面「类型 · 性别 · 年龄」行；
 * 缺任一件或图没到位 ⇒ 六角色立绘（旧链一个字没动）；两者皆缺 ⇒ 既有占位。
 */
describe('PortraitCard 16 型形象', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    translationMode.real = false;
  });

  it('完整四字码 + 性别 + 有图 ⇒ 16 型全身卡（不再画六角色立绘）', () => {
    const view = render(<PortraitCard axes={allYes.axes} letters="ENFJ" role="hewei" gender="female" age={28} />);
    expect(view.container.querySelector('[data-mbti-artwork]')?.getAttribute('src')).toContain('mbti-ENFJ-f');
    expect(view.container.querySelector('[data-portrait-artwork]')).toBeNull();
    expect(view.container.querySelector('[data-portrait-fallback]')).toBeNull();
    expect(view.container.querySelector('[data-testid="portrait-card"]')?.getAttribute('data-artwork-source')).toBe(
      'mbti',
    );
    view.unmount();
  });

  it('卡面文案区显示「四字码 · 性别 · 年龄」（缺年龄就不显示那一段）', () => {
    const view = render(<PortraitCard axes={allYes.axes} letters="ENFJ" role="hewei" gender="female" age={28} />);
    expect(view.container.querySelector('[data-portrait-mbti-type]')?.textContent).toBe('ENFJ');
    expect(view.container.querySelector('[data-portrait-gender]')?.textContent).toBe(
      'onboarding.portrait.gender.female',
    );
    expect(view.container.querySelector('[data-portrait-age]')?.textContent).toBe('28');
    expect(view.container.textContent).toContain('onboarding.portrait.typeLabel');
    expect(view.container.textContent).toContain('onboarding.portrait.genderLabel');
    expect(view.container.textContent).toContain('onboarding.portrait.ageLabel');
    view.unmount();

    const bare = render(<PortraitCard axes={allYes.axes} letters="ENFJ" role="hewei" gender="male" />);
    expect(bare.container.querySelector('[data-portrait-age]')).toBeNull();
    expect(bare.container.textContent).not.toContain('onboarding.portrait.ageLabel');
    bare.unmount();
  });

  it('四字码不完整 / 性别没填 ⇒ 一行都不出现，退回六角色立绘', () => {
    const partial = render(<PortraitCard axes={allYes.axes} letters="ENXJ" role="zhenshan" gender="female" />);
    expect(partial.container.querySelector('[data-portrait-identity]')).toBeNull();
    expect(partial.container.querySelector('[data-portrait-artwork]')?.getAttribute('src')).toContain(
      'persona-zhenshan',
    );
    partial.unmount();

    const noGender = render(<PortraitCard axes={allYes.axes} letters="ENFJ" role="zhenshan" />);
    expect(noGender.container.querySelector('[data-portrait-identity]')).toBeNull();
    expect(noGender.container.querySelector('[data-mbti-artwork]')).toBeNull();
    expect(noGender.container.querySelector('[data-portrait-artwork]')?.getAttribute('src')).toContain(
      'persona-zhenshan',
    );
    noGender.unmount();
  });

  it('16 型素材缺图 ⇒ 退回六角色立绘（不是占位、也不破图）', () => {
    // ESTJ + 女：打桩表里没有这张 ⇒ 走立绘
    const view = render(<PortraitCard axes={allYes.axes} letters="ESTJ" role="zhenshan" gender="female" age={30} />);
    expect(view.container.querySelector('[data-mbti-artwork]')).toBeNull();
    expect(view.container.querySelector('[data-portrait-artwork]')?.getAttribute('src')).toContain('persona-zhenshan');
    // 身份行说的是真实身份（类型/性别/年龄），与"这次用的是哪张图"无关
    expect(view.container.querySelector('[data-portrait-identity]')).not.toBeNull();
    view.unmount();
  });

  it('16 型全身卡坏图 ⇒ 退回六角色立绘，再缺才占位', () => {
    const view = render(<PortraitCard axes={allYes.axes} letters="ENFJ" role="zhenshan" gender="female" />);
    const broken = view.container.querySelector('[data-mbti-artwork]')!;
    act(() => {
      broken.dispatchEvent(new Event('error'));
    });
    expect(view.container.querySelector('[data-mbti-artwork]')).toBeNull();
    expect(view.container.querySelector('[data-portrait-artwork]')?.getAttribute('src')).toContain('persona-zhenshan');
    view.unmount();

    // 两者皆缺（既没有 16 型图、角色也没立绘）⇒ 既有占位文案
    const empty = render(<PortraitCard axes={allYes.axes} letters="ENFJ" role="hewei" gender="male" />);
    expect(empty.container.querySelector('[data-mbti-artwork]')).toBeNull();
    expect(empty.container.querySelector('[data-portrait-artwork]')).toBeNull();
    expect(empty.container.querySelector('[data-portrait-fallback]')?.textContent).toContain(
      'onboarding.firstRun.personaUnavailable',
    );
    empty.unmount();
  });
});
