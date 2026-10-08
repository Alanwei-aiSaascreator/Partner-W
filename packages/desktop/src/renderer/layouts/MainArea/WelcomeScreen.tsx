import { useEffect } from 'react';
import { ChevronRight } from 'lucide-react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import AgentIcon from '@/components/AgentIcon';
import AgentMissingNotice from '@/components/AgentMissingNotice';
import GatewayInstanceSelector from '@/components/GatewayInstanceSelector';
import { useGatewaySelector } from '@/hooks/useGatewaySelector';
import { resolveCommercialDefaultModel } from '@/lib/commercial-default-model';
import { resolveModelLabel } from '@/lib/model-display';
import { PRESET_AGENT_IDS, resolveAssistantWorkspace } from '@/lib/preset-agents';
import { ASSISTANT_ID_BY_WORKSPACE } from '@/lib/assistant-task-presets';
import type { OnboardingProfile } from '@/lib/user-onboarding';
import { cn } from '@/lib/utils';
import { useTaskStore } from '@/stores/taskStore';
import { useUiStore } from '@/stores/uiStore';
import { motion as animationPresets } from '@/styles/design-tokens';
import { relayModelsFrom } from '@/components/ChatInput/model-families';
import type { AssistantTaskPreset } from '@/lib/assistant-task-presets';
import { removeAssistantTaskPresetTags } from '@/lib/assistant-task-preset-tags';
import {
  DEFAULT_TASK_MODE,
  normalizeTaskModeSetting,
  resolveModeModelId,
  type TaskMode,
  type TaskModeSetting,
} from '@clawwork/shared';
import AssistantTaskWorkbench from './AssistantTaskWorkbench';

/**
 * ⭐ 2026-10-06（V1 收口 · 欢迎屏降级）：
 *
 * 1. **默认当前助手 = 主罗盘**。以前这里拿引导画像的「用途」去推荐一个六类预置助手
 *    （`resolveProfileAssistantId`，2026-10-07 质检 P2-2 **已删**：候选集只剩主罗盘，
 *    那层循环永远不可能命中），于是内容创作/电商运营这些**能力**被摆成了用户的
 *    一级身份。现在契约是「主罗盘 + 五岗位；六类 = Skill/能力」⇒ 默认永远是罗盘，
 *    待发任务点名的助手（`pendingNewTask.agentId`）不受影响，仍然优先。
 * 2. **「当前助手」chip 区不把六类当一级入口**：只放当前助手 + 非预置助手（比如团队
 *    里装的业务助手）；当前助手恰好是某个预置助手时仍然显示它（否则用户看不见自己在用谁）。
 */
const PRESET_IDS: readonly string[] = PRESET_AGENT_IDS;

/**
 * 三档模式的人话（i18n key）。与 `ChatInput/index.tsx` 里那份是**同一组文案**，各自写
 * 字面量常量：i18n 门禁的"代码 → 词表"方向要能在源码里扫到键（拼字符串扫不到）。
 */
const TASK_MODE_LABEL_KEYS: Record<TaskMode, string> = {
  fast: 'chatInput.mode.fast',
  smart: 'chatInput.mode.smart',
  deep: 'chatInput.mode.deep',
};

interface WelcomeScreenProps {
  /**
   * ⚠️ 2026-10-07（质检 P2-2）：**保留字段，不再参与"默认当前助手"的挑选** ——
   * 一级身份固定是主罗盘，画像只影响工作资料展示（调用方仍传，省得动一片测试）。
   */
  onboardingProfile: OnboardingProfile;
  recentPresetIds: readonly string[];
  onSelectPreset: (preset: AssistantTaskPreset, prompt: string) => void;
  onCustomTask: () => void;
  onAssistantChange: () => void;
  conversationReady?: boolean;
  /**
   * **已知失败**的本地化结论（`null` / 缺省 = 没有已知失败）。
   * 由 `deriveStartupReadiness` 已经算出来的东西经 `startupFailureText` 翻出来
   * —— 这一屏**不重新推断**（重新推断就会各说各的）。
   */
  failureText?: string | null;
}

export default function WelcomeScreen({
  recentPresetIds,
  onSelectPreset,
  onCustomTask,
  onAssistantChange,
  conversationReady = true,
  failureText = null,
}: WelcomeScreenProps) {
  const { t } = useTranslation();
  const pendingNewTask = useTaskStore((state) => state.pendingNewTask);
  const setSelectedAgent = useUiStore((state) => state.setSelectedAgent);
  const setMainView = useUiStore((state) => state.setMainView);
  // ⭐ 默认当前助手**直接写常量**（2026-10-07 质检 P2-2）：一级身份只有主罗盘，
  //    六类预置降级为 Skill/能力（入口在切换器的「技能与能力」折叠组里），
  //    画像的 useCases 不再参与挑选 —— 那层"推荐"是死的（候选集只剩主罗盘）。
  const preferredAgentId = ASSISTANT_ID_BY_WORKSPACE.compass;
  const {
    gateways,
    selectedGwId,
    setSelectedGwId,
    agentCatalog,
    effectiveAgentId,
    missingRequestedAgentId,
    setSelectedAgentId,
  } = useGatewaySelector({
    initialGatewayId: pendingNewTask?.gatewayId,
    initialAgentId: pendingNewTask?.agentId ?? preferredAgentId,
    // ⭐ **只有待发任务点名的助手才算"请求"**；`preferredAgentId` 是画像的**推荐**，
    //    它不参与拒绝 —— 否则新机器上"正在安装"的预置助手会被说成"不在本机"（独立复核 I-1）。
    requestedAgentId: pendingNewTask?.agentId,
  });
  const rawModelCatalog = useUiStore((state) => (selectedGwId ? state.modelCatalogByGateway[selectedGwId] : undefined));
  /** 与发送路径同一把尺：先过 `relayModelsFrom`（网关返回的是全量目录，含我们服务不了的）。 */
  const serviceableCatalog = relayModelsFrom(rawModelCatalog ?? []);
  const defaultModel = resolveCommercialDefaultModel(serviceableCatalog);
  const selectedModelId = pendingNewTask?.gatewayId === selectedGwId ? pendingNewTask.model : undefined;
  /**
   * ⭐ FEAT-01（2026-10-08）：**chip 说的是"将要跑什么"，不是"上次跑过什么"**。
   *
   * 新任务在 `createTask` 里就写入默认档（智能），发送路径按 `MODE_POLICY` 对着目录
   * **现解析**模型（智能/深度 = `qwen3.7-flash`，快速 = 别名缺席时回退基础模型）；
   * 而 `pending.model` 只是那条"留痕"（商业默认模型）。此前 chip 直接显示留痕 ⇒
   * 用户看到的模型和真跑的模型对不上（2026-09-17 实机老账的同一类）。
   *
   * 规则（与 `useChatSend` 的发送判据逐条对齐）：
   *   · 待发态的模式：没选过 = 默认档（与 `createTask` 写入的默认档一致）；
   *   · 模式档位下能解析出模型 ⇒ 显示「模式名 · 模型名」；
   *   · 解析不出（目录没拉到 / 模型下架）⇒ 显示 `pending.model` —— 那正是发送路径的
   *     回退目标（`resolveModeModelId` 返回 undefined 时它保持现状），不硬编也不说谎。
   */
  const pendingMode: TaskModeSetting =
    pendingNewTask?.gatewayId === selectedGwId
      ? (normalizeTaskModeSetting(pendingNewTask?.mode) ?? DEFAULT_TASK_MODE)
      : DEFAULT_TASK_MODE;
  const modeDriven = pendingMode !== 'custom';
  const modeModelId = modeDriven
    ? resolveModeModelId(
        pendingMode,
        serviceableCatalog.map((entry) => entry.id),
      )
    : undefined;
  const modeModelLabel = modeModelId ? (resolveModelLabel(modeModelId, rawModelCatalog) ?? modeModelId) : undefined;
  const modelLabel =
    modeDriven && modeModelLabel
      ? `${t(TASK_MODE_LABEL_KEYS[pendingMode])} · ${modeModelLabel}`
      : selectedModelId
        ? (resolveModelLabel(selectedModelId, rawModelCatalog) ?? selectedModelId)
        : // ⚠️ 已知失败时不许回落"正在准备模型…"：那一步**永远不会**发生（2026-09-21 第二台机器实机）。
          //    这一格说的是"手上没有能用的模型"，与失败是哪一种无关（所以措辞不许断言目录缺失）。
          (defaultModel?.label ?? (failureText ? t('chatInput.modelsUnusable') : t('chatInput.modelsLoading')));
  const definition = resolveAssistantWorkspace(effectiveAgentId);
  const currentAgent = agentCatalog.find((agent) => agent.id === effectiveAgentId);
  const firstLevelAgents = [
    ...(currentAgent ? [currentAgent] : []),
    ...agentCatalog.filter((agent) => agent.id !== currentAgent?.id && !PRESET_IDS.includes(agent.id)),
  ].slice(0, 3);
  // 目录里只有预置助手（比如罗盘还没装好）时别把 chip 区清空 —— 那会变成"切不了助手"。
  const visibleAgents = firstLevelAgents.length > 0 ? firstLevelAgents : agentCatalog.slice(0, 3);
  const hiddenAgentCount = Math.max(0, agentCatalog.length - visibleAgents.length);

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
          failureText={failureText}
          recentPresetIds={recentPresetIds}
          onSelectPreset={(preset) => onSelectPreset(preset, t(preset.promptKey))}
          onCustomTask={onCustomTask}
        />
      ) : (
        <section className="mx-auto flex w-full max-w-[var(--content-max-width)] flex-col items-center px-2 py-5 text-center">
          {/* ⭐ 点名要的助手不在本机 ⇒ **不冒充**成别的助手：这一屏就是通用欢迎屏，
              上面如实说清，并给两条走得通的出口（2026-09-24）。 */}
          {missingRequestedAgentId ? (
            <AgentMissingNotice
              agentId={missingRequestedAgentId}
              // ⚠️ 罗盘自己也不在目录里时**不渲染这个按钮** —— 否则一边说"不在本机"、
              //    一边给一个指向同样不存在的助手的出口（2026-09-24 独立复核 M-2）。
              //    拒绝态必然意味着**目录已加载**，所以这里的 `some` 判据是有效的。
              onSwitchAssistant={
                agentCatalog.some((agent) => agent.id === ASSISTANT_ID_BY_WORKSPACE.compass)
                  ? () => handleSelectAgent(ASSISTANT_ID_BY_WORKSPACE.compass)
                  : undefined
              }
              onOpenTeams={() => setMainView('teams')}
              className="mb-4 w-full text-left"
            />
          ) : null}
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
          {visibleAgents.map((agent) => (
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
          {hiddenAgentCount > 0 && (
            <span className="type-support inline-flex items-center gap-1 px-2 py-2 text-[var(--text-muted)]">
              +{hiddenAgentCount}
              <ChevronRight size={12} />
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
}
