import { dialog } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { desc, sql } from 'drizzle-orm';
import { getDb, isDbReady } from '../db/index.js';
import { artifacts, messages, tasks } from '../db/schema.js';
import { readConfig } from '../workspace/config.js';
import type { AppConfig } from '../workspace/config.js';
import { getDebugLogger } from '../debug/index.js';

/**
 * 客户端本地数据（任务、会话、消息、成果索引、设置）—— 导出工单的**本地那一半**。
 * 另一半是服务端快照，由 `privacy-handlers.ts` 把两者合成**一个** JSON 落盘。
 *
 * ⚠️ 五条硬规矩：
 *   1. **不含任何密钥** —— `readConfig()` 返回的是**已解密**的配置（网关 token /
 *      密码 / 配对码 / license key / supabase anon key 全是明文），所以设置走
 *      **白名单逐字段挑选**，绝不整份 spread；外面再套一层键名脱敏兜底。
 *   2. 有**明确上限**（200 MB / 50 万条消息），超限**如实说明**，不静默截断
 *      （与"服务端快照超 5 MB 就转人工"同一条纪律：宁可不给，也不给一份
 *      看起来完整、其实缺斤少两的历史）。
 *   3. 读不出来就在 `notes` 里说明原因，**绝不假装成功**。
 *   4. 上限判断只有**一个口径**：`measureLocalBodies()`（测试用同一个函数打边界）。
 *   5. **超限要在读正文之前就判掉**（`measureMessages()` 的预检 + 分块读）：
 *      旧写法是"先全量读进内存、最后才 measure" —— 50 万条消息实测同步阻塞主进程
 *      约 10 秒、RSS 峰值 1.4 GB，而体积上限**一次都没来得及拦**。预检是
 *      `measureLocalBodies` 的**下界**（见 `measureMessages` 的注释），只可能提前
 *      触发、不可能漏触发，所以两个口径不会打架。
 */

export interface LocalExportLimits {
  /** 消息条数上限。 */
  maxMessages: number;
  /** 本地数据正文（任务/会话/消息/成果）的序列化字节上限。 */
  maxBytes: number;
}

export interface LocalExportCounts {
  tasks: number;
  sessions: number;
  messages: number;
  artifacts: number;
}

/** 会被上限拦下的四类正文。 */
export interface LocalExportBodies {
  tasks: unknown[];
  sessions: unknown[];
  messages: unknown[];
  artifacts: unknown[];
}

export interface LocalExport extends LocalExportBodies {
  settings: Record<string, unknown> | null;
  meta: {
    counts: LocalExportCounts;
    limits: LocalExportLimits;
    /** true = 有正文因为上限被省略（**计数仍然如实**）。 */
    truncated: boolean;
  };
  notes: string[];
}

/** 50 万条消息（设计 §6.2）。 */
export const MAX_MESSAGES = 500_000;
/** 200 MB（设计 §6.2）。 */
export const MAX_EXPORT_BYTES = 200 * 1024 * 1024;
/** 消息正文的分块大小：每读这么多行就让出一次事件循环（见 `readMessagesChunked`）。 */
export const MESSAGE_CHUNK_SIZE = 5_000;

/**
 * 本地正文的序列化字节数 —— 上限判断的**唯一**口径。
 * 导出成函数是为了让测试能用同一把尺子打边界（正好等于 / 少 1 字节）。
 */
export function measureLocalBodies(bodies: LocalExportBodies): number {
  return Buffer.byteLength(JSON.stringify(bodies), 'utf8');
}

/** 文本列在 SQLite 里是 JSON 字符串，照 `data-handlers.ts` 的做法解析回去。 */
function parseJsonColumns(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  for (const key of ['tags', 'attachments', 'toolCalls'] as const) {
    if (typeof out[key] === 'string') {
      try {
        out[key] = JSON.parse(out[key] as string);
      } catch {
        /* 坏 JSON 原样留着比丢掉好 */
      }
    }
  }
  return out;
}

/**
 * 会话索引。
 *
 * ⚠️ 本地库**没有独立的会话列表表** —— 产品不变量是"一个任务 = 一个 OpenClaw 会话"
 * （`docs/agent-rules/architecture.md`），会话身份就落在任务的
 * `session_key` / `session_id` 上。这里导出的是任务的会话身份投影，
 * **不编造**消息计数之类的滚动统计（那些在 `meta.counts` 与消息正文里都有）。
 *
 * 房间级的两张表（`task_room_sessions` 的成员 agent、`task_context_sources` 的
 * 上下文目录）**不在本次范围**：现在的导出是任务/会话/消息/成果四件套，
 * 房间协作数据留给后续工单版本（要加就得同时进 `meta.counts` 与上限判断）。
 */
function sessionIndexRow(task: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionKey: task.sessionKey,
    sessionId: task.sessionId,
    taskId: task.id,
    title: task.title,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/**
 * 键名脱敏：任何**键名**命中敏感词、或值是 `enc:` 密文的字段一律剔除。
 * 与 debug logger 的 `SECRET_KEY_RE` 同一套纪律，是白名单之外的**最后一道闸**
 * （命中一律写进 notes，不静默）。
 */
const SECRET_KEY_RE =
  /(token|password|secret|license|anon[_-]?key|api[_-]?key|pairing|credential|authorization|cookie)/i;

function stripSecretKeys(value: unknown, path: string, hits: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => stripSecretKeys(item, `${path}[${index}]`, hits));
  }
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    if (SECRET_KEY_RE.test(key) || (typeof child === 'string' && child.startsWith('enc:'))) {
      hits.push(childPath);
      continue;
    }
    out[key] = stripSecretKeys(child, childPath, hits);
  }
  return out;
}

/**
 * 配置里的数组字段：**形状坏掉时当作空数组**，并把这件事写进 notes。
 *
 * ⚠️ 配置文件是**用户能手改的**磁盘文件（`config.json`）。手改坏成
 *    `"gateways": {}` / `"gateways": "oops"` 时，`(config.gateways ?? []).map(...)`
 *    会抛 `TypeError: ... .map is not a function`，**整份导出**跟着失败
 *    —— 而用户要的恰恰是"把数据导出来"。所以坏形状降级成空数组 + 如实说明。
 *    非对象项（字符串/数字/null）同理跳过，重复的键当没看见。
 */
function asRecordArray(value: unknown, field: string, notes: string[]): Array<Record<string, unknown>> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    notes.push(`设置里的 ${field} 不是数组（配置可能被改坏），本次按空处理`);
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const item of value) {
    if (item && typeof item === 'object' && !Array.isArray(item)) out.push(item as Record<string, unknown>);
  }
  if (out.length !== value.length) {
    notes.push(`设置里的 ${field} 有 ${value.length - out.length} 项不是对象，本次已跳过`);
  }
  return out;
}

/**
 * 设置：**白名单**逐字段挑选。
 *
 * ⚠️ 别改成 `{ ...config }` —— 那份对象里的网关 token / 密码 / 配对码 /
 *    license key / supabase anon key 都是**解密后的明文**，spread 一次就是
 *    把密钥写进用户随手转发的 JSON。
 */
function redactSettings(config: AppConfig | null, notes: string[]): Record<string, unknown> | null {
  if (!config) return null;

  const picked = {
    workspacePath: config.workspacePath ?? null,
    theme: config.theme ?? null,
    density: config.density ?? null,
    language: config.language ?? null,
    sendShortcut: config.sendShortcut ?? null,
    trayEnabled: config.trayEnabled ?? null,
    leftNavShortcut: config.leftNavShortcut ?? null,
    rightPanelShortcut: config.rightPanelShortcut ?? null,
    zoomLevel: config.zoomLevel ?? null,
    devMode: config.devMode === true,
    updateChannel: config.updateChannel ?? null,
    deviceId: config.deviceId ?? null,
    voiceInput: { introSeen: config.voiceInput?.introSeen === true },
    quickLaunch: config.quickLaunch
      ? { enabled: config.quickLaunch.enabled === true, shortcut: config.quickLaunch.shortcut ?? '' }
      : null,
    notifications: config.notifications
      ? {
          taskComplete: config.notifications.taskComplete === true,
          approvalRequest: config.notifications.approvalRequest === true,
          gatewayDisconnect: config.notifications.gatewayDisconnect === true,
        }
      : null,
    teamHubRegistries: asRecordArray(config.teamHubRegistries, 'teamHubRegistries', notes).map((item) => ({
      id: item.id,
      url: item.url,
      isOfficial: item.isOfficial === true,
    })),
    // 网关只导出**非密钥**字段（token / password / pairingCode 一律不出现）
    gateways: asRecordArray(config.gateways, 'gateways', notes).map((gateway) => ({
      id: gateway.id,
      name: gateway.name,
      url: gateway.url,
      authMode: gateway.authMode ?? null,
      tlsVerify: gateway.tlsVerify ?? null,
      isDefault: gateway.isDefault === true,
      color: gateway.color ?? null,
    })),
    // 激活状态只导出**布尔**：卡密本身是密钥
    commercial: { activated: Boolean(config.commercial?.licenseKey) },
  };

  const hits: string[] = [];
  const safe = stripSecretKeys(picked, 'settings', hits) as Record<string, unknown>;
  if (hits.length > 0) {
    notes.push(`设置里按脱敏规则剔除了敏感字段：${hits.join('、')}`);
  }
  return safe;
}

/** 非有限数 / 负数 / undefined 一律当 0（脏的聚合值不许穿透成 NaN）。 */
function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

interface MessageStats {
  /** 消息总条数。 */
  count: number;
  /** 消息正文字节的**下界**近似（不是精确值，见下）。 */
  bytes: number;
}

/**
 * 消息的**预检**：条数 + 正文字节，一次 SQL 聚合拿到，**一行正文都不读**。
 *
 * ⚠️ 为什么要有它：上限必须在**把正文捞进内存之前**判掉。旧写法是"先全量
 *    `.all()` 读进内存、最后才 `measureLocalBodies`" —— 50 万条消息实测读 6.8 秒
 *    （RSS → 484 MB）、两次 stringify 5.5 秒、峰值 1.4 GB、**同步阻塞主进程约 10 秒**，
 *    而体积上限一次都没拦住。
 *
 * ⚠️ `bytes` 是**下界**，不是精确值 —— 精确值只有 `measureLocalBodies()` 能给：
 *    · SQLite 的 `length()` 对 TEXT 数的是**字符**，不是 UTF-8 字节（中文会被少算）；
 *    · JSON 序列化还要再叠上键名、引号、逗号等结构开销。
 *    既然是下界，"预检超限 ⇒ 真值一定超限"恒成立：这一跳只会**提前**退到
 *    "只导元数据"，不可能出现"预检说没事、精确尺子说超了"所以两个口径不打架
 *    （反向仍由 `measureLocalBodies` 兜底，它才是唯一口径）。
 */
function measureMessages(db: ReturnType<typeof getDb>): MessageStats {
  const rows = db
    .select({
      n: sql<number>`count(*)`,
      bytes: sql<number>`coalesce(sum(
        length(${messages.content})
        + length(coalesce(${messages.thinkingContent}, ''))
        + length(coalesce(${messages.attachments}, ''))
        + length(coalesce(${messages.toolCalls}, ''))
      ), 0)`,
    })
    .from(messages)
    .all() as Array<{ n: unknown; bytes: unknown }>;
  return { count: toCount(rows[0]?.n), bytes: toCount(rows[0]?.bytes) };
}

/**
 * 分块读消息正文 —— 每块 `MESSAGE_CHUNK_SIZE` 行，块与块之间 `await` 一次
 * （`setImmediate`）把事件循环让出去，导出期间主进程不会被长时间独占。
 *
 * ⚠️ 分页稳定靠 `orderBy(timestamp, id)`：`id` 是主键，是唯一的次序 tiebreak。
 *    缺了它，同毫秒的时间戳在块边界上会**重复或漏行**（导出结果就不再是
 *    "这批消息的一个排列"，而是带重影的）。
 */
async function readMessagesChunked(db: ReturnType<typeof getDb>, total: number): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; offset < total; offset += MESSAGE_CHUNK_SIZE) {
    const chunk = db
      .select()
      .from(messages)
      .orderBy(messages.timestamp, messages.id)
      .limit(MESSAGE_CHUNK_SIZE)
      .offset(offset)
      .all() as unknown as Record<string, unknown>[];
    if (chunk.length === 0) break;
    for (const row of chunk) rows.push(parseJsonColumns(row));
    // 最后一块读完就不用再让出一次（省一跳）
    if (offset + MESSAGE_CHUNK_SIZE < total) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  return rows;
}

export async function buildLocalExport(options: Partial<LocalExportLimits> = {}): Promise<LocalExport> {
  const limits: LocalExportLimits = {
    maxMessages: options.maxMessages ?? MAX_MESSAGES,
    maxBytes: options.maxBytes ?? MAX_EXPORT_BYTES,
  };
  const notes: string[] = [];
  const noBodies = (): LocalExportBodies => ({ tasks: [], sessions: [], messages: [], artifacts: [] });

  // 本地库没就绪：**如实说明**，绝不假装"导出成功但内容是空的"
  if (!isDbReady()) {
    return {
      ...noBodies(),
      settings: null,
      meta: {
        counts: { tasks: 0, sessions: 0, messages: 0, artifacts: 0 },
        limits,
        truncated: false,
      },
      notes: ['本地数据库未就绪，本次未包含本地数据'],
    };
  }

  const db = getDb();
  const taskRows = db
    .select()
    .from(tasks)
    .orderBy(desc(tasks.createdAt))
    .all()
    .map((row) => parseJsonColumns(row as unknown as Record<string, unknown>));
  const sessions = taskRows.map(sessionIndexRow);
  const artifactRows = db.select().from(artifacts).all() as unknown as Record<string, unknown>[];
  // 预检（计数 + 正文字节下界）：**这一行之后才决定要不要读正文**
  const stats = measureMessages(db);

  const counts: LocalExportCounts = {
    tasks: taskRows.length,
    sessions: sessions.length,
    messages: stats.count,
    artifacts: artifactRows.length,
  };

  let messageRows: Record<string, unknown>[] = [];
  let truncated = false;
  /** true = 正文整体退化成元数据（下面统一走同一条返回路径）。 */
  let metadataOnly = false;

  if (stats.count > limits.maxMessages) {
    // 超限 ⇒ 只导出计数与索引（**说出来**，不静默截断）
    truncated = true;
    notes.push(
      `本地消息共 ${stats.count} 条，超过上限 ${limits.maxMessages} 条：本次只导出计数与索引，不含消息正文（不是完整历史）`,
    );
  } else if (stats.bytes > limits.maxBytes) {
    // ⚠️ 体积预检：**下界**都超了 ⇒ 真值一定超 ⇒ 直接退到元数据，**绝不读正文**
    //    （这里就是"先捞后判"变成"先判后捞"的那一跳）
    truncated = true;
    metadataOnly = true;
    notes.push(
      `本地消息正文约 ${stats.bytes} 字节（下界估计），超过上限 ${limits.maxBytes} 字节：本次只导出计数与设置等元数据，不含任务/会话/消息/成果正文（不是完整历史）`,
    );
  } else if (stats.count > 0) {
    messageRows = await readMessagesChunked(db, stats.count);
  }

  const settings = redactSettings(readConfig(), notes);
  if (!settings) {
    notes.push('读不到本地设置（配置文件缺失或损坏），本次未包含设置');
  }

  if (metadataOnly) {
    // 正文整体退化成元数据：**计数 + 设置仍然带上**，只是不含正文
    return { ...noBodies(), settings, meta: { counts, limits, truncated }, notes };
  }

  const bodies: LocalExportBodies = {
    tasks: taskRows,
    sessions,
    messages: messageRows,
    artifacts: artifactRows,
  };
  const bytes = measureLocalBodies(bodies);

  if (bytes > limits.maxBytes) {
    // 正文整体退化成元数据：**计数 + 设置仍然带上**，只是不含正文
    truncated = true;
    notes.push(
      `本地数据体积 ${bytes} 字节，超过上限 ${limits.maxBytes} 字节：本次只导出计数与设置等元数据，不含任务/会话/消息/成果正文（不是完整历史）`,
    );
    return {
      ...noBodies(),
      settings,
      meta: { counts, limits, truncated },
      notes,
    };
  }

  return {
    tasks: taskRows,
    sessions,
    messages: messageRows,
    artifacts: artifactRows,
    settings,
    meta: { counts, limits, truncated },
    notes,
  };
}

/**
 * 建议文件名的日期戳 —— **本地日期**。
 *
 * ⚠️ 别用 `toISOString().slice(0, 10)`：那是 UTC。北京时间 00:00–08:00 之间，
 *    用户明明"今天"点导出，文件名却写着昨天（用户会以为导错了文件）。
 *    文件名是给人看的，就该用他日历上那天。
 */
export function localDateStamp(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * 落盘：系统保存对话框 + UTF-8 JSON。
 * 用户点取消不是错误，抛一个 `cancelled` 让 IPC 层如实回码（界面安静收场）。
 */
export async function saveExportFile(payload: unknown): Promise<string> {
  const suggested = join(process.env.USERPROFILE ?? process.cwd(), `rongying-mofang-export-${localDateStamp()}.json`);
  const picked = await dialog.showSaveDialog({
    defaultPath: suggested,
    // 不给 filter 时 Windows 会把它当"任意文件"，用户很容易存成没有后缀的东西
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (picked.canceled || !picked.filePath) throw new Error('cancelled');
  await writeFile(picked.filePath, JSON.stringify(payload, null, 2), 'utf8');
  getDebugLogger().info({ domain: 'privacy', event: 'privacy.export-saved' });
  return picked.filePath;
}
