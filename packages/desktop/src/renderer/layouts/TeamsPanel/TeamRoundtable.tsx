import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Compass,
  Feather,
  Hammer,
  MinusCircle,
  Loader2,
  Search,
  ShieldCheck,
  Target,
} from 'lucide-react';
import { useUiStore } from '@/platform';
import { teamMeetingController, useTeamMeetingStore } from '@/features/team-meeting/instance';
import { cn } from '@/lib/utils';
import {
  ROUNDTABLE_POSITIONS,
  deriveRoundtableSignal,
  type RoundtablePosition,
  type RoundtableStatus,
} from './roundtable';

/**
 * 「我的 AI 团队」轻量圆桌（2026-10-06，V1 收口 · 任务 08）。
 *
 * 冻结契约：**主罗盘（main）+ 五岗位（调研员/分析师/创作师/制作师/质检师）**。
 * 白底卡 + 简单 CSS 圆环；不引入新依赖、不做深接线。
 *
 * ⚠️ **状态只来自真实信号**（团队开会的 `TeamMeetingRecord.turns` 真实 status，
 *    推导见 `roundtable.ts`）。没有任何记录 ⇒ 整组「未启用」；会议没跑到的岗位 ⇒「待命」。
 *    这里**不许**出现任何计时器 / 假进度。
 */
const POSITION_ICONS: Record<RoundtablePosition, typeof Search> = {
  researcher: Search,
  analyst: Target,
  creator: Feather,
  producer: Hammer,
  inspector: ShieldCheck,
};

/** 状态四档（+ 未启用）+ 配色：只用语义 token，遵守 UI 契约。 */
const STATUS_CLASSES: Record<RoundtableStatus, string> = {
  idle: 'text-[var(--text-muted)]',
  working: 'text-[var(--accent)]',
  done: 'text-[var(--accent)]',
  attention: 'text-[var(--text-warning)]',
  disabled: 'text-[var(--text-muted)] opacity-70',
};

function StatusIcon({ status }: { status: RoundtableStatus }) {
  const className = cn('h-3.5 w-3.5 shrink-0', STATUS_CLASSES[status]);
  if (status === 'working') return <Loader2 className={cn(className, 'animate-spin')} />;
  if (status === 'done') return <CheckCircle2 className={className} />;
  if (status === 'attention') return <AlertTriangle className={className} />;
  if (status === 'disabled') return <MinusCircle className={className} />;
  return <Circle className={className} />;
}

export default function TeamRoundtable() {
  const { t } = useTranslation();
  const gatewayId = useUiStore((s) => s.defaultGatewayId ?? undefined);
  const records = useTeamMeetingStore((s) => s.records);
  const loaded = useTeamMeetingStore((s) => s.loaded);

  // 真实信号要**先取回来**才有一切（与团队开会对话框同一条只有一次的加载路径）。
  useEffect(() => {
    if (!loaded) void teamMeetingController.load().catch(() => {});
  }, [loaded]);

  const { record, statuses } = deriveRoundtableSignal(records, { gatewayId });

  return (
    <section
      data-testid="team-roundtable"
      aria-label={t('teams.roundtable.title')}
      className="rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="type-section-title text-[var(--text-primary)]">{t('teams.roundtable.title')}</h2>
        {record && (
          <p data-testid="roundtable-latest" className="type-meta min-w-0 max-w-full truncate text-[var(--text-muted)]">
            {t('teams.roundtable.latest', { question: record.question })}
          </p>
        )}
      </div>
      <p className="type-meta mt-1 text-[var(--text-muted)]">{t('teams.roundtable.subtitle')}</p>

      <div className="relative mx-auto my-3 aspect-square w-full max-w-[var(--content-card-min)]">
        {/* 中心：主罗盘（一级身份，不占五岗位名额） */}
        <div
          data-testid="roundtable-compass"
          className="absolute left-1/2 top-1/2 flex w-24 -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1 rounded-full border border-[var(--border-accent)] bg-[var(--accent-soft)] px-2 py-3 text-center"
        >
          <Compass size={18} className="text-[var(--accent)]" />
          <span className="type-meta font-medium text-[var(--text-primary)]">{t('teams.roundtable.compass')}</span>
        </div>

        {ROUNDTABLE_POSITIONS.map((position, index) => {
          const angle = (Math.PI * 2 * index) / ROUNDTABLE_POSITIONS.length - Math.PI / 2;
          const left = 50 + 34 * Math.cos(angle);
          const top = 50 + 34 * Math.sin(angle);
          const Icon = POSITION_ICONS[position];
          const status = statuses[position];
          return (
            <div
              key={position}
              data-position={position}
              data-status={status}
              className="absolute flex w-20 -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-1.5 py-2 text-center"
              style={{ left: `${left}%`, top: `${top}%` }}
            >
              <Icon size={14} className="text-[var(--text-secondary)]" />
              {/* 岗位名走**共用词表**（与个性化中心的五岗位同一组键，别再另起一套） */}
              <span className="type-meta text-[var(--text-primary)]">
                {t(`identity.teamPosition.${position}.name`)}
              </span>
              <span className={cn('type-meta flex items-center gap-1', STATUS_CLASSES[status])}>
                <StatusIcon status={status} />
                {t(`teams.roundtable.status.${status}`)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
