import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `ws:sync-sessions` 的回归测试 —— 针对 2026-09-14 查实的一个**线上潜伏 bug**。
 *
 * ## Bug
 *
 * `chat.history` 的 `content` 是**多态**的（实测）：
 *
 * ```
 * role=user       content = "你好"          ← 纯字符串
 * role=assistant  content = [{type:'text'}] ← 块数组
 * ```
 *
 * 而 handler 只按块数组处理，`(m.content ?? []).filter(...)` 撞上字符串就抛
 * `(m.content ?? []).filter is not a function`。更要命的是当时**一条会话出错 =
 * 整个网关的会话全部归零**（外层 catch 吞掉），表现成 `discovered=0` 且不报错。
 *
 * ## 这些用例钉死什么
 *
 * A. 字符串 content 能被 materialize（不是被丢掉）
 * B. 块数组保持原行为
 * C. null / undefined 不抛
 * D. 混合/非 text 块只取合法 text，不抛
 * E. **一条会话坏掉不影响同网关的另一条**（负向控制，最重要的一条）
 */

const handleMap = new Map<string, (...args: unknown[]) => unknown>();

const loggerWarn = vi.fn();
const loggerError = vi.fn();
const loggerInfo = vi.fn();

let sessionsPayload: { sessions?: Array<Record<string, unknown>> } = { sessions: [] };
let historyByKey: Record<string, unknown> = {};

const listSessionsMock = vi.fn(async () => sessionsPayload);
const getChatHistoryMock = vi.fn(async (key: string) => historyByKey[key] ?? { messages: [] });

const fakeGatewayClient = {
  isConnected: true,
  httpBase: 'http://127.0.0.1:18789',
  listSessions: listSessionsMock,
  getChatHistory: getChatHistoryMock,
};

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handleMap.set(channel, handler);
    }),
  },
}));

vi.mock('../src/main/ws/index.js', () => ({
  getGatewayClient: vi.fn((id: string) => (id === 'gw-1' ? fakeGatewayClient : null)),
  getAllGatewayClients: vi.fn(() => new Map([['gw-1', fakeGatewayClient]])),
  reconnectGateway: vi.fn(),
}));

vi.mock('../src/main/workspace/config.js', () => ({
  readConfig: vi.fn(() => null),
  ensureDeviceId: vi.fn(() => 'dev-1'),
}));

vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: vi.fn(() => ({ warn: loggerWarn, error: loggerError, info: loggerInfo })),
}));

// 用**真的**会话键谓词，不要 mock 成恒 true —— 否则过滤这一层就没被测到。
// ⚠️ **部分** mock（`importOriginal` 铺底），不是整包替换：这个文件只关心那三个
//    会话键helper。整包替换的话，任何**别的**共享导出被主进程代码新引用一次
//    （2026-09-26：`docgen/request.ts` 开始用 `DOCGEN_FORMATS`），这个测试就会在
//    "collect" 阶段炸成一句和本文件毫无关系的报错 —— 一个没人会想到来这里改的假红。
vi.mock('@clawwork/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@clawwork/shared')>()),
  isClawWorkSession: vi.fn((key: string, deviceId?: string) => {
    const m = key.match(/^agent:([^:]+):clawwork:([^:]+):task:(.+)$/);
    return m !== null && (!deviceId || m[2] === deviceId);
  }),
  parseTaskIdFromSessionKey: vi.fn((key: string) => key.match(/task:(.+)$/)?.[1] ?? null),
  parseAgentIdFromSessionKey: vi.fn((key: string) => key.match(/^agent:([^:]+):/)?.[1] ?? 'main'),
}));

const { registerWsHandlers } = await import('../src/main/ipc/ws-handlers.js');

interface Discovered {
  taskId?: string;
  sessionKey?: string;
  title?: string;
  messages?: Array<{ role: string; content: string }>;
}

async function runSync(): Promise<Discovered[]> {
  const handler = handleMap.get('ws:sync-sessions');
  if (!handler) throw new Error('ws:sync-sessions 没注册');
  const res = (await handler({})) as { ok: boolean; discovered?: Discovered[] };
  return res.discovered ?? [];
}

const keyFor = (taskId: string) => `agent:main:clawwork:dev-1:task:${taskId}`;

beforeEach(() => {
  handleMap.clear();
  loggerWarn.mockClear();
  loggerError.mockClear();
  loggerInfo.mockClear();
  listSessionsMock.mockClear();
  getChatHistoryMock.mockClear();
  sessionsPayload = { sessions: [] };
  historyByKey = {};
  registerWsHandlers();
});

describe('ws:sync-sessions —— chat.history content 多态', () => {
  it('A. 字符串 content（user 的真实形状）能被 materialize，不再抛', async () => {
    const key = keyFor('t1');
    sessionsPayload = { sessions: [{ key }] };
    historyByKey[key] = { messages: [{ role: 'user', content: '你好' }] };

    const discovered = await runSync();

    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.messages).toHaveLength(1);
    expect(discovered[0]!.messages![0]!.content).toBe('你好');
    // 顺带：标题从第一条 user 消息取
    expect(discovered[0]!.title).toBe('你好');
  });

  it('B. 块数组 content（assistant 的真实形状）保持原行为', async () => {
    const key = keyFor('t2');
    sessionsPayload = { sessions: [{ key }] };
    historyByKey[key] = {
      messages: [
        { role: 'user', content: '问' },
        { role: 'assistant', content: [{ type: 'text', text: '答' }] },
      ],
    };

    const discovered = await runSync();

    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.messages!.map((m) => [m.role, m.content])).toEqual([
      ['user', '问'],
      ['assistant', '答'],
    ]);
  });

  it('C. null / undefined content 不抛', async () => {
    const key = keyFor('t3');
    sessionsPayload = { sessions: [{ key }] };
    historyByKey[key] = {
      messages: [
        { role: 'user', content: null },
        { role: 'assistant', content: undefined },
        { role: 'user', content: '' },
      ],
    };

    const discovered = await runSync();

    // 三条都因"没有可显示内容"被过滤掉，但**不该抛**，会话本身仍在
    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.messages).toEqual([]);
  });

  it('D. 混合 / 非 text 块只取合法 text，不抛', async () => {
    const key = keyFor('t4');
    sessionsPayload = { sessions: [{ key }] };
    historyByKey[key] = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '前' },
            { type: 'image', url: 'http://x/y.png' },
            { type: 'text' }, // 没有 text 字段
            { type: 'text', text: '后' },
          ],
        },
      ],
    };

    const discovered = await runSync();

    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.messages![0]!.content).toBe('前后');
  });

  it('D3. 数组里混进非对象元素也不抛（`Array.isArray` 不保证元素类型）', async () => {
    const key = keyFor('t4b');
    sessionsPayload = { sessions: [{ key }] };
    historyByKey[key] = {
      messages: [
        {
          role: 'user',
          content: ['裸字符串', null, 42, { type: 'text', text: '正常块' }],
        },
      ],
    };

    const discovered = await runSync();

    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.messages![0]!.content).toBe('正常块');
  });

  it('D2. 未知形状（对象）fail-soft：不抛、记一条日志、不把 [object Object] 写进历史', async () => {
    const key = keyFor('t5');
    sessionsPayload = { sessions: [{ key }] };
    historyByKey[key] = { messages: [{ role: 'user', content: { weird: true } }] };

    const discovered = await runSync();

    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.messages).toEqual([]);
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ipc.ws.sync-sessions.unknown-content-shape' }),
    );
    // ⚠️ 绝不能出现 String({}) 的产物
    expect(JSON.stringify(discovered)).not.toContain('[object Object]');
  });
});

describe('ws:sync-sessions —— 单条会话故障隔离（负向控制）', () => {
  it('E. 一条会话 chat.history 抛异常 ⇒ 只丢它自己，另一条照常被发现', async () => {
    const badKey = keyFor('bad');
    const goodKey = keyFor('good');
    const badTaskId = 'bad';
    sessionsPayload = { sessions: [{ key: badKey }, { key: goodKey }] };
    historyByKey = {
      [goodKey]: { messages: [{ role: 'user', content: '好会话' }] },
      // 坏会话：chat.history 直接抛（模拟网关侧的任意失败）
      [badKey]: null,
    };
    getChatHistoryMock.mockImplementation(async (key: string) => {
      if (key === badKey) throw new Error('boom: history unavailable');
      return historyByKey[key] ?? { messages: [] };
    });

    const discovered = await runSync();

    // ⭐ 关键：**不是 0** —— 好会话必须活下来
    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.taskId).toBe('good');
    expect(discovered[0]!.messages![0]!.content).toBe('好会话');
    // 而且坏的那条确实被标记了（不是被静默吞掉）
    expect(discovered.map((d) => d.taskId)).not.toContain(badTaskId);
    expect(loggerError).toHaveBeenCalledWith(expect.objectContaining({ event: 'ipc.ws.sync-sessions.session-failed' }));
  });

  it('E2. 坏会话的日志里不出现 session key 原文，只出现哈希', async () => {
    const badKey = keyFor('bad2');
    sessionsPayload = { sessions: [{ key: badKey }] };
    getChatHistoryMock.mockImplementation(async () => {
      throw new Error('boom');
    });

    await runSync();

    const call = loggerError.mock.calls.find(
      (c) => (c[0] as { event?: string })?.event === 'ipc.ws.sync-sessions.session-failed',
    );
    expect(call).toBeTruthy();
    expect(JSON.stringify(call)).not.toContain(badKey);
    expect(JSON.stringify(call)).toContain('sessionKeyHash');
  });

  it('E3. sessions.list 本身失败 ⇒ 仍是 **gateway 级**失败（边界没被收得过窄）', async () => {
    listSessionsMock.mockImplementationOnce(async () => {
      throw new Error('gateway list exploded');
    });

    const discovered = await runSync();

    expect(discovered).toEqual([]);
    expect(loggerError).toHaveBeenCalledWith(expect.objectContaining({ event: 'ipc.ws.sync-sessions.gateway-failed' }));
  });
});
