import type { GatewayConnectionStatus } from '@clawwork/core';
import type { ModelCatalogEntry } from '@clawwork/shared';
import { deriveModelAvailability } from '@/components/ChatInput/model-availability';
import { relayModelsFrom } from '@/components/ChatInput/model-families';
import type { PresetAgentBootstrapPhase, PresetAgentBootstrapSnapshot } from '@/lib/preset-agent-bootstrap';

export type StartupAiPhase = 'starting' | 'loading-models' | 'catalog-failed' | 'ready' | 'error';
export type StartupAssistantPhase = 'waiting' | Exclude<PresetAgentBootstrapPhase, 'idle'>;
export type StartupRetry = () => Promise<void>;

export interface StartupReadiness {
  gatewayId: string | null | undefined;
  ai: { phase: StartupAiPhase };
  assistants: Omit<PresetAgentBootstrapSnapshot, 'phase'> & { phase: StartupAssistantPhase };
  workspaceAvailable: boolean;
  conversationReady: boolean;
  /**
   * 输入框该不该拦。**只有"还在准备"才拦**（服务没起来 / 目录还在取）；
   * 一旦有结论（取到了 / 确实没有模型 / 取不到）就不该再锁着用户。
   */
  composerBlocked: boolean;
  isReady: boolean;
  hasError: boolean;
}

interface StartupReadinessInput {
  gatewayId: string | null | undefined;
  gatewayStatus: GatewayConnectionStatus | undefined;
  rawModelCatalog: ModelCatalogEntry[] | undefined;
  catalogFailed: boolean;
  assistantSnapshot: PresetAgentBootstrapSnapshot;
}

export function deriveStartupReadiness({
  gatewayId,
  gatewayStatus,
  rawModelCatalog,
  catalogFailed,
  assistantSnapshot,
}: StartupReadinessInput): StartupReadiness {
  const modelAvailability = deriveModelAvailability({
    gatewayId,
    gatewayStatus,
    rawCatalog: rawModelCatalog,
    catalogFailed,
    modelCount: relayModelsFrom(rawModelCatalog ?? []).length,
  });
  const aiPhase: StartupAiPhase =
    modelAvailability === 'service-starting'
      ? 'starting'
      : modelAvailability === 'models-loading'
        ? 'loading-models'
        : modelAvailability === 'catalog-failed'
          ? 'catalog-failed'
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
  // ⚠️ 拦输入框的判据**只有一条**：还在准备（服务没起来 / 目录还在取）。
  //    以前是 `!conversationReady`，于是"目录取不到"（相位永远停在 loading）会把用户
  //    **永远**锁在输入框外 —— 打不了字、也看不到任何出错信号（2026-09-20 用户报障）。
  //    一旦有了结论（取到了 / 确实没有模型 / 取不到），等待就没有意义了，必须给出口。
  const composerBlocked = aiPhase === 'starting' || aiPhase === 'loading-models';

  return {
    gatewayId,
    ai: { phase: aiPhase },
    assistants,
    workspaceAvailable: true,
    conversationReady,
    composerBlocked,
    isReady,
    hasError: aiPhase === 'error' || aiPhase === 'catalog-failed' || assistantPhase === 'error',
  };
}
