// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { resolveAssistantWorkspace } from '../src/renderer/lib/preset-agents';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import AssistantTaskWorkbench from '../src/renderer/layouts/MainArea/AssistantTaskWorkbench';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(ui: ReactElement): {
  container: HTMLDivElement;
  rerender: (nextUi: ReactElement) => void;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    rerender: (nextUi) => act(() => root.render(nextUi)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function renderWorkbench(
  assistantId = 'rongying-content',
  overrides: Partial<React.ComponentProps<typeof AssistantTaskWorkbench>> = {},
) {
  const definition = resolveAssistantWorkspace(assistantId)!;
  const props: React.ComponentProps<typeof AssistantTaskWorkbench> = {
    definition,
    modelLabel: 'DeepSeek V4 Flash',
    ready: true,
    recentPresetIds: [],
    onSelectPreset: vi.fn(),
    onCustomTask: vi.fn(),
    ...overrides,
  };
  return { definition, props, ...render(<AssistantTaskWorkbench {...props} />) };
}

describe('AssistantTaskWorkbench', () => {
  it('renders the identity and four complete task presets for all seven assistants', () => {
    const assistantIds = [
      'main',
      'rongying-content',
      'rongying-video',
      'rongying-office',
      'rongying-ecommerce',
      'rongying-research',
      'rongying-family',
    ];

    for (const assistantId of assistantIds) {
      const { container, definition, unmount } = renderWorkbench(assistantId);
      expect(container.textContent).toContain(definition.emoji);
      expect(container.textContent).toContain(definition.titleKey);
      expect(container.textContent).toContain(definition.descriptionKey);

      const cards = container.querySelectorAll<HTMLButtonElement>('[data-testid="assistant-task-preset"]');
      expect(cards).toHaveLength(4);
      expect(cards[0]?.parentElement?.className).toContain('grid-cols-1');
      expect(cards[0]?.parentElement?.className).toContain('sm:grid-cols-2');
      expect(container.textContent).toContain('taskWorkbench.materialHint');
      expect(container.textContent).toContain('taskWorkbench.output');
      expect(container.textContent).toContain('taskWorkbench.customTask');

      for (const [index, card] of Array.from(cards).entries()) {
        const preset = definition.starters[index]!;
        expect(card.dataset.presetId).toBe(preset.id);
        expect(card.textContent).toContain(preset.titleKey);
        expect(card.textContent).toContain(preset.descriptionKey);
        expect(card.textContent).toContain(preset.materialHintKey);
        expect(card.textContent).toContain(preset.outputKey);
      }
      unmount();
    }
  });

  it('returns the selected preset object instead of only its prompt', () => {
    const onSelectPreset = vi.fn();
    const { container, definition, unmount } = renderWorkbench('rongying-video', { onSelectPreset });

    const secondPreset = container.querySelectorAll<HTMLButtonElement>('[data-testid="assistant-task-preset"]')[1]!;
    act(() => secondPreset.click());

    expect(onSelectPreset).toHaveBeenCalledOnce();
    expect(onSelectPreset).toHaveBeenCalledWith(definition.starters[1]);
    unmount();
  });

  it('shows unique recent presets only when they belong to the current assistant', () => {
    const content = resolveAssistantWorkspace('rongying-content')!;
    const ecommerce = resolveAssistantWorkspace('rongying-ecommerce')!;
    const { container, unmount } = renderWorkbench('rongying-content', {
      recentPresetIds: [
        content.starters[1]!.id,
        ecommerce.starters[0]!.id,
        content.starters[1]!.id,
        'unknown:preset',
        content.starters[3]!.id,
      ],
    });

    const recent = container.querySelectorAll<HTMLButtonElement>('[data-testid="assistant-task-recent-preset"]');
    expect(Array.from(recent, (button) => button.dataset.presetId)).toEqual([
      content.starters[1]!.id,
      content.starters[3]!.id,
    ]);
    expect(container.textContent).toContain('taskWorkbench.recentTasks');
    unmount();
  });

  it('exposes readiness details and the custom task action as keyboard buttons', () => {
    const onCustomTask = vi.fn();
    const { container, props, rerender, unmount } = renderWorkbench('main', { ready: false, onCustomTask });

    expect(container.textContent).toContain('DeepSeek V4 Flash');
    expect(container.textContent).toContain('startupReadiness.aiStarting');
    const readinessStatus = container.querySelector<HTMLElement>('[role="status"]');
    expect(readinessStatus?.getAttribute('aria-live')).toBe('polite');
    expect(readinessStatus?.getAttribute('aria-atomic')).toBe('true');

    rerender(<AssistantTaskWorkbench {...props} ready />);
    expect(readinessStatus?.textContent).toContain('startupReadiness.aiReady');
    expect(readinessStatus?.textContent).not.toContain('startupReadiness.aiStarting');

    const buttons = container.querySelectorAll<HTMLButtonElement>('button');
    expect(Array.from(buttons).every((button) => button.type === 'button')).toBe(true);
    expect(Array.from(buttons).every((button) => button.className.includes('glow-focus'))).toBe(true);

    const customButton = container.querySelector<HTMLButtonElement>('[data-testid="assistant-task-custom"]')!;
    act(() => customButton.click());
    expect(onCustomTask).toHaveBeenCalledOnce();
    unmount();
  });

  it('does not invent counts, ratings, income, or offline-data assurances', () => {
    const { container, unmount } = renderWorkbench();
    expect(container.textContent).not.toMatch(
      /\d+(?:\.\d+)?\s*(?:万|k|\+)?\s*(?:人|用户)?\s*(?:在线|online)|(?:评分|评级)\s*[:：]?\s*\d(?:\.\d+)?|\d(?:\.\d+)?\s*(?:分|星)\s*(?:好评)?|(?:月入|年入)\s*(?:(?:￥|¥|\$)?\s*\d+|过万|上万|百万)|收入(?:提升|增长|增加)\s*\d+|(?:数据|文件|内容)(?:绝不|不会|不)(?:上传|离开本地|出本地)|(?:完全|百分之百|100%)\s*(?:离线|本地|私密|安全)|隐私(?:绝对|完全|百分之百|100%)保障/iu,
    );
    unmount();
  });
});
