// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
import Onboarding from '../src/renderer/layouts/Onboarding';
import i18n from '../src/renderer/i18n';

const cases = [
  { id: 'content', useCase: 'content', workspace: 'content' },
  { id: 'photography', useCase: 'video', workspace: 'video' },
  { id: 'office', useCase: 'office', workspace: 'office' },
  { id: 'research', useCase: 'research', workspace: 'research' },
  { id: 'ecommerce', useCase: 'ecommerce', workspace: 'ecommerce' },
  { id: 'family', useCase: 'family', workspace: 'family' },
];
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  sessionStorage.clear();
});
it.each(
  ['zh', 'en', 'zh-TW', 'ja', 'ko', 'pt', 'de', 'es', 'fr'].flatMap((language) =>
    cases.map((entry) => ({ ...entry, language })),
  ),
)(
  'renders $id recommendation examples using real $language workspace translations',
  async ({ id, useCase, workspace, language }) => {
    await i18n.changeLanguage(language);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const click = (key: string) => {
      const label = i18n.t(key);
      const button = [...container.querySelectorAll('button')].find((element) => element.textContent?.includes(label));
      expect(button, `Missing button ${key}`).toBeDefined();
      act(() => button!.click());
    };
    try {
      act(() => root.render(<Onboarding userId="translation-fixture" onComplete={vi.fn()} />));
      click(`onboarding.useCases.${useCase}.title`);
      act(() => container.querySelector<HTMLButtonElement>('[data-industry="C"]')!.click());
      click('onboarding.firstRun.generate');
      for (let answer = 0; answer < 4; answer++) click('onboarding.firstRun.questionSkip');
      click('onboarding.portrait.next');
      const example = container.querySelector(`[data-assistant="${id}"] [data-skill-task]`);
      expect(example).not.toBeNull();
      const titleKey = `assistantWorkspaces.${workspace}.starters.1.title`;
      const descriptionKey = `assistantWorkspaces.${workspace}.starters.1.description`;
      expect(i18n.exists(titleKey)).toBe(true);
      expect(i18n.exists(descriptionKey)).toBe(true);
      expect(example?.textContent).toBe(`${i18n.t(titleKey)} · ${i18n.t(descriptionKey)}`);
      expect(container.textContent).not.toMatch(/assistantWorkspaces\.[a-z]+\./);
    } finally {
      act(() => root.unmount());
      container.remove();
      await i18n.changeLanguage('en');
    }
  },
);
