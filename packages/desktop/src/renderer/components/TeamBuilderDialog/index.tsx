import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Sparkles,
  Send,
  Loader2,
  Bot,
  User,
  X,
  Crown,
  Users,
  Check,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import type { ModelCatalogEntry, InstallEvent, TeamPosition } from '@clawwork/shared';
import { cn } from '@/lib/utils';
import { buildInstallEventView } from '@/lib/install-event-view';
import { InstallMessageLine } from '@/components/InstallMessageLine';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import MarkdownContent from '@/components/MarkdownContent';
import ConfirmDialog from '@/components/semantic/ConfirmDialog';
import { useUiStore } from '@/stores/uiStore';
import { useSystemSession } from '@/hooks/useSystemSession';
import { useDialogGuard } from '@/hooks/useDialogGuard';
import { useTeamStore } from '@/stores/teamStore';
import { useTeamInstall } from '@/layouts/TeamsPanel/useTeamInstall';
import { toSlug, EMOJI_OPTIONS } from '@/layouts/TeamsPanel/utils';
import type { AgentDraft, TeamInfo } from '@/layouts/TeamsPanel/types';
import { relayModelsFrom } from '@/components/ChatInput/model-families';
import { canonicalModelRef, resolveTeamModelRef } from '@/lib/team-model-ref';

export interface AgentConfig {
  name: string;
  role: 'coordinator' | 'worker';
  description: string;
  model: string;
  identity: string;
  position?: TeamPosition;
}

export interface TeamConfig {
  name: string;
  emoji: string;
  description: string;
  agents: AgentConfig[];
}

const EMPTY_CONFIG: TeamConfig = { name: '', emoji: '🤖', description: '', agents: [] };

const EMPTY_MODELS: ModelCatalogEntry[] = [];

const VALID_ROLES = new Set<string>(['coordinator', 'worker']);
const HAS_CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/u;

export function defaultTeamPositionForRole(role: AgentConfig['role']): TeamPosition {
  return role === 'coordinator' ? 'moderator' : 'expert';
}

const SYSTEM_PROMPT_TEMPLATE = `You are a Team creation assistant for Rongying Cube. Help the user create a new AI Team — a group of specialized Agents that work together on tasks.

Your job:
1. Ask what kind of Team the user wants and what tasks it should handle
2. Based on their description, suggest a team name, description, emoji, and a set of agents with their roles
3. Each team needs at least one coordinator (who orchestrates the workflow) and one or more workers (who handle specific tasks)
4. Recommend models for each agent from the available list: {{modelList}}
5. After each response, include a structured block with the current team config

Rules:
- Ask ONE question at a time
- Be proactive: extract team structure from the user's first description
- All user-visible team names, agent names, descriptions, identities, and prose MUST use {{displayLanguage}}. Do not copy English display names from the example when the requested language is Chinese.
- The client derives stable internal identifiers separately, so user-visible names do NOT need to be English or ASCII.
- Keep the JSON values for role exactly "coordinator" or "worker", and copy model identifiers exactly from the available list.
- Team description should be a brief summary (under 200 chars) of the team's purpose
- Each agent needs: name, role (coordinator or worker), description (brief capability summary under 200 chars), model, and identity (system prompt, 2-4 sentences)
- A team must have at least 2 agents, with at least 1 coordinator
- Always end your response with the current config as a JSON block
- Only include fields whose values have been determined
- Example:

\`\`\`team-config
{{exampleConfig}}
\`\`\`

Respond in {{displayLanguage}}.

Now begin by asking what kind of Team the user wants to create.`;

function isTraditionalChinese(language: string): boolean {
  return /^zh-(tw|hk|hant)/i.test(language);
}

function isChinese(language: string): boolean {
  return /^zh(?:-|$)/i.test(language);
}

function localizedTeamConfigExample(language: string, model: string): string {
  if (isTraditionalChinese(language)) {
    return JSON.stringify({
      name: '研究分析團隊',
      emoji: '🔬',
      description: '負責資料研究、分析與結論整合',
      agents: [
        {
          name: '研究主管',
          role: 'coordinator',
          description: '規劃研究方向並整合結論',
          model,
          identity: '你是研究主管。先制定研究策略，再核對證據並整合成清晰結論。',
        },
        {
          name: '資料分析師',
          role: 'worker',
          description: '分析資料並提煉洞察',
          model,
          identity: '你是資料分析師。負責清理資料、比較指標並輸出可驗證的洞察。',
        },
      ],
    });
  }
  if (isChinese(language)) {
    return JSON.stringify({
      name: '研究分析团队',
      emoji: '🔬',
      description: '负责资料研究、分析与结论整合',
      agents: [
        {
          name: '研究主管',
          role: 'coordinator',
          description: '规划研究方向并整合结论',
          model,
          identity: '你是研究主管。先制定研究策略，再核对证据并整合成清晰结论。',
        },
        {
          name: '数据分析师',
          role: 'worker',
          description: '分析数据并提炼洞察',
          model,
          identity: '你是数据分析师。负责清理数据、比较指标并输出可验证的洞察。',
        },
      ],
    });
  }
  return JSON.stringify({
    name: 'Research Team',
    emoji: '🔬',
    description: 'Deep research and analysis team',
    agents: [
      {
        name: 'Research Lead',
        role: 'coordinator',
        description: 'Coordinates research and synthesizes findings',
        model,
        identity: 'You plan research strategies, verify evidence, and synthesize findings.',
      },
      {
        name: 'Data Analyst',
        role: 'worker',
        description: 'Analyzes data and produces insights',
        model,
        identity: 'You clean data, compare metrics, and produce verifiable insights.',
      },
    ],
  });
}

export function buildTeamBuilderSystemPrompt(modelRefs: string[], language: string): string {
  const displayLanguage = isTraditionalChinese(language)
    ? 'Traditional Chinese (繁體中文)'
    : isChinese(language)
      ? 'Simplified Chinese (简体中文)'
      : language || 'the user language';
  return SYSTEM_PROMPT_TEMPLATE.replace('{{modelList}}', modelRefs.join(', ') || 'default')
    .replaceAll('{{displayLanguage}}', displayLanguage)
    .replace('{{exampleConfig}}', localizedTeamConfigExample(language, modelRefs[0] ?? ''));
}

const CONFIG_BLOCK_RE = /\n?```team-config\n([\s\S]*?)\n```\n?/g;
const CONFIG_BLOCK_PARTIAL_RE = /\n?```team-config[\s\S]*$/;

function sanitizeAgents(raw: unknown[], models: ModelCatalogEntry[]): AgentConfig[] {
  return raw
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
    .map((a) => {
      const role = VALID_ROLES.has(a.role as string) ? (a.role as 'coordinator' | 'worker') : 'worker';
      return {
        name: typeof a.name === 'string' ? a.name : '',
        role,
        description: typeof a.description === 'string' ? a.description : '',
        model: resolveTeamModelRef(typeof a.model === 'string' ? a.model : '', models),
        identity: typeof a.identity === 'string' ? a.identity : '',
        position: defaultTeamPositionForRole(role),
      };
    });
}

export function parseTeamConfig(text: string, models: ModelCatalogEntry[]): Partial<TeamConfig> | null {
  const matches = [...text.matchAll(CONFIG_BLOCK_RE)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  try {
    const value: unknown = JSON.parse(last[1]);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const parsed: Partial<TeamConfig> = {};
    if (typeof raw.name === 'string') parsed.name = raw.name;
    if (typeof raw.emoji === 'string') parsed.emoji = raw.emoji;
    if (typeof raw.description === 'string') parsed.description = raw.description;
    if (Array.isArray(raw.agents)) parsed.agents = sanitizeAgents(raw.agents, models);
    return parsed;
  } catch {
    return null;
  }
}

function stripConfigBlock(text: string): string {
  let result = text.replace(CONFIG_BLOCK_RE, '');
  result = result.replace(CONFIG_BLOCK_PARTIAL_RE, '');
  return result.trim();
}

function configToTeamInfo(config: TeamConfig, gatewayId: string): TeamInfo {
  return {
    name: config.name.trim(),
    emoji: config.emoji || '🤖',
    description: config.description.trim(),
    gatewayId,
  };
}

function configToAgentDrafts(config: TeamConfig, models: ModelCatalogEntry[]): AgentDraft[] {
  return config.agents.map((a) => ({
    uid: crypto.randomUUID(),
    name: a.name.trim(),
    description: a.description.trim(),
    role: a.role,
    position: a.position ?? defaultTeamPositionForRole(a.role),
    model: resolveTeamModelRef(a.model, models),
    agentMd: a.identity.trim(),
    soulMd: '',
    skills: [],
  }));
}

export function isTeamConfigValid(config: TeamConfig, language: string): boolean {
  if (!config.name.trim() || !config.description.trim()) return false;
  if (config.agents.length < 2) return false;
  if (!config.agents.some((agent) => agent.role === 'coordinator')) return false;
  if (
    !config.agents.every(
      (agent) =>
        agent.name.trim() &&
        agent.description.trim() &&
        agent.model.trim() &&
        agent.identity.trim() &&
        toSlug(agent.name),
    )
  ) {
    return false;
  }
  const slugs = config.agents.map((agent) => toSlug(agent.name));
  if (new Set(slugs).size !== slugs.length) return false;

  if (isChinese(language)) {
    const visibleFields = [
      config.name,
      config.description,
      ...config.agents.flatMap((agent) => [agent.name, agent.description, agent.identity]),
    ];
    if (!visibleFields.every((value) => HAS_CJK.test(value))) return false;
  }
  return true;
}

const inputClass = cn(
  'flex-1 h-[var(--density-control-height-lg)] px-3 py-2 rounded-md',
  'bg-[var(--bg-tertiary)] border border-[var(--border)]',
  'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
  'outline-none ring-accent-focus transition-colors',
);

interface TeamBuilderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gatewayId: string;
  onCreated?: () => void;
}

export default function TeamBuilderDialog({ open, onOpenChange, gatewayId, onCreated }: TeamBuilderDialogProps) {
  const { t, i18n } = useTranslation();
  const { status, messages, error, start, send, end } = useSystemSession();

  const modelCatalogByGateway = useUiStore((s) => s.modelCatalogByGateway);
  const agentCatalogByGateway = useUiStore((s) => s.agentCatalogByGateway);
  const models = modelCatalogByGateway[gatewayId] ?? EMPTY_MODELS;
  const relayModels = useMemo(() => relayModelsFrom(models).filter((model) => model.available !== false), [models]);
  const defaultAgentId = agentCatalogByGateway[gatewayId]?.defaultId ?? 'main';

  const loadTeams = useTeamStore((s) => s.loadTeams);
  const { installStatus, installEvents, runInstall, resetInstall } = useTeamInstall(loadTeams);

  const [config, setConfig] = useState<TeamConfig>(EMPTY_CONFIG);
  const [userEdited, setUserEdited] = useState<Set<string>>(new Set());
  const [input, setInput] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [expandedAgent, setExpandedAgent] = useState<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const prevStatusRef = useRef(status);
  const startedRef = useRef(false);

  const isDirty = useCallback(() => {
    if (installStatus === 'installing') return true;
    if (installStatus === 'done' || installStatus === 'error') return false;
    return messages.length > 1;
  }, [installStatus, messages.length]);

  const doClose = useCallback(() => {
    end();
    resetInstall();
    onOpenChange(false);
  }, [end, resetInstall, onOpenChange]);

  const { confirmOpen, guardedOpenChange, contentProps, confirmDiscard, cancelDiscard } = useDialogGuard({
    isDirty,
    onConfirmClose: doClose,
  });

  useEffect(() => {
    if (!open) {
      startedRef.current = false;
      return;
    }
    if (startedRef.current) return;
    startedRef.current = true;

    setConfig(EMPTY_CONFIG);
    setUserEdited(new Set());
    setInput('');
    setEmojiOpen(false);
    setExpandedAgent(null);
    resetInstall();

    const modelRefs = relayModels.map(canonicalModelRef);
    const prompt = buildTeamBuilderSystemPrompt(modelRefs, i18n.language);

    start({
      gatewayId,
      agentId: defaultAgentId,
      purpose: 'team-builder',
      initialMessage: prompt,
    });
  }, [open, gatewayId, defaultAgentId, relayModels, start, i18n.language, resetInstall]);

  useEffect(() => {
    if (status === 'streaming' || (prevStatusRef.current === 'streaming' && status === 'active')) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === 'assistant') {
        const parsed = parseTeamConfig(lastMsg.content, relayModels);
        if (parsed) {
          setConfig((prev) => ({
            name: userEdited.has('name') ? prev.name : (parsed.name ?? prev.name),
            emoji: userEdited.has('emoji') ? prev.emoji : (parsed.emoji ?? prev.emoji),
            description: userEdited.has('description') ? prev.description : (parsed.description ?? prev.description),
            agents: parsed.agents ?? prev.agents,
          }));
        }
      }
    }
    prevStatusRef.current = status;
  }, [status, messages, userEdited, relayModels]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (status === 'active') {
      inputRef.current?.focus();
    }
  }, [status]);

  const visibleMessages = useMemo(() => (messages.length > 1 ? messages.slice(1) : []), [messages]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || status === 'streaming') return;
    setInput('');
    await send(text);
  }, [input, status, send]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const updateField = useCallback((field: 'name' | 'emoji' | 'description', value: string) => {
    setConfig((prev) => ({ ...prev, [field]: value }));
    setUserEdited((prev) => {
      const next = new Set(prev);
      if (value) next.add(field);
      else next.delete(field);
      return next;
    });
  }, []);

  const isValid = useMemo(() => {
    return isTeamConfigValid(config, i18n.language);
  }, [config, i18n.language]);

  const handleCreate = useCallback(async () => {
    if (!isValid) return;
    await end();
    const teamInfo = configToTeamInfo(config, gatewayId);
    const agentDrafts = configToAgentDrafts(config, relayModels);
    runInstall(teamInfo, agentDrafts);
  }, [isValid, config, gatewayId, end, runInstall, relayModels]);

  useEffect(() => {
    if (!open) return;
    if (installStatus === 'done') {
      toast.success(t('teams.teamBuilderCreated'));
      onCreated?.();
      onOpenChange(false);
    }
    if (installStatus === 'error') {
      toast.error(t('teams.wizard.installError'));
    }
  }, [open, installStatus, onCreated, onOpenChange, t]);

  const lastProgress = useMemo(() => {
    for (let i = installEvents.length - 1; i >= 0; i--) {
      if (installEvents[i].progress) return installEvents[i].progress;
    }
    return null;
  }, [installEvents]);

  const progressPercent = lastProgress ? Math.round((lastProgress.current / lastProgress.total) * 100) : 0;

  const installing = installStatus === 'installing' || installStatus === 'done' || installStatus === 'error';

  return (
    <Dialog open={open} onOpenChange={guardedOpenChange}>
      <DialogContent className="max-w-5xl p-0 overflow-hidden [&>button:last-child]:hidden" {...contentProps}>
        <DialogHeader className="relative px-6 pt-5 pb-0">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles size={18} className="text-[var(--accent)]" />
            {t('teams.teamBuilderTitle')}
          </DialogTitle>
          <DialogDescription>{t('teams.teamBuilderDesc')}</DialogDescription>
          <button
            type="button"
            onClick={() => guardedOpenChange(false)}
            disabled={installStatus === 'installing'}
            className="absolute right-4 top-4 rounded-md p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            <X size={16} />
          </button>
        </DialogHeader>

        <div className="flex h-144 border-t border-[var(--border-subtle)]">
          <div className="flex flex-1 flex-col border-r border-[var(--border-subtle)]">
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
              {visibleMessages.map((msg, i) => (
                <div
                  key={`${msg.role}-${msg.timestamp}-${i}`}
                  className={cn('flex gap-2.5', msg.role === 'user' ? 'justify-end' : 'justify-start')}
                >
                  {msg.role === 'assistant' && (
                    <div className="w-7 h-7 rounded-lg bg-[var(--accent-soft)] flex items-center justify-center flex-shrink-0 mt-0.5">
                      <Bot size={14} className="text-[var(--accent)]" />
                    </div>
                  )}
                  <div
                    className={cn(
                      'rounded-xl px-3.5 py-2.5',
                      msg.role === 'user'
                        ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
                        : 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]',
                    )}
                  >
                    {msg.role === 'assistant' && !stripConfigBlock(msg.content) && status === 'streaming' ? (
                      <div className="flex items-center gap-1.5 py-1">
                        <Loader2 size={14} className="animate-spin text-[var(--text-muted)]" />
                      </div>
                    ) : msg.role === 'assistant' ? (
                      <div className="type-body leading-relaxed [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
                        <MarkdownContent content={stripConfigBlock(msg.content)} />
                      </div>
                    ) : (
                      <p className="type-body leading-relaxed">{msg.content}</p>
                    )}
                  </div>
                  {msg.role === 'user' && (
                    <div className="w-7 h-7 rounded-lg bg-[var(--bg-tertiary)] flex items-center justify-center flex-shrink-0 mt-0.5">
                      <User size={14} className="text-[var(--text-muted)]" />
                    </div>
                  )}
                </div>
              ))}
              {error && <p className="type-support text-center text-[var(--danger)]">{error}</p>}
              <div ref={messagesEndRef} />
            </div>

            <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] px-4 py-3">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('teams.teamBuilderInputPlaceholder')}
                disabled={status === 'streaming' || status === 'idle' || installing}
                className={cn(inputClass, 'w-full')}
              />
              <Button
                variant="default"
                size="icon"
                onClick={handleSend}
                disabled={!input.trim() || status === 'streaming' || installing}
              >
                {status === 'streaming' ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              </Button>
            </div>
          </div>

          <div className="flex w-88 flex-col">
            {installing ? (
              <InstallProgress
                status={installStatus}
                events={installEvents}
                progressPercent={progressPercent}
                agents={config.agents}
              />
            ) : (
              <>
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  <div className="flex items-center gap-3 pb-3 border-b border-[var(--border-subtle)]">
                    <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
                      <PopoverTrigger asChild>
                        <button className="w-10 h-10 rounded-xl bg-[var(--bg-tertiary)] flex items-center justify-center transition-colors hover:bg-[var(--bg-hover)] cursor-pointer">
                          <span className="emoji-md">{config.emoji}</span>
                        </button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-64">
                        <div className="grid grid-cols-8 gap-1">
                          {EMOJI_OPTIONS.map((e) => (
                            <button
                              key={e}
                              onClick={() => {
                                updateField('emoji', e);
                                setEmojiOpen(false);
                              }}
                              className="emoji-md flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-hover)] cursor-pointer"
                            >
                              {e}
                            </button>
                          ))}
                        </div>
                      </PopoverContent>
                    </Popover>
                    <span className="type-label text-[var(--text-primary)] truncate">
                      {config.name || t('teams.teamBuilderPreviewTitle')}
                    </span>
                  </div>

                  <div>
                    <label className="type-label mb-1.5 block text-[var(--text-secondary)]">
                      {t('teams.teamName')}
                    </label>
                    <input
                      type="text"
                      value={config.name}
                      onChange={(e) => updateField('name', e.target.value.slice(0, 50))}
                      placeholder={t('teams.namePlaceholder')}
                      maxLength={50}
                      className={cn(inputClass, 'w-full')}
                    />
                  </div>

                  <div>
                    <label className="type-label mb-1.5 block text-[var(--text-secondary)]">
                      {t('teams.description')}
                    </label>
                    <input
                      type="text"
                      value={config.description}
                      onChange={(e) => updateField('description', e.target.value.slice(0, 200))}
                      placeholder={t('teams.teamBuilderDescPlaceholder')}
                      maxLength={200}
                      className={cn(inputClass, 'w-full')}
                    />
                  </div>

                  <div>
                    <div className="flex items-center gap-1.5 type-label mb-2 text-[var(--text-secondary)]">
                      <Users size={14} />
                      {t('teams.wizard.agentCount', { count: config.agents.length })}
                    </div>
                    <div className="space-y-2">
                      {config.agents.map((agent, i) => (
                        <div
                          key={`${agent.name}-${i}`}
                          className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)]"
                        >
                          <button
                            type="button"
                            onClick={() => setExpandedAgent(expandedAgent === i ? null : i)}
                            className="flex w-full items-center gap-2 px-3 py-2 cursor-pointer"
                          >
                            {expandedAgent === i ? (
                              <ChevronDown size={12} className="text-[var(--text-muted)]" />
                            ) : (
                              <ChevronRight size={12} className="text-[var(--text-muted)]" />
                            )}
                            <span className="type-body font-medium text-[var(--text-primary)] flex-1 text-left truncate">
                              {agent.name || t('teams.teamBuilderNewAgent')}
                            </span>
                            {agent.role === 'coordinator' && (
                              <span className="inline-flex items-center gap-1 type-meta text-[var(--accent)]">
                                <Crown size={10} />
                              </span>
                            )}
                          </button>
                          {expandedAgent === i && (
                            <div className="px-3 pb-3 space-y-2 border-t border-[var(--border-subtle)]">
                              <div className="flex items-center gap-2 pt-2">
                                <span
                                  className={cn(
                                    'type-meta px-1.5 py-0.5 rounded',
                                    agent.role === 'coordinator'
                                      ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                                      : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]',
                                  )}
                                >
                                  {agent.role === 'coordinator'
                                    ? t('teams.wizard.coordinator')
                                    : t('teams.wizard.worker')}
                                </span>
                                {agent.model && (
                                  <span className="type-meta text-[var(--text-muted)] truncate">{agent.model}</span>
                                )}
                              </div>
                              {agent.description && (
                                <p className="type-meta text-[var(--text-secondary)] leading-relaxed">
                                  {agent.description}
                                </p>
                              )}
                              {agent.identity && (
                                <p className="type-meta text-[var(--text-muted)] leading-relaxed italic">
                                  {agent.identity}
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                      {config.agents.length === 0 && (
                        <p className="type-meta text-[var(--text-muted)] text-center py-4">
                          {t('teams.teamBuilderNoAgents')}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="border-t border-[var(--border-subtle)] p-4">
                  <Button
                    variant="default"
                    size="default"
                    className="w-full gap-2"
                    disabled={!isValid}
                    onClick={handleCreate}
                  >
                    {t('teams.teamBuilderCreate')}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </DialogContent>

      <ConfirmDialog
        open={confirmOpen}
        title={t('common.discardChangesTitle')}
        description={t('common.discardChangesDesc')}
        confirmLabel={t('common.discard')}
        onConfirm={confirmDiscard}
        onCancel={cancelDiscard}
      />
    </Dialog>
  );
}

/** 导出是为了能**直接渲染它**测那条实机教训：失败原因必须上屏（见 `test/install-progress-reason.test.tsx`）。 */
export function InstallProgress({
  status,
  events,
  progressPercent,
  agents,
}: {
  status: 'idle' | 'installing' | 'done' | 'error';
  events: InstallEvent[];
  progressPercent: number;
  /**
   * 只收「它真正用到的那部分」：这个面板只读助手的 `name`（换算成 slug 去对事件），
   * 而 `buildInstallEventView` 收的也正是 `ReadonlyArray<{ name: string }>`。
   *
   * ⚠️ 写成 `AgentConfig[]` 是**过度约束**：`test/install-progress-reason.test.tsx`
   *    要造的就是"两个只有名字的助手"，于是 `typecheck:tests` 报
   *    「缺少 role/description/model/identity」（既有红，2026-09-20 修）。
   */
  agents: ReadonlyArray<{ name: string }>;
}) {
  const { t } = useTranslation();

  /**
   * ⚠️ 2026-09-20 U 盘交付实机（截图 4）：这里原来自己数事件，**只认
   *    `agent_creating`/`agent_created`/`warning` 三种状态**，逐助手的
   *    `warning.message`（里面才是网关的失败原文）**从头到尾没渲染过**，
   *    于是"四个助手全建失败"上屏的只剩「安装失败」+ 四行 slug +
   *    一句大写英文 `NO AGENTS WERE CREATED SUCCESSFULLY`。
   *    ⇒ 改用与「创建团队」面板**同一份**事件视图（`lib/install-event-view`），
   *      并把行上的告警原因渲染出来。
   */
  const { agentStates, teamSaved, globalWarnings, globalError } = useMemo(
    () => buildInstallEventView(agents, events),
    [agents, events],
  );

  return (
    <div className="flex flex-col h-full p-4">
      <div className="space-y-3 mb-4">
        <span className="type-label text-[var(--text-secondary)]">
          {status === 'installing' && t('teams.wizard.installing')}
          {status === 'done' && t('teams.wizard.installComplete')}
          {status === 'error' && t('teams.wizard.installError')}
        </span>
        <div className="h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
          <div
            className={cn(
              'h-full rounded-full transition-all duration-300',
              status === 'error' ? 'bg-[var(--text-danger)]' : 'bg-[var(--accent)]',
            )}
            style={{ width: `${status === 'done' ? 100 : progressPercent}%` }}
          />
        </div>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto">
        {agentStates.map((agent) => (
          <div key={agent.slug} className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2">
            <div className="flex items-center gap-2">
              {agent.status === 'pending' && <div className="h-3 w-3 rounded-full border border-[var(--border)]" />}
              {agent.status === 'creating' && <Loader2 size={12} className="animate-spin text-[var(--text-muted)]" />}
              {agent.status === 'created' && <Check size={12} className="text-[var(--accent)]" />}
              {agent.status === 'warning' && <AlertTriangle size={12} className="text-[var(--text-warning)]" />}
              <span className="type-body text-[var(--text-primary)] flex-1 truncate">{agent.slug}</span>
            </div>
            {/* ⚠️ 逐助手的失败原文：**必须上屏**，否则用户和我们都没有可读的原因 */}
            {agent.warnings.length > 0 && (
              <div className="mt-1 space-y-0.5">
                {agent.warnings.map((w, i) => (
                  <div key={i} className="flex items-start gap-1.5 type-meta text-[var(--text-warning)]">
                    <AlertTriangle size={10} className="mt-0.5 flex-shrink-0" />
                    <InstallMessageLine message={w} />
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}

        {teamSaved && (
          <div className="flex items-center gap-2 px-3 py-2 type-meta text-[var(--accent)]">
            <Check size={12} />
            {t('teams.wizard.teamSaved')}
          </div>
        )}

        {globalWarnings.map((w, i) => (
          <div key={i} className="flex items-center gap-2 px-3 py-2 type-meta text-[var(--text-warning)]">
            <AlertTriangle size={12} />
            <InstallMessageLine message={w} />
          </div>
        ))}

        {globalError && (
          <div className="flex items-center gap-2 px-3 py-2 type-meta text-[var(--text-danger)]">
            <AlertTriangle size={12} />
            <InstallMessageLine message={globalError} />
          </div>
        )}
      </div>
    </div>
  );
}
