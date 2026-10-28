// @vitest-environment jsdom
//
// BUG-075 独立复审 P2（2026-10-13）：`useTraySync` 第二轮改写**把 tasks/rooms 的
// 订阅弄丢了** —— 消息 selector 返回原始值字符串本身没问题（这是"思考快照不重渲
// 整树"的关键），但它内部**现读** `useTaskStore.getState()` / `useRoomStore.getState()`
// 却不订阅这两个 store：只有房间水合（performer 加入）而没有消息更新时，
// selector 根本不会重算 ⇒ 托盘状态永远不刷新（基线行为：room 水合 → 托盘变 running，
// 复审隔离探针实测「基线 running / HEAD 仍 idle，下一条 message 更新才补偿」）。
//
// 本文件钉两条：
//   1. ★ room-only 水合必须即刻反映到托盘（P2 回归钉子）；
//   2. 思考快照风暴（同 key）不推托盘 —— 保住第二轮优化的观察行为不倒退。

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task, TaskRoom } from '@clawwork/shared';
import { useTraySync } from '../src/renderer/hooks/useTraySync';
import { useMessageStore } from '../src/renderer/stores/messageStore';
import { useRoomStore } from '../src/renderer/stores/roomStore';
import { useTaskStore } from '../src/renderer/stores/taskStore';
import { useUiStore } from '../src/renderer/stores/uiStore';
import i18n from '../src/renderer/i18n';

void i18n;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TASK_SK = 'agent:main:clawwork:dev:task:t1';
const PERFORMER_SK = 'agent:worker:clawwork:dev:task:t1';
const TS = '2026-10-13T08:00:00.000Z';

const updateTrayStatus = vi.fn();

function makeTask(): Task {
  return {
    id: 't1',
    sessionKey: TASK_SK,
    sessionId: 's1',
    title: '做一份 PPT',
    status: 'active',
    createdAt: TS,
    updatedAt: TS,
    tags: [],
    artifactDir: '',
    gatewayId: 'gw1',
  };
}

function makeRoom(): TaskRoom {
  return {
    taskId: 't1',
    conductorSessionKey: TASK_SK,
    conductorReady: true,
    status: 'active',
    performers: [{ sessionKey: PERFORMER_SK, agentId: 'worker', agentName: '制作师', verifiedAt: TS }],
  };
}

const cleanups: Array<() => void> = [];

function renderTrayHook(): { unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  function Probe() {
    useTraySync();
    return null;
  }
  act(() => root.render(<Probe />));
  const unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  cleanups.push(unmount);
  return { unmount };
}

beforeEach(() => {
  updateTrayStatus.mockClear();
  (window as unknown as { clawwork: unknown }).clawwork = { updateTrayStatus };
  useTaskStore.setState({ tasks: [] });
  useRoomStore.setState({ rooms: {} });
  useMessageStore.setState({ activeTurnBySession: {}, processingBySession: new Set() });
  useUiStore.setState({ unreadTaskIds: new Set() });
});

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  delete (window as { clawwork?: unknown }).clawwork;
  vi.restoreAllMocks();
});

describe('useTraySync · room 水合与快照风暴', () => {
  it('★ room-only 水合：performer 加入已在流式输出的会话 ⇒ 托盘即刻变 running（不许等下一次消息更新）', () => {
    useTaskStore.setState({ tasks: [makeTask()] });
    const { unmount } = renderTrayHook();

    // 挂载时任务空闲 ⇒ idle（首次推送，prevRef 从空变为 idle）
    expect(updateTrayStatus).toHaveBeenCalledWith('idle', []);

    // performer 的回合已经在思考流输出（真实形状：网关事件先到，房间随后水合）
    act(() => {
      useMessageStore.getState().appendThinkingDelta(PERFORMER_SK, '正在规划这份 PPT');
    });
    // 任务自身会话无回合、房间未水合 ⇒ 仍 idle，无新推送
    expect(updateTrayStatus).toHaveBeenCalledTimes(1);
    updateTrayStatus.mockClear();

    // **只有** rooms 变化（没有任何消息更新）
    act(() => {
      useRoomStore.setState({ rooms: { t1: makeRoom() } });
    });

    expect(updateTrayStatus).toHaveBeenCalledTimes(1);
    // running 的**唯一来源**是 performer 的会话（任务自身会话没有任何回合）
    // ⇒ 这一条同时证明"room 水合真的改变了派生结果"。payload 里的 sessionKey
    // 不钉死：代码优先挑有 streamingText（正文）的会话，思考流不在其列。
    expect(updateTrayStatus).toHaveBeenCalledWith('running', [expect.objectContaining({ taskId: 't1' })]);
    unmount();
  });

  it('思考快照风暴（同 key）不推托盘：key 不变就不重发（第二轮优化的观察行为不倒退）', () => {
    useTaskStore.setState({ tasks: [makeTask()] });
    act(() => {
      useMessageStore.getState().appendThinkingDelta(TASK_SK, '推理 0');
    });
    renderTrayHook();
    expect(updateTrayStatus).toHaveBeenCalledTimes(1);
    expect(updateTrayStatus).toHaveBeenCalledWith('running', [expect.objectContaining({ taskId: 't1' })]);
    updateTrayStatus.mockClear();

    act(() => {
      for (let i = 1; i <= 30; i++) {
        useMessageStore.getState().appendThinkingDelta(TASK_SK, `推理 ${i}`);
      }
    });

    expect(updateTrayStatus).not.toHaveBeenCalled();
  });

  it('任务集合变化仍然推托盘（key 变了就发一次，不是不发了）', () => {
    renderTrayHook();
    expect(updateTrayStatus).toHaveBeenCalledWith('idle', []);
    updateTrayStatus.mockClear();

    act(() => {
      useTaskStore.setState({ tasks: [makeTask()] });
      useMessageStore.getState().appendThinkingDelta(TASK_SK, '推理');
    });

    expect(updateTrayStatus).toHaveBeenCalledTimes(1);
    expect(updateTrayStatus).toHaveBeenCalledWith('running', [expect.objectContaining({ taskId: 't1' })]);
  });
});
