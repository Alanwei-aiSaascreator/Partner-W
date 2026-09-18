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
 * ⚠️ 四条硬规矩：
 *   1. **不含任何密钥** —— `readConfig()` 返回的是**已解密**的配置（网关 token /
 *      密码 / 配对码 / license key / supabase anon key 全是明文），所以设置走
 *      **白名单逐字段挑选**，绝不整份 spread；外面再套一层键名脱敏兜底。
 *   2. 有**明确上限**（200 MB / 50 万条消息），超限**如实说明**，不静默截断
 *      （与"服务端快照超 5 MB 就转人工"同一条纪律：宁可不给，也不给一份
 *      看起来完整、其实缺斤少两的历史）。
 *   3. 读不出来就在 `notes` 里说明原因，**绝不假装成功**。
 *   4. 上限判断只有**一个口径**：`measureLocalBodies()`（测试用同一个函数打边界）。
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
 * ⚠️ 本地库**没有独立会话表** —— 产品不变量是"一个任务 = 一个 OpenClaw 会话"
 * （`docs/agent-rules/architecture.md`），会话身份就落在任务的
 * `session_key` / `session_id` 上。这里导出的是任务的会话身份投影，
 * **不编造**消息计数之类的滚动统计（那些在 `meta.counts` 与消息正文里都有）。
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
    teamHubRegistries: (config.teamHubRegistries ?? []).map((item) => ({
      id: item.id,
      url: item.url,
      isOfficial: item.isOfficial === true,
    })),
    // 网关只导出**非密钥**字段（token / password / pairingCode 一律不出现）
    gateways: (config.gateways ?? []).map((gateway) => ({
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

/** 消息总条数走 SQL 聚合：超限时**不把几十万行捞进内存再丢掉**。 */
function countMessages(db: ReturnType<typeof getDb>): number {
  const rows = db
    .select({ n: sql<number>`count(*)` })
    .from(messages)
    .all() as Array<{ n: unknown }>;
  const total = Number(rows[0]?.n ?? 0);
  return Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0;
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
  const totalMessages = countMessages(db);

  const counts: LocalExportCounts = {
    tasks: taskRows.length,
    sessions: sessions.length,
    messages: totalMessages,
    artifacts: artifactRows.length,
  };

  let messageRows: Record<string, unknown>[] = [];
  let truncated = false;

  if (totalMessages > limits.maxMessages) {
    // 超限 ⇒ 只导出计数与索引（**说出来**，不静默截断）
    truncated = true;
    notes.push(
      `本地消息共 ${totalMessages} 条，超过上限 ${limits.maxMessages} 条：本次只导出计数与索引，不含消息正文（不是完整历史）`,
    );
  } else if (totalMessages > 0) {
    messageRows = db
      .select()
      .from(messages)
      .orderBy(messages.timestamp)
      .all()
      .map((row) => parseJsonColumns(row as unknown as Record<string, unknown>));
  }

  const settings = redactSettings(readConfig(), notes);
  if (!settings) {
    notes.push('读不到本地设置（配置文件缺失或损坏），本次未包含设置');
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
 * 落盘：系统保存对话框 + UTF-8 JSON。
 * 用户点取消不是错误，抛一个 `cancelled` 让 IPC 层如实回码（界面安静收场）。
 */
export async function saveExportFile(payload: unknown): Promise<string> {
  const suggested = join(
    process.env.USERPROFILE ?? process.cwd(),
    `rongying-mofang-export-${new Date().toISOString().slice(0, 10)}.json`,
  );
  const picked = await dialog.showSaveDialog({ defaultPath: suggested });
  if (picked.canceled || !picked.filePath) throw new Error('cancelled');
  await writeFile(picked.filePath, JSON.stringify(payload, null, 2), 'utf8');
  getDebugLogger().info({ domain: 'privacy', event: 'privacy.export-saved' });
  return picked.filePath;
}
