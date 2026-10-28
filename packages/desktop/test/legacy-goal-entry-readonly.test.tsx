// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import type { OnboardingProfile } from '../src/renderer/lib/user-onboarding';
import { parseGoalAnalysis, saveGoalAnalysis } from '../src/renderer/features/goal-routing/goal-analysis';
import { useGoalAnalysisWithSession } from '../src/renderer/features/goal-routing/useGoalAnalysis';
import GoalRecommendationPanel from '../src/renderer/features/goal-routing/GoalRecommendationPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const source = readFileSync(resolve('src/renderer/layouts/MainArea/index.tsx'), 'utf8');
const start = source.indexOf('const goalAnalysis = useGoalAnalysis({');
const end = source.indexOf('});', start) + 3;
const panel = source.indexOf('<GoalRecommendationPanel');
const panelStart = source.lastIndexOf('          {', panel) + '          {'.length;
const panelEnd = source.indexOf('          )}', panel) + '          )'.length;
const optionsCode = ts.transpileModule(source.slice(start, end) + ';goalAnalysis;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const panelCode = ts.transpileModule('globalThis.element = (' + source.slice(panelStart, panelEnd) + ');', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;

it.each([false, true])('workbench entry does not charge automatically; stored advice=%s', async (stored) => {
  const profile: OnboardingProfile = {
    version: 1,
    userId: `legacy-entry-${stored}`,
    nickname: '',
    useCases: ['content'],
    customGoal: 'Prepare weekly content',
    completedAt: '2026-10-02T00:00:00.000Z',
  };
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  if (stored) {
    const fence = String.fromCharCode(96).repeat(3);
    const result = parseGoalAnalysis(
      fence +
        'goal-analysis\n' +
        JSON.stringify({
          kind: 'preset',
          assistantId: 'partner-w-content',
          summary: 'Content',
          reason: 'Writing',
          model: 'deepseek-v4-flash',
          starters: ['Collect', 'Outline', 'Write'],
        }) +
        '\n' +
        fence,
    );
    expect(result).not.toBeNull();
    saveGoalAnalysis(profile, result!, storage);
  }
  const startSession = vi.fn(async () => ({ ok: true }));
  const session = {
    status: 'idle' as const,
    messages: [],
    error: null,
    start: startSession,
    end: vi.fn(async () => undefined),
  };
  function Harness() {
    const options: Parameters<typeof useGoalAnalysisWithSession>[0] = runInNewContext(optionsCode, {
      onboardingProfile: profile,
      startupReadiness: { conversationReady: true },
      license: { activated: true, tokenQuotaMicros: 100, tokenUsedMicros: 0 },
      defaultGatewayId: 'ready-gateway',
      goalAgentCatalog: { defaultId: 'main' },
      goalModelIds: ['deepseek-v4-flash'],
      useGoalAnalysis: (value: unknown) => value,
    });
    const goalAnalysis = useGoalAnalysisWithSession({ ...options, storage }, session);
    const context = {
      React,
      GoalRecommendationPanel,
      onboardingProfile: profile,
      goalAnalysis,
      handleSelectRecommendedAssistant: vi.fn(),
      requestDraft: vi.fn(),
      handleCreateCustomAssistant: vi.fn(async () => undefined),
      element: null,
    };
    runInNewContext(panelCode, context);
    return context.element;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => root.render(<Harness />));
    expect(startSession).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('goalRouting.waiting');
    expect(container.textContent).not.toContain('goalRouting.analyzing');
    if (stored) expect(container.textContent).toContain('goalRouting.recommendationReady');
    else expect(container.textContent).toBe('');
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
