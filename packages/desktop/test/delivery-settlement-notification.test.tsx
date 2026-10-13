// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ⭐ R5（2026-10-14 五小时窗）：**统一完成资格的消费口** —— 通知只由封口后的
 * `evaluateRunCompletion` 判定驱动。红例口径（复审旁路一/二/三）：
 *  - 封口后全部结算 complete ⇒ 发「任务完成」；partial ⇒ 发「部分完成」；
 *  - failed / unconfirmed / 未结算 ⇒ **不发**（旁路一：settled-but-failed 不得说完成）；
 *  - 需求未封口（模型未结束/轮次未关）时结算了也不发（旁路二：登记窗口未关）；
 *  - 挂载即封口（历史注入）或经 hydrate 标记的 run ⇒ 不发（旁路三：恢复静默）；
 *  - 幂等：同 run 同资格一次；partial→complete 升级补发一次；
 *  - 与 maybeNotify 同条件：聚焦且正在看这个任务时不打扰；设置里关掉就不发。
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('../src/renderer/stores/messageStore', async () => {
  const { create } = await import('zustand');
  return { useMessageStore: create(() => ({ executionBySession: {}, activeTurnBySession: {} })) };
});
vi.mock('../src/renderer/stores/taskStore', async () => {
  const { create } = await import('zustand');
  return { useTaskStore: create(() => ({ tasks: [], activeTaskId: null as string | null })) };
});

import { useMessageStore } from '../src/renderer/stores/messageStore';
import { useTaskStore } from '../src/renderer/stores/taskStore';
import {
  isRunSealed,
  settlementNotificationForStatus,
  shouldNotifyDeliverySettlement,
  useDeliverySettlementNotification,
} from '../src/renderer/lib/delivery-settlement-notification';
import { markRunHydrated, resetHydrationRegistryForTests } from '../src/renderer/lib/execution-hydration-registry';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const session = 'agent:main:clawwork:task:task-1';
const getSettings = vi.fn(async () => ({ notifications: { taskComplete: true } }));
const sendNotification = vi.fn(async () => ({ ok: true }));

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function Harness(): ReactElement | null {
  useDeliverySettlementNotification();
  return null;
}

/** 装一条执行投影 + 轮次开关（模块级 store：用例间由 beforeEach 复位）。 */
function setRuntime(input: {
  runId?: string;
  modelPhase?: 'active' | 'ended' | 'failed';
  turnOpen?: boolean;
  operations?: Record<string, { outcome?: 'complete' | 'partial' | 'failed' | 'unconfirmed' }>;
}): void {
  act(() => {
    useMessageStore.setState({
      executionBySession: {
        [session]: {
          runId: input.runId ?? 'run-1',
          modelPhase: input.modelPhase ?? 'active',
          steps: {},
          approvals: {},
          stop: { state: 'none', lastObservedAt: -1 },
          delivery: { phase: 'pending', operations: input.operations ?? {} },
          lastSeq: 3,
        },
      },
      activeTurnBySession: input.turnOpen === false ? {} : { [session]: { runId: input.runId ?? 'run-1' } },
    } as never);
  });
}

beforeEach(() => {
  getSettings.mockClear();
  sendNotification.mockClear();
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  resetHydrationRegistryForTests();
  useMessageStore.setState({ executionBySession: {}, activeTurnBySession: {} } as never);
  useTaskStore.setState({ tasks: [{ id: 'task-1', title: '季度汇报' }], activeTaskId: 'task-2' } as never);
  (window as unknown as { clawwork: unknown }).clawwork = { getSettings, sendNotification };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<Harness />));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('统一完成资格通知（封口后判定）', () => {
  it('现场目击 → 封口 → 全部结算 complete ⇒ 发「任务完成」', async () => {
    setRuntime({ turnOpen: true, operations: { 'gw|op-1': {} } }); // 未封口目击（witnessed）
    await flush();
    setRuntime({ modelPhase: 'ended', turnOpen: false, operations: { 'gw|op-1': { outcome: 'complete' } } });
    await flush();
    expect(sendNotification).toHaveBeenCalledWith({
      title: 'notifications.taskComplete',
      body: '季度汇报',
      taskId: 'task-1',
    });
  });

  it('多项需求一成一败 ⇒ 发「部分完成」（不把一成一败说成完成）', async () => {
    setRuntime({ turnOpen: true, operations: { 'gw|op-1': {}, 'gw|op-2': {} } });
    await flush();
    setRuntime({
      modelPhase: 'ended',
      turnOpen: false,
      operations: { 'gw|op-1': { outcome: 'complete' }, 'gw|op-2': { outcome: 'failed' } },
    });
    await flush();
    expect(sendNotification).toHaveBeenCalledWith({
      title: 'notifications.taskPartiallyComplete',
      body: '季度汇报',
      taskId: 'task-1',
    });
  });

  it.each(['failed', 'unconfirmed'] as const)('封口后仅 %s ⇒ 不发"任务完成"', async (outcome) => {
    setRuntime({ turnOpen: true, operations: { 'gw|op-1': {} } });
    await flush();
    setRuntime({ modelPhase: 'ended', turnOpen: false, operations: { 'gw|op-1': { outcome } } });
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('⭐ 旁路一/二：封口时需求未结算 ⇒ 不发；封口之后结算才发（登记窗口关了才算）', async () => {
    // 未封口：模型还在跑（operation 已登记但没结算）——即便 outcome 已经 complete 也不发。
    setRuntime({ modelPhase: 'active', turnOpen: true, operations: { 'gw|op-1': { outcome: 'complete' } } });
    await flush();
    expect(sendNotification, '模型未结束 ⇒ 不发（登记窗口未关）').not.toHaveBeenCalled();
    // 封口：模型结束 + 轮次关闭，但结算还没到 ⇒ 仍不发。
    setRuntime({ modelPhase: 'ended', turnOpen: false, operations: { 'gw|op-1': {} } });
    await flush();
    expect(sendNotification, '结算未到 ⇒ 不发（不提前说完成）').not.toHaveBeenCalled();
    // 结算到达 ⇒ 现场转变 ⇒ 发。
    setRuntime({ modelPhase: 'ended', turnOpen: false, operations: { 'gw|op-1': { outcome: 'complete' } } });
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('普通聊天（无需求）：封口 + 模型 ended ⇒ 由本口发「任务完成」；模型 failed ⇒ 不发', async () => {
    setRuntime({ turnOpen: true, operations: {} });
    await flush();
    setRuntime({ modelPhase: 'ended', turnOpen: false, operations: {} });
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'notifications.taskComplete', taskId: 'task-1' }),
    );

    sendNotification.mockClear();
    setRuntime({ runId: 'run-2', turnOpen: true, operations: {} });
    await flush();
    setRuntime({ runId: 'run-2', modelPhase: 'failed', turnOpen: false, operations: {} });
    await flush();
    expect(sendNotification, '失败轮不得发"任务完成"').not.toHaveBeenCalled();
  });

  it('⭐ 旁路三：挂载即封口（历史注入）⇒ 静默；hydrate 标记 ⇒ 静默', async () => {
    // 历史注入：hook 只知道这条 run 已封口（从未在未封口状态出现过）。
    setRuntime({
      runId: 'old-1',
      modelPhase: 'ended',
      turnOpen: false,
      operations: { 'gw|op-1': { outcome: 'complete' } },
    });
    await flush();
    expect(sendNotification, '历史注入（挂载即封口）⇒ 不发').not.toHaveBeenCalled();

    // 现场目击过、但被标记为 hydrate（本地恢复应用）⇒ 也静默。
    setRuntime({ runId: 'run-3', turnOpen: true, operations: { 'gw|op-1': {} } });
    await flush();
    markRunHydrated(session, 'run-3');
    setRuntime({
      runId: 'run-3',
      modelPhase: 'ended',
      turnOpen: false,
      operations: { 'gw|op-1': { outcome: 'complete' } },
    });
    await flush();
    expect(sendNotification, 'hydrate 标记 ⇒ 不发').not.toHaveBeenCalled();
  });

  it('聚焦且正在看这个任务 ⇒ 不打扰（封口完成也不发）', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useTaskStore.setState({ activeTaskId: 'task-1' } as never);
    setRuntime({ turnOpen: true, operations: {} });
    await flush();
    setRuntime({ modelPhase: 'ended', turnOpen: false, operations: {} });
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('设置里关掉"任务完成"通知 ⇒ 不发', async () => {
    getSettings.mockResolvedValueOnce({ notifications: { taskComplete: false } });
    setRuntime({ turnOpen: true, operations: {} });
    await flush();
    setRuntime({ modelPhase: 'ended', turnOpen: false, operations: {} });
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('幂等：同 run 同资格一次；partial→complete 升级补发一次；新一轮 runId 重新计', async () => {
    setRuntime({ turnOpen: true, operations: { 'gw|op-1': {}, 'gw|op-2': {} } });
    await flush();
    setRuntime({
      modelPhase: 'ended',
      turnOpen: false,
      operations: { 'gw|op-1': { outcome: 'complete' }, 'gw|op-2': { outcome: 'failed' } },
    });
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1); // partial 一条

    // 重复同一投影 ⇒ 不重发。
    setRuntime({
      modelPhase: 'ended',
      turnOpen: false,
      operations: { 'gw|op-1': { outcome: 'complete' }, 'gw|op-2': { outcome: 'failed' } },
    });
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1);

    // 真实升级（另一项后来也完成）⇒ 新资格键补发一条。
    setRuntime({
      modelPhase: 'ended',
      turnOpen: false,
      operations: { 'gw|op-1': { outcome: 'complete' }, 'gw|op-2': { outcome: 'complete' } },
    });
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(sendNotification).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'notifications.taskComplete' }));

    // 新一轮 runId 重新计。
    setRuntime({ runId: 'run-9', turnOpen: true, operations: {} });
    await flush();
    setRuntime({ runId: 'run-9', modelPhase: 'ended', turnOpen: false, operations: {} });
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(3);
  });

  it('纯判定：status 分档 / 封口判据 / 通知条件的负例', () => {
    expect(settlementNotificationForStatus('complete')).toBe('complete');
    expect(settlementNotificationForStatus('partial')).toBe('partial');
    expect(settlementNotificationForStatus('failed')).toBeNull();
    expect(settlementNotificationForStatus('unconfirmed')).toBeNull();
    expect(settlementNotificationForStatus('not-complete')).toBeNull();
    expect(settlementNotificationForStatus(undefined)).toBeNull();
    expect(isRunSealed({ modelPhase: 'active', turnOpen: false })).toBe(false);
    expect(isRunSealed({ modelPhase: 'ended', turnOpen: true })).toBe(false);
    expect(isRunSealed({ modelPhase: 'ended', turnOpen: false })).toBe(true);
    expect(isRunSealed({ modelPhase: 'failed', turnOpen: false })).toBe(true);
    expect(shouldNotifyDeliverySettlement({ focused: true, activeTaskId: 'task-1', taskId: 'task-1' })).toBe(false);
    expect(shouldNotifyDeliverySettlement({ focused: true, activeTaskId: 'other', taskId: 'task-1' })).toBe(true);
    expect(shouldNotifyDeliverySettlement({ focused: false, activeTaskId: 'task-1', taskId: 'task-1' })).toBe(true);
  });
});
