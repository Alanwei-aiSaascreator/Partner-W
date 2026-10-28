// @vitest-environment jsdom

/**
 * r7-1 / F4（BUG-026 **跨重开残余**）—— 移植自独立复审的最小反例。
 *
 * 来源：`D:/claude/partner-w/reviews/r7-artifact-review/f4-lifecycle.test.tsx`（Codex 独立探针，5 例，
 * 实跑 3 PASS / 2 FAIL，日志 `lifecycle-probes.log`）。原样保留全部 5 例与断言文案：
 *   ① 控制项：r6 原反例已修 + 新周期内重复重检仍去重；
 *   ② 控制项：另一个 session 的成功不清本 session；
 *   ③ 控制项：hook 保持挂载、消息 id 不变的水合保留边界；
 *   ④ 重开反例：**失败 → 可信成功 → 卸载 hook → 新 store 水合原消息 → 同因再失败**
 *      必须重新通知（修复前实际只通知 1 次）；
 *   ⑤ 重复成功回执：**失败A→成功S→失败B→重复S→失败C（B/C 同因）** 期待 2 次通知
 *      （修复前 `:45` 每收到一次 succeeded 就无差别重拍当前全部便签，实际 3 次）。
 *
 * 唯一适配（不削弱反例）：把 preload 面补成**真实形状** —— 真机 `window.clawwork` 除事件订阅外
 * 还有 `getArtifactDeliveryActivitySnapshot()`（`src/preload/index.ts:41`），重开后的成功边界
 * 只能从它（`completedActivities` 里 `status === 'succeeded'` 的持久化终态）恢复；
 * 水合出来的这些消息对象本身**不带**"这条交付成功"的事实（原来的 r6 实现只把边界记在
 * hook 内存 ref 里，重开即丢——这正是本反例的成因）。
 * 重开例在 `fail()` 前多一次 `await act(async () => {})`：真机上"挂载"与"用户又改一版"
 * 之间隔着整轮对话（毫秒级的快照读早已返回），这里只是让同一次挂载的恢复 Promise 落地。
 *
 * 生产链路（静态核对）：便签落盘 `packages/core/src/stores/message-store.ts:700`；
 * 重开读本地消息并 `bulkLoad` `packages/core/src/services/session-sync.ts:406/428`；
 * 新 React root `src/renderer/main.tsx:68`；hook 重挂 `src/renderer/App.tsx:255`。
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMessageStore } from '@clawwork/core';
import type {
  ArtifactDeliveryActivity,
  ArtifactDeliveryFailure,
  ArtifactDeliverySettled,
  Message,
} from '@clawwork/shared';

const mocks = vi.hoisted(() => ({ getState: vi.fn(), toast: vi.fn() }));
vi.mock('../src/renderer/stores/messageStore', () => ({ useMessageStore: { getState: mocks.getState } }));
vi.mock('../src/renderer/lib/toast', () => ({ toast: { error: mocks.toast } }));
vi.mock('react-i18next', () => ({
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
  mocks.toast.mockClear();
  vi.restoreAllMocks();
});

const taskId = 'task-1';
const sessionKey = 'session-1';
const failure = (messageId: string, session = sessionKey): ArtifactDeliveryFailure => ({
  taskId,
  sessionKey: session,
  messageId,
  missing: [],
  invalidArtifacts: ['report.docx'],
});
const success = (messageId: string, session = sessionKey): ArtifactDeliverySettled => ({
  taskId,
  sessionKey: session,
  messageId,
  status: 'succeeded',
});

/** 持久化的成功交付终态（`artifact_delivery_activities` 读完就是它；这里只写本用例用到的字段）。 */
function successActivity(messageId: string, session = sessionKey): ArtifactDeliveryActivity {
  const endedAt = Date.now();
  return {
    taskId,
    sessionKey: session,
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

function freshStore() {
  return createMessageStore({ persistMessage: vi.fn(async () => ({ ok: true })) });
}

function mount(store = freshStore(), completedActivities: ArtifactDeliveryActivity[] = []) {
  let failed: ((e: ArtifactDeliveryFailure) => void) | undefined;
  let settled: ((e: ArtifactDeliverySettled) => void) | undefined;
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
        Promise.resolve({
          owner: { scope: 'ws-test', revision: 1 },
          activities: [],
          completedActivities,
        }),
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
  let closed = false;
  const unmount = () => {
    if (closed) return;
    closed = true;
    act(() => {
      root.unmount();
      container.remove();
    });
  };
  cleanups.push(unmount);
  return {
    store,
    unmount,
    fail: (e: ArtifactDeliveryFailure) => act(() => failed!(e)),
    settle: (e: ArtifactDeliverySettled) => act(() => settled!(e)),
    notes: () => (store.getState().messagesByTask[taskId] ?? []).filter((m) => m.role === 'system'),
  };
}

function addSuccessfulAssistant(store: ReturnType<typeof freshStore>) {
  return store
    .getState()
    .addMessage(taskId, 'assistant', '已保存修订后的 report.docx', undefined, { sessionKey, persist: false });
}

describe('r7-1 跨重开失败周期边界（移植自 reviews/r7-artifact-review/f4-lifecycle.test.tsx）', () => {
  it('control: original r6 counterexample is fixed, and repeated failure in the new episode stays deduped', () => {
    const h = mount();
    h.fail(failure('bad-1'));
    h.settle(success(addSuccessfulAssistant(h.store).id));
    h.fail(failure('bad-2'));
    h.fail(failure('bad-3'));
    expect(mocks.toast).toHaveBeenCalledTimes(2);
    expect(h.notes()).toHaveLength(2);
  });

  it('control: a success in another session cannot clear this session', () => {
    const h = mount();
    h.fail(failure('bad-1'));
    h.settle(success('other-success', 'session-2'));
    h.fail(failure('bad-2'));
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it('control: hydration preserves a known boundary when message identities remain stable', () => {
    const h = mount();
    h.fail(failure('bad-1'));
    h.settle(success(addSuccessfulAssistant(h.store).id));
    h.store.getState().bulkLoad(taskId, structuredClone(h.store.getState().messagesByTask[taskId]));
    h.fail(failure('bad-2'));
    expect(mocks.toast).toHaveBeenCalledTimes(2);
  });

  it('new failure after hook remount and message hydration must not be hidden by a closed historical failure', async () => {
    const h = mount();
    h.fail(failure('bad-before-reopen'));
    const successMessage = addSuccessfulAssistant(h.store);
    h.settle(success(successMessage.id));
    // ⚠️ 与真机一致：持久化的只有消息与交付活动终态，**不带** hook 的内存态。
    const persisted: Message[] = structuredClone(h.store.getState().messagesByTask[taskId]);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    h.unmount();
    const reopenedStore = freshStore();
    useArtifactDeliveryStore.setState({ settled: [] });
    const reopened = mount(reopenedStore, [successActivity(successMessage.id)]);
    await act(async () => {});
    // Real session-sync hydrateFromLocal uses bulkLoad with these same persisted IDs.
    reopenedStore.getState().bulkLoad(taskId, persisted);
    reopenedStore.getState().addMessage(taskId, 'user', '继续修改 report.docx', undefined, { sessionKey });
    reopened.fail(failure('new-failure-after-reopen'));
    expect(mocks.toast, 'closed successful episode must stay closed across remount/hydration').toHaveBeenCalledTimes(2);
  });

  it('replayed success for an already closed older message must not re-open notification for the current failure', () => {
    const h = mount();
    h.fail(failure('bad-1'));
    const oldSuccess = success(addSuccessfulAssistant(h.store).id);
    h.settle(oldSuccess);
    h.fail(failure('bad-2'));
    expect(mocks.toast).toHaveBeenCalledTimes(2);
    h.settle(oldSuccess);
    h.fail(failure('bad-3'));
    expect(mocks.toast, 'older repeated success cannot close the later failure episode').toHaveBeenCalledTimes(2);
  });
});
