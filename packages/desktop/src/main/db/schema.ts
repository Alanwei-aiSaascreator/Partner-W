import { sql } from 'drizzle-orm';
import { check, sqliteTable, text, integer, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  sessionKey: text('session_key').notNull(),
  sessionId: text('session_id').notNull().default(''),
  title: text('title').notNull().default(''),
  status: text('status').notNull().default('active'),
  ensemble: integer('ensemble', { mode: 'boolean' }).notNull().default(false),
  /**
   * 任务模式（`fast` / `smart` / `deep` / `custom`）。
   * ⚠️ NULL = **没有偏好**（老行；按 custom 处理，不劫持既有 `model`）；不 backfill。
   *    见 `@clawwork/shared` 的 `task-modes.ts`。
   */
  mode: text('mode'),
  model: text('model'),
  modelProvider: text('model_provider'),
  thinkingLevel: text('thinking_level'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  contextTokens: integer('context_tokens'),
  teamId: text('team_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  tags: text('tags').notNull().default('[]'),
  /** 置顶时间（ISO）；NULL = 未置顶。见 `@clawwork/shared` 的 `Task.pinnedAt`。 */
  pinnedAt: text('pinned_at'),
  /**
   * deck 路由标记（演示文稿 → DeepSeek 的粘性开关）。
   * 老行 = 0（没标记过）；语义见 `@clawwork/shared` 的 `Task.deckRouted`。
   */
  deckRouted: integer('deck_routed', { mode: 'boolean' }).notNull().default(false),
  artifactDir: text('artifact_dir').notNull().default(''),
  gatewayId: text('gateway_id').notNull().default(''),
});

export const taskContextSources = sqliteTable(
  'task_context_sources',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['folder'] }).notNull(),
    absolutePath: text('absolute_path').notNull(),
    displayName: text('display_name').notNull(),
    createdAt: text('created_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
  },
  (table) => [
    uniqueIndex('task_context_sources_task_path').on(table.taskId, table.absolutePath),
    check('task_context_sources_kind_check', sql`${table.kind} = 'folder'`),
  ],
);

export const teamMeetings = sqliteTable('team_meetings', {
  id: text('id').primaryKey(),
  ownerTaskId: text('owner_task_id').notNull().unique(),
  revision: integer('revision').notNull(),
  recordJson: text('record_json').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const artifactDeliveryActivities = sqliteTable('artifact_delivery_activities', {
  operationId: text('operation_id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  sessionKey: text('session_key').notNull(),
  ownerUserId: text('owner_user_id'),
  ownerOrgId: text('owner_org_id'),
  ownerLicenseId: text('owner_license_id'),
  endedAt: integer('ended_at').notNull(),
  recordJson: text('record_json').notNull(),
  artifactRefsJson: text('artifact_refs_json').notNull().default('[]'),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id),
  role: text('role').notNull(),
  content: text('content').notNull(),
  timestamp: text('timestamp').notNull(),
  sessionKey: text('session_key'),
  agentId: text('agent_id'),
  runId: text('run_id'),
  attachments: text('image_attachments'),
  toolCalls: text('tool_calls'),
  thinkingContent: text('thinking_content'),
  model: text('model'),
  /**
   * 整轮用时（用户发出 → 本轮定稿），毫秒。
   * ⚠️ 不是网关的 message.durationMs（单条消息生成时间）；契约见 `Message.durationMs`。
   */
  durationMs: integer('duration_ms'),
  /**
   * 交付成功的最小持久化标记（r7-1 / BUG-026 跨重开残余）。
   * NULL = 老行 / 还没有可信成功结算；语义见 `@clawwork/shared` 的 `Message.deliverySucceeded`。
   */
  deliverySucceeded: integer('delivery_succeeded', { mode: 'boolean' }),
  deliveryFailureClosed: integer('delivery_failure_closed', { mode: 'boolean' }),
});

export const taskRooms = sqliteTable('task_rooms', {
  taskId: text('task_id')
    .primaryKey()
    .references(() => tasks.id),
  status: text('status').notNull().default('active'),
  conductorReady: integer('conductor_ready', { mode: 'boolean' }).notNull().default(false),
});

export const taskRoomSessions = sqliteTable('task_room_sessions', {
  sessionKey: text('session_key').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id),
  agentId: text('agent_id').notNull(),
  agentName: text('agent_name').notNull().default(''),
  emoji: text('emoji'),
  verifiedAt: text('verified_at').notNull(),
});

export const teams = sqliteTable('teams', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  emoji: text('emoji').default(''),
  description: text('description').default(''),
  gatewayId: text('gateway_id').notNull(),
  source: text('source').default('local'),
  version: text('version').default(''),
  hubSlug: text('hub_slug').default(''),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const teamAgents = sqliteTable(
  'team_agents',
  {
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id),
    agentId: text('agent_id').notNull(),
    role: text('role').default(''),
    isManager: integer('is_manager', { mode: 'boolean' }).default(false),
    skillsJson: text('skills_json').default('[]'),
    // 讨论职位（圆桌用）。与 role 是两回事，理由见 shared/src/types.ts 的注释。
    // 老行没有值 ⇒ 空串，读的时候由 normalizePosition 兜底成 'expert'。
    position: text('position').default(''),
  },
  (table) => [primaryKey({ columns: [table.teamId, table.agentId] })],
);

/**
 * 长期记忆条目 / 草案（2026-10-16）。DDL 真源是 `main/memory/schema.ts`（与测试共用一句），
 * 这里只是把它声明给 drizzle —— 两者字段必须逐字一致。
 *
 * `ownerUserId` = 归属账号（`''` = 未登录匿名）。`dedupeKey` 上的唯一索引
 * `(owner_user_id, dedupe_key)` 是"同一件事只可能有一条"的落点。
 */
export const memoryEntries = sqliteTable('memory_entries', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull().default(''),
  text: text('text').notNull(),
  status: text('status').notNull(),
  source: text('source').notNull(),
  sourceTaskId: text('source_task_id'),
  sourceMessageId: text('source_message_id'),
  dedupeKey: text('dedupe_key').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  decidedAt: text('decided_at'),
});

export const artifacts = sqliteTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id),
    type: text('type').notNull().default('file'),
    name: text('name').notNull(),
    filePath: text('file_path').notNull(),
    localPath: text('local_path').notNull(),
    mimeType: text('mime_type').notNull().default(''),
    size: integer('size').notNull().default(0),
    sourceKey: text('source_key').notNull().default(''),
    contentText: text('content_text').notNull().default(''),
    /**
     * `localPath` 相对**哪个根**解析。见 `db/index.ts` 里那条迁移的说明。
     *
     * - `'workspace'`（默认，= 老行为）：应用工作区，`<appWorkspace>/<taskId>/…`
     * - `'agent'`：该任务所属**助手的工作区**（网关 `agents.entries.<id>.workspace`）
     */
    root: text('root').notNull().default('workspace'),
    createdAt: text('created_at').notNull(),
  },
  // ⚠️ 索引必须含 `root`，且**必须与 `db/index.ts` 里手写的那条逐字一致**：
  //    `local_path` 是相对某个根的，两个根下可以有同名文件。
  (table) => [uniqueIndex('artifacts_task_local_path').on(table.taskId, table.root, table.localPath)],
);
