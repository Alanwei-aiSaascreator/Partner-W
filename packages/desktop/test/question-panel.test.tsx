// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@clawwork/shared';
import zh from '../src/renderer/i18n/locales/zh.json';

/** 用**真实中文文案**渲染：这样「漏选提示是中文」才是被验证过的，而不是被 mock 掉的。 */
function translate(key: string, values?: Record<string, unknown>): string {
  const path = key.split('.');
  let node: unknown = zh;
  for (const part of path) {
    if (typeof node !== 'object' || node === null) return key;
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== 'string') return key;
  if (!values) return node;
  return node.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(values[name] ?? ''));
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const QUESTION_ID = 'ask_b331b9ae631f740e1cecf8b24115aaf8';
const SESSION_KEY = 'agent:partner-w-content:clawwork:abc:task:task-1';

function questionPayload(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: QUESTION_ID,
    questions: [
      {
        questionId: 'subject',
        header: '科目',
        question: '人教版一年级第一节课，你是指哪个科目？',
        options: [{ label: '语文 —— 第一课《天地人》（识字）' }, { label: '数学 —— 第一课《数一数》（准备课）' }],
        isOther: true,
      },
      {
        questionId: 'doc_type',
        header: '文档类型',
        question: '你需要什么类型的文档？',
        options: [{ label: '教案（教学设计）' }, { label: '学生练习 / 作业纸' }],
        isOther: true,
      },
    ],
    sessionKey: SESSION_KEY,
    createdAtMs: now,
    expiresAtMs: now + 900_000,
    status: 'pending',
    ...overrides,
  };
}

function task(): Task {
  return {
    id: 'task-1',
    sessionKey: SESSION_KEY,
    sessionId: '',
    title: 'Task 1',
    status: 'active',
    createdAt: '2026-03-23T00:00:00.000Z',
    updatedAt: '2026-03-23T00:00:00.000Z',
    tags: [],
    artifactDir: '',
    gatewayId: 'gw-1',
    agentId: 'partner-w-content',
  };
}

async function setup(payload: unknown = questionPayload(), lastUserText = '') {
  vi.resetModules();
  const resolveQuestion = vi.fn().mockResolvedValue({ ok: true });
  const windowWithClawwork = (globalThis.window ??= {} as typeof globalThis.window) as unknown as Window & {
    clawwork: Record<string, unknown>;
  };
  windowWithClawwork.clawwork = { ...windowWithClawwork.clawwork, resolveQuestion };
  vi.stubGlobal('localStorage', {
    getItem: vi.fn().mockReturnValue(null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
  });

  const [questionStore, taskStore, messageStore, panelModule] = await Promise.all([
    import('../src/renderer/stores/questionStore'),
    import('../src/renderer/stores/taskStore'),
    import('../src/renderer/stores/messageStore'),
    import('../src/renderer/components/QuestionPanel'),
  ]);
  const QuestionPanel = panelModule.default;

  const activeTask = task();
  taskStore.useTaskStore.setState({
    tasks: [activeTask],
    activeTaskId: activeTask.id,
    hydrated: true,
    pendingNewTask: null,
  });
  if (lastUserText) {
    messageStore.useMessageStore.setState({
      messagesByTask: {
        [activeTask.id]: [
          {
            id: 'm1',
            taskId: activeTask.id,
            role: 'user',
            content: lastUserText,
            artifacts: [],
            toolCalls: [],
            timestamp: '2026-09-17T05:11:54.000Z',
          },
        ],
      },
    });
  }
  questionStore.useQuestionStore.getState().addQuestion('gw-1', payload);

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<QuestionPanel />);
  });
  return {
    container,
    resolveQuestion,
    questionStore: questionStore.useQuestionStore,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`button not found: ${text}`);
  return button as HTMLButtonElement;
}

function click(button: HTMLButtonElement): void {
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function optionButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label && candidate.hasAttribute('aria-pressed'),
  );
  if (!button) throw new Error(`option not found: ${label}`);
  return button as HTMLButtonElement;
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  act(() => {
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('QuestionPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('shows every question with its options so the user can answer them together', async () => {
    const { container, unmount } = await setup();
    cleanup = unmount;

    expect(container.textContent).toContain('科目');
    expect(container.textContent).toContain('文档类型');
    expect(container.textContent).toContain('语文 —— 第一课《天地人》（识字）');
    expect(container.textContent).toContain('教案（教学设计）');
    // 内部字段名绝不能出现在界面上
    expect(container.textContent).not.toContain('doc_type');
    expect(container.textContent).not.toContain('subject');
  });

  it('blocks the submit and names the unanswered question in Chinese', async () => {
    const { container, resolveQuestion, unmount } = await setup();
    cleanup = unmount;

    click(optionButton(container, '语文 —— 第一课《天地人》（识字）'));
    click(findButton(container, translate('question.submit')));

    expect(resolveQuestion).not.toHaveBeenCalled();
    expect(container.textContent).toContain('文档类型');
    expect(container.textContent).not.toContain('doc_type');
  });

  it('submits every answer in a single resolve call', async () => {
    const { container, resolveQuestion, unmount } = await setup();
    cleanup = unmount;

    click(optionButton(container, '语文 —— 第一课《天地人》（识字）'));
    click(optionButton(container, '教案（教学设计）'));
    await act(async () => {
      click(findButton(container, translate('question.submit')));
    });

    expect(resolveQuestion).toHaveBeenCalledWith('gw-1', {
      id: QUESTION_ID,
      answers: {
        answers: {
          subject: ['语文 —— 第一课《天地人》（识字）'],
          doc_type: ['教案（教学设计）'],
        },
      },
      resolvedBy: 'user',
    });
    expect(container.textContent).toBe('');
  });

  it('lets the user type their own answer instead of picking an option', async () => {
    const { container, resolveQuestion, unmount } = await setup();
    cleanup = unmount;

    click(optionButton(container, '数学 —— 第一课《数一数》（准备课）'));
    const custom = container.querySelectorAll('input[type="text"]')[1] as HTMLInputElement;
    typeInto(custom, '一年级道德与法治');
    await act(async () => {
      click(findButton(container, translate('question.submit')));
    });

    expect(resolveQuestion).toHaveBeenCalledWith(
      'gw-1',
      expect.objectContaining({
        answers: { answers: { subject: ['数学 —— 第一课《数一数》（准备课）'], doc_type: ['一年级道德与法治'] } },
      }),
    );
  });

  it('cancels the question when the user skips it', async () => {
    const { container, resolveQuestion, unmount } = await setup();
    cleanup = unmount;

    await act(async () => {
      click(findButton(container, translate('question.skip')));
    });

    expect(resolveQuestion).toHaveBeenCalledWith('gw-1', {
      id: QUESTION_ID,
      cancel: true,
      resolvedBy: 'user',
    });
    expect(container.textContent).toBe('');
  });

  it('preselects the option the user already named in their task', async () => {
    const { container, unmount } = await setup(
      questionPayload(),
      '帮我写一个小学一年级人教版语文《天地人》的完整教案 Word',
    );
    cleanup = unmount;

    expect(optionButton(container, '语文 —— 第一课《天地人》（识字）').getAttribute('aria-pressed')).toBe('true');
    expect(optionButton(container, '数学 —— 第一课《数一数》（准备课）').getAttribute('aria-pressed')).toBe('false');
  });

  it('renders nothing when the pending question belongs to another task', async () => {
    const { container, unmount } = await setup(
      questionPayload({ sessionKey: 'agent:partner-w-content:clawwork:abc:task:other-task' }),
    );
    cleanup = unmount;

    expect(container.textContent).toBe('');
  });
});
