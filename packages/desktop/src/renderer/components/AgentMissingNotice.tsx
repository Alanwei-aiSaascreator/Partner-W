import { useTranslation } from 'react-i18next';
import InlineNotice from '@/components/semantic/InlineNotice';

interface AgentMissingNoticeProps {
  /** 用户/调用方点名要的那个助手（不在本机）。 */
  agentId: string;
  /**
   * 出口。**给了才渲染按钮** —— 左栏那一列太窄，只放说明不放按钮
   * （那边的出口是团队页，用户自己走过去）。
   */
  onSwitchAssistant?: () => void;
  onOpenTeams?: () => void;
  className?: string;
}

/**
 * 「你点的这个助手不在本机」。
 *
 * 2026-09-24：三处入口（团队/欢迎屏、左栏切换器、身份中心）共用这一条 ——
 * 判据在 `lib/requested-agent.ts`，它保证**目录还没拉回来时不会走到这里**
 * （那种情况下说"不在本机"就是误报失败）。
 *
 * ⚠️ 措辞里点出**下一步**（换一个助手 / 去团队页），不是干说一句坏消息。
 */
export default function AgentMissingNotice({
  agentId,
  onSwitchAssistant,
  onOpenTeams,
  className,
}: AgentMissingNoticeProps) {
  const { t } = useTranslation();

  return (
    <InlineNotice tone="warning" className={className}>
      <p className="type-label">{t('agent.missingTitle', { agentId })}</p>
      <p className="mt-0.5 text-[var(--text-secondary)]">{t('agent.missingBody')}</p>
      {onSwitchAssistant || onOpenTeams ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {onSwitchAssistant ? (
            <button
              type="button"
              onClick={onSwitchAssistant}
              className="type-label inline-flex items-center gap-2 rounded-xl border border-[var(--accent)] bg-[var(--accent-dim)] px-4 py-2.5 text-[var(--accent)] transition-colors focus-visible:outline-none glow-focus"
            >
              {t('agent.missingSwitch', { assistant: t('mainArea.compassAssistant') })}
            </button>
          ) : null}
          {onOpenTeams ? (
            <button
              type="button"
              onClick={onOpenTeams}
              className="type-label inline-flex items-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-none glow-focus"
            >
              {t('agent.missingOpenTeams')}
            </button>
          ) : null}
        </div>
      ) : null}
    </InlineNotice>
  );
}
