import { useEffect, useMemo, useState } from 'react';
import type { GatewayInfo } from '@clawwork/core';
import type { AgentInfo } from '@clawwork/shared';
import { useUiStore } from '@/stores/uiStore';
import { fetchAgentsForGateway } from '@/hooks/useGatewayBootstrap';
import { resolveRequestedAgent } from '@/lib/requested-agent';

interface UseGatewaySelectorOptions {
  initialGatewayId?: string;
  initialAgentId?: string;
  /**
   * ⭐ 用户/调用方**点名要的**那个助手 —— 只有它会被"拒绝并说明"。
   *
   * ⚠️ 与 `initialAgentId` 是**两件事**，别合并：
   * `initialAgentId` 是"先选中哪个"（可以有推荐/默认的成分），而推荐不是用户点的。
   * 把它们混在一起会造出**误报**：新机器上引导画像推荐的预置助手正在装、目录里还没出现，
   * 界面就会说「这个助手不在本机」—— 而它几十秒后就装好了（2026-09-24 独立复核 I-1）。
   */
  requestedAgentId?: string;
}

interface UseGatewaySelectorResult {
  gateways: GatewayInfo[];
  selectedGwId: string;
  setSelectedGwId: (id: string) => void;
  agentCatalog: AgentInfo[];
  defaultAgentId: string;
  effectiveAgentId: string;
  /**
   * 仅当**目录已加载**且请求的助手不在里面时非空。
   *
   * 有值表示「用户/调用方点名要的那个助手在本机不存在」——界面的责任是**如实说明**，
   * 不是换一个助手顶上（判据见 `lib/requested-agent.ts`）。目录还没拉回来时恒为 `null`。
   */
  missingRequestedAgentId: string | null;
  setSelectedAgentId: (id: string) => void;
  hasMultipleAgents: boolean;
}

export function useGatewaySelector(options: UseGatewaySelectorOptions = {}): UseGatewaySelectorResult {
  const gatewayInfoMap = useUiStore((s) => s.gatewayInfoMap);
  const defaultGatewayId = useUiStore((s) => s.defaultGatewayId);
  const agentCatalogByGateway = useUiStore((s) => s.agentCatalogByGateway);

  const gateways = useMemo(() => Object.values(gatewayInfoMap), [gatewayInfoMap]);
  const [selectedGwId, setSelectedGwId] = useState(
    options.initialGatewayId ?? defaultGatewayId ?? gateways[0]?.id ?? '',
  );

  const gwAgents = agentCatalogByGateway[selectedGwId];
  const agentCatalog = useMemo(() => gwAgents?.agents ?? [], [gwAgents]);
  const [selectedAgentId, setSelectedAgentId] = useState(
    options.initialAgentId ??
      agentCatalogByGateway[options.initialGatewayId ?? defaultGatewayId ?? '']?.defaultId ??
      '',
  );

  const defaultAgentId = gwAgents?.defaultId ?? agentCatalog[0]?.id ?? '';

  /**
   * ⭐ 目录里没有请求的那个助手时，**拒绝**而不是换成默认助手（2026-09-24）。
   *
   * 旧行为是静默换成 `defaultAgentId`，于是「点了团队里的助手却落到主罗盘」全程无提示；
   * 更坏的是调用方（`WelcomeScreen` 的写回 effect）会把这个替换后的 id **当成用户的选择**
   * 写回 `pendingNewTask`，连带把欢迎屏重挂载一次。
   *
   * ⚠️ `loading` 那一路**必须**保持老行为：目录还没拉回来时 `agentCatalog` 是空的、
   *    `defaultAgentId` 也是 `''`，所以这里返回的同样是 `''`，与今天一字不差 —— 不引入闪烁。
   */
  /**
   * ⚠️ 请求还要**属于当前这个网关**才判（2026-09-24 独立复核 M-6）。
   *
   * 请求自带网关（`initialGatewayId`，来自待发任务的 `gatewayId`），而上面那条回落会在
   * 网关列表变化时**把 `selectedGwId` 换掉**。两者不一致时拿新网关的目录去判旧网关的请求，
   * 会把「不在**这个**网关上」说成「不在**本机**」。
   */
  const requestGatewayMatches = !options.initialGatewayId || options.initialGatewayId === selectedGwId;
  /**
   * 请求属于**别的网关**时**不判**（`loading`）—— 因为拿新网关的目录去判它必然误报。
   *
   * ⚠️ 这里**只关掉"说"**，**不关掉"代言"**：`effectiveAgentId` 仍会落回**当前网关**的默认助手，
   *    写回 effect 于是把待发任务归一到这个网关。这是**既有且被测试钉住的**行为
   *    （`welcome-screen.test.tsx` 的 "uses the destination gateway default label before stale
   *    pending state is normalized"），**不要顺手改成空串** —— 我按复核建议试过，那条用例当场红：
   *    待发任务的**网关本身**已经消失时，它点名的助手在那个网关上无从谈起，"不替它选"只会
   *    让用户既没有助手、又把待发任务留在一个死网关上。
   *
   * ⚠️ 但复核指出的那一面是真的：用户**明确选过**的助手会被静默换掉、且没有任何提示。
   *    那是"网关没了"这个更上层的事件的通知缺口，**属于另一件事**，已登记（见账本的"待拍"一节）。
   */
  const requestDeferred = Boolean(options.requestedAgentId) && !requestGatewayMatches;
  const requestedState = useMemo(
    () => (requestDeferred ? 'loading' : resolveRequestedAgent(options.requestedAgentId, gwAgents)),
    [gwAgents, options.requestedAgentId, requestDeferred],
  );
  const missingRequestedAgentId = requestedState === 'missing' ? (options.requestedAgentId ?? null) : null;
  const effectiveAgentId = useMemo(
    () =>
      requestedState === 'missing'
        ? ''
        : agentCatalog.some((agent) => agent.id === selectedAgentId)
          ? selectedAgentId
          : defaultAgentId,
    [agentCatalog, defaultAgentId, requestedState, selectedAgentId],
  );

  useEffect(() => {
    if (!gateways.length) return;
    if (gateways.some((gw) => gw.id === selectedGwId)) return;
    const fallback =
      defaultGatewayId && gateways.some((gw) => gw.id === defaultGatewayId)
        ? defaultGatewayId
        : (gateways[0]?.id ?? '');
    if (fallback && fallback !== selectedGwId) setSelectedGwId(fallback);
  }, [defaultGatewayId, gateways, selectedGwId]);

  useEffect(() => {
    if (selectedGwId) fetchAgentsForGateway(selectedGwId);
  }, [selectedGwId]);

  return {
    gateways,
    selectedGwId,
    setSelectedGwId,
    agentCatalog,
    defaultAgentId,
    effectiveAgentId,
    missingRequestedAgentId,
    setSelectedAgentId,
    hasMultipleAgents: agentCatalog.length > 1,
  };
}
