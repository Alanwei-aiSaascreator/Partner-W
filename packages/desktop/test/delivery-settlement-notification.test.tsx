// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ⭐ V3-artifact：延后的"任务完成"通知（交付结算路径）。红例口径：
 *  - complete ⇒ 发「任务完成」；partial ⇒ 发「部分完成」；
 *  - failed / unconfirmed ⇒ **不发**（不冒充完成）；
 *  - 与 maybeNotify 同条件：聚焦且正在看这个任务时不打扰；设置里关掉就不发；
 *  - 一次结算只发一次（重复渲染不重发）。
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('../src/renderer/stores/messageStore', async () => {
  const { create } = await import('zustand');
  return { useMessageStore: create(() => ({ executionBySession: {} })) };
});
vi.mock('../src/renderer/stores/taskStore', async () => {
  const { create } = await import('zustand');
  return { useTaskStore: create(() => ({ tasks: [], activeTaskId: null as string | null })) };
});

import { useMessageStore } from '../src/renderer/stores/messageStore';
import { useTaskStore } from '../src/renderer/stores/taskStore';
import {
  settlementNotificationFor,
  shouldNotifyDeliverySettlement,
  useDeliverySettlementNotification,
} from '../src/renderer/lib/delivery-settlement-notification';

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

function settleDelivery(outcome: 'complete' | 'partial' | 'failed' | 'unconfirmed', runId = 'run-1'): void {
  act(() => {
    useMessageStore.setState({
      executionBySession: {
        [session]: {
          runId,
          modelPhase: 'ended',
          steps: {},
          approvals: {},
          stop: { state: 'none', lastObservedAt: -1 },
          delivery: {
            phase: 'settled',
            outcome,
            operations: {},
          },
          lastSeq: 3,
        },
      },
    } as never);
  });
}

beforeEach(() => {
  getSettings.mockClear();
  sendNotification.mockClear();
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  useMessageStore.setState({ executionBySession: {} } as never); // 模块级 store：用例间必须复位
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

describe('交付结算通知（complete / partial 分档）', () => {
  it('settled + complete ⇒ 发「任务完成」', async () => {
    settleDelivery('complete');
    await flush();
    expect(sendNotification).toHaveBeenCalledWith({
      title: 'notifications.taskComplete',
      body: '季度汇报',
      taskId: 'task-1',
    });
  });

  it('settled + partial ⇒ 发「部分完成」（不把一成一败说成完成）', async () => {
    settleDelivery('partial');
    await flush();
    expect(sendNotification).toHaveBeenCalledWith({
      title: 'notifications.taskPartiallyComplete',
      body: '季度汇报',
      taskId: 'task-1',
    });
  });

  it.each(['failed', 'unconfirmed'] as const)('settled + %s ⇒ 不发"任务完成"', async (outcome) => {
    settleDelivery(outcome);
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('聚焦且正在看这个任务 ⇒ 不打扰（投影变化也不发）', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useTaskStore.setState({ activeTaskId: 'task-1' } as never);
    settleDelivery('complete');
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('设置里关掉"任务完成"通知 ⇒ 不发', async () => {
    getSettings.mockResolvedValueOnce({ notifications: { taskComplete: false } });
    settleDelivery('complete');
    await flush();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('一次结算只发一次（重复投影不重发；新一轮 runId 重新计）', async () => {
    settleDelivery('complete', 'run-1');
    await flush();
    settleDelivery('complete', 'run-1');
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(1);
    settleDelivery('complete', 'run-2');
    await flush();
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it('纯判定：outcome 分档与会话键解析的负例', () => {
    expect(settlementNotificationFor('complete')).toBe('complete');
    expect(settlementNotificationFor('partial')).toBe('partial');
    expect(settlementNotificationFor('failed')).toBeNull();
    expect(settlementNotificationFor(undefined)).toBeNull();
    expect(shouldNotifyDeliverySettlement({ focused: true, activeTaskId: 'task-1', taskId: 'task-1' })).toBe(false);
    expect(shouldNotifyDeliverySettlement({ focused: true, activeTaskId: 'other', taskId: 'task-1' })).toBe(true);
    expect(shouldNotifyDeliverySettlement({ focused: false, activeTaskId: 'task-1', taskId: 'task-1' })).toBe(true);
  });
});
