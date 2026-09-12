import type { ModelCatalogEntry } from '@clawwork/shared';

export const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024;
export const MAX_TEXT_TOTAL = 500 * 1024;
export const ACCEPTED_TYPES = [
  'image/*',
  '.txt,.md,.csv,.json,.xml,.yaml,.yml,.log',
  '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx',
  '.zip,.tar,.gz,.7z,.rar',
].join(',');
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
 * `adaptive` 相反：它至今**没有任何模型支持**，留着是因为历史上写过。
 */
export const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
  'adaptive',
] as const;
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
  adaptive: 'chatInput.thinkingAdaptive',
};
