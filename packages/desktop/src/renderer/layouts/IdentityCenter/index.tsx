import { useTranslation } from 'react-i18next';
import { Check, RotateCcw, Sparkles, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

/**
 * 身份中心 —— **本版只做排版，未接任何数据/逻辑**（2026-09-19）。
 *
 * ## 为什么是静态的
 *
 * 需求原话是「**就是排版**」：先把版式立起来给老板看密度，逻辑后面单独排期。
 * ⇒ 下面所有标签、角色、技能都是**写死的展示数据**，不是从任何 store / IPC 来的；
 *    「应用此画像」「保存并应用此身份配置」两个按钮**没有 onClick**（按下去不会有任何事）。
 *
 * ⚠️ 后面接逻辑时，**别把这份写死数据当成"接口形状"照抄** —— 它是照设计稿摆的版。
 *
 * ## 密度
 *
 * 版式按 `D:\Desktop\mofang-ui-preview\app-dense.html` 那版原型定稿的密度来
 * （间距用 gap-2/gap-3 一档，不是仓库既有的 gap-4/gap-6）。
 * ⚠️ 仓库**已有**一套密度变量（`--density-*`，见 theme.css 的 data-density 三档），
 *    但实测它**只覆盖控件高度/工具栏**（`--density-panel-gap` 甚至 0 引用），
 *    管不到页面级留白 ⇒ 这里先用显式的间距类；全应用统一收紧是另一件事。
 */
export default function IdentityCenter() {
  const { t } = useTranslation();

  /** 写死的展示数据 —— 见文件头「为什么是静态的」。 */
  const personaTags = ['goalOriented', 'efficiency', 'logical', 'reporting', 'timeManagement'] as const;
  const selectedTags = new Set<(typeof personaTags)[number]>(['goalOriented', 'efficiency', 'logical', 'reporting']);
  const skills = [
    'docManager',
    'officeDoc',
    'dataAssistant',
    'dataViz',
    'meetingSecretary',
    'toolbox',
    'mailExpert',
  ] as const;
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
                {personaTags.map((key) => (
                  <span
                    key={key}
                    data-tag={key}
                    data-selected={selectedTags.has(key) ? 'true' : 'false'}
                    className={
                      'type-badge inline-flex items-center rounded-full px-2.5 py-1 ' +
                      (selectedTags.has(key)
                        ? 'bg-[var(--accent-dim)] font-semibold text-[var(--accent)]'
                        : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]')
                    }
                  >
                    {t(`identity.tag.${key}`)}
                  </span>
                ))}
              </div>

              <div className="mt-3 grid grid-cols-4 gap-4">
                <div>
                  <p className="type-support text-[var(--text-muted)]">{t('identity.roleLabel')}</p>
                  <p className="type-body mt-1 font-semibold text-[var(--text-primary)]" data-field="role">
                    {t('identity.roleValue')}
                  </p>
                </div>
                <div className="col-span-3">
                  <p className="type-support text-[var(--text-muted)]">{t('identity.skillsLabel')}</p>
                  <div className="mt-1 flex flex-wrap gap-1.5" data-field="skills">
                    {skills.map((key) => (
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

            <div className="flex items-center gap-2 border-t border-[var(--border)] px-4 py-2">
              <Button variant="ghost" size="sm" className="type-support">
                <RotateCcw />
                {t('identity.reselect')}
              </Button>
              <Button variant="ghost" size="sm" className="type-support">
                {t('identity.shuffle')}
              </Button>
              <span className="flex-1" />
              <Button size="sm" className="type-support">
                <Check />
                {t('identity.apply')}
              </Button>
            </div>
          </section>

          {/* ── 其它客群 ── */}
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
        <Button size="sm" className="type-support">
          {t('identity.save')}
        </Button>
      </div>
    </div>
  );
}
