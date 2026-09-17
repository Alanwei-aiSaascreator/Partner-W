import { useEffect } from 'react';
import { ChevronRight } from 'lucide-react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import AgentIcon from '@/components/AgentIcon';
import GatewayInstanceSelector from '@/components/GatewayInstanceSelector';
import { useGatewaySelector } from '@/hooks/useGatewaySelector';
import { resolveCommercialDefaultModel } from '@/lib/commercial-default-model';
import { resolveModelLabel } from '@/lib/model-display';
import { PRESET_AGENT_IDS, resolveAssistantWorkspace, resolveProfileAssistantId } from '@/lib/preset-agents';
import type { OnboardingProfile } from '@/lib/user-onboarding';
import { cn } from '@/lib/utils';
import { useTaskStore } from '@/stores/taskStore';
import { useUiStore } from '@/stores/uiStore';
import { motion as animationPresets } from '@/styles/design-tokens';
import { relayModelsFrom } from '@/components/ChatInput/model-families';
import type { AssistantTaskPreset } from '@/lib/assistant-task-presets';
import { removeAssistantTaskPresetTags } from '@/lib/assistant-task-preset-tags';
import AssistantTaskWorkbench from './AssistantTaskWorkbench';

interface WelcomeScreenProps {
  onboardingProfile: OnboardingProfile;
  recentPresetIds: readonly string[];
  onSelectPreset: (preset: AssistantTaskPreset, prompt: string) => void;
  onCustomTask: () => void;
  onAssistantChange: () => void;
  conversationReady?: boolean;
}

export default function WelcomeScreen({
  onboardingProfile,
  recentPresetIds,
  onSelectPreset,
  onCustomTask,
  onAssistantChange,
  conversationReady = true,
}: WelcomeScreenProps) {
  const { t } = useTranslation();
  const pendingNewTask = useTaskStore((state) => state.pendingNewTask);
  const setSelectedAgent = useUiStore((state) => state.setSelectedAgent);
  const preferredAgentId = resolveProfileAssistantId(onboardingProfile, ['main', ...PRESET_AGENT_IDS], 'main');
  const { gateways, selectedGwId, setSelectedGwId, agentCatalog, effectiveAgentId, setSelectedAgentId } =
    useGatewaySelector({
      initialGatewayId: pendingNewTask?.gatewayId,
      initialAgentId: pendingNewTask?.agentId ?? preferredAgentId,
    });
  const rawModelCatalog = useUiStore((state) => (selectedGwId ? state.modelCatalogByGateway[selectedGwId] : undefined));
  const defaultModel = resolveCommercialDefaultModel(relayModelsFrom(rawModelCatalog ?? []));
  const selectedModelId = pendingNewTask?.gatewayId === selectedGwId ? pendingNewTask.model : undefined;
  const modelLabel = selectedModelId
    ? (resolveModelLabel(selectedModelId, rawModelCatalog) ?? selectedModelId)
    : (defaultModel?.label ?? t('chatInput.modelsLoading'));
  const definition = resolveAssistantWorkspace(effectiveAgentId);

  useEffect(() => {
    if (!selectedGwId || !effectiveAgentId) return;
    const previous = useTaskStore.getState().pendingNewTask;
    const sameScope = previous?.gatewayId === selectedGwId && previous.agentId === effectiveAgentId;
    const model = sameScope && previous.model ? previous.model : defaultModel?.id;
    if (!previous?.agentId && effectiveAgentId === preferredAgentId) {
      setSelectedAgent(selectedGwId, effectiveAgentId);
    }
    if (sameScope) {
      if (previous.model !== model) useTaskStore.getState().updatePending({ model });
      return;
    }
    const tags = removeAssistantTaskPresetTags(previous?.tags ?? []);
    useTaskStore.getState().setPending({
      gatewayId: selectedGwId,
      agentId: effectiveAgentId,
      model,
      ...(tags.length > 0 ? { tags } : {}),
    });
  }, [defaultModel?.id, effectiveAgentId, preferredAgentId, selectedGwId, setSelectedAgent]);

  const handleSelectGateway = (gatewayId: string) => {
    setSelectedGwId(gatewayId);
    setSelectedAgentId('');
  };

  const handleSelectAgent = (agentId: string) => {
    setSelectedAgent(selectedGwId, agentId);
    setSelectedAgentId(agentId);
    const taskState = useTaskStore.getState();
    const previous = taskState.pendingNewTask;
    const sameScope = previous?.gatewayId === selectedGwId && previous.agentId === agentId;
    if (sameScope) {
      taskState.updatePending({ model: previous.model ?? defaultModel?.id });
    } else {
      const tags = removeAssistantTaskPresetTags(previous?.tags ?? []);
      taskState.setPending({
        gatewayId: selectedGwId,
        agentId,
        model: defaultModel?.id,
        ...(tags.length > 0 ? { tags } : {}),
      });
    }
    onAssistantChange();
  };

  return (
    <motion.div {...animationPresets.fadeIn} className="flex min-h-full flex-col items-center px-5 py-2">
      {definition ? (
        <AssistantTaskWorkbench
          definition={definition}
          modelLabel={modelLabel}
          ready={conversationReady}
          recentPresetIds={recentPresetIds}
          onSelectPreset={(preset) => onSelectPreset(preset, t(preset.promptKey))}
          onCustomTask={onCustomTask}
        />
      ) : (
        <section className="mx-auto flex w-full max-w-[var(--content-max-width)] flex-col items-center px-2 py-5 text-center">
          <h1 className="type-page-title text-[var(--text-primary)]">{t('mainArea.welcomeTitle')}</h1>
          <p className="type-body mt-2 max-w-xl text-[var(--text-secondary)]">{t('mainArea.welcomeSubtitle')}</p>
        </section>
      )}

      <div className="mt-1 flex w-full max-w-[var(--content-max-width)] flex-col items-center gap-3 border-t border-[var(--border-subtle)] pt-4">
        {gateways.length > 1 && (
          <GatewayInstanceSelector
            gateways={gateways}
            selectedGatewayId={selectedGwId}
            onSelectGateway={handleSelectGateway}
            showLabel={false}
          />
        )}
        <p className="type-support text-[var(--text-muted)]">{t('mainArea.currentAssistant')}</p>
        <div className="flex max-w-full flex-wrap items-center justify-center gap-2">
          {agentCatalog.slice(0, 3).map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => handleSelectAgent(agent.id)}
              className={cn(
                'type-label inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 transition-colors focus-visible:outline-none glow-focus',
                agent.id === effectiveAgentId
                  ? 'border-[var(--accent)] bg-[var(--accent-dim)] text-[var(--accent)]'
                  : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
              )}
            >
              <AgentIcon
                gatewayId={selectedGwId}
                agentId={agent.id}
                gatewayAvatarUrl={agent.identity?.avatarUrl}
                emoji={agent.identity?.emoji}
                imgClass="h-4 w-4 rounded-full object-cover"
                emojiClass="emoji-sm"
                iconSize={14}
              />
              {agent.id === 'main' ? t('mainArea.compassAssistant') : (agent.name ?? agent.id)}
            </button>
          ))}
          {agentCatalog.length > 3 && (
            <span className="type-support inline-flex items-center gap-1 px-2 py-2 text-[var(--text-muted)]">
              +{agentCatalog.length - 3}
              <ChevronRight size={12} />
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
}
