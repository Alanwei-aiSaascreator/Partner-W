// @vitest-environment jsdom
//
// 并排面板 + 选择条的**界面接线**：一列挂掉只影响那一列、采纳/重试真的落到
// 编排与消息 store 上。
//
// 这里用的是**真**的 message store 与**真**的 compare store（只把网关调用换成假的），
// 所以「点采纳 → 时间线里多出一问一答」是端到端成立的，而不是「某个 mock 被调过」。
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelCatalogEntry } from '@clawwork/shared';
import zh from '../src/renderer/i18n/locales/zh.json';

/** 用**真实中文文案**渲染：这样"用户看到的是哪句话"是被验证过的，而不是被 mock 掉的。 */
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

vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() } }));

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children?: unknown }) => <>{children as never}</>,
  DropdownMenuTrigger: ({ children }: { children?: unknown }) => <>{children as never}</>,
  DropdownMenuContent: ({ children }: { children?: unknown }) => <div>{children as never}</div>,
  DropdownMenuItem: ({ children, ...props }: Record<string, unknown>) => (
    <button type="button" {...(props as Record<string, unknown>)}>
      {children as never}
    </button>
  ),
  DropdownMenuSub: ({ children }: { children?: unknown }) => <>{children as never}</>,
  DropdownMenuSubTrigger: ({ children }: { children?: unknown }) => <>{children as never}</>,
  DropdownMenuSubContent: ({ children }: { children?: unknown }) => <div>{children as never}</div>,
}));

const hoisted = vi.hoisted(() => ({
  message: null as unknown,
  tasks: [] as Array<Record<string, unknown>>,
  taskMeta: [] as Array<{ id: string; meta: Record<string, unknown> }>,
  gatewayCalls: [] as Array<{ method: string; args: unknown[] }>,
  /** 网关报的"实际生成这条回复的模型"：**故意不在**任何一列的配置里（见 chatHistory 的说明）。 */
  gatewayModel: 'kimi-k2-thinking',
}));

vi.mock('../src/renderer/platform', async () => {
  const { useStore } = await import('zustand');
  type Api = Parameters<typeof useStore>[0];
  const api = () => hoisted.message as unknown as Api;
  const taskState = {
    tasks: hoisted.tasks,
    updateTaskMetadata: (id: string, meta: Record<string, unknown>) => {
      hoisted.taskMeta.push({ id, meta });
    },
  };
  return {
    messageStore: { getState: () => (hoisted.message as { getState: () => unknown }).getState() },
    useMessageStore: (selector?: (s: unknown) => unknown) => useStore(api(), selector as never),
    taskStore: { getState: () => taskState },
    useTaskStore: (selector?: (s: unknown) => unknown) => selector?.(taskState),
    useUiStore: (selector?: (s: unknown) => unknown) => selector?.({}),
    composer: {},
    composerBridge: {},
    ports: {},
  };
});

vi.mock('@/features/compare/compare-store-instance', async () => {
  const { useStore } = await import('zustand');
  const { createCompareStore } = await import('@/features/compare/compare-store');
  const store = createCompareStore({
    createSession: async (gatewayId, params) => {
      hoisted.gatewayCalls.push({ method: 'createSession', args: [gatewayId, params] });
      return { ok: true };
    },
    patchSession: async (gatewayId, sessionKey, patch) => {
      hoisted.gatewayCalls.push({ method: 'patchSession', args: [gatewayId, sessionKey, patch] });
      return { ok: true };
    },
    sendMessage: async (gatewayId, sessionKey, content) => {
      hoisted.gatewayCalls.push({ method: 'sendMessage', args: [gatewayId, sessionKey, content] });
      return { ok: true };
    },
    abortChat: async () => ({ ok: true }),
    deleteSession: async () => ({ ok: true }),
    // ⚠️ 形状按**实测**的网关 `chat.history`：assistant 的 content 是块数组、
    //    timestamp 是 epoch 毫秒；返回的模型**故意不是**勾选的任何一列
    //（否则"徽章来自网关"这条断言用列的配置模型也能过 —— 等于没验）。
    chatHistory: async () => ({
      ok: true,
      result: {
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: '问题' }],
            timestamp: Date.parse('2026-09-18T09:00:00.000Z'),
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: '答案' }],
            model: hoisted.gatewayModel,
            timestamp: Date.parse('2026-09-18T09:00:05.000Z'),
          },
        ],
      },
    }),
    getMessageStore: () => (hoisted.message as { getState: () => never }).getState(),
    getTaskStore: () => ({
      tasks: hoisted.tasks as never,
      updateTaskMetadata: (id: string, meta: { sessionKey?: string }) => {
        hoisted.taskMeta.push({ id, meta });
      },
    }),
    translate,
    newId: () => 'run-1',
  });
  return {
    compareStore: () => store,
    useCompareStore: (selector?: (s: unknown) => unknown) => useStore(store, selector as never),
  };
});

import { createMessageStore } from '@clawwork/core';
import ComparePanel from '../src/renderer/features/compare/ComparePanel';
import CompareSetupBar from '../src/renderer/features/compare/CompareSetupBar';
import { compareStore } from '@/features/compare/compare-store-instance';

const TASK_ID = 'task-1';
const GATEWAY_ID = 'gw-1';
const PROMPT = '用一句话介绍你自己';

const CATALOG = [
  { id: 'qwen-plus', name: '通义千问 Plus' },
  { id: 'glm-4.7', name: '智谱 GLM-4.7' },
  { id: 'kimi-k2', name: 'Kimi K2' },
] as unknown as ModelCatalogEntry[];

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function render(node: ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(node));
}

function unmount() {
  if (root) act(() => root.unmount());
  container?.remove();
}

/** 真的 message store（每轮测试现造一个）。 */
function messageStore() {
  return hoisted.message as ReturnType<typeof createMessageStore>;
}

/** 起一轮三列对比（真 store，假网关）。 */
function startCompare(models = ['qwen-plus', 'glm-4.7', 'kimi-k2']) {
  // 线上进对比面板的前提就是**开着对比模式**（面板只在 mode 为真时才可能出现在这一屏）。
  // 不打开的话「采纳后退出对比模式」那条断言会因为"本来就是 false"而白过。
  compareStore().getState().setMode(true);
  compareStore().getState().setDraftModels(models);
  compareStore().getState().start({ taskId: TASK_ID, gatewayId: GATEWAY_ID, agentId: 'main', prompt: PROMPT });
  return compareStore()
    .getState()
    .active!.columns.map((c) => c.sessionKey);
}

function columns(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-testid="compare-column"]')];
}

function statusOf(index: number): string | null {
  return columns()[index]?.getAttribute('data-column-status') ?? null;
}

function buttonIn(index: number, testId: string): HTMLButtonElement | null {
  return columns()[index]?.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`) ?? null;
}

/** 这里没有 `@testing-library/jest-dom`，禁用状态只能读 DOM 属性本身。 */
function isDisabled(el: HTMLButtonElement | null): boolean {
  return el === null || el.disabled === true;
}

async function flush(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++)
    await act(async () => {
      await Promise.resolve();
    });
}

describe('多模型并排面板', () => {
  beforeEach(() => {
    hoisted.gatewayCalls = [];
    hoisted.taskMeta = [];
    hoisted.tasks = [
      {
        id: TASK_ID,
        sessionKey: 'agent:main:clawwork:dev-1:task:task-1',
        gatewayId: GATEWAY_ID,
        agentId: 'main',
        title: '测试任务',
      },
    ];
    hoisted.message = createMessageStore({ persistMessage: vi.fn(async () => ({ ok: true })) });
    // store 是模块级单例：不把**每个**字段都复位的话，上一个用例的残留会漏进下一个
    //（比如 `adoptingKey` 没清 ⇒ 下一个用例的采纳按钮全是禁用的）。
    compareStore().setState({
      active: null,
      mode: false,
      draftModels: [],
      draftSeeded: false,
      adoptingKey: null,
      ephemeralKeys: new Set<string>(),
      abortedKeys: new Set<string>(),
      error: null,
    });
  });

  afterEach(() => {
    unmount?.();
    document.body.innerHTML = '';
  });

  it('N 列并排、顺序 = 勾选顺序，模型显示目录里的名字', async () => {
    startCompare(['glm-4.7', 'qwen-plus']);
    render(<ComparePanel modelCatalog={CATALOG} taskId={TASK_ID} />);
    await flush();

    expect(columns()).toHaveLength(2);
    expect(columns().map((c) => c.getAttribute('data-column-model'))).toEqual(['glm-4.7', 'qwen-plus']);
    expect(columns()[0].textContent).toContain('智谱 GLM-4.7');
    expect(columns()[1].textContent).toContain('通义千问 Plus');
    // 用户问的什么一直看得见
    expect(container.textContent).toContain(PROMPT);
    // 还没回话：两列都是 pending
    expect(statusOf(0)).toBe('pending');
    expect(statusOf(1)).toBe('pending');
    expect(container.textContent).toContain('0/2 已完成');
  });

  it('谁先出字谁先显示，但列的位置不动；没跑完不给采纳', async () => {
    const [, keyB] = startCompare(['qwen-plus', 'glm-4.7']);
    render(<ComparePanel modelCatalog={CATALOG} taskId={TASK_ID} />);

    act(() => {
      messageStore().getState().appendStreamDelta(keyB, '第二列先说话');
    });
    await flush();

    expect(statusOf(0)).toBe('pending');
    expect(statusOf(1)).toBe('streaming');
    expect(columns()[1].textContent).toContain('第二列先说话');
    // 位置没动：第 2 列还是 glm
    expect(columns()[1].getAttribute('data-column-model')).toBe('glm-4.7');
    expect(isDisabled(buttonIn(1, 'compare-adopt'))).toBe(true);
    expect(container.textContent).toContain('0/2 已完成');

    // 跑完 → 可采纳
    act(() => {
      messageStore().getState().finalizeStream(keyB);
    });
    await flush();
    expect(statusOf(1)).toBe('done');
    expect(isDisabled(buttonIn(1, 'compare-adopt'))).toBe(false);
  });

  it('一列失败：那一列只有可读错误 + 重试，其余列继续出字', async () => {
    const [keyA, keyB] = startCompare();
    render(<ComparePanel modelCatalog={CATALOG} taskId={TASK_ID} />);

    act(() => {
      const store = messageStore().getState();
      store.appendStreamDelta(keyA, '第一列在正常写');
      store.setSessionError(keyB, '余额不足，请充值后再试');
    });
    await flush();

    expect(statusOf(0)).toBe('streaming');
    expect(statusOf(1)).toBe('error');
    expect(statusOf(2)).toBe('pending');

    // 失败列：看得懂的原因 + 重试；没有采纳按钮（没答案可采纳）
    expect(columns()[1].textContent).toContain('余额不足，请充值后再试');
    expect(buttonIn(1, 'compare-retry')).not.toBeNull();
    expect(buttonIn(1, 'compare-adopt')).toBeNull();
    // 其余列照常
    expect(columns()[0].textContent).toContain('第一列在正常写');
    // 汇总只报数量，不改单列状态
    expect(container.textContent).toContain('1 路失败');
    expect(container.textContent).toContain('1/3 已完成');
  });

  it('点重试只重发那一列，并把它的错误清掉', async () => {
    const [keyA, keyB] = startCompare();
    render(<ComparePanel modelCatalog={CATALOG} taskId={TASK_ID} />);
    act(() => {
      messageStore().getState().setSessionError(keyB, '上游 500');
    });
    await flush();

    hoisted.gatewayCalls = [];
    act(() => {
      buttonIn(1, 'compare-retry')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(messageStore().getState().errorBySession[keyB]).toBeUndefined();
    expect(hoisted.gatewayCalls.filter((c) => c.method === 'sendMessage').map((c) => c.args[1])).toEqual([keyB]);
    expect(hoisted.gatewayCalls.every((c) => c.method !== 'sendMessage' || c.args[1] !== keyA)).toBe(true);
  });

  it('点采纳 = 时间线里多出一问一答，会话指针指向那一列，面板退出', async () => {
    const [keyA] = startCompare(['qwen-plus', 'glm-4.7']);
    render(<ComparePanel modelCatalog={CATALOG} taskId={TASK_ID} />);
    act(() => {
      const store = messageStore().getState();
      store.appendStreamDelta(keyA, '我是通义千问');
      store.finalizeStream(keyA);
    });
    await flush();

    act(() => {
      buttonIn(0, 'compare-adopt')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const messages = messageStore().getState().messagesByTask[TASK_ID];
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[0].content).toBe(PROMPT);
    expect(messages[1].content).toBe('我是通义千问');
    // 徽章的模型来自**网关历史**，不是列的配置模型 —— 假网关刻意报一个不在任何一列上的
    // 模型名，这条断言才真的在验来源（用列的配置模型也能过的断言等于没验）
    expect(messages[1].model).toBe(hoisted.gatewayModel);
    // 「采纳后新会话带上下文」：任务会话指针改成这一列
    expect(hoisted.taskMeta).toEqual([{ id: TASK_ID, meta: { sessionKey: keyA } }]);
    // 面板退出，对话区回来
    expect(container.querySelector('[data-testid="compare-panel"]')).toBeNull();
    expect(compareStore().getState().active).toBeNull();
    // 采纳成功 = 这一轮结束 ⇒ 退出对比模式：不然选择条立刻又冒出来，
    // 用户刚说完"就用这个答案"，下一句话又变成一轮全新的对比
    expect(compareStore().getState().mode).toBe(false);
  });

  it('别的任务在跑对比时这一屏不出面板（这一屏是**这个任务**的对话）', async () => {
    startCompare();
    render(<ComparePanel modelCatalog={CATALOG} taskId="task-2" />);
    await flush();

    expect(container.querySelector('[data-testid="compare-panel"]')).toBeNull();
    // 那一轮本身没被碰掉：切回去还看得见
    expect(compareStore().getState().active?.taskId).toBe(TASK_ID);
  });

  it('有采纳在飞时所有「采纳」按钮都禁用（同步占位，防连点）', async () => {
    const [keyA, keyB] = startCompare(['qwen-plus', 'glm-4.7']);
    render(<ComparePanel modelCatalog={CATALOG} taskId={TASK_ID} />);
    act(() => {
      const store = messageStore().getState();
      store.appendStreamDelta(keyA, '答案 A');
      store.finalizeStream(keyA);
      store.appendStreamDelta(keyB, '答案 B');
      store.finalizeStream(keyB);
    });
    await flush();
    expect(isDisabled(buttonIn(0, 'compare-adopt'))).toBe(false);
    expect(isDisabled(buttonIn(1, 'compare-adopt'))).toBe(false);

    // 采纳的落库要等一次网关往返（探针）：这期间按钮必须已经是禁用的
    act(() => {
      compareStore().setState({ adoptingKey: keyA });
    });
    await flush();
    expect(isDisabled(buttonIn(0, 'compare-adopt'))).toBe(true);
    expect(isDisabled(buttonIn(1, 'compare-adopt'))).toBe(true);

    // 失败/取消之后要能恢复（锁不是一次性的）
    act(() => {
      compareStore().setState({ adoptingKey: null });
    });
    await flush();
    expect(isDisabled(buttonIn(0, 'compare-adopt'))).toBe(false);
  });

  it('取消：跑着时按钮说「取消对比」、全部落定后说「关闭」，点完面板退出', async () => {
    const [keyA, keyB, keyC] = startCompare();
    render(<ComparePanel modelCatalog={CATALOG} taskId={TASK_ID} />);
    const dismiss = container.querySelector<HTMLButtonElement>('[data-testid="compare-dismiss"]')!;
    expect(dismiss.textContent).toContain('取消对比');

    // 全部落定（成 / 败都算）之后就没有"还在跑的列"了，同一个按钮改成「关闭」（不再假装能中止什么）
    act(() => {
      const store = messageStore().getState();
      store.appendStreamDelta(keyA, '答案');
      store.finalizeStream(keyA);
      store.setSessionError(keyB, '余额不足');
      store.setSessionError(keyC, '超时');
    });
    await flush();
    expect(dismiss.textContent).toContain('关闭');
    expect(dismiss.textContent).not.toContain('取消对比');

    act(() => {
      dismiss.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(container.querySelector('[data-testid="compare-panel"]')).toBeNull();
    expect(compareStore().getState().active).toBeNull();
  });

  it('没有在跑的对比时不渲染任何东西（普通对话不受影响）', () => {
    render(<ComparePanel modelCatalog={CATALOG} taskId={TASK_ID} />);
    expect(container.querySelector('[data-testid="compare-panel"]')).toBeNull();
  });
});

describe('对比模式的选择条', () => {
  const onClose = vi.fn();

  beforeEach(() => {
    hoisted.gatewayCalls = [];
    hoisted.taskMeta = [];
    hoisted.message = createMessageStore({ persistMessage: vi.fn(async () => ({ ok: true })) });
    onClose.mockReset();
    compareStore().setState({
      active: null,
      mode: true,
      draftModels: [],
      ephemeralKeys: new Set<string>(),
      error: null,
    });
  });

  afterEach(() => {
    unmount?.();
    document.body.innerHTML = '';
  });

  it('选中的模型显示成带序号的小块，数量不足时提示最少几个', async () => {
    compareStore().getState().setDraftModels(['qwen-plus', 'glm-4.7']);
    render(<CompareSetupBar modelCatalog={CATALOG} onClose={onClose} />);
    await flush();

    const chips = [...container.querySelectorAll('[data-testid="compare-model-chip"]')];
    expect(chips).toHaveLength(2);
    expect(chips[0].textContent).toContain('通义千问 Plus');
    expect(chips[1].textContent).toContain('智谱 GLM-4.7');
    expect(container.textContent).toContain('将并发询问 2 个模型');

    // 去掉一个 → 提示「至少选择 2 个模型」，此时发送会被拦下
    act(() => {
      chips[0].querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(container.querySelectorAll('[data-testid="compare-model-chip"]')).toHaveLength(1);
    expect(container.textContent).toContain('至少选择 2 个模型');
  });

  it('目录里已选中的模型在菜单里不可再点（同一句话不会问同一个模型两遍）', async () => {
    compareStore().getState().setDraftModels(['qwen-plus']);
    render(<CompareSetupBar modelCatalog={CATALOG} onClose={onClose} />);
    await flush();

    const items = [...container.querySelectorAll<HTMLButtonElement>('button')];
    const picked = items.find((b) => b.textContent === '通义千问 Plus')!;
    const other = items.find((b) => b.textContent === '智谱 GLM-4.7')!;
    expect(isDisabled(picked)).toBe(true);
    expect(isDisabled(other)).toBe(false);

    act(() => {
      other.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(compareStore().getState().draftModels).toEqual(['qwen-plus', 'glm-4.7']);
  });

  it('「退出对比」把模式关掉（关掉不影响已经跑起来的单模型对话）', async () => {
    render(<CompareSetupBar modelCatalog={CATALOG} onClose={onClose} />);
    await flush();
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="compare-setup-close"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('一个模型都没有时只给提示，不给可选菜单', async () => {
    render(<CompareSetupBar modelCatalog={[]} onClose={onClose} />);
    await flush();
    expect(container.textContent).toContain('暂无可用模型');
  });
});
