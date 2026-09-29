import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, RotateCcw, Sparkles, SquarePen, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from '@/lib/toast';
import { useUiStore } from '@/stores/uiStore';
import { useTaskStore } from '@/stores/taskStore';
import { useSelectAgent } from '@/hooks/useSelectAgent';
import { fetchAgentsForGateway } from '@/hooks/useGatewayBootstrap';
import AgentMissingNotice from '@/components/AgentMissingNotice';
import { resolveRequestedAgentForAction } from '@/lib/requested-agent';
import { PRESET_AGENT_IDS, resolveAssistantWorkspace } from '@/lib/preset-agents';
import {
  IDENTITY_DEFAULT_TAGS,
  IDENTITY_PERSONA_TAGS,
  USER_MD_MAX_CHARS,
  buildIdentityBlock,
  mergeIdentityIntoUserMd,
  nextTagSelection,
  type IdentityTagId,
} from '@/lib/identity-persona';

/**
 * 身份中心。
 *
 * ## v2（2026-09-26）：把"展示"换成**真的**
 *
 * 用户真机反馈「身份中心里面改不了，重新选择、换标签这些点击没反应」。
 * 真机复现（CDP 真实鼠标事件，盘上 0.0.34）的结论是：**不是事件坏了** ——
 * 五个标签、重新选择、换一个标签、应用、保存**全都真的执行**；
 * 坏的是**页面承诺的事一件都没发生**：
 *
 * | 页面元素 | v1（被反馈的那版） | v2（现在） |
 * | --- | --- | --- |
 * | 客群 | 四张**死卡**（`cursor:auto`、没有 onClick，名字还是设计稿编的） | **真实助手**七个，点一下真的切（`useSelectAgent`） |
 * | 画像正文 | **常量**，点什么都不变 | 随（客群 + 标签）**实时变** |
 * | 推荐技能 | 七个**网关里不存在**的技能名 | 该助手**真实能做的四件事**（`resolveAssistantTaskPresets`） |
 * | 保存 | 只写 localStorage（用户看不见任何变化） | **合并写进每个助手的 `USER.md`**（运行时每轮都读它） |
 * | 应用 | 写死切「高效办公」 | 切**当前选中的客群** |
 *
 * ⚠️ 教训写在这里：`identity-center.test.tsx` v1 有 16 条全绿，而它测的是
 *    「按钮有没有 handler」；**jsdom 测得到 handler，测不到"点了以后世界有没有变化"**。
 *    v2 的断言改成"点下去看得见什么"，并单独钉了一条"画像正文跟着变"。
 */

/** 页面上的客群顺序：罗盘打头，其余按预置清单的顺序。 */
const IDENTITY_AGENT_IDS: readonly string[] = ['main', ...PRESET_AGENT_IDS];

export default function IdentityCenter() {
  const { t } = useTranslation();
  const gatewayId = useUiStore((s) => s.defaultGatewayId);
  const selectAgent = useSelectAgent();
  const [selected, setSelected] = useState<IdentityTagId[]>(IDENTITY_DEFAULT_TAGS);
  /** 目录**已加载**但点名的助手不在里面时，提示里要显示的 id（`null` = 没有这回事）。 */
  const [missingAgentId, setMissingAgentId] = useState<string | null>(null);
  const catalogEntry = useUiStore((s) => (gatewayId ? s.agentCatalogByGateway[gatewayId] : undefined));
  const setMainView = useUiStore((s) => s.setMainView);
  const selectedAgentByGateway = useUiStore((s) => s.selectedAgentByGateway);

  /**
   * 当前客群 = 应用里**正在用的那个助手**（与左侧「我的助手」同一份状态）。
   * 不另立一份"我在这一页选了谁" —— 两份必然漂移，而漂移的表现就是
   * "这一页说电商运营、左边写罗盘助手"。
   */
  const currentAgentId =
    (gatewayId ? selectedAgentByGateway[gatewayId] : undefined) || catalogEntry?.defaultId || 'main';
  const workspace = resolveAssistantWorkspace(currentAgentId) ?? resolveAssistantWorkspace('main')!;

  const tagLabels = selected.map((id) => t(`identity.tag.${id}`));
  const groupLabel = t(workspace.titleKey);
  const personaLine = `${t(workspace.descriptionKey)}｜${tagLabels.length > 0 ? tagLabels.join('、') : '—'}`;

  /**
   * 「应用」= 把当前客群**真的切成当前助手**（走 `useSelectAgent`，与左侧
   * 「我的助手」切换器**同一条路**：改选择 + 改待发任务 + 离开旧会话 + 回到对话）。
   *
   * ⚠️ 没有网关时**如实报错**，不假装成功（本项目栽过"把不确定说成确定"）。
   * ⭐ 目录已加载时直接使用权威结论；目录还没拉回来时强制刷新一次。
   * 这样既不把 loading 误报成缺失，也不把 loading 当成可以盲目切换的 ok。
   */
  const startNewTask = useTaskStore((s) => s.startNewTask);

  /**
   * ⭐ **判据只此一处**（2026-09-29）：目录**已加载**、而点名的助手不在里面 ⇒
   * 如实说明，并且**不做那件事**（不切、不开任务）。返回 `true` = 已被拒绝。
   *
   * 目录 `loading` 也不是放行证：必须强制刷新一次，重读 store 里的权威目录。
   * 刷新失败时既不误报“助手缺失”，也不得切换或开任务。
   *
   * ⚠️ 这一页原来有**三个**入口会切助手/开任务，但只有「应用此画像」接了判据；
   * 点客群卡与「用它开任务」没接 ⇒ 用户点的是一个不存在的助手，
   * 却要等**跳进对话页之后**由欢迎屏告诉他 —— `TeamsPanel` 的注释明确反对这种"跳过去才说"。
   */
  const refuseIfAgentUnavailable = useCallback(
    async (agentId: string): Promise<boolean> => {
      if (!gatewayId) return true;
      const decision = await resolveRequestedAgentForAction({
        requestedAgentId: agentId,
        readCatalog: () => useUiStore.getState().agentCatalogByGateway[gatewayId],
        refresh: () => fetchAgentsForGateway(gatewayId, { force: true }),
      });
      if (decision === 'ok') {
        setMissingAgentId(null);
        return false;
      }
      if (decision === 'missing') {
        setMissingAgentId(agentId);
      } else {
        setMissingAgentId(null);
        toast.error(t('errors.failed'));
      }
      return true;
    },
    [gatewayId, t],
  );

  const applyPersona = useCallback(async (): Promise<boolean> => {
    if (!gatewayId) {
      toast.error(t('identity.applyFailed'));
      return false;
    }
    if (await refuseIfAgentUnavailable(currentAgentId)) return false;
    setMissingAgentId(null);
    selectAgent(currentAgentId);
    return true;
  }, [gatewayId, currentAgentId, refuseIfAgentUnavailable, selectAgent, t]);

  /**
   * 提示里的出口：直接切到罗盘助手。
   * ⚠️ 不是再调一次 `applyPersona` —— 那条路在 missing 态会原地打转（同一个判据又会命中）。
   */
  const switchToCompass = useCallback(() => {
    setMissingAgentId(null);
    selectAgent('main');
  }, [selectAgent]);

  /** 点客群卡：真的切，但**留在这一页**（用户是在挑，不是在开新任务）。 */
  const chooseGroup = useCallback(
    async (agentId: string): Promise<void> => {
      // ⭐ 卡片是按**固定的预设 id 清单**渲染的（`IDENTITY_AGENT_IDS`），
      //    所以盘上没装的助手**也有卡片、也点得着** —— 这正是静默换人的入口。
      if (await refuseIfAgentUnavailable(agentId)) return;
      setMissingAgentId(null);
      selectAgent(agentId);
      // ⚠️ 顺序有意：`useSelectAgent` 的最后一步会把主区切到对话页。
      //    这一页是"选择器"，选完把用户甩进对话页等于让他重新找路。
      //    **不能改成只调 `setSelectedAgent`** —— 那个 hook 的四步是一个整体
      //    （少了 `setPending` 就会出现"下一条消息发给上一个助手"的老毛病）。
      setMainView('identity');
    },
    [refuseIfAgentUnavailable, selectAgent, setMainView],
  );

  /**
   * ⭐ 用当前客群**开一个新任务**（0.0.35 账本 §六-3：客群卡与「新建任务」打通）。
   *
   * ⚠️ 与 `chooseGroup` 的分工**刻意分开**：点卡片是"我在挑"，只切不甩人；
   *    这个出口是"就它了，开工" —— 两件事都发生，但由**两个不同的动作**触发。
   *    （把点击行为直接改成"切+开任务"会把上一版那条取舍推翻：用户是在挑，不是在开任务。）
   *
   * ⚠️ 没网关时**如实报错**，不假装成功（与 `applyPersona` 同一条规矩）。
   */
  const startTaskWithAgent = useCallback(async (): Promise<void> => {
    if (!gatewayId) {
      toast.error(t('identity.applyFailed'));
      return;
    }
    // ⭐ 缺失时**留在原地说明**，不开任务。原来这里只判了网关在不在 ⇒
    //    用户会先被甩进对话页、再在欢迎屏上看到"这个助手不在本机"（跳过去才说）。
    if (await refuseIfAgentUnavailable(currentAgentId)) return;
    setMissingAgentId(null);
    // ⚠️ **不自己切视图**：`startNewTask` 内部已经通过平台的 `onTaskCreated`
    //    把主区切到对话页了（`platform/index.ts:89`）。这里再调一次 `setMainView('chat')`
    //    是冗余的 —— 变异测试把那条删掉之后**测试照样全绿**，正是它在说明这件事。
    startNewTask({ gatewayId, agentId: currentAgentId });
  }, [currentAgentId, gatewayId, refuseIfAgentUnavailable, startNewTask, t]);

  const onApply = useCallback(async (): Promise<void> => {
    if (selected.length === 0) {
      toast.error(t('identity.needTag'));
      return;
    }
    if (await applyPersona()) toast.success(t('identity.appliedToast', { role: groupLabel }));
  }, [selected.length, applyPersona, groupLabel, t]);

  const toggleTag = (id: IdentityTagId) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  /**
   * 「保存并应用」= 切助手 + **把身份写进每个助手的记忆**（`USER.md`）。
   *
   * ⚠️ 每个助手**各读各的、各写各的**：记忆页那种"读第一个、写给全部"在这里会把
   *    别的助手自己写的记忆冲掉 —— 那是不可逆的损坏，不是省一次调用。
   * ⚠️ 写在前、切在后：切助手会把主区切走（页面卸载），先写才不会半途而废。
   * ⚠️ 部分失败/超限**如实报**（几个没写成、超了上限），**不许**报"已保存"。
   */
  const onSave = useCallback(() => {
    if (selected.length === 0) {
      toast.error(t('identity.needTag'));
      return;
    }
    if (!gatewayId) {
      toast.error(t('identity.applyFailed'));
      return;
    }
    const agents = catalogEntry?.agents ?? [];
    if (agents.length === 0) {
      toast.error(t('settings.memoryNoAgents'));
      return;
    }
    const block = buildIdentityBlock({ groupLabel, tagLabels });

    void (async () => {
      let failed = 0;
      let overLimit = 0;
      for (const agent of agents) {
        const read = await window.clawwork.getAgentFile(gatewayId, agent.id, 'USER.md');
        const existing = read.ok && read.result ? String((read.result as { content?: unknown }).content ?? '') : '';
        const merged = mergeIdentityIntoUserMd(existing, block);
        if (!merged.ok) {
          overLimit += 1;
          failed += 1;
          continue;
        }
        const write = await window.clawwork.setAgentFile(gatewayId, agent.id, 'USER.md', merged.content);
        if (!write.ok) failed += 1;
      }

      await applyPersona();

      if (overLimit === agents.length) {
        toast.error(t('settings.memoryTooLong', { max: USER_MD_MAX_CHARS }));
        return;
      }
      if (failed > 0) {
        toast.error(t('settings.memorySavePartial', { failed, total: agents.length }));
        return;
      }
      toast.success(t('settings.memorySaved', { count: agents.length }));
    })();
  }, [selected.length, tagLabels, groupLabel, gatewayId, catalogEntry, applyPersona, t]);

  return (
    <div data-testid="identity-center" className="flex h-full flex-col overflow-hidden">
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-5 py-4">
          <h1 className="type-page-title text-[var(--text-primary)]">{t('identity.title')}</h1>
          <p className="type-support mt-1 text-[var(--text-muted)]">{t('identity.subtitle')}</p>

          {/* ── 客群（= 真实助手）：点一下真的换 ── */}
          <div className="mt-3 grid grid-cols-12 gap-2.5" data-testid="identity-agent-grid">
            {IDENTITY_AGENT_IDS.map((agentId, index) => {
              const ws = resolveAssistantWorkspace(agentId);
              if (!ws) return null;
              const on = agentId === currentAgentId;
              // 7 张卡不能用固定 4 列：第二行会永久缺一格。
              // 12 列只用来分配宽度：桌面端 4×3 + 3×4，窄屏 2 列，最后一张铺满。
              const layoutClass =
                index < 4
                  ? 'col-span-12 sm:col-span-6 lg:col-span-3'
                  : index < 6
                    ? 'col-span-12 sm:col-span-6 lg:col-span-4'
                    : 'col-span-12 sm:col-span-12 lg:col-span-4';
              return (
                <button
                  key={agentId}
                  type="button"
                  data-group={agentId}
                  data-selected={on ? 'true' : 'false'}
                  aria-pressed={on}
                  onClick={() => void chooseGroup(agentId)}
                  className={
                    `glow-focus ${layoutClass} rounded-[10px] border px-3 py-2.5 text-left transition-colors ` +
                    (on
                      ? 'border-[var(--accent)] bg-[var(--accent-dim)]'
                      : 'border-[var(--border)] bg-[var(--bg-elevated)] hover:bg-[var(--bg-hover)]')
                  }
                >
                  <p className="type-body font-semibold text-[var(--text-primary)]">
                    <span aria-hidden="true" className="mr-1.5">
                      {ws.emoji}
                    </span>
                    {t(ws.titleKey)}
                  </p>
                  <p className="type-support mt-1 text-[var(--text-muted)]">{t(ws.descriptionKey)}</p>
                </button>
              );
            })}
          </div>

          {/* ⭐ 挑完助手的**出口**：开一个新任务用上它。
              ⚠️ 与卡片本身的点击分开两次动作（见 `startTaskWithAgent` 的注释）。 */}
          <div className="mt-2.5 flex items-center gap-2">
            <Button
              size="sm"
              className="type-support"
              data-action="new-task-with-agent"
              onClick={() => void startTaskWithAgent()}
            >
              <SquarePen />
              {t('identity.startTask', { role: groupLabel })}
            </Button>
          </div>

          {/* ── 画像生成卡片 ── */}
          <section className="mt-3 rounded-[10px] border border-[var(--border)] bg-[var(--bg-elevated)] shadow-[var(--elev-1)]">
            <div className="px-4 py-3">
              <div className="flex items-center gap-2">
                <Sparkles className="size-4 text-[var(--accent)]" />
                <span className="type-body font-semibold text-[var(--text-primary)]">{t('identity.cardTitle')}</span>
              </div>
              <p className="type-support mt-1 text-[var(--text-muted)]">{t('identity.cardHint')}</p>

              {/* ⭐ 画像正文**随选区实时变** —— 上一版这里是常量，用户点了标签以为"没反应" */}
              <p className="type-body mt-2 text-[var(--text-secondary)]" data-field="persona">
                <UserRound className="mr-1 inline size-3.5 align-[-2px] text-[var(--accent)]" />
                {personaLine}
              </p>

              <p className="type-support mt-3 text-[var(--text-muted)]">{t('identity.tagsLabel')}</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {IDENTITY_PERSONA_TAGS.map((id) => {
                  const on = selected.includes(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      data-tag={id}
                      data-selected={on ? 'true' : 'false'}
                      aria-pressed={on}
                      onClick={() => toggleTag(id)}
                      className={
                        'type-badge glow-focus inline-flex items-center rounded-full px-2.5 py-1 transition-colors ' +
                        (on
                          ? 'bg-[var(--accent-dim)] font-semibold text-[var(--accent)]'
                          : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]')
                      }
                    >
                      {t(`identity.tag.${id}`)}
                    </button>
                  );
                })}
              </div>

              <div className="mt-3 grid grid-cols-4 gap-4">
                <div>
                  <p className="type-support text-[var(--text-muted)]">{t('identity.roleLabel')}</p>
                  <p className="type-body mt-1 font-semibold text-[var(--text-primary)]" data-field="role">
                    {groupLabel}
                  </p>
                </div>
                <div className="col-span-3">
                  <p className="type-support text-[var(--text-muted)]">{t('identity.skillsLabel')}</p>
                  {/* ⭐ 这一排是**这个助手真实能做的四件事**（来自预置任务的标题），
                      不再是上一版那七个网关里根本不存在的技能名。 */}
                  <div className="mt-1 flex flex-wrap gap-1.5" data-field="skills">
                    {workspace.starters.map((starter) => (
                      <span
                        key={starter.id}
                        className="type-badge inline-flex items-center rounded-md bg-[var(--bg-tertiary)] px-2.5 py-1 text-[var(--text-secondary)]"
                      >
                        {t(starter.titleKey)}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {missingAgentId ? (
              <div className="px-4 pb-3">
                <AgentMissingNotice
                  agentId={missingAgentId}
                  // ⚠️ 罗盘自己也不在目录里时不给这个出口（同 `WelcomeScreen`，复核 M-2）。
                  onSwitchAssistant={
                    catalogEntry?.agents.some((agent) => agent.id === 'main') ? switchToCompass : undefined
                  }
                  onOpenTeams={() => setMainView('teams')}
                />
              </div>
            ) : null}

            <div className="flex items-center gap-2 border-t border-[var(--border)] px-4 py-2">
              <Button
                variant="ghost"
                size="sm"
                className="type-support"
                data-action="reset"
                onClick={() => setSelected([])}
              >
                <RotateCcw />
                {t('identity.reselect')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="type-support"
                data-action="shuffle"
                onClick={() => setSelected((prev) => nextTagSelection(prev))}
              >
                {t('identity.shuffle')}
              </Button>
              <span className="flex-1" />
              <Button size="sm" className="type-support" data-action="apply" onClick={onApply}>
                <Check />
                {t('identity.apply')}
              </Button>
            </div>
          </section>
        </div>
      </ScrollArea>

      {/* ── 固定底栏 ── */}
      <div className="flex flex-none items-center gap-3 border-t border-[var(--border)] bg-[var(--bg-secondary)] px-5 py-2">
        <span className="type-support flex-1 text-[var(--text-muted)]">{t('settings.memoryAboutYouHint')}</span>
        <Button size="sm" className="type-support" data-action="save" onClick={onSave}>
          {t('identity.save')}
        </Button>
      </div>
    </div>
  );
}
