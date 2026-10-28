import { create } from 'zustand';

/**
 * BYOK 端点名的 renderer 侧缓存（2026-10-28 多端点）。
 *
 * 端点「友好名」（如「公司中转站」）存在主进程 config 里；模型目录里的模型只有
 * `provider`（= 端点 id，如 `byok` / `byok-company`），没有友好名。运行时模型选择器
 * 要「先选端点再选模型」，需要把 provider 映射回友好名 —— 这里缓存一份 id → name。
 *
 * 由 App 启动时 `refreshByokEndpoints()` 拉一次；配置变更后也可再刷。
 */

export interface ByokEndpointInfo {
  id: string;
  name: string;
}

interface ByokStoreState {
  endpoints: ByokEndpointInfo[];
  setEndpoints: (endpoints: ByokEndpointInfo[]) => void;
}

export const useByokStore = create<ByokStoreState>((set) => ({
  endpoints: [],
  setEndpoints: (endpoints) => set({ endpoints }),
}));

/** provider id → 端点友好名；未加载 / 未找到返回 undefined（调用方回退用 provider 显示）。 */
export function byokEndpointName(provider: string): string | undefined {
  return useByokStore.getState().endpoints.find((e) => e.id === provider)?.name;
}

/** 拉一次端点列表写进 store。失败静默（选择器回退用 provider id 显示，不致命）。 */
export async function refreshByokEndpoints(): Promise<void> {
  try {
    const res = await window.clawwork.modelApiGet();
    if (res.ok && res.result) {
      useByokStore.getState().setEndpoints(res.result.endpoints.map((e) => ({ id: e.id, name: e.name })));
    }
  } catch {
    // 读取失败不致命。
  }
}
