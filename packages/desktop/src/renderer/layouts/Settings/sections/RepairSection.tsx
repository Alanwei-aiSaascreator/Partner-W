import { useTranslation } from 'react-i18next';
import RepairPanel from '@/features/repair/RepairPanel';

/**
 * 设置 → 诊断与修复（SPEC 一·第二批「同一引擎嵌入应用」）。
 *
 * ⚠️ 这里**只有接线，没有判据**：面板块与 `--repair` 独立窗口用的是同一个组件、
 *    同一组 IPC、同一个主进程引擎（`main/repair/*`）。引擎单真源是 SPEC 一·第二批
 *    的硬要求 —— 两处各写一遍，"修好了"就成了两件不同的事。
 */
export default function RepairSection() {
  const { t } = useTranslation();
  return (
    <div>
      <h3 className="type-section-title mb-4 text-[var(--text-primary)]">{t('settings.repair.title')}</h3>
      <RepairPanel />
    </div>
  );
}
