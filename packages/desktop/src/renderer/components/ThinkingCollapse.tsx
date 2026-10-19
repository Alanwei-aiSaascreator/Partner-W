import { memo, useDeferredValue, useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/** live 态正文的渲染上限（字符）。见组件内 `body` 的注释。 */
const LIVE_TAIL_LIMIT = 8000;

export interface ThinkingCollapseProps {
  /** 推理正文（流式累积或定稿 thinkingContent）。空串 ⇒ 不渲染。 */
  text: string;
  paused?: boolean;
  /**
   * `live` = 思考是**当前最新活动**（core `ActiveTurn.activity.kind === 'thinking'`）；
   * `done` = 已被更新的输出（正文/工具）接续，或回合定稿。
   *
   * ⚠️ 这个相位由 core 事件入口留痕（`message-store` 的 `activity`），
   *    **不是**从 props 变化猜出来的 —— `thinking→tool` 与 `tool→thinking`
   *    在同一次提交里可能给出完全相同的最终文本，顺序只在写入那一刻存在。
   */
  phase: 'live' | 'done';
  /** 思考段号（core `activity.thinkingSegment`）：新段才复位"用户手动折叠"的选择。 */
  segment?: number;
}

/**
 * 思考折叠（2026-10-08 对话可视化改造 · Task 2；形态依据 WorkBuddy 实测）。
 *
 * 三条语义（每条有测试钉着）：
 * 1. 标题**静态**「深度思考」——不报秒数（没有可靠的思考窗测量源就不报）；
 * 2. `live` 自动展开 + 扫光；`done` 自动收起 + 停动画；
 * 3. **尊重用户手动折叠**：同段新 delta 不强行展开；段号变化（工具后再次思考）才复位。
 *
 * 惰性正文：live 或被用户展开之前不渲染正文节点（长 CoT 性能；定稿不闪重排）。
 * 样式全部在 `theme.css` 的 `.thinking-collapse*` / `.text-shimmer`（gate 豁免文件）。
 */
function ThinkingCollapse({ text, phase, segment = 0, paused = false }: ThinkingCollapseProps) {
  const { t } = useTranslation();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const prevPhase = useRef(phase);
  const prevSegment = useRef(segment);
  /** 用户手动开合（按段记录；段变化/相变即作废）。null = 跟随相位默认。 */
  const [override, setOverride] = useState<{ segment: number; open: boolean } | null>(null);

  /**
   * 长思考只渲染尾部（2026-10-18 同事批次移植）。
   *
   * 现场：一次「做官网」的任务吐了 **58,036 字**思考 / **2,638 个增量帧** —— live 态
   * 每帧把整段重贴一遍 DOM，渲染进程吃满一个核、CDP 求值 150 秒不返回（界面等于卡死）。
   * 规则：**live 时只渲染最后 8,000 字**（用户看的是滚动尾部），定稿（done）渲染全文；
   * 短思考（绝大多数）完全不受影响。
   *
   * ⚠️ 如实说：live 且被截断时，DOM 里只有尾部 —— 此刻全选/复制拿到的是**尾部**，
   *    不是全文（定稿后再复制才是全文）。所以上方给了一条明确的省略提示。
   */
  const deferredText = useDeferredValue(text);
  const truncated = phase === 'live' && deferredText.length > LIVE_TAIL_LIMIT;
  const tail = truncated ? deferredText.slice(-LIVE_TAIL_LIMIT) : deferredText;
  // UTF-16 `slice` 会把代理对切成半个 emoji（渲染成乱码）—— 落在低代理项上就再让一位。
  const firstCode = tail.charCodeAt(0);
  const body = truncated && firstCode >= 0xdc00 && firstCode <= 0xdfff ? tail.slice(1) : tail;
  /** 惰性挂载：一旦挂过就保持（live→done 的收起动画需要正文还在）。 */
  const [mounted, setMounted] = useState(phase === 'live');

  const expanded = override && override.segment === segment ? override.open : phase === 'live';

  // 相变：进 live（含 done→live 的"新一段"）自动展开并复位用户选择；进 done 自动收起。
  useEffect(() => {
    if (phase === 'live' || expanded) setMounted(true);
    if (prevPhase.current !== phase) {
      prevPhase.current = phase;
      setOverride(null);
    }
  }, [phase, expanded]);

  // 段号变化（工具之后再次思考）：复位用户选择，按当前相位重新默认。
  useEffect(() => {
    if (prevSegment.current !== segment) {
      prevSegment.current = segment;
      setOverride(null);
    }
  }, [segment]);

  // 流式进行中跟随最新一行（防止长推理把新内容藏在滚动区外）。
  // ⭐ BUG-075（2026-10-13）：同一帧内的多次快照用 rAF 合并成一次滚动写入 ——
  //    原来每个快照直接写 scrollTop 会强制同步布局，20+/秒的思考流下这里是主线程热点之一。
  useEffect(() => {
    if (phase !== 'live') return;
    const el = bodyRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [text, phase]);

  if (!text.trim()) return null;

  const toggle = (): void => {
    setOverride({ segment, open: !expanded });
  };

  return (
    <div
      data-testid="thinking-collapse"
      className={cn(
        'thinking-collapse',
        phase === 'live' ? 'thinking-collapse--live' : 'thinking-collapse--done',
        expanded ? 'thinking-collapse--expanded' : 'thinking-collapse--collapsed',
      )}
    >
      <button
        type="button"
        data-testid="thinking-collapse-header"
        aria-expanded={expanded}
        onClick={toggle}
        className="thinking-collapse__header"
      >
        <span aria-hidden className="thinking-collapse__icon">
          <ChevronRight size={12} />
        </span>
        <span className={cn('thinking-collapse__title', phase === 'live' && !paused && 'text-shimmer')}>
          {t('chatMessage.thinking.title')}
        </span>
      </button>
      {(mounted || expanded) && (
        <div className="thinking-collapse__content">
          {truncated ? (
            <div data-testid="thinking-tail-hint" className="type-meta mb-1 text-[var(--text-muted)]">
              {t('chatMessage.thinking.liveTailHint')}
            </div>
          ) : null}
          <div ref={bodyRef} className="thinking-collapse__body">
            {body}
          </div>
        </div>
      )}
    </div>
  );
}

// ⭐ BUG-075（2026-10-13）：思考流每快照都会重渲这一块 —— memo 是"父组件无辜重渲"时的最后一道闸
//（props 全是原始值，浅比较即可正确跳过）。
export default memo(ThinkingCollapse);
