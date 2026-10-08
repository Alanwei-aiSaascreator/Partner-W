// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGatewayDispatcher,
  type ActiveTurn,
  type AutoRetryFailure,
  type GatewayDispatcherDeps,
  type GatewayEvent,
} from '@clawwork/core';
import type { Artifact, ArtifactDeliveryActivity, Message } from '@clawwork/shared';
import { AUTO_RETRY_DELAY_MS, useAutoRetryFailedTurn } from '../src/renderer/hooks/useAutoRetryFailedTurn';
import { useMessageStore } from '../src/renderer/stores/messageStore';
import { useTaskStore } from '../src/renderer/stores/taskStore';
import { useFileStore } from '../src/renderer/stores/fileStore';
import { useDeliveryActivityStore } from '../src/renderer/stores/deliveryActivityStore';
import { compareStore } from '../src/renderer/features/compare/compare-store-instance';
import i18n from '../src/renderer/i18n';

/**
 * 包 D（2026-10-07）：「整轮失败自动重发 1 次」。BUG-050（2026-10-08）补齐。
 *
 * 这个 hook 的全部价值在于**把不该自动重发的挡在门外**：自动重发会再花一次钱、
 * 而且失败轮可能已经跑过工具（副作用不可逆）。所以这里的用例以"**不**发"为主：
 *   - 类别门：只有 `transient` 才发，`unclassified`（含 malformed / unknown）不发；
 *   - 零最终交付判据（**证据快照**显示本轮无产出、本轮无新产物、无已结算交付）；
 *   - 该任务所有会话空闲、非临时会话、发送前二次校验（用户可能已手动重试）；
 *   - 每条失败消息只自动一次 + 我们自己重发出来的失败不再重发（防环路）。
 *
 * ⭐ BUG-050 的整合用例在最后一个 describe：**真身 dispatcher**（真 error 分支，
 *    真的把 activeTurn 清掉）+ 真身 store + 真身 hook 串起来跑 —— 旧的钩子正是
 *    在这里把"跑过工具的轮次"整轮重发的（证据源被清掉后现读恒为 undefined）。
 */

const composerSend = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock('../src/renderer/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/platform')>();
  // 只换掉 `composer`（唯一发送入口）——store 保持真货，免得把 store 的行为也桩没了。
  return { ...actual, composer: { send: composerSend } };
});

const TASK_ID = 'task-1';
const SESSION = 'agent:main:clawwork:dev:task:task-1';
const OTHER_SESSION = 'agent:worker:clawwork:dev:task:task-1';
const USER_TS = '2026-10-07T10:00:00.000Z';
const TURN_START_MS = Date.parse(USER_TS);
const ERROR_TS = '2026-10-07T10:05:00.000Z';

function userMessage(partial: Partial<Message> = {}): Message {
  return {
    id: 'msg-user',
    taskId: TASK_ID,
    role: 'user',
    content: '帮我做一份年度总结 PPT',
    artifacts: [],
    toolCalls: [],
    timestamp: USER_TS,
    sessionKey: SESSION,
    ...partial,
  };
}

function errorMessage(id = 'err-1'): Message {
  return {
    id,
    taskId: TASK_ID,
    role: 'system',
    content: '运行失败: ⚠️ Agent run failed (model: clawrouter/deepseek-v4-flash)',
    artifacts: [],
    toolCalls: [],
    timestamp: ERROR_TS,
    sessionKey: SESSION,
  };
}

function failure(partial: Partial<AutoRetryFailure> = {}): AutoRetryFailure {
  // 默认「未分类 + 本轮无产出」= 最保守的登记形状：两个门（类别门 / 产出快照）
  // 都由用例显式放宽才能真正发出去。
  return { taskId: TASK_ID, messageId: 'err-1', kind: 'unclassified', producedOutput: false, ...partial };
}

function turn(partial: Partial<ActiveTurn> = {}): ActiveTurn {
  return {
    id: 'turn-1',
    streamingText: '',
    streamingThinking: '',
    toolCalls: [],
    finalized: false,
    content: '',
    timestamp: USER_TS,
    ...partial,
  };
}

function artifact(createdAt: string): Artifact {
  return {
    id: `artifact-${createdAt}`,
    taskId: TASK_ID,
    messageId: 'assistant-1',
    type: 'ppt',
    name: 'deck.pptx',
    filePath: 'C:\\work\\deck.pptx',
    localPath: 'deck.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    size: 1,
    createdAt,
    availability: 'available',
  } as unknown as Artifact;
}

function delivery(startedAt: number, status: ArtifactDeliveryActivity['status']): ArtifactDeliveryActivity {
  return {
    taskId: TASK_ID,
    sessionKey: SESSION,
    messageId: 'assistant-1',
    workspaceScope: 'scope',
    workspaceRevision: 1,
    operationId: `op-${startedAt}`,
    sequence: 1,
    startedAt,
    phase: 'generating-presentation',
    status,
  };
}

function Probe() {
  useAutoRetryFailedTurn();
  return null;
}

let container: HTMLDivElement;
let root: Root;

function seed(partial: {
  messages?: Message[];
  turns?: Record<string, ActiveTurn>;
  busy?: string[];
  artifacts?: Artifact[];
  deliveries?: ArtifactDeliveryActivity[];
  ephemeral?: string[];
}) {
  act(() => {
    useMessageStore.setState({
      messagesByTask: { [TASK_ID]: partial.messages ?? [userMessage(), errorMessage()] },
      activeTurnBySession: partial.turns ?? {},
      processingBySession: new Set(partial.busy ?? []),
      autoRetryFailureBySession: {},
    });
    useTaskStore.setState({
      tasks: [{ id: TASK_ID, title: 'Task', gatewayId: 'gw-1', sessionKey: SESSION }] as never,
    });
    useFileStore.setState({ artifacts: partial.artifacts ?? [] });
    useDeliveryActivityStore.setState({
      records: Object.fromEntries((partial.deliveries ?? []).map((entry) => [entry.operationId, entry])),
    });
    compareStore().setState({ ephemeralKeys: new Set(partial.ephemeral ?? []) });
  });
}

function emitFailure(partial: Partial<AutoRetryFailure> = {}) {
  act(() => {
    useMessageStore.setState({ autoRetryFailureBySession: { [SESSION]: failure(partial) } });
  });
}

async function flush(ms = AUTO_RETRY_DELAY_MS + 50) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function taskMessages(): Message[] {
  return useMessageStore.getState().messagesByTask[TASK_ID] ?? [];
}

function noticeCount(): number {
  return taskMessages().filter((message) => message.content === i18n.t('chatMessage.autoRetryNotice')).length;
}

beforeAll(async () => {
  await i18n.changeLanguage('zh');
});

beforeEach(() => {
  vi.useFakeTimers();
  composerSend.mockClear();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as unknown as { window: Window }).window.clawwork = {
    persistMessage: vi.fn(async () => ({ ok: true })),
  } as unknown as Window['clawwork'];

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useAutoRetryFailedTurn —— 该发的', () => {
  it('⭐ 瞬时类失败（transient）+ 零交付 ⇒ 自动重发一次，且先明示再发', async () => {
    seed({});
    act(() => root.render(<Probe />));
    emitFailure({ kind: 'transient' });

    // 到点之前什么都不做（登记的释放本身就有 2s 去重窗，这里再留一拍给迟到帧）
    await flush(AUTO_RETRY_DELAY_MS - 100);
    expect(composerSend).not.toHaveBeenCalled();

    let messagesAtSend: string[] = [];
    composerSend.mockImplementationOnce(async () => {
      messagesAtSend = taskMessages().map((message) => message.content);
      return { ok: true };
    });
    await flush();

    expect(composerSend).toHaveBeenCalledTimes(1);
    expect(composerSend).toHaveBeenCalledWith(TASK_ID, { content: '帮我做一份年度总结 PPT' });
    // 用户先被告知，再看到那条"凭空多出来的"用户气泡
    expect(messagesAtSend).toContain(i18n.t('chatMessage.autoRetryNotice'));
    expect(i18n.t('chatMessage.autoRetryNotice')).toContain('自动重试');
    expect(noticeCount()).toBe(1);
  });

  it('附件跟着原样回去（只发正文会变成"看起来一样、其实不是同一件事"）', async () => {
    const attachment = { id: 'att-1', name: '数据.xlsx', path: 'C:\\work\\数据.xlsx', size: 10 } as never;
    seed({ messages: [userMessage({ attachments: [attachment] }), errorMessage()] });
    act(() => root.render(<Probe />));
    emitFailure({ kind: 'transient' });

    await flush();

    expect(composerSend).toHaveBeenCalledWith(TASK_ID, {
      content: '帮我做一份年度总结 PPT',
      messageAttachments: [attachment],
    });
  });

  it('本轮产物是**上一轮**留下的（早于本轮起点）⇒ 不影响重发', async () => {
    seed({ artifacts: [artifact('2026-10-07T09:00:00.000Z')] });
    act(() => root.render(<Probe />));
    emitFailure({ kind: 'transient' });

    await flush();

    expect(composerSend).toHaveBeenCalledTimes(1);
  });

  it('已经结算过的交付是**更早**一轮的 ⇒ 不影响重发', async () => {
    seed({ deliveries: [delivery(TURN_START_MS - 60_000, 'succeeded')] });
    act(() => root.render(<Probe />));
    emitFailure({ kind: 'transient' });

    await flush();

    expect(composerSend).toHaveBeenCalledTimes(1);
  });
});

describe('useAutoRetryFailedTurn —— 类别门 + 零最终交付判据（挡住的）', () => {
  it('⭐ 未分类（unclassified）失败 ⇒ 不自动重发 —— 认不出来就不替用户再花一次钱（BUG-050）', async () => {
    // 这门是**有意收紧**的：`malformed tool call` / `unknown` / lifecycle 那种只有一句
    // 英文原文的失败，登记时全都落进 `unclassified`（dispatcher 拿不到结构化类别）。
    // 旧行为（登记了就按零交付判据放行）与"确认重发能改变结果"无关，纯赌。
    seed({});
    act(() => root.render(<Probe />));
    emitFailure(); // kind 默认 unclassified

    await flush();

    expect(composerSend).not.toHaveBeenCalled();
  });

  it('⭐ 证据快照显示本轮已产出（跑过工具）⇒ 不自动重发 —— 哪怕 store 里已被清干净（BUG-050 主判据）', async () => {
    // 真实现场：dispatcher 的错误分支**先** clearActiveTurn、**再**登记候选，
    // 1.5s 后评估时 activeTurn 早就没了（`turns: {}` 正是那个现场）——
    // 唯一还能证明"跑过工具"的就是登记时带出来的快照。
    seed({ turns: {} });
    act(() => root.render(<Probe />));
    emitFailure({ kind: 'transient', producedOutput: true });

    await flush();

    expect(composerSend).not.toHaveBeenCalled();
  });

  it.each([
    ['正文已经出过字', turn({ streamingText: '正在写第 1 页…' })],
    [
      '工具调用已经跑过（可能有不可逆副作用）',
      turn({ toolCalls: [{ id: 't1', name: 'exec', status: 'done' } as never] }),
    ],
    ['这一轮已收尾', turn({ finalized: true, content: '做完了' })],
  ])('还活着的 activeTurn 里%s ⇒ 不自动重发（迟到帧会把 turn 重新建出来）', async (_label, activeTurn) => {
    seed({ turns: { [SESSION]: activeTurn } });
    act(() => root.render(<Probe />));
    emitFailure({ kind: 'transient' });

    await flush();

    expect(composerSend).not.toHaveBeenCalled();
  });

  it('本轮已经有新产物 ⇒ 不自动重发', async () => {
    seed({ artifacts: [artifact('2026-10-07T10:02:00.000Z')] });
    act(() => root.render(<Probe />));
    emitFailure({ kind: 'transient' });

    await flush();

    expect(composerSend).not.toHaveBeenCalled();
  });

  it.each(['succeeded', 'needs-review'] as const)('本轮有已结算的交付（%s）⇒ 不自动重发', async (status) => {
    seed({ deliveries: [delivery(TURN_START_MS + 60_000, status)] });
    act(() => root.render(<Probe />));
    emitFailure({ kind: 'transient' });

    await flush();

    expect(composerSend).not.toHaveBeenCalled();
  });
});

describe('useAutoRetryFailedTurn —— 防线', () => {
  it('该任务还有别的会话在跑（会议/团队是多会话的）⇒ 不插手', async () => {
    seed({ busy: [OTHER_SESSION] });
    act(() => root.render(<Probe />));
    emitFailure({ kind: 'transient' });

    await flush();

    expect(composerSend).not.toHaveBeenCalled();
  });

  it('临时会话（对比的一列）⇒ 永远不自动重发', async () => {
    seed({ ephemeral: [SESSION] });
    act(() => root.render(<Probe />));
    // `transient` 是"本来真会发"的形状 —— 挡住它的必须只有"临时会话"这一条。
    emitFailure({ kind: 'transient' });

    await flush();

    expect(composerSend).not.toHaveBeenCalled();
  });

  it('⭐ 到点时登记已被清（用户已经手动重试）⇒ 放弃，不抢在用户前面再发一条', async () => {
    seed({});
    act(() => root.render(<Probe />));
    emitFailure({ kind: 'transient' });
    act(() => {
      useMessageStore.setState({ autoRetryFailureBySession: {} });
    });

    await flush();

    expect(composerSend).not.toHaveBeenCalled();
  });

  it('同一失败消息只自动一次（重复登记同一 entry 不会再发）', async () => {
    seed({});
    act(() => root.render(<Probe />));
    emitFailure({ kind: 'transient' });
    await flush();
    expect(composerSend).toHaveBeenCalledTimes(1);

    emitFailure({ kind: 'transient' });
    await flush();

    expect(composerSend).toHaveBeenCalledTimes(1);
    expect(noticeCount()).toBe(1);
  });

  it('⭐ 防环路：自动重试自己那轮再失败 ⇒ 不再自动重试（每条失败消息只自动一次，重发出来的不算）', async () => {
    seed({});
    act(() => root.render(<Probe />));
    emitFailure({ kind: 'transient' });
    await flush();
    expect(composerSend).toHaveBeenCalledTimes(1);

    // 模拟 composer.send 真发出去后的现场：多了一条**我们自己重发**的用户消息 + 新的失败消息
    act(() => {
      useMessageStore.setState({
        messagesByTask: {
          [TASK_ID]: [
            userMessage(),
            errorMessage(),
            userMessage({ id: 'msg-user-retry', timestamp: '2026-10-07T10:06:00.000Z' }),
            errorMessage('err-2'),
          ],
        },
      });
    });
    emitFailure({ kind: 'transient', messageId: 'err-2' });

    await flush();

    expect(composerSend).toHaveBeenCalledTimes(1);
  });

  it('错误消息前面没有可重发的用户消息 ⇒ 什么都不做（不编一句空话发出去）', async () => {
    seed({ messages: [errorMessage()] });
    act(() => root.render(<Probe />));
    emitFailure({ kind: 'transient' });

    await flush();

    expect(composerSend).not.toHaveBeenCalled();
  });

  it('挂载时没有候选 ⇒ 连定时器都不排（不做无谓的等待）', async () => {
    seed({});
    act(() => root.render(<Probe />));

    await flush();

    expect(composerSend).not.toHaveBeenCalled();
  });
});

/**
 * ⭐ BUG-050 的整合用例：**真身 dispatcher** + 真身 store + 真身 hook 串起来跑。
 *
 * 既有用例分别测"dispatcher 登记了什么"（core 侧）与"hook 拿到候选后发不发"——
 * 中间的衔接段（**登记前 activeTurn 已经被真的清掉**）谁都没测，而 bug 正藏在那里。
 * 这里让 dispatcher 用真实 error 分支处理一条 chat error 帧：它真的会
 * `clearActiveTurn`，再把候选写进**同一个** store；旧钩子就是在这个衔接处读到
 * "已被清空的证据源"，把跑过工具的轮次整轮重发（write/exec 副作用重复）。
 */
function createDispatcherHarness() {
  let listener: ((data: GatewayEvent) => void) | null = null;
  const deps = {
    gateway: {
      onGatewayEvent: (cb: (data: GatewayEvent) => void) => {
        listener = cb;
        return () => {
          listener = null;
        };
      },
    },
    getSettings: async () => null,
    sendNotification: vi.fn(async () => ({})),
    getTaskStore: () => useTaskStore.getState(),
    getMessageStore: () => useMessageStore.getState(),
    getActiveTaskId: () => null,
    markUnread: vi.fn(),
    onToast: vi.fn(),
    translate: (key: string) => key,
    isWindowFocused: () => true,
    reportDebugEvent: vi.fn(),
    syncSessionMessages: vi.fn(async () => {}),
  } as unknown as GatewayDispatcherDeps;

  const dispatcher = createGatewayDispatcher(deps);
  dispatcher.start();
  return {
    /** 一条真正的 chat error 帧（`routeRunFrame` → `handleChatEvent` 的 error 分支）。 */
    emitChatError(payload: { errorMessage: string; errorKind?: string }) {
      listener?.({ event: 'chat', payload: { sessionKey: SESSION, state: 'error', ...payload }, gatewayId: 'gw-1' });
    },
  };
}

describe('useAutoRetryFailedTurn × gateway-dispatcher —— 真 error 分支清理后的整合（BUG-050）', () => {
  it('⭐ 跑过工具（有落盘证据）的轮次被真实 error 分支清掉 activeTurn ⇒ 不得自动重发', async () => {
    seed({
      messages: [userMessage()],
      turns: { [SESSION]: turn({ toolCalls: [{ id: 't1', name: 'exec', status: 'done' } as never] }) },
      busy: [SESSION],
    });
    const gateway = createDispatcherHarness();
    gateway.emitChatError({ errorMessage: 'RateLimitExceededError: slow down', errorKind: 'rate_limit' });

    // 站在真实现场里（前置事实，不是被测行为）：activeTurn 真的被清掉了，
    // "跑过工具"这唯一一份证据只剩候选里那张快照。
    const state = useMessageStore.getState();
    expect(state.activeTurnBySession[SESSION]).toBeUndefined();
    expect(state.autoRetryFailureBySession[SESSION]?.kind).toBe('transient');
    expect(state.autoRetryFailureBySession[SESSION]?.producedOutput).toBe(true);

    act(() => root.render(<Probe />));
    await flush();

    expect(composerSend).not.toHaveBeenCalled();
  });

  it('⭐ 认不出类别（unknown / malformed tool call 那条路）⇒ 登记为未分类，且不得自动重发', async () => {
    seed({ messages: [userMessage()] });
    const gateway = createDispatcherHarness();
    gateway.emitChatError({
      errorMessage: 'Provider returned an incomplete or malformed tool call',
      errorKind: 'unknown',
    });

    expect(useMessageStore.getState().autoRetryFailureBySession[SESSION]?.kind).toBe('unclassified');

    act(() => root.render(<Probe />));
    await flush();

    expect(composerSend).not.toHaveBeenCalled();
  });

  it('对照：瞬时类失败 + 本轮什么都没产出 ⇒ 照常自动重发（这条链整体仍然活着）', async () => {
    seed({ messages: [userMessage()], busy: [SESSION] });
    const gateway = createDispatcherHarness();
    gateway.emitChatError({ errorMessage: 'RateLimitExceededError: slow down', errorKind: 'rate_limit' });

    act(() => root.render(<Probe />));
    await flush();

    expect(composerSend).toHaveBeenCalledTimes(1);
    expect(composerSend).toHaveBeenCalledWith(TASK_ID, { content: '帮我做一份年度总结 PPT' });
  });
});
