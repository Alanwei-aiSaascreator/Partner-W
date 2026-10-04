import { sql } from 'drizzle-orm';
import { check, sqliteTable, text, integer, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  sessionKey: text('session_key').notNull(),
  sessionId: text('session_id').notNull().default(''),
  title: text('title').notNull().default(''),
  status: text('status').notNull().default('active'),
  ensemble: integer('ensemble', { mode: 'boolean' }).notNull().default(false),
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
