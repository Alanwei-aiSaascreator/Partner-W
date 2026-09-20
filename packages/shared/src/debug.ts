const REDACTED = '***redacted***';
const TRUNCATE_AT = 500;
const SECRET_KEY_RE = /(token|password|secret|authorization|cookie|pairingcode|bootstraptoken)/i;

/**
 * **会话正文**类字段（外部审计 P3：日志里落地了用户原话）。
 *
 * 实测（本机 `logs/debug-*.ndjson`，不是推测）：`chat.history` 的应答
 * 与流式事件被整包记进日志 ⇒ `messages[].content`、`content[].text`、
 * `content[].thinking` 里是**用户原话与模型正文**。截断到 500 字符只是
 * "少存一点"，不是"不存"。
 */
const CONTENT_KEY_RE = /^(content|text|thinking)$/i;

/**
 * ⚠️ 已核对的**已知代价**（实测本机 16 个日志文件、12.3 万条事件里的键分布）：
 *    `text` 这个键**同时**被两边用 —— 模型正文/流式 delta（该摘）与网关状态行
 *    （`{version, mode, reason, host, ip, platform, text}`，"Gateway: Digua … · app 2026.9.3"）。
 *    状态行的 `text` 也会被摘掉，**但信息没丢**：版本/模式/原因/主机都在同一个对象的
 *    结构化字段里（各 100 条实测样本）。所以这里不为此开特例 —— 特例才是将来的漏洞。
 */

/** 正文被摘掉后留下的标记（与"密钥被摘"区分开，读日志时一眼能认出）。 */
export const REDACTED_CONTENT = '***content-redacted***';

/**
 * `chat.send` 的参数里，用户那句话挂在 `message` 上（正文，不是日志行）。
 *
 * ⚠️ 判据**不能**只看键名 `message`：我们自己的日志事件里也有
 *    `sessionKey` + `message`（`message` 是那条日志的说明文字，摘掉就没法查故障了）。
 *    真正能区分"这是聊天载荷"的是 **`idempotencyKey`** —— 实测它只出现在
 *    openclaw 的聊天对象/参数上（`{sessionKey, message, idempotencyKey, deliver}`），
 *    我们的 DebugEvent 从不带它。
 */
const CHAT_PAYLOAD_MARKER = 'idempotencyKey';

export type DebugLevel = 'debug' | 'info' | 'warn' | 'error';
export type DebugDomain =
  | 'app'
  | 'gateway'
  | 'ipc'
  | 'renderer'
  | 'db'
  | 'workspace'
  | 'artifact'
  | 'debug'
  | 'tray'
  | 'quick-launch'
  | 'updater'
  | 'commercial'
  | 'analytics'
  | 'privacy'
  | 'avatar'
  /** 资料库：索引流水线、嵌入引擎、检索（T6）。 */
  | 'kb';

export interface DebugError {
  name?: string;
  message: string;
  stack?: string;
  code?: string;
}

export interface DebugEvent {
  ts: string;
  level: DebugLevel;
  domain: DebugDomain;
  event: string;
  traceId?: string;
  feature?: string;
  message?: string;
  gatewayId?: string;
  sessionKey?: string;
  taskId?: string;
  runId?: string;
  requestId?: string;
  wsFrameId?: string;
  seq?: number;
  attempt?: number;
  durationMs?: number;
  ok?: boolean;
  error?: DebugError;
  data?: Record<string, unknown>;
}

export function truncateForLog(value: string, maxLen = TRUNCATE_AT): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}…<truncated len=${value.length}>`;
}

export function sanitizeForLog<T>(value: T): T {
  return sanitizeValue(value) as T;
}

/**
 * 网关载荷的摘要：与 `sanitizeForLog` 同一套规则（同一次遍历，不复制实现）。
 *
 * 名字容易误会成"只做长度摘要"——它**同时**负责摘掉会话正文：
 * 网关帧是**整包**记进日志的，`chat.history` 的应答与流式事件里带的是
 * 用户原话与模型正文（见 `CONTENT_KEY_RE`）。
 */
export function summarizePayload<T>(value: T): T {
  return sanitizeValue(value) as T;
}

function sanitizeValue(value: unknown, key?: string): unknown {
  if (key && SECRET_KEY_RE.test(key)) {
    return REDACTED;
  }

  if (typeof value === 'string') {
    // 正文类字段：**整段**摘掉（不是截断 —— 截断只是"少存一点"）
    if (key && CONTENT_KEY_RE.test(key)) {
      return REDACTED_CONTENT;
    }
    return truncateForLog(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  // 聊天载荷：见 `CHAT_PAYLOAD_MARKER` —— 只认**带 idempotencyKey 的对象**，
  // 我们自己的日志事件（有 sessionKey + message 说明文字）不在此列。
  const isChatPayload = typeof (value as Record<string, unknown>)[CHAT_PAYLOAD_MARKER] === 'string';

  const output: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    output[entryKey] =
      isChatPayload && entryKey === 'message' && typeof entryValue === 'string'
        ? REDACTED_CONTENT
        : sanitizeValue(entryValue, entryKey);
  }
  return output;
}
