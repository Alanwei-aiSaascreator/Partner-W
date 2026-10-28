// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import GoalRecommendationPanel from '../src/renderer/features/goal-routing/GoalRecommendationPanel';
import type { GoalAnalysisResult } from '../src/renderer/features/goal-routing/goal-analysis';

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

function button(container: HTMLElement, key: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(key));
  if (!match) throw new Error(`missing button: ${key}`);
  return match;
}

describe('GoalRecommendationPanel', () => {
  it('selects a preset assistant only after confirmation and fills starters without sending', () => {
    const result: GoalAnalysisResult = {
      kind: 'preset',
      assistantId: 'partner-w-content',
      summary: '短视频内容',
      reason: '需要选题和脚本',
      model: 'deepseek-v4-flash',
      starters: ['整理素材', '生成选题', '写脚本'],
    };
    const onSelectAssistant = vi.fn();
    const onSelectStarter = vi.fn();
    const { container, unmount } = render(
      <GoalRecommendationPanel
        status="ready"
        result={result}
        error={null}
        onRetry={vi.fn()}
        onSelectAssistant={onSelectAssistant}
        onSelectStarter={onSelectStarter}
        onCreateCustom={vi.fn()}
      />,
    );

    expect(onSelectAssistant).not.toHaveBeenCalled();
    act(() => button(container, 'goalRouting.useAssistant').click());
    expect(onSelectAssistant).toHaveBeenCalledWith('partner-w-content');

    act(() => button(container, '整理素材').click());
    expect(onSelectStarter).toHaveBeenCalledWith('整理素材');
    unmount();
  });

  it('shows a custom prompt preview and creates only after confirmation', async () => {
    const result: GoalAnalysisResult = {
      kind: 'custom',
      summary: '周更播客',
      reason: '现有助手不覆盖音频制作',
      model: 'deepseek-v4-flash',
      starters: ['确定主题', '整理提纲', '生成节目单'],
      draft: {
        name: 'Podcast Planner',
        description: '规划播客选题、提纲和节目流程',
        identity: '你是播客策划助手。',
        boundaries: '不声称已录音或发布节目。',
      },
    };
    const onCreateCustom = vi.fn(async () => undefined);
    const { container, unmount } = render(
      <GoalRecommendationPanel
        status="ready"
        result={result}
        error={null}
        onRetry={vi.fn()}
        onSelectAssistant={vi.fn()}
        onSelectStarter={vi.fn()}
        onCreateCustom={onCreateCustom}
      />,
    );

    expect(container.textContent).toContain('你是播客策划助手。');
    expect(onCreateCustom).not.toHaveBeenCalled();
    await act(async () => button(container, 'goalRouting.createAssistant').click());
    expect(onCreateCustom).toHaveBeenCalledWith(result);
    unmount();
  });
});
