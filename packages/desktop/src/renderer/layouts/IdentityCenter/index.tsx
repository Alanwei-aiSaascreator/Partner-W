import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, RotateCcw, Sparkles, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from '@/lib/toast';
import { useUiStore } from '@/stores/uiStore';
import { useSelectAgent } from '@/hooks/useSelectAgent';
import AgentMissingNotice from '@/components/AgentMissingNotice';
import { resolveRequestedAgent } from '@/lib/requested-agent';
import { ASSISTANT_ID_BY_WORKSPACE } from '@/lib/assistant-task-presets';
import {
  IDENTITY_DEFAULT_TAGS,
  IDENTITY_PERSONA_TAGS,
  nextTagSelection,
  type IdentityTagId,
} from '@/lib/identity-persona';

/** 标签选择的落盘位置（本机、不上云 —— 与引导问卷一样用 localStorage）。 */
export const IDENTITY_STORAGE_KEY = 'cw:identity-tags';

/** 推荐技能（**展示用** —— 见文件头"刻意没做的"）。 */
export const IDENTITY_SKILL_IDS = [
  'docManager',
  'officeDoc',
  'dataAssistant',
  'dataViz',
  'meetingSecretary',
  'toolbox',
  'mailExpert',
] as const;

/**
 * 身份中心。
 *
 * ## 这一版做了什么（2026-09-19 第二刀）
 *
 * 第一版是**纯排版**（按钮没有 `onClick`，用户反馈「功能用不了」）。这一刀把它接上：
 *
 * | 按钮 | 现在真的做什么 |
 * | --- | --- |
 * | 标签 | 点击切换选中（多选） |
 * | 重新选择 | 清空全部选中 |
 * | 换一个标签 | 按环轮换一格（纯函数 `nextTagSelection`，可单测） |
 * | 应用此画像 | **真的切到「高效办公」助手**（`setSelectedAgent`）+ 提示 |
 * | 保存并应用此身份配置 | 上面那步 + 把标签选择存进 localStorage |
 *
 * ⚠️ **这一版刻意没做的**（都要先定口径，见 `docs/superpowers/specs/2026-09-19-身份中心-design.md`）：
 * - **推荐技能那排仍是展示** —— 那 7 个技能在网关里**不存在**，而客户端**没有写技能的通道**
 * - **没有新立一份「画像」** —— 产品里已有一份（引导问卷 + 设置→账户的「工作画像」），
 *   再立一份会打架；这里只存了**标签选择**
 * - 「其它客群」四张卡仍是展示（没有对应的助手 / 内容）
 */
export default function IdentityCenter() {
  const { t } = useTranslation();
  const gatewayId = useUiStore((s) => s.defaultGatewayId);
  const selectAgent = useSelectAgent();
  const [selected, setSelected] = useState<IdentityTagId[]>(IDENTITY_DEFAULT_TAGS);
  /** 目录**已加载**但点名的助手不在里面时，提示里要显示的 id（`null` = 没有这回事）。 */
  const [missingAgentId, setMissingAgentId] = useState<string | null>(null);
  const catalogEntry = useUiStore((s) => (gatewayId ? s.agentCatalogByGateway[gatewayId] : undefined));
  const setMainView = useUiStore((s) => s.setMainView);

  const roleLabel = t('identity.roleValue');
  const officeAssistantId = ASSISTANT_ID_BY_WORKSPACE.office;

  /**
   * 「应用」= 把推荐角色**真的切成当前助手**（走 `useSelectAgent`，与左侧
   * 「我的助手」切换器**同一条路**：改选择 + 改待发任务 + 离开旧会话 + 回到对话）。
   *
   * ⚠️ 没有网关时**如实报错**，不假装成功（本项目栽过"把不确定说成确定"）。
   * ⚠️ **不做**"这个助手在不在目录里"的检查：六个预设助手由 `useStartupReadiness`
   *    在进首页前装好（`preset-agent-installer`），目录还没拉回来时会误报失败。
   */
  const applyPersona = useCallback((): boolean => {
    if (!gatewayId) {
      toast.error(t('identity.applyFailed'));
      return false;
    }
    // ⭐ 2026-09-24：目录**已加载**且点名要的助手不在里面 ⇒ 如实说明，**不静默换人**。
    //    目录还没拉回来时这个判据返回 `loading`（不是 missing），走原路 —— 那条既有注释
    //    （怕误报失败）依然成立。
    if (resolveRequestedAgent(officeAssistantId, catalogEntry) === 'missing') {
      setMissingAgentId(officeAssistantId);
      return false;
    }
    setMissingAgentId(null);
    selectAgent(officeAssistantId);
    return true;
  }, [catalogEntry, gatewayId, officeAssistantId, selectAgent, t]);

  /**
   * 提示里的出口：直接切到罗盘助手。
   * ⚠️ 不是再调一次 `applyPersona` —— 那条路在 missing 态会原地打转（同一个判据又会命中）。
   */
  const switchToCompass = useCallback(() => {
    setMissingAgentId(null);
    selectAgent(ASSISTANT_ID_BY_WORKSPACE.compass);
  }, [selectAgent]);

  const onApply = useCallback(() => {
    if (selected.length === 0) {
      toast.error(t('identity.needTag'));
      return;
    }
    if (applyPersona()) toast.success(t('identity.appliedToast', { role: roleLabel }));
  }, [selected.length, applyPersona, roleLabel, t]);

  const onSave = useCallback(() => {
    if (selected.length === 0) {
      toast.error(t('identity.needTag'));
      return;
    }
    if (!applyPersona()) return;
    try {
      window.localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(selected));
    } catch {
      /* 存不进就算了 —— 应用那一步已经生效，不该因为存储报错把它说成失败 */
    }
    toast.success(t('identity.savedToast'));
  }, [selected, applyPersona, t]);

  const toggleTag = (id: IdentityTagId) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const otherGroups = ['educator', 'legal', 'ecommerce', 'engineer'] as const;

  return (
    <div data-testid="identity-center" className="flex h-full flex-col overflow-hidden">
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-5 py-4">
          <h1 className="type-page-title text-[var(--text-primary)]">{t('identity.title')}</h1>
          <p className="type-support mt-1 text-[var(--text-muted)]">{t('identity.subtitle')}</p>

          {/* ── 画像生成卡片 ── */}
          <section className="mt-3 rounded-[10px] border border-[var(--border)] bg-[var(--bg-elevated)] shadow-[var(--elev-1)]">
            <div className="px-4 py-3">
              <div className="flex items-center gap-2">
                <Sparkles className="size-4 text-[var(--accent)]" />
                <span className="type-body font-semibold text-[var(--text-primary)]">{t('identity.cardTitle')}</span>
              </div>
              <p className="type-support mt-1 text-[var(--text-muted)]">{t('identity.cardHint')}</p>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="type-badge inline-flex items-center gap-1.5 rounded-md bg-[var(--accent-dim)] px-2.5 py-1 text-[var(--accent)]">
                  <UserRound className="size-3.5" />
                  {t('identity.personaTag')}
                </span>
                <span className="type-badge inline-flex items-center gap-1.5 rounded-md bg-[var(--bg-tertiary)] px-2.5 py-1 text-[var(--text-secondary)]">
                  {t('identity.direction', { value: t('identity.directionValue') })}
                </span>
              </div>

              <p className="type-body mt-2 text-[var(--text-secondary)]">{t('identity.personaDesc')}</p>

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
                    {roleLabel}
                  </p>
                </div>
                <div className="col-span-3">
                  <p className="type-support text-[var(--text-muted)]">{t('identity.skillsLabel')}</p>
                  {/* ⚠️ 这一排**仍是展示**：那 7 个技能在网关里不存在，客户端也没有写技能的通道。 */}
                  <div className="mt-1 flex flex-wrap gap-1.5" data-field="skills">
                    {IDENTITY_SKILL_IDS.map((key) => (
                      <span
                        key={key}
                        className="type-badge inline-flex items-center rounded-md bg-[var(--bg-tertiary)] px-2.5 py-1 text-[var(--text-secondary)]"
                      >
                        {t(`identity.skill.${key}`)}
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
                  onSwitchAssistant={switchToCompass}
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

          {/* ── 其它客群（仍是展示：没有对应的助手与内容） ── */}
          <p className="type-body mt-4 font-semibold text-[var(--text-primary)]">{t('identity.otherGroups')}</p>
          <div className="mt-2 grid grid-cols-4 gap-2.5">
            {otherGroups.map((key) => (
              <div
                key={key}
                data-group={key}
                className="rounded-[10px] border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2.5 shadow-[var(--elev-1)]"
              >
                <p className="type-body font-semibold text-[var(--text-primary)]">{t(`identity.group.${key}.name`)}</p>
                <p className="type-support mt-1 text-[var(--text-muted)]">{t(`identity.group.${key}.desc`)}</p>
              </div>
            ))}
          </div>
        </div>
      </ScrollArea>

      {/* ── 固定底栏 ── */}
      <div className="flex flex-none items-center gap-3 border-t border-[var(--border)] bg-[var(--bg-secondary)] px-5 py-2">
        <span className="type-support flex-1 text-[var(--text-muted)]">{t('identity.footerHint')}</span>
        <Button size="sm" className="type-support" data-action="save" onClick={onSave}>
          {t('identity.save')}
        </Button>
      </div>
    </div>
  );
}
