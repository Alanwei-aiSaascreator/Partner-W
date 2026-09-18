/**
 * 对比 store 的**单例**与 React 绑定。
 *
 * ⚠️ 依赖是**惰性**取的：模块导入阶段绝不碰 `window.clawwork`。
 *    渲染层测试普遍只 mock `@/platform`，如果这里在 import 时就解引用
 *    `window.clawwork.createSession`，任何 import 了这个模块的测试都会在建模块时就炸。
 *    （同样的理由：`useCompareStore` 只订阅状态，不触发任何网关调用。）
 */
import { useStore } from 'zustand';
import { toast } from '@/lib/toast';
import i18n from '@/i18n';
import { messageStore, taskStore } from '@/platform';
import { createCompareStore, type CompareState, type CompareStore } from './compare-store';

let instance: CompareStore | null = null;

/** 全局唯一的对比 store（主进程之外只有这一条编排线）。 */
export function compareStore(): CompareStore {
  if (instance) return instance;
  instance = createCompareStore({
    createSession: (gatewayId, params) => window.clawwork.createSession(gatewayId, params),
    patchSession: (gatewayId, sessionKey, patch) => window.clawwork.patchSession(gatewayId, sessionKey, patch),
    sendMessage: (gatewayId, sessionKey, content, attachments) =>
      window.clawwork.sendMessage(gatewayId, sessionKey, content, attachments as never),
    abortChat: (gatewayId, sessionKey) => window.clawwork.abortChat(gatewayId, sessionKey),
    deleteSession: (gatewayId, sessionKey) => window.clawwork.deleteSession(gatewayId, sessionKey),
    chatHistory: (gatewayId, sessionKey) => window.clawwork.chatHistory(gatewayId, sessionKey),
    getMessageStore: () => messageStore.getState(),
    getTaskStore: () => taskStore.getState(),
    translate: (key, opts) => i18n.t(key, opts),
    onToast: (type, title, opts) => {
      if (type === 'error') toast.error(title, { description: opts?.description });
      else if (type === 'warning') toast.warning(title, { description: opts?.description });
      else toast.success(title, { description: opts?.description });
    },
  });
  return instance;
}

export function useCompareStore(): CompareState;
export function useCompareStore<T>(selector: (state: CompareState) => T): T;
export function useCompareStore<T>(selector?: (state: CompareState) => T) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return useStore(compareStore(), selector as any);
}
