import type { ModelCatalogEntry } from '@clawwork/shared';

export const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024;
export const MAX_TEXT_TOTAL = 500 * 1024;

/**
 * 一次发送的**二进制附件**个数上限（暂存附件 `pendingAttachments` + 已选导入材料
 * `selectedImportedFiles`）。
 *
 * ⚠️ 2026-10-07（质量战役区 2 · 方案 A）：计数**只作用二进制附件**。
 *    `@` 授权文件夹（`selectedLocalFiles`，tier='text' 内联）**不计数** ——
 *    它们只受 `MAX_TEXT_TOTAL`（500KB）的字节约束，个数与带宽无关：
 *    旧口径下「@ 11 个小文本文件」会被拒发，而整包载荷才几 KB（P1-2 实害）。
 *
 * 30 的由来（旧值 10 无任何依据：引入 commit `08243f3e` 的 body 为空，全仓 docs 无一字解释）：
 *    真边界是**字节闸门**（见 `deriveMaterialByteBudget`）——只要字节没超，个数本身不产生
 *    额外危害；30×均值 850KB 才触字节闸门，30 张截图 ≈ 6–15MB，30 个 2KB md 更是无关痛痒。
 *    取 30 而不是更大：给"拖入一大堆"的用户一个可读的上限，让问题**在 UI 里提前可见**
 *    （计数徽标 + 置灰，见 TaskMaterials / ChatInput）。
 */
export const MAX_SEND_MATERIAL_COUNT = 30;

/**
 * 网关单帧上限的**默认值**（`MAX_PAYLOAD_BYTES`，见 `docs/openclaw-gateway-whitepaper.md` §2.4）。
 *
 * ⚠️ 真实值**每次握手由网关下发**（`hello-ok.policy.maxPayload`，2026-10-07 在随包
 *    运行时 dist 实读确认）——连接建立后以协商值为准，这个常量只是拿不到协商值时的兜底。
 */
export const DEFAULT_MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;

/**
 * 单帧里**除附件 base64 之外**要留的余量（用户正文 / contextPrefix / JSON 外壳）。
 * 0.75MiB：正文与隐藏上下文（附件纪律、产物索引）在这条通道上从不超过几百 KB，
 * 留到 0.75MB 是宽松值；25MiB 帧按下面的公式正好折出 18MiB 材料预算。
 */
export const SEND_FRAME_RESERVE_BYTES = 768 * 1024;

/**
 * 材料**字节预算**（以文件原始字节计）= 单帧上限 × 3/4 − 余量。
 *
 * 为什么要有 3/4：二进制附件经 base64 传输会膨胀 4/3（`useChatSend` 把
 * `attachments[].content` 直接填 base64），按原始字节对着 25MB 判等于**暗中放行了
 * 33MB 的帧**——真撞上限时死在 WS 层（网关 1009 断连），而不是一句能看懂的提示（P1-1）。
 * 折算后：原始字节 × 4/3 ≤ maxPayload − 余量 ⇒ 发送永远落在单帧里。
 *
 * `maxPayloadBytes` 传连接协商值（`ui-store` 的 `gatewayMaxPayloadByGateway`）；
 * 缺席 / 非法值回落 `DEFAULT_MAX_PAYLOAD_BYTES`（25MiB → 18MiB 预算）。
 */
export function deriveMaterialByteBudget(maxPayloadBytes?: number): number {
  const frame =
    typeof maxPayloadBytes === 'number' && Number.isFinite(maxPayloadBytes) && maxPayloadBytes > 0
      ? maxPayloadBytes
      : DEFAULT_MAX_PAYLOAD_BYTES;
  return Math.max(0, Math.floor((frame * 3) / 4) - SEND_FRAME_RESERVE_BYTES);
}

/** 默认预算（18MiB）——拿不到协商值时的兜底；展示给用户的 MB 数由它/协商值现算。 */
export const MAX_SEND_MATERIAL_BYTES = deriveMaterialByteBudget();

/** 字节预算的 MB 展示值（文案与闸门同源，免得随协商值漂开）。 */
export function materialBudgetMb(byteBudget: number): number {
  return Math.round(byteBudget / (1024 * 1024));
}

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
