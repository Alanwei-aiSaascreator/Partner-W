import { useEffect, useRef } from 'react';
import { useTaskStore } from '../stores/taskStore';
import { useMessageStore } from '../stores/messageStore';
import { useUiStore } from '../stores/uiStore';
import { useRoomStore } from '../stores/roomStore';
import { deriveSessionActivity, getTaskSessionKeys } from '@clawwork/core';
import i18n from '../i18n';

function formatDuration(updatedAt: string): string {
  const ms = Date.now() - new Date(updatedAt).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return i18n.t('common.justNow');
  if (min === 1) return i18n.t('common.minAgo', { count: 1 });
  return i18n.t('common.minAgo', { count: min });
}

/**
 * ⭐ BUG-075 第二轮（2026-10-13）：**消息侧只订阅派生出的原始值，绝不再整表订阅**。
 *
 * 血案：原来这里 `useMessageStore((s) => s.activeTurnBySession)` 整表订阅 —— 而思考流
 * **每个快照都换 `activeTurnBySession` 的引用**。本 hook 挂在 **`App`** 上 ⇒ 每个快照
 * **整个应用树（左栏/输入框/右栏全线）重渲一遍**，是"越跑越卡"的最大单一放大器。
 *
 * 订阅面 = `runningTaskIdsKey`（运行中任务 id 的**字符串**，思考流期间恒定）+
 * 未读数 + `tasks`/`rooms` 整表（**低频**：任务/房间只在真实状态变化时换引用，
 * 与每快照必换的消息表不是一回事）。
 *
 * ⚠️ 2026-10-13 独立复审 P2：第一版改写只订阅了消息侧，selector 里 `getState()`
 *    现读 `tasks`/`rooms` 却**没有订阅它们** —— 房间水合（performer 加入正在流的会话）
 *    这类**不伴随消息更新**的变化永远不触发重算，托盘停在 idle（复审隔离复现）。
 *    ⇒ `tasks`/`rooms` 必须是真订阅，selector 从闭包读它们；消息活动仍走原始值。
 *
 * 观察行为不变：托盘只在"运行状态 / 运行中任务集合"变化时收到一次 `updateTrayStatus`
 *（原实现同样有 `prevRef` 去重，per-tick 的执行被去重挡在门外，只是重渲已经发生了）。
 */
export function useTraySync(): void {
  const tasks = useTaskStore((s) => s.tasks);
  const rooms = useRoomStore((s) => s.rooms);
  const runningTaskIdsKey = useMessageStore((s) =>
    tasks
      .filter(
        (task) =>
          deriveSessionActivity(
            getTaskSessionKeys(task, rooms[task.id]),
            s.activeTurnBySession,
            s.processingBySession,
          ) !== 'idle',
      )
      .map((task) => task.id)
      .join(','),
  );
  const unreadCount = useUiStore((s) => s.unreadTaskIds.size);

  const prevRef = useRef<{ status: string; taskIds: string }>({ status: '', taskIds: '' });

  useEffect(() => {
    const tasks = useTaskStore.getState().tasks;
    const rooms = useRoomStore.getState().rooms;
    const activeTurnBySession = useMessageStore.getState().activeTurnBySession;

    const activeIds = runningTaskIdsKey ? runningTaskIdsKey.split(',') : [];
    const isRunning = activeIds.length > 0;

    let status: 'idle' | 'running' | 'unread';
    if (isRunning) status = 'running';
    else if (unreadCount > 0) status = 'unread';
    else status = 'idle';

    const taskIdsKey = runningTaskIdsKey;

    if (prevRef.current.status === status && prevRef.current.taskIds === taskIdsKey) return;
    prevRef.current = { status, taskIds: taskIdsKey };

    const activeTasks = activeIds.map((id) => {
      const task = tasks.find((t) => t.id === id)!;
      const sessionKeys = getTaskSessionKeys(task, rooms[task.id]);
      const snippetSessionKey = sessionKeys.find((sessionKey) => activeTurnBySession[sessionKey]?.streamingText);
      return {
        taskId: id,
        title: task.title || i18n.t('common.noTitle'),
        snippet: ((snippetSessionKey ? activeTurnBySession[snippetSessionKey]?.streamingText : '') ?? '').slice(0, 60),
        duration: formatDuration(task.updatedAt),
        gatewayId: task.gatewayId,
        sessionKey: snippetSessionKey ?? sessionKeys[0],
      };
    });

    window.clawwork.updateTrayStatus(status, activeTasks);
  }, [runningTaskIdsKey, unreadCount]);
}
