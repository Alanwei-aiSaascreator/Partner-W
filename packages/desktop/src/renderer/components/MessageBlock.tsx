import type { ReactNode, Ref } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { motion as motionPresets } from '@/styles/design-tokens';
import MessageAvatar from './MessageAvatar';

/**
 * 助手块的**外壳**（头像 + 名字/角色/模型那一行 + 间距）。
 *
 * 为什么要有这么一个只画壳的组件：一个助手块在一轮对话里要换好几次**身份**——
 * 等待 → 流式 → 定稿 → 收编成正式消息。这些状态以前分属 `StreamingMessage` 与
 * `ChatMessage` **两个组件**，React 在同一个位置看到两个不同的组件类型时会**整块卸载重建**
 * ⇒ 头像是新节点 ⇒ 用户看到"头像闪一下"（2026-09-20 实机报障，MutationObserver 实测抓到
 * `移除[BLOCK] 新增[BLOCK]` + `移除[avatar] 新增[avatar]`）。
 *
 * 抽成同一个壳之后，状态之间只有**身体**不同，壳（连同头像这个 DOM 节点）从头到尾是同一个。
 */
export interface AssistantIdentity {
  agentName?: string;
  agentRoleLabel?: string;
  agentEmoji?: string;
  localAvatarUrl?: string;
  gatewayAvatarUrl?: string;
  /**
   * 这条回复**实际**由哪个模型生成（展示名，由调用方从 `message.model` + 目录解析）。
   * 流式态还不知道是谁答的 ⇒ 不传（组件不会拿会话级模型/picker 补一个）。
   */
  modelLabel?: string;
  /** 徽章 `title` 用的原始 model id（展示名可能被本地化过）。 */
  modelTitle?: string;
}

interface MessageBlockProps {
  identity: AssistantIdentity;
  /**
   * 入场动效。默认 `fadeIn`（流式/等待那块一直用的是它）；定稿/正式消息用
   * `messageEnter`。⚠️ 这一项在定稿那一刻会变 —— 但**节点不会换**（同一个 key、同一个类型），
   * 只是动画目标值变；两个预设的终点都是 `opacity:1, y:0`，静默。
   */
  preset?: typeof motionPresets.fadeIn | typeof motionPresets.messageEnter;
  className?: string;
  /** 挂在最外层那个 `motion.div` 上的 ref（高亮滚动、测试要用）。 */
  rootRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}

export default function MessageBlock({
  identity,
  preset = motionPresets.fadeIn,
  className,
  rootRef,
  children,
}: MessageBlockProps) {
  const { agentName, agentRoleLabel, modelLabel, modelTitle, agentEmoji, localAvatarUrl, gatewayAvatarUrl } = identity;

  return (
    <motion.div
      ref={rootRef}
      initial={preset.initial}
      animate={preset.animate}
      transition={preset.transition}
      className={cn('group/message flex gap-3.5 py-4', className)}
      data-testid="assistant-block"
    >
      <MessageAvatar
        role="assistant"
        agentEmoji={agentEmoji}
        localAvatarUrl={localAvatarUrl}
        gatewayAvatarUrl={gatewayAvatarUrl}
      />
      <div className="min-w-0 flex-1">
        {(agentName || agentRoleLabel || modelLabel) && (
          <div className="mb-1.5 flex min-w-0 flex-wrap items-center gap-2 text-[var(--text-muted)]">
            {agentName ? <div className="type-label truncate text-[var(--text-secondary)]">{agentName}</div> : null}
            {agentRoleLabel ? (
              <span className="type-meta inline-flex items-center rounded-full border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] px-2 py-0.5 text-[var(--text-muted)]">
                {agentRoleLabel}
              </span>
            ) : null}
            {modelLabel ? (
              <span
                data-testid="model-badge"
                title={modelTitle}
                className="type-meta inline-flex items-center rounded-full border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] px-2 py-0.5 text-[var(--text-muted)]"
              >
                {modelLabel}
              </span>
            ) : null}
          </div>
        )}
        {children}
      </div>
    </motion.div>
  );
}
