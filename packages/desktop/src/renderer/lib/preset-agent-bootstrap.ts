import { PRESET_AGENT_IDS, type PresetAgentId } from '@/lib/preset-agents';
import type { PresetAgentInstallProgress, PresetAgentInstallResult } from '@/lib/preset-agent-installer';

export type PresetAgentBootstrapPhase = 'idle' | 'verifying' | 'installing' | 'ready' | 'error';

export interface PresetAgentBootstrapSnapshot {
  phase: PresetAgentBootstrapPhase;
  completed: number;
  total: number;
  currentId?: PresetAgentId;
  missingIds: PresetAgentId[];
  error?: string;
}

export interface PresetAgentBootstrapDeps {
  refreshAgents: () => Promise<void>;
  readAgentIds: () => string[];
  install: (
    currentAgentIds: string[],
    onProgress: (progress: PresetAgentInstallProgress) => void,
  ) => Promise<PresetAgentInstallResult>;
}

type SnapshotListener = (snapshot: PresetAgentBootstrapSnapshot) => void;

function initialSnapshot(): PresetAgentBootstrapSnapshot {
  return {
    phase: 'idle',
    completed: 0,
    total: PRESET_AGENT_IDS.length,
    missingIds: [],
  };
}

function missingPresetIds(agentIds: readonly string[]): PresetAgentId[] {
  const knownIds = new Set(agentIds);
  return PRESET_AGENT_IDS.filter((id) => !knownIds.has(id));
}

export function createPresetAgentBootstrapCoordinator() {
  const snapshots = new Map<string, PresetAgentBootstrapSnapshot>();
  const listeners = new Map<string, Set<SnapshotListener>>();
  const inFlight = new Map<string, Promise<PresetAgentBootstrapSnapshot>>();

  const getSnapshot = (gatewayId: string): PresetAgentBootstrapSnapshot =>
    snapshots.get(gatewayId) ?? initialSnapshot();

  const emit = (gatewayId: string, snapshot: PresetAgentBootstrapSnapshot): PresetAgentBootstrapSnapshot => {
    snapshots.set(gatewayId, snapshot);
    for (const listener of listeners.get(gatewayId) ?? []) listener(snapshot);
    return snapshot;
  };

  const subscribe = (gatewayId: string, listener: SnapshotListener): (() => void) => {
    const gatewayListeners = listeners.get(gatewayId) ?? new Set<SnapshotListener>();
    gatewayListeners.add(listener);
    listeners.set(gatewayId, gatewayListeners);
    listener(getSnapshot(gatewayId));
    return () => {
      gatewayListeners.delete(listener);
      if (gatewayListeners.size === 0) listeners.delete(gatewayId);
    };
  };

  const run = (gatewayId: string, deps: PresetAgentBootstrapDeps): Promise<PresetAgentBootstrapSnapshot> => {
    const activeRun = inFlight.get(gatewayId);
    if (activeRun) return activeRun;

    const operation = (async () => {
      let missingIds: PresetAgentId[] = [];
      emit(gatewayId, {
        phase: 'verifying',
        completed: 0,
        total: PRESET_AGENT_IDS.length,
        missingIds,
      });

      try {
        await deps.refreshAgents();
        const currentAgentIds = deps.readAgentIds();
        missingIds = missingPresetIds(currentAgentIds);
        emit(gatewayId, {
          phase: 'installing',
          // 现有 ID 也要验关键文件/名称，不能在检查前先算“已完成”。
          completed: 0,
          total: PRESET_AGENT_IDS.length,
          currentId: missingIds[0],
          missingIds,
        });

        const result = await deps.install(currentAgentIds, (progress) => {
          emit(gatewayId, {
            phase: 'installing',
            completed: progress.completed,
            total: progress.total,
            // 安装器被助手市场复用了，id 类型放宽到 string；这条链只装预置助手
            currentId: progress.currentId as PresetAgentId,
            missingIds,
          });
        });

        await deps.refreshAgents();
        missingIds = missingPresetIds(deps.readAgentIds());
        const failedIds = result.failed
          .map((failure) => failure.id)
          .filter((id): id is PresetAgentId => PRESET_AGENT_IDS.includes(id as PresetAgentId));
        const unresolvedIds = [...new Set<PresetAgentId>([...missingIds, ...failedIds])];
        if (unresolvedIds.length === 0) {
          return emit(gatewayId, {
            phase: 'ready',
            completed: PRESET_AGENT_IDS.length,
            total: PRESET_AGENT_IDS.length,
            missingIds: [],
          });
        }

        const failedMessages = result.failed
          .filter((failure) => unresolvedIds.includes(failure.id as PresetAgentId))
          .map((failure) => failure.error);
        return emit(gatewayId, {
          phase: 'error',
          completed: PRESET_AGENT_IDS.length - unresolvedIds.length,
          total: PRESET_AGENT_IDS.length,
          missingIds: unresolvedIds,
          error: failedMessages.join('; ') || 'assistant setup incomplete',
        });
      } catch (error) {
        const unresolvedIds = missingIds.length > 0 ? missingIds : [...PRESET_AGENT_IDS];
        return emit(gatewayId, {
          phase: 'error',
          completed: PRESET_AGENT_IDS.length - unresolvedIds.length,
          total: PRESET_AGENT_IDS.length,
          missingIds: unresolvedIds,
          error: error instanceof Error ? error.message : 'assistant setup failed',
        });
      }
    })();

    const trackedOperation = operation.finally(() => {
      if (inFlight.get(gatewayId) === trackedOperation) inFlight.delete(gatewayId);
    });
    inFlight.set(gatewayId, trackedOperation);
    return trackedOperation;
  };

  const reset = (gatewayId: string): void => {
    if (inFlight.has(gatewayId)) return;
    snapshots.delete(gatewayId);
    emit(gatewayId, initialSnapshot());
  };

  return { getSnapshot, subscribe, run, reset };
}

export const presetAgentBootstrapCoordinator = createPresetAgentBootstrapCoordinator();
