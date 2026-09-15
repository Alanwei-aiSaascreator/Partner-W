import { useEffect } from 'react';
import { ChevronRight } from 'lucide-react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import AgentIcon from '@/components/AgentIcon';
import GatewayInstanceSelector from '@/components/GatewayInstanceSelector';
import { useGatewaySelector } from '@/hooks/useGatewaySelector';
import { resolveCommercialDefaultModel } from '@/lib/commercial-default-model';
import { resolveAssistantWorkspace } from '@/lib/preset-agents';
import type { OnboardingProfile } from '@/lib/user-onboarding';
import { cn } from '@/lib/utils';
import { useTaskStore } from '@/stores/taskStore';
import { useUiStore } from '@/stores/uiStore';
import { motion as animationPresets } from '@/styles/design-tokens';
import { relayModelsFrom } from '@/components/ChatInput/model-families';
import AssistantWorkspaceWelcome from './AssistantWorkspaceWelcome';

interface WelcomeScreenProps {
  onboardingProfile: OnboardingProfile;
  onSelectPrompt: (prompt: string) => void;
  conversationReady?: boolean;
}

export default function WelcomeScreen({ onSelectPrompt, conversationReady = true }: WelcomeScreenProps) {
  const { t } = useTranslation();
  const pendingNewTask = useTaskStore((state) => state.pendingNewTask);
  const setSelectedAgent = useUiStore((state) => state.setSelectedAgent);
  const { gateways, selectedGwId, setSelectedGwId, agentCatalog, effectiveAgentId, setSelectedAgentId } =
    useGatewaySelector({
      initialGatewayId: pendingNewTask?.gatewayId,
      initialAgentId: pendingNewTask?.agentId,
    });
  const rawModelCatalog = useUiStore((state) => (selectedGwId ? state.modelCatalogByGateway[selectedGwId] : undefined));
  const defaultModel = resolveCommercialDefaultModel(relayModelsFrom(rawModelCatalog ?? []));
  const definition = resolveAssistantWorkspace(effectiveAgentId) ?? resolveAssistantWorkspace('main')!;

  useEffect(() => {
    if (!selectedGwId || !effectiveAgentId) return;
    const previous = useTaskStore.getState().pendingNewTask;
    if (
      previous?.gatewayId === selectedGwId &&
      previous.agentId === effectiveAgentId &&
      previous.model === defaultModel?.id &&
      !previous.ensemble &&
      !previous.teamId
    ) {
      return;
    }
    useTaskStore.getState().setPending({
      gatewayId: selectedGwId,
      agentId: effectiveAgentId,
      model: defaultModel?.id,
    });
  }, [defaultModel?.id, effectiveAgentId, selectedGwId]);

  const handleSelectGateway = (gatewayId: string) => {
    setSelectedGwId(gatewayId);
    setSelectedAgentId('');
  };

  const handleSelectAgent = (agentId: string) => {
    setSelectedAgent(selectedGwId, agentId);
    setSelectedAgentId(agentId);
    useTaskStore.getState().setPending({ gatewayId: selectedGwId, agentId, model: defaultModel?.id });
    onSelectPrompt('');
  };

  return (
    <motion.div {...animationPresets.fadeIn} className="flex min-h-full flex-col items-center px-5 py-2">
      <AssistantWorkspaceWelcome
        definition={definition}
        modelLabel={defaultModel?.label ?? t('chatInput.modelsLoading')}
        ready={conversationReady}
        onSelectPrompt={onSelectPrompt}
      />

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
