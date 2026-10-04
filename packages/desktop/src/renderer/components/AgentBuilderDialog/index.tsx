import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Sparkles, Send, Loader2, Bot, User, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { buildResponseLanguageContext } from '@/lib/response-language';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import MarkdownContent from '@/components/MarkdownContent';
import { useUiStore } from '@/stores/uiStore';
import { useSystemSession } from '@/hooks/useSystemSession';
import type { ModelCatalogEntry } from '@clawwork/shared';
import { serializeIdentityMd } from '@clawwork/core';
import { createAgentWithRollback, deriveAgentCreationId } from '@/lib/agent-builder';
import { checkInstallWorkspace } from '@/lib/install-workspace';
import { resolveCommercialDefaultModel } from '@/lib/commercial-default-model';
import { relayModelsFrom } from '@/components/ChatInput/model-families';
import { canonicalModelRef, resolveTeamModelRef } from '@/lib/team-model-ref';

/**
 * AI 引导多久没吐出新内容就认定「卡住了」并给出跳过入口。
 *
 * 2026-09-17 实机：引导侧会话跑在主助手的模型上，那个模型卡在 `starting_model`
 * 十几秒不出字，用户以为整个「创建智能体」坏了（真正的 `agents.create` 从未执行）。
 * 引导只是**辅助**，绝不能让主流程看起来像死了。
 */
const GUIDANCE_STALL_HINT_MS = 12_000;

interface AgentConfig {
  name: string;
  description: string;
  model: string;
  identity: string;
}

const EMPTY_CONFIG: AgentConfig = { name: '', description: '', model: '', identity: '' };

const EMPTY_MODELS: ModelCatalogEntry[] = [];

const SYSTEM_PROMPT_TEMPLATE = `You are an Agent creation assistant for Rongying Cube. Help the user create a new AI Agent through guided conversation.

Your job:
1. Ask what kind of Agent the user wants and what it should do
2. Based on their description, suggest a name, a short description (one-line summary of capabilities for multi-agent coordination), and draft an identity (system prompt that defines the Agent's role, expertise, and behavior)
3. Recommend a model from the available list: {{modelList}}
4. After each response, include a structured block with current config

Rules:
- Ask ONE question at a time
- Be proactive: extract name, description, and identity from the user's first description
- All user-visible names, descriptions and identities must use the requested response language. The client derives internal identifiers separately.
- The description should be a brief capability summary (under 200 chars) used by conductor agents to understand what this agent can do
- Keep identity concise but specific (2-4 sentences)
- Always end your response with the current config as a JSON block
- Only include fields whose values have been determined. Do NOT include fields with placeholder values like "..."
- Example with three determined fields:

\`\`\`agent-config
{"name": "Code Review Helper", "description": "Expert in code review, security audit, and best practices enforcement", "identity": "A code review assistant that..."}
\`\`\`

Respond in {{language}}.

Now begin by asking what kind of Agent the user wants to create.`;

const CONFIG_BLOCK_RE = /\n?```agent-config\n([\s\S]*?)\n```\n?/g;
const CONFIG_BLOCK_PARTIAL_RE = /\n?```agent-config[\s\S]*$/;

function parseAgentConfig(text: string): Partial<AgentConfig> | null {
  const matches = [...text.matchAll(CONFIG_BLOCK_RE)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  try {
    return JSON.parse(last[1]);
  } catch {
    return null;
  }
}

function stripConfigBlock(text: string): string {
  let result = text.replace(CONFIG_BLOCK_RE, '');
  result = result.replace(CONFIG_BLOCK_PARTIAL_RE, '');
  return result.trim();
}

const inputClass = cn(
  'flex-1 h-[var(--density-control-height-lg)] px-3 py-2 rounded-md',
  'bg-[var(--bg-tertiary)] border border-[var(--border)]',
  'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
  'outline-none ring-accent-focus transition-colors',
);

interface AgentBuilderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gatewayId: string;
  onCreated?: () => void;
}

export default function AgentBuilderDialog({ open, onOpenChange, gatewayId, onCreated }: AgentBuilderDialogProps) {
  const { t, i18n } = useTranslation();
  const { status, messages, error, start, send, end } = useSystemSession();

  const modelCatalogByGateway = useUiStore((s) => s.modelCatalogByGateway);
  const agentCatalogByGateway = useUiStore((s) => s.agentCatalogByGateway);
  const catalog = modelCatalogByGateway[gatewayId] ?? EMPTY_MODELS;
  const models = useMemo(() => relayModelsFrom(catalog).filter((model) => model.available !== false), [catalog]);
  const defaultAgentId = agentCatalogByGateway[gatewayId]?.defaultId ?? 'main';

  const [config, setConfig] = useState<AgentConfig>(EMPTY_CONFIG);
  const [userEdited, setUserEdited] = useState<Set<string>>(new Set());
  const [input, setInput] = useState('');
  const [creating, setCreating] = useState(false);
  const [stalled, setStalled] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const prevStatusRef = useRef(status);
  const startedRef = useRef(false);

  // 用**当前确实可用**的模型，而不是主助手配的那个：侧会话以主助手身份建立会继承它的模型，
  // 而实机就是那个模型卡住了（见 GUIDANCE_STALL_HINT_MS 的注释）。
  const availableModelId = useMemo(
    () =>
      resolveTeamModelRef(resolveCommercialDefaultModel(models)?.id, models) ||
      (models[0] ? canonicalModelRef(models[0]) : ''),
    [models],
  );

  useEffect(() => {
    if (!open) {
      startedRef.current = false;
      return;
    }
    if (startedRef.current) return;
    if (!availableModelId) return;
    startedRef.current = true;

    // ⚠️ 这里**不重置** `config`：用户关掉再打开时必须还能看到自己填的草稿
    //（2026-09-17 之前每次打开都清空，等于让人重填一遍）。只有真的创建成功后才清。
    setInput('');
    setCreating(false);
    setStalled(false);

    const modelListStr = models.map(canonicalModelRef).join(', ');
    const prompt = SYSTEM_PROMPT_TEMPLATE.replace('{{modelList}}', modelListStr || 'default')
      .replace('{{language}}', i18n.language)
      .concat(
        '\n\n',
        buildResponseLanguageContext(i18n.language),
        '\nThe generated identity must retain this response-language policy in the requested language, including the user override.',
      );

    start({
      gatewayId,
      agentId: defaultAgentId,
      purpose: 'agent-builder',
      model: availableModelId,
      initialMessage: prompt,
    });
  }, [open, gatewayId, defaultAgentId, models, start, i18n.language, availableModelId]);

  // 表单里先把可用模型选上：AI 没给出建议（或干脆没响应）时也能一键创建。
  // 不算「用户编辑」，所以之后 AI 给了别的建议仍然可以覆盖它。
  useEffect(() => {
    if (!availableModelId) return;
    setConfig((prev) => (prev.model ? prev : { ...prev, model: availableModelId }));
  }, [availableModelId]);

  // 引导卡住检测：streaming 期间只要**有新内容**就重新计时（deltas 会换掉 messages 引用）。
  useEffect(() => {
    if (status !== 'streaming') {
      setStalled(false);
      return;
    }
    const timer = setTimeout(() => setStalled(true), GUIDANCE_STALL_HINT_MS);
    return () => clearTimeout(timer);
  }, [status, messages]);

  const skipGuidance = useCallback(() => {
    setStalled(false);
    void end();
  }, [end]);

  useEffect(() => {
    if (status === 'streaming' || (prevStatusRef.current === 'streaming' && status === 'active')) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === 'assistant') {
        const parsed = parseAgentConfig(lastMsg.content);
        if (parsed) {
          setConfig((prev) => ({
            name: userEdited.has('name') ? prev.name : (parsed.name ?? prev.name),
            description: userEdited.has('description') ? prev.description : (parsed.description ?? prev.description),
            model: userEdited.has('model') ? prev.model : (parsed.model ?? prev.model),
            identity: userEdited.has('identity') ? prev.identity : (parsed.identity ?? prev.identity),
          }));
        }
      }
    }
    prevStatusRef.current = status;
  }, [status, messages, userEdited]);

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

  const updateConfigField = useCallback((field: keyof AgentConfig, value: string) => {
    setConfig((prev) => ({ ...prev, [field]: value }));
    setUserEdited((prev) => {
      const next = new Set(prev);
      if (value) {
        next.add(field);
      } else {
        next.delete(field);
      }
      return next;
    });
  }, []);

  const handleCreate = useCallback(async () => {
    if (!config.name.trim()) return;
    setCreating(true);

    try {
      const model = resolveTeamModelRef(config.model, models);
      if (!model) {
        toast.error(t('chatInput.modelGone', { model: config.model || t('chatInput.noModelsAvailable') }));
        return;
      }
      const existingAgents = agentCatalogByGateway[gatewayId]?.agents;
      const slug = deriveAgentCreationId(config.name, existingAgents);
      // ⚠️ 不许再用 `wsBase ? `${wsBase}/${slug}` : slug`（2026-09-20，T-a28 同族）：
      //    拿不到工作区时**发出去的 slug 是相对路径**，而 `agents.create` 是**另一个进程**
      //    按它自己的 cwd 解析 ⇒ 助手的文件落在谁也没预期的地方，且界面不报错。
      //    判据与模板安装 / 团队安装同一份（`checkInstallWorkspace`）：坏输入一个请求都不发。
      const wsCheck = checkInstallWorkspace(await window.clawwork.getWorkspacePath());
      if (!wsCheck.ok) {
        toast.error(wsCheck.message);
        return;
      }
      const workspace = `${wsCheck.path}/${slug}`;

      const identityContent =
        config.identity.trim() || config.description.trim()
          ? serializeIdentityMd(config.description.trim() || undefined, config.identity.trim())
          : '';

      // ⚠️ 走 createAgentWithRollback：任一步失败都会把刚建的 agent 删掉。
      //    原先这里是手写的三步、**没有回滚** ⇒ 写 IDENTITY.md 失败会在网关里
      //    留下一个半成品助手（用户看得见、用不了）。另两条创建路径（预置助手、
      //    模板安装）一直都有回滚，这条是漏网的。
      const createRes = await createAgentWithRollback(window.clawwork, {
        gatewayId,
        name: config.name.trim(),
        workspace,
        model,
        identityContent: identityContent || undefined,
        existingAgents,
      });
      if (!createRes.ok) {
        toast.error(createRes.error ?? t('errors.failed'));
        return;
      }

      await end();
      // 创建**成功**之后才清草稿：关掉再打开时用户填过的东西要还在
      setConfig(EMPTY_CONFIG);
      setUserEdited(new Set());
      toast.success(t('settings.agentCreated'));
      onCreated?.();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('errors.failed'));
    } finally {
      setCreating(false);
    }
  }, [config, models, gatewayId, agentCatalogByGateway, end, onCreated, onOpenChange, t]);

  const requestClose = useCallback(() => {
    if (creating) return;
    const hasConversation = messages.length > 1;
    if (hasConversation && !window.confirm(t('settings.agentBuilderCloseConfirm'))) return;
    end();
    onOpenChange(false);
  }, [creating, messages.length, end, onOpenChange, t]);

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        className="max-w-5xl p-0 overflow-hidden [&>button:last-child]:hidden"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader className="relative px-6 pt-5 pb-0">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles size={18} className="text-[var(--accent)]" />
            {t('settings.agentBuilderTitle')}
          </DialogTitle>
          <DialogDescription>{t('settings.agentBuilderDesc')}</DialogDescription>
          <button
            type="button"
            onClick={requestClose}
            disabled={creating}
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
              {models.length === 0 && (
                <p className="type-support text-center text-[var(--text-muted)]">
                  {t('chatInput.noModelsAvailable')} {t('chatInput.noModelsAvailableDetail')}
                </p>
              )}
              <div ref={messagesEndRef} />
            </div>

            {stalled && (
              <div
                className="mx-4 mb-2 rounded-lg px-3 py-2 type-support"
                style={{ background: 'var(--bg-warning)', color: 'var(--text-secondary)' }}
                data-testid="agent-builder-stalled"
              >
                {t('settings.agentBuilderStalled')}
              </div>
            )}

            <div className="flex items-center justify-between gap-2 px-4 pb-2">
              {/* 引导只是辅助：任何时候都要能跳过，不能因为侧会话没响应就让「创建」看起来坏掉 */}
              <button
                type="button"
                onClick={skipGuidance}
                className="type-support text-[var(--text-muted)] underline-offset-2 transition-colors hover:text-[var(--text-primary)] hover:underline"
              >
                {t('settings.agentBuilderSkip')}
              </button>
            </div>

            <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] px-4 py-3">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('settings.agentBuilderInputPlaceholder')}
                disabled={status === 'streaming' || status === 'idle'}
                className={cn(inputClass, 'w-full')}
              />
              <Button
                variant="default"
                size="icon"
                onClick={handleSend}
                disabled={!input.trim() || status === 'streaming'}
              >
                {status === 'streaming' ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              </Button>
            </div>
          </div>

          <div className="flex w-80 flex-col">
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div className="flex items-center gap-3 pb-3 border-b border-[var(--border-subtle)]">
                <div className="w-10 h-10 rounded-xl bg-[var(--bg-tertiary)] flex items-center justify-center">
                  <Bot size={20} className="text-[var(--text-muted)]" />
                </div>
                <span className="type-label text-[var(--text-primary)] truncate">
                  {config.name || t('settings.agentBuilderPreviewTitle')}
                </span>
              </div>

              <div>
                <label className="type-label mb-1.5 block text-[var(--text-secondary)]">
                  {t('settings.agentName')}
                </label>
                <input
                  type="text"
                  value={config.name}
                  onChange={(e) => updateConfigField('name', e.target.value)}
                  placeholder={t('settings.agentNamePlaceholder')}
                  className={cn(inputClass, 'w-full')}
                />
              </div>

              <div>
                <label className="type-label mb-1.5 block text-[var(--text-secondary)]">
                  {t('settings.agentDescription')}
                </label>
                <input
                  type="text"
                  value={config.description}
                  onChange={(e) => updateConfigField('description', e.target.value.slice(0, 200))}
                  placeholder={t('settings.agentDescriptionPlaceholder')}
                  maxLength={200}
                  className={cn(inputClass, 'w-full')}
                />
              </div>

              <div>
                <label className="type-label mb-1.5 block text-[var(--text-secondary)]">
                  {t('settings.agentModel')}
                </label>
                <select
                  value={config.model}
                  onChange={(e) => updateConfigField('model', e.target.value)}
                  className={cn(inputClass, 'w-full')}
                >
                  <option value="">{t('settings.agentModelPlaceholder')}</option>
                  {models.map((m) => (
                    <option key={m.id} value={canonicalModelRef(m)}>
                      {m.name ?? m.id}
                      {m.provider ? ` (${m.provider})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex-1">
                <label className="type-label mb-1.5 block text-[var(--text-secondary)]">
                  {t('settings.agentBuilderIdentity')}
                </label>
                <textarea
                  value={config.identity}
                  onChange={(e) => updateConfigField('identity', e.target.value)}
                  placeholder={t('settings.agentBuilderIdentityPlaceholder')}
                  rows={6}
                  className={cn(inputClass, 'h-auto w-full resize-none leading-relaxed')}
                />
              </div>
            </div>

            <div className="border-t border-[var(--border-subtle)] p-4">
              <Button
                variant="default"
                size="default"
                className="w-full gap-2"
                disabled={!config.name.trim() || creating}
                onClick={handleCreate}
              >
                {creating && <Loader2 size={14} className="animate-spin" />}
                {t('settings.agentBuilderCreate')}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
