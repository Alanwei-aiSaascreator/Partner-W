// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 会话内的**运行行**（`TurnActivityRow`）。
 *
 * 用户（老板）要求："对话模型回复期间可视化交互体验不好，照抄主流智能体" ——
 * 主流的做法是把活动指示放在**回复位**。本行就是那一格：
 * 等待期可见（跳动条 + 正在干什么 + 已等待），没有活动时不渲染。
 *
 * 数据源与输入框上方的 ComposerActivity **共用** `useTurnActivity`（唯一出口），
 * 这里验证的就是这个共用面在会话内的表现。
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && 'what' in opts
        ? `${key}(${String(opts.what)})`
        : opts && 'count' in opts
          ? `${key}(${opts.count})`
          : opts && 'attempt' in opts
            ? `${key}(${opts.attempt}/${opts.maxAttempts})`
            : key,
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SK = 'agent:main:clawwork:dev:task:t1';
const T0 = Date.parse('2026-09-18T10:00:00.000Z');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

/** 挂起提问（`ask_user`）的播种形状：只带 id 与**属于哪个会话**（本组用例的变量）。 */
type QuestionSeed = { id: string; sessionKey: string };

/**
 * 一条**最小合法**的挂起提问负载 —— 走真实 `useQuestionStore.addQuestion`，
 * 不手塞 state：`sessionKey` 是经 `parseQuestionRequest` 落地的（hook 正是按它过滤），
 * 手塞就绕过了"这条键真的到得了 store"这一段。
 */
function questionPayload(seed: QuestionSeed): Record<string, unknown> {
  return {
    id: seed.id,
    questions: [
      {
        questionId: 'doc_type',
        header: '文档类型',
        question: '你需要什么类型的文档？',
        options: [{ label: '教案（教学设计）' }, { label: '学生练习 / 作业纸' }],
        isOther: true,
      },
    ],
    sessionKey: seed.sessionKey,
    createdAtMs: T0,
    expiresAtMs: T0 + 900_000,
    status: 'pending',
  };
}

async function setup(storeState: {
  processing?: boolean;
  startedAgoMs?: number;
  progressText?: string | null;
  toolCalls?: { id: string; name: string; status: string; title?: string; startedAt: string }[];
  /** 挂起的结构化提问（先种再渲染）。 */
  pendingQuestions?: QuestionSeed[];
}): Promise<void> {
  const { useMessageStore } = await import('../src/renderer/stores/messageStore');
  const { useQuestionStore } = await import('../src/renderer/stores/questionStore');
  const { default: TurnActivityRow } = await import('../src/renderer/components/TurnActivityRow');

  vi.useFakeTimers();
  vi.setSystemTime(T0);

  // ⚠️ 必须**无条件**重置再种：提问 store 与下面各键同理（浅合并/跨用例残留会把
  //    "另一个会话的提问"带进下一个用例 —— 而本组用例的变量恰恰就是"属于谁"）。
  useQuestionStore.getState().clear();
  for (const seed of storeState.pendingQuestions ?? []) {
    useQuestionStore.getState().addQuestion('gw-1', questionPayload(seed));
  }

  useMessageStore.setState({
    processingBySession: storeState.processing === false ? new Set() : new Set([SK]),
    turnStartedAtBySession: storeState.processing === false ? {} : { [SK]: T0 - (storeState.startedAgoMs ?? 0) },
    runPhaseBySession: { [SK]: null },
    runRetryBySession: {},
    // ⚠️ 必须**无条件**设：`setState` 是浅合并，漏设的键会留上一个用例的值
    progressTextBySession: { [SK]: storeState.progressText ?? null },
    compactingBySession: {},
    activeTurnBySession: storeState.toolCalls
      ? ({ [SK]: { toolCalls: storeState.toolCalls } } as never)
      : ({} as never),
  });

  await act(async () => {
    root.render((<TurnActivityRow sessionKey={SK} />) as ReactElement);
  });
}

/**
 * 主行文案（`data-testid="turn-activity-row-headline"` 的文本）。
 *
 * ⚠️ 2026-10-08：**有意**从"取行内第一个 span"改成按 testid 取值 —— 行里现在有三种东西
 *    （图标 / 主行 / 计时），等待态的图标从跳动条换成了静态时钟，按位置取会取到别的元素，
 *    断言就变成"测的是哪个 span 全看运气"。testid 是组件对测试的显式契约，不随视觉改动漂。
 */
function headlineText(): string {
  const headline = container.querySelector('[data-testid="turn-activity-row-headline"]');
  expect(headline).toBeTruthy();
  return headline!.textContent ?? '';
}

/** 行根节点（`data-status` 与图标/跳动条的宿主）。 */
function rowEl(): Element {
  const row = container.querySelector('[data-testid="turn-activity-row"]');
  expect(row).toBeTruthy();
  return row!;
}

/** 主行 span 有没有挂扫光（`text-shimmer` = "正在动"的统一视觉）。 */
function headlineShimmers(): boolean {
  return container.querySelector('[data-testid="turn-activity-row-headline"]')!.classList.contains('text-shimmer');
}

describe('TurnActivityRow（会话内运行行）', () => {
  it('没有活动轮次 → 整行不渲染', async () => {
    await setup({ processing: false });
    expect(container.querySelector('[data-testid="turn-activity-row"]')).toBeNull();
  });

  it('等待期（什么都没到）→ 显示泛化"处理中"主行与已等待时长', async () => {
    const { formatElapsed } = await import('../src/renderer/lib/waiting-copy');
    await setup({ startedAgoMs: 65_000 });
    expect(headlineText()).toBe('chatInput.waiting.working');
    const elapsed = container.querySelector('[data-testid="turn-activity-row-elapsed"]');
    expect(elapsed?.textContent).toBe(formatElapsed(65_000));
  });

  it('有正在跑的工具 → 主行说得出工具名（比泛化文案有用）', async () => {
    await setup({
      startedAgoMs: 1_000,
      toolCalls: [
        {
          id: 'c1',
          name: 'exec',
          status: 'running',
          title: '正在执行 deck-layout',
          startedAt: new Date(T0).toISOString(),
        },
      ],
    });
    expect(headlineText()).toBe('chatInput.waiting.runningTool(正在执行 deck-layout)');
  });

  it('模型自述进度可见（正文不流式时的唯一"在动"信号）', async () => {
    await setup({ startedAgoMs: 2_000, progressText: '正在整理第 3 页' });
    expect(headlineText()).toBe('chatInput.waiting.modelProgress(正在整理第 3 页)');
  });
});

/**
 * ⭐「等人」的第二种：结构化提问（`ask_user`）—— Codex 审核 P1-3。
 *
 * 等待用户有两类：**等批准**（工具调用停在 `awaitingApproval`）与**等回答**
 * （`questionStore.pendingQuestions`）。两类都是"不是我们在动，是在等你"——
 * 界面必须**停下来**（跳动条/扫光都是"在动"的语言，此处用它就是撒谎），
 * 图标换成静态时钟，文案说得出在等谁。
 *
 * ⚠️ 第二类必须**按会话键过滤**：同任务其他会话（performer）、其他任务的提问
 *    不得冻结**本**会话那一格。
 */
describe('⭐ 等人在回答（ask_user）：本行静止，说得清在等谁的什么', () => {
  it('本会话挂着提问 ⇒ awaiting-answer + 静态 Clock：跳动条与扫光都停下', async () => {
    await setup({ startedAgoMs: 8_000, pendingQuestions: [{ id: 'ask_1', sessionKey: SK }] });

    const row = rowEl();
    expect(row.getAttribute('data-status')).toBe('awaiting-answer');
    expect(headlineText()).toBe('chatInput.waiting.awaitingAnswer');
    expect(row.querySelector('svg.lucide-clock'), '等待期图标必须是静态时钟').not.toBeNull();
    expect(row.querySelector('[style*="bar-bounce"]'), '等人时还在跳 = 在说"我们正在动"').toBeNull();
    expect(headlineShimmers(), '等人时扫光同样是在说"正在动"').toBe(false);
  });

  it('等人批准 ⇒ awaiting-approval，与"等回答"同一套静止视觉', async () => {
    await setup({
      startedAgoMs: 8_000,
      toolCalls: [
        {
          id: 'c1',
          name: 'exec',
          status: 'awaitingApproval',
          title: 'rm -rf /tmp/x',
          startedAt: new Date(T0).toISOString(),
        },
      ],
    });

    const row = rowEl();
    expect(row.getAttribute('data-status')).toBe('awaiting-approval');
    expect(headlineText()).toBe('chatInput.waiting.awaitingApproval(rm -rf x)');
    expect(row.querySelector('svg.lucide-clock')).not.toBeNull();
    expect(row.querySelector('[style*="bar-bounce"]')).toBeNull();
    expect(headlineShimmers()).toBe(false);
  });

  it('⚠️ 提问属于**同任务另一个会话** ⇒ 本会话照旧（别拿别人的问题冻住这一格）', async () => {
    await setup({ startedAgoMs: 8_000, pendingQuestions: [{ id: 'ask_2', sessionKey: `${SK}:performer:1` }] });

    const row = rowEl();
    expect(row.getAttribute('data-status')).toBe('running');
    expect(headlineText()).toBe('chatInput.waiting.working');
    expect(row.querySelector('svg.lucide-clock')).toBeNull();
  });

  it('⚠️ 提问属于**另一个任务** ⇒ 本会话照旧', async () => {
    await setup({
      startedAgoMs: 8_000,
      pendingQuestions: [{ id: 'ask_3', sessionKey: 'agent:main:clawwork:dev:task:t9' }],
    });

    expect(rowEl().getAttribute('data-status')).toBe('running');
    expect(headlineText()).toBe('chatInput.waiting.working');
  });

  it('对照组：正在跑工具 ⇒ 跳动条 + 扫光都在（静止视觉只属于"等人"）', async () => {
    await setup({
      startedAgoMs: 3_000,
      toolCalls: [
        {
          id: 'c1',
          name: 'exec',
          status: 'running',
          title: '正在执行 deck-layout',
          startedAt: new Date(T0).toISOString(),
        },
      ],
    });

    const row = rowEl();
    expect(row.getAttribute('data-status')).toBe('running');
    expect(row.querySelector('[style*="bar-bounce"]')).not.toBeNull();
    expect(headlineShimmers(), '跑了才允许扫光').toBe(true);
  });
});
