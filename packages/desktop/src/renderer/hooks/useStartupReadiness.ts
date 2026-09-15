import { useCallback, useEffect, useState } from 'react';
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

function createBootstrapDeps(gatewayId: string): PresetAgentBootstrapDeps {
  return {
    refreshAgents: () => fetchAgentsForGateway(gatewayId, { force: true }),
    readAgentIds: () => agentIdsFor(gatewayId),
    install: async (currentAgentIds, onProgress) => {
      const workspaceRoot = await window.clawwork.getWorkspacePath();
      if (!workspaceRoot) throw new Error(i18n.t('presetAgents.workspaceUnavailable'));
      const displayNames = Object.fromEntries(
        PRESET_AGENT_DEFINITIONS.map((definition) => [definition.id, i18n.t(definition.displayNameKey)]),
      );
      return installPresetAgentPack({
        gatewayId,
        workspaceRoot,
        currentAgentIds,
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
  const [assistantSnapshot, setAssistantSnapshot] = useState<PresetAgentBootstrapSnapshot>(emptyAssistantSnapshot);

  useEffect(() => {
    if (!gatewayId) {
      setAssistantSnapshot(emptyAssistantSnapshot());
      return;
    }
    return presetAgentBootstrapCoordinator.subscribe(gatewayId, setAssistantSnapshot);
  }, [gatewayId]);

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
    assistantSnapshot,
  });

  const retry = useCallback(async () => {
    if (gatewayId) presetAgentBootstrapCoordinator.reset(gatewayId);
    if (readiness.ai.phase === 'ready' && gatewayStatus === 'connected') {
      await runAssistantBootstrap();
      return;
    }
    await reinitializeGatewayBootstrap();
    if (gatewayId && useUiStore.getState().gatewayStatusMap[gatewayId] === 'connected') {
      await runAssistantBootstrap();
    }
  }, [gatewayId, gatewayStatus, readiness.ai.phase, runAssistantBootstrap]);

  return { ...readiness, retry };
}
