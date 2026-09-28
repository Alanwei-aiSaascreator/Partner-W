import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useUiStore } from '@/stores/uiStore';
import { useTaskStore } from '@/stores/taskStore';
import { resolveRequestedAgent } from '@/lib/requested-agent';
import { toast } from '@/lib/toast';

/**
 * 「目标分析推荐的助手」这条入口 —— 从 `MainArea` 抽出来（2026-09-29）。
 *
 * ⚠️ 抽出来的**唯一理由**是它原来不可测：那段判断埋在 `MainArea` 的一个 `useCallback` 里，
 * 而渲染整个 `MainArea` 需要网关/启动自检/引导画像一大串状态 ⇒ 没人测得动它。
 * （另两个同族入口在 `IdentityCenter`，那边是走组件测的。）
 *
 * @param onDone 选成功后的收尾（`MainArea` 传的是清掉草稿请求）
 */
export function useSelectRecommendedAssistant(onDone: () => void): (agentId: string) => void {
  const { t } = useTranslation();

  return useCallback(
    (agentId: string) => {
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
       * 顺带的好处：依赖表里不再有会变的值 ⇒ 这个回调本身是稳定的。
       */
      const state = useUiStore.getState();
      const gatewayId = state.defaultGatewayId ?? '';
      if (!gatewayId) return;

      /**
       * ⭐ 推荐的助手**不在本机**时如实说明，并且**什么都不做**。
       *
       * 原来的写法是直接 `setSelectedAgent` —— 目录里没有它，界面就静默落到第一个
       * （也就是「点了 A 进去的是罗盘助手」，`[[team-agent-404-405-brief]]` 的层 2）。
       *
       * ⚠️ 判据**复用** `resolveRequestedAgent`：目录还没拉回来时它返回 `loading`，
       * 不判缺失。自己写 `agents.some(...)` 会把"还没加载"说成"不在本机"。
       */
      if (resolveRequestedAgent(agentId, state.agentCatalogByGateway[gatewayId]) === 'missing') {
        toast.error(t('agent.missingTitle', { agentId }));
        return;
      }
      state.setSelectedAgent(gatewayId, agentId);
      useTaskStore.getState().setPending({ gatewayId, agentId });
      onDone();
    },
    [onDone, t],
  );
}
