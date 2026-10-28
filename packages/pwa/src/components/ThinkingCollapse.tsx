import { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LoadingTip } from './LoadingTip';

export interface ThinkingCollapseProps {
  /** 推理正文（流式累积或定稿 thinkingContent）。空串 ⇒ 不渲染。 */
  text: string;
  /** live = 思考是当前最新活动；done = 已被正文/工具接续，或回合定稿。 */
  phase: 'live' | 'done';
  /** 思考段号：新段才复位"用户手动折叠"的选择。 */
  segment?: number;
}

/**
 * 手机端「深度思考」折叠 —— 从桌面端
 * `packages/desktop/src/renderer/components/ThinkingCollapse.tsx` 移植。
 *
 * 三条语义与桌面端一致：
 * 1. 标题静态「深度思考」，不报秒数；
 * 2. live 自动展开 + 扫光，done 自动收起 + 停动画；
 * 3. 尊重用户手动折叠，同段新 delta 不强行展开。
 */
export function ThinkingCollapse({ text, phase, segment = 0 }: ThinkingCollapseProps) {
  const { t } = useTranslation();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const prevPhase = useRef(phase);
  const prevSegment = useRef(segment);
  const [override, setOverride] = useState<{ segment: number; open: boolean } | null>(null);
  const [mounted, setMounted] = useState(phase === 'live');

  const expanded = override && override.segment === segment ? override.open : phase === 'live';

  useEffect(() => {
    if (phase === 'live' || expanded) setMounted(true);
    if (prevPhase.current !== phase) {
      prevPhase.current = phase;
      setOverride(null);
    }
  }, [phase, expanded]);

  useEffect(() => {
    if (prevSegment.current !== segment) {
      prevSegment.current = segment;
      setOverride(null);
    }
  }, [segment]);

  // 流式进行中跟随最新一行，避免长推理把新内容藏在滚动区外。
  useEffect(() => {
    if (phase !== 'live') return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text, phase]);

  if (!text.trim()) return null;

  const className = [
    'thinking-collapse',
    phase === 'live' ? 'thinking-collapse--live' : 'thinking-collapse--done',
    expanded ? 'thinking-collapse--expanded' : 'thinking-collapse--collapsed',
  ].join(' ');

  return (
    <div data-testid="thinking-collapse" className={className}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOverride({ segment, open: !expanded })}
        className="thinking-collapse__header"
        style={{ minHeight: 32 }}
      >
        <span aria-hidden className="thinking-collapse__icon">
          <ChevronRight size={12} />
        </span>
        {phase === 'live' && <span className="thinking-collapse__live-dot" aria-hidden="true" />}
        <span
          className={
            phase === 'live' ? 'thinking-collapse__title text-shimmer' : 'thinking-collapse__title'
          }
        >
          {t('chat.thinkingTitle')}
        </span>
        {phase === 'live' && (
          <LoadingTip className="thinking-collapse__hint" style={{ color: 'var(--text-muted)', opacity: 0.75 }} />
        )}
        <span className="ml-auto text-[11px]" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>
          {expanded ? t('chat.collapseThinking') : t('chat.expandThinking')}
        </span>
      </button>
      {(mounted || expanded) && (
        <div className="thinking-collapse__content">
          <div ref={bodyRef} className="thinking-collapse__body">
            {text}
          </div>
        </div>
      )}
    </div>
  );
}
