import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Compass, Feather, Hammer, Search, ShieldCheck, Target } from 'lucide-react';
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
 * 「我的 AI 团队」圆桌（2026-10-06 V1 收口 · 任务 08；2026-10-12 视觉重做）。
 *
 * 冻结契约：**主罗盘（main）+ 五岗位（调研员/分析师/创作师/制作师/质检师）**。
 * 推导层（`roundtable.ts`）零改动；这里只做视觉层：
 *   - 双轨道环 + 中心光晕罗盘 = 「圆桌」意象（此前是五张矩形卡漂浮，观感散）；
 *   - 五岗位改为**圆形徽章 + 状态点**（状态文字进 `title` 与 `sr-only`，
 *     不再占三行文字——开会后满屏「已完成」的视觉噪声降下来）；
 *   - 进行中（working）= 徽章亮起 + 扩散脉冲环；需要处理（attention）= 警示色状态点。
 *
 * ⚠️ **状态只来自真实信号**（团队开会的 `TeamMeetingRecord.turns` 真实 status，
 *    推导见 `roundtable.ts`）。没有任何记录 ⇒ 整组「未启用」；会议没跑到的岗位 ⇒「待命」。
 *    这里**不许**出现任何计时器 / 假进度。
 * ⚠️ `data-testid` / `data-position` / `data-status` 与全部文案 key 是测试与冒烟的契约，
 *    视觉重做**不许动**它们（`team-roundtable.test.tsx` 钉着）。
 */
const POSITION_ICONS: Record<RoundtablePosition, typeof Search> = {
  researcher: Search,
  analyst: Target,
  creator: Feather,
  producer: Hammer,
  inspector: ShieldCheck,
};

/** 状态 → 徽章右下角状态点（语义 token，遵守 UI 契约；working 另有脉冲环）。 */
const STATUS_DOT_CLASSES: Record<RoundtableStatus, string> = {
  idle: 'bg-[var(--border)]',
  working: 'bg-[var(--accent)]',
  done: 'bg-[var(--accent)]',
  attention: 'bg-[var(--text-warning)]',
  disabled: 'bg-[var(--border)] opacity-60',
};

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
      className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="type-section-title text-[var(--text-primary)]">{t('teams.roundtable.title')}</h2>
        {record && (
          <p
            data-testid="roundtable-latest"
            className="type-meta flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-2.5 py-1 text-[var(--text-muted)]"
          >
            <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
            <span className="truncate">{t('teams.roundtable.latest', { question: record.question })}</span>
          </p>
        )}
      </div>
      <p className="type-meta mt-1 text-[var(--text-muted)]">{t('teams.roundtable.subtitle')}</p>

      <div className="roundtable-stage relative mx-auto my-4 aspect-square w-full max-w-[var(--content-card-min)]">
        {/* 桌面轨道：双环（纯装饰，不承载状态；用内置分数尺度避开门禁的任意值） */}
        <div
          aria-hidden
          className="absolute left-1/2 top-1/2 h-5/6 w-5/6 -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-[var(--border-subtle)]"
        />
        <div
          aria-hidden
          className="absolute left-1/2 top-1/2 h-1/2 w-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[var(--border-subtle)]"
        />

        {/* 中心：主罗盘（一级身份，不占五岗位名额）——品牌光晕圆 */}
        <div
          data-testid="roundtable-compass"
          className="absolute left-1/2 top-1/2 flex h-24 w-24 -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center gap-1 rounded-full border border-[var(--border-accent)] bg-[var(--accent-soft)] shadow-[0_0_36px_var(--accent-soft)]"
        >
          <Compass size={22} className="text-[var(--accent)]" />
          <span className="type-meta font-medium text-[var(--text-primary)]">{t('teams.roundtable.compass')}</span>
        </div>

        {ROUNDTABLE_POSITIONS.map((position, index) => {
          const angle = (Math.PI * 2 * index) / ROUNDTABLE_POSITIONS.length - Math.PI / 2;
          const left = 50 + 37 * Math.cos(angle);
          const top = 50 + 37 * Math.sin(angle);
          const Icon = POSITION_ICONS[position];
          const status = statuses[position];
          const statusLabel = t(`teams.roundtable.status.${status}`);
          return (
            <div
              key={position}
              data-position={position}
              data-status={status}
              title={statusLabel}
              className="absolute flex w-16 -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1"
              style={{ left: `${left}%`, top: `${top}%` }}
            >
              <span
                className={cn(
                  'relative flex h-11 w-11 items-center justify-center rounded-full border bg-[var(--bg-secondary)] transition-colors',
                  status === 'working' && 'border-[var(--border-accent)] bg-[var(--accent-soft)]',
                  status === 'disabled' && 'opacity-70',
                )}
              >
                {status === 'working' && (
                  <span
                    aria-hidden
                    className="absolute inset-0 animate-ping rounded-full border border-[var(--border-accent)] motion-reduce:animate-none"
                  />
                )}
                <Icon
                  size={16}
                  className={cn(
                    status === 'working' ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]',
                    status === 'disabled' && 'text-[var(--text-muted)]',
                  )}
                />
                {/* 状态点：对内说状态，对外（hover/读屏）说人话（下面的 sr-only + title） */}
                <span
                  aria-hidden
                  className={cn(
                    'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[var(--bg-primary)]',
                    STATUS_DOT_CLASSES[status],
                  )}
                />
              </span>
              {/* 岗位名走**共用词表**（与个性化中心的五岗位同一组键，别再另起一套） */}
              <span className="type-meta text-center text-[var(--text-primary)]">
                {t(`identity.teamPosition.${position}.name`)}
              </span>
              <span className="sr-only">{statusLabel}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
