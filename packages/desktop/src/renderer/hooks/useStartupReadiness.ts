import { useCallback, useEffect, useState } from 'react';
import type { RelayBootstrapPublicState } from '@clawwork/shared';
import i18n from '@/i18n';
import { fetchAgentsForGateway, reinitializeGatewayBootstrap } from '@/hooks/useGatewayDispatcherSetup';
import {
  presetAgentBootstrapCoordinator,
  type PresetAgentBootstrapDeps,
  type PresetAgentBootstrapSnapshot,
} from '@/lib/preset-agent-bootstrap';
import { PRESET_AGENT_DEFINITIONS } from '@/lib/preset-agents';
import { installPresetAgentPack } from '@/lib/preset-agent-installer';
import { deriveStartupReadiness } from '@/lib/startup-readiness';
import { useUiStore } from '@/stores/uiStore';

function emptyAssistantSnapshot(): PresetAgentBootstrapSnapshot {
  return {
    phase: 'idle',
    completed: 0,
    total: PRESET_AGENT_DEFINITIONS.length,
    missingIds: [],
  };
}

function agentIdsFor(gatewayId: string): string[] {
  return useUiStore.getState().agentCatalogByGateway[gatewayId]?.agents.map((agent) => agent.id) ?? [];
}

export function createBootstrapDeps(gatewayId: string): PresetAgentBootstrapDeps {
  return {
    refreshAgents: () => fetchAgentsForGateway(gatewayId, { force: true }),
    readAgentIds: () => agentIdsFor(gatewayId),
    install: async (currentAgentIds, onProgress) => {
      const workspaceRoot = await window.clawwork.getWorkspacePath();
      if (!workspaceRoot) throw new Error(i18n.t('presetAgents.workspaceUnavailable'));
      const presetIds = new Set<string>(PRESET_AGENT_DEFINITIONS.map((definition) => definition.id));
      const repairAgentIds = (useUiStore.getState().agentCatalogByGateway[gatewayId]?.agents ?? [])
        .filter((agent) => presetIds.has(agent.id) && (agent.name === agent.id || agent.identity?.name === agent.id))
        .map((agent) => agent.id);
      const displayNames = Object.fromEntries(
        PRESET_AGENT_DEFINITIONS.map((definition) => [definition.id, i18n.t(definition.displayNameKey)]),
      );
      return installPresetAgentPack({
        gatewayId,
        workspaceRoot,
        currentAgentIds,
        repairAgentIds,
        verifyExisting: true,
        preservePartialOnFailure: true,
        displayNames,
        api: window.clawwork,
        onProgress,
      });
    },
  };
}

export function useStartupReadiness(enabled: boolean) {
  const gatewayId = useUiStore((state) => state.defaultGatewayId);
  const gatewayStatus = useUiStore((state) =>
    state.defaultGatewayId ? state.gatewayStatusMap[state.defaultGatewayId] : undefined,
  );
  const rawModelCatalog = useUiStore((state) =>
    state.defaultGatewayId ? state.modelCatalogByGateway[state.defaultGatewayId] : undefined,
  );
  // 目录**取不到**（退避已用尽）与"还在取"是两件事：前者得落显式失败态，
  // 否则界面永远停在"正在准备模型…"（2026-09-20 用户报障）。
  const catalogFailed = useUiStore((state) =>
    state.defaultGatewayId ? state.modelCatalogFailureByGateway[state.defaultGatewayId] === true : false,
  );
  const [assistantSnapshot, setAssistantSnapshot] = useState<PresetAgentBootstrapSnapshot>(emptyAssistantSnapshot);
  const [relayState, setRelayState] = useState<RelayBootstrapPublicState | null>(null);
  // 请求重试那一刻手头那条快照的时间戳：只有**比它更新**的结论才算这一轮的答复。
  const [relayRetryFrom, setRelayRetryFrom] = useState<number | null>(null);

  useEffect(() => {
    if (!gatewayId) {
      setAssistantSnapshot(emptyAssistantSnapshot());
      return;
    }
    return presetAgentBootstrapCoordinator.subscribe(gatewayId, setAssistantSnapshot);
  }, [gatewayId]);

  /**
   * ⭐ 中转公开状态：**先订阅，再读初始快照**。
   *
   * 为什么要读：bootstrap 在窗口建好**之前**就跑过一轮，那之前的事件没人收 ⇒ 只能补读。
   * 为什么要先订阅：补读是异步的，反过来写的话，**订阅前那一瞬**发生的事件会丢，
   * 而晚到的初始读又把更旧的结论盖回去 —— 界面于是把已经确定的失败重新显示成
   * "正在准备模型"（第二台机器那次实机的形状）。
   *
   * 取舍一律看 `updatedAt`（主进程那边严格单调，见 `@clawwork/shared` 的事件契约）：
   * **不是**"事件优先"也不是"读优先"。幂等键是 `(phase, errorCode, updatedAt)`，
   * 内容完全相同的事件可能重复发（被单飞吸收的那次触发也会推成 `running`），
   * 所以这里**不**假设"一条事件 = 一次状态转变"。
   */
  useEffect(() => {
    const api = window.clawwork;
    if (typeof api?.onCommercialRelayBootstrapState !== 'function') return;
    let active = true;
    const accept = (next: RelayBootstrapPublicState): void => {
      setRelayState((current) => (current && current.updatedAt >= next.updatedAt ? current : next));
    };
    const unsubscribe = api.onCommercialRelayBootstrapState((next) => {
      if (active) accept(next);
    });
    void api
      .commercialRelayBootstrapState()
      .then((result) => {
        if (!active) return;
        // ⚠️ 读不到 = **没有结论**，不是"出错了"：什么都不改，照旧走目录那条有界推断。
        if (result?.ok && result.result) accept(result.result);
      })
      .catch(() => {
        // 同上：初始读这条路不可用，不该在界面上变成一条失败结论。
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const runAssistantBootstrap = useCallback(async () => {
    if (!gatewayId) return;
    await presetAgentBootstrapCoordinator.run(gatewayId, createBootstrapDeps(gatewayId));
  }, [gatewayId]);

  useEffect(() => {
    if (!enabled || !gatewayId || gatewayStatus !== 'connected') return;
    void runAssistantBootstrap();
  }, [enabled, gatewayId, gatewayStatus, runAssistantBootstrap]);

  const readiness = deriveStartupReadiness({
    gatewayId,
    gatewayStatus,
    rawModelCatalog,
    catalogFailed,
    assistantSnapshot,
    relayState: relayState ?? undefined,
  });

  /**
   * ⭐ 重试之后**第二步**：中转换到 `ready` 才刷网关/目录/助手。
   *
   * 判据是"比请求重试那一刻**更新**的结论"（`updatedAt` 严格单调），不是"又来了一条事件"、
   * 也不是"相位变了"：内容相同的 `running` 会被重发，而请求重试时手头那条失败结论
   * 也还挂在那儿 —— 用那两个判据都会在**还没开始**的时候就把刷新做掉（白刷：
   * 中转配置还没落上去，目录照样取不到）。
   */
  useEffect(() => {
    if (relayRetryFrom === null || !relayState) return;
    if (relayState.updatedAt <= relayRetryFrom) return;
    if (relayState.phase === 'running') return; // 新一轮已经跑起来了：等它跑完
    setRelayRetryFrom(null);
    if (relayState.phase !== 'ready') return; // 又失败了：不白刷（失败结论已经给到界面）
    void reinitializeGatewayBootstrap().then(() => {
      if (gatewayId && useUiStore.getState().gatewayStatusMap[gatewayId] === 'connected') {
        void runAssistantBootstrap();
      }
    });
  }, [gatewayId, relayRetryFrom, relayState, runAssistantBootstrap]);

  const retry = useCallback(async () => {
    // ⭐ 已知的中转失败：出口是**让主进程重跑一轮**，不是"重新准备模型"。
    //     ⚠️ 确定性失败（去激活 / 换账号）连这一下都不发：再试一万次也是一样的结论，
    //     界面上也没有那个按钮（`StartupReadinessPanel` 按 `kind` 决定给哪个出口）。
    //     `updatedAt` 要在**发请求之前**记下来，否则主进程那条 `running` 可能先到。
    if (readiness.relayFailure) {
      if (readiness.relayFailure.kind !== 'retryable') return;
      setRelayRetryFrom(relayState?.updatedAt ?? 0);
      await window.clawwork.commercialRelayBootstrapRetry();
      return;
    }
    if (gatewayId) presetAgentBootstrapCoordinator.reset(gatewayId);
    if (readiness.ai.phase === 'ready' && gatewayStatus === 'connected') {
      await runAssistantBootstrap();
      return;
    }
    await reinitializeGatewayBootstrap();
    if (gatewayId && useUiStore.getState().gatewayStatusMap[gatewayId] === 'connected') {
      await runAssistantBootstrap();
    }
  }, [gatewayId, gatewayStatus, readiness.ai.phase, readiness.relayFailure, relayState, runAssistantBootstrap]);

  return { ...readiness, retry };
}
