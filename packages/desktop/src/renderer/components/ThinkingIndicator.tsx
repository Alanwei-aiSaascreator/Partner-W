import { motion, useReducedMotion } from 'framer-motion';
import { motionDuration, motionEase } from '@/styles/design-tokens';

/**
 * 「还在等第一个字」的三个跳动点。
 *
 * ## ⚠️ 它**只是身体**，不是一整块（2026-09-20 改）
 *
 * 原来它自带 `MessageAvatar` + 外层 `flex gap-3.5 py-4`，是**独立的等待块**；
 * 内容一到就换成 `StreamingMessage` —— 而后者**也有自己的头像**。
 * 两个块各自淡入淡出 ⇒ **同一帧里两个头像并存**（MutationObserver 实测抓到
 * `头像=2` 且跳动点=3 的那一帧）⇒ 用户看到的就是
 * 「我发完要求，那个对话头像会消失一下，然后再给我反馈」。
 *
 * 现在它被 `StreamingMessage` **渲染在自己的身体位置**：
 * 头像与名字由 `StreamingMessage` 提供一次，从"发出"到"收到"到"结束"
 * 都是**同一个 DOM 节点**，头像不再被卸载重建 ⇒ 不会闪。
 *
 * ⚠️ 所以**别**再把头像/外层间距加回来 —— 那等于把两个头像的问题重新引入一次。
 */
export default function ThinkingIndicator() {
  const reduced = useReducedMotion();

  return (
    <div className="flex items-center gap-1.5 py-2" data-testid="thinking-indicator">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="w-2 h-2 rounded-full bg-[var(--text-muted)]"
          animate={reduced ? { opacity: [0.3, 1, 0.3] } : { opacity: [0.3, 1, 0.3], scale: [0.85, 1, 0.85] }}
          transition={{
            duration: motionDuration.slow * 4,
            repeat: Infinity,
            delay: i * motionDuration.moderate,
            ease: motionEase.standard,
          }}
        />
      ))}
    </div>
  );
}
