import { createSessionSync } from '@clawwork/core';
import { compareStore } from '../features/compare/compare-store-instance';
import { ports, useTaskStore, useMessageStore } from '../platform';

const sync = createSessionSync({
  persistence: ports.persistence,
  gateway: ports.gateway,
  getTaskStore: () => useTaskStore.getState(),
  getMessageStore: () => ({
    ...useMessageStore.getState(),
    setState: useMessageStore.setState,
  }),
  // 对比的临时列**不进对话历史**：它们各自是一条会话，但用户还没"采纳"哪一条。
  // 这里必须和 dispatcher 一样动态判（采纳后赢家会转正，缓存就错了）。
  isEphemeralSession: (sessionKey) => compareStore().getState().isEphemeral(sessionKey),
});

export const { hydrateFromLocal, syncSessionMessages, syncFromGateway, retrySyncPending, resetHydration, syncRun } =
  sync;
