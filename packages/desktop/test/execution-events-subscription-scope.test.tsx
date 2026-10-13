// @vitest-environment jsdom
/**
 * `useExecutionEventsSubscription` —— IPC 在途来源校验（2026-10-14 五小时窗）。
 *
 * 复审要求（stale-delivery-owner-supplement 验收 4）：主进程 A 帧在途 → renderer 切 B
 * → 帧到达：**零 apply/零 append/零通知**；当前 B 合法帧照常显示。本档钉住：
 *   1. 同代现场帧 ⇒ 折入投影（sessionKey/events 原样透传）；
 *   2. 换区后在途旧帧（携带捕获时 A 的 scope/revision）⇒ 拒收；
 *   3. 无 scope 字段帧（旧生产者/缺字段）⇒ 拒收（fail-closed，不从当前 workspace 补）；
 *   4. workspaceEpoch 变更后旧闭包回调 ⇒ 拒收（既有归属校验保留）；
 *   5. 当前 B 合法帧照常收（不误杀）。
 *
 * 权威 owner 用**真件** `useDeliveryActivityStore`（兄弟通道维护的同一份
 * ArtifactWorkspaceScope），不做第二套判据。
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const taskScope = vi.hoisted(() => ({ store: undefined as unknown }));
const messageScope = vi.hoisted(() => ({ apply: vi.fn() }));

vi.mock('../src/renderer/stores/taskStore', async () => {
  const { create } = await import('zustand');
  const useTaskStore = create<{ workspaceEpoch: number }>(() => ({ workspaceEpoch: 0 }));
  taskScope.store = useTaskStore as unknown;
  return { useTaskStore };
});

vi.mock('../src/renderer/stores/messageStore', () => ({
  useMessageStore: Object.assign(
    (selector?: (state: { applyExecutionEvents: typeof messageScope.apply }) => unknown) =>
      selector ? selector({ applyExecutionEvents: messageScope.apply }) : { applyExecutionEvents: messageScope.apply },
    { getState: () => ({ applyExecutionEvents: messageScope.apply }) },
  ),
}));

import { useExecutionEventsSubscription } from '../src/renderer/hooks/useExecutionEventsSubscription';
import { useDeliveryActivityStore } from '../src/renderer/stores/deliveryActivityStore';

type TaskStoreLike = {
  getState: () => { workspaceEpoch: number };
  setState: (partial: { workspaceEpoch: number }) => void;
};
const taskStore = () => taskScope.store as TaskStoreLike;

interface ExecutionEventsPayload {
  sessionKey: string;
  events: unknown[];
  workspaceScope?: string | null;
  workspaceRevision?: number;
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let captured: ((payload: ExecutionEventsPayload) => void) | null = null;
let unsubscribeSpy: ReturnType<typeof vi.fn>;

function Host(): null {
  useExecutionEventsSubscription();
  return null;
}

describe('useExecutionEventsSubscription · IPC 在途来源校验', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.clearAllMocks();
    captured = null;
    unsubscribeSpy = vi.fn();
    (window as unknown as { clawwork: unknown }).clawwork = {
      onExecutionEvents: (callback: (payload: ExecutionEventsPayload) => void) => {
        captured = callback;
        return unsubscribeSpy;
      },
    };
    taskStore().setState({ workspaceEpoch: 7 });
    useDeliveryActivityStore.getState().clear(0);
    useDeliveryActivityStore.setState({ owner: { scope: null, revision: -1 } });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('同代现场帧折入投影；换区后在途旧帧与无 scope 帧一律拒收；当前新帧照常收', () => {
    act(() => root.render(<Host />));
    expect(captured).not.toBeNull();

    // 权威 owner：A 代（revision 3）。
    act(() => {
      useDeliveryActivityStore.getState().setOwner({ scope: 'ws-A', revision: 3 }, 0);
    });

    const evtA = { type: 'delivery.started', payload: { operationId: 'op-1' } };
    act(() => {
      captured?.({
        sessionKey: 'sk-1',
        events: [evtA],
        workspaceScope: 'ws-A',
        workspaceRevision: 3,
      });
    });
    expect(messageScope.apply, '同代现场帧 ⇒ 折入一次').toHaveBeenCalledTimes(1);
    expect(messageScope.apply).toHaveBeenLastCalledWith('sk-1', [evtA]);

    // 换区到 B：此刻到达的"A 捕获"在途帧必须被接收侧拒收。
    act(() => {
      useDeliveryActivityStore.getState().setOwner({ scope: 'ws-B', revision: 4 }, 0);
    });
    const staleEvt = { type: 'delivery.settled', payload: { operationId: 'op-1', outcome: 'complete' } };
    act(() => {
      captured?.({
        sessionKey: 'sk-1',
        events: [staleEvt],
        workspaceScope: 'ws-A',
        workspaceRevision: 3,
      });
    });
    expect(messageScope.apply, '换区后在途旧帧 ⇒ 零 apply').toHaveBeenCalledTimes(1);

    // 当前 B 合法帧照常收（不误杀）。
    const evtB = { type: 'delivery.settled', payload: { operationId: 'op-2', outcome: 'complete' } };
    act(() => {
      captured?.({
        sessionKey: 'sk-1',
        events: [evtB],
        workspaceScope: 'ws-B',
        workspaceRevision: 4,
      });
    });
    expect(messageScope.apply, '当前 B 合法帧 ⇒ 收').toHaveBeenCalledTimes(2);
    expect(messageScope.apply).toHaveBeenLastCalledWith('sk-1', [evtB]);

    // 无 scope 字段帧（旧生产者/缺字段）⇒ fail-closed 拒收。
    act(() => {
      captured?.({ sessionKey: 'sk-1', events: [evtA] });
    });
    expect(messageScope.apply, '无 scope 帧 ⇒ 零 apply').toHaveBeenCalledTimes(2);
  });

  it('workspaceEpoch 变更后旧闭包回调拒收（既有归属校验保留），新订阅按当前代收帧', () => {
    act(() => root.render(<Host />));
    const oldCallback = captured;
    expect(oldCallback).not.toBeNull();

    act(() => {
      useDeliveryActivityStore.getState().setOwner({ scope: 'ws-A', revision: 3 }, 0);
    });

    // epoch 变更 ⇒ 旧 effect 清理 + 重建（旧回调已退订，这里仍直接调用以证明其自身也拒收）。
    act(() => {
      taskStore().setState({ workspaceEpoch: 8 });
    });
    const newCallback = captured;
    expect(unsubscribeSpy).toHaveBeenCalled();

    act(() => {
      oldCallback?.({
        sessionKey: 'sk-1',
        events: [{ type: 'delivery.started', payload: { operationId: 'op-3' } }],
        workspaceScope: 'ws-A',
        workspaceRevision: 3,
      });
    });
    expect(messageScope.apply, '旧 epoch 闭包 ⇒ 拒收').not.toHaveBeenCalled();

    act(() => {
      newCallback?.({
        sessionKey: 'sk-1',
        events: [{ type: 'delivery.started', payload: { operationId: 'op-4' } }],
        workspaceScope: 'ws-A',
        workspaceRevision: 3,
      });
    });
    expect(messageScope.apply, '新 epoch 闭包 + 同代帧 ⇒ 收').toHaveBeenCalledTimes(1);
  });
});
