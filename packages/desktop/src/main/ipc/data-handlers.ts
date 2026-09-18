import { BrowserWindow, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { and, eq, desc } from 'drizzle-orm';
import { getDb, isDbReady } from '../db/index.js';
import { tasks, messages, artifacts, taskRooms, taskRoomSessions, teams, teamAgents } from '../db/schema.js';
import { autoExtractArtifacts } from '../artifact/auto-extract.js';
import { captureTaskArtifactBaseline, reconcileTaskArtifacts, type ArtifactBaseline } from '../artifact/reconcile.js';
import type { MessageAttachment } from '@clawwork/shared';
import { getWorkspacePath } from '../workspace/config.js';
import { getGatewayClient } from '../ws/index.js';

function ipcError(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : 'unknown' };
}

function parseTeamAgentSkills(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [];
  } catch {
    return [];
  }
}

interface ArtifactRunContext {
  baseline?: Promise<ArtifactBaseline>;
  token: string;
  createdAt: number;
  sequence: number;
  expiryTimer: ReturnType<typeof setTimeout>;
  gatewayRunId?: string;
  state: 'active' | 'canceled' | 'claimed';
  taskId: string;
  sessionKey: string;
}

const artifactRuns = new Map<string, ArtifactRunContext[]>();
const claimedArtifactRuns = new Map<string, ArtifactRunContext>();
const desynchronizedArtifactSessions = new Set<string>();
const completedAssistantMessages = new Map<
  string,
  { state: 'inFlight' | 'completed'; touchedAt: number; sequence: number; taskId: string; sessionKey: string }
>();
const ARTIFACT_RUN_TTL_MS = 15 * 60 * 1000;
const MAX_ARTIFACT_RUNS = 128;
const COMPLETED_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_COMPLETED_MESSAGES = 2048;
let nextArtifactRunSequence = 0;
let nextCompletedMessageSequence = 0;

function artifactRunKey(taskId: string, sessionKey: string): string {
  return `${taskId}\0${sessionKey}`;
}

function hasRunningToolCall(toolCalls: unknown[] | undefined): boolean {
  return Boolean(
    toolCalls?.some(
      (value) =>
        value !== null &&
        typeof value === 'object' &&
        ['pending', 'running'].includes(String((value as { status?: unknown }).status ?? '')),
    ),
  );
}

export function beginArtifactRun(workspacePath: string, taskId: string, sessionKey: string): string {
  pruneArtifactRuns();
  pruneCompletedAssistantMessages();
  const token = randomUUID();
  const baseline = captureTaskArtifactBaseline({ workspacePath, taskId }).catch((error: unknown) => {
    console.error('[artifact_baseline_failed]', { taskId, error });
    throw error;
  });
  // Attach a rejection handler immediately. The final assistant write may never
  // arrive (cancel/disconnect), and an unobserved baseline rejection must not
  // become an unhandled process rejection.
  void baseline.catch(() => undefined);
  const key = artifactRunKey(taskId, sessionKey);
  if (desynchronizedArtifactSessions.has(key)) return token;
  while (artifactRunCount() >= MAX_ARTIFACT_RUNS) desynchronizeOldestArtifactSession();
  if (desynchronizedArtifactSessions.has(key)) return token;
  const expiryTimer = setTimeout(() => cancelArtifactRun(taskId, sessionKey, token), ARTIFACT_RUN_TTL_MS);
  expiryTimer.unref?.();
  const queue = artifactRuns.get(key) ?? [];
  queue.push({
    baseline,
    token,
    createdAt: Date.now(),
    sequence: nextArtifactRunSequence++,
    expiryTimer,
    state: 'active',
    taskId,
    sessionKey,
  });
  artifactRuns.set(key, queue);
  return token;
}

export function cancelArtifactRun(taskId: string, sessionKey: string, token: string): void {
  const key = artifactRunKey(taskId, sessionKey);
  const queue = artifactRuns.get(key);
  const index = queue?.findIndex((run) => run.token === token) ?? -1;
  if (!queue || index < 0) {
    const claimed = claimedArtifactRuns.get(token);
    if (claimed?.taskId === taskId && claimed.sessionKey === sessionKey) claimed.state = 'canceled';
    return;
  }
  const run = queue[index];
  run.state = 'canceled';
  run.baseline = undefined;
  clearTimeout(run.expiryTimer);
}

export function bindArtifactRun(taskId: string, sessionKey: string, token: string, gatewayRunId: string): void {
  if (!gatewayRunId) return;
  const run = artifactRuns.get(artifactRunKey(taskId, sessionKey))?.find((candidate) => candidate.token === token);
  if (run) run.gatewayRunId = gatewayRunId;
}

function claimArtifactRun(taskId: string, sessionKey: string, gatewayRunId?: string): ArtifactRunContext | undefined {
  const key = artifactRunKey(taskId, sessionKey);
  if (desynchronizedArtifactSessions.has(key)) return undefined;
  const queue = artifactRuns.get(key);
  const exactRunIndex = gatewayRunId
    ? (queue?.findIndex((candidate) => candidate.gatewayRunId === gatewayRunId) ?? -1)
    : -1;
  const index = gatewayRunId
    ? exactRunIndex >= 0
      ? exactRunIndex
      : (queue?.findIndex((candidate) => candidate.state === 'canceled' && !candidate.gatewayRunId) ?? -1)
    : queue?.length
      ? 0
      : -1;
  // A terminal carrying a run id only falls back to an unbound canceled
  // tombstone. That is the timeout/uncertain-send case: it preserves the FIFO
  // hole without ever assigning an active baseline to an unrelated run id.
  const run = index >= 0 ? queue?.splice(index, 1)[0] : undefined;
  if (!run || !queue) return undefined;
  clearTimeout(run.expiryTimer);
  if (queue.length === 0) artifactRuns.delete(key);
  if (run.state === 'active') run.state = 'claimed';
  claimedArtifactRuns.set(run.token, run);
  return run;
}

function artifactRunCount(): number {
  let count = claimedArtifactRuns.size;
  for (const queue of artifactRuns.values()) count += queue.length;
  return count;
}

function markArtifactSessionDesynchronized(key: string): void {
  const queue = artifactRuns.get(key) ?? [];
  for (const run of queue) clearTimeout(run.expiryTimer);
  artifactRuns.delete(key);
  for (const [token, run] of claimedArtifactRuns) {
    if (artifactRunKey(run.taskId, run.sessionKey) !== key) continue;
    run.state = 'canceled';
    claimedArtifactRuns.delete(token);
  }
  desynchronizedArtifactSessions.add(key);
}

function desynchronizeOldestArtifactSession(): void {
  let oldest: { key: string; run: ArtifactRunContext } | null = null;
  for (const [key, queue] of artifactRuns) {
    for (const run of queue) {
      if (!oldest || run.sequence < oldest.run.sequence) oldest = { key, run };
    }
  }
  for (const run of claimedArtifactRuns.values()) {
    const key = artifactRunKey(run.taskId, run.sessionKey);
    if (!oldest || run.sequence < oldest.run.sequence) oldest = { key, run };
  }
  if (!oldest) return;
  markArtifactSessionDesynchronized(oldest.key);
}

function pruneArtifactRuns(now = Date.now()): void {
  for (const [key, queue] of artifactRuns) {
    for (const run of [...queue]) {
      if (now - run.createdAt < ARTIFACT_RUN_TTL_MS) continue;
      const separator = key.indexOf('\0');
      cancelArtifactRun(key.slice(0, separator), key.slice(separator + 1), run.token);
    }
  }
}

function completedMessageKey(taskId: string, messageId: string): string {
  return `${taskId}\0${messageId}`;
}

function isArtifactRunCanceled(run: ArtifactRunContext): boolean {
  return run.state === 'canceled';
}

function pruneCompletedAssistantMessages(now = Date.now()): void {
  for (const [key, value] of completedAssistantMessages) {
    if (value.state === 'completed' && now - value.touchedAt >= COMPLETED_MESSAGE_TTL_MS) {
      completedAssistantMessages.delete(key);
      markArtifactSessionDesynchronized(artifactRunKey(value.taskId, value.sessionKey));
    }
  }
  if (completedAssistantMessages.size < MAX_COMPLETED_MESSAGES) return;
  const completed = [...completedAssistantMessages.entries()]
    .filter(([, value]) => value.state === 'completed')
    .sort((a, b) => a[1].sequence - b[1].sequence);
  while (completedAssistantMessages.size >= MAX_COMPLETED_MESSAGES && completed.length > 0) {
    const [key, value] = completed.shift()!;
    completedAssistantMessages.delete(key);
    markArtifactSessionDesynchronized(artifactRunKey(value.taskId, value.sessionKey));
  }
}

export function cancelArtifactRunsForSession(sessionKey: string): void {
  for (const [key, queue] of artifactRuns) {
    if (!key.endsWith(`\0${sessionKey}`)) continue;
    for (const run of queue) clearTimeout(run.expiryTimer);
    artifactRuns.delete(key);
  }
  for (const run of claimedArtifactRuns.values()) {
    if (run.sessionKey === sessionKey) run.state = 'canceled';
  }
  for (const key of desynchronizedArtifactSessions) {
    if (key.endsWith(`\0${sessionKey}`)) desynchronizedArtifactSessions.delete(key);
  }
  for (const [key, value] of completedAssistantMessages) {
    if (value.sessionKey === sessionKey) completedAssistantMessages.delete(key);
  }
}

export function cancelArtifactRunsForTask(taskId: string): void {
  for (const [key, queue] of artifactRuns) {
    if (!key.startsWith(`${taskId}\0`)) continue;
    for (const run of queue) clearTimeout(run.expiryTimer);
    artifactRuns.delete(key);
  }
  for (const run of claimedArtifactRuns.values()) {
    if (run.taskId === taskId) run.state = 'canceled';
  }
  for (const key of desynchronizedArtifactSessions) {
    if (key.startsWith(`${taskId}\0`)) desynchronizedArtifactSessions.delete(key);
  }
  for (const [key, value] of completedAssistantMessages) {
    if (value.taskId === taskId) completedAssistantMessages.delete(key);
  }
}

export function beginArtifactRunForGatewayDispatch(input: {
  gatewayId: string;
  sessionKey: string;
  taskId: string;
}): string | null {
  if (!isDbReady()) return null;
  const task = getDb()
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, input.taskId), eq(tasks.gatewayId, input.gatewayId)))
    .get();
  const workspacePath = getWorkspacePath();
  if (!task || !workspacePath) return null;
  return beginArtifactRun(workspacePath, input.taskId, input.sessionKey);
}

function finalizeAssistantArtifacts(input: {
  workspacePath: string;
  taskId: string;
  sessionKey: string;
  messageId: string;
  runId?: string;
  content: string;
  attachments?: MessageAttachment[];
  gatewayHttpBase?: string;
}): void {
  pruneCompletedAssistantMessages();
  const messageKey = completedMessageKey(input.taskId, input.messageId);
  if (completedAssistantMessages.has(messageKey)) return;
  completedAssistantMessages.set(messageKey, {
    state: 'inFlight',
    touchedAt: Date.now(),
    sequence: nextCompletedMessageSequence++,
    taskId: input.taskId,
    sessionKey: input.sessionKey,
  });
  const run = claimArtifactRun(input.taskId, input.sessionKey, input.runId);
  if (!run) {
    completedAssistantMessages.set(messageKey, {
      state: 'completed',
      touchedAt: Date.now(),
      sequence: nextCompletedMessageSequence++,
      taskId: input.taskId,
      sessionKey: input.sessionKey,
    });
    return;
  }
  void (async () => {
    try {
      await autoExtractArtifacts({
        workspacePath: input.workspacePath,
        taskId: input.taskId,
        messageId: input.messageId,
        content: input.content,
        attachments: input.attachments,
        gatewayHttpBase: input.gatewayHttpBase,
      });
    } catch (error) {
      console.error('[auto-extract]', error);
    }
    try {
      if (isArtifactRunCanceled(run) || !run.baseline) return;
      const baseline = await run.baseline;
      if (isArtifactRunCanceled(run)) return;
      const result = await reconcileTaskArtifacts({
        workspacePath: input.workspacePath,
        taskId: input.taskId,
        messageId: input.messageId,
        baseline,
      });
      for (const artifact of result.saved) {
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send('artifact:saved', artifact);
      }
    } catch (error) {
      console.error('[artifact_reconcile_failed]', { taskId: input.taskId, messageId: input.messageId, error });
    } finally {
      claimedArtifactRuns.delete(run.token);
      completedAssistantMessages.set(messageKey, {
        state: 'completed',
        touchedAt: Date.now(),
        sequence: nextCompletedMessageSequence++,
        taskId: input.taskId,
        sessionKey: input.sessionKey,
      });
      pruneCompletedAssistantMessages();
    }
  })();
}

export function registerDataHandlers(): void {
  ipcMain.handle(
    'data:create-task',
    (
      _event,
      task: {
        id: string;
        sessionKey: string;
        sessionId: string;
        title: string;
        status: string;
        ensemble?: boolean;
        model?: string;
        modelProvider?: string;
        thinkingLevel?: string;
        inputTokens?: number;
        outputTokens?: number;
        contextTokens?: number;
        teamId?: string;
        createdAt: string;
        updatedAt: string;
        tags: string[];
        artifactDir: string;
        gatewayId: string;
      },
    ) => {
      if (!isDbReady()) return ipcError(new Error('database not ready'));
      try {
        const db = getDb();
        db.insert(tasks)
          .values({
            id: task.id,
            sessionKey: task.sessionKey,
            sessionId: task.sessionId,
            title: task.title,
            status: task.status,
            ensemble: task.ensemble ?? false,
            model: task.model,
            modelProvider: task.modelProvider,
            thinkingLevel: task.thinkingLevel,
            inputTokens: task.inputTokens,
            outputTokens: task.outputTokens,
            contextTokens: task.contextTokens,
            teamId: task.teamId ?? null,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            tags: JSON.stringify(task.tags),
            artifactDir: task.artifactDir,
            gatewayId: task.gatewayId,
          })
          .run();
        return { ok: true };
      } catch (err) {
        console.error('[data] create-task failed:', err);
        return ipcError(err);
      }
    },
  );

  ipcMain.handle(
    'data:update-task',
    (
      _event,
      params: {
        id: string;
        title?: string;
        status?: string;
        ensemble?: boolean;
        model?: string;
        modelProvider?: string;
        thinkingLevel?: string;
        inputTokens?: number;
        outputTokens?: number;
        contextTokens?: number;
        teamId?: string | null;
        /**
         * 改任务的会话指针（多模型对比采纳后指到赢的那条会话）。
         * ⚠️ 只改**指针**：这条会话在网关侧本来就在，不新建也不删。
         */
        sessionKey?: string;
        updatedAt: string;
      },
    ) => {
      if (!isDbReady()) return ipcError(new Error('database not ready'));
      try {
        const db = getDb();
        const updates: Record<string, string | number | boolean | null | undefined> = { updatedAt: params.updatedAt };
        if (params.title !== undefined) updates.title = params.title;
        if (params.status !== undefined) updates.status = params.status;
        if (params.ensemble !== undefined) updates.ensemble = params.ensemble;
        if (params.model !== undefined) updates.model = params.model;
        if (params.modelProvider !== undefined) updates.modelProvider = params.modelProvider;
        if (params.thinkingLevel !== undefined) updates.thinkingLevel = params.thinkingLevel;
        if (params.inputTokens !== undefined) updates.inputTokens = params.inputTokens;
        if (params.outputTokens !== undefined) updates.outputTokens = params.outputTokens;
        if (params.contextTokens !== undefined) updates.contextTokens = params.contextTokens;
        if (params.teamId !== undefined) updates.teamId = params.teamId;
        if (params.sessionKey !== undefined) updates.sessionKey = params.sessionKey;
        db.update(tasks).set(updates).where(eq(tasks.id, params.id)).run();
        return { ok: true };
      } catch (err) {
        console.error('[data] update-task failed:', err);
        return ipcError(err);
      }
    },
  );

  ipcMain.handle(
    'data:create-message',
    (
      _event,
      msg: {
        id: string;
        taskId: string;
        role: string;
        content: string;
        timestamp: string;
        sessionKey?: string;
        agentId?: string;
        runId?: string;
        attachments?: unknown[];
        toolCalls?: unknown[];
        thinkingContent?: string;
        model?: string;
      },
    ) => {
      if (!isDbReady()) return ipcError(new Error('database not ready'));
      try {
        const db = getDb();
        let resolvedSessionKey = msg.sessionKey;
        if (!resolvedSessionKey) {
          const task = db.select({ sk: tasks.sessionKey }).from(tasks).where(eq(tasks.id, msg.taskId)).get();
          resolvedSessionKey = task?.sk ?? '';
        }
        db.insert(messages)
          .values({
            id: msg.id,
            taskId: msg.taskId,
            role: msg.role,
            content: msg.content,
            timestamp: msg.timestamp,
            sessionKey: resolvedSessionKey,
            agentId: msg.agentId ?? null,
            runId: msg.runId ?? null,
            attachments: msg.attachments?.length ? JSON.stringify(msg.attachments) : null,
            toolCalls: msg.toolCalls?.length ? JSON.stringify(msg.toolCalls) : null,
            thinkingContent: msg.thinkingContent ?? null,
            model: msg.model ?? null,
          })
          .onConflictDoUpdate({
            target: [messages.taskId, messages.sessionKey, messages.role, messages.timestamp],
            set: {
              content: msg.content,
              agentId: msg.agentId ?? null,
              runId: msg.runId ?? null,
              attachments: msg.attachments?.length ? JSON.stringify(msg.attachments) : null,
              toolCalls: msg.toolCalls?.length ? JSON.stringify(msg.toolCalls) : null,
              // ⚠️ 故意「有空才覆盖」而不是 `?? null`：工具调用等中途落库若不带思考，
              // 不该把已经存下来的推理抹掉（其它字段没这个问题 —— 它们是同一个值的更新）。
              ...(msg.thinkingContent ? { thinkingContent: msg.thinkingContent } : {}),
              // 同上：模型只在**这条写入自己带**的时候覆盖。工具调用/推理那些中途
              // upsert 拿不到它，写成 `?? null` 会把已落库的模型抹掉，重载后徽章消失。
              ...(msg.model ? { model: msg.model } : {}),
            },
          })
          .run();
        const persisted = db
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.taskId, msg.taskId),
              eq(messages.sessionKey, resolvedSessionKey),
              eq(messages.role, msg.role),
              eq(messages.timestamp, msg.timestamp),
            ),
          )
          .get();
        const persistedMessageId = persisted?.id ?? msg.id;
        const workspacePath = getWorkspacePath();
        if (
          workspacePath &&
          msg.role === 'assistant' &&
          !hasRunningToolCall(msg.toolCalls) &&
          (msg.content.length > 0 || (msg.attachments?.length ?? 0) > 0 || (msg.toolCalls?.length ?? 0) > 0)
        ) {
          const run = artifactRuns.get(artifactRunKey(msg.taskId, resolvedSessionKey));
          if (run) {
            const taskRow = db.select({ gid: tasks.gatewayId }).from(tasks).where(eq(tasks.id, msg.taskId)).get();
            const gatewayHttpBase = taskRow ? getGatewayClient(taskRow.gid)?.httpBase : undefined;
            finalizeAssistantArtifacts({
              workspacePath,
              taskId: msg.taskId,
              sessionKey: resolvedSessionKey,
              messageId: persistedMessageId,
              runId: msg.runId,
              content: msg.content,
              attachments: msg.attachments as MessageAttachment[] | undefined,
              gatewayHttpBase,
            });
          } else {
            // Legacy/history hydration still needs attachment and fenced-code
            // extraction. Reconciliation deliberately fails closed without a
            // trusted user-turn baseline so old workspace files are not claimed.
            autoExtractArtifacts({
              workspacePath,
              taskId: msg.taskId,
              messageId: persistedMessageId,
              content: msg.content,
              attachments: msg.attachments as MessageAttachment[] | undefined,
            }).catch((err: unknown) => console.error('[auto-extract]', err));
          }
        }
        return { ok: true };
      } catch (err) {
        console.error('[data] create-message failed:', err);
        return ipcError(err);
      }
    },
  );

  ipcMain.handle('data:delete-task', (_event, params: { id: string }) => {
    cancelArtifactRunsForTask(params.id);
    if (!isDbReady()) return ipcError(new Error('database not ready'));
    try {
      const db = getDb();
      db.delete(taskRoomSessions).where(eq(taskRoomSessions.taskId, params.id)).run();
      db.delete(taskRooms).where(eq(taskRooms.taskId, params.id)).run();
      db.delete(artifacts).where(eq(artifacts.taskId, params.id)).run();
      db.delete(messages).where(eq(messages.taskId, params.id)).run();
      db.delete(tasks).where(eq(tasks.id, params.id)).run();
      return { ok: true };
    } catch (err) {
      console.error('[data] delete-task failed:', err);
      return ipcError(err);
    }
  });

  ipcMain.handle('data:list-tasks', () => {
    if (!isDbReady()) return { ok: true, rows: [] };
    try {
      const db = getDb();
      const rows = db.select().from(tasks).orderBy(desc(tasks.createdAt)).all();
      return {
        ok: true,
        rows: rows.map((r) => {
          let tags: string[] = [];
          try {
            tags = JSON.parse(r.tags as string);
          } catch {}
          return { ...r, tags };
        }),
      };
    } catch (err) {
      console.error('[data] list-tasks failed:', err);
      return ipcError(err);
    }
  });

  ipcMain.handle('data:list-messages', (_event, params: { taskId: string }) => {
    if (!isDbReady()) return { ok: true, rows: [] };
    try {
      const db = getDb();
      const rows = db
        .select()
        .from(messages)
        .where(eq(messages.taskId, params.taskId))
        .orderBy(messages.timestamp)
        .all();
      return {
        ok: true,
        rows: rows.map((r) => {
          let attachments: unknown[] | undefined;
          let toolCalls: unknown[] | undefined;
          if (r.attachments) {
            try {
              attachments = JSON.parse(r.attachments as string);
            } catch {}
          }
          if (r.toolCalls) {
            try {
              toolCalls = JSON.parse(r.toolCalls as string);
            } catch {}
          }
          return { ...r, attachments, toolCalls };
        }),
      };
    } catch (err) {
      console.error('[data] list-messages failed:', err);
      return ipcError(err);
    }
  });

  ipcMain.handle(
    'data:persist-room',
    (
      _event,
      params: {
        taskId: string;
        status: string;
        conductorReady: boolean;
      },
    ) => {
      if (!isDbReady()) return ipcError(new Error('database not ready'));
      try {
        const db = getDb();
        db.insert(taskRooms)
          .values({
            taskId: params.taskId,
            status: params.status,
            conductorReady: params.conductorReady,
          })
          .onConflictDoUpdate({
            target: [taskRooms.taskId],
            set: {
              status: params.status,
              conductorReady: params.conductorReady,
            },
          })
          .run();
        return { ok: true };
      } catch (err) {
        console.error('[data] persist-room failed:', err);
        return ipcError(err);
      }
    },
  );

  ipcMain.handle('data:load-room', (_event, params: { taskId: string }) => {
    if (!isDbReady()) return { ok: true, room: null, performers: [] };
    try {
      const db = getDb();
      const room = db.select().from(taskRooms).where(eq(taskRooms.taskId, params.taskId)).get();
      const performers = db.select().from(taskRoomSessions).where(eq(taskRoomSessions.taskId, params.taskId)).all();
      return { ok: true, room: room ?? null, performers };
    } catch (err) {
      console.error('[data] load-room failed:', err);
      return ipcError(err);
    }
  });

  ipcMain.handle(
    'data:persist-performer',
    (
      _event,
      params: {
        taskId: string;
        sessionKey: string;
        agentId: string;
        agentName: string;
        emoji?: string;
        verifiedAt: string;
      },
    ) => {
      if (!isDbReady()) return ipcError(new Error('database not ready'));
      try {
        const db = getDb();
        db.insert(taskRoomSessions)
          .values({
            sessionKey: params.sessionKey,
            taskId: params.taskId,
            agentId: params.agentId,
            agentName: params.agentName,
            emoji: params.emoji ?? null,
            verifiedAt: params.verifiedAt,
          })
          .onConflictDoUpdate({
            target: [taskRoomSessions.sessionKey],
            set: {
              agentId: params.agentId,
              agentName: params.agentName,
              emoji: params.emoji ?? null,
              verifiedAt: params.verifiedAt,
            },
          })
          .run();
        return { ok: true };
      } catch (err) {
        console.error('[data] persist-performer failed:', err);
        return ipcError(err);
      }
    },
  );

  ipcMain.handle('data:delete-room', (_event, params: { taskId: string }) => {
    if (!isDbReady()) return ipcError(new Error('database not ready'));
    try {
      const db = getDb();
      db.delete(taskRoomSessions).where(eq(taskRoomSessions.taskId, params.taskId)).run();
      db.delete(taskRooms).where(eq(taskRooms.taskId, params.taskId)).run();
      return { ok: true };
    } catch (err) {
      console.error('[data] delete-room failed:', err);
      return ipcError(err);
    }
  });

  ipcMain.handle('data:teams-list', () => {
    if (!isDbReady()) return { ok: true, result: [] };
    try {
      const db = getDb();
      const rows = db.select().from(teams).orderBy(desc(teams.createdAt)).all();
      const agentRows = db.select().from(teamAgents).all();
      const agentsByTeam = new Map<
        string,
        Array<{ agentId: string; role: string | null; isManager: boolean | null; skillsJson: string | null }>
      >();
      for (const a of agentRows) {
        let list = agentsByTeam.get(a.teamId);
        if (!list) {
          list = [];
          agentsByTeam.set(a.teamId, list);
        }
        list.push({ agentId: a.agentId, role: a.role, isManager: a.isManager, skillsJson: a.skillsJson });
      }
      return {
        ok: true,
        result: rows.map((r) => ({
          ...r,
          agents: (agentsByTeam.get(r.id) ?? []).map((a) => ({
            agentId: a.agentId,
            role: a.role ?? '',
            isManager: a.isManager ?? false,
            skills: parseTeamAgentSkills(a.skillsJson),
          })),
        })),
      };
    } catch (err) {
      console.error('[data] teams-list failed:', err);
      return ipcError(err);
    }
  });

  ipcMain.handle('data:team-get', (_event, params: { id: string }) => {
    if (!isDbReady()) return ipcError(new Error('database not ready'));
    try {
      const db = getDb();
      const row = db.select().from(teams).where(eq(teams.id, params.id)).get();
      if (!row) return { ok: true, result: null };
      const agents = db
        .select()
        .from(teamAgents)
        .where(eq(teamAgents.teamId, params.id))
        .all()
        .map((a) => ({
          agentId: a.agentId,
          role: a.role ?? '',
          isManager: a.isManager ?? false,
          skills: parseTeamAgentSkills(a.skillsJson),
        }));
      return { ok: true, result: { ...row, agents } };
    } catch (err) {
      console.error('[data] team-get failed:', err);
      return ipcError(err);
    }
  });

  ipcMain.handle(
    'data:team-persist',
    (
      _event,
      params: {
        id: string;
        name: string;
        emoji?: string;
        description?: string;
        gatewayId: string;
        source?: string;
        version?: string;
        hubSlug?: string;
        agents: Array<{ agentId: string; role?: string; isManager?: boolean; skills?: string[] }>;
        createdAt: string;
        updatedAt: string;
      },
    ) => {
      if (!isDbReady()) return ipcError(new Error('database not ready'));
      try {
        const db = getDb();
        db.transaction((tx) => {
          tx.insert(teams)
            .values({
              id: params.id,
              name: params.name,
              emoji: params.emoji ?? '',
              description: params.description ?? '',
              gatewayId: params.gatewayId,
              source: params.source ?? 'local',
              version: params.version ?? '',
              hubSlug: params.hubSlug ?? '',
              createdAt: params.createdAt,
              updatedAt: params.updatedAt,
            })
            .onConflictDoUpdate({
              target: [teams.id],
              set: {
                name: params.name,
                emoji: params.emoji ?? '',
                description: params.description ?? '',
                gatewayId: params.gatewayId,
                source: params.source ?? 'local',
                version: params.version ?? '',
                hubSlug: params.hubSlug ?? '',
                updatedAt: params.updatedAt,
              },
            })
            .run();
          tx.delete(teamAgents).where(eq(teamAgents.teamId, params.id)).run();
          for (const agent of params.agents) {
            tx.insert(teamAgents)
              .values({
                teamId: params.id,
                agentId: agent.agentId,
                role: agent.role ?? '',
                isManager: agent.isManager ?? false,
                skillsJson: JSON.stringify(agent.skills ?? []),
              })
              .run();
          }
        });
        return { ok: true };
      } catch (err) {
        console.error('[data] team-persist failed:', err);
        return ipcError(err);
      }
    },
  );

  ipcMain.handle('data:team-delete', (_event, params: { id: string }) => {
    if (!isDbReady()) return ipcError(new Error('database not ready'));
    try {
      const db = getDb();
      db.transaction((tx) => {
        tx.delete(teamAgents).where(eq(teamAgents.teamId, params.id)).run();
        tx.delete(teams).where(eq(teams.id, params.id)).run();
      });
      return { ok: true };
    } catch (err) {
      console.error('[data] team-delete failed:', err);
      return ipcError(err);
    }
  });
}
