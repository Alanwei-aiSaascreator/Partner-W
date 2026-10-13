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
import { getTurnRegistration, resetTurnRegistrationForTests } from '../src/renderer/lib/turn-registration';

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
let registrationCaptured: ((payload: RegistrationPayload) => void) | null = null;
let unsubscribeSpy: ReturnType<typeof vi.fn>;

interface RegistrationPayload {
  taskId: string;
  sessionKey: string;
  runId: string;
  status: 'registered' | 'needs-review' | 'none-expected';
  expectedKinds: string[];
  workspaceScope?: string | null;
  workspaceRevision?: number;
}

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
    registrationCaptured = null;
    resetTurnRegistrationForTests();
    unsubscribeSpy = vi.fn();
    (window as unknown as { clawwork: unknown }).clawwork = {
      onExecutionEvents: (callback: (payload: ExecutionEventsPayload) => void) => {
        captured = callback;
        return unsubscribeSpy;
      },
      onTurnRegistration: (callback: (payload: RegistrationPayload) => void) => {
        registrationCaptured = callback;
        return () => {};
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

  it('⭐ 第二轮（R2-4）：权威 owner 就绪前的合法帧有界暂存——就绪后按原 scope 过滤、按序折入、恰一次', () => {
    act(() => root.render(<Host />));
    expect(captured).not.toBeNull();
    expect(useDeliveryActivityStore.getState().ownerReady, '初始未就绪').toBe(false);

    // 快照尚未返回：合法当前代帧（ws-A/3）与到得早的旧代帧（ws-B/9）先后到达。
    const earlyA = { type: 'delivery.settled', payload: { operationId: 'op-early-a', outcome: 'complete' } };
    const earlyB = { type: 'delivery.started', payload: { operationId: 'op-early-b' } };
    act(() => {
      captured?.({ sessionKey: 'sk-1', events: [earlyA], workspaceScope: 'ws-A', workspaceRevision: 3 });
      captured?.({ sessionKey: 'sk-1', events: [earlyB], workspaceScope: 'ws-B', workspaceRevision: 9 });
    });
    expect(messageScope.apply, '未就绪 ⇒ 暂存，零 apply').not.toHaveBeenCalled();

    // 权威 owner 就绪（ws-A/3，与快照同款来源）⇒ flush：只折入匹配帧、按接收序、恰一次。
    act(() => {
      useDeliveryActivityStore.getState().setOwner({ scope: 'ws-A', revision: 3 }, 0);
    });
    expect(messageScope.apply, '就绪后只折入与权威 owner 同代的那条').toHaveBeenCalledTimes(1);
    expect(messageScope.apply).toHaveBeenLastCalledWith('sk-1', [earlyA]);

    // 再触发一次 store 变化：暂存已清空 ⇒ 不重复折入。
    act(() => {
      useDeliveryActivityStore.getState().record(
        {
          operationId: 'act-x',
          workspaceScope: 'ws-A',
          workspaceRevision: 3,
          sequence: 1,
          status: 'active',
          startedAt: 1,
          updatedAt: 1,
        } as never,
        0,
      );
    });
    expect(messageScope.apply, 'flush 恰一次（不得重复折入）').toHaveBeenCalledTimes(1);
  });

  it('⭐ I-1（复审实跑反例）：活动帧 record 填出的相等 owner 不得越过权威屏障 —— started 暂存期 phase/settled 不提前折入，就绪后按序一次折入', () => {
    act(() => root.render(<Host />));
    const started = { type: 'delivery.started', payload: { operationId: 'op-a' } };
    const phase = { type: 'delivery.phase', payload: { operationId: 'op-a', phase: 'validating' } };
    const settled = { type: 'delivery.settled', payload: { operationId: 'op-a', outcome: 'complete' } };
    // 真实生产顺序：execution started → activity begin（record）→ phase/settled。
    act(() => {
      captured?.({ sessionKey: 'sk-1', events: [started], workspaceScope: 'ws-A', workspaceRevision: 3 });
    });
    act(() => {
      useDeliveryActivityStore.getState().record(
        {
          operationId: 'act-a',
          workspaceScope: 'ws-A',
          workspaceRevision: 3,
          sequence: 1,
          status: 'active',
          startedAt: 1,
          updatedAt: 1,
        } as never,
        0,
      );
    });
    // record 把 owner 填成了 ws-A/3（看似匹配），但权威屏障未就绪。
    expect(useDeliveryActivityStore.getState().owner).toEqual({ scope: 'ws-A', revision: 3 });
    expect(useDeliveryActivityStore.getState().ownerReady).toBe(false);
    act(() => {
      captured?.({ sessionKey: 'sk-1', events: [phase], workspaceScope: 'ws-A', workspaceRevision: 3 });
      captured?.({ sessionKey: 'sk-1', events: [settled], workspaceScope: 'ws-A', workspaceRevision: 3 });
    });
    expect(
      messageScope.apply,
      '未经权威屏障 ⇒ 三条全部暂存、零 apply（提前折入会被 reducer 丢弃终态）',
    ).toHaveBeenCalledTimes(0);
    // 权威快照就绪 ⇒ 按到达顺序一次折入。
    act(() => {
      useDeliveryActivityStore.getState().setOwner({ scope: 'ws-A', revision: 3 }, 0);
    });
    expect(messageScope.apply).toHaveBeenCalledTimes(3);
    expect(messageScope.apply.mock.calls.map((call) => (call[1] as Array<{ type: string }>)[0]?.type)).toEqual([
      'delivery.started',
      'delivery.phase',
      'delivery.settled',
    ]);
  });

  it('⭐ 第二轮（R2-4）：快照为空/失败（ownerReady 永不置位）⇒ 暂存不折入（fail-closed），不猜 owner', () => {
    act(() => root.render(<Host />));
    const frame = { type: 'delivery.started', payload: { operationId: 'op-lost' } };
    act(() => {
      captured?.({ sessionKey: 'sk-1', events: [frame], workspaceScope: 'ws-A', workspaceRevision: 3 });
    });
    // 空快照：owner 保持哨兵、ownerReady 不置位 —— 帧不得被折入（也不拿第一帧当权威 owner）。
    expect(messageScope.apply).not.toHaveBeenCalled();
    expect(useDeliveryActivityStore.getState().ownerReady).toBe(false);

    // epoch 切换 ⇒ 旧暂存随 effect 实例销毁；新代帧照常自成新的初始化屏障。
    act(() => {
      taskStore().setState({ workspaceEpoch: 8 });
      useDeliveryActivityStore.getState().clear(8);
    });
    const newCallback = captured;
    act(() => {
      newCallback?.({ sessionKey: 'sk-1', events: [frame], workspaceScope: 'ws-A', workspaceRevision: 3 });
    });
    expect(messageScope.apply, '旧暂存不得跨 epoch 折入').not.toHaveBeenCalled();
    // 新代快照就绪 ⇒ 新暂存帧折入一次。
    act(() => {
      useDeliveryActivityStore.getState().setOwner({ scope: 'ws-A', revision: 3 }, 8);
    });
    expect(messageScope.apply, '新代就绪后折入恰一次').toHaveBeenCalledTimes(1);
  });

  it('⭐ 第二轮（R5 P1）：登记回执同款归属校验——同代收下并落表；无 scope / 不同代 / 未知 status 一律拒', () => {
    act(() => root.render(<Host />));
    expect(registrationCaptured).not.toBeNull();
    act(() => {
      useDeliveryActivityStore.getState().setOwner({ scope: 'ws-A', revision: 3 }, 0);
    });

    // 同代回执 ⇒ 落表。
    act(() => {
      registrationCaptured?.({
        taskId: 't-1',
        sessionKey: 'sk-1',
        runId: 'run-1',
        status: 'registered',
        expectedKinds: ['pptx'],
        workspaceScope: 'ws-A',
        workspaceRevision: 3,
      });
    });
    expect(getTurnRegistration('sk-1', 'run-1')?.status).toBe('registered');

    // 无 scope 回执 ⇒ 拒（fail-closed，不补 owner）。
    act(() => {
      registrationCaptured?.({
        taskId: 't-1',
        sessionKey: 'sk-1',
        runId: 'run-2',
        status: 'registered',
        expectedKinds: [],
      });
    });
    expect(getTurnRegistration('sk-1', 'run-2'), '无 scope 回执不得落表').toBeUndefined();

    // 不同代回执（在途旧帧）⇒ 拒。
    act(() => {
      registrationCaptured?.({
        taskId: 't-1',
        sessionKey: 'sk-1',
        runId: 'run-3',
        status: 'needs-review',
        expectedKinds: [],
        workspaceScope: 'ws-B',
        workspaceRevision: 9,
      });
    });
    expect(getTurnRegistration('sk-1', 'run-3'), '在途旧代回执不得落表').toBeUndefined();

    // 未知 status ⇒ 拒。
    act(() => {
      registrationCaptured?.({
        taskId: 't-1',
        sessionKey: 'sk-1',
        runId: 'run-4',
        status: 'bogus' as never,
        expectedKinds: [],
        workspaceScope: 'ws-A',
        workspaceRevision: 3,
      });
    });
    expect(getTurnRegistration('sk-1', 'run-4')).toBeUndefined();
  });
});
