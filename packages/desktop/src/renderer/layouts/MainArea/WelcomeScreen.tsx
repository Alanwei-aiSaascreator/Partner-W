import { useEffect, useState } from 'react';
import { Bot, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { useTaskStore } from '@/stores/taskStore';
import { cn } from '@/lib/utils';
import { motion as animationPresets } from '@/styles/design-tokens';
import AgentIcon from '@/components/AgentIcon';
import { useGatewaySelector } from '@/hooks/useGatewaySelector';
import GatewayInstanceSelector from '@/components/GatewayInstanceSelector';
import logo from '@/assets/logo.png';

export default function WelcomeScreen() {
  const { t } = useTranslation();
  const pendingNewTask = useTaskStore((s) => s.pendingNewTask);
  const { gateways, selectedGwId, setSelectedGwId, agentCatalog, effectiveAgentId, setSelectedAgentId } =
    useGatewaySelector({
      initialGatewayId: pendingNewTask?.gatewayId,
      initialAgentId: pendingNewTask?.agentId,
    });
  const [agentExpanded, setAgentExpanded] = useState(false);
  const maxVisible = 3;
  const visibleAgents = agentExpanded ? agentCatalog : agentCatalog.slice(0, maxVisible);
  const hiddenAgentCount = agentCatalog.length - maxVisible;

  useEffect(() => {
    if (!selectedGwId || !effectiveAgentId) return;
    const previous = useTaskStore.getState().pendingNewTask;
    if (
      previous?.gatewayId === selectedGwId &&
      previous?.agentId === effectiveAgentId &&
      !previous?.ensemble &&
      !previous?.teamId
    ) {
      return;
    }
    useTaskStore.getState().setPending({ gatewayId: selectedGwId, agentId: effectiveAgentId });
  }, [effectiveAgentId, selectedGwId]);

  const handleSelectGateway = (gatewayId: string) => {
    setSelectedGwId(gatewayId);
    setSelectedAgentId('');
    setAgentExpanded(false);
  };

  return (
    <motion.div
      {...animationPresets.fadeIn}
      className="flex h-full flex-col items-center justify-center px-6 py-16 text-center"
    >
      <div className="relative mb-5">
        <div className="absolute inset-0 scale-[2.2] rounded-full bg-[var(--accent)] opacity-[0.05] blur-2xl" />
        <img
          src={logo}
          alt={t('common.appName')}
          className="relative h-16 w-16 rounded-2xl shadow-[var(--glow-accent)]"
        />
      </div>

      <p className="type-label mb-2 text-[var(--accent)]">{t('common.appName')}</p>
      <h1 className="type-page-title text-[var(--text-primary)]">{t('mainArea.welcomeTitle')}</h1>
      <p className="type-body mt-3 max-w-xl text-[var(--text-secondary)]">{t('mainArea.welcomeSubtitle')}</p>

      <div className="mt-7 flex w-full max-w-xl flex-col items-center gap-4">
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
