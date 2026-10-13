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
 *
 * ⭐ 第二轮（R5 P1 / R2-8）新增合同：
 *  - **登记回执是封口的必要组成**：promote 清 activeTurn 时登记可能仍在主进程路上
 *    ⇒ 无回执（unknown）一律不发；registered/none-expected/needs-review 各档行为；
 *  - **恢复静默一次消费**：hydrate 只抑制"历史应用直接产生的那次状态变化"并把定格
 *    终态按已通知入册；运行中 run 打开历史后，真实 live 完成仍通知一次；历史已
 *    complete 后重复 live 终态不重报（不做永久 run 黑名单）。
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
  historicalSettledNotificationKind,
  isRunSealed,
  settlementNotificationForStatus,
  shouldNotifyDeliverySettlement,
  useDeliverySettlementNotification,
} from '../src/renderer/lib/delivery-settlement-notification';
import { markRunHydrated, resetHydrationRegistryForTests } from '../src/renderer/lib/execution-hydration-registry';
import { noteTurnRegistration, resetTurnRegistrationForTests } from '../src/renderer/lib/turn-registration';

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

/** 落一条登记回执（main 广播的等价落表；版本号会驱动 hook 重评估）。 */
function register(runId: string, status: 'registered' | 'needs-review' | 'none-expected' = 'registered'): void {
  act(() => {
    noteTurnRegistration({ taskId: 'task-1', sessionKey: session, runId, status, expectedKinds: [] });
  });
}

beforeEach(() => {
  getSettings.mockClear();
  sendNotification.mockClear();
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  resetHydrationRegistryForTests();
  resetTurnRegistrationForTests();
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
    register('run-1');
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
    register('run-1');
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
    register('run-1');
    setRuntime({ modelPhase: 'ended', turnOpen: false, operations: { 'gw|op-1': { outcome } } });
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('⭐ 第二轮（R5 P1）：promote 已清轮次但登记回执未到（unknown）⇒ 一律不发（空 ops 不推普通聊天）', async () => {
    // 现场目击 → 封口：模型 ended + activeTurn 空 + ops 空 + **无回执** —— 旧实现此处误发"完成"。
    setRuntime({ turnOpen: true, operations: {} });
    await flush();
    setRuntime({ modelPhase: 'ended', turnOpen: false, operations: {} });
    await flush();
    expect(sendNotification, '无登记回执 ⇒ 不得判 complete（真跑探针反例的修复点）').not.toHaveBeenCalled();

    // 回执到达（普通聊天 = 确认零需求）⇒ 才允许完成通知。
    register('run-1', 'none-expected');
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('⭐ 第二轮：registered 而 ops 未到 ⇒ 不发；ops 到达并结算 ⇒ 发；needs-review ⇒ 不发', async () => {
    setRuntime({ turnOpen: true, operations: {} });
    await flush();
    register('run-1', 'registered');
    setRuntime({ modelPhase: 'ended', turnOpen: false, operations: {} });
    await flush();
    expect(sendNotification, 'registered 而 ops 未到 = 等登记证据').not.toHaveBeenCalled();

    setRuntime({ modelPhase: 'ended', turnOpen: false, operations: { 'gw|op-1': { outcome: 'complete' } } });
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1);

    // 另一 run：needs-review（已知文件需求登记失败/未确认）⇒ 需求保留，不发完成。
    sendNotification.mockClear();
    setRuntime({ runId: 'run-2', turnOpen: true, operations: {} });
    await flush();
    register('run-2', 'needs-review');
    setRuntime({ runId: 'run-2', modelPhase: 'ended', turnOpen: false, operations: {} });
    await flush();
    expect(sendNotification, 'needs-review ⇒ 未确认，不发').not.toHaveBeenCalled();
  });

  it('⭐ 旁路一/二：封口时需求未结算 ⇒ 不发；封口之后结算才发（登记窗口关了才算）', async () => {
    // 未封口：模型还在跑（operation 已登记但没结算）——即便 outcome 已经 complete 也不发。
    setRuntime({ modelPhase: 'active', turnOpen: true, operations: { 'gw|op-1': { outcome: 'complete' } } });
    await flush();
    expect(sendNotification, '模型未结束 ⇒ 不发（登记窗口未关）').not.toHaveBeenCalled();
    register('run-1');
    // 封口：模型结束 + 轮次关闭，但结算还没到 ⇒ 仍不发。
    setRuntime({ modelPhase: 'ended', turnOpen: false, operations: { 'gw|op-1': {} } });
    await flush();
    expect(sendNotification, '结算未到 ⇒ 不发（不提前说完成）').not.toHaveBeenCalled();
    // 结算到达 ⇒ 现场转变 ⇒ 发。
    setRuntime({ modelPhase: 'ended', turnOpen: false, operations: { 'gw|op-1': { outcome: 'complete' } } });
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it('普通聊天（确认零需求）：封口 + 模型 ended ⇒ 由本口发「任务完成」；模型 failed ⇒ 不发', async () => {
    setRuntime({ turnOpen: true, operations: {} });
    await flush();
    register('run-1', 'none-expected');
    setRuntime({ modelPhase: 'ended', turnOpen: false, operations: {} });
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'notifications.taskComplete', taskId: 'task-1' }),
    );

    sendNotification.mockClear();
    setRuntime({ runId: 'run-2', turnOpen: true, operations: {} });
    await flush();
    register('run-2', 'none-expected');
    setRuntime({ runId: 'run-2', modelPhase: 'failed', turnOpen: false, operations: {} });
    await flush();
    expect(sendNotification, '失败轮不得发"任务完成"').not.toHaveBeenCalled();
  });

  it('⭐ 旁路三：挂载即封口（历史注入）⇒ 静默；hydrate 标记 ⇒ 静默且定格终态入册', async () => {
    // 历史注入：hook 只知道这条 run 已封口（从未在未封口状态出现过）。
    setRuntime({
      runId: 'old-1',
      modelPhase: 'ended',
      turnOpen: false,
      operations: { 'gw|op-1': { outcome: 'complete' } },
    });
    await flush();
    expect(sendNotification, '历史注入（挂载即封口）⇒ 不发').not.toHaveBeenCalled();

    // 现场目击过、但被标记为 hydrate（本地恢复应用）⇒ 静默；随后重复 live 终态不重报。
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
    // 重复 live 终态（幂等重放）⇒ 定格终态已在恢复时入册 ⇒ 不重报。
    setRuntime({
      runId: 'run-3',
      modelPhase: 'ended',
      turnOpen: false,
      operations: { 'gw|op-1': { outcome: 'complete' } },
    });
    await flush();
    expect(sendNotification, '历史已 complete 后重复 live 终态不重报').not.toHaveBeenCalled();
  });

  it('⭐ 第二轮（R2-8）：运行中 run 打开历史（hydrate 中间态）后，真实 live 完成仍通知一次（非永久黑名单）', async () => {
    // 现场目击运行中的 run-4（未封口）。
    setRuntime({ runId: 'run-4', modelPhase: 'active', turnOpen: true, operations: { 'gw|op-1': {} } });
    await flush();
    // 打开历史：恢复应用（中间态：模型还在跑）——一次性消费，不入册（未定格）。
    markRunHydrated(session, 'run-4');
    setRuntime({ runId: 'run-4', modelPhase: 'active', turnOpen: true, operations: { 'gw|op-1': {} } });
    await flush();
    expect(sendNotification, '恢复应用本身不得发现场通知').not.toHaveBeenCalled();
    // 后续真实 live 完成：登记回执 + 结算到达 ⇒ 必须仍能通知一次。
    register('run-4');
    setRuntime({
      runId: 'run-4',
      modelPhase: 'ended',
      turnOpen: false,
      operations: { 'gw|op-1': { outcome: 'complete' } },
    });
    await flush();
    expect(sendNotification, 'live 完成仍按资格通知一次（永久 run 黑名单是缺陷）').toHaveBeenCalledTimes(1);
  });

  it('聚焦且正在看这个任务 ⇒ 不打扰（封口完成也不发）', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useTaskStore.setState({ activeTaskId: 'task-1' } as never);
    setRuntime({ turnOpen: true, operations: {} });
    await flush();
    register('run-1', 'none-expected');
    setRuntime({ modelPhase: 'ended', turnOpen: false, operations: {} });
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('设置里关掉"任务完成"通知 ⇒ 不发', async () => {
    getSettings.mockResolvedValueOnce({ notifications: { taskComplete: false } });
    setRuntime({ turnOpen: true, operations: {} });
    await flush();
    register('run-1', 'none-expected');
    setRuntime({ modelPhase: 'ended', turnOpen: false, operations: {} });
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('幂等：同 run 同资格一次；partial→complete 升级补发一次；新一轮 runId 重新计', async () => {
    setRuntime({ turnOpen: true, operations: { 'gw|op-1': {}, 'gw|op-2': {} } });
    await flush();
    register('run-1');
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
    register('run-9', 'none-expected');
    setRuntime({ runId: 'run-9', modelPhase: 'ended', turnOpen: false, operations: {} });
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(3);
  });

  it('纯判定：status 分档 / 封口判据 / 通知条件 / 历史定格分档的负例', () => {
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

    // 历史定格分档（恢复静默入册）：只看投影本身，不依赖登记回执。
    const projection = {
      runId: 'h-1',
      modelPhase: 'ended',
      steps: {},
      approvals: {},
      stop: { state: 'none', lastObservedAt: -1 },
      delivery: { phase: 'settled', operations: { 'gw|op-1': { outcome: 'complete' } } },
      lastSeq: 1,
    } as never;
    expect(historicalSettledNotificationKind({ projection, sealed: true })).toBe('complete');
    expect(historicalSettledNotificationKind({ projection, sealed: false })).toBeNull(); // 未封口不是定格终态
    const unsettled = {
      ...(projection as Record<string, unknown>),
      delivery: { phase: 'pending', operations: { 'gw|op-1': {} } },
    } as never;
    expect(historicalSettledNotificationKind({ projection: unsettled, sealed: true })).toBeNull(); // 未结算不是定格
    const failed = { ...(projection as Record<string, unknown>), modelPhase: 'failed' } as never;
    expect(historicalSettledNotificationKind({ projection: failed, sealed: true })).toBeNull();
    const emptySettled = {
      ...(projection as Record<string, unknown>),
      delivery: { phase: 'settled', operations: {} },
    } as never;
    expect(
      historicalSettledNotificationKind({ projection: emptySettled, sealed: true }),
      '无 ops + ended = 历史普通聊天',
    ).toBe('complete');
  });
});
