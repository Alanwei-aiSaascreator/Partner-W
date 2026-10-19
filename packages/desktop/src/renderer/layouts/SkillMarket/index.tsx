import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, Loader2, PackagePlus, RefreshCw, Search, Sparkles, Trash2, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import ConfirmDialog from '@/components/semantic/ConfirmDialog';
import EmptyState from '@/components/semantic/EmptyState';
import InlineNotice from '@/components/semantic/InlineNotice';
import WindowTitlebar from '@/components/semantic/WindowTitlebar';
import { toast } from '@/lib/toast';
import { useUiStore } from '@/stores/uiStore';
import { useTaskStore } from '@/stores/taskStore';
import {
  captureBundledSkillsOperationScope,
  reconcileBundledSkillsAfterResolvedSkill,
} from '@/lib/ensure-bundled-skills';
import { useSkillVerdicts } from './use-skill-verdicts';
import SkillVerdictBadge from './SkillVerdictBadge';
import {
  groupSkillsByCategory,
  skillCategoryOf,
  SKILL_CATEGORY_ORDER,
  type SkillCategory,
} from '@/lib/skill-categories';
import { cn } from '@/lib/utils';
import type { OurSkillEntry } from '@clawwork/shared';

/**
 * 技能市场（T-a2）—— 列**我们自己随包发**的技能，点一下就装。
 *
 * ## 与「设置 → 技能」的分工
 *
 * 那一页列的是**网关自带的**技能（12 个 bundled + 插件，名字与描述都是英文，
 * 大多是给开发者用的），保留给要调参的高级用户。
 * 这一页是**面向用户的**：只有我们挑过、写过中文说明的技能。
 *
 * ## 这个界面要如实说清的三件事
 *
 * ① **装上之后谁能用**：装到网关的**共享**技能目录（`managedSkillsDir`），
 *    所以是"装一次，所有助手都能用"，不是只对当前助手生效。
 * ② **装不上时是为什么**：要装就得先连上网关（安装目录是**问网关要的**，
 *    不是本地猜的）。连不上时**按钮禁用 + 一条提示**，而不是点下去转圈然后报个看不懂的错。
 * ③ **"不知道装没装"≠"没装"**：网关没连上时 `managedDirKnown` 是 false ——
 *    这时**不显示"未装"**（那会让用户以为自己的技能丢了），只显示"未连接"。
 *
 * ⚠️ 这里**不显示**积分/token。技能是随包的，装它不花钱。
 */

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; skills: OurSkillEntry[]; managedDirKnown: boolean }
  | { kind: 'error'; message: string };

export default function SkillMarket() {
  const { t } = useTranslation();
  const gatewayId = useUiStore((s) => s.defaultGatewayId);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  /** 正在装/卸哪一个 —— 只忙那一个按钮，别把整页锁住。 */
  const [busySlug, setBusySlug] = useState<string | null>(null);
  /** 这一行的忙碌来自哪个动作（装/卸 vs 修复）：只有对应的那个按钮转圈。 */
  const [busyAction, setBusyAction] = useState<'toggle' | 'repair' | null>(null);
  /**
   * ⭐ E3：待确认的「修复随包版本」（已装的那一行）。
   *
   * 修复是**替换用户盘上的厂商文件**，必须用户明确点过确认才发 IPC ——
   * 但入口要看得见：已装的技能原来只有"卸载"一个动作，用户没法只换一份干净的厂商文件。
   * ⚠️ 刻意**不复用卸载**：卸载会把整个技能目录删掉（连用户自己放的文件一起），
   * 那是另一件事，不能用"卸了再装"冒充修复。
   */
  const [repairTarget, setRepairTarget] = useState<OurSkillEntry | null>(null);
  /**
   * 强制**重问网关**的计数器（2026-09-29）：刷新按钮、以及装卸之后 +1。
   *
   * ⚠️ 装卸其实会自动重问（装了哪些变了 ⇒ 探测键变了）；这个计数器是为**刷新按钮**准备的
   * —— 网关重连之后这一页没有别的办法恢复，而"重新问一次助手那边"正是刷新该做的事。
   */
  const [verdictNonce, setVerdictNonce] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await window.clawwork.listOurSkills(gatewayId ?? undefined);
      if (!res.ok || !res.result) {
        setState({ kind: 'error', message: res.error ?? '' });
        return;
      }
      setState({ kind: 'ready', skills: res.result.skills, managedDirKnown: res.result.managedDirKnown });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'unknown' });
    }
  }, [gatewayId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleToggle = useCallback(
    async (skill: OurSkillEntry) => {
      if (!gatewayId || busySlug) return;
      // ⭐ B3（复审二轮）：操作成功要收敛报告 —— 作用域（网关 + 真实工作区代次，从 store
      //    读当下值，不从报告反推）在**发起这一刻**捕获；成功回调按结果收敛/记账。
      //    （安装是异步的：期间用户切了网关/工作区 ⇒ 成功后不写；期间报告被读写不再拦收敛。）
      const reportScope = captureBundledSkillsOperationScope(gatewayId, useTaskStore.getState().workspaceEpoch);
      setBusySlug(skill.slug);
      setBusyAction('toggle');
      try {
        const res = skill.installed
          ? await window.clawwork.removeOurSkill(gatewayId, skill.slug)
          : await window.clawwork.installOurSkill(gatewayId, skill.slug);
        if (!res.ok) {
          toast.error(t('skillMarket.actionFailed', { reason: res.error ?? '' }));
          return;
        }
        // ⚠️ 装/卸的**可见性**在网关那边有约 0.7 秒延迟（实测 2026-09-20），
        //    但这一页显示的"装没装"看的是**磁盘**（主进程 `fs.existsSync`），
        //    所以这里立刻重载就是准的 —— 不要为了"等网关"故意延迟，
        //    也别把这一页的已装状态改成去读 `skills.status`（那会平白多出那 0.7 秒的闪烁）。
        // ⚠️ 卸载要**载明代价**：实测网关侧**在进程内不失效** ——
        //    装上 ~0.7 秒就生效，卸掉之后 **≥3 分钟仍报存在**
        //    （按 agent 缓存：换一个 agent 问立刻正确），**重启客户端后正确**。
        //    不写这句，用户卸完发现助手还在用它，只会当成我们的 bug。
        //    装上不提 —— 它确实马上就生效，加警告是噪音。
        toast.success(
          skill.installed
            ? t('skillMarket.removed', { name: skill.name ?? '' })
            : t('skillMarket.installed', { name: skill.name ?? '' }),
          skill.installed ? { description: t('skillMarket.removedCaveat') } : undefined,
        );
        await load();
        // 装完之后**必须重问一次助手那边**（这正是"装完到底能不能用"的答案来源）。
        setVerdictNonce((n) => n + 1);
        // ⭐ B3（复审二轮）：**安装成功** = 这个 slug 的"未生效"报告已经解决
        //    （与修复同一个带作用域/轮次校验的收敛入口）。此前只有修复路径接了
        //    收敛 —— 开机 ensure 失败过的技能手动装上了，failed 还挂在提示里。
        //    ⚠️ 卸载方向不动报告：卸掉不解决"随包版本没生效"这件事（下次开机 ensure
        //    还会把它装回来），如实保留。
        if (!skill.installed)
          reconcileBundledSkillsAfterResolvedSkill(reportScope, skill.slug, {
            gatewayId: useUiStore.getState().defaultGatewayId,
            workspaceEpoch: useTaskStore.getState().workspaceEpoch,
          });
      } finally {
        setBusySlug(null);
        setBusyAction(null);
      }
    },
    [gatewayId, busySlug, load, t],
  );

  /**
   * ⭐ E3：「修复随包版本」——**只有用户点过确认框**才会走到这里。
   *
   * 走的是**现有**的 `skills:our-install`（已装 ⇒ 主进程走 confirmed-repair：厂商文件
   * 全量重写、用户额外文件保留、修复前留一份可恢复备份）。**不新增 IPC、不调卸载**。
   * 结果必须如实上屏：失败报失败（主进程的 error 里带着备份位置），成功报成功并给出
   * 恢复备份的位置 —— 用户换掉的是自己盘上的东西，他得知道去哪儿找回。
   */
  const handleRepair = useCallback(
    async (skill: OurSkillEntry) => {
      setRepairTarget(null);
      if (!gatewayId || busySlug) return;
      // ⭐ B3（复审二轮）：作用域（网关 + 真实工作区代次）在**发起这一刻**捕获 ——
      //    修复是异步的，期间切了网关/工作区的话，这次成功回调不许把它清成自己的
      //    （旧完成不许回写新状态；报告被其他结论写过不再拦收敛，见 reconcile…）。
      const reportScope = captureBundledSkillsOperationScope(gatewayId, useTaskStore.getState().workspaceEpoch);
      setBusySlug(skill.slug);
      setBusyAction('repair');
      try {
        const res = await window.clawwork.installOurSkill(gatewayId, skill.slug);
        if (!res.ok) {
          // 不假报成功：失败原文（含"恢复备份已保留：<路径>"）如实上屏。
          toast.error(t('skillMarket.actionFailed', { reason: res.error ?? '' }));
          return;
        }
        const backupDir = res.result?.backupDir;
        toast.success(t('skillMarket.repaired', { name: skill.name ?? '' }), {
          description: backupDir ? t('skillMarket.repairedBackup', { path: backupDir }) : undefined,
        });
        await load();
        setVerdictNonce((n) => n + 1);
        // ⭐ B3：修复成功 = 这个 slug 的冲突已按**真实结果**解决（confirmed-repair 核验过）——
        //    报告里只收敛它自己，其他冲突/失败保留；作用域（当下 store 值 vs 发起时捕获）
        //    已变则一个副作用都不留（见 reconcileBundledSkillsAfterResolvedSkill）。
        reconcileBundledSkillsAfterResolvedSkill(reportScope, skill.slug, {
          gatewayId: useUiStore.getState().defaultGatewayId,
          workspaceEpoch: useTaskStore.getState().workspaceEpoch,
        });
      } finally {
        setBusySlug(null);
        setBusyAction(null);
      }
    },
    [gatewayId, busySlug, load, t],
  );

  const skills = state.kind === 'ready' ? state.skills : [];
  const canAct = state.kind === 'ready' && state.managedDirKnown && Boolean(gatewayId);
  const installedCount = skills.filter((skill) => skill.installed).length;
  const setMainView = useUiStore((s) => s.setMainView);

  // ── 2026-10-17 晚按设计稿：分类卡 + 搜索 + 分类筛选 + 卡片网格 ─────────────
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<SkillCategory | 'all'>('all');
  const categoryGroups = useMemo(() => groupSkillsByCategory(skills), [skills]);
  const visibleSkills = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return skills.filter((skill) => {
      if (category !== 'all' && skillCategoryOf(skill.slug) !== category) return false;
      if (!needle) return true;
      return (
        (skill.name ?? '').toLowerCase().includes(needle) ||
        (skill.description ?? '').toLowerCase().includes(needle) ||
        skill.slug.toLowerCase().includes(needle)
      );
    });
  }, [skills, query, category]);

  /**
   * ⭐ 问网关「**这个助手**现在能不能用它们」（2026-09-29）。
   *
   * ⚠️ 判据与磁盘那一半**互不推导**：`installed` 仍看磁盘（主进程 `fs.existsSync`），
   * 这里产出的是**另一个**标签。页面上原来那段"别为了等网关把已装状态改成读
   * `skills.status`"的注释仍然有效 —— 我们没有改它，只是加了一个独立的状态。
   *
   * ⚠️ 必须**点名助手**：不带 `agentId` 的 `skills.status` 会落到环境属主
   * （本机是 `main`），而技能缓存是**按助手**的 ⇒ 那是假绿。
   */
  const selectedAgentId = useUiStore((s) => s.getSelectedAgentOrDefault(gatewayId ?? ''));
  const verdicts = useSkillVerdicts({
    gatewayId,
    agentId: selectedAgentId,
    enabled: canAct,
    skills,
    nonce: verdictNonce,
  });

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <WindowTitlebar
        center={<span className="type-label">{t('leftNav.pages.skills')}</span>}
        right={
          // 刷新按钮不是装饰：网关没连上时整页是只读的，而网关重连**不会**让这一页自动重来
          //（没有订阅连接状态）⇒ 没这个按钮，用户只能切走再切回来。
          <Button
            variant="ghost"
            size="sm"
            data-testid="our-skill-refresh"
            onClick={() => {
              void load();
              // 刷新也要**重问助手那边**：网关重连之后，那一行状态同样需要重来一遍。
              setVerdictNonce((n) => n + 1);
            }}
          >
            <RefreshCw size={14} />
            <span className="ml-1.5">{t('skillMarket.refresh')}</span>
          </Button>
        }
      />
      <ScrollArea className="flex-1 min-h-0">
        <div className="flex w-full flex-col gap-4 px-4 py-4">
          {/* 页签（2026-10-17 设计稿）：技能 / 智能体 / 提示词。
              智能体复用真实专家库页；提示词库尚无实现 ⇒ 如实置灰，不做假入口。 */}
          <div className="flex items-center gap-4 border-b border-[var(--border-subtle)] pb-2">
            <span className="type-label -mb-2 inline-flex items-center gap-1.5 border-b-2 border-[var(--accent)] pb-2 text-[var(--accent)]">
              {t('skillMarket.tabSkills')}
              <span className="type-meta">{skills.length}</span>
            </span>
            <button
              type="button"
              onClick={() => setMainView('experts')}
              className="glow-focus type-label text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
            >
              {t('skillMarket.tabAgents')}
            </button>
            <button
              type="button"
              disabled
              title={t('skillMarket.promptsSoon')}
              className="type-label text-[var(--text-muted)] opacity-60"
            >
              {t('skillMarket.tabPrompts')}
            </button>
          </div>

          {state.kind === 'ready' && !state.managedDirKnown ? (
            <InlineNotice tone="warning">{t('skillMarket.gatewayRequired')}</InlineNotice>
          ) : null}

          {state.kind === 'loading' ? (
            <div className="flex items-center justify-center py-10 text-[var(--text-muted)]">
              <Loader2 size={18} className="animate-spin" />
            </div>
          ) : state.kind === 'error' ? (
            <InlineNotice tone="error">{t('skillMarket.loadFailed')}</InlineNotice>
          ) : skills.length === 0 ? (
            <EmptyState icon={<Sparkles size={18} />} title={t('skillMarket.empty')} className="py-10" />
          ) : (
            <>
              {/* 分类卡：渐变 + 数量 + 三个代表项，点一下就是筛选。 */}
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {categoryGroups.map((group) => {
                  const active = category === group.category;
                  return (
                    <button
                      key={group.category}
                      type="button"
                      data-testid={`skill-tile-${group.category}`}
                      onClick={() => setCategory(active ? 'all' : group.category)}
                      className={cn(
                        'skill-tile flex flex-col items-start gap-1 rounded-xl px-3.5 py-3 text-left transition-colors',
                        `skill-tile--${group.category}`,
                        active && 'ring-2 ring-[var(--accent)]',
                      )}
                    >
                      <span className="flex w-full items-center justify-between type-label">
                        {t(`skillMarket.category.${group.category}`)}
                        <ArrowRight size={14} />
                      </span>
                      <span className="type-meta opacity-80">{t('skillMarket.tileCount', { n: group.items.length })}</span>
                      <span className="type-meta line-clamp-2 opacity-80">
                        {group.items.slice(0, 3).map((item) => item.name ?? item.slug).join(' · ')}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* 搜索 + 总数（总数是真实值；不做假的使用次数/热度排序）。 */}
              <div className="flex flex-wrap items-center gap-3">
                <div className="relative w-full max-w-md">
                  <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                  <input
                    type="text"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('skillMarket.searchPlaceholder')}
                    className="h-[var(--density-control-height-sm)] w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] pl-9 pr-3 type-body text-[var(--text-primary)] placeholder:text-[var(--text-muted)] glow-focus"
                  />
                </div>
                <span
                  data-testid="our-skill-count"
                  data-field="count"
                  data-total={skills.length}
                  data-installed={installedCount}
                  className="type-support text-[var(--text-muted)]"
                >
                  {t('skillMarket.allInstalled', { n: skills.length })}
                </span>
              </div>

              {/* 分类筛选 chips */}
              <div className="flex flex-wrap gap-2">
                <FilterChip
                  active={category === 'all'}
                  label={t('experts.domain.all')}
                  count={skills.length}
                  onClick={() => setCategory('all')}
                />
                {categoryGroups.map((group) => (
                  <FilterChip
                    key={group.category}
                    active={category === group.category}
                    label={t(`skillMarket.category.${group.category}`)}
                    count={group.items.length}
                    onClick={() => setCategory(group.category)}
                  />
                ))}
              </div>

              {visibleSkills.length === 0 ? (
                <EmptyState icon={<Search size={18} />} title={t('skillMarket.noMatch')} className="py-10" />
              ) : (
                <div data-testid="our-skill-list" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                  {visibleSkills.map((skill) => (
                    <article
                      key={skill.slug}
                      data-testid="our-skill-row"
                      data-slug={skill.slug}
                      data-installed={skill.installed ? 'true' : 'false'}
                      data-verdict={verdicts[skill.slug]?.kind ?? 'none'}
                      className="flex flex-col gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-3.5"
                    >
                      <div className="flex items-start gap-2.5">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-tertiary)]">
                          <span className="emoji-sm">{skill.emoji ?? '🧩'}</span>
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="type-label truncate font-medium text-[var(--text-primary)]">
                              {skill.name ?? skill.slug}
                            </span>
                            {skill.installed ? (
                              <span className="type-meta shrink-0 rounded bg-[var(--accent)]/10 px-1.5 text-[var(--accent)]">
                                {t('skillMarket.installedBadge')}
                              </span>
                            ) : null}
                          </div>
                          {skill.description ? (
                            <p
                              className="type-support mt-1 line-clamp-2 break-words text-[var(--text-secondary)]"
                              title={skill.description}
                            >
                              {skill.description}
                            </p>
                          ) : null}
                        </div>
                      </div>
                      {canAct ? <SkillVerdictBadge verdict={verdicts[skill.slug] ?? { kind: 'none' }} /> : null}
                      <div className="mt-auto flex items-center gap-1.5 pt-1">
                        <span className="type-meta text-[var(--text-muted)]">
                          {t(`skillMarket.category.${skillCategoryOf(skill.slug)}`)}
                        </span>
                        <div className="ml-auto flex items-center gap-1">
                          {skill.installed ? (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              disabled={!canAct || busySlug !== null}
                              data-testid="our-skill-repair"
                              title={t('skillMarket.repair')}
                              aria-label={t('skillMarket.repair')}
                              onClick={() => setRepairTarget(skill)}
                            >
                              {busySlug === skill.slug && busyAction === 'repair' ? (
                                <Loader2 size={14} className="animate-spin" />
                              ) : (
                                <Wrench size={14} />
                              )}
                            </Button>
                          ) : null}
                          <Button
                            variant={skill.installed ? 'ghost' : 'default'}
                            size="icon-sm"
                            disabled={!canAct || busySlug !== null}
                            data-testid={skill.installed ? 'our-skill-remove' : 'our-skill-install'}
                            title={skill.installed ? t('skillMarket.remove') : t('skillMarket.install')}
                            aria-label={skill.installed ? t('skillMarket.remove') : t('skillMarket.install')}
                            onClick={() => void handleToggle(skill)}
                          >
                            {busySlug === skill.slug && busyAction === 'toggle' ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : skill.installed ? (
                              <Trash2 size={14} />
                            ) : (
                              <PackagePlus size={14} />
                            )}
                          </Button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>
      {/* 确认框要说清三件事：换掉的是什么（厂商文件）、什么不会被碰（你自己的文件）、
          出问题去哪儿找回（修复前的备份）。取消 = 一个 IPC 都不发。 */}
      <ConfirmDialog
        open={repairTarget !== null}
        title={t('skillMarket.repairConfirmTitle', { name: repairTarget?.name ?? repairTarget?.slug ?? '' })}
        description={t('skillMarket.repairConfirmBody')}
        confirmLabel={t('skillMarket.repairConfirm')}
        onConfirm={() => {
          if (repairTarget) void handleRepair(repairTarget);
        }}
        onCancel={() => setRepairTarget(null)}
      />
    </div>
  );
}

/** 分类筛选 chip（设计稿同款；选中态用强调色）。 */
function FilterChip({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'glow-focus inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 type-support transition-colors',
        active
          ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
          : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border)] hover:text-[var(--text-primary)]',
      )}
    >
      <span>{label}</span>
      <span className="type-meta opacity-70">{count}</span>
    </button>
  );
}
