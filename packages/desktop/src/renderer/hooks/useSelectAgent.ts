import { useCallback } from 'react';
import { useTaskStore } from '@/stores/taskStore';
import { useUiStore } from '@/stores/uiStore';
import { useGatewaySelector } from '@/hooks/useGatewaySelector';
import { resolvePendingAfterAgentSwitch } from '@/lib/agent-switch';

/**
 * **全应用唯一切换助手的动作**（2026-09-19 从 `LeftNav` 里抽出来）。
 *
 * 为什么抽：`LeftNav`（「我的助手」切换器）和「身份中心」（应用推荐角色）都要切助手。
 * 两边各写一遍必然漂移 —— 最典型的漂移是**漏掉 `setPending`**：用户新任务打到一半
 * 点了应用，pending 里还留着**上一个助手**的 gatewayId/agentId（和它的任务预设标签），
 * 于是下一次发送发给了错的助手、还带着错的预设。
 *
 * 所以这里的四步是一个整体，别拆着用：
 * 1. `setSelectedAgent` —— 记下选择（落盘）
 * 2. `setPending` —— 把待发任务改挂到新助手（整理规则见 `lib/agent-switch.ts`）
 * 3. `setActiveTask(null)` —— 离开旧会话
 * 4. `setMainView('chat')` —— 走到用户能看见效果的地方
 *
 * ⚠️ 这里**自己**调了一次 `useGatewaySelector`（`LeftNav` 里也调过一次，等于同组件树里两份）。
 *    可以接受：它拉的那次助手目录是**带缓存的**（`fetchAgentsForGateway` 在目录已存在时直接
 *    返回，见 `core/services/gateway-dispatcher.ts`），而且两处拿到的是同一个 `selectedGwId`。
 *    换成"从外面传 gatewayId 进来"能省这一份，但那样两个调用方又要各自决定用哪个网关 ——
 *    正是这个 hook 要消灭的分叉。
 */
export function useSelectAgent(): (agentId: string) => void {
  const { selectedGwId } = useGatewaySelector();
  const setSelectedAgent = useUiStore((s) => s.setSelectedAgent);
  const setMainView = useUiStore((s) => s.setMainView);
  const setPending = useTaskStore((s) => s.setPending);
  const setActiveTask = useTaskStore((s) => s.setActiveTask);

  return useCallback(
    (agentId: string) => {
      setSelectedAgent(selectedGwId, agentId);
      setPending(resolvePendingAfterAgentSwitch(useTaskStore.getState().pendingNewTask, selectedGwId, agentId));
      setActiveTask(null);
      setMainView('chat');
    },
    [selectedGwId, setActiveTask, setMainView, setPending, setSelectedAgent],
  );
}
