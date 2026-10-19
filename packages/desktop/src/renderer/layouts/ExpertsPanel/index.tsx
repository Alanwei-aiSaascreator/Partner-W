import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import WindowTitlebar from '@/components/semantic/WindowTitlebar';
import {
  EXPERT_CATALOG,
  EXPERT_DOMAINS,
  buildExpertLaunchPrompt,
  expertsByDomain,
  type ExpertDomain,
  type ExpertEntry,
} from '@/lib/expert-catalog';

/**
 * 专家库（2026-10-16，全量总单第 24 行）。
 *
 * ## 这一页在补什么
 *
 * 随包发出去 18 份专家技能（`our-skills/octop-*`），但界面上**没有"专家"这个面**：
 * 用户只能在「技能市场」看到一行行**待安装的技能**，看不到"这些人是谁、能帮我干什么"。
 * 这一页把每位专家摊成一张卡：头像字 + 名字 + 一句话能力 + 一个直接开任务的入口。
 *
 * ## ⚠️ 它**不**新造执行通道
 *
 * 卡片上的按钮只做一件事：把一句话交给**上一层注入的 `onStartTask`**。
 * 那个回调是 `MainArea` 的既有 `requestDraft`（与欢迎屏的任务预设、目标路由
 * **同一条路**）—— 填进输入框、切到对话，之后走的完全是既有的任务/团队机制。
 * 这一页**不碰**网关、不建任务、不发请求。
 *
 * ## ⚠️ 名字与说明不进 i18n
 *
 * 与「技能市场」同一个既有口径（`OurSkillEntry` 注释）：**技能自带内容，不随界面语言变**。
 * 界面外壳（标题、筛选、按钮）才走 i18n 键。
 *
 * ## ⚠️ 头像 = 内容自带的 emoji，不引入任何图片
 *
 * 上游头像不在专家库的 Apache-2.0 许可目录内（见 `test/octop-provenance-integrity.test.ts`），
 * 本包一个字节都没取。所以卡片头像用的是各技能 SKILL.md frontmatter 自带的那个 emoji ——
 * **零素材、零权利风险**，而且与技能市场里那一行显示的是同一个字。
 */

export interface ExpertsPanelProps {
  /**
   * 点一位专家之后干什么。由 `MainArea` 注入（既有 `requestDraft`）。
   *
   * ⚠️ 注入而不是在这里 import 一个 store：这样这一页**不需要网关、不需要会话**就能测，
   *    执行通道仍然只有一条（改通道不用改这里）。
   */
  onStartTask: (prompt: string) => void;
  /**
   * 当前网关。给了才去查"这位专家的技能装没装"（2026-10-19 闭环）。
   * 不给 ⇒ 保持旧行为：不做任何安装状态断言（"不知道"不许说成"没装"）。
   */
  gatewayId?: string;
}

type DomainFilter = ExpertDomain | 'all';

const FILTERS: readonly DomainFilter[] = ['all', ...EXPERT_DOMAINS];

export default function ExpertsPanel({ onStartTask, gatewayId }: ExpertsPanelProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<DomainFilter>('all');
  const experts = filter === 'all' ? EXPERT_CATALOG : expertsByDomain(filter);

  /**
   * 技能安装状态（2026-10-19，闭环缺口 2）。
   *
   * 这一页原来只发一句"请使用你已安装的技能 X"，**不校验装没装** —— 技能没装时
   * 用户点下去任务照开，助手却看不到它。现在从真实 `listOurSkills` 取状态：
   *   · `undefined` = 不知道（没网关 / 没问出来）⇒ 不做任何断言，保持旧行为；
   *   · `false` = 明确没装 ⇒ 卡上给「装上」，弹窗里挡住「开始」。
   * `managedDirKnown=false` 是"不知道"而不是"没装"，必须原样跳过。
   */
  const [installedBySlug, setInstalledBySlug] = useState<Record<string, boolean> | null>(null);
  const [installingSlug, setInstallingSlug] = useState<string | null>(null);

  const loadSkills = useCallback(async () => {
    if (!gatewayId || typeof window.clawwork?.listOurSkills !== 'function') return;
    try {
      const res = await window.clawwork.listOurSkills(gatewayId);
      if (!res.ok || !res.result || !res.result.managedDirKnown) return;
      const next: Record<string, boolean> = {};
      for (const skill of res.result.skills) next[skill.slug] = skill.installed;
      setInstalledBySlug(next);
    } catch {
      // 问不出来 ≠ 没装：保持 null，界面什么也不断言。
    }
  }, [gatewayId]);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const handleInstall = useCallback(
    async (slug: string) => {
      if (!gatewayId || installingSlug || typeof window.clawwork?.installOurSkill !== 'function') return;
      setInstallingSlug(slug);
      try {
        const res = await window.clawwork.installOurSkill(gatewayId, slug);
        if (!res.ok) {
          toast.error(t('skillMarket.actionFailed', { reason: res.error ?? '' }));
          return;
        }
        await loadSkills();
      } catch (error) {
        toast.error(
          t('skillMarket.actionFailed', { reason: error instanceof Error ? error.message : 'unknown' }),
        );
      } finally {
        setInstallingSlug(null);
      }
    },
    [gatewayId, installingSlug, loadSkills, t],
  );

  // ⚠️ 根节点必须用 `h-full`，不能用 `flex-1`（2026-10-19，用户实测 1.0.10 滚不动）：
  //    `MainArea` 用 `<div className="flex-1 min-h-0">` 包住本面板 —— 那是一个**普通 block**，
  //    `flex-1` 只在 flex 父容器里生效 ⇒ 面板高度退化成内容高度，`ScrollArea` 视口与内容同高，
  //    表现就是整页被窗口裁掉、滚轮无效。`h-full` 相对包装层的确定高度取 100%，与其它面板一致。
  return (
    <div className="flex h-full min-h-0 flex-col">
      <WindowTitlebar center={<span className="type-label">{t('experts.title')}</span>} />
      <ScrollArea className="flex-1 min-h-0">
        <div className="flex w-full flex-col gap-4 px-4 py-4">
          <p className="type-meta text-[var(--text-secondary)]">{t('experts.subtitle')}</p>
          {/* ⚠️ 这句**必须留着**（2026-10-16）：专家的能力是靠随包技能说话的 ——
              技能没装到网关上时，助手看不到它，"点了没反应"。与其让用户猜，
              不如当面说清下一步去「技能市场」。 */}
          <p data-testid="experts-install-hint" className="type-support text-[var(--text-muted)]">
            {t('experts.installHint')}
          </p>

          {/* 领域筛选。⚠️「全部」必须是第一个且默认选中 —— 用户不该先学会筛选才看得到人。 */}
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('experts.filterLabel')}>
            {FILTERS.map((value) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={filter === value ? 'secondary' : 'ghost'}
                data-expert-domain={value}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {t(`experts.domain.${value}`)}
              </Button>
            ))}
            <span data-testid="expert-count" className="type-support ml-auto shrink-0 text-[var(--text-muted)]">
              {/* ⚠️ 变量名刻意叫 `n` 而不是 `count`：i18next 见到 `count` 会去解析
                  复数键（`_one` / `_other`），而这份键表是按 9 语言**单一形态**交回的，
                  用 `count` 会变成"某些语言缺 `_other`"的假缺口。 */}
              {t('experts.countLabel', { n: experts.length })}
            </span>
          </div>

          <ul className="grid gap-3 sm:grid-cols-2">
            {experts.map((expert) => (
              <ExpertCard
                key={expert.id}
                expert={expert}
                onStartTask={onStartTask}
                installed={installedBySlug?.[expert.skillSlug]}
                installing={installingSlug === expert.skillSlug}
                onInstall={() => void handleInstall(expert.skillSlug)}
              />
            ))}
          </ul>
        </div>
      </ScrollArea>
    </div>
  );
}

function ExpertCard({
  expert,
  onStartTask,
  installed,
  installing,
  onInstall,
}: {
  expert: ExpertEntry;
  onStartTask: (prompt: string) => void;
  /** `undefined` = 不知道（不显示任何安装状态）。 */
  installed?: boolean;
  installing?: boolean;
  onInstall?: () => void;
}) {
  const { t } = useTranslation();
  // 2026-10-17 用户反馈：点「开个任务」只往输入框塞一句"用「X」这个专家能力帮我做："，
  // 看起来像没反应。改成先问一句"要做什么"，确认后**直接开任务并发送**。
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState('');
  const trimmed = request.trim();
  return (
    <li
      data-expert-card={expert.id}
      className="flex flex-col gap-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3"
    >
      <div className="flex items-start gap-3">
        {/* 头像位：内容自带的 emoji，语义令牌上色（不新增图片素材）。 */}
        <span
          data-expert-avatar
          aria-hidden="true"
          className="emoji-md flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--bg-tertiary)]"
        >
          {expert.glyph}
        </span>
        <div className="min-w-0 flex-1">
          <p className="type-label break-words font-medium text-[var(--text-primary)]">{expert.name}</p>
          <p className="type-meta mt-0.5 text-[var(--text-muted)]">{t(`experts.domain.${expert.domain}`)}</p>
        </div>
      </div>
      <p className="type-support break-words text-[var(--text-secondary)]">{expert.capability}</p>
      <div className="mt-auto flex items-center justify-end gap-2">
        {installed === true && (
          <span data-expert-installed className="type-support text-[var(--text-muted)]">
            {t('skillMarket.installedBadge')}
          </span>
        )}
        {installed === false && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-expert-install
            disabled={installing}
            onClick={onInstall}
          >
            {t('skillMarket.install')}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          data-expert-launch={expert.id}
          onClick={() => setOpen(true)}
        >
          {t('experts.launch')}
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('experts.dialogTitle', { name: expert.name })}</DialogTitle>
            <DialogDescription>{t('experts.dialogDescription')}</DialogDescription>
          </DialogHeader>
          <textarea
            data-testid="expert-request-input"
            value={request}
            onChange={(event) => setRequest(event.target.value)}
            placeholder={t('experts.dialogPlaceholder')}
            rows={3}
            className="w-full resize-none rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 type-body text-[var(--text-primary)] placeholder:text-[var(--text-muted)] glow-focus"
          />
          {installed === false && (
            <div
              data-testid="expert-install-required"
              className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] px-3 py-2"
            >
              <p className="type-support text-[var(--text-secondary)]">{t('experts.installHint')}</p>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="mt-2"
                data-testid="expert-dialog-install"
                disabled={installing}
                onClick={onInstall}
              >
                {t('skillMarket.install')}
              </Button>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t('experts.dialogCancel')}
            </Button>
            <Button
              type="button"
              data-testid="expert-request-start"
              disabled={trimmed.length === 0 || installed === false}
              onClick={() => {
                setOpen(false);
                setRequest('');
                onStartTask(`${buildExpertLaunchPrompt(expert, t)}${trimmed}`);
              }}
            >
              {t('experts.dialogStart')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}
