// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { OnboardingProfile } from '../src/renderer/lib/user-onboarding';
import {
  parseGoalAnalysis,
  saveGoalAnalysis,
  type GoalAnalysisStorage,
} from '../src/renderer/features/goal-routing/goal-analysis';
import {
  useGoalAnalysisWithSession,
  type GoalAnalysisSession,
} from '../src/renderer/features/goal-routing/useGoalAnalysis';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function memoryStorage(): GoalAnalysisStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

function profile(userId: string, customGoal = '每周生成三个短视频脚本'): OnboardingProfile {
  return {
    version: 1,
    userId,
    nickname: '',
    useCases: ['content'],
    customGoal,
    completedAt: '2026-09-15T00:00:00.000Z',
  };
}

function mountHarness() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  return {
    container,
    render: (props: {
      profile: OnboardingProfile;
      enabled: boolean;
      session: GoalAnalysisSession;
      storage: GoalAnalysisStorage;
    }) => {
      function Harness() {
        const analysis = useGoalAnalysisWithSession(
          {
            profile: props.profile,
            enabled: props.enabled,
            gatewayId: 'gw-1',
            agentId: 'main',
            modelIds: ['deepseek-v4-flash'],
            storage: props.storage,
          },
          { ...props.session },
        );
        return <div data-status={analysis.status}>{analysis.result?.summary}</div>;
      }
      act(() => root.render(<Harness />));
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('useGoalAnalysis', () => {
  it('waits for entitlement and conversation readiness before starting', async () => {
    const start = vi.fn(async () => ({ ok: true }));
    const session: GoalAnalysisSession = {
      status: 'idle',
      messages: [],
      error: null,
      start,
      end: vi.fn(async () => undefined),
    };
    const storage = memoryStorage();
    const harness = mountHarness();

    harness.render({ profile: profile('gate-user'), enabled: false, session, storage });
    expect(start).not.toHaveBeenCalled();

    harness.render({ profile: profile('gate-user'), enabled: true, session, storage });
    await act(async () => undefined);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayId: 'gw-1', agentId: 'main', purpose: 'goal-analysis' }),
    );

    harness.unmount();
  });

  it('does not start for an empty goal or an already persisted result', async () => {
    const start = vi.fn(async () => ({ ok: true }));
    const session: GoalAnalysisSession = {
      status: 'idle',
      messages: [],
      error: null,
      start,
      end: vi.fn(async () => undefined),
    };
    const storage = memoryStorage();
    const storedProfile = profile('stored-user');
    const result = parseGoalAnalysis(
      '```goal-analysis\n{"kind":"preset","assistantId":"partner-w-content","summary":"短视频内容","reason":"需要选题和脚本","model":"deepseek-v4-flash","starters":["整理素材","生成选题","写脚本"]}\n```',
    );
    saveGoalAnalysis(storedProfile, result!, storage);
    const harness = mountHarness();

    harness.render({ profile: profile('empty-user', '   '), enabled: true, session, storage });
    harness.render({ profile: storedProfile, enabled: true, session, storage });
    await act(async () => undefined);

    expect(start).not.toHaveBeenCalled();
    expect(harness.container.querySelector('[data-status]')?.getAttribute('data-status')).toBe('ready');
    harness.unmount();
  });

  it('does not restart analysis after a successful result triggers a rerender', async () => {
    const start = vi.fn(async () => ({ ok: true }));
    const end = vi.fn(async () => undefined);
    const storage = memoryStorage();
    const currentProfile = profile('completion-user');
    const harness = mountHarness();

    harness.render({
      profile: currentProfile,
      enabled: true,
      storage,
      session: { status: 'idle', messages: [], error: null, start, end },
    });
    await act(async () => undefined);

    harness.render({
      profile: currentProfile,
      enabled: true,
      storage,
      session: {
        status: 'active',
        error: null,
        start,
        end,
        messages: [
          {
            role: 'assistant',
            timestamp: '2026-09-15T00:00:01.000Z',
            content:
              '```goal-analysis\n{"kind":"preset","assistantId":"partner-w-content","summary":"短视频内容","reason":"需要选题和脚本","model":"deepseek-v4-flash","starters":["整理素材","生成选题","写脚本"]}\n```',
          },
        ],
      },
    });
    await act(async () => undefined);

    expect(harness.container.querySelector('[data-status]')?.getAttribute('data-status')).toBe('ready');
    expect(start).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    harness.unmount();
  });
});
