/**
 * 「记忆草案」的**契约文本**（写给助手看的）与**载体解析**（客户端读助手回复的）。
 *
 * ## 为什么要有一段注入的契约
 *
 * 一期明确定的是"**助手只提草案、用户点头才落盘**，不做自动写入"。要做到这一点，
 * 助手必须知道**怎么提**：本运行时里"助手请求客户端做一件结构化的事"只有一条既有通道 ——
 * 在回复里给一个**围栏代码块**（`docgen` / `slidegen` / `htmlgen` / `videogen` / `imagegen`
 * 五条通道都是这个形状，见 `main/ipc/data-handlers.ts` 的 `hasStructuredFenceKind`）。
 * 记忆草案沿用同一形状，客户端解析后**只建一条待确认草案**，绝不直接落盘。
 *
 * 契约文本随 `AGENTS.md` 注入（运行时每轮全文注入、且**只有它**会进子代理会话，
 * 见 `capability-boundary-prompt.ts` 的实读结论）—— 与能力边界同一通道、**不同标记**。
 *
 * ## 载体：```memory 围栏
 *
 * 正文是一行 JSON（`{"text": "...", "reason": "..."}`）。JSON 而不是自由文本，是因为
 * "这段字是记忆正文"与"这段字只是解释"必须在解析层可区分；模型写坏 JSON 时我们
 * **整块忽略**（`memory-draft-fence.ts` 的纪律），而不是把一段坏 JSON 当记忆存进去。
 */

import { checkMemoryText, MEMORY_DRAFT_MAX_PER_MESSAGE, MEMORY_ENTRY_MAX_CHARS } from './memory-entry.js';
import { markedBlockBulletLines, mergeMarkedBlock, type MarkedBlockMerge } from './marked-block.js';

/** 契约版本：文案变化时 +1（写端据此升级已注入的那一块）。 */
export const MEMORY_CONTRACT_VERSION = 1;

/** 契约区块的标记前缀。**故意与 `partner-w-memory` 不同**：两者一个住在 `AGENTS.md`（契约），一个住在 `MEMORY.md`（内容），互不匹配。 */
export const MEMORY_CONTRACT_MARKER_PREFIX = 'partner-w-memory-contract';

/** 草案围栏的语言标记。 */
export const MEMORY_DRAFT_FENCE = 'memory';

/**
 * 注入给助手的契约文本。
 *
 * ⚠️ 三条不许写丢：
 *   ① **只提草案**（写了什么都不会自动生效）；
 *   ② **没被确认的不算记住**（不许对用户说"我记住了"）；
 *   ③ **一条一个块**，正文是 JSON。
 */
export function renderMemoryContractPrompt(): string {
  return [
    '## 长期记忆草案（自动维护区块，请勿手改本区块）',
    '',
    '用户希望你把一件事**长期记住**时（偏好、习惯、长期设定、稳定的个人信息），',
    '你**只提草案**，由用户在工作台「设置 → 记忆」里确认。**你写的任何草案都不会自动生效**，',
    '所以：**在用户确认之前，不要对用户说"我记住了"**，只说"我提了一条待确认的记忆"。',
    '',
    `提草案的方式：回复里给一个 \`\`\`${MEMORY_DRAFT_FENCE} 代码块，正文是一行 JSON：`,
    '',
    `\`\`\`${MEMORY_DRAFT_FENCE}`,
    '{"text": "用户希望结论先行，先给结果再给理由。", "reason": "用户在最近几轮里反复要求先说结论"}',
    `\`\`\``,
    '',
    '规则：',
    `- 一条记忆一个代码块；一条回复里最多 ${MEMORY_DRAFT_MAX_PER_MESSAGE} 条，超过的会被忽略；`,
    `- \`text\` 是一条**独立成立**的陈述（第三人称、能脱离本轮对话被读懂），不超过 ${MEMORY_ENTRY_MAX_CHARS} 字；`,
    '- `reason` 可选，写"为什么值得长期记住"（用户会看到它来决定收不收）；',
    '- **不要**把一次性的任务细节、临时上下文、涉密内容写成记忆；',
    '- 已经在这里列出的、或用户已经拒绝过的，**不要重复提**。',
  ].join('\n');
}

/** 把契约区块并入一份 `AGENTS.md` 正文（幂等；区块外一字不动）。 */
export function mergeMemoryContractBlock(
  existing: string,
  block: string = renderMemoryContractPrompt(),
  version: number = MEMORY_CONTRACT_VERSION,
): MarkedBlockMerge {
  return mergeMarkedBlock(existing, MEMORY_CONTRACT_MARKER_PREFIX, version, block);
}

/** 契约区块里以 `- ` 开头的行（测试与取证用）。 */
export function memoryContractBulletLines(content: string): string[] {
  return markedBlockBulletLines(content, MEMORY_CONTRACT_MARKER_PREFIX);
}

export interface MemoryDraftProposal {
  text: string;
  reason: string | null;
}

export interface MemoryDraftScan {
  proposals: MemoryDraftProposal[];
  /** 认出是草案块、但正文不可用（坏 JSON / 空正文 / 超长）的个数 —— 如实计数，便于排障。 */
  discarded: number;
  /** 超出每消息上限被丢掉的个数。 */
  overflow: number;
}

const FENCE_RE = new RegExp('^```[ \\t]*' + MEMORY_DRAFT_FENCE + '[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n```[ \\t]*$', 'gim');

/**
 * 从一段助手回复里扫出记忆草案。
 *
 * 纪律（与 `videogen/request.ts` 同款"宁可什么都没有"）：
 * · 围栏标记必须**恰好**是 `memory`（大小写不敏感）；
 * · 正文优先按 JSON 解析；**以 `{` 或 `[` 开头但解析失败 ⇒ 整块丢掉**（不猜、不把坏 JSON 当正文）；
 * · 不以 `{`/`[` 开头的正文按**纯文本**处理（模型不写 JSON 时也认，但仍要过长度/控制字校验）；
 * · 正文过不了 `checkMemoryText` ⇒ 丢掉并计数；
 * · 超过上限的块丢掉并计数（`overflow`）—— **不**静默。
 */
export function scanMemoryDraftFences(content: string): MemoryDraftScan {
  const result: MemoryDraftScan = { proposals: [], discarded: 0, overflow: 0 };
  if (typeof content !== 'string' || content.length === 0) return result;

  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(content)) !== null) {
    const raw = (match[1] ?? '').trim();
    if (raw.length === 0) {
      result.discarded += 1;
      continue;
    }
    const parsed = parseProposalBody(raw);
    if (!parsed) {
      result.discarded += 1;
      continue;
    }
    const checked = checkMemoryText(parsed.text);
    if (!checked.ok) {
      result.discarded += 1;
      continue;
    }
    if (result.proposals.length >= MEMORY_DRAFT_MAX_PER_MESSAGE) {
      result.overflow += 1;
      continue;
    }
    const reason = typeof parsed.reason === 'string' && parsed.reason.trim().length > 0 ? parsed.reason.trim() : null;
    result.proposals.push({ text: checked.text, reason });
  }
  return result;
}

function parseProposalBody(raw: string): { text: unknown; reason?: unknown } | null {
  const looksLikeJson = raw.startsWith('{') || raw.startsWith('[');
  if (!looksLikeJson) return { text: raw };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 模型写了一块坏 JSON：**整块丢掉**。把它当正文存进去 = 用户记忆里出现一段代码。
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (!('text' in record)) return null;
  return { text: record.text, reason: record.reason };
}
