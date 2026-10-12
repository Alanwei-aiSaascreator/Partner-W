import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSessionKey } from '@clawwork/shared';
import { createSessionSync, type SessionSyncDeps } from '../src/services/session-sync.js';
import { createMessageStore } from '../src/stores/message-store.js';
import type { RawHistoryMessage } from '../src/protocol/types.js';

/**
 * ⚠️ DOCX-205 合同（2026-10-10，终审修订）：整轮终态证据的**源头**在 session-sync ——
 *    判据 = "历史末条 assistant：`stopReason==='stop'` 且 runId 存在"（不以正文非空为条件）；
 *    证据**按条归属**：只附在身份（runId + 时间戳）与这条末段吻合的那一条 canonical 上，
 *    同 run 的更早正文段一律不带 —— 一次 run 归一化成多段时，绝不许"最早一段"消费
 *    ArtifactRun（否则生成器拿到的是较早正文而不是最终交付，2026-10-10 终审实证）。
 *    所有同步链路消息仍打 `sync: true` 标记（主进程据此只认终态证据）。
 */

// ⚠️ 证据归属按 (runId, timestamp) 双匹配，而不是模块级 runId 白名单——
//    用例不再需要"每例独立 scope"来隔离窗口；仍保留独立 task/session 以贴合真实形态。
let scopeSeq = 0;
function harness(history: RawHistoryMessage[]) {
  const taskId = `task-${++scopeSeq}`;
  const sessionKey = buildSessionKey(taskId);
  const persist = vi.fn<SessionSyncDeps['persistence']['persistMessage']>().mockResolvedValue({ ok: true });
  const store = createMessageStore({ persistMessage: persist });
  const task = { id: taskId, gatewayId: 'gw-1', sessionKey };
  const sync = createSessionSync({
    persistence: { persistMessage: persist, loadMessages: async () => ({ ok: true, rows: [] }) },
    gateway: {
      chatHistory: async () => ({ ok: true, result: { messages: history } }),
      syncSessions: async () => ({ ok: true, discovered: [] }),
    },
    getTaskStore: () => ({
      tasks: [task],
      hydrate: async () => {},
      adoptTasks: () => {},
      updateTaskMetadata: () => {},
    }),
    getMessageStore: () => ({ ...store.getState(), setState: store.setState }),
  });
  return { sync, persist, store, taskId };
}

const assistantPayloads = (persist: ReturnType<typeof harness>['persist']): Array<Record<string, unknown>> =>
  persist.mock.calls.map(([message]) => message as unknown as Record<string, unknown>).filter(() => true);

describe('trusted terminal evidence tagging', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('attaches final evidence to the trusted stop run and marks every sync write', async () => {
    const h = harness([
      {
        role: 'assistant',
        timestamp: 1000,
        stopReason: 'stop',
        __openclaw: { runId: 'run-9' },
        content: [{ type: 'text', text: 'answer' }],
      },
    ]);
    await h.sync.syncSessionMessages(h.taskId);
    const writes = assistantPayloads(h.persist);
    expect(writes.length).toBeGreaterThan(0);
    const answer = writes.find((message) => message.role === 'assistant');
    expect(answer).toMatchObject({
      runId: 'run-9',
      sync: true,
      terminal: { kind: 'final', runId: 'run-9', stopReason: 'stop', source: 'history' },
    });
    vi.useRealTimers();
  });

  it('does not attach evidence when the last assistant raw has no stop reason, but still marks the write', async () => {
    const h = harness([
      {
        role: 'assistant',
        timestamp: 1000,
        stopReason: 'tool_calls',
        __openclaw: { runId: 'run-9' },
        content: [{ type: 'text', text: 'mid-turn snapshot' }],
      },
    ]);
    await h.sync.syncSessionMessages(h.taskId);
    const writes = assistantPayloads(h.persist);
    expect(writes.length).toBeGreaterThan(0);
    for (const message of writes) {
      expect(message).not.toHaveProperty('terminal');
      expect(message.sync).toBe(true);
    }
    vi.useRealTimers();
  });

  it('tags a tool-only stop raw with evidence (tool-only terminals are not starved)', async () => {
    const h = harness([
      {
        role: 'assistant',
        timestamp: 1000,
        stopReason: 'stop',
        __openclaw: { runId: 'run-9' },
        content: [{ type: 'tool_use', id: 'tool-1', name: 'read', arguments: {} }],
      },
    ]);
    await h.sync.syncSessionMessages(h.taskId);
    const writes = assistantPayloads(h.persist);
    for (const message of writes) {
      if (message.role !== 'assistant') continue;
      expect(message.sync).toBe(true);
      expect(message.terminal).toMatchObject({ kind: 'final', runId: 'run-9' });
    }
    vi.useRealTimers();
  });

  it('does not leak evidence into an unrelated later run', async () => {
    const h = harness([
      {
        role: 'assistant',
        timestamp: 1000,
        stopReason: 'stop',
        __openclaw: { runId: 'run-9' },
        content: [{ type: 'text', text: 'answer' }],
      },
    ]);
    await h.sync.syncSessionMessages(h.taskId);
    const first = assistantPayloads(h.persist).find((message) => message.role === 'assistant');
    expect(first?.terminal).toMatchObject({ runId: 'run-9' });
    // 消息 store 的 upsert 路径（正文/工具快照）随后落库：带 sync 标记、**永远不带**证据。
    h.persist.mockClear();
    h.store.getState().addMessage(h.taskId, 'assistant', 'later');
    const persisted = assistantPayloads(h.persist);
    expect(persisted.length).toBeGreaterThan(0);
    for (const payload of persisted) {
      expect(payload).not.toHaveProperty('terminal');
      expect(payload.sync).toBe(true);
    }
    vi.useRealTimers();
  });

  it('⭐ 同 run 多段归一化：证据只落**承载末条 stop 记录**的那一段，较早正文段绝不带', async () => {
    // 复刻 2026-10-10 终审实证的失败形状：同一 run 里先有一段可见正文（无 stop），
    // 随后另一条才是带 stop 的最终交付（含 docgen 围栏）。旧实现按 runId 广播证据，
    // 最早一段先消费了 ArtifactRun，生成器拿到"我先整理材料…"而不是最终 docgen。
    const h = harness([
      {
        role: 'assistant',
        timestamp: 1000,
        __openclaw: { runId: 'run-9' },
        content: [{ type: 'text', text: '我先整理材料，然后提交文档。' }],
      },
      {
        role: 'assistant',
        timestamp: 2000,
        stopReason: 'stop',
        __openclaw: { runId: 'run-9' },
        content: [{ type: 'text', text: '材料已整理完毕。\n\n```docgen\n{"kind":"docx","title":"验收文档"}\n```' }],
      },
    ]);
    await h.sync.syncSessionMessages(h.taskId);
    const writes = assistantPayloads(h.persist).filter((message) => message.role === 'assistant');
    expect(writes).toHaveLength(2);
    expect(writes[0], '较早正文段绝不带终态证据').not.toHaveProperty('terminal');
    expect(writes[1].terminal).toMatchObject({ kind: 'final', runId: 'run-9', stopReason: 'stop' });
    expect(String(writes[1].content)).toContain('docgen');
    for (const message of writes) expect(message.sync).toBe(true);
    vi.useRealTimers();
  });

  it('⭐ 持久化重试沿用同一 entry 的证据（入队时定死，不许重推断/升级/丢失）', async () => {
    const h = harness([
      {
        role: 'assistant',
        timestamp: 1000,
        stopReason: 'stop',
        __openclaw: { runId: 'run-9' },
        content: [{ type: 'text', text: 'answer' }],
      },
    ]);
    h.persist.mockResolvedValueOnce({ ok: false, error: 'transient-write-failure' });
    const pending = h.sync.syncSessionMessages(h.taskId);
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    expect(h.persist).toHaveBeenCalledTimes(2);
    for (const [message] of h.persist.mock.calls) {
      expect(message).toMatchObject({
        role: 'assistant',
        sync: true,
        terminal: { kind: 'final', runId: 'run-9', stopReason: 'stop', source: 'history' },
      });
    }
    vi.useRealTimers();
  });
});
