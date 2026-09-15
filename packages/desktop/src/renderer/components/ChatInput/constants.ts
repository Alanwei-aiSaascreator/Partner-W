import type { ModelCatalogEntry } from '@clawwork/shared';

export const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024;
export const MAX_TEXT_TOTAL = 500 * 1024;
export const MAX_SEND_MATERIAL_COUNT = 10;
export const MAX_SEND_MATERIAL_BYTES = 25 * 1024 * 1024;
export const GATEWAY_INJECTED_MODEL = 'gateway-injected';
export const EMPTY_MODELS_CATALOG: ModelCatalogEntry[] = [];

export const MENTION_ALL_AGENT_ID = '__all__';

/**
 * 已知档位。
 *
 * ⚠️ `xhigh` / `max` / `ultra` 是**网关真实会发**的档位（2026-09-12 relay 声明能力后
 * 目录里就出现了），不是预留值。`ultra` 只在 runtime 是 openclaw/auto 时由 `max` 额外多出一档。
 * 缺了文案不会崩 —— `thinkingLabelKey` 会返回 null、界面直接显示协议 id ——
 * 但那样用户看到的是「xhigh」这种英文，所以三个都要有。
 *
 * ⚠️ `adaptive` **已移除**（2026-09-14）。它从来没有被任何模型支持过，却一直留在
 * 下面这几个写死的列表里，于是用户能选中它、然后收到网关的英文 400：
 * `thinkingLevel "adaptive" is not supported for clawrouter/qwen3.5-27b`。
 * 档位是**逐模型**的，客户端写死的表迟早和网关漂开 —— 真正的守卫在
 * `chat-composer.ts` 的 `resolveSupportedThinking`（对着目录里模型自己声明的档位校验）。
 * 这份常量表现在只用来**给已知档位配文案**，不再是「可选项清单」。
 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const THINKING_LABEL_KEYS: Record<ThinkingLevel, string> = {
  off: 'chatInput.thinkingOff',
  minimal: 'chatInput.thinkingMinimal',
  low: 'chatInput.thinkingLow',
  medium: 'chatInput.thinkingMedium',
  high: 'chatInput.thinkingHigh',
  xhigh: 'chatInput.thinkingXhigh',
  max: 'chatInput.thinkingMax',
  ultra: 'chatInput.thinkingUltra',
};
