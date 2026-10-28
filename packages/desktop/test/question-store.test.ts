import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@clawwork/shared';

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

/** 与网关实测一致：15 分钟后过期（`timeoutMs` 默认 900_000）。 */
function questionPayload(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: 'ask_b331b9ae631f740e1cecf8b24115aaf8',
    questions: [
      {
        questionId: 'subject',
        header: '科目',
        question: '人教版一年级第一节课，你是指哪个科目？',
        options: [{ label: '语文 —— 第一课《天地人》（识字）' }, { label: '数学' }],
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
    sessionKey: 'agent:partner-w-content:clawwork:abc:task:task-1',
    createdAtMs: now,
    expiresAtMs: now + 900_000,
    status: 'pending',
    ...overrides,
  };
}

async function loadStores() {
  vi.resetModules();
  const [questionStore, taskStore, uiStore] = await Promise.all([
    import('../src/renderer/stores/questionStore'),
    import('../src/renderer/stores/taskStore'),
    import('../src/renderer/stores/uiStore'),
  ]);
  return { questionStore, taskStore, uiStore };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    sessionKey: 'agent:partner-w-content:clawwork:abc:task:task-1',
    sessionId: '',
    title: 'Task 1',
    status: 'active',
    createdAt: '2026-03-23T00:00:00.000Z',
    updatedAt: '2026-03-23T00:00:00.000Z',
    tags: [],
    artifactDir: '',
    gatewayId: 'gw-1',
    agentId: 'partner-w-content',
    ...overrides,
  };
}

describe('question store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    const windowWithClawwork = (globalThis.window ??= {} as typeof globalThis.window) as unknown as Window & {
      clawwork: { resolveQuestion: ReturnType<typeof vi.fn> };
    };
    windowWithClawwork.clawwork = {
      resolveQuestion: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as typeof windowWithClawwork.clawwork;
    vi.stubGlobal('localStorage', {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    });
  });

  it('stores the parsed request, attaches the task and flags inactive tasks unread', async () => {
    const { questionStore, taskStore, uiStore } = await loadStores();
    taskStore.useTaskStore.setState({
      tasks: [task()],
      activeTaskId: 'another-task',
      hydrated: true,
      pendingNewTask: null,
    });

    questionStore.useQuestionStore.getState().addQuestion('gw-1', questionPayload());

    const pending = questionStore.useQuestionStore.getState().pendingQuestions;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.taskId).toBe('task-1');
    expect(pending[0]?.questions).toHaveLength(2);
    expect(uiStore.useUiStore.getState().unreadTaskIds.has('task-1')).toBe(true);
  });

  it('ignores payloads it cannot parse and requests that already expired', async () => {
    const { questionStore, taskStore } = await loadStores();
    taskStore.useTaskStore.setState({ tasks: [task()], activeTaskId: 'task-1', hydrated: true, pendingNewTask: null });

    questionStore.useQuestionStore.getState().addQuestion('gw-1', { nonsense: true });
    questionStore.useQuestionStore.getState().addQuestion('gw-1', questionPayload({ expiresAtMs: Date.now() - 1 }));

    expect(questionStore.useQuestionStore.getState().pendingQuestions).toHaveLength(0);
  });

  it('sends the exact resolve payload and drops the question on success', async () => {
    const { questionStore, taskStore } = await loadStores();
    taskStore.useTaskStore.setState({ tasks: [task()], activeTaskId: 'task-1', hydrated: true, pendingNewTask: null });
    questionStore.useQuestionStore.getState().addQuestion('gw-1', questionPayload());

    const ok = await questionStore.useQuestionStore.getState().resolveQuestion('ask_b331b9ae631f740e1cecf8b24115aaf8', {
      subject: ['语文 —— 第一课《天地人》（识字）'],
      doc_type: ['教案（教学设计）'],
    });

    expect(ok).toBe(true);
    expect(window.clawwork.resolveQuestion).toHaveBeenCalledWith('gw-1', {
      id: 'ask_b331b9ae631f740e1cecf8b24115aaf8',
      answers: {
        answers: { subject: ['语文 —— 第一课《天地人》（识字）'], doc_type: ['教案（教学设计）'] },
      },
      resolvedBy: 'user',
    });
    expect(questionStore.useQuestionStore.getState().pendingQuestions).toHaveLength(0);
  });

  it('refuses to submit an incomplete selection without touching the gateway', async () => {
    const { questionStore, taskStore } = await loadStores();
    taskStore.useTaskStore.setState({ tasks: [task()], activeTaskId: 'task-1', hydrated: true, pendingNewTask: null });
    questionStore.useQuestionStore.getState().addQuestion('gw-1', questionPayload());

    const ok = await questionStore.useQuestionStore.getState().resolveQuestion('ask_b331b9ae631f740e1cecf8b24115aaf8', {
      subject: ['语文 —— 第一课《天地人》（识字）'],
    });

    expect(ok).toBe(false);
    expect(window.clawwork.resolveQuestion).not.toHaveBeenCalled();
    expect(questionStore.useQuestionStore.getState().pendingQuestions).toHaveLength(1);
  });

  it('keeps the card visible when the gateway rejects the resolve', async () => {
    const { questionStore, taskStore } = await loadStores();
    taskStore.useTaskStore.setState({ tasks: [task()], activeTaskId: 'task-1', hydrated: true, pendingNewTask: null });
    questionStore.useQuestionStore.getState().addQuestion('gw-1', questionPayload());
    vi.mocked(window.clawwork.resolveQuestion).mockResolvedValueOnce({
      ok: false,
      error: "question 'doc_type' requires an answer",
    });

    const ok = await questionStore.useQuestionStore.getState().resolveQuestion('ask_b331b9ae631f740e1cecf8b24115aaf8', {
      subject: ['语文 —— 第一课《天地人》（识字）'],
      doc_type: ['教案（教学设计）'],
    });
    await flushMicrotasks();

    expect(ok).toBe(false);
    expect(questionStore.useQuestionStore.getState().pendingQuestions).toHaveLength(1);
  });

  it('cancels through the same RPC with the cancel flag', async () => {
    const { questionStore, taskStore } = await loadStores();
    taskStore.useTaskStore.setState({ tasks: [task()], activeTaskId: 'task-1', hydrated: true, pendingNewTask: null });
    questionStore.useQuestionStore.getState().addQuestion('gw-1', questionPayload());

    questionStore.useQuestionStore.getState().cancelQuestion('ask_b331b9ae631f740e1cecf8b24115aaf8');
    await flushMicrotasks();

    expect(window.clawwork.resolveQuestion).toHaveBeenCalledWith('gw-1', {
      id: 'ask_b331b9ae631f740e1cecf8b24115aaf8',
      cancel: true,
      resolvedBy: 'user',
    });
    expect(questionStore.useQuestionStore.getState().pendingQuestions).toHaveLength(0);
  });

  it('removes the question when the gateway reports it resolved elsewhere', async () => {
    const { questionStore, taskStore } = await loadStores();
    taskStore.useTaskStore.setState({ tasks: [task()], activeTaskId: 'task-1', hydrated: true, pendingNewTask: null });
    questionStore.useQuestionStore.getState().addQuestion('gw-1', questionPayload());

    questionStore.useQuestionStore.getState().removeQuestion('ask_b331b9ae631f740e1cecf8b24115aaf8');

    expect(questionStore.useQuestionStore.getState().pendingQuestions).toHaveLength(0);
  });

  it('expires the card on its own when the gateway never answers', async () => {
    vi.useFakeTimers();
    const { questionStore, taskStore } = await loadStores();
    taskStore.useTaskStore.setState({ tasks: [task()], activeTaskId: 'task-1', hydrated: true, pendingNewTask: null });
    const now = Date.now();
    questionStore.useQuestionStore.getState().addQuestion('gw-1', questionPayload({ expiresAtMs: now + 5_000 }));

    expect(questionStore.useQuestionStore.getState().pendingQuestions).toHaveLength(1);
    vi.advanceTimersByTime(5_100);
    expect(questionStore.useQuestionStore.getState().pendingQuestions).toHaveLength(0);
    vi.useRealTimers();
  });

  it('reconciles with the gateway after a reconnect: adopts what is still pending, drops the rest', async () => {
    const { questionStore, taskStore } = await loadStores();
    taskStore.useTaskStore.setState({ tasks: [task()], activeTaskId: 'task-1', hydrated: true, pendingNewTask: null });
    questionStore.useQuestionStore.getState().addQuestion('gw-1', questionPayload());

    const survivor = questionPayload({ id: 'ask_still_pending', questions: questionPayload().questions });

    questionStore.useQuestionStore.getState().reconcileQuestions('gw-1', [survivor]);

    const pending = questionStore.useQuestionStore.getState().pendingQuestions;
    expect(pending.map((question) => question.id)).toEqual(['ask_still_pending']);
  });

  it('keeps questions from other gateways alone while reconciling', async () => {
    const { questionStore, taskStore } = await loadStores();
    taskStore.useTaskStore.setState({ tasks: [task()], activeTaskId: 'task-1', hydrated: true, pendingNewTask: null });
    questionStore.useQuestionStore.getState().addQuestion('gw-2', questionPayload());

    questionStore.useQuestionStore.getState().reconcileQuestions('gw-1', []);

    expect(questionStore.useQuestionStore.getState().pendingQuestions).toHaveLength(1);
  });

  it('ignores unusable entries in the gateway list', async () => {
    const { questionStore, taskStore } = await loadStores();
    taskStore.useTaskStore.setState({ tasks: [task()], activeTaskId: 'task-1', hydrated: true, pendingNewTask: null });

    questionStore.useQuestionStore
      .getState()
      .reconcileQuestions('gw-1', [
        { nonsense: true },
        questionPayload({ expiresAtMs: Date.now() - 1 }),
        questionPayload({ id: 'ask_live' }),
      ]);

    expect(questionStore.useQuestionStore.getState().pendingQuestions.map((q) => q.id)).toEqual(['ask_live']);
  });

  it('clears everything on logout / account switch', async () => {
    const { questionStore, taskStore, uiStore } = await loadStores();
    taskStore.useTaskStore.setState({
      tasks: [task()],
      activeTaskId: 'another-task',
      hydrated: true,
      pendingNewTask: null,
    });
    questionStore.useQuestionStore.getState().addQuestion('gw-1', questionPayload());
    expect(uiStore.useUiStore.getState().unreadTaskIds.has('task-1')).toBe(true);

    questionStore.useQuestionStore.getState().clear();

    expect(questionStore.useQuestionStore.getState().pendingQuestions).toHaveLength(0);
    // 未读标记也要一起收掉，否则登出后还留着一个点不开的红点
    expect(uiStore.useUiStore.getState().unreadTaskIds.has('task-1')).toBe(false);
  });
});
