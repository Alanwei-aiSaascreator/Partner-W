// @vitest-environment jsdom
/**
 * G4 回归（2026-10-08 集中终审 · P2 必修）：**"等人"必须贯穿整个活动块**。
 *
 * 既有思考/正文/运行工具存在时，再挂本 session 的**提问**或**待批准**：
 * 活动条（`TurnActivityRow`）此前只在"什么都没到"的分支里 —— 已有内容就整条不出现，
 * 其他子树（思考扫光 / 工具行扫光 / 运行图标 / 流式光标）也照旧无限动画。
 * "视觉静止 = 语义静止"的判据必须按**本 session 的等待事实**传到全部展示子树；
 * 且 **`processing=false`（首正文 delta 后就是 false）不代表本轮结束** —— 等待仍须成立。
 *
 * ⚠️ 用**真实主线组件**（AssistantBlock 真身 + 真 store + 真工具行/思考折叠/正文），
 *    只把 framer-motion 换成"原样渲染"。不能用 Markdown 替身证明光标行为。
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '@clawwork/shared';
import '../src/renderer/i18n';

vi.mock('framer-motion', async () => {
  const React = await import('react');
  const MOTION_ONLY = new Set([
    'initial',
    'animate',
    'exit',
    'transition',
    'variants',
    'whileHover',
    'whileTap',
    'whileInView',
    'layout',
    'layoutId',
  ]);
  const cache = new Map<string, unknown>();
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        const cached = cache.get(tag);
        if (cached) return cached;
        const component = React.forwardRef<HTMLElement, Record<string, unknown>>((props, ref) => {
          const { children, ...rest } = props;
          const clean = Object.fromEntries(Object.entries(rest).filter(([key]) => !MOTION_ONLY.has(key)));
          return React.createElement(tag, { ...clean, ref }, children as React.ReactNode);
        });
        cache.set(tag, component);
        return component;
      },
    },
  );
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion,
    useReducedMotion: () => false,
  };
});

import AssistantBlock from '../src/renderer/components/AssistantBlock';
import { useMessageStore } from '../src/renderer/stores/messageStore';
import { useQuestionStore } from '../src/renderer/stores/questionStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SK = 'agent:main:clawwork:task:task-1';
const OTHER_SK = 'agent:main:clawwork:task:task-other';

const identity = { agentName: '内容助手', agentRoleLabel: '内容', localAvatarUrl: 'file:///avatar.png' };

const cleanups: Array<() => void> = [];

function render(ui: ReactElement): {
  container: HTMLDivElement;
  rerender: (next: ReactElement) => void;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  const unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  cleanups.push(unmount);
  return { container, rerender: (next) => act(() => root.render(next)), unmount };
}

function makeCall(partial: Partial<ToolCall> & Pick<ToolCall, 'id' | 'name' | 'status'>): ToolCall {
  return { startedAt: '2026-10-08T00:00:00.000Z', ...partial };
}

/** 种子：本 session 的活动回合（工具/相位来源）+ processing 开关（首正文 delta 后就是 false）。 */
function seedTurn(toolCalls: ToolCall[], processing: boolean): void {
  useMessageStore.setState({
    activeTurnBySession: {
      [SK]: {
        id: 'turn-1',
        streamingText: '',
        streamingThinking: '',
        toolCalls,
        finalized: false,
        content: '',
        timestamp: '2026-10-08T00:00:00.000Z',
      },
    },
    processingBySession: processing ? new Set([SK]) : new Set<string>(),
    turnStartedAtBySession: processing ? { [SK]: Date.now() - 4200 } : {},
  });
}

function seedQuestion(sessionKey: string): void {
  useQuestionStore.setState({
    pendingQuestions: [
      {
        id: `q-${sessionKey}`,
        sessionKey,
        gatewayId: 'gw-1',
        taskId: null,
        questions: [],
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 15 * 60_000,
      },
    ],
  });
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  document.body.innerHTML = '';
  useMessageStore.setState({
    activeTurnBySession: {},
    processingBySession: new Set<string>(),
    turnStartedAtBySession: {},
  });
  useQuestionStore.setState({ pendingQuestions: [] });
});

const shimmer = (container: HTMLElement) => container.querySelectorAll('.text-shimmer');
const loadingIcons = (container: HTMLElement) => container.querySelectorAll('.tool-icon-loading');

describe('G4：等待贯穿整个活动块（真实组件 + 真实 store）', () => {
  it('⭐ 已有正文 + 本 session 提问挂起（processing=false）⇒ 等待行出现、思考/光标/工具行全静态；解除后恢复', () => {
    seedTurn([makeCall({ id: 'r1', name: 'read', status: 'running' })], false);
    seedQuestion(SK);
    const view = render(
      <AssistantBlock
        state="streaming"
        content="已经写了一半的正文"
        thinkingContent="还在继续推理"
        toolCalls={[makeCall({ id: 'r1', name: 'read', status: 'running' })]}
        identity={identity}
        activity={{ kind: 'thinking', revision: 2, thinkingSegment: 1 }}
        activitySessionKey={SK}
      />,
    );

    expect(
      view.container.querySelector('[data-testid="turn-activity-row"]'),
      '等待行必须贯穿已有内容出现（不是只在"什么都没到"时才有）',
    ).not.toBeNull();
    expect(view.container.querySelector('[data-testid="turn-activity-row"]')!.getAttribute('data-status')).toBe(
      'awaiting-answer',
    );
    const title = view.container.querySelector('.thinking-collapse__title');
    expect(title!.className, '等待期间思考标题不得扫光').not.toContain('text-shimmer');
    expect(view.container.querySelector('.stream-cursor'), '等待期间流式光标必须收起').toBeNull();
    expect(view.container.querySelector('.tool-row__status.text-shimmer'), '等待期间工具行不得扫光').toBeNull();
    expect(loadingIcons(view.container).length, '等待期间运行图标必须停（换静态 Clock）').toBe(0);

    // —— 解除等待：全部恢复（光标/扫光回来，等待行收起）——
    act(() => {
      useQuestionStore.setState({ pendingQuestions: [] });
    });
    expect(view.container.querySelector('[data-testid="turn-activity-row"]'), '解除后等待行收起').toBeNull();
    expect(view.container.querySelector('.stream-cursor'), '解除后光标恢复').not.toBeNull();
    expect(view.container.querySelector('.thinking-collapse__title')!.className).toContain('text-shimmer');
  });

  it('⭐ 仅思考 + 提问挂起 ⇒ 等待行同样出现（思考折叠不再挡住它）', () => {
    seedTurn([], false);
    seedQuestion(SK);
    const view = render(
      <AssistantBlock
        state="streaming"
        content=""
        thinkingContent="先想想"
        toolCalls={[]}
        identity={identity}
        activity={{ kind: 'thinking', revision: 1, thinkingSegment: 1 }}
        activitySessionKey={SK}
      />,
    );

    expect(
      view.container.querySelector('[data-testid="turn-activity-row"]'),
      '有推理文本时等待行也必须出现（它正是"在等你"的那一格）',
    ).not.toBeNull();
    expect(view.container.querySelector('.thinking-collapse__title')!.className).not.toContain('text-shimmer');
  });

  it('⭐ 工具停在等人批准 + 已有正文 ⇒ 等待行出现且为 awaiting-approval；工具行不扫光', () => {
    const awaiting = makeCall({ id: 'a1', name: 'write', status: 'awaitingApproval' });
    seedTurn([awaiting], true);
    const view = render(
      <AssistantBlock
        state="streaming"
        content="正文先到了"
        toolCalls={[awaiting]}
        identity={identity}
        activity={{ kind: 'output', revision: 3, thinkingSegment: 1 }}
        activitySessionKey={SK}
      />,
    );

    const row = view.container.querySelector('[data-testid="turn-activity-row"]');
    expect(row, '待批准时等待行必须出现（已有正文也不例外）').not.toBeNull();
    expect(row!.getAttribute('data-status')).toBe('awaiting-approval');
    expect(view.container.querySelector('.tool-row__status.text-shimmer'), '待批准 ≠ 在跑：不得扫光').toBeNull();
  });

  it('⭐ 其他 session 的提问不得冻结本会话（无等待行、扫光/光标照常）', () => {
    seedTurn([makeCall({ id: 'r1', name: 'read', status: 'running' })], true);
    seedQuestion(OTHER_SK);
    const view = render(
      <AssistantBlock
        state="streaming"
        content="继续写正文"
        thinkingContent="继续推理"
        toolCalls={[makeCall({ id: 'r1', name: 'read', status: 'running' })]}
        identity={identity}
        activity={{ kind: 'thinking', revision: 2, thinkingSegment: 1 }}
        activitySessionKey={SK}
      />,
    );

    expect(view.container.querySelector('[data-testid="turn-activity-row"]'), '别的会话提问与本会话无关').toBeNull();
    expect(view.container.querySelector('.thinking-collapse__title')!.className, '本会话照常 live').toContain(
      'text-shimmer',
    );
    expect(view.container.querySelector('.stream-cursor'), '本会话光标照常').not.toBeNull();
    expect(view.container.querySelector('.tool-row__status.text-shimmer'), '本会话工具行照常').not.toBeNull();
  });

  it('⭐ 等待期间手动收起照常生效；解除后同段保持收起；新段复位展开', () => {
    seedTurn([], false);
    seedQuestion(SK);
    const view = render(
      <AssistantBlock
        state="streaming"
        content=""
        thinkingContent="第一段推理"
        toolCalls={[]}
        identity={identity}
        activity={{ kind: 'thinking', revision: 1, thinkingSegment: 1 }}
        activitySessionKey={SK}
      />,
    );
    const header = view.container.querySelector<HTMLButtonElement>('[data-testid="thinking-collapse-header"]');
    act(() => header?.click());
    expect(view.container.querySelector('[data-testid="thinking-collapse"]')!.className).toContain(
      'thinking-collapse--collapsed',
    );

    act(() => {
      useQuestionStore.setState({ pendingQuestions: [] });
    });
    expect(
      view.container.querySelector('[data-testid="thinking-collapse"]')!.className,
      '解除等待不得把用户的手动收起复位',
    ).toContain('thinking-collapse--collapsed');

    view.rerender(
      <AssistantBlock
        state="streaming"
        content=""
        thinkingContent={'第一段推理\n第二段换个思路'}
        toolCalls={[]}
        identity={identity}
        activity={{ kind: 'thinking', revision: 2, thinkingSegment: 2 }}
        activitySessionKey={SK}
      />,
    );
    expect(
      view.container.querySelector('[data-testid="thinking-collapse"]')!.className,
      '新段（段号变化）自动展开',
    ).toContain('thinking-collapse--expanded');
  });

  it('⭐ 多个工具（含重复失败详情）+ 提问 ⇒ 等待期间任何一行都不得扫光/转圈', () => {
    const running = makeCall({ id: 'r1', name: 'read', status: 'running', args: { path: 'a.md' } });
    const repeat = makeCall({ id: 'r2', name: 'read', status: 'running', args: { path: 'a.md' } });
    const failed = makeCall({
      id: 'r3',
      name: 'read',
      status: 'error',
      args: { path: 'a.md' },
      result: '这一步暂时无法完成',
    });
    seedTurn([running, repeat], false);
    seedQuestion(SK);
    const view = render(
      <AssistantBlock
        state="streaming"
        content="正文在"
        toolCalls={[running, repeat, failed]}
        identity={identity}
        activity={{ kind: 'output', revision: 4, thinkingSegment: 1 }}
        activitySessionKey={SK}
      />,
    );

    expect(view.container.querySelector('[data-testid="turn-activity-row"]'), '等待行必须在').not.toBeNull();
    expect(shimmer(view.container).length, '等待期间（含重复失败详情）不得有任何扫光').toBe(0);
    expect(loadingIcons(view.container).length, '等待期间不得有任何运行图标').toBe(0);
  });
});
