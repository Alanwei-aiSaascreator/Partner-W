import { useCallback, useEffect, useState } from 'react';
import { Loader2, PackagePlus, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import EmptyState from '@/components/semantic/EmptyState';
import InlineNotice from '@/components/semantic/InlineNotice';
import WindowTitlebar from '@/components/semantic/WindowTitlebar';
import { toast } from '@/lib/toast';
import { useUiStore } from '@/stores/uiStore';
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
      setBusySlug(skill.slug);
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
      } finally {
        setBusySlug(null);
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
        <div className="mx-auto flex w-full max-w-[var(--content-max-width)] flex-col gap-4 px-6 py-5">
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
            /* 卡片网格（2026-09-29）：原来是"一行一条"的竖排列表。
               ⚠️ 类名照 `TeamsPanel` 那一处**原样抄** —— 带内容宽度变量的那一种是唯一被
               UI 契约放行的任意值网格写法（别自己捏一个自定像素值，会被判成布局逃逸）。
               ⚠️ 也**别在注释里照抄那个类名或那个变量名**：`check:ui-contract`
               **连注释一起扫**，会把注释里的字面量当成真违规
               （2026-09-29 我连栽两次：第一版写类名、第二版写变量名，各红一次）。 */
            <ul
              className="grid grid-cols-[repeat(auto-fill,minmax(var(--content-card-min),1fr))] gap-4"
              data-testid="our-skill-list"
            >
              {skills.map((skill) => (
                <li
                  key={skill.slug}
                  data-testid="our-skill-row"
                  data-slug={skill.slug}
                  data-installed={skill.installed ? 'true' : 'false'}
                  data-verdict={verdicts[skill.slug]?.kind ?? 'none'}
                  className="surface-card flex flex-col items-start gap-3 rounded-xl p-5"
                >
                  <div className="flex w-full items-center gap-2">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-tertiary)]">
                      <span className="emoji-lg">{skill.emoji ?? '🧩'}</span>
                    </span>
                    {/* ⚠️ 技能名与描述来自 SKILL.md 的 frontmatter，**不进 i18n** ——
                        与市场里的官方模板同一个口径（内容自带，不随界面语言变）。 */}
                    <span className="type-section-title truncate text-[var(--text-primary)]">
                      {skill.name ?? skill.slug}
                    </span>
                    {skill.installed ? (
                      <span className="type-meta ml-auto shrink-0 rounded bg-[var(--accent)]/10 px-1.5 text-[var(--accent)]">
                        {t('skillMarket.installedBadge')}
                      </span>
                    ) : null}
                  </div>
                  {skill.description ? (
                    <p className="type-body line-clamp-2 text-[var(--text-secondary)]">{skill.description}</p>
                  ) : null}
                  {/* 「已装」是磁盘的事；这一行是**网关按助手**回来的答案。两件事，两个标签。
                      ⚠️ 只有**问得出去**的时候才画（`canAct`）：网关没连上时整页已经有一条
                      「未连接」的提示了，再给每张卡挂一句"没问出来"是噪音 ——
                      而且会让人以为是**这个技能**的问题，其实只是网关没连上。 */}
                  {canAct ? <SkillVerdictBadge verdict={verdicts[skill.slug] ?? { kind: 'none' }} /> : null}
                  <Button
                    variant={skill.installed ? 'ghost' : 'default'}
                    size="sm"
                    disabled={!canAct || busySlug !== null}
                    data-testid={skill.installed ? 'our-skill-remove' : 'our-skill-install'}
                    onClick={() => void handleToggle(skill)}
                    className="shrink-0"
                  >
                    {busySlug === skill.slug ? (
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
                </li>
              ))}
            </ul>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
