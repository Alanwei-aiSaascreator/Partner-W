import { memo, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, ChevronRight, CircleAlert, Clock, Loader2, Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isSlidegenToolProgress } from '@clawwork/shared';
import { cn } from '@/lib/utils';
import { motion as motionPresets } from '@/styles/design-tokens';
import {
  classifyToolActivity,
  classifyToolFailure,
  maskLocalPaths,
  productizedToolFailure,
  sanitizeToolText,
  sanitizeToolTitle,
  toolCallDurationMs,
  type DisplayToolCall,
  type ToolDisplayStatus,
  namedToolFailureKind,
} from '@/lib/tool-activity';
import { resolveDisplayKind } from '@/lib/tool-display-kind';
import { formatElapsed } from '@/lib/waiting-copy';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';

function StatusIcon({ status }: { status: ToolDisplayStatus }) {
  return (
    <AnimatePresence mode="wait">
      <motion.span key={status} {...motionPresets.crossfade} className="inline-flex">
        {/*
          ⭐ 2026-10-08 对话可视化改造：运行图标改 `.tool-icon-loading`（半转 + 呼吸，1.2s ease-in-out；
          reduced-motion 降级为静态）—— 通用 `animate-spin` 在轻量工具行里太重（样式全在 theme.css）。
        */}
        {status === 'running' && <Loader2 size={14} className="tool-icon-loading" />}
        {/*
          ⭐ A2「等待批准」：**不转圈** —— 转圈说的"在动"，而这条恰恰是"没动，在等人"。
          用现成的 `Clock`（lucide 图标集里已有的，不是新造的视觉件）。
        */}
        {status === 'awaitingApproval' && <Clock size={14} className="text-[var(--text-muted)]" />}
        {status === 'done' && <Check size={14} className="text-[var(--accent)]" />}
        {status === 'error' && <X size={14} className="text-[var(--danger)]" />}
        {/*
          第三态「未收到结果」：**不是失败**（区1 体检 P1-1）。用中性提醒色，不是红叉——
          红叉会让"用户取消/历史截断"看起来像一次报错，那是在编事实。
        */}
        {status === 'unreported' && <CircleAlert size={14} className="text-[var(--text-muted)]" />}
      </motion.span>
    </AnimatePresence>
  );
}

interface ToolCallCardProps {
  /** 展示副本（`status` 可能是 `unreported`，见 `markUnreportedCalls`）。 */
  toolCall: DisplayToolCall;
  defaultOpen?: boolean;
  label?: string;
  /**
   * 受控开合。摘要收起会把整棵子树卸载，开合态必须由父级（`ToolCallSummary`）持有，
   * 否则"收起再展开"用户的展开状态全丢（区1 体检 P3-11）。不传就是原来的非受控用法。
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const ToolCallCard = memo(function ToolCallCard({
  toolCall,
  defaultOpen,
  label,
  open: controlledOpen,
  onOpenChange,
}: ToolCallCardProps) {
  const { t } = useTranslation();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen ?? false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const [now, setNow] = useState(() => Date.now());
  const start = Date.parse(toolCall.startedAt);
  const waiting = toolCall.status === 'running' || toolCall.status === 'awaitingApproval';

  useEffect(() => {
    if (!waiting || !Number.isFinite(start)) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waiting, start]);

  const waited = waiting && Number.isFinite(start) && now >= start ? now - start : null;

  const duration = useMemo(() => {
    if (toolCall.status === 'running' || toolCall.status === 'awaitingApproval') return null;
    const elapsed = toolCallDurationMs(toolCall);
    if (elapsed === null) return null;
    return elapsed < 100 ? '<0.1s' : `${(elapsed / 1000).toFixed(1)}s`;
  }, [toolCall]);

  /**
   * 失败原因：**产品化后的可上屏形态**（图12，2026-10-06 有意反转 2026-09-24 的"原文照登"）——
   * 剥安全样板、遮本地路径、常见原始错误映射产品文案；认不出来才保留清洗后的原文。
   * 空/纯样板一律当没有（不渲染空行，也不编一句话顶上）。
   */
  const errorText =
    toolCall.status === 'error' && toolCall.result ? (productizedToolFailure(toolCall.result, t) ?? '') : '';
  /**
   * 详情区里的**错误类别**（区1 体检 P2-5）：详情同样走产品化（安全基线不破，见 `sanitizeToolText`），
   * 但只给"清洗后原文"有时看不出这是什么问题 —— 已知形态（网络/限流/超时）补一句人类可读的类别，
   * 判据复用 `classifyToolFailure`（**唯一判据**，别在这里再写一份正则）；认不出的不编。
   *
   * ⚠️ 2026-10-08 总审（R5）第 4 条：**具名命中时不再追加家族类别** ——
   *    `Missing required parameter: timeout (…)` 被判"超时"是宽泛关键词撞上**参数名**，
   *    在具名说明（缺少必要参数（timeout））旁边再挂一句「错误类别：等待超时」是自相矛盾。
   *    具名判据与 summary 共用 `namedToolFailureKind`（唯一出口，两处说明必须一致）。
   */
  const failureFamily =
    toolCall.status === 'error' && toolCall.result ? classifyToolFailure(toolCall.result) : 'unknown';
  const failureClass =
    failureFamily === 'unknown' || namedToolFailureKind(toolCall.result ?? '')
      ? ''
      : t(`toolActivity.failureClass.${failureFamily}`);
  /** 行标题：剥工具名 + 遮路径；剥空了退回产品化动作词（图12：web_search 这类原始工具名不上屏）。 */
  const rowTitle = sanitizeToolTitle(toolCall.title, toolCall.name);
  /**
   * 动作名兜底（2026-10-08 对话可视化改造）：`classifyToolActivity` 认不出的**精确工具名**
   * （`read`/`process`/`apply_patch`…）由 `resolveDisplayKind` 补位 —— 行上不再一律显示
   * 「使用工具」这种说不出在干什么的泛化文案。
   */
  const actionKind = resolveDisplayKind(toolCall.name, classifyToolActivity(toolCall.name));
  const sanitizedResult = toolCall.result ? sanitizeToolText(toolCall.result) : '';
  const pageProgress = isSlidegenToolProgress(toolCall.slideProgress) ? toolCall.slideProgress : undefined;
  const pagePending = toolCall.status === 'running';
  const pageLabel = pageProgress
    ? t('chatInput.deliveryPageProgress', { completed: pageProgress.completed, total: pageProgress.total })
    : '';

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      {/*
        ⭐ 2026-10-08 对话可视化改造：工具行从"卡片"变"单行" —— 去 glass-card/左侧彩条/光效/扫描线，
        只留 `.tool-row`（14px tertiary 单行，样式全在 theme.css；行内不再写尺寸/颜色）。
        容器只挂类名，错误态用 `.tool-row--error` 修饰（行本身仍保持 tertiary，不整行变红）。
      */}
      <div
        data-testid="tool-call-card"
        data-status={toolCall.status}
        className={cn('tool-row', toolCall.status === 'error' && 'tool-row--error')}
      >
        <CollapsibleTrigger asChild>
          <button className="tool-row__trigger glow-focus">
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <StatusIcon status={toolCall.status} />
            <span className="tool-row__main">
              {label ? <span className="type-label text-[var(--text-secondary)]">{label} · </span> : null}
              {/*
                ⭐ 优先显示网关拼好的 `title`（形如「memory_search 游戏 爆款 创作 内容」）——
                这才是用户要的"做了什么操作"。只有工具名（`name`）时说明拿不到 item 流，退回产品化动作词。
                ⚠️ 图12（2026-10-06）：title 经过产品化（剥工具名/遮路径）；原始工具名不再直接上屏。
                ⚠️ 超长由 CSS 省略号（`.tool-row__primary`），不再挂 `truncate`/`type-mono-data`。
              */}
              <span className="tool-row__primary" title={rowTitle ?? undefined}>
                {rowTitle ?? t(`toolActivity.actions.${actionKind}`)}
              </span>
            </span>
            {/*
              状态区：等待批准说"在等人"；等待时长/耗时如实报（testid 保留，旧断言按新语义改）。
              running 追加 `text-shimmer`（"正在进行"的统一视觉）；awaiting **不加**（在等人 ≠ 在跑）。
            */}
            <span className={cn('tool-row__status', toolCall.status === 'running' && 'text-shimmer')}>
              {toolCall.status === 'awaitingApproval' && (
                <span className="type-label text-[var(--text-muted)]" data-testid="awaiting-approval-label">
                  {t('toolCall.awaitingApproval')}
                </span>
              )}
              {waited !== null ? (
                <span className="type-mono-data text-[var(--text-muted)]" data-testid="tool-call-waiting-time">
                  {t('toolActivity.waitingElapsed', { time: waited < 100 ? '<0.1s' : formatElapsed(waited) })}
                </span>
              ) : duration ? (
                <span className="text-[var(--text-muted)]">{duration}</span>
              ) : null}
            </span>
          </button>
        </CollapsibleTrigger>
        {/*
          ⭐ 2026-10-08：失败说明块**移到行外**（行的同级兄弟、行下方）—— 全文可读、不再 truncate、
          行本身保持 tertiary（安装包复核口径：行不整行变红，红字只在这块里）。
          ⚠️ 2026-10-06 反转过 2026-09-24 的「原文照登」：这里给的是**产品化后**的形态
            （`productizedToolFailure` —— 剥样板/遮路径/已知形态映射产品文案），与展开详情同一套；
            原始载荷只进 console（`debugToolFailures`）。认不出来的形态保留清洗后原文。
          ⚠️ 只有 `error` 且**有可展示文本**才渲染（空白/纯样板不渲染空行，也不编一句话顶上）。
        */}
        {errorText ? (
          <div data-testid="tool-call-error" className="tool-row__error" title={errorText}>
            {errorText}
          </div>
        ) : null}
        {/*
          ⭐ PPT 真实页数进度（`isSlidegenToolProgress` 净化后的元数据）—— 本块**一字不动**：
          它承载"真实完成的页数"，是本仓假成功事故后最不该被展示改造波动的证据出口。
        */}
        {pageProgress && (
          <div
            className="px-3 pb-2.5 space-y-1"
            data-generation-state={pagePending ? 'pending' : 'settled'}
            aria-live={pagePending ? 'polite' : 'off'}
          >
            <p className="type-caption text-[var(--text-secondary)]">{pageLabel}</p>
            {pagePending && (
              <progress
                value={pageProgress.completed}
                max={pageProgress.total}
                aria-label={pageLabel}
                className="h-1.5 w-full appearance-none overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-[var(--bg-hover)] [&::-webkit-progress-value]:bg-[var(--accent)] [&::-moz-progress-bar]:bg-[var(--accent)]"
              />
            )}
          </div>
        )}
        <CollapsibleContent forceMount>
          <AnimatePresence>
            {open && (
              <motion.div
                initial={motionPresets.slideUp.initial}
                animate={motionPresets.slideUp.animate}
                exit={motionPresets.slideUp.exit}
                transition={motionPresets.slideUp.transition}
                className="type-code-block tool-row__details"
              >
                {toolCall.args && (
                  <div className="mb-1">
                    <p className="text-[var(--text-muted)] mb-0.5">{t('toolCall.args')}</p>
                    <pre
                      className={cn(
                        'whitespace-pre-wrap text-[var(--text-secondary)]',
                        'bg-[var(--bg-primary)] p-2 rounded overflow-x-auto',
                      )}
                    >
                      {/* 图12：参数里的本地路径同样遮蔽（保留证据、不暴露目录结构） */}
                      {maskLocalPaths(JSON.stringify(toolCall.args, null, 2))}
                    </pre>
                  </div>
                )}
                {failureClass ? (
                  <p data-testid="tool-call-failure-class" className="text-[var(--text-muted)] mb-1">
                    {failureClass}
                  </p>
                ) : null}
                {sanitizedResult && (
                  <div>
                    <p className="text-[var(--text-muted)] mb-0.5">{t('toolCall.result')}</p>
                    <pre
                      className={cn(
                        'whitespace-pre-wrap text-[var(--text-secondary)]',
                        'bg-[var(--bg-primary)] p-2 rounded overflow-x-auto',
                        'max-h-40 overflow-y-auto',
                      )}
                    >
                      {sanitizedResult}
                    </pre>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
});

export default ToolCallCard;
