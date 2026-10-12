export const GATEWAY_WS_PORT = 18789;

/**
 * Bounds for free-form recharge, in cents.
 *
 * The database RPC `create_recharge_order_custom` is the authority and rejects
 * anything outside this range on its own. These exist so the renderer and the
 * main process agree without a round trip — changing them means changing the
 * RPC too.
 */
export const CUSTOM_RECHARGE_MIN_CENTS = 100; // ¥1
export const CUSTOM_RECHARGE_MAX_CENTS = 50000; // ¥500

/**
 * Parses a user-typed yuan amount ("1", "10.5", "500") into cents.
 *
 * Returns null for anything that is not a usable amount, including values
 * outside the recharge bounds — callers show one error either way, and the RPC
 * re-checks. Deliberately integer arithmetic: `Number('1.15') * 100` is
 * 114.99999999999999, which rounds fine here but is not something to rely on
 * when the result is money.
 */
export function parseRechargeYuanToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, frac = ''] = trimmed.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isInteger(cents)) return null;
  if (cents < CUSTOM_RECHARGE_MIN_CENTS || cents > CUSTOM_RECHARGE_MAX_CENTS) return null;
  return cents;
}

export const SESSION_KEY_PREFIX = 'agent:main:clawwork:task:';
const CLAWWORK_DEVICE_SESSION_RE = /^agent:([^:]+):clawwork:([^:]+):task:(.+)$/;
const CLAWWORK_SESSION_RE = /^agent:([^:]+):clawwork:task:(.+)$/;
const LEGACY_SESSION_KEY_RE = /^agent:[^:]+:task-(.+)$/;
const SUBAGENT_SESSION_RE = /^agent:([^:]+):subagent:([a-f0-9-]+)$/;

export function buildSessionKey(taskId: string, agentId: string = 'main', deviceId?: string): string {
  if (deviceId) return `agent:${agentId}:clawwork:${deviceId}:task:${taskId}`;
  return `agent:${agentId}:clawwork:task:${taskId}`;
}

export function parseTaskIdFromSessionKey(sessionKey: string): string | null {
  const dm = sessionKey.match(CLAWWORK_DEVICE_SESSION_RE);
  if (dm) return dm[3] || null;

  const m = sessionKey.match(CLAWWORK_SESSION_RE);
  if (m) return m[2] || null;

  const legacyMatch = sessionKey.match(LEGACY_SESSION_KEY_RE);
  return legacyMatch ? legacyMatch[1] : null;
}

export function parseAgentIdFromSessionKey(sessionKey: string): string {
  const dm = sessionKey.match(CLAWWORK_DEVICE_SESSION_RE);
  if (dm) return dm[1];
  const m = sessionKey.match(CLAWWORK_SESSION_RE);
  if (m) return m[1];
  const sub = sessionKey.match(SUBAGENT_SESSION_RE);
  if (sub) return sub[1];
  return 'main';
}

export function isSubagentSession(sessionKey: string): boolean {
  return SUBAGENT_SESSION_RE.test(sessionKey);
}

/**
 * 房间成员（worker）在界面上显示什么名字 —— **唯一**的优先级规则。
 *
 * 为什么要收成一处：`RoomPerformer.agentName` 是**派活那一刻写的快照**，
 * 而网关目录里的 `name` 是**活的**。两处（消息头像区、成员头像提示条）各写一遍优先级，
 * 就会像 2026-09-20 那样一处对一处错。
 *
 * ⚠️ 实测（2026-09-20，`agents.list` 直连网关）：目录里
 * `rongying-tpl-78b62899` 的 `name` 就是「爆款内容教练」——
 * 所以**目录优先**能直接消掉"消息头显示裸 agentId"那个症状。
 *
 * ⚠️ 快照**不能删**：agent 被删/换网关后目录里就没有它了，那时只有快照还记得名字。
 * 但它必须排在目录**后面**：存量数据库里这个字段存的就是裸 agentId（两个写入方都传错了），
 * 排在前面就会**永远遮住**目录里的真名。
 */
export function resolvePerformerAgentName(
  performer: { agentId: string; agentName?: string } | undefined,
  // `id` 只是为了让调用方能直接塞 `AgentInfo`（结构化类型）；本函数不读它。
  catalogEntry: { id?: string; name?: string } | undefined,
): string {
  const catalogName = catalogEntry?.name;
  if (catalogName) return catalogName;
  const snapshot = performer?.agentName;
  if (snapshot) return snapshot;
  return performer?.agentId ?? '';
}

export function mergeGatewayStreamText(previous: string, incoming: string): string {
  if (!incoming) return previous;
  if (incoming === previous) return previous;
  if (incoming.startsWith(previous)) return incoming;
  if (previous.startsWith(incoming)) return previous;
  return previous + incoming;
}

/**
 * 推理（thinking）流的合并 —— 与 `mergeGatewayStreamText` 的关键差别：**按段**。
 *
 * 推理是**分段重发**的：每段工具调用之后模型重新开始推理，网关从空快照重新累积
 * （不是接在上一段后面）。实机实测（2026-09-20，一个 worker 的 121 条 thinking 事件）
 * 里有 **7 次重置** —— `chars` 从 227 → 3、1409 → 3、860 → 3 …，共 8 段。
 *
 * ⚠️ 跨段时两个方向**都不是前缀**，`mergeGatewayStreamText` 会落到 `previous + incoming`
 * **直接拼接** ⇒ 8 段推理糊成一团，界面上就是"同一句反复出现、越接越长"。
 * ⇒ 这里把无法判定为同段的情况当成**新的一段**，用空行隔开。
 *
 * ⚠️ 本通道送的是**累计快照**（见 `AgentThinkingData` 的注释），所以不处理"真增量片段"；
 *    即便真来了增量，空行隔开也只是多一个换行，不会丢内容。
 */
export function mergeThinkingSegments(previous: string, incoming: string): string {
  if (!incoming) return previous;
  if (incoming === previous) return previous;
  if (incoming.startsWith(previous)) return incoming;
  if (previous.startsWith(incoming)) return previous;
  // ⚠️ 重连/重订阅会把**旧段**再投一次：它已经是我们结果的尾部 ⇒ 保持，别再加一遍。
  //    否则"重复投递不会把推理拼成两遍"这条保证就破了。
  if (previous.endsWith(incoming)) return previous;
  // 空行隔开：它们是**不同**的推理块，不该粘成一团。
  return previous + '\n\n' + incoming;
}

export function isClawWorkSession(sessionKey: string, deviceId?: string): boolean {
  if (deviceId) {
    const dm = sessionKey.match(CLAWWORK_DEVICE_SESSION_RE);
    return dm !== null && dm[2] === deviceId;
  }
  return CLAWWORK_DEVICE_SESSION_RE.test(sessionKey) || CLAWWORK_SESSION_RE.test(sessionKey);
}

const SYSTEM_SESSION_RE = /^agent:[^:]+:clawwork:system:[^:]+:[a-f0-9-]+$/;

export function buildSystemSessionKey(purpose: string, agentId: string = 'main'): string {
  return `agent:${agentId}:clawwork:system:${purpose}:${crypto.randomUUID()}`;
}

export function isSystemSession(sessionKey: string): boolean {
  return SYSTEM_SESSION_RE.test(sessionKey);
}

export const HEARTBEAT_INTERVAL_MS = 30_000;

export const RECONNECT_DELAY_MS = 3_000;

export const MAX_RECONNECT_ATTEMPTS = 10;

export const SUPPORTED_LANGUAGE_CODES = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'pt', 'de', 'es', 'fr'] as const;
export type LanguageCode = (typeof SUPPORTED_LANGUAGE_CODES)[number];

export const DEFAULT_WORKSPACE_DIR = 'ClawWork-Workspace';

export const CONFIG_FILE_NAME = 'clawwork-config.json';

export const DB_FILE_NAME = '.clawwork.db';

export const TEAMSHUB_COMMUNITY_URL = 'https://github.com/clawwork-ai/teamshub-community';
export const TEAMSHUB_COMMUNITY_ID = 'community';

/**
 * 上游 id（`pricing_rules.provider`）→ 界面上给人看的名字。
 *
 * ⚠️ 与服务端 `services/relay/src/catalog.ts` 里那份是**同源**的：
 *    那边决定客户端在模型下拉里看到什么名字，这边决定统计页显示什么。
 *    改一处要两边一起改 —— 但**不要**加第三份。
 *
 * 查不到 id 时调用方应回退成原样显示 id：新上游接进来时宁可显示
 * `volc` 这样的生 id，也不要显示空白（空白会被当成「数据没加载出来」）。
 */
export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  bailian: '百炼',
  ark: '火山方舟',
};

export const MAX_USER_TASK_CHARS = 4000;
export const MAX_AGENT_CATALOG_CHARS = 8000;
export const USER_TASK_FENCE_OPEN = '<<<USER_TASK';
export const USER_TASK_FENCE_CLOSE = '>>>USER_TASK';

const TRUNCATED_PROMPT_SUFFIX = '\n... [truncated]';

// Matches catalog lines produced by useChatSend: "- id: <id>, name: \"...\"[, emoji: ...][, role: \"...\"][, description: \"...\"]"
const AGENT_CATALOG_LINE_BREAK_CHARS = '\\n\\r\\x00-\\x1f\\u0085\\u2028\\u2029';
const AGENT_CATALOG_QUOTED_VALUE_RE = `(?:[^"${AGENT_CATALOG_LINE_BREAK_CHARS}\\\\]|\\\\.)*`;
const AGENT_CATALOG_EMOJI_RE = `[^\\s,${AGENT_CATALOG_LINE_BREAK_CHARS}]+`;
const AGENT_CATALOG_LINE_RE = new RegExp(
  `^- id: [\\w-]+, name: "${AGENT_CATALOG_QUOTED_VALUE_RE}"(?:, emoji: ${AGENT_CATALOG_EMOJI_RE})?(?:, role: "${AGENT_CATALOG_QUOTED_VALUE_RE}")?(?:, description: "${AGENT_CATALOG_QUOTED_VALUE_RE}")?$`,
);

function normalizePromptText(input: unknown): string {
  return typeof input === 'string'
    ? input
        .replace(/\r\n?/g, '\n')
        .replace(/[\f\v\u0085\u2028\u2029]/g, '\n')
        .trim()
    : '';
}

function truncatePromptText(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  const maxBodyChars = Math.max(0, maxChars - TRUNCATED_PROMPT_SUFFIX.length);
  return `${input.slice(0, maxBodyChars).trimEnd()}${TRUNCATED_PROMPT_SUFFIX}`;
}

function stripPromptFenceLines(lines: string[]): string[] {
  return lines.filter((line) => line.trim() !== USER_TASK_FENCE_OPEN && line.trim() !== USER_TASK_FENCE_CLOSE);
}

export function sanitizeAgentCatalog(input: unknown): string {
  // Only normalize CRLF pairs here — do not fold lone \r or Unicode line separators before
  // validation, or a single malformed line can split into injected catalog entries.
  const normalized = typeof input === 'string' ? input.replace(/\r\n/g, '\n').trim() : '';
  if (!normalized) return '';
  // Split on LF only — do not split on lone \r or the injection line above becomes two valid entries.
  const validated = stripPromptFenceLines(normalized.split('\n'))
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && AGENT_CATALOG_LINE_RE.test(line));
  return truncatePromptText(validated.join('\n'), MAX_AGENT_CATALOG_CHARS);
}

export function sanitizeUserTask(input: unknown): string {
  const normalized = normalizePromptText(input);
  if (!normalized) return '';
  const stripped = stripPromptFenceLines(normalized.split('\n')).join('\n');
  return truncatePromptText(stripped, MAX_USER_TASK_CHARS);
}

export function buildConductorPrompt(agentCatalog: string): string {
  const safeAgentCatalog = sanitizeAgentCatalog(agentCatalog);
  return [
    'You are a task coordinator. Your responsibilities:',
    "1. Analyze the user's task and determine if multi-agent collaboration is needed",
    '2. Solve the task directly in the current session by default',
    '3. Delegate only when a listed worker adds clear value and native delegation is actually available',
    '4. If workers are used, integrate their results; otherwise complete the work yourself',
    '5. Deliver one honest final result to the user',
    '',
    'Hard rules:',
    '- Delegation is optional. Do not make task completion depend on `sessions_spawn` or any worker session.',
    '- If delegation is unavailable, unnecessary, or fails, continue the task yourself in the current session.',
    '- Do not use exec, process, bash background jobs, or any non-native path to simulate worker orchestration.',
    '- Do not claim that a worker started unless its `sessions_spawn` call succeeded.',
    '- Do not tell desktop users to run `openclaw doctor`, any other OpenClaw CLI command, or terminal commands.',
    '- Offer only in-app next steps such as retrying, reconnecting, or opening Settings.',
    '- If you delegate, use only the agent ids listed below.',
    '- Child completion is push-based. Do NOT poll sessions_list, sessions_history, or exec sleep for status.',
    '',
    'Optional dispatch modes (only after a worker was successfully spawned):',
    '- Serial: sessions_send(sessionKey, message, timeoutSeconds:30) — blocks until reply',
    '- Parallel: sessions_send(sessionKey, message, timeoutSeconds:0) — fire-and-forget, result pushed back when done',
    'Use serial when the next step depends on this result. Use parallel when multiple steps are independent.',
    '',
    'Worker sessions are reusable. You can send multiple messages to the same session for iterative work.',
    '',
    'Available agents:',
    safeAgentCatalog,
  ].join('\n');
}

export interface MentionParseResult {
  targets: string[];
  cleanContent: string;
  isAll: boolean;
}

const MENTION_ALL_RE = /(?:^|\s)@all(?=\s|$)/;
const MENTION_RE = /@([\w-]+)/g;

export function parseMentions(content: string, knownAgentIds: Set<string>): MentionParseResult {
  if (MENTION_ALL_RE.test(content)) {
    return {
      targets: [...knownAgentIds],
      cleanContent: content
        .replace(MENTION_RE, '')
        .replace(/\s{2,}/g, ' ')
        .trim(),
      isAll: true,
    };
  }

  const targets: string[] = [];
  let match;
  const re = new RegExp(MENTION_RE.source, MENTION_RE.flags);
  while ((match = re.exec(content))) {
    const agentId = match[1];
    if (knownAgentIds.has(agentId) && !targets.includes(agentId)) {
      targets.push(agentId);
    }
  }

  if (!targets.length) return { targets: [], cleanContent: content, isAll: false };

  const cleanContent = content
    .replace(MENTION_RE, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { targets, cleanContent, isAll: false };
}

export const RETRYABLE_ERROR_CODES = new Set([
  'RATE_LIMIT',
  'RATE_LIMITED',
  'TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'MODEL_UNAVAILABLE',
  'SERVICE_UNAVAILABLE',
  'GATEWAY_TIMEOUT',
  'OVERLOADED',
]);

export const NON_RETRYABLE_ERROR_CODES = new Set([
  'AUTH_INVALID',
  'AUTH_FAILED',
  'GATEWAY_AUTH_FAILED',
  'QUOTA_EXHAUSTED',
  'CONTENT_POLICY',
  'CONTENT_FILTERED',
  'CONTEXT_LENGTH_EXCEEDED',
  'INVALID_REQUEST',
  'SESSION_NOT_FOUND',
  'AGENT_NOT_FOUND',
  'PERMISSION_DENIED',
  'METHOD_NOT_SUPPORTED',
]);

/**
 * 商业默认模型（**唯一真源**）。
 *
 * 为什么必须只有一处：它同时决定两件事 ——
 *   ① 激活时写进网关的 `agents.defaults.model.primary`（main 进程）；
 *   ② composer 显示的"当前模型"（渲染层）。
 * 2026-09-17 实机就是因为两边各定义一次（main 取"中转目录第一条"= qwen3.5-27b，
 * 渲染层写死 deepseek-v4-flash），用户看到的模型和实际生成消息的模型对不上。
 *
 * 2026-10-10 Cephalon 批：默认 = `glm-5.3-flash`（与智能档同一模型 —— 三档映射
 * 见 `task-modes.ts`，此处是"新任务默认"的唯一来源）。
 *
 * ⚠️ 只写**model id 本体**（不带 `clawrouter/` 前缀）：网关里的 ref 是两段，
 *    前缀由调用方按自己的上下文拼（见 relay-config.ts 的说明）。
 */
export const COMMERCIAL_DEFAULT_MODEL_ID = 'glm-5.3-flash';

/**
 * 冷启动开场片（1 分钟，含内嵌音轨）。
 *
 * ⚠️ `OPENING_MEDIA_DIR_NAME` 必须与 electron-builder 配置里 extraResources 的
 *    `to:` 一字不差（`test/opening-media-packaging-gate.test.ts` 钉住）。
 * ⚠️ 媒体绝不进 app.asar（同 pptx-templates 的理由：大文件走 extraResources）。
 */
export const OPENING_MEDIA_SCHEME = 'clawwork-asset';
export const OPENING_MEDIA_DIR_NAME = 'media';
export const OPENING_VIDEO_FILE_NAME = 'opening.mp4';
