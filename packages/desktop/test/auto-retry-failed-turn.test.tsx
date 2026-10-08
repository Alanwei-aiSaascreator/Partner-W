// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveTurn, AutoRetryFailure } from '@clawwork/core';
import type { Artifact, ArtifactDeliveryActivity, Message } from '@clawwork/shared';
import { AUTO_RETRY_DELAY_MS, useAutoRetryFailedTurn } from '../src/renderer/hooks/useAutoRetryFailedTurn';
import { useMessageStore } from '../src/renderer/stores/messageStore';
import { useTaskStore } from '../src/renderer/stores/taskStore';
import { useFileStore } from '../src/renderer/stores/fileStore';
import { useDeliveryActivityStore } from '../src/renderer/stores/deliveryActivityStore';
import { compareStore } from '../src/renderer/features/compare/compare-store-instance';
import i18n from '../src/renderer/i18n';

/**
 * 包 D（2026-10-07）：「整轮失败自动重发 1 次」。
 *
 * 这个 hook 的全部价值在于**把不该自动重发的挡在门外**：自动重发会再花一次钱、
 * 而且失败轮可能已经跑过工具（副作用不可逆）。所以这里的用例以"**不**发"为主：
 *   - 零最终交付判据（activeTurn 无正文/工具、本轮无新产物、无已结算交付）；
 *   - 该任务所有会话空闲、非临时会话、发送前二次校验（用户可能已手动重试）；
 *   - 每条失败消息只自动一次 + 我们自己重发出来的失败不再重发（防环路）。
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
  return { taskId: TASK_ID, messageId: 'err-1', kind: 'unclassified', ...partial };
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
  it('⭐ 未分类失败 + 零交付 ⇒ 自动重发一次，且先明示再发', async () => {
    seed({});
    act(() => root.render(<Probe />));
    emitFailure();

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

  it('瞬时类（transient）候选同样自动重发（重发真可能改变结果的那一类）', async () => {
    seed({});
    act(() => root.render(<Probe />));
    emitFailure({ kind: 'transient' });

    await flush();

    expect(composerSend).toHaveBeenCalledTimes(1);
  });

  it('附件跟着原样回去（只发正文会变成"看起来一样、其实不是同一件事"）', async () => {
    const attachment = { id: 'att-1', name: '数据.xlsx', path: 'C:\\work\\数据.xlsx', size: 10 } as never;
    seed({ messages: [userMessage({ attachments: [attachment] }), errorMessage()] });
    act(() => root.render(<Probe />));
    emitFailure();

    await flush();

    expect(composerSend).toHaveBeenCalledWith(TASK_ID, {
      content: '帮我做一份年度总结 PPT',
      messageAttachments: [attachment],
    });
  });

  it('本轮产物是**上一轮**留下的（早于本轮起点）⇒ 不影响重发', async () => {
    seed({ artifacts: [artifact('2026-10-07T09:00:00.000Z')] });
    act(() => root.render(<Probe />));
    emitFailure();

    await flush();

    expect(composerSend).toHaveBeenCalledTimes(1);
  });

  it('已经结算过的交付是**更早**一轮的 ⇒ 不影响重发', async () => {
    seed({ deliveries: [delivery(TURN_START_MS - 60_000, 'succeeded')] });
    act(() => root.render(<Probe />));
    emitFailure();

    await flush();

    expect(composerSend).toHaveBeenCalledTimes(1);
  });
});

describe('useAutoRetryFailedTurn —— 零最终交付判据（挡住的）', () => {
  it.each([
    ['正文已经出过字', turn({ streamingText: '正在写第 1 页…' })],
    [
      '工具调用已经跑过（可能有不可逆副作用）',
      turn({ toolCalls: [{ id: 't1', name: 'exec', status: 'done' } as never] }),
    ],
    ['这一轮已收尾', turn({ finalized: true, content: '做完了' })],
  ])('activeTurn 里%s ⇒ 不自动重发', async (_label, activeTurn) => {
    seed({ turns: { [SESSION]: activeTurn } });
    act(() => root.render(<Probe />));
    emitFailure();

    await flush();

    expect(composerSend).not.toHaveBeenCalled();
  });

  it('本轮已经有新产物 ⇒ 不自动重发', async () => {
    seed({ artifacts: [artifact('2026-10-07T10:02:00.000Z')] });
    act(() => root.render(<Probe />));
    emitFailure();

    await flush();

    expect(composerSend).not.toHaveBeenCalled();
  });

  it.each(['succeeded', 'needs-review'] as const)('本轮有已结算的交付（%s）⇒ 不自动重发', async (status) => {
    seed({ deliveries: [delivery(TURN_START_MS + 60_000, status)] });
    act(() => root.render(<Probe />));
    emitFailure();

    await flush();

    expect(composerSend).not.toHaveBeenCalled();
  });
});

describe('useAutoRetryFailedTurn —— 防线', () => {
  it('该任务还有别的会话在跑（会议/团队是多会话的）⇒ 不插手', async () => {
    seed({ busy: [OTHER_SESSION] });
    act(() => root.render(<Probe />));
    emitFailure();

    await flush();

    expect(composerSend).not.toHaveBeenCalled();
  });

  it('临时会话（对比的一列）⇒ 永远不自动重发', async () => {
    seed({ ephemeral: [SESSION] });
    act(() => root.render(<Probe />));
    emitFailure();

    await flush();

    expect(composerSend).not.toHaveBeenCalled();
  });

  it('⭐ 到点时登记已被清（用户已经手动重试）⇒ 放弃，不抢在用户前面再发一条', async () => {
    seed({});
    act(() => root.render(<Probe />));
    emitFailure();
    act(() => {
      useMessageStore.setState({ autoRetryFailureBySession: {} });
    });

    await flush();

    expect(composerSend).not.toHaveBeenCalled();
  });

  it('同一失败消息只自动一次（重复登记同一 entry 不会再发）', async () => {
    seed({});
    act(() => root.render(<Probe />));
    emitFailure();
    await flush();
    expect(composerSend).toHaveBeenCalledTimes(1);

    emitFailure();
    await flush();

    expect(composerSend).toHaveBeenCalledTimes(1);
    expect(noticeCount()).toBe(1);
  });

  it('⭐ 防环路：自动重试自己那轮再失败 ⇒ 不再自动重试（每条失败消息只自动一次，重发出来的不算）', async () => {
    seed({});
    act(() => root.render(<Probe />));
    emitFailure();
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
    emitFailure({ messageId: 'err-2' });

    await flush();

    expect(composerSend).toHaveBeenCalledTimes(1);
  });

  it('错误消息前面没有可重发的用户消息 ⇒ 什么都不做（不编一句空话发出去）', async () => {
    seed({ messages: [errorMessage()] });
    act(() => root.render(<Probe />));
    emitFailure();

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
