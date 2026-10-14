// @vitest-environment jsdom

/**
 * r7-1 / F4（BUG-026 跨重开残余）验收补充：成功边界的**三种可恢复证据**与窗口淘汰后的行为。
 *
 * 移植反例（`delivery-claim-note-reopen-boundary.test.tsx`）钉的是"重开 + 交付活动快照恢复"这一条；
 * 本文件钉住其余验收面：
 *   ① **持久化最小成功标记**（`messages.delivery_succeeded`，随消息水合）—— 交付活动快照
 *      已经被 256 条窗口淘汰 / 这条操作压根没有活动记录时，边界照样重建（新失败重新通知）；
 *   ② **128 淘汰**：其它 task/session 的成功刷满任何"有上限的边界缓存"之后，本 key 已关闭的
 *      周期仍正确闭合（这正是复审点名的"只换另一份有上限的缓存不够"）；
 *   ③ **无任何证据**：回退旧行为（同因重复被压、不重复刷屏）—— "查不到"≠"未成功"，
 *      只降能力、不误报；
 *   ④ **task/session 隔离**：另一个会话的成功标记不清本会话的历史便签。
 *
 * 历史便签内容由 hook 自己产出一遍再当夹具用（`historicalNoteContent`），不在这里抄文案 ——
 * 抄一份就会在改文案时假绿。
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMessageStore } from '@clawwork/core';
import type { ArtifactDeliveryActivity, ArtifactDeliveryFailure, Message } from '@clawwork/shared';

const mocks = vi.hoisted(() => ({ getState: vi.fn(), toast: vi.fn() }));
vi.mock('../src/renderer/stores/messageStore', () => ({ useMessageStore: { getState: mocks.getState } }));
vi.mock('../src/renderer/lib/toast', () => ({ toast: { error: mocks.toast } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key}:${Object.values(values).join(':')}` : key),
  }),
}));

import { useClaimGuardToast } from '../src/renderer/hooks/useClaimGuardToast';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  mocks.toast.mockClear();
  vi.restoreAllMocks();
});

const taskId = 'task-1';
const sessionKey = 'session-1';
const violation = (messageId: string, session = sessionKey): ArtifactDeliveryFailure => ({
  taskId,
  sessionKey: session,
  messageId,
  missing: [],
  invalidArtifacts: ['report.docx'],
});

function freshStore() {
  return createMessageStore({ persistMessage: vi.fn(async () => ({ ok: true })) });
}

function mount(store = freshStore(), completedActivities: ArtifactDeliveryActivity[] = []) {
  let failed: ((e: ArtifactDeliveryFailure) => void) | undefined;
  let settled: ((e: { taskId: string; sessionKey: string; messageId: string; status: string }) => void) | undefined;
  mocks.getState.mockImplementation(store.getState);
  Object.defineProperty(window, 'clawwork', {
    configurable: true,
    value: {
      onClaimViolation: (cb: typeof failed) => {
        failed = cb;
        return () => {};
      },
      onArtifactDeliverySettled: (cb: typeof settled) => {
        settled = cb;
        return () => {};
      },
      getArtifactDeliveryActivitySnapshot: () =>
        Promise.resolve({ owner: { scope: 'ws-test', revision: 1 }, activities: [], completedActivities }),
    },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  function Harness() {
    useClaimGuardToast();
    return null;
  }
  act(() => root.render(createElement(Harness)));
  const unmount = () =>
    act(() => {
      root.unmount();
      container.remove();
    });
  cleanups.push(unmount);
  return {
    store,
    unmount,
    fail: (e: ArtifactDeliveryFailure) => act(() => failed!(e)),
    settle: (e: Parameters<NonNullable<typeof settled>>[0]) => act(() => settled!(e)),
    notes: (task = taskId) => (store.getState().messagesByTask[task] ?? []).filter((m) => m.role === 'system'),
  };
}

/** 真实便签文案（由 hook 自己产出一遍），供"历史已持久化便签"夹具使用。 */
function historicalNoteContent(): string {
  const scratch = mount();
  scratch.fail(violation('history-failure'));
  const content = scratch.notes()[0]?.content ?? '';
  scratch.unmount();
  mocks.toast.mockClear();
  expect(content).toContain('claimGuard.invalidArtifactBody');
  return content;
}

function fixture(entries: Array<Partial<Message> & Pick<Message, 'id' | 'role' | 'content'>>): Message[] {
  return entries.map((entry) => ({
    taskId,
    sessionKey,
    artifacts: [],
    toolCalls: [],
    timestamp: '2026-10-15T00:00:00.000Z',
    ...entry,
  })) as Message[];
}

/** 持久化的成功交付终态（`artifact_delivery_activities` 读完就是它）。 */
function successActivity(messageId: string): ArtifactDeliveryActivity {
  const endedAt = Date.now();
  return {
    taskId,
    sessionKey,
    messageId,
    workspaceScope: 'ws-test',
    workspaceRevision: 1,
    operationId: `op-${messageId}`,
    sequence: 1,
    startedAt: endedAt - 1,
    phase: 'saving-artifacts',
    status: 'succeeded',
    endedAt,
  };
}

describe('r7-1 成功边界的可恢复证据', () => {
  it('① 交付活动快照查不到成功（256 淘汰 / 无活动），但消息带持久化最小成功标记 ⇒ 新失败仍重新通知', () => {
    const store = freshStore();
    const note = historicalNoteContent();
    store.getState().bulkLoad(
      taskId,
      fixture([
        { id: 'note-history', role: 'system', content: note },
        // main 在 `succeeded` 结算时把这条消息标记为"交付成功过"，重开时随消息水合回来。
        { id: 'assistant-ok', role: 'assistant', content: '已保存修订后的 report.docx', deliverySucceeded: true },
        { id: 'user-next', role: 'user', content: '继续修改 report.docx' },
      ]),
    );

    const h = mount(store, []); // 快照里没有任何成功终态
    h.fail(violation('new-failure-after-eviction'));
    expect(mocks.toast, '已关闭的失败周期不得吞掉新一轮同因失败').toHaveBeenCalledTimes(1);
    expect(h.notes()).toHaveLength(2);

    // 新周期内的重复重检仍只算一次（边界没有把去重能力一起丢掉）。
    h.fail(violation('new-failure-again'));
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(h.notes()).toHaveLength(2);
  });

  it('② 其它 key 的成功刷满 128 条级缓存之后，本 key 已关闭的周期仍正确闭合', () => {
    const store = freshStore();
    const note = historicalNoteContent();
    store.getState().bulkLoad(
      taskId,
      fixture([
        { id: 'note-history', role: 'system', content: note },
        { id: 'assistant-ok', role: 'assistant', content: '已保存修订后的 report.docx', deliverySucceeded: true },
        { id: 'user-next', role: 'user', content: '继续修改 report.docx' },
      ]),
    );

    const h = mount(store, []);
    for (let index = 0; index < 130; index += 1) {
      h.settle({
        taskId: `task-other-${index}`,
        sessionKey: 'session-1',
        messageId: `ok-${index}`,
        status: 'succeeded',
      });
    }

    h.fail(violation('after-128-evictions'));
    expect(mocks.toast, '缓存淘汰不得让已关闭的周期重新生效').toHaveBeenCalledTimes(1);
    expect(h.notes()).toHaveLength(2);
  });

  it('③ 没有任何成功证据 ⇒ 回退旧行为：同因重复被压（重开不重复刷屏）', () => {
    const store = freshStore();
    const note = historicalNoteContent();
    store.getState().bulkLoad(
      taskId,
      fixture([
        { id: 'note-history', role: 'system', content: note },
        { id: 'user-next', role: 'user', content: '还是没看到文件' },
      ]),
    );

    const h = mount(store, []);
    h.fail(violation('same-failure'));
    expect(mocks.toast, '查不到成功证据时不许把它当成成功').toHaveBeenCalledTimes(0);
    expect(h.notes()).toHaveLength(1);
  });

  it('④ 持久化标记按 task/session 隔离：另一个会话的成功标记不清本会话', () => {
    const store = freshStore();
    const note = historicalNoteContent();
    store.getState().bulkLoad(
      taskId,
      fixture([
        { id: 'note-s1', role: 'system', content: note },
        {
          id: 'assistant-ok-s2',
          role: 'assistant',
          content: '另一个会话的成功回复',
          sessionKey: 'session-2',
          deliverySucceeded: true,
        },
        { id: 'user-next', role: 'user', content: '继续' },
      ]),
    );

    const h = mount(store, []);
    h.fail(violation('s1-failure'));
    expect(mocks.toast, 'session-2 的成功不得替 session-1 关闭周期').toHaveBeenCalledTimes(0);
    expect(h.notes()).toHaveLength(1);
  });

  it('⑤ 升级前的成功（消息没有标记）靠交付活动快照恢复边界', async () => {
    const store = freshStore();
    const note = historicalNoteContent();
    store.getState().bulkLoad(
      taskId,
      fixture([
        { id: 'note-history', role: 'system', content: note },
        // 加这一列之前落库的成功：消息对象上没有 `deliverySucceeded`。
        { id: 'assistant-ok', role: 'assistant', content: '已保存修订后的 report.docx' },
        { id: 'user-next', role: 'user', content: '继续修改 report.docx' },
      ]),
    );

    const h = mount(store, [successActivity('assistant-ok')]);
    // 真机上"挂载"与"用户又改一版"之间隔着整轮对话；这里让同一次挂载的快照读先落地。
    await act(async () => {});
    h.fail(violation('new-failure-after-upgrade'));
    expect(mocks.toast, '快照恢复的成功消息 id 必须能闭合旧周期').toHaveBeenCalledTimes(1);
    expect(h.notes()).toHaveLength(2);
  });
});
