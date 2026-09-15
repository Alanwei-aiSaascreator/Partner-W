import { useEffect, useState } from 'react';
import {
  Bot,
  BriefcaseBusiness,
  ChevronRight,
  Clapperboard,
  GraduationCap,
  HeartHandshake,
  PenLine,
  ShoppingBag,
  Target,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { useTaskStore } from '@/stores/taskStore';
import { cn } from '@/lib/utils';
import { motion as animationPresets } from '@/styles/design-tokens';
import AgentIcon from '@/components/AgentIcon';
import { useGatewaySelector } from '@/hooks/useGatewaySelector';
import GatewayInstanceSelector from '@/components/GatewayInstanceSelector';
import logo from '@/assets/logo.png';
import { recommendedStarterIds, type OnboardingProfile, type StarterId } from '@/lib/user-onboarding';
import { resolveStarterAgentId, STARTER_AGENT_BY_ID } from '@/lib/preset-agents';
import { resolveCommercialDefaultModel } from '@/lib/commercial-default-model';
import { useUiStore } from '@/stores/uiStore';
import { relayModelsFrom } from '@/components/ChatInput/model-families';

interface WelcomeScreenProps {
  onboardingProfile: OnboardingProfile;
  onSelectPrompt: (prompt: string) => void;
}

const STARTER_ICONS: Record<StarterId, LucideIcon> = {
  content: PenLine,
  photography: Clapperboard,
  office: BriefcaseBusiness,
  research: GraduationCap,
  ecommerce: ShoppingBag,
  family: HeartHandshake,
};

export default function WelcomeScreen({ onboardingProfile, onSelectPrompt }: WelcomeScreenProps) {
  const { t } = useTranslation();
  const pendingNewTask = useTaskStore((s) => s.pendingNewTask);
  const { gateways, selectedGwId, setSelectedGwId, agentCatalog, effectiveAgentId, setSelectedAgentId } =
    useGatewaySelector({
      initialGatewayId: pendingNewTask?.gatewayId,
      initialAgentId: pendingNewTask?.agentId,
    });
  const [agentExpanded, setAgentExpanded] = useState(false);
  const rawModelCatalog = useUiStore((s) => (selectedGwId ? s.modelCatalogByGateway[selectedGwId] : undefined));
  const defaultModel = resolveCommercialDefaultModel(relayModelsFrom(rawModelCatalog ?? []));
  const maxVisible = 3;
  const visibleAgents = agentExpanded ? agentCatalog : agentCatalog.slice(0, maxVisible);
  const hiddenAgentCount = agentCatalog.length - maxVisible;
  const selectedStarterId = (Object.entries(STARTER_AGENT_BY_ID).find(
    ([, agentId]) => agentId === effectiveAgentId,
  )?.[0] ?? null) as StarterId | null;
  const recommendedIds = recommendedStarterIds(onboardingProfile);
  const starterIds = selectedStarterId
    ? [selectedStarterId, ...recommendedIds.filter((id) => id !== selectedStarterId)]
    : recommendedIds;
  const customGoal = onboardingProfile.customGoal.trim();
  const visibleStarterIds = customGoal ? starterIds.slice(0, 3) : starterIds;

  useEffect(() => {
    if (!selectedGwId || !effectiveAgentId) return;
    const previous = useTaskStore.getState().pendingNewTask;
    if (
      previous?.gatewayId === selectedGwId &&
      previous?.agentId === effectiveAgentId &&
      !previous?.ensemble &&
      !previous?.teamId &&
      previous?.model === defaultModel?.id
    ) {
      return;
    }
    useTaskStore.getState().setPending({
      ...previous,
      gatewayId: selectedGwId,
      agentId: effectiveAgentId,
      model: defaultModel?.id,
    });
  }, [defaultModel?.id, effectiveAgentId, selectedGwId]);

  const handleSelectGateway = (gatewayId: string) => {
    setSelectedGwId(gatewayId);
    setSelectedAgentId('');
    setAgentExpanded(false);
  };

  const handleSelectStarter = (starterId: StarterId) => {
    const agentId = resolveStarterAgentId(
      starterId,
      agentCatalog.map((agent) => agent.id),
      effectiveAgentId,
    );
    if (selectedGwId && agentId) {
      const previous = useTaskStore.getState().pendingNewTask;
      useTaskStore.getState().setPending({
        ...previous,
        gatewayId: selectedGwId,
        agentId,
        model: previous?.model ?? defaultModel?.id,
      });
      if (agentId !== effectiveAgentId) setSelectedAgentId(agentId);
    }
    onSelectPrompt(t(`mainArea.starters.${starterId}.prompt`));
  };

  return (
    <motion.div
      {...animationPresets.fadeIn}
      className="flex min-h-full flex-col items-center justify-start px-6 py-4 text-center"
    >
      <div className="relative mb-3">
        <div className="absolute inset-0 scale-[2.2] rounded-full bg-[var(--accent)] opacity-[0.05] blur-2xl" />
        <img
          src={logo}
          alt={t('common.appName')}
          className="relative h-12 w-12 rounded-xl shadow-[var(--glow-accent)]"
        />
      </div>

      <p className="type-label mb-1 text-[var(--accent)]">{t('common.appName')}</p>
      <h1 className="type-page-title text-[var(--text-primary)]">{t('mainArea.welcomeTitle')}</h1>
      <p className="type-body mt-2 max-w-xl text-[var(--text-secondary)]">{t('mainArea.welcomeSubtitle')}</p>

      <div className="mt-4 w-full max-w-2xl">
        <div className="mb-3 text-left">
          <p className="type-label text-[var(--text-primary)]">
            {selectedStarterId ? t(`mainArea.starters.${selectedStarterId}.title`) : t('mainArea.popularTasks')}
          </p>
          {selectedStarterId && (
            <p className="type-support mt-1 text-[var(--text-secondary)]">
              {t(`mainArea.starters.${selectedStarterId}.description`)}
            </p>
          )}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {customGoal && (
            <button
              type="button"
              onClick={() => onSelectPrompt(t('mainArea.customGoalPrompt', { goal: customGoal }))}
              className="group rounded-2xl border border-[var(--accent)] bg-[var(--accent-dim)] p-4 text-left transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-none glow-focus"
            >
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-[var(--bg-primary)] text-[var(--accent)]">
                  <Target size={17} />
                </span>
                <span className="min-w-0">
                  <span className="type-label block text-[var(--text-primary)]">{t('mainArea.customGoalTitle')}</span>
                  <span className="type-support mt-1 block truncate text-[var(--text-secondary)]">{customGoal}</span>
                </span>
              </div>
            </button>
          )}
          {visibleStarterIds.map((id) => {
            const Icon = STARTER_ICONS[id];
            return (
              <button
                key={id}
                type="button"
                onClick={() => handleSelectStarter(id)}
                className="group rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-dim)] focus-visible:outline-none glow-focus"
              >
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-[var(--bg-tertiary)] text-[var(--accent)] transition-colors group-hover:bg-[var(--bg-primary)]">
                    <Icon size={17} />
                  </span>
                  <span>
                    <span className="type-label block text-[var(--text-primary)]">
                      {t(`mainArea.starters.${id}.title`)}
                    </span>
                    <span className="type-support mt-1 block text-[var(--text-secondary)]">
                      {t(`mainArea.starters.${id}.description`)}
                    </span>
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-5 flex w-full max-w-2xl flex-col items-center gap-4">
        {gateways.length > 1 && (
          <GatewayInstanceSelector
            gateways={gateways}
            selectedGatewayId={selectedGwId}
            onSelectGateway={handleSelectGateway}
            showLabel={false}
          />
        )}

        {agentCatalog.length > 0 && (
          <div className="flex flex-col items-center gap-2">
            <div className="type-support inline-flex items-center gap-1.5 text-[var(--text-muted)]">
              <Bot size={13} />
              {t('mainArea.currentAssistant')}
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              {visibleAgents.map((agent) => {
                const displayName = agent.id === 'main' ? t('mainArea.compassAssistant') : (agent.name ?? agent.id);
                return (
                  <button
                    key={agent.id}
                    onClick={() => {
                      setSelectedAgentId(agent.id);
                      setAgentExpanded(false);
                    }}
                    className={cn(
                      'type-label inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 transition-colors',
                      'focus-visible:outline-none glow-focus',
                      agent.id === effectiveAgentId
                        ? 'border-[var(--accent)] bg-[var(--accent-dim)] text-[var(--accent)]'
                        : 'border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--text-muted)] hover:bg-[var(--bg-hover)]',
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
                    <span className="max-w-32 truncate">{displayName}</span>
                  </button>
                );
              })}
              {!agentExpanded && hiddenAgentCount > 0 && (
                <button
                  onClick={() => setAgentExpanded(true)}
                  className="type-support inline-flex items-center gap-1 rounded-lg px-3 py-2.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] focus-visible:outline-none glow-focus"
                  aria-label={t('mainArea.showMoreAssistants', { count: hiddenAgentCount })}
                >
                  +{hiddenAgentCount}
                  <ChevronRight size={12} />
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}
