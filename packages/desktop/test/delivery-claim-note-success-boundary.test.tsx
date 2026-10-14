// @vitest-environment jsdom

/**
 * BUG-026 成功边界（r6 终审 F4，2026-10-14）：**可信交付成功要结束上一段失败去重周期**。
 *
 * 反例（终审真实 hook/store 探针，见 `reviews/r6-artifact-review/delivery-success-boundary.test.tsx`）：
 *   同 task/session 里「失败 → 修好并**成功交付** → 再改又失败」，
 *   期望两次失败各通知一次；`916b4254` 之后实际只弹一次 ——
 *   因为去重扫描**整个历史**的"同文便签"，成功事件只进 `artifactDeliveryStore`，不结束旧周期。
 *
 * 修法（本轮）：可信交付成功（`artifact:delivery-settled` 的 `status === 'succeeded'`）时，
 * 把该 task/session 里**此刻已存在**的系统便签记为"上一段周期"；去重只对**当前周期**
 * 的便签生效。历史便签不删（模型上下文照旧拿得到），也不加永久失败缓存
 * （判定仍每轮由主进程重新做出，这里只是把"当前周期"划清）。
 *
 * 保留的语义（本文件钉住）：
 *   ① 同一失败连续重检（每轮 failed settled + 新 messageId）⇒ 仍只通知一次、便签一条；
 *   ② 成功边界之后的新失败 ⇒ 重新通知 + 追加新便签（旧便签留在历史里）；
 *   ③ 非成功 settled（failed / needs-review / canceled）**不**结束周期 ——
 *      needs-review 是"未确认"，不是可信成功；把它当边界会让未解决的同一失败
 *      在中段 needs-review 之后重新刷屏；
 *   ④ task/session 隔离：另一个会话的成功不结束本会话的周期（反之亦然）。
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMessageStore } from '@clawwork/core';
import type { ArtifactDeliveryFailure, ArtifactDeliverySettled, Message } from '@clawwork/shared';

const mocks = vi.hoisted(() => ({ getState: vi.fn(), toast: vi.fn() }));
vi.mock('../src/renderer/stores/messageStore', () => ({ useMessageStore: { getState: mocks.getState } }));
vi.mock('../src/renderer/lib/toast', () => ({ toast: { error: mocks.toast } }));
vi.mock('react-i18next', () => ({
  // 把插值带上：便签内容里的文件名是"同一失败/不同失败"的判据（真实运行时就靠它）。
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key}:${Object.values(values).join(':')}` : key),
  }),
}));

import { useClaimGuardToast } from '../src/renderer/hooks/useClaimGuardToast';
import { useArtifactDeliveryStore } from '../src/renderer/stores/artifactDeliveryStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mountHook() {
  let violation: ((event: ArtifactDeliveryFailure) => void) | undefined;
  let settled: ((event: ArtifactDeliverySettled) => void) | undefined;
  const store = createMessageStore({ persistMessage: vi.fn(async () => ({ ok: true })) });
  store.getState().bulkLoad('task-1', [] as Message[]);
  mocks.getState.mockImplementation(store.getState);
  mocks.toast.mockClear();
  useArtifactDeliveryStore.setState({ settled: [] });
  Object.defineProperty(window, 'clawwork', {
    configurable: true,
    value: {
      onClaimViolation: (cb: typeof violation) => {
        violation = cb;
        return () => {};
      },
      onArtifactDeliverySettled: (cb: typeof settled) => {
        settled = cb;
        return () => {};
      },
    },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  function Harness() {
    useClaimGuardToast();
    return null;
  }
  act(() => root.render(<Harness />));
  cleanups.push(() =>
    act(() => {
      root.unmount();
      container.remove();
    }),
  );
  return {
    store,
    emit: (event: ArtifactDeliveryFailure) => act(() => violation!(event)),
    settle: (event: ArtifactDeliverySettled) => act(() => settled!(event)),
    notes: (taskId = 'task-1') =>
      store.getState().messagesByTask[taskId].filter((message) => message.role === 'system'),
  };
}

const violation: ArtifactDeliveryFailure = {
  taskId: 'task-1',
  sessionKey: 'session-1',
  messageId: 'failed-1',
  missing: [],
  invalidArtifacts: ['report.docx'],
};

/** 真机一轮的形状：先 `artifact:delivery-settled`（失败轮为 failed），再 `artifact:claim-violation`。 */
function failedRound(messageId: string, sessionKey = 'session-1'): ArtifactDeliverySettled {
  return { taskId: 'task-1', sessionKey, messageId, status: 'failed' };
}

describe('BUG-026 成功边界（r6 F4）', () => {
  it('① 控制项：同一失败连续重检（含每轮 failed settled）⇒ 通知一次、便签一条', () => {
    const mounted = mountHook();

    mounted.settle(failedRound('assistant-1'));
    mounted.emit(violation);
    mounted.settle(failedRound('assistant-2'));
    mounted.emit({ ...violation, messageId: 'assistant-2' });

    expect(mocks.toast, '同一失败周期内只许一次通知').toHaveBeenCalledTimes(1);
    expect(mounted.notes()).toHaveLength(1);
  });

  it('② 反例转正：失败 → 成功交付 → 同文新失败 ⇒ 再次通知且追加新便签（历史便签保留）', () => {
    const mounted = mountHook();

    mounted.settle(failedRound('assistant-1'));
    mounted.emit(violation);
    expect(mocks.toast).toHaveBeenCalledTimes(1);

    // 修好并**成功交付**：这是结束上一段失败周期的唯一可信边界。
    mounted.settle({ taskId: 'task-1', sessionKey: 'session-1', messageId: 'good-revision', status: 'succeeded' });
    expect(useArtifactDeliveryStore.getState().settled.at(-1)?.status).toBe('succeeded');

    // 用户在同一会话里继续改同一份文件（真机形状：中间夹一条用户消息）。
    mounted.store
      .getState()
      .addMessage('task-1', 'user', '继续修改同一份 report.docx', undefined, { sessionKey: 'session-1' });

    mounted.settle(failedRound('assistant-2'));
    mounted.emit({ ...violation, messageId: 'assistant-2' });
    // 新周期里的重复重检仍只算一次。
    mounted.settle(failedRound('assistant-3'));
    mounted.emit({ ...violation, messageId: 'assistant-3' });

    expect(mocks.toast, '成功之后的新失败必须重新通知').toHaveBeenCalledTimes(2);
    const notes = mounted.notes();
    expect(notes, '新失败周期要追加新便签，历史便签不删').toHaveLength(2);
    expect(notes[0].content).toBe(notes[1].content);
  });

  it('③ 非成功 settled（needs-review / canceled）不结束周期 ⇒ 同一失败仍只通知一次', () => {
    const mounted = mountHook();

    mounted.emit(violation);
    mounted.settle({ taskId: 'task-1', sessionKey: 'session-1', messageId: 'review-1', status: 'needs-review' });
    mounted.emit({ ...violation, messageId: 'assistant-2' });
    mounted.settle({ taskId: 'task-1', sessionKey: 'session-1', messageId: 'cancel-1', status: 'canceled' });
    mounted.emit({ ...violation, messageId: 'assistant-3' });

    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mounted.notes()).toHaveLength(1);
  });

  it('④ task/session 隔离：另一个会话的成功不结束本会话的周期，也不替本会话清账', () => {
    const mounted = mountHook();

    mounted.emit(violation);
    mounted.emit({ ...violation, messageId: 'other-session-1', sessionKey: 'session-2' });
    expect(mocks.toast).toHaveBeenCalledTimes(2);

    // session-1 成功：只结束 session-1 的周期。
    mounted.settle({ taskId: 'task-1', sessionKey: 'session-1', messageId: 'good-s1', status: 'succeeded' });
    mounted.emit({ ...violation, messageId: 's1-failed-2' });
    expect(mocks.toast, 'session-1 成功后同文失败要重新通知').toHaveBeenCalledTimes(3);

    // session-2 从未成功过：同文重复仍被压。
    mounted.emit({ ...violation, messageId: 'other-session-2', sessionKey: 'session-2' });
    expect(mocks.toast).toHaveBeenCalledTimes(3);
    expect(mounted.notes().filter((message) => message.sessionKey === 'session-2')).toHaveLength(1);
  });
});
