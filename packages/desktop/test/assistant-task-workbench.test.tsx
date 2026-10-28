// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import i18n from '../src/renderer/i18n';
import { resolveAssistantWorkspace } from '../src/renderer/lib/preset-agents';

import AssistantTaskWorkbench from '../src/renderer/layouts/MainArea/AssistantTaskWorkbench';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await i18n.changeLanguage('zh');
});

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
  assistantId = 'partner-w-content',
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
  it('defines complete, non-empty workbench copy in the real Chinese and English resources', () => {
    const sharedKeys = [
      'recentTasks',
      'materialHint',
      'output',
      'customTask',
      'draftConflictTitle',
      'draftConflictDescription',
      'appendDraft',
      'replaceDraft',
    ];
    const definitions = [
      'main',
      'partner-w-content',
      'partner-w-video',
      'partner-w-office',
      'partner-w-ecommerce',
      'partner-w-research',
      'partner-w-family',
    ].map((id) => resolveAssistantWorkspace(id)!);

    for (const locale of ['zh', 'en']) {
      const t = i18n.getFixedT(locale);
      for (const key of sharedKeys) {
        const translationKey = `taskWorkbench.${key}`;
        expect(t(translationKey), `${locale}: ${translationKey}`).not.toBe(translationKey);
        expect(t(translationKey).trim(), `${locale}: ${translationKey}`).not.toBe('');
      }

      for (const definition of definitions) {
        for (const preset of definition.starters) {
          for (const key of [preset.materialHintKey, preset.outputKey]) {
            expect(t(key), `${locale}: ${key}`).not.toBe(key);
            expect(t(key).trim(), `${locale}: ${key}`).not.toBe('');
          }
        }
      }
    }
  });

  it('renders the short-video and rewrite task metadata on their matching content cards', () => {
    const { container, unmount } = renderWorkbench('partner-w-content');
    const shortVideoCard = container.querySelector<HTMLElement>('[data-preset-id="content:short-video-script"]');
    const rewriteCard = container.querySelector<HTMLElement>('[data-preset-id="content:rewrite-polish"]');

    expect(shortVideoCard?.textContent).toContain('短视频脚本');
    expect(shortVideoCard?.textContent).toContain('主题、平台、目标受众、视频时长、产品信息和参考内容（可选）');
    expect(shortVideoCard?.textContent).toContain('包含开场钩子、口播、画面提示、节奏和行动引导的短视频脚本');
    expect(rewriteCard?.textContent).toContain('改写润色');
    expect(rewriteCard?.textContent).toContain('原文、发布平台、目标受众、目标语气和需要保留的事实（可选）');
    expect(rewriteCard?.textContent).toContain('保留原意的润色稿、修改说明和可选标题');

    unmount();
  });

  it('renders the identity and four complete task presets for all seven assistants', () => {
    const assistantIds = [
      'main',
      'partner-w-content',
      'partner-w-video',
      'partner-w-office',
      'partner-w-ecommerce',
      'partner-w-research',
      'partner-w-family',
    ];

    for (const assistantId of assistantIds) {
      const { container, definition, unmount } = renderWorkbench(assistantId);
      expect(container.textContent).toContain(definition.emoji);
      expect(container.textContent).toContain(i18n.t(definition.titleKey));
      expect(container.textContent).toContain(i18n.t(definition.descriptionKey));

      const cards = container.querySelectorAll<HTMLButtonElement>('[data-testid="assistant-task-preset"]');
      expect(cards).toHaveLength(4);
      expect(cards[0]?.parentElement?.className).toContain('grid-cols-1');
      expect(cards[0]?.parentElement?.className).toContain('sm:grid-cols-2');
      expect(container.textContent).toContain('建议资料');
      expect(container.textContent).toContain('预期成果');
      expect(container.textContent).toContain('自定义任务');

      for (const [index, card] of Array.from(cards).entries()) {
        const preset = definition.starters[index]!;
        expect(card.dataset.presetId).toBe(preset.id);
        expect(card.textContent).toContain(i18n.t(preset.titleKey));
        expect(card.textContent).toContain(i18n.t(preset.descriptionKey));
        expect(card.textContent).toContain(i18n.t(preset.materialHintKey));
        expect(card.textContent).toContain(i18n.t(preset.outputKey));
      }
      unmount();
    }
  });

  it('returns the selected preset object instead of only its prompt', () => {
    const onSelectPreset = vi.fn();
    const { container, definition, unmount } = renderWorkbench('partner-w-video', { onSelectPreset });

    const secondPreset = container.querySelectorAll<HTMLButtonElement>('[data-testid="assistant-task-preset"]')[1]!;
    act(() => secondPreset.click());

    expect(onSelectPreset).toHaveBeenCalledOnce();
    expect(onSelectPreset).toHaveBeenCalledWith(definition.starters[1]);
    unmount();
  });

  it('shows unique recent presets only when they belong to the current assistant', () => {
    const content = resolveAssistantWorkspace('partner-w-content')!;
    const ecommerce = resolveAssistantWorkspace('partner-w-ecommerce')!;
    const { container, unmount } = renderWorkbench('partner-w-content', {
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
    expect(container.textContent).toContain('最近使用');
    unmount();
  });

  it('exposes readiness details and the custom task action as keyboard buttons', () => {
    const onCustomTask = vi.fn();
    const { container, props, rerender, unmount } = renderWorkbench('main', { ready: false, onCustomTask });

    expect(container.textContent).toContain('DeepSeek V4 Flash');
    expect(container.textContent).toContain(i18n.t('startupReadiness.aiStarting'));
    const readinessStatus = container.querySelector<HTMLElement>('[role="status"]');
    expect(readinessStatus?.getAttribute('aria-live')).toBe('polite');
    expect(readinessStatus?.getAttribute('aria-atomic')).toBe('true');
    expect(container.querySelector('.animate-spin')?.getAttribute('class')).toContain('motion-reduce:animate-none');

    rerender(<AssistantTaskWorkbench {...props} ready />);
    expect(readinessStatus?.textContent).toContain(i18n.t('startupReadiness.aiReady'));
    expect(readinessStatus?.textContent).not.toContain(i18n.t('startupReadiness.aiStarting'));

    const buttons = container.querySelectorAll<HTMLButtonElement>('button');
    expect(Array.from(buttons).every((button) => button.type === 'button')).toBe(true);
    expect(Array.from(buttons).every((button) => button.className.includes('glow-focus'))).toBe(true);
    expect(Array.from(buttons).every((button) => button.className.includes('motion-reduce:transition-none'))).toBe(
      true,
    );
    const customButton = container.querySelector<HTMLButtonElement>('[data-testid="assistant-task-custom"]')!;
    act(() => customButton.click());
    expect(onCustomTask).toHaveBeenCalledOnce();
    unmount();
  });

  it('does not put invented metrics, income, online status, or absolute privacy claims in workbench copy', () => {
    const forbidden =
      /\d+(?:\.\d+)?\s*(?:万|k|m|\+)?\s*(?:(?:人|用户|users?|people)\s*)?(?:在线|online)|(?:评分|评级|rating)\s*[:：]?\s*\d(?:\.\d+)?|\d(?:\.\d+)?\s*(?:分|星|stars?)\s*(?:好评)?|(?:月入|年入|income|revenue)\s*(?:(?:￥|¥|\$)?\s*\d+|过万|上万|百万)|(?:收入|income|revenue)(?:提升|增长|增加|growth|increase)\s*\d+|(?:数据|文件|内容|data|files?|content)(?:绝不|不会|不|never|will not|won't)(?:上传|离开本地|出本地|upload|leave (?:your )?(?:device|computer))|(?:完全|百分之百|100%|completely|fully)\s*(?:离线|本地|私密|安全|offline|local|private|secure)|(?:隐私|privacy)(?:绝对|完全|百分之百|100%|guaranteed|absolute)保障?/iu;
    const definitions = [
      'main',
      'partner-w-content',
      'partner-w-video',
      'partner-w-office',
      'partner-w-ecommerce',
      'partner-w-research',
      'partner-w-family',
    ].map((id) => resolveAssistantWorkspace(id)!);
    const sharedKeys = [
      'recentTasks',
      'materialHint',
      'output',
      'customTask',
      'draftConflictTitle',
      'draftConflictDescription',
      'appendDraft',
      'replaceDraft',
    ];

    for (const locale of ['zh', 'en']) {
      const t = i18n.getFixedT(locale);
      for (const key of sharedKeys) expect(t(`taskWorkbench.${key}`), `${locale}: ${key}`).not.toMatch(forbidden);
      for (const definition of definitions) {
        for (const preset of definition.starters) {
          for (const key of [preset.materialHintKey, preset.outputKey]) {
            expect(t(key), `${locale}: ${key}`).not.toMatch(forbidden);
          }
        }
      }
    }
  });
});
