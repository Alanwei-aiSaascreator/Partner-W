/**
 * 能力边界（Planner 边界 + 请求前置识别）—— BUG-043 的"产品文案"这一半。
 *
 * ## 它要修的用户体验
 *
 * 用户开口要一个**根本不存在的能力**（"调用 GPT 帮我写"、"生成一段视频"）时，旧行为是：
 * 模型照样排计划 → 调工具 → 失败 → 界面上冒出一串 Tool Failure，用户读到的是
 * "工具坏了"，而不是"这个能力本来就没有"。正确行为只有一句：
 * **「当前暂不支持该模型或能力」+ 替代方案**，一次说清，不试错。
 *
 * ## 机制（最小实现，不造路由器）
 *
 * 1. **提示词注入**：`buildCapabilityBoundaryPrompt(registry)` 产出"已知能力清单 +
 *    不支持时怎么回答"的一段提示词，由主进程写进 main 助手的 `AGENTS.md`
 *    （运行时每轮全文注入的系统提示词通道；`AGENTS.md` 正是它自己文档里
 *    "本地工具与环境说明"的指定位置）。区块带版本标记、可替换、幂等
 *    （`mergeCapabilityBoundaryBlock`），**不碰用户手写的内容**。
 * 2. **请求前置识别**：`recognizeUnsupportedCapabilityRequest` 是给客户端用的
 *    纯函数（用户消息 → 命中的原因 + 文案键）。本轮**未接进发送路径**
 *    （`ChatInput/**` 归另一路 owner）——它是给展示层预留的已测试原语，
 *    接线后的效果是"用户一发就当场回话"，与提示词注入互为兜底。
 *
 * ## 文案键
 *
 * 界面文案走 i18n（9 语言，键在两个 `*_COPY_KEY` 常量里）。中文规范句
 * **「当前暂不支持该模型或能力」**同时写进提示词 —— 模型用用户界面语言等价表达。
 */

import { availableChatModelIds, type CapabilityEntry } from './capability-registry.js';

/** 区块版本：提示词内容变化时 +1，写端据此升级（与 preset 提示词同一套"带版本标记"纪律）。 */
export const CAPABILITY_BOUNDARY_PROMPT_VERSION = 1;

/** 用户点名了不存在的**模型**时，界面要说的话（i18n 键）。 */
export const UNSUPPORTED_MODEL_COPY_KEY = 'chatInput.unsupportedModel';
/** 用户点名了不存在的**能力**（图片/视频生成、语音等）时，界面要说的话（i18n 键）。 */
export const UNSUPPORTED_CAPABILITY_COPY_KEY = 'chatInput.unsupportedCapability';

const MARKER_PREFIX = 'mofang-capability-boundary';

export function capabilityBoundaryStartMarker(version: number = CAPABILITY_BOUNDARY_PROMPT_VERSION): string {
  return `<!-- ${MARKER_PREFIX}:${version}:begin -->`;
}

export function capabilityBoundaryEndMarker(version: number = CAPABILITY_BOUNDARY_PROMPT_VERSION): string {
  return `<!-- ${MARKER_PREFIX}:${version}:end -->`;
}

/** 任意版本都能认出来的整段区块（替换时用；跨版本也要能被换掉，否则永远升级不了）。 */
const BOUNDARY_BLOCK_RE = new RegExp(
  `<!-- ${MARKER_PREFIX}:\\d+:begin -->[\\s\\S]*?<!-- ${MARKER_PREFIX}:\\d+:end -->`,
);

const UNAVAILABLE_MODEL_FAMILIES = 'GPT / ChatGPT / Claude / Gemini / Grok / Llama / 文心一言 等';

/**
 * 能力边界提示词（注入给 main 助手）。
 *
 * 只陈述**注册表里的事实**：可用模型来自目录（`chat` 能力非 `unavailable` 的条目），
 * 实测能力只列 `available` 的那些。目录没拉到时（空注册表）不伪造模型名。
 */
export function buildCapabilityBoundaryPrompt(registry: readonly CapabilityEntry[]): string {
  const chatModels = availableChatModelIds(registry);
  const verified = registry.filter((entry) => entry.availability === 'available');
  const verifiedModels = verified.filter((entry) => entry.kind === 'model');
  const verifiedTools = verified.filter((entry) => entry.kind === 'tool');

  const modelLine =
    chatModels.length > 0
      ? `本机可用的对话模型（以工作台模型选择器为准）：${chatModels.join('、')}`
      : '本机可用的对话模型：以工作台模型选择器为准（此刻目录尚未取到）。';

  const capabilityLines: string[] = [];
  for (const entry of verifiedModels) {
    const capability = entry.capability === 'vision' ? '图片理解' : entry.capability === 'search' ? '联网搜索' : null;
    if (!capability) continue;
    capabilityLines.push(`- ${capability}：${entry.id}（${entry.evidence?.verifiedAt ?? '已实测'} 实测可用）`);
  }
  for (const entry of verifiedTools) {
    capabilityLines.push(`- ${entry.capability}：${entry.id}（${entry.evidence?.verifiedAt ?? '已实测'} 实测可用）`);
  }

  return [
    '## 能力边界（自动维护区块，请勿手改本区块；用户如需自定义请写在本区块之外）',
    '',
    modelLine,
    '',
    ...(capabilityLines.length > 0 ? ['已实测可用的能力：', ...capabilityLines, ''] : []),
    '当前暂不支持（直接如实说明，不要调用工具试错、不要假装可以）：',
    `- 其它厂商模型：${UNAVAILABLE_MODEL_FAMILIES}`,
    '- 图片生成、视频生成（本轮未接入）',
    '- 语音合成 / 声音克隆（Windows 桌面版未接入）',
    '',
    '用户请求以上内容时：明确回答「当前暂不支持该模型或能力」，并给出替代方案',
    '（例如改用上面列出的可用模型，或用现有的文档 / 文件能力完成任务），不要反复尝试。',
  ].join('\n');
}

export interface CapabilityBoundaryMergeResult {
  content: string;
  /** 需要写盘吗（false = 已是当前版本、一个字都不用写）。 */
  changed: boolean;
}

/**
 * 把能力边界区块并入一份已有文本（`AGENTS.md` 的内容）。
 *
 * 纪律（与 `main-agent-contract` 的提示词纪律一致：**不碰用户的东西**）：
 * · 空文本 ⇒ 直接写区块；
 * · 已有我们的区块（任意版本）⇒ **只替换区块本身**，区块外一字不动；
 * · 没有我们的区块、但有别的文本 ⇒ **追加**在末尾（原文原样保留；区块本身是
 *   运行时要每轮注入的能力契约，不由用户手工维护）；
 * · 同版本重复并 ⇒ `changed: false`（幂等；写端据此不写盘）。
 */
export function mergeCapabilityBoundaryBlock(
  existing: string,
  block: string,
  version: number = CAPABILITY_BOUNDARY_PROMPT_VERSION,
): CapabilityBoundaryMergeResult {
  const wrapped = `${capabilityBoundaryStartMarker(version)}\n${block.trim()}\n${capabilityBoundaryEndMarker(version)}`;
  const text = typeof existing === 'string' ? existing : '';
  const match = BOUNDARY_BLOCK_RE.exec(text);
  if (match) {
    if (match[0] === wrapped) return { content: text, changed: false };
    return {
      content: `${text.slice(0, match.index)}${wrapped}${text.slice(match.index + match[0].length)}`,
      changed: true,
    };
  }
  if (text.trim().length === 0) return { content: `${wrapped}\n`, changed: true };
  const separator = text.endsWith('\n') ? '\n' : '\n\n';
  return { content: `${text}${separator}${wrapped}\n`, changed: true };
}

export type UnsupportedRequestReason = 'model' | 'image-generation' | 'video-generation' | 'voice';

export interface UnsupportedRequestHit {
  reason: UnsupportedRequestReason;
  copyKey: string;
}

export interface RecognizeUnsupportedOptions {
  /** 目录里真的存在的模型 id：命中这些的 token 不算"不存在"（例如将来接了 Claude）。 */
  availableModelIds?: readonly string[];
}

/**
 * 其它厂商模型的名字（**明确不在本机目录里**的那些）。
 *
 * ⚠️ 只收**确定不是我们模型**的名字：目录里已有的家族（qwen / deepseek / glm / kimi /
 *    doubao …）一个都不许进来 —— 误判会让用户被一句"暂不支持"顶回他自己的可用模型。
 *    将来真接了其中某家（如 Claude），把它从名单删掉；`availableModelIds` 是第二道闸。
 */
const ABSENT_MODEL_TOKENS: readonly string[] = [
  'chatgpt',
  'gpt',
  'openai',
  'claude',
  'anthropic',
  'gemini',
  'bard',
  'grok',
  'llama',
  'mistral',
  'ernie',
  '文心一言',
  '文心',
];

/** 图片生成意图（保守：只认"生成/制作/做 + 图片类名词"，`画一张流程图` 这类不误伤）。 */
const IMAGE_INTENT_RE = /(?:生成|制作|做)[一\d]*张?(?:图片|配图|插图|海报)|文生图|生成图片|ai\s*(?:绘图|绘画|画图)/iu;
/** 视频生成意图（同上：动词 + 视频名词，`分析这段视频` 不误伤）。 */
const VIDEO_INTENT_RE = /(?:生成|制作|做|剪)[一\d]*段?(?:视频|短片|mv)|视频生成|生成视频/iu;
/** 语音合成 / 声音克隆意图。 */
const VOICE_INTENT_RE = /克隆(?:我的|我)?声音|声音克隆|语音克隆|语音合成|声音复刻/iu;

/**
 * 请求前置识别：用户这句话是不是在点名"本机根本没有的能力"。
 *
 * 纯函数、无 IO；**保守优先**——命中才给文案，拿不准一律 `null`（错报会把正常任务
 * 顶回一句"暂不支持"，比漏报坏得多）。
 */
export function recognizeUnsupportedCapabilityRequest(
  text: string,
  options?: RecognizeUnsupportedOptions,
): UnsupportedRequestHit | null {
  const normalized = (text ?? '').toLowerCase();
  if (normalized.trim().length === 0) return null;
  const available = (options?.availableModelIds ?? []).map((id) => id.toLowerCase());

  const mentions = (token: string): boolean => {
    if (available.some((id) => id.includes(token))) return false;
    if (/^[a-z0-9]+$/u.test(token)) {
      return new RegExp(`(?:^|[^a-z0-9])${token}(?:[^a-z0-9]|$)`, 'u').test(normalized);
    }
    return normalized.includes(token);
  };

  if (ABSENT_MODEL_TOKENS.some(mentions)) return { reason: 'model', copyKey: UNSUPPORTED_MODEL_COPY_KEY };
  if (VOICE_INTENT_RE.test(normalized)) return { reason: 'voice', copyKey: UNSUPPORTED_CAPABILITY_COPY_KEY };
  if (IMAGE_INTENT_RE.test(normalized)) {
    return { reason: 'image-generation', copyKey: UNSUPPORTED_CAPABILITY_COPY_KEY };
  }
  if (VIDEO_INTENT_RE.test(normalized)) {
    return { reason: 'video-generation', copyKey: UNSUPPORTED_CAPABILITY_COPY_KEY };
  }
  return null;
}
