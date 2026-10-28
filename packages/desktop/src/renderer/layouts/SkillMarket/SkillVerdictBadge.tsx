import { AlertTriangle, Check, HelpCircle, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { SkillVerdict } from './verdict';

/**
 * 「**这个助手**现在能不能用它」的那一行（2026-09-29）。
 *
 * 与「已装」徽章是**两个**东西，故意分开画：
 * - 已装 = 盘上有那个目录（主进程看的，不会骗人，但也不代表助手能用）；
 * - 这一行 = 网关（`skills.status`，按助手）现在认不认它。
 *
 * ⭐ 四态各有各的画法，**"不知道"必须画成"不知道"**：
 * 问不到的时候既不许画成绿（骗用户），也不许画成红（冤枉网关）。
 *
 * ⚠️ 颜色只用语义 token（`--accent` / `--text-warning` / `--text-muted`）——
 * `check:ui-contract` 不允许裸色值，也不允许调色板类名。
 */
export default function SkillVerdictBadge({ verdict }: { verdict: SkillVerdict }) {
  const { t } = useTranslation();

  if (verdict.kind === 'none') return null;

  const base = 'type-meta mt-1.5 flex items-center gap-1';

  if (verdict.kind === 'checking') {
    return (
      <span data-testid="our-skill-verdict" className={cn(base, 'text-[var(--text-muted)]')}>
        <Loader2 size={11} className="animate-spin" />
        {t('skillMarket.verdictChecking')}
      </span>
    );
  }

  if (verdict.kind === 'usable') {
    return (
      <span data-testid="our-skill-verdict" className={cn(base, 'text-[var(--accent)]')}>
        <Check size={11} />
        {t('skillMarket.verdictUsable')}
      </span>
    );
  }

  if (verdict.kind === 'blocked') {
    return (
      <span data-testid="our-skill-verdict" className={cn(base, 'text-[var(--text-warning)]')}>
        <AlertTriangle size={11} className="shrink-0" />
        {verdict.reason}
      </span>
    );
  }

  // unknown：**如实说"没问出来"**，并给出下一步（刷新按钮）。
  return (
    <span data-testid="our-skill-verdict" className={cn(base, 'text-[var(--text-muted)]')}>
      <HelpCircle size={11} className="shrink-0" />
      {t('skillMarket.verdictUnknown')}
    </span>
  );
}
