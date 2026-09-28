/**
 * **把被显示层截断的那一条助手回复，从网关会话记录里取回完整原文。**
 *
 * ## 症状
 *
 * 正式包 1.0.2：助手把整份 PPT 版面写进回复 ⇒ 运行时在**投影时**把单条消息截到
 * **8,000 字符**、末尾追加字面标记 `...(truncated)...` ⇒ 围栏没有结尾 ⇒
 * 客户端整份丢掉。真机上**连续四次**这么死。
 *
 * ⚠️ 这**不是**模型上下文问题，也**不是**我们都解析器的错，是**显示/投影**层的截断。
 *    完整原文还在网关的会话记录里，可以取回来。
 *
 * ## 全部结论都是**真发请求量到的**（2026-09-28，不是读代码猜的）
 *
 * | 事实 | 量到的结果 |
 * | --- | --- |
 * | `maxChars` 能不能顶开 8,000 | **能**：同一条消息 8,018 → **12,414（完整）**，截断标记消失 |
 * | 预算 N 与返回长度 | N 给回 **N+18** 字符（那 18 是追加的标记本身） |
 * | `maxChars` 合法范围 | 1 … **500,000**（`HISTORY_MAX_CHARS`） |
 * | 身份藏在哪 | ⚠️ **不在 item 顶层**，在 `message.__openclaw.{id,runId}` |
 * | 截断状态藏在哪 | ⚠️ 同上：`__openclaw.truncated` + `__openclaw.reason`，**文本完整时这两个字段整体消失** |
 * | `inputRunIds` 会按 run 过滤吗 | **不会** —— 传真 runId 与假 UUID 返回**逐字节相同** |
 * | `maxBytes` 会抬单条文本上限吗 | **不会** —— 只减消息**条数** |
 *
 * ⚠️ **两个坑，踩过一次就别再踩**：
 *   1. 读 `m.id` / `m.runId` 会得到 `undefined` ⇒ 会**错误地**得出"没有稳定身份"的结论。
 *      它们在 `m.__openclaw` 里。
 *   2. `inputRunIds` 那条路**是死的**（不过滤）。圈定本轮必须**在客户端按 runId 精确比对**。
 *
 * ⇒ 所以：用 `maxChars` 取，**在客户端只认 `__openclaw.runId === 当前 runId` 的那一条**。
 *
 * ## 为什么锚点是 `runId` 而不是我们自己那个 `messageId`
 *
 * 本地 `messages.id` 是 `crypto.randomUUID()` 现造的（`core/stores/message-store.ts`），
 * **网关从没见过它** —— 拿它去问网关等于拿错钥匙。
 * 而 `runId` 是**网关给的**，`chat` 事件里就带，已经落库、也已经接进
 * `ArtifactRunContext.gatewayRunId` / `claimArtifactRun`。所以"稳定消息身份"这条前置条件
 * **本来就满足**，不需要新拉字段。
 *
 * ## 三条纪律（规格明令，逐条钉在测试里）
 *
 * - **不许**按"最长的那条"选；**不许**按"最近闭合的 fence"猜；
 * - **不许**跨 task/session 兜底；**不许**静默退回旧消息；
 * - 取不到完整原文 ⇒ 返回 `unavailable` / `incomplete`，**绝不拿截断文本去生成半份 PPT**。
 */

/**
 * 把 `chat.history` 里**多态的** `content` 收成一段文本。
 *
 * 运行时的消息 `content` 有三种形状（实测）：纯字符串、`[{type:'text', text}]`、
 * 以及混合块数组。**认不出的形状一律当空串，不猜** —— 猜错会把别的块
 * （图片、工具结果）当成正文喂进解析器。
 *
 * ⚠️ 2026-09-28 从 `slidegen/full-reply.ts` 搬到这里：那是"按最长 + 按闭合围栏"选候选的
 *    旧方案，**它的选法已被规格明令禁止**（见文件头），整个模块删掉了；
 *    而这个提取函数是通用的，跟着新的恢复模块走。
 */
export function assistantHistoryText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const record = block as { text?: unknown; content?: unknown };
    if (typeof record.text === 'string' && record.text) parts.push(record.text);
    else if (typeof record.content === 'string' && record.content) parts.push(record.content);
  }
  return parts.join('\n');
}

/**
 * 运行时在截断时追加的字面标记。
 *
 * 量到的规律：预算 N 个字符 ⇒ 返回 **N+18** 个字符，那 18 就是它。
 * 用它做**本地快速判据**：显示文本里没有它 ⇒ 本来就没被截断 ⇒ 一次请求都不用发。
 */
export const DISPLAY_TRUNCATION_MARKER = '...(truncated)...';

/**
 * 向网关请求的**字符**上限，取运行时 schema 允许的最大值（1 … 500,000）。
 *
 * ⚠️ 这是**字符**不是字节。真正的安全上限见 `RECOVERED_MAX_BYTES`，在客户端复核。
 */
export const HISTORY_MAX_CHARS = 500_000;

/**
 * 收下来的原文的**字节**上限（1 MiB）。
 *
 * 理由与 `slidegen/deck-file.ts` 的 `DECK_FILE_MAX_BYTES` 同一条：这条路绕开了 8,000
 * 的显示截断，但"没有显示上限"**不等于**"可以没有上限" —— 一份失控的原文会在
 * **消息收尾路径**上被整份送进排版。
 *
 * ⚠️ 单位为**字节**（运行时的 `maxBytes` 也是字节）。中文一个字 3 字节
 * ⇒ 约 34 万个汉字。**别用"多少字"当判据**（实测踩过：按 `.length` 减预算会超 4 字节）。
 */
export const RECOVERED_MAX_BYTES = 1024 * 1024;

/**
 * 落盘竞态的重试节奏。
 *
 * completion 事件到达时，网关那边可能**还没把这条写进会话记录**，
 * 于是第一次查不到。实测这个窗口很短，所以前几次间隔很小。
 * ⚠️ **必须有上限** —— 收尾路径上一分一秒都算用户的等待。
 */
const RETRY_DELAYS_MS = [0, 100, 250, 500, 1000] as const;

/** 一次 `chat.history` 的返回形状（只声明我们真正读的字段）。 */
export interface ChatHistoryResult {
  messages: HistoryMessage[];
}

/**
 * 一条历史消息。
 *
 * ⚠️ `__openclaw` 是**运行时放身份与截断状态的地方**：`{ id, runId, truncated, reason, seq, … }`。
 *    它们**不在** message 顶层 —— 这一条是实测出来的，不是从类型声明推的。
 */
export interface HistoryMessage {
  role?: unknown;
  content?: unknown;
  /** 实测线上有这个字段（助手消息还带 model / usage / stopReason / responseId 等）。 */
  timestamp?: unknown;
  __openclaw?: {
    id?: unknown;
    runId?: unknown;
    truncated?: unknown;
    reason?: unknown;
  };
}

export type FetchChatHistory = (params: {
  sessionKey: string;
  limit: number;
  maxChars: number;
}) => Promise<ChatHistoryResult>;

/** 结构化产物的种类。目前只用于日志与将来分档，取法完全相同。 */
export type ArtifactKind = 'slidegen' | 'docgen' | 'html';

export type RecoverResult =
  | { status: 'complete'; content: string }
  /**
   * 取到了，但**它本身还是不完整的**（超过 `maxChars` / 模型输出被截断）。
   * ⚠️ 调用方**不可以用**这个结果去生成产物。
   */
  | { status: 'incomplete'; reason: string }
  /** 取不到（还没落盘 / 网关没连上 / 这一轮压根没有助手消息）。调用方**不可以用**显示文本兜底生成。 */
  | { status: 'unavailable'; reason: string };

export interface RecoverInput {
  sessionKey: string;
  /** 网关给的本轮身份（`chat` 事件里的 `runId`）。**不是**本地那个 `messages.id`。 */
  currentRunId: string;
  /** 屏幕上那一份（可能已被截断）。 */
  displayContent: string;
  artifactKind: ArtifactKind;
  deps: {
    fetchHistory: FetchChatHistory;
    /** 注入是为了测试能跳过真实等待。 */
    sleep?: (ms: number) => Promise<void>;
  };
}

/** 这条消息是不是**本轮**那位助手的。两条都要满足 —— 少一条就会串轮次。 */
function isAssistantMessageForRun(message: HistoryMessage, runId: string): boolean {
  if (message.role !== 'assistant') return false;
  return message.__openclaw?.runId === runId;
}

/**
 * 把网关客户端的原始响应收成 `FetchChatHistory`。
 *
 * ⚠️ **必须原样带出 `__openclaw`** —— 身份（`id` / `runId`）与截断状态
 *    （`truncated` / `reason`）全在里面。少带一层，整个恢复逻辑就是瞎的
 *    （而且表现为"找不到这一轮" ⇒ 静默什么都恢复不了）。
 * ⚠️ 响应畸形一律回**空数组**、不抛：这条跑在**消息收尾路径**上。
 */
export function historyFetcherFrom(client: {
  getChatHistory: (sessionKey: string, limit?: number, maxChars?: number) => Promise<Record<string, unknown>>;
}): FetchChatHistory {
  return async ({ sessionKey, limit, maxChars }) => {
    const raw = await client.getChatHistory(sessionKey, limit, maxChars);
    const messages = (raw as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) return { messages: [] };
    return { messages: messages.filter((entry): entry is HistoryMessage => !!entry && typeof entry === 'object') };
  };
}

/**
 * 取回完整原文。
 *
 * 快速路径：显示文本里没有截断标记 ⇒ 它本来就是完整的 ⇒ **直接返回，不发请求**。
 * （普通聊天绝大多数走这条，零成本。）
 */
export async function recoverFullReply(input: RecoverInput): Promise<RecoverResult> {
  // ── 快速路径：没被截断就别去打扰网关 ──────────────────────────────────
  if (!input.displayContent.includes(DISPLAY_TRUNCATION_MARKER)) {
    return { status: 'complete', content: input.displayContent };
  }

  // ── 没有稳定身份就别去猜 ────────────────────────────────────────────────
  // 规格明令：**没有稳定消息身份，不允许上线恢复逻辑**。
  // 少了 runId 就没有任何"精确匹配"可做 —— 那几种偷懒取法（最长 / 最近围栏 / 跨会话）
  // 全都在禁令里。⇒ 直接回 unavailable，让调用方**不生成**，而不是拿截断文本凑一份。
  // ⚠️ 这里提前返回还有一个好处：不白跑五次网关请求 + 累计 1.85 秒的等待。
  if (!input.currentRunId) return { status: 'unavailable', reason: 'no-run-id' };

  const sleep = input.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastReason = 'not-found';

  for (const delay of RETRY_DELAYS_MS) {
    if (delay > 0) await sleep(delay);
    try {
      const history = await input.deps.fetchHistory({
        sessionKey: input.sessionKey,
        limit: RETRY_DELAYS_MS.length + 2,
        maxChars: HISTORY_MAX_CHARS,
      });
      const message = history.messages.find((entry) => isAssistantMessageForRun(entry, input.currentRunId));
      if (!message) {
        // 还没落盘（或者压根不是这一轮）⇒ 换下一个间隔再试。
        lastReason = 'not-found';
        continue;
      }

      // ⚠️ 完整时运行时会把这两个字段**整体去掉**；还在 ⇒ 这份就是被截断的。
      if (message.__openclaw?.truncated === true) {
        const reason = typeof message.__openclaw.reason === 'string' ? message.__openclaw.reason : 'unknown';
        return { status: 'incomplete', reason };
      }

      const content = assistantHistoryText(message.content);
      if (!content) {
        lastReason = 'empty-message';
        continue;
      }

      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > RECOVERED_MAX_BYTES) {
        // 明确、可测、有限的失败 —— 不硬塞给解析器，也不静默截断。
        return { status: 'incomplete', reason: 'too-large' };
      }

      return { status: 'complete', content };
    } catch (error) {
      // 网关没连上 / RPC 超时。收尾链不能被它掀翻 ⇒ 吞掉，记原因，接着重试。
      lastReason = error instanceof Error ? error.message : 'unknown';
    }
  }

  return { status: 'unavailable', reason: lastReason };
}
