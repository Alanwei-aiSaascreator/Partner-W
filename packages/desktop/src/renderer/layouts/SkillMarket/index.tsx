import { useCallback, useEffect, useState } from 'react';
import { Loader2, PackagePlus, RefreshCw, Sparkles, Trash2, Wrench } from 'lucide-react';
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
          <div className="flex flex-wrap items-center gap-3">
            <p className="type-meta text-[var(--text-secondary)]">{t('skillMarket.subtitle')}</p>
            {/* 数量装置（2026-09-29）：**已装数**比总数更有用 —— 用户想知道"我还差几个"。
                ⚠️ 空列表时不显示（"共 0 个"是噪音）。 */}
            {state.kind === 'ready' && skills.length > 0 ? (
              <span
                data-testid="our-skill-count"
                data-field="count"
                data-total={skills.length}
                data-installed={installedCount}
                className="type-support ml-auto shrink-0 text-[var(--text-muted)]"
              >
                {t('skillMarket.count', { total: skills.length, installed: installedCount })}
              </span>
            ) : null}
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
            <ul className="divide-y divide-[var(--border-subtle)]" data-testid="our-skill-list">
              {skills.map((skill) => (
                <li
                  key={skill.slug}
                  data-testid="our-skill-row"
                  data-slug={skill.slug}
                  data-installed={skill.installed ? 'true' : 'false'}
                  data-verdict={verdicts[skill.slug]?.kind ?? 'none'}
                  className="-mx-2 flex flex-col items-start gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-[var(--bg-secondary)] sm:flex-row sm:items-center"
                >
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--bg-tertiary)]">
                      <span className="emoji-sm">{skill.emoji ?? '🧩'}</span>
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        {/* ⚠️ 技能名与描述来自 SKILL.md 的 frontmatter，**不进 i18n** ——
                        与市场里的官方模板同一个口径（内容自带，不随界面语言变）。 */}
                        <span className="type-label break-words font-medium text-[var(--text-primary)]">
                          {skill.name ?? skill.slug}
                        </span>
                        {skill.installed ? (
                          <span className="type-meta shrink-0 rounded bg-[var(--accent)]/10 px-1.5 text-[var(--accent)]">
                            {t('skillMarket.installedBadge')}
                          </span>
                        ) : null}
                      </div>
                      {/* 描述限宽 + 两行封顶（2026-10-12 排版精修）：此前全宽换行，
                          宽屏上一条描述横跨一千多像素，行行见尾才换行 —— 扫读性最差的一处。
                          完整文案保留在 title（悬停可见），信息不丢。 */}
                      {skill.description ? (
                        <p
                          className="type-support mt-1.5 line-clamp-2 max-w-2xl break-words text-[var(--text-secondary)]"
                          title={skill.description}
                        >
                          {skill.description}
                        </p>
                      ) : null}
                      {/* 「已装」是磁盘的事；这一行是**网关按助手**回来的答案。两件事，两个标签。
                      ⚠️ 只有**问得出去**的时候才画（`canAct`）：网关没连上时整页已经有一条
                      「未连接」的提示了，再给每张卡挂一句"没问出来"是噪音 ——
                      而且会让人以为是**这个技能**的问题，其实只是网关没连上。 */}
                      {canAct ? <SkillVerdictBadge verdict={verdicts[skill.slug] ?? { kind: 'none' }} /> : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {/* ⭐ E3：已装的那一行多一个**独立**的「修复随包版本」动作（卸载按钮原样保留）。
                        它只做"换成当前随包的那份"，且必须用户确认过才发 IPC。 */}
                    {skill.installed ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canAct || busySlug !== null}
                        data-testid="our-skill-repair"
                        onClick={() => setRepairTarget(skill)}
                        className="shrink-0"
                      >
                        {busySlug === skill.slug && busyAction === 'repair' ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Wrench size={14} />
                        )}
                        <span className="ml-1.5">{t('skillMarket.repair')}</span>
                      </Button>
                    ) : null}
                    <Button
                      variant={skill.installed ? 'ghost' : 'default'}
                      size="sm"
                      disabled={!canAct || busySlug !== null}
                      data-testid={skill.installed ? 'our-skill-remove' : 'our-skill-install'}
                      onClick={() => void handleToggle(skill)}
                      className="shrink-0"
                    >
                      {busySlug === skill.slug && busyAction === 'toggle' ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : skill.installed ? (
                        <Trash2 size={14} />
                      ) : (
                        <PackagePlus size={14} />
                      )}
                      <span className="ml-1.5">
                        {skill.installed ? t('skillMarket.remove') : t('skillMarket.install')}
                      </span>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
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
