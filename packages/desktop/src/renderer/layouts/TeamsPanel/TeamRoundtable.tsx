import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Compass, Feather, Hammer, Search, ShieldCheck, Target } from 'lucide-react';
import { useUiStore } from '@/platform';
import { teamMeetingController, useTeamMeetingStore } from '@/features/team-meeting/instance';
import type { MeetingPhase } from '@/features/team-meeting/status';
import { cn } from '@/lib/utils';
import { ROUNDTABLE_POSITIONS, deriveRoundtableSignal, type RoundtablePosition } from './roundtable';

/**
 * 「我的 AI 团队」圆桌（2026-10-06 V1 收口 · 任务 08；2026-10-12 视觉重做）。
 *
 * 冻结契约：**主罗盘（main）+ 五岗位（调研员/分析师/创作师/制作师/质检师）**。
 *   - 双轨道环 + 中心光晕罗盘 = 「圆桌」意象；
 *   - 岗位做成**圆形徽章 + 状态点**（状态文字进 `title` 与 `sr-only`）。
 *
 * ⚠️ **状态只来自真实信号**（团队开会的 `TeamMeetingRecord.turns` 真实 status，
 *    推导见 `roundtable.ts`）。这里**不许**出现任何计时器 / 假进度。
 *
 * ⚠️ 2026-10-16（T30）：岗位归属**只认真实 `turn.agentId`**，`positions` 里只会有
 *    **真的**归到岗位的那些。真源没有"这一轮属于哪个岗位"的载体 ⇒ 当前恒为空
 *    ⇒ **舞台上的岗位徽章整行不渲染**（不画 5 个"未归因"灰徽章：那是把"我们没有这条
 *    数据"变成每次开会都挂着的常驻噪声）。"这一轮属于谁"由**真实参与名单**
 *    （真实 agentName / stage / status）承担。
 *
 * ⚠️ 2026-10-17（T30b）：舞台空着不等于圆桌「只剩一个圈」。补一条**五岗位结构行** ——
 *    把这五个岗位当**结构说明**呈现（各自是什么、负责哪一段），**零状态**：
 *    没有 `data-status`、没有状态点、没有进度，纯静态。它描述的是**执行结构本身**，
 *    不是"谁在跑"。"谁在跑"仍只走真实信号（参与名单 / 将来真源有岗位载体时的徽章）。
 * ⚠️ 全部文案 key 是测试与冒烟的契约（`team-roundtable.test.tsx` 钉着）。
 */
const POSITION_ICONS: Record<RoundtablePosition, typeof Search> = {
  researcher: Search,
  analyst: Target,
  creator: Feather,
  producer: Hammer,
  inspector: ShieldCheck,
};

/** 相位 → 文字色（真实参与名单里那颗状态胶囊；与协作条 `STATUS_CLASSES` 同源语义）。 */
const PHASE_TEXT_CLASSES: Record<MeetingPhase, string> = {
  idle: 'text-[var(--text-muted)]',
  working: 'text-[var(--accent)]',
  done: 'text-[var(--accent)]',
  attention: 'text-[var(--text-warning)]',
};

/** 相位 → 徽章右下角状态点（语义 token，遵守 UI 契约；working 另有脉冲环）。 */
const PHASE_DOT_CLASSES: Record<MeetingPhase, string> = {
  idle: 'bg-[var(--border)]',
  working: 'bg-[var(--accent)]',
  done: 'bg-[var(--accent)]',
  attention: 'bg-[var(--text-warning)]',
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

  const { record, positions, participants, unattributed } = deriveRoundtableSignal(records, { gatewayId });

  /**
   * 归因日志（T30 硬要求）：归不到岗位的那些轮次必须**留痕**，否则"为什么圆桌上没有岗位"
   * 就成了一个没人知道原因的死状态。按会议记录 id+revision 记一次（不是每次渲染都刷屏）。
   */
  const gapKey = record ? `${record.id}:${record.revision}` : '';
  useEffect(() => {
    if (!gapKey || unattributed.length === 0) return;
    console.warn(
      `[teams:roundtable] ${unattributed.length} 轮无岗位归属（真源无岗位载体），不渲染岗位徽章：`,
      unattributed,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在记录换了一版时记一次
  }, [gapKey]);

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

        {/* ⚠️ 岗位徽章**只渲染真的归到岗位的那些**（`positions`）。真源没有岗位载体
            ⇒ 这里当前一个都不出（整行不渲染）—— 绝不按 `stage` 补一个假岗位出来。 */}
        {positions.map(({ position, phase }) => {
          const index = ROUNDTABLE_POSITIONS.indexOf(position);
          const angle = (Math.PI * 2 * index) / ROUNDTABLE_POSITIONS.length - Math.PI / 2;
          const left = 50 + 37 * Math.cos(angle);
          const top = 50 + 37 * Math.sin(angle);
          const Icon = POSITION_ICONS[position];
          const statusLabel = t(`teams.roundtable.status.${phase}`);
          return (
            <div
              key={position}
              data-position={position}
              data-status={phase}
              title={statusLabel}
              className="absolute flex w-16 -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1"
              style={{ left: `${left}%`, top: `${top}%` }}
            >
              <span
                className={cn(
                  'relative flex h-11 w-11 items-center justify-center rounded-full border bg-[var(--bg-secondary)] transition-colors',
                  phase === 'working' && 'border-[var(--border-accent)] bg-[var(--accent-soft)]',
                )}
              >
                {phase === 'working' && (
                  <span
                    aria-hidden
                    className="absolute inset-0 animate-ping rounded-full border border-[var(--border-accent)] motion-reduce:animate-none"
                  />
                )}
                <Icon
                  size={16}
                  className={cn(phase === 'working' ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]')}
                />
                {/* 状态点：对内说状态，对外（hover/读屏）说人话（下面的 sr-only + title） */}
                <span
                  aria-hidden
                  className={cn(
                    'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[var(--bg-primary)]',
                    PHASE_DOT_CLASSES[phase],
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

      {/* ⭐ 2026-10-17（T30b）：**五岗位结构行** —— 纯结构说明，**零状态**。
          这五个岗位是「执行结构」本身（各自负责哪一段），不是"谁在跑"。这里**只**画
          岗位名 + 职责（同一个词表 `identity.teamPosition.*`，别再另起一套），
          **不带任何** `data-status` / 状态点 / 进度 —— 所以它不随会议信号变化，
          也不会出现"5 个一直灰着"的假状态。`data-team-position` 只是结构锚点（与
          IdentityCenter 的静态名单同名），不是 `data-position` 那种"归属徽章"。 */}
      <div data-testid="roundtable-positions" className="mt-4">
        <p className="type-meta text-[var(--text-muted)]">{t('teams.roundtable.positions')}</p>
        <ul className="mt-1.5 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {ROUNDTABLE_POSITIONS.map((position) => {
            const Icon = POSITION_ICONS[position];
            return (
              <li
                key={position}
                data-team-position={position}
                className="flex items-start gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-2.5 py-2"
              >
                <Icon size={14} aria-hidden className="mt-0.5 shrink-0 text-[var(--text-secondary)]" />
                <div className="min-w-0">
                  <span className="type-label block text-[var(--text-primary)]">
                    {t(`identity.teamPosition.${position}.name`)}
                  </span>
                  <span className="type-support mt-0.5 block text-[var(--text-muted)]">
                    {t(`identity.teamPosition.${position}.duty`)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {/* ⭐ 2026-10-16（T30）：**这一轮属于谁**——直接来自真实 `turn.agentId`，
          不是按阶段猜的。这是圆桌上唯一有真实归属的那份信息。 */}
      {record && participants.length > 0 && (
        <div data-testid="roundtable-participants">
          <p className="type-meta text-[var(--text-muted)]">{t('teams.roundtable.participants')}</p>
          <ul className="mt-1 space-y-1">
            {participants.map((participant) => (
              <li
                key={participant.agentId}
                data-participant={participant.agentId}
                data-participant-phase={participant.phase}
                className="flex items-center gap-2 type-meta"
              >
                <span className="min-w-0 truncate text-[var(--text-primary)]">{participant.name}</span>
                <span className="shrink-0 text-[var(--text-muted)]">{t(`meeting.stage.${participant.stage}`)}</span>
                <span
                  className={cn(
                    'ml-auto shrink-0 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-2 py-0.5',
                    PHASE_TEXT_CLASSES[participant.phase],
                  )}
                >
                  {t(`teams.roundtable.status.${participant.phase}`)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
