// 对账路径上的**临时会话闸门**（多模型对比的一列）。
//
// 这是第一道闸（dispatcher 在 final 时不触发 sync）**之外**的第二道，
// 兜的是一条很隐蔽的旁路：对比列的会话键里嵌的是**真** taskId，
// 于是重连时的 `retrySyncPending` 会把它当成"这个任务有一条跑完但还没落库的回复"，
// 去 `chat.history` 把它 promote 进任务时间线 —— 用户没采纳的答案就自己冒出来了。
//
// 所以这里的重点不是"函数早返回了"，而是**网关调用有没有真的发生**（chatHistory 次数）。
import { describe, expect, it, vi } from 'vitest';
import { createMessageStore } from '../src/stores/message-store.js';
import { createSessionSync, type SessionSyncDeps } from '../src/services/session-sync.js';

const TASK_ID = 'task-1';
const GATEWAY_ID = 'gw-1';
const TASK_KEY = `agent:main:clawwork:dev-1:task:${TASK_ID}`;
/** 第 0 列：伪设备号，真 taskId 在里面。 */
const COMPARE_KEY = `agent:main:clawwork:compare-run-1-0:task:${TASK_ID}`;

/**
 * 网关侧的时间戳是 **epoch 毫秒的数字**（实测形状，见 `RawHistoryMessage.timestamp` /
 * `normalizeAssistantTurns` 里的 `toISOTimestamp`）。取「此刻 + 60 秒」是为了让
 * 「问题在前、答案在后」（T1 < T2）在一个进程里**确定**成立，不看墙钟。
 */
const GATEWAY_USER_TS = Date.now() + 55_000;
const GATEWAY_ASSISTANT_TS = Date.now() + 60_000;

interface Harness {
  sync: ReturnType<typeof createSessionSync>;
  messageStore: ReturnType<typeof createMessageStore>;
  chatHistory: ReturnType<typeof vi.fn>;
  persistMessage: ReturnType<typeof vi.fn>;
  ephemeral: Set<string>;
}

function makeHarness(opts: { withGate?: boolean } = {}): Harness {
  const ephemeral = new Set<string>([COMPARE_KEY]);
  const chatHistory = vi.fn(async () => ({
    ok: true,
    result: {
      // ⚠️ 形状照网关的来：assistant 的 content 是**内容块数组**（不是纯字符串），
      //    timestamp 是 **epoch 毫秒的数字**（不是 ISO 串）。
      //    给字符串会被 normalizeContentBlocks 当"零个块"，正文变成空串。
      messages: [
        { role: 'user', content: '问题', timestamp: GATEWAY_USER_TS },
        {
          role: 'assistant',
          content: [{ type: 'text', text: '网关历史里的答案' }],
          model: 'qwen-plus',
          timestamp: GATEWAY_ASSISTANT_TS,
        },
      ],
    },
  }));
  const persistMessage = vi.fn(async () => ({ ok: true }));

  const messageStore = createMessageStore({ persistMessage });

  const deps: SessionSyncDeps = {
    persistence: {
      loadMessages: vi.fn(async () => ({ ok: true, rows: [] })),
      persistMessage,
    } as unknown as SessionSyncDeps['persistence'],
    gateway: {
      getHttpBase: () => undefined,
      chatHistory,
      syncSessions: vi.fn(async () => ({ ok: true, discovered: [] })),
    } as unknown as SessionSyncDeps['gateway'],
    getTaskStore: () => ({
      tasks: [{ id: TASK_ID, gatewayId: GATEWAY_ID, sessionKey: TASK_KEY }],
      hydrate: vi.fn(async () => {}),
      adoptTasks: vi.fn(),
      updateTaskMetadata: vi.fn(),
    }),
    getMessageStore: () => messageStore.getState() as unknown as ReturnType<SessionSyncDeps['getMessageStore']>,
    // 判据动态读 Set：采纳之后赢家会被移出去（"转正"）。
    isEphemeralSession: opts.withGate === false ? undefined : (sessionKey: string) => ephemeral.has(sessionKey),
  };

  return { sync: createSessionSync(deps), messageStore, chatHistory, persistMessage, ephemeral };
}

/** 让一列"跑完了"（正式会话那样走完流式）。 */
function finishTurn(h: Harness, sessionKey: string, text: string): void {
  h.messageStore.getState().appendStreamDelta(sessionKey, text);
  h.messageStore.getState().finalizeStream(sessionKey);
}

describe('重连对账（retrySyncPending）不碰临时会话', () => {
  it('对比列跑完了也不去拉网关历史 ⇒ 没采纳的答案不会被写进时间线', async () => {
    const h = makeHarness();
    finishTurn(h, COMPARE_KEY, '网关历史里的答案');

    h.sync.retrySyncPending();
    await new Promise((r) => setTimeout(r, 0));

    expect(h.chatHistory).not.toHaveBeenCalled();
    expect(h.persistMessage).not.toHaveBeenCalled();
    expect(h.messageStore.getState().messagesByTask[TASK_ID] ?? []).toEqual([]);
  });

  it('对照：普通会话跑完了照旧对账（证明差异来自判据，不是"什么都没发生"）', async () => {
    const h = makeHarness();
    finishTurn(h, TASK_KEY, '正式回复');

    h.sync.retrySyncPending();
    await new Promise((r) => setTimeout(r, 0));

    expect(h.chatHistory).toHaveBeenCalledWith(GATEWAY_ID, TASK_KEY);
    // 网关历史里那条回复被 promote 进时间线（这才是"对账"该有的样子）
    const messages = h.messageStore.getState().messagesByTask[TASK_ID] ?? [];
    expect(messages.map((m) => m.content)).toEqual(['网关历史里的答案']);
    expect(messages[0].sessionKey).toBe(TASK_KEY);
  });

  it('没有这道判据时，对比列会被对账写进时间线（说明闸门确实是它挡住的）', async () => {
    const h = makeHarness({ withGate: false });
    finishTurn(h, COMPARE_KEY, '网关历史里的答案');

    h.sync.retrySyncPending();
    await new Promise((r) => setTimeout(r, 0));

    // 反向对照：这正是**不能**发生的事 —— 未采纳的答案变成任务的对话内容
    expect(h.chatHistory).toHaveBeenCalledWith(GATEWAY_ID, COMPARE_KEY);
    const messages = h.messageStore.getState().messagesByTask[TASK_ID] ?? [];
    expect(messages.some((m) => m.content === '网关历史里的答案')).toBe(true);
  });

  it('采纳之后那一列"转正"：同一个键再去对账就照常走', async () => {
    const h = makeHarness();
    finishTurn(h, COMPARE_KEY, '被采纳的答案');

    h.sync.retrySyncPending();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.chatHistory).not.toHaveBeenCalled();

    // 采纳 = 这一列成为任务的会话
    h.ephemeral.delete(COMPARE_KEY);
    h.sync.retrySyncPending();
    await new Promise((r) => setTimeout(r, 0));

    expect(h.chatHistory).toHaveBeenCalledWith(GATEWAY_ID, COMPARE_KEY);
  });
});

describe('显式对账（syncSessionMessages）也拦住临时会话', () => {
  it('拿对比列的会话键直接调也不拉网关历史', async () => {
    const h = makeHarness();
    finishTurn(h, COMPARE_KEY, '网关历史里的答案');

    await h.sync.syncSessionMessages(TASK_ID, COMPARE_KEY);

    expect(h.chatHistory).not.toHaveBeenCalled();
    expect(h.messageStore.getState().activeTurnBySession[COMPARE_KEY]?.finalized).toBe(true);
  });
});

// 「采纳」之后赢家"转正"（临时会话闸门放行它），所以对账**会**去看它的网关历史 ——
// 这时唯一的防线就是去重键 `${sessionKey}|${timestamp}`。采纳进来的那条要是落的是
// **本地**时间，键就永远对不上：同一段答案会被当成"网关新回复"再 promote 一遍，
// 用户看到两条一样的回答（时间戳还各自不同）。
describe('采纳进来的回复不会被对账再写一遍', () => {
  /**
   * 采纳 = 赢家"转正"（从闸门里出去）+ 问题与答案一起落库。
   * `timestamp` 不给就是**修之前**的行为（拿 activeTurn 的本地时间落库）。
   */
  function adopt(h: Harness, timestamp?: string): void {
    h.ephemeral.delete(COMPARE_KEY);
    finishTurn(h, COMPARE_KEY, '网关历史里的答案');
    h.messageStore
      .getState()
      // 问题用本地时间（T1）：这就是「问题在前」那半个基线
      .addMessage(TASK_ID, 'user', '问题', undefined, { timestamp: new Date(Date.now() - 1).toISOString() });
    h.messageStore.getState().adoptActiveTurn(COMPARE_KEY, TASK_ID, timestamp ? { timestamp } : {});
  }

  it('答案带的是**网关**时间戳（T2 > T1）⇒ 对账认得出来，不会再写一遍', async () => {
    const h = makeHarness();
    adopt(h, new Date(GATEWAY_ASSISTANT_TS).toISOString());
    // 采纳那一下已经写了两条（问题 + 答案）
    const writesAfterAdopt = h.persistMessage.mock.calls.length;

    await h.sync.syncSessionMessages(TASK_ID, COMPARE_KEY);

    const messages = h.messageStore.getState().messagesByTask[TASK_ID] ?? [];
    expect(messages.map((m) => m.content)).toEqual(['问题', '网关历史里的答案']);
    // 问题在前、答案在后（顺序不再靠运气）
    expect(messages[0].timestamp <= messages[1].timestamp).toBe(true);
    // 对账没有再写一条（重复回答会同时多出内存消息 + 一次写盘）
    expect(h.persistMessage.mock.calls.length).toBe(writesAfterAdopt);
  });

  it('反方向：答案带的是**本地**时间戳 ⇒ 同一段答案被再写一遍（这就是修掉的那个形状）', async () => {
    const h = makeHarness();
    adopt(h);

    await h.sync.syncSessionMessages(TASK_ID, COMPARE_KEY);

    const messages = h.messageStore.getState().messagesByTask[TASK_ID] ?? [];
    expect(messages.filter((m) => m.content === '网关历史里的答案')).toHaveLength(2);
  });
});
