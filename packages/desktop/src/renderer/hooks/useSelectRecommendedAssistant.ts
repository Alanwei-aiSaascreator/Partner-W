import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useUiStore } from '@/stores/uiStore';
import { useTaskStore } from '@/stores/taskStore';
import { fetchAgentsForGateway } from '@/hooks/useGatewayBootstrap';
import { resolveRequestedAgentForAction } from '@/lib/requested-agent';
import { toast } from '@/lib/toast';

/**
 * 「目标分析推荐的助手」这条入口 —— 从 `MainArea` 抽出来（2026-09-29）。
 *
 * ⚠️ 抽出来的**唯一理由**是它原来不可测：那段判断埋在 `MainArea` 的一个 `useCallback` 里，
 * 而渲染整个 `MainArea` 需要网关/启动自检/引导画像一大串状态 ⇒ 没人测得动它。
 * （另两个同族入口在 `IdentityCenter`，那边是走组件测的。）
 *
 * @param onDone 选成功后的收尾（`MainArea` 传的是清掉草稿请求）
 * @returns 动作结果。第二个参数 `gatewayId` 是流程起点的归属，不得在 await 后重读默认网关。
 */
export function useSelectRecommendedAssistant(
  onDone: () => void,
): (agentId: string, gatewayId: string) => Promise<boolean> {
  const { t } = useTranslation();

  return useCallback(
    async (agentId: string, gatewayId: string): Promise<boolean> => {
      /**
       * ⚠️⚠️ **在调用这一刻读 store，不要读渲染时捕获的那一份**（2026-09-29 自查抓到的真错）。
       *
       * 调用方 `MainArea.handleCreateCustomAssistant` 的时序是：
       * `await fetchAgentsForGateway(force)` → **紧接着**调这个函数 ——
       * 而它调的是**自己闭包里那个**（上一轮渲染的）回调。即使 store 已经更新、组件已经重渲，
       * 那个局部变量**仍然指向旧的闭包** ⇒ 捕获法会把**用户刚建好的助手**判成"不在本机"、
       * 弹一句「这个助手不在本机」—— **等于告诉他创建失败了**。
       *
       * （这是我改成"带判据"之后引进的回归；原来没有判据，所以不存在这个问题。
       *   测试里那条 ⭐ 用例专门复现这个时序：先抓住旧闭包，再更新目录。）
       *
       * 路由则只认调用方显式传入的 `gatewayId`：流程中途用户切换默认网关，
       * 刚创建的助手、目录刷新和待发任务仍然必须留在原网关。
       */
      if (!gatewayId) return false;

      /**
       * ⭐ 推荐的助手**不在本机**时如实说明，并且**什么都不做**。
       *
       * 原来的写法是直接 `setSelectedAgent` —— 目录里没有它，界面就静默落到第一个
       * （也就是「点了 A 进去的是罗盘助手」，`[[team-agent-404-405-brief]]` 的层 2）。
       *
       * 目录还没拉回来时强制刷新一次；刷新失败不误报缺失，
       * 但也不得把 loading 当成 ok 继续路由。
       */
      const decision = await resolveRequestedAgentForAction({
        requestedAgentId: agentId,
        readCatalog: () => useUiStore.getState().agentCatalogByGateway[gatewayId],
        refresh: () => fetchAgentsForGateway(gatewayId, { force: true }),
      });
      if (decision === 'missing') {
        toast.error(t('agent.missingTitle', { agentId }));
        return false;
      }
      if (decision === 'unavailable') {
        toast.error(t('errors.failed'));
        return false;
      }

      const state = useUiStore.getState();
      state.setSelectedAgent(gatewayId, agentId);
      useTaskStore.getState().setPending({ gatewayId, agentId });
      onDone();
      return true;
    },
    [onDone, t],
  );
}
