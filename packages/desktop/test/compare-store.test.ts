// 多模型对比的**编排**：并发发起 / 单路失败隔离 / 重试 / 采纳落库。
//
// 依赖全部是假的（网关、任务 store、时钟），唯独 `messageStore` 用的是**真的**
// `createMessageStore` —— 采纳这条路的重点就是"留下的消息长什么样、顺序对不对、
// 落库几条"，用假 store 断言"调过某方法"等于什么都没验。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMessageStore } from '@clawwork/core';
import { buildSessionKey, type IpcResult } from '@clawwork/shared';
import { compareSessionTaskId } from '../src/renderer/features/compare/compare-plan';
import { createCompareStore, type CompareStoreDeps } from '../src/renderer/features/compare/compare-store';

const TASK_ID = 'task-1';
const GATEWAY_ID = 'gw-1';
const PROMPT = '用三句话介绍你自己';

/**
 * 网关 `chat.history` 的**实测形状**（夹具刻意贴着它写）：
 *   · assistant 的 `content` 是**块数组**，不是字符串；
 *   · `timestamp` 是 **epoch 毫秒（number）**，不是 ISO 串。
 *
 * ⚠️ 夹具用"简化形状"（字符串 + ISO）会掩盖真实链路上的转换：这条链上真切地漏过一次 ——
 *    探测函数只认字符串，于是网关的毫秒数被判成"没有"，采纳进来的消息落的是本地时间，
 *    与 session-sync 的去重键永远对不上。夹具不真实，测试就是绿的谎话。
 */
const GATEWAY_USER_TS = Date.parse('2026-09-18T09:00:00.000Z');
const GATEWAY_ASSISTANT_TS = Date.parse('2026-09-18T09:00:05.000Z');
/** 网关说这条回复实际是它生成的 —— **故意不是**任何一列的配置模型（否则断言等于没验）。 */
const GATEWAY_MODEL = 'kimi-k2-thinking';

type Call = { method: string; args: unknown[] };

interface Harness {
  store: ReturnType<typeof createCompareStore>;
  calls: Call[];
  /** 落库的消息（按调用顺序）。 */
  persisted: Array<Record<string, unknown>>;
  /** 任务元数据更新（采纳时改会话指针用）。 */
  taskMetaUpdates: Array<{ id: string; meta: Record<string, unknown> }>;
  messageStore: ReturnType<typeof createMessageStore>;
  /** 任务表（**可变**：有的用例要模拟"任务已经没有了 / 没有 gatewayId"）。 */
  tasks: Array<{ id: string; sessionKey: string; gatewayId: string; agentId?: string; title: string }>;
  /** 让某一列"跑完"：走真实的两步（流式累积 → finalize）。 */
  finishColumn: (sessionKey: string, text: string, thinking?: string) => void;
  methods: (name: string) => Call[];
  keys: () => string[];
}

function ok(): IpcResult {
  return { ok: true };
}

function makeHarness(overrides: Partial<CompareStoreDeps> = {}): Harness {
  const calls: Call[] = [];
  const persisted: Array<Record<string, unknown>> = [];
  const taskMetaUpdates: Array<{ id: string; meta: Record<string, unknown> }> = [];
  const log = (method: string, ...args: unknown[]) => calls.push({ method, args });

  const messageStore = createMessageStore({
    persistMessage: vi.fn(async (msg: Record<string, unknown>) => {
      persisted.push(msg);
      return ok();
    }),
  });

  const tasks = [
    { id: TASK_ID, sessionKey: buildSessionKey(TASK_ID), gatewayId: GATEWAY_ID, agentId: 'main', title: '测试任务' },
  ];

  const deps: CompareStoreDeps = {
    createSession: vi.fn(async (gatewayId: string, params: { key: string; agentId: string }) => {
      log('createSession', gatewayId, params);
      return ok();
    }),
    patchSession: vi.fn(async (gatewayId: string, sessionKey: string, patch: Record<string, unknown>) => {
      log('patchSession', gatewayId, sessionKey, patch);
      return ok();
    }),
    sendMessage: vi.fn(async (gatewayId: string, sessionKey: string, content: string) => {
      log('sendMessage', gatewayId, sessionKey, content);
      return ok();
    }),
    abortChat: vi.fn(async (gatewayId: string, sessionKey: string) => {
      log('abortChat', gatewayId, sessionKey);
      return ok();
    }),
    deleteSession: vi.fn(async (gatewayId: string, sessionKey: string) => {
      log('deleteSession', gatewayId, sessionKey);
      return ok();
    }),
    chatHistory: vi.fn(async (gatewayId: string, sessionKey: string) => {
      log('chatHistory', gatewayId, sessionKey);
      return {
        ok: true,
        result: {
          messages: [
            { role: 'user', content: [{ type: 'text', text: PROMPT }], timestamp: GATEWAY_USER_TS },
            {
              role: 'assistant',
              content: [{ type: 'text', text: '我是谁' }],
              model: GATEWAY_MODEL,
              timestamp: GATEWAY_ASSISTANT_TS,
            },
          ],
        },
      };
    }),
    getMessageStore: () => messageStore.getState(),
    getTaskStore: () => ({
      tasks,
      updateTaskMetadata: (id: string, meta: { sessionKey?: string }) => {
        taskMetaUpdates.push({ id, meta });
        log('updateTaskMetadata', id, meta);
      },
    }),
    translate: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key),
    onToast: (type: string, title: string) => log('toast', type, title),
    newId: () => 'run-1',
    ...overrides,
  };

  const store = createCompareStore(deps);

  return {
    store,
    calls,
    persisted,
    taskMetaUpdates,
    messageStore,
    tasks,
    methods: (name) => calls.filter((c) => c.method === name),
    keys: () => store.getState().active?.columns.map((c) => c.sessionKey) ?? [],
    finishColumn: (sessionKey, text, thinking) => {
      messageStore.getState().appendStreamDelta(sessionKey, text);
      if (thinking) messageStore.getState().appendThinkingDelta(sessionKey, thinking);
      messageStore.getState().finalizeStream(sessionKey);
    },
  };
}

function start(h: Harness, models = ['qwen-plus', 'glm-4.7']) {
  h.store.getState().setDraftModels(models);
  return h.store.getState().start({ taskId: TASK_ID, gatewayId: GATEWAY_ID, agentId: 'main', prompt: PROMPT });
}

/** 让所有 promise 链跑完（全部依赖都是 promise，不涉及真实计时器）。 */
async function flush(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

describe('对比编排：并发发起', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('N 路在**同一个 tick** 里全部开跑（不是一路一路等往返）', () => {
    const h = makeHarness();
    start(h);

    // ⚠️ 这条断言就是「并发」本身：`start()` 返回时 2 路都已经调过 createSession。
    //    若实现改成 `for (const c of columns) await runColumn(c)`，这里只会是 1。
    expect(h.methods('createSession')).toHaveLength(2);
    expect(h.keys()).toHaveLength(2);
  });

  it('每路钉自己的模型：同一句话发到 N 条独立会话，各自的模型互不相同', async () => {
    const h = makeHarness();
    start(h, ['qwen-plus', 'glm-4.7', 'kimi-k2']);
    await flush();

    const [keyA, keyB, keyC] = h.keys();
    expect(new Set([keyA, keyB, keyC]).size).toBe(3);
    // 会话键认得出归属任务（事件路由要靠它），但都不是这个设备的普通会话
    for (const key of [keyA, keyB, keyC]) expect(compareSessionTaskId(key)).toBe(TASK_ID);

    expect(h.methods('patchSession').map((c) => c.args[2])).toEqual([
      { model: 'qwen-plus' },
      { model: 'glm-4.7' },
      { model: 'kimi-k2' },
    ]);
    const sent = h.methods('sendMessage');
    expect(sent.map((c) => c.args[1])).toEqual([keyA, keyB, keyC]);
    expect(sent.map((c) => c.args[2])).toEqual([PROMPT, PROMPT, PROMPT]);
  });

  it('监听的每一列都是临时会话（不写进对话时间线的依据）', async () => {
    const h = makeHarness();
    start(h);
    await flush();
    for (const key of h.keys()) expect(h.store.getState().isEphemeral(key)).toBe(true);
    expect(h.store.getState().isEphemeral(buildSessionKey(TASK_ID))).toBe(false);
  });

  it('勾选的模型数量不合法时一路都不开跑', () => {
    const h = makeHarness();
    h.store.getState().setDraftModels(['只有一个']);
    expect(
      h.store.getState().start({ taskId: TASK_ID, gatewayId: GATEWAY_ID, agentId: 'main', prompt: PROMPT }),
    ).toBeNull();
    expect(h.store.getState().error).toBe('too-few-models');
    expect(h.methods('createSession')).toHaveLength(0);
    expect(h.store.getState().active).toBeNull();
  });
});

describe('对比编排：单路失败不影响其余路', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('钉模型失败只挂那一列：其余列照常发出，且失败**不进时间线**', async () => {
    // 第 2 列钉模型失败（模型下架 / 上游拒绝）
    const h = makeHarness({
      patchSession: vi.fn(async (gatewayId: string, sessionKey: string, p: Record<string, unknown>) => {
        if (p.model === 'bad-model') return { ok: false, error: '模型不可用' };
        return ok();
      }),
    });
    start(h, ['qwen-plus', 'bad-model']);
    await flush();

    const [goodKey, badKey] = h.keys();
    const errors = h.messageStore.getState().errorBySession;
    expect(Object.keys(errors)).toEqual([badKey]);
    expect(errors[badKey]).toContain('compare.columnModelFailed');
    // 好的那一路照常发出
    expect(h.methods('sendMessage').map((c) => c.args[1])).toEqual([goodKey]);
    // 失败**不落成对话消息**（用户还没采纳任何一列，这一轮不算这个任务的对话内容）
    expect(h.messageStore.getState().messagesByTask[TASK_ID] ?? []).toEqual([]);
    expect(h.persisted).toEqual([]);
  });

  it('发送失败（额度/上游）只挂那一列，其余列继续跑', async () => {
    const h = makeHarness({
      sendMessage: vi.fn(async (gatewayId: string, sessionKey: string) => {
        // 第 2 列（伪设备号 compare-run-1-1）发送失败
        if (sessionKey.includes(':compare-run-1-1:')) return { ok: false, error: '余额不足' };
        return ok();
      }),
    });
    start(h, ['qwen-plus', 'glm-4.7']);
    await flush();

    const [key0, key1] = h.keys();
    const errors = h.messageStore.getState().errorBySession;
    expect(errors[key0]).toBeUndefined();
    expect(errors[key1]).toBe('余额不足');
  });

  it('某一路抛异常（建会话就炸）也只看得到它自己挂', async () => {
    const h = makeHarness({
      createSession: vi.fn(async (gatewayId: string, params: { key: string }) => {
        // 第 1 列（伪设备号 compare-run-1-0）在建会话这一步就炸
        if (params.key.includes(':compare-run-1-0:')) throw new Error('会话建不起来');
        return ok();
      }),
    });
    start(h, ['qwen-plus', 'glm-4.7']);
    await flush();

    const [key0, key1] = h.keys();
    expect(h.messageStore.getState().errorBySession[key0]).toBe('会话建不起来');
    expect(h.messageStore.getState().errorBySession[key1]).toBeUndefined();
    expect(h.methods('sendMessage').map((c) => c.args[1])).toEqual([key1]);
  });

  it('发出去后**毫无动静**的那一列 30 秒后报错；已经有字的列不报', async () => {
    const h = makeHarness();
    start(h, ['qwen-plus', 'glm-4.7']);
    await flush();

    const [key0, key1] = h.keys();
    // 第 1 列已经开始出字（有 activeTurn = 活着），第 2 列什么都没有
    h.messageStore.getState().appendStreamDelta(key0, '正在写');

    vi.advanceTimersByTime(30_000);

    const errors = h.messageStore.getState().errorBySession;
    expect(errors[key0]).toBeUndefined();
    expect(errors[key1]).toContain('errors.');
    expect(errors[key1]).not.toBe('');
  });

  it('网关**已接单**但还没出字（processing）时 30 秒兜底不误报；没动静的那列照旧报', async () => {
    const h = makeHarness();
    start(h, ['qwen-plus', 'glm-4.7']);
    await flush();

    const [key0, key1] = h.keys();
    // 冷启动实测：网关要 37–74 秒才吐第一个字，但这期间 `lifecycle.start` 早就把
    // `processingBySession` 立起来了 —— 那一列是**活的**，不能报"助手没有响应"
    //（用户看到的是"明明在流式，30 秒后集体报错"，然后点重试 = 同一句话再花一次钱）。
    h.messageStore.getState().setProcessing(key0, true);

    vi.advanceTimersByTime(30_000);

    const errors = h.messageStore.getState().errorBySession;
    expect(errors[key0]).toBeUndefined();
    // 反方向：一条真的毫无动静的列（processing 也没立起来）仍然要报错，兜底不能被削弱成摆设
    expect(errors[key1]).toContain('errors.');
  });

  it('重试只重跑挂了那一列，并把它的旧错误与残留正文清掉', async () => {
    const h = makeHarness();
    start(h, ['qwen-plus', 'glm-4.7']);
    await flush();

    const [key0, key1] = h.keys();
    // 第 2 列挂掉，第 1 列正常出字
    h.messageStore.getState().setSessionError(key1, '上游 500');
    h.messageStore.getState().appendStreamDelta(key0, '第 1 列的字');

    h.store.getState().retry(key1);
    // 重试只清自己那一列
    expect(h.messageStore.getState().errorBySession[key1]).toBeUndefined();
    await flush();

    const retried = h.methods('sendMessage');
    expect(retried.map((c) => c.args[1])).toEqual([key0, key1, key1]);
    // 第 1 列的字还在（没被"整体清一下"打回空白）
    expect(h.messageStore.getState().activeTurnBySession[key0]?.streamingText).toBe('第 1 列的字');
  });
});

describe('对比编排：采纳', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('采纳落库的时间戳：问题在前、答案在后，且答案用的是**网关时刻**', async () => {
    // 本机时钟**晚于**网关那条回复的时刻（最常见的形状：回复早就生成完了，用户过一会儿才点采纳）
    vi.setSystemTime(new Date('2026-09-18T10:00:00.000Z'));
    const h = makeHarness();
    start(h);
    await flush();
    const [keyA] = h.keys();
    h.finishColumn(keyA, '答案');

    h.store.getState().adopt(keyA);
    await flush();

    const messages = h.messageStore.getState().messagesByTask[TASK_ID];
    // ⚠️ 这条不变式就是"重启后对话不会倒过来"：消息回读是按 timestamp **升序**排的
    //（主进程 `data:list-messages` 的 orderBy）。相等也不行 —— 相等时顺序由读取实现决定。
    expect(messages[0].timestamp < messages[1].timestamp).toBe(true);
    // 答案用的是**网关**那条回复的生成时刻（去重键的一半，不能是本地落库时刻）
    expect(messages[1].timestamp).toBe(new Date(GATEWAY_ASSISTANT_TS).toISOString());
    // 问题贴在同一个基准上：网关时刻往前 1ms
    expect(messages[0].timestamp).toBe(new Date(GATEWAY_ASSISTANT_TS - 1).toISOString());
    // 落库顺序与时间顺序一致（两条一起落，谁也不许插队）
    expect(h.persisted.map((m) => m.timestamp)).toEqual([messages[0].timestamp, messages[1].timestamp]);
  });

  it('本机时钟**落后于**网关时也一样先问后答（基准取两边的较小值）', async () => {
    vi.setSystemTime(new Date('2026-09-18T08:00:00.000Z')); // 早于网关那条回复
    const h = makeHarness();
    start(h);
    await flush();
    const [keyA] = h.keys();
    h.finishColumn(keyA, '答案');

    h.store.getState().adopt(keyA);
    await flush();

    const messages = h.messageStore.getState().messagesByTask[TASK_ID];
    expect(messages[0].timestamp < messages[1].timestamp).toBe(true);
    // 答案仍然是网关时刻（两侧时钟有偏差也不能改它，否则去重键对不上）
    expect(messages[1].timestamp).toBe(new Date(GATEWAY_ASSISTANT_TS).toISOString());
  });

  it('采纳成功就退出对比模式（不然选择条立刻又冒出来，下一句话又是一轮新对比）', async () => {
    const h = makeHarness();
    h.store.getState().setMode(true);
    start(h);
    await flush();
    const [keyA] = h.keys();
    h.finishColumn(keyA, '答案');

    h.store.getState().adopt(keyA);
    await flush();

    expect(h.store.getState().mode).toBe(false);
  });

  it('采纳在飞的时候再点一次：只落一对问答，且**不许**把刚采纳的会话删掉', async () => {
    const h = makeHarness();
    start(h);
    await flush();
    const [keyA] = h.keys();
    h.finishColumn(keyA, '答案');

    // 两次点击之间不 flush：探针（chat.history）还没回来，第二次点落在"同步检查已通过、
    // 状态还没改"的窗口里 —— 正是线上双击的形状。
    h.store.getState().adopt(keyA);
    h.store.getState().adopt(keyA);
    await flush();

    const messages = h.messageStore.getState().messagesByTask[TASK_ID] ?? [];
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(h.taskMetaUpdates).toHaveLength(1);
    // 单飞的意思是第二次点击**什么都不做**（探针只飞一次），而不是"先放它进来、再靠后面
    // 的兜底检查擦屁股"——兜底那一步会用失败分支把刚采纳的赢家会话删掉。
    expect(h.methods('chatHistory')).toHaveLength(1);
    // 第二次点以前会走到"探针回来时那一轮已经没了"的收尾分支：abort + 删掉**刚指过去的
    // 赢家会话**（任务指针随即指向一条不存在的会话）。
    expect(h.methods('deleteSession').map((c) => c.args[1])).not.toContain(keyA);
    expect(h.store.getState().isEphemeral(keyA)).toBe(false);
  });

  it('先点第 1 列再点第 2 列：先点的赢（不会变成两问两答、也不会把注册表删空）', async () => {
    const h = makeHarness();
    start(h, ['qwen-plus', 'glm-4.7', 'kimi-k2']);
    await flush();
    const [keyA, keyB, keyC] = h.keys();
    h.finishColumn(keyA, '千问的答案');
    h.finishColumn(keyB, 'GLM 的答案');

    h.store.getState().adopt(keyA);
    // 败者的「用户主动中断」标记是**同步**打的（不能等异步清理 —— 登记表在
    // `deleteSession` 成功那一刻就摘键了，迟到的 aborted 帧那时看着像普通会话）
    expect(h.store.getState().wasAbortedByUser(keyB)).toBe(true);
    expect(h.store.getState().wasAbortedByUser(keyA)).toBe(false);
    h.store.getState().adopt(keyB); // 探针还在飞：这一次必须被单飞锁吃掉
    await flush();

    const messages = h.messageStore.getState().messagesByTask[TASK_ID] ?? [];
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1].content).toBe('千问的答案');
    expect(h.taskMetaUpdates).toEqual([{ id: TASK_ID, meta: { sessionKey: keyA } }]);
    // 赢家留、败者被收拾掉（第一次点的 keyB 是败者，不是"第二次点的赢家"）
    const deleted = h.methods('deleteSession').map((c) => c.args[1]);
    expect(deleted.sort()).toEqual([keyB, keyC].sort());
    expect(deleted).not.toContain(keyA);
  });

  it('采纳 = 先落问题再落答案（+ 指针指向赢家 + 其余列被收拾掉）', async () => {
    const h = makeHarness();
    start(h, ['qwen-plus', 'glm-4.7', 'kimi-k2']);
    await flush();

    const [keyA, keyB, keyC] = h.keys();
    h.finishColumn(keyA, '我是千问', '一点推理');
    h.finishColumn(keyB, '我是 GLM');

    h.store.getState().adopt(keyA);
    await flush();

    // ① 消息：问题在前、答案在后（顺序反了就是"一条没有问题的答案"）
    const messages = h.messageStore.getState().messagesByTask[TASK_ID];
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[0].content).toBe(PROMPT);
    expect(messages[1].content).toBe('我是千问');
    expect(messages[1].thinkingContent).toBe('一点推理');
    // ② 徽章用的模型来自**网关历史**（不是列的配置模型 —— 那是"我发给谁"）。
    //    假网关刻意报一个**不在任何一列上**的模型名，这条断言才真的在验来源。
    expect(messages[1].model).toBe(GATEWAY_MODEL);
    expect(messages[1].sessionKey).toBe(keyA);
    // ③ 落库两条，顺序一致
    expect(h.persisted.map((m) => m.role)).toEqual(['user', 'assistant']);

    // ④ 会话指针指向赢家 ⇒ 下一句话发进这条已经有本次问答的会话（"采纳后新会话带上下文"）
    expect(h.taskMetaUpdates).toEqual([{ id: TASK_ID, meta: { sessionKey: keyA } }]);

    // ⑤ 界面回到普通对话；赢家转正、败者清理
    expect(h.store.getState().active).toBeNull();
    expect(h.store.getState().isEphemeral(keyA)).toBe(false);
    expect(h.store.getState().isEphemeral(keyB)).toBe(false);
    expect(h.store.getState().isEphemeral(keyC)).toBe(false);
    const deleted = h.methods('deleteSession').map((c) => c.args[1]);
    expect(deleted.sort()).toEqual([keyB, keyC].sort());
    expect(deleted).not.toContain(keyA);

    // ⑥ 临时回合被收走：赢家变成正式消息、败者那点半截正文也一并丢掉（这一轮结束了，
    //    谁都不会再去读它 —— 留着只会在下一轮读到同一个键时冒充"正在跑的列"）
    expect(h.messageStore.getState().activeTurnBySession[keyA]).toBeUndefined();
    expect(h.messageStore.getState().activeTurnBySession[keyB]).toBeUndefined();
  });

  it('采纳的是**哪一列**就是哪一列：换一列答案就换', async () => {
    const h = makeHarness();
    start(h);
    await flush();
    const [keyA, keyB] = h.keys();
    h.finishColumn(keyA, '千问的答案');
    h.finishColumn(keyB, 'GLM 的答案');

    h.store.getState().adopt(keyB);
    await flush();

    const messages = h.messageStore.getState().messagesByTask[TASK_ID];
    expect(messages[1].content).toBe('GLM 的答案');
    expect(messages[1].sessionKey).toBe(keyB);
    expect(h.taskMetaUpdates[0].meta.sessionKey).toBe(keyB);
  });

  it('还没跑完的列采纳不动（不能把指针指到没有答案的会话上）', async () => {
    const h = makeHarness();
    start(h);
    await flush();
    const [keyA] = h.keys();
    // keyA 只有半截流式正文，还没 finalize
    h.messageStore.getState().appendStreamDelta(keyA, '半截');

    h.store.getState().adopt(keyA);
    await flush();

    expect(h.messageStore.getState().messagesByTask[TASK_ID] ?? []).toEqual([]);
    expect(h.taskMetaUpdates).toEqual([]);
    expect(h.store.getState().active).not.toBeNull();
    expect(h.store.getState().isEphemeral(keyA)).toBe(true);
  });

  it('探不到网关历史时不伪造模型，但答案照样落库', async () => {
    const h = makeHarness({
      chatHistory: vi.fn(async () => ({ ok: false, error: '网关没连上' })),
    });
    start(h);
    await flush();
    const [keyA] = h.keys();
    h.finishColumn(keyA, '答案');

    h.store.getState().adopt(keyA);
    await flush();

    const messages = h.messageStore.getState().messagesByTask[TASK_ID];
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1].content).toBe('答案');
    // ⚠️ 宁可没有徽章，也不拿列的配置模型冒充"实际生成它的模型"
    expect(messages[1].model).toBeUndefined();
  });

  it('采纳之后兜底计时器不会再给赢家挂错误', async () => {
    const h = makeHarness();
    start(h);
    await flush();
    const [keyA] = h.keys();
    h.finishColumn(keyA, '答案');
    h.store.getState().adopt(keyA);
    await flush();

    vi.advanceTimersByTime(60_000);
    expect(h.messageStore.getState().errorBySession[keyA]).toBeUndefined();
  });
});

describe('对比编排：取消', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('取消 = 界面立刻退出 + 尽力关掉那几条会话', async () => {
    const h = makeHarness();
    start(h, ['qwen-plus', 'glm-4.7']);
    await flush();
    const [keyA, keyB] = h.keys();

    h.store.getState().dismiss();
    // 先关界面（点完就不该再看到那几列），清理是后台的
    expect(h.store.getState().active).toBeNull();
    await flush();

    expect(
      h
        .methods('abortChat')
        .map((c) => c.args[1])
        .sort(),
    ).toEqual([keyA, keyB].sort());
    expect(
      h
        .methods('deleteSession')
        .map((c) => c.args[1])
        .sort(),
    ).toEqual([keyA, keyB].sort());
    expect(h.store.getState().isEphemeral(keyA)).toBe(false);
    expect(h.store.getState().isEphemeral(keyB)).toBe(false);
  });

  it('删不掉的会话仍然留在登记表里（迟到的 final 不许进对话）', async () => {
    const h = makeHarness({
      deleteSession: vi.fn(async () => ({ ok: false, error: '会话还在跑' })),
    });
    start(h);
    await flush();
    const [keyA] = h.keys();

    h.store.getState().dismiss();
    await flush();

    expect(h.store.getState().isEphemeral(keyA)).toBe(true);
  });

  it('取消时给每一列打上「用户主动中断」，**在** abort 发出去之前', async () => {
    const aborted: string[] = [];
    const markedWhenAborted: boolean[] = [];
    const h = makeHarness({
      abortChat: vi.fn(async (gatewayId: string, sessionKey: string) => {
        aborted.push(sessionKey);
        // 关键点：abort 请求发出**那一刻**标记就得在。网关的回执 / 迟到的 aborted 帧
        // 可能在登记表摘键之后才到，那时这一帧看着就是一条"普通会话"的中断 ——
        // dispatcher 会往对话时间线里插一条 system 消息、标未读、弹通知。
        markedWhenAborted.push(store.getState().wasAbortedByUser(sessionKey));
        return { ok: true };
      }),
    });
    const { store } = h;
    start(h, ['qwen-plus', 'glm-4.7']);
    await flush();
    const [keyA, keyB] = h.keys();

    h.store.getState().dismiss();
    // 标记是**同步**打的（在 dismiss 返回时就已经在），不用等清理流程跑完
    expect(store.getState().wasAbortedByUser(keyA)).toBe(true);
    await flush();

    expect(aborted).toEqual([keyA, keyB]);
    expect(markedWhenAborted).toEqual([true, true]);
    expect(store.getState().wasAbortedByUser(keyB)).toBe(true);
    // 没有中断过的那条普通会话不能被误标（标记是按会话键的，不是"整轮都算"）
    expect(store.getState().wasAbortedByUser(buildSessionKey(TASK_ID))).toBe(false);
  });

  it('取消时把每一列的界面旁路状态一起丢掉（不留上一轮的残影）', async () => {
    const h = makeHarness();
    start(h, ['qwen-plus', 'glm-4.7']);
    await flush();
    const [keyA, keyB] = h.keys();
    h.messageStore.getState().appendStreamDelta(keyA, '半截正文');
    h.messageStore.getState().setSessionError(keyB, '上游 500');

    h.store.getState().dismiss();

    expect(h.messageStore.getState().errorBySession).toEqual({});
    expect(h.messageStore.getState().activeTurnBySession[keyA]).toBeUndefined();
  });

  it('任务已经没有 gatewayId 时也要摘键（漏掉就是把那几条会话键永远钉在登记表里）', async () => {
    const h = makeHarness();
    start(h, ['qwen-plus', 'glm-4.7']);
    await flush();
    const [keyA, keyB] = h.keys();
    // 任务已经从本地被删掉（或网关 id 还没落下）：`deps.getTaskStore().tasks.find` 找不到它
    h.tasks.length = 0;

    h.store.getState().dismiss();
    await flush();

    expect(h.store.getState().isEphemeral(keyA)).toBe(false);
    expect(h.store.getState().isEphemeral(keyB)).toBe(false);
  });
});

describe('对比编排：跨任务与默认勾选', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('在另一个任务里又发起一轮：上一轮被收掉（它的会话不会变成没人管的孤儿）', async () => {
    const h = makeHarness();
    h.store.getState().setDraftModels(['qwen-plus', 'glm-4.7']);
    h.store.getState().start({ taskId: TASK_ID, gatewayId: GATEWAY_ID, agentId: 'main', prompt: PROMPT });
    await flush();
    const [oldA, oldB] = h.keys();

    // 用户切到别的任务，再发一句话（那边也在对比模式下）
    h.store.getState().start({ taskId: 'task-2', gatewayId: GATEWAY_ID, agentId: 'main', prompt: '第二个任务' });
    await flush();

    expect(h.store.getState().active?.taskId).toBe('task-2');
    // 上一轮那两条：登记表摘掉 + 网关侧尽力删掉（界面只有一组列，留着就再没人收拾它们）
    expect(h.store.getState().isEphemeral(oldA)).toBe(false);
    expect(h.store.getState().isEphemeral(oldB)).toBe(false);
    const deleted = h.methods('deleteSession').map((c) => c.args[1]);
    expect(deleted).toEqual(expect.arrayContaining([oldA, oldB]));
    // 新一轮自己的列照常登记
    for (const key of h.keys()) expect(h.store.getState().isEphemeral(key)).toBe(true);
  });

  it('默认勾选只在**第一次**进入对比模式时回填；用户清空之后不许再填', () => {
    const h = makeHarness();
    const catalog = ['m1', 'm2', 'm3'];

    h.store.getState().seedDraftModels(catalog);
    expect(h.store.getState().draftModels).toEqual(['m1', 'm2']);
    expect(h.store.getState().draftSeeded).toBe(true);

    // 用户主动清空 —— 界面随后会因为任何一次重渲染再调一次回填，
    // 判据若是"现在是空的"（`draftModels.length > 0`），用户删一个它填一个，永远清不干净
    h.store.getState().setDraftModels([]);
    h.store.getState().seedDraftModels(catalog);
    expect(h.store.getState().draftModels).toEqual([]);

    // 目录还没热的时候不置位：等目录到了还会再调一次，那时才回填
    const cold = makeHarness();
    cold.store.getState().seedDraftModels(['只有一个']);
    expect(cold.store.getState().draftModels).toEqual([]);
    expect(cold.store.getState().draftSeeded).toBe(false);
    cold.store.getState().seedDraftModels(catalog);
    expect(cold.store.getState().draftModels).toEqual(['m1', 'm2']);

    // 退出对比模式再进来 = 重新开始：这时空的选择才应该被填回来
    h.store.getState().setMode(false);
    h.store.getState().seedDraftModels(catalog);
    expect(h.store.getState().draftModels).toEqual(['m1', 'm2']);
  });
});
