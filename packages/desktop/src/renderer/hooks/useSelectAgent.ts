import { useCallback } from 'react';
import { useTaskStore } from '@/stores/taskStore';
import { useUiStore } from '@/stores/uiStore';
import { useGatewaySelector } from '@/hooks/useGatewaySelector';
import { resolvePendingAfterAgentSwitch } from '@/lib/agent-switch';
import { mostRecentTaskIdForAgent } from '@/lib/task-sort';

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
 * 3. `setActiveTask(该助手最近那次对话)` —— **回到它上次说到哪**；它还没有对话时才是 `null`
 * 4. `setMainView('chat')` —— 走到用户能看见效果的地方
 *
 * ⚠️ 第 3 步 2026-09-25 **改过行为**：原来是**无条件** `setActiveTask(null)`，
 *    于是切回来是一片欢迎屏。同事真机反馈 ②「来回切换管家内容会丢失（不知道在哪里找到）」
 *    复核定性为"内容没丢（任务都在「最近任务」里），丢的是**回去的路**"⇒ 改成回到该助手的会话。
 *    ⇒ 所以**第 4 步仍然是必须的**：只恢复 id 不够，还得把主区切到对话页。
 *    ⚠️ 想"再做一层新对话的兜底"之前先看清：**用户想开新的，左栏就有「新建任务」**
 *    （`startNewTask`，快捷键与命令面板同一个），不需要靠切助手来清空。
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
      setActiveTask(mostRecentTaskIdForAgent(useTaskStore.getState().tasks, agentId));
      setMainView('chat');
    },
    [selectedGwId, setActiveTask, setMainView, setPending, setSelectedAgent],
  );
}
