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
        toast.success(
          skill.installed
            ? t('skillMarket.removed', { name: skill.name ?? '' })
            : t('skillMarket.installed', { name: skill.name ?? '' }),
        );
        await load();
      } finally {
        setBusySlug(null);
      }
    },
    [gatewayId, busySlug, load, t],
  );

  const skills = state.kind === 'ready' ? state.skills : [];
  const canAct = state.kind === 'ready' && state.managedDirKnown && Boolean(gatewayId);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <WindowTitlebar
        center={<span className="type-label">{t('leftNav.pages.skills')}</span>}
        right={
          // 刷新按钮不是装饰：网关没连上时整页是只读的，而网关重连**不会**让这一页自动重来
          //（没有订阅连接状态）⇒ 没这个按钮，用户只能切走再切回来。
          <Button variant="ghost" size="sm" data-testid="our-skill-refresh" onClick={() => void load()}>
            <RefreshCw size={14} />
            <span className="ml-1.5">{t('skillMarket.refresh')}</span>
          </Button>
        }
      />
      <ScrollArea className="flex-1 min-h-0">
        <div className="mx-auto flex w-full max-w-[var(--content-max-width)] flex-col gap-4 px-6 py-5">
          <p className="type-meta text-[var(--text-secondary)]">{t('skillMarket.subtitle')}</p>

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
            <ul className="flex flex-col gap-2" data-testid="our-skill-list">
              {skills.map((skill) => (
                <li
                  key={skill.slug}
                  data-testid="our-skill-row"
                  data-slug={skill.slug}
                  data-installed={skill.installed ? 'true' : 'false'}
                  className="surface-card flex items-start gap-3 rounded-xl px-4 py-3"
                >
                  <span className="emoji-md shrink-0 leading-7">{skill.emoji ?? '🧩'}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {/* ⚠️ 技能名与描述来自 SKILL.md 的 frontmatter，**不进 i18n** ——
                          与市场里的官方模板同一个口径（内容自带，不随界面语言变）。 */}
                      <span className="type-label text-[var(--text-primary)]">{skill.name ?? skill.slug}</span>
                      {skill.installed ? (
                        <span className="type-meta rounded bg-[var(--accent)]/10 px-1.5 text-[var(--accent)]">
                          {t('skillMarket.installedBadge')}
                        </span>
                      ) : null}
                    </div>
                    {skill.description ? (
                      <p className="type-meta mt-1 text-[var(--text-secondary)]">{skill.description}</p>
                    ) : null}
                  </div>
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
