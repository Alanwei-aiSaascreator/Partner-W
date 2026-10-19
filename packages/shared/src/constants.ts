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
 * 推理（thinking）分段的**显式状态**（2026-10-13 第二次独立复审整改）。
 *
 * 背景（为什么必须显式存，而不是拿字符串猜）：推理是**分段重发**的 —— 每段工具调用
 * 之后模型重新开始推理，网关从空快照重新累积（不是接在上一段后面，实机实测
 * 2026-09-20：一个 worker 的 121 条 thinking 事件里 7 次重置、共 8 段）；本通道送的是
 * **累计快照**。同一段内快照只会"变长"（新快照以上一个快照为前缀），除此之外一律是新段。
 * **"当前段身份"没有任何可靠的纯字符串特征**：
 *   - 最长后缀匹配会把合法新段当延长（`…开始检查` + 新段`检查结果正常` 被拼成
 *     `…开始检查结果正常`）——复审反例 1；
 *   - 全历史 includes 会把与历史同文的新段整段吞掉——复审反例 2；
 *   - 两者还都退化成平方级扫描（重复前缀输入）。
 * ⇒ 状态必须**显式保存**：已完成段（completed）+ 当前段最新快照（current）。
 *   段边界由**真实事件语义**给出：工具调用落地 = 前一段结束（`sealThinkingSegment`）。
 */
export interface ThinkingSegments {
  /** 已完成段的合并文本（段间空行分隔；没有已完成段 = ''）。 */
  completed: string;
  /** 当前段的最新累计快照（原始文本；工具边界后从空重新开始）。 */
  current: string;
  /**
   * **刚归档那一段**的文本（回声守卫基线，仅一段、O(1)）。
   *
   * 形状来源（F1 回归，2026-10-08）：工具边界之后的帧里旧 thinking 块可能被**原样重投**
   *（blocks 数组还带着上一段的文本）——它必须被当作回声忽略，不得开新段、不得弹 activity。
   * ⚠️ 只认**刚归档的最近一段**：更早的历史一律不猜（2026-10-13 复审：新段允许与历史
   *    完全同文——拿全历史做 includes/前缀都会吞掉合法新段）。
   */
  lastSealed: string;
  /**
   * **源端段身份**（BUG-075 / T26，2026-10-16）：当前段由源端（网关/运行时）给出的标识。
   *
   * 为什么需要它：`current` / `lastSealed` 全是**文本**，而 BUG-075 的两条未决反例
   * （复审探针 `new-prefix-after-tool` / `new-identical-after-tool`）恰好是"边界后的新段
   * 与刚归档段**前缀相同 / 完全同文**"——纯字符串在这两种输入上**没有可判据的差异**
   * （同一对字符串既可能是回声、也可能是合法新段），所以当时只能保留 skip。
   *
   * 有了源端身份就不再需要猜：**同 id = 同一段的累计快照；不同 id = 一定是新段**，
   * 哪怕文本一模一样、哪怕新段是旧段的前缀。
   *
   * ⚠️ 缺省（`undefined` / `''`）= 该帧**没有**身份（旧运行时 / 旧协议）⇒ 逐字回落到
   *    原来的字符串启发式 + 回声守卫，既有行为一字不变。
   */
  currentId?: string;
  /** 刚归档那一段的身份（同 `lastSealed`，用于身份侧的回声判定；缺省 = 未知）。 */
  lastSealedId?: string;
}

/** 显示文本：已完成段 + 空行 + 当前段（给 UI 与 final 用）。 */
export function renderThinkingSegments(state: ThinkingSegments): string {
  if (!state.current) return state.completed;
  if (!state.completed) return state.current;
  return state.completed + '\n\n' + state.current;
}

/**
 * 当前段快照合并 —— **只跟"当前段最新快照"比**，不猜历史：
 *  - incoming 是 current 的延伸（含相等）⇒ 只替换当前段；current 为空时 = 新段起点，
 *    但先过**回声守卫**（见下）；
 *  - incoming 是 current 的前缀 ⇒ 旧快照/重复重投 ⇒ 原样不动（**同引用**返回，
 *    调用方以此作"真的变了"的判定，activity revision 不应被旧快照推动）；
 *  - 回声守卫：current 为空且 incoming 是 `lastSealed` 的前缀（含相等）⇒ 刚归档段的
 *    重投 ⇒ 原样不动（F1 形状；复审反例均不是该形状，互不冲突）；
 *  - 其余 ⇒ **新段**：current 归档进 completed，新段从 incoming 开始。
 *    新段与历史/已完成段完全同文**也允许**（文本相同 ≠ 同一段）。
 *
 * 复杂度：每次调用 ≤3 次前缀比较（O(len)），没有后缀扫描/历史搜索。
 *
 * ## 源端段身份（BUG-075 / T26，2026-10-16）
 *
 * 第三个参数 `id` 是**源端给的段身份**（缺省 = 没有）。给了身份就**不再用字符串猜**：
 *  - `id === state.currentId` ⇒ 同一段的累计快照 ⇒ 与下面"同段"分支同样的替换规则
 *    （相等/前缀 ⇒ 原样；延伸/更短重投 ⇒ 替换当前段）——**绝不会**被回声守卫吞掉；
 *  - `id !== state.currentId` ⇒ **一定是新段**（哪怕与 `lastSealed` 完全同文）⇒ 归档 + 开新段。
 *
 * 这正是 `new-prefix-after-tool` / `new-identical-after-tool` 两条未决反例的可判据：
 * 身份不同 ⇒ 新段；身份相同 ⇒ 同段。没有身份时下方字符串路径**逐字不变**。
 */
export function mergeThinkingSnapshot(state: ThinkingSegments, incoming: string, id?: string): ThinkingSegments {
  if (!incoming) return state;
  const hasId = typeof id === 'string' && id !== '';
  if (hasId) {
    if (state.currentId === id) {
      // 同一段：相等/重复前缀 ⇒ 原样不动（同引用）；否则替换当前段快照。
      if (state.current === incoming) return state;
      if (state.current.startsWith(incoming)) return state;
      return { ...state, current: incoming };
    }
    // 身份不同 ⇒ 新段（不管文本与新段/旧段像不像）。
    // ⚠️ `current` 为空（刚被工具边界归档过）= **没有东西可归档** ⇒ 不能拼出多余的段间空行，
    //    也不能把 `lastSealed` 覆盖成空（回声守卫基线要留着）。
    if (!state.current) return { ...state, current: incoming, currentId: id };
    return {
      completed: state.completed ? state.completed + '\n\n' + state.current : state.current,
      current: incoming,
      currentId: id,
      lastSealed: state.current,
      lastSealedId: state.currentId ?? '',
    };
  }
  if (state.current === incoming) return state;
  if (state.current.startsWith(incoming)) return state;
  if (incoming.startsWith(state.current)) {
    // 回声守卫：刚归档段的重投（只认最近一段；current 为空 = 还没开始新段）
    if (state.current === '' && state.lastSealed.startsWith(incoming)) return state;
    return { ...state, current: incoming };
  }
  return {
    completed: state.completed ? state.completed + '\n\n' + state.current : state.current,
    current: incoming,
    currentId: '',
    lastSealed: state.current,
    lastSealedId: state.currentId ?? '',
  };
}

/**
 * 段边界：当前段判完（真实语义：**工具调用落地后模型重新开始推理**）⇒ 归档进已完成段，
 * 并把归档文本记进 `lastSealed`（回声守卫基线）。空段是 no-op。
 *
 * ⚠️ 显示文本在 seal 前后**不变**（current 原样挪进 completed，分隔符相同）——
 *    界面不抖、activity revision 不被推动。
 */
export function sealThinkingSegment(state: ThinkingSegments): ThinkingSegments {
  if (!state.current) return state;
  return {
    completed: state.completed ? state.completed + '\n\n' + state.current : state.current,
    current: '',
    currentId: '',
    lastSealed: state.current,
    lastSealedId: state.currentId ?? '',
  };
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
 * 2026-10-17：默认 = **智能档的模型** `glm-5.3-flashx`（三档映射见 `task-modes.ts`）。
 * 两者必须同值 —— 2026-09-17 实机故障就是"激活时的默认"与"composer 显示的默认"
 * 两个值，用户看到的模型和实际跑的对不上。
 *
 * ⚠️ 只写**model id 本体**（不带 `clawrouter/` 前缀）：网关里的 ref 是两段，
 *    前缀由调用方按自己的上下文拼（见 relay-config.ts 的说明）。
 */
export const COMMERCIAL_DEFAULT_MODEL_ID = 'glm-5.3-flashx';

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
