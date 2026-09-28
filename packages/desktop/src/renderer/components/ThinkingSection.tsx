import { memo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Brain, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { motion as motionPresets } from '@/styles/design-tokens';
import MarkdownContent from './MarkdownContent';

interface ThinkingSectionProps {
  content: string;
  defaultOpen?: boolean;
  streaming?: boolean;
  showCursor?: boolean;
}

function ThinkingSection({
  content,
  defaultOpen = false,
  streaming = false,
  showCursor = false,
}: ThinkingSectionProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="mb-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'type-support inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1',
          'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
          'bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)] transition-colors',
        )}
      >
        <Brain size={12} className={cn('text-[var(--accent)] opacity-70', streaming && 'animate-pulse')} />
        <span>{t('chatMessage.thinkingProcess')}</span>
        <ChevronDown size={11} className={cn('transition-transform', open && 'rotate-180')} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={motionPresets.collapse.initial}
            animate={motionPresets.collapse.animate}
            exit={motionPresets.collapse.exit}
            transition={motionPresets.collapse.transition}
            className="overflow-hidden"
          >
            <div
              className={cn(
                'type-support mt-1.5 rounded-lg px-3 py-2 leading-relaxed',
                'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
                'max-h-60 overflow-y-auto',
              )}
            >
              <MarkdownContent content={content} showCursor={showCursor} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * ⭐ `memo`（2026-09-29）：这一块是**长思维链**那条路上最贵的一环 ——
 * 它的 props 全是字符串/布尔（浅比较按值比，正好），而它内部只有 `open` 一个 state。
 * 不 memo 的话，**正文**每来一个 delta 都会把整段推理重新解析一遍 markdown，
 * 反过来也一样。真机实测一轮长思维链 480 次整块重渲染。
 *
 * ⚠️ 别加自定义比较器：漏掉 `content` 会让流式推理**冻住**。
 */
export default memo(ThinkingSection);
