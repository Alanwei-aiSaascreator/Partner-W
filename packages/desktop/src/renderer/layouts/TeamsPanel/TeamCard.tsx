import { MessageSquare, MoreHorizontal, Pencil, Trash2, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Team } from '@clawwork/shared';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TeamCardShell } from './TeamCardShell';

interface TeamCardProps {
  team: Team;
  /**
   * ⭐ C3：这个团队**要进的那个助手不在本机**（判据见 `lib/team-chat-entry.ts`）。
   *
   * 为什么要在卡片上就说：点下去才发现"这个助手不在本机"是**白跳一趟** ——
   * 用户被带进会话，还得自己退回来。卡片上先说，就知道该先装。
   * ⚠️ 判据在卡片外面算好传进来（卡片不该自己去读 store：那会让它没法单独测）。
   */
  needsInstall?: boolean;
  onSelect: () => void;
  onStartChat: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export default function TeamCard({ team, needsInstall, onSelect, onStartChat, onEdit, onDelete }: TeamCardProps) {
  const { t } = useTranslation();

  return (
    <TeamCardShell
      emoji={team.emoji}
      name={team.name}
      description={team.description}
      memberCount={team.agents.length}
      subtitle={
        needsInstall ? (
          <span
            data-testid="team-needs-install"
            className="type-meta inline-flex items-center gap-1 rounded-md bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[var(--text-warning)]"
          >
            <TriangleAlert size={12} aria-hidden="true" />
            {t('teams.needsInstall')}
          </span>
        ) : undefined
      }
      onClick={onSelect}
      topRight={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              onClick={(e) => e.stopPropagation()}
              aria-label={t('common.moreActions')}
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] cursor-pointer focus-visible:outline-none glow-focus"
            >
              <MoreHorizontal size={15} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>
              <Pencil size={14} />
              {t('teams.editTeam')}
            </DropdownMenuItem>
            <DropdownMenuItem danger onClick={onDelete}>
              <Trash2 size={14} />
              {t('teams.deleteTeam')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
      actions={
        <Button
          size="sm"
          variant="soft"
          onClick={(e) => {
            e.stopPropagation();
            onStartChat();
          }}
        >
          <MessageSquare size={14} />
          {t('teams.startChat')}
        </Button>
      }
    />
  );
}
