import { motion, useReducedMotion } from 'framer-motion';

/**
 * 「还在等第一个字」的三个跳动点 —— 与桌面端
 * `components/ThinkingIndicator.tsx` 同一形态（3 点、0.85↔1 缩放、错峰延迟）。
 *
 * ⚠️ 它只是身体，不带头像：头像由外层消息块提供，避免同一帧出现两个头像。
 */
export function ThinkingIndicator() {
  const reduced = useReducedMotion();

  return (
    <div className="flex items-center gap-1.5 py-2" data-testid="thinking-indicator">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="h-2 w-2 rounded-full"
          style={{ backgroundColor: 'var(--text-muted)' }}
          animate={
            reduced
              ? { opacity: [0.3, 1, 0.3] }
              : { opacity: [0.3, 1, 0.3], scale: [0.85, 1, 0.85] }
          }
          transition={{
            duration: 1.2,
            repeat: Infinity,
            delay: i * 0.2,
            ease: [0.2, 0, 0, 1],
          }}
        />
      ))}
    </div>
  );
}
