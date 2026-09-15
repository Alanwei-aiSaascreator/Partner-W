import type { GatewayConnectionStatus } from '@clawwork/core';
import type { ModelCatalogEntry } from '@clawwork/shared';
import { deriveModelAvailability } from '@/components/ChatInput/model-availability';
import { relayModelsFrom } from '@/components/ChatInput/model-families';
import type { PresetAgentBootstrapPhase, PresetAgentBootstrapSnapshot } from '@/lib/preset-agent-bootstrap';

export type StartupAiPhase = 'starting' | 'loading-models' | 'ready' | 'error';
export type StartupAssistantPhase = 'waiting' | Exclude<PresetAgentBootstrapPhase, 'idle'>;

export interface StartupReadiness {
  gatewayId: string | null | undefined;
  ai: { phase: StartupAiPhase };
  assistants: Omit<PresetAgentBootstrapSnapshot, 'phase'> & { phase: StartupAssistantPhase };
  workspaceAvailable: boolean;
  conversationReady: boolean;
  isReady: boolean;
  hasError: boolean;
}

interface StartupReadinessInput {
  gatewayId: string | null | undefined;
  gatewayStatus: GatewayConnectionStatus | undefined;
  rawModelCatalog: ModelCatalogEntry[] | undefined;
  assistantSnapshot: PresetAgentBootstrapSnapshot;
}

export function deriveStartupReadiness({
  gatewayId,
  gatewayStatus,
  rawModelCatalog,
  assistantSnapshot,
}: StartupReadinessInput): StartupReadiness {
  const modelAvailability = deriveModelAvailability({
    gatewayId,
    gatewayStatus,
    rawCatalog: rawModelCatalog,
    modelCount: relayModelsFrom(rawModelCatalog ?? []).length,
  });
  const aiPhase: StartupAiPhase =
    modelAvailability === 'service-starting'
      ? 'starting'
      : modelAvailability === 'models-loading'
        ? 'loading-models'
        : modelAvailability === 'empty'
          ? 'error'
          : 'ready';
  const assistantPhase: StartupAssistantPhase =
    !gatewayId || gatewayStatus !== 'connected'
      ? 'waiting'
      : assistantSnapshot.phase === 'idle'
        ? 'verifying'
        : assistantSnapshot.phase;
  const assistants = { ...assistantSnapshot, phase: assistantPhase };
  const isReady = aiPhase === 'ready' && assistantPhase === 'ready';
  const conversationReady = aiPhase === 'ready';

  return {
    gatewayId,
    ai: { phase: aiPhase },
    assistants,
    workspaceAvailable: true,
    conversationReady,
    isReady,
    hasError: aiPhase === 'error' || assistantPhase === 'error',
  };
}
