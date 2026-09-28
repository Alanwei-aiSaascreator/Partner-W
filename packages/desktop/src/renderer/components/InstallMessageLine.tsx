import { useTranslation } from 'react-i18next';
import { localizeInstallMessage } from '@/lib/install-message';

/**
 * 一条安装告警/错误：**中文人话当标题，网关原文当细节**。
 *
 * ⭐ 两句话**都要在**，这是两次实机各撞一次换来的（缺哪一句都是错的）：
 *
 * - **只有英文原文** ⇒ 用户看不懂，看起来就是"坏了"。
 *   2026-09-28 真机：「创建团队是英文而且还是创建失败」。
 * - **只有中文人话** ⇒ **原因没了**，用户和我们都没有可读的原因，只能猜。
 *   2026-09-20 实机四个助手全建失败，面板只剩 slug + 一句
 *   `NO AGENTS WERE CREATED SUCCESSFULLY` —— `install-progress-reason.test.tsx`
 *   就是那次钉下来的（它的注释写着"原文必须上屏"）。
 *
 * 所以这里不是二选一：人话在上、原文在下（小一号、弱化色），谁都不删。
 * 原文只在**与人话不同**时出现，避免本来就认得的句子重复两遍。
 */
export function InstallMessageLine({ message }: { message: string }) {
  const { t } = useTranslation();
  const humanized = localizeInstallMessage(message, t);
  if (humanized === message) return <span>{humanized}</span>;
  return (
    <span className="flex-1">
      <span className="block">{humanized}</span>
      <span className="mt-0.5 block break-all text-[var(--text-muted)] opacity-80">{message}</span>
    </span>
  );
}
