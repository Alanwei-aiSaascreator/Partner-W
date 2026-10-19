// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-a7 家族**第四个面**（给 conductor 那句「用户 @ 了谁」）的**接线**测试：
 * 真 `platform/index.ts` → 真 `createChatComposer` → 真 `lookupAgentName`
 * → 真 `lib/task-agent-name.ts` → 真 `window.clawwork.sendMessage`（假的只是进程边界）。
 *
 * 为什么非要有这一条：这一刀修的是「那句话里写的是裸 agentId」。
 * 光有对的规则（`lib/task-agent-name.ts`）与对的调用点（core 的 `resolveMentionNames`）、
 * **宿主不把这个 dep 接进 `createChatComposer`**，模型看到的仍然是一串机器 id ——
 * 症状一模一样。这个仓库里其它 desktop 测试都把 `../src/renderer/platform` 整个 mock 掉，
 * 所以"接线到底接没接"只有这里守着。
 *
 * ⚠️ 房间是**手工 seed 的脏快照**（`agentName` 就是裸 agentId）—— 那正是存量数据的样子，
 *    也是这一刀唯一能显形的前提（新房间的快照里已经是人名了，接不接线都看不出差别）。
 */
const h = vi.hoisted(() => {
  // ⚠️ 参数类型要声明出来，否则 `mock.calls` 是长度 0 的元组，读不出载荷（tsc TS2493）。
  const sendMessage = vi.fn(async (_gwId: string, _sessionKey: string, _content: string, _attachments?: unknown) => ({
    ok: true,
  }));
  const patchSession = vi.fn(async (_gwId: string, _sessionKey: string, _patch: unknown) => ({ ok: true }));
  const loadRoom = vi.fn(async (_taskId: string) => ({ ok: true, room: null, performers: [] }));
  const listSessions = vi.fn<(...args: unknown[]) => Promise<import('@clawwork/shared').IpcResult>>();
  const getConfig = vi.fn<(...args: unknown[]) => Promise<import('@clawwork/shared').IpcResult>>();
  const api: Record<string, unknown> = { sendMessage, patchSession, loadRoom, listSessions, getConfig };
  (globalThis as unknown as { window: { clawwork: unknown } }).window.clawwork = new Proxy(api, {
    get: (target, prop) => (prop in target ? target[prop as string] : vi.fn(async () => ({ ok: true }))),
  });
  return { sendMessage, patchSession, loadRoom, listSessions, getConfig };
});

import { composer, useRoomStore, useTaskStore, useUiStore } from '../src/renderer/platform';
import { useGatewayDispatcherSetup } from '../src/renderer/hooks/useGatewayDispatcherSetup';

vi.mock('../src/renderer/features/team-meeting/instance', () => ({
  teamMeetingController: { load: vi.fn(async () => {}) },
}));

const TASK_ID = 'task-1';
const GATEWAY_ID = 'gw1';
const AGENT_ID = 'rongying-tpl-78b62899';
const AGENT_NAME = '爆款内容教练';
const SESSION_KEY = `agent:${AGENT_ID}:subagent:0e0b5f3a-1111-2222-3333-444455556666`;
const CONDUCTOR_KEY = `agent:conductor:clawwork:task:${TASK_ID}`;

/** seed：一个**存量脏快照**的房间（`agentName` 存的是裸 id），外加网关目录。 */
function seed(opts: { taskGatewayId?: string | undefined; agents?: Array<{ id: string; name?: string }> } = {}) {
  const task: { id: string; gatewayId?: string; sessionKey: string; ensemble: boolean; title: string } = {
    id: TASK_ID,
    sessionKey: CONDUCTOR_KEY,
    ensemble: true,
    title: 'T',
  };
  task.gatewayId = opts.taskGatewayId ?? GATEWAY_ID;
  useTaskStore.setState({ tasks: [task] as never });
  useUiStore.setState({
    agentCatalogByGateway: {
      [GATEWAY_ID]: { agents: opts.agents ?? [{ id: AGENT_ID, name: AGENT_NAME }], defaultId: AGENT_ID },
    },
  } as never);
  useRoomStore.setState({
    rooms: {
      [TASK_ID]: {
        taskId: TASK_ID,
        conductorSessionKey: CONDUCTOR_KEY,
        conductorReady: true,
        status: 'active',
        performers: [
          {
            agentId: AGENT_ID,
            // ⭐ 存量脏数据：快照里存的就是裸 agentId（两个写入方原来都传错）
            agentName: AGENT_ID,
            sessionKey: SESSION_KEY,
            verifiedAt: '2026-09-16T00:00:00.000Z',
          },
        ],
      },
    },
    subagentKeyMap: { [SESSION_KEY]: TASK_ID },
  } as never);
}

/** 发给某个 session 的消息正文。 */
function sentTo(sessionKey: string): string[] {
  return h.sendMessage.mock.calls.filter((c) => c[1] === sessionKey).map((c) => c[2]);
}

describe('@ 提及通知的接线 —— conductor 那句话里的名字必须来自网关目录', () => {
  beforeEach(() => {
    useGatewayDispatcherSetup();
    h.sendMessage.mockClear();
    h.patchSession.mockClear();
    seed();
  });

  it('⭐ 存量房间（脏快照）里 @ 一个 worker ⇒ conductor 收到的是目录里的名字，不是裸 agentId', async () => {
    const res = await composer.send(TASK_ID, { content: '看看这个', mentions: [AGENT_ID] });

    expect(res.ok).toBe(true);
    expect(sentTo(CONDUCTOR_KEY)).toEqual([`[User directed message to ${AGENT_NAME}: "看看这个"]`]);
  });

  it('⭐ 负对照：同一个 id 在**别的网关**下查不到 ⇒ 退回快照（裸 id），证明上面那条不是写死的', async () => {
    seed({ taskGatewayId: 'gw2' });

    await composer.send(TASK_ID, { content: '看看这个', mentions: [AGENT_ID] });

    expect(sentTo(CONDUCTOR_KEY)).toEqual([`[User directed message to ${AGENT_ID}: "看看这个"]`]);
  });

  it('⭐ 名字只进那句话：派给 worker 的仍然是**用户原话**（载荷一个字节没动）', async () => {
    await composer.send(TASK_ID, { content: '看看这个', mentions: [AGENT_ID] });

    expect(sentTo(SESSION_KEY)).toEqual(['看看这个']);
  });

  it('⚠️ 目录还没拉到（agentCatalogByGateway 是空的）⇒ 退回裸 id，消息照发不炸', async () => {
    // 目录是异步拉的：刚启动 / 换网关时它可能还没到。取不到名字**不能**影响发消息。
    useUiStore.setState({ agentCatalogByGateway: {} } as never);

    const res = await composer.send(TASK_ID, { content: '看看这个', mentions: [AGENT_ID] });

    expect(res.ok).toBe(true);
    expect(sentTo(CONDUCTOR_KEY)).toEqual([`[User directed message to ${AGENT_ID}: "看看这个"]`]);
    expect(sentTo(SESSION_KEY)).toEqual(['看看这个']);
  });
});

describe('image recipient validation through real platform and composer', () => {
  const image = { mimeType: 'image/png', fileName: 'random.png', content: 'AP8BEA==' };
  const catalog = [
    { id: 'vision-a', name: 'A', provider: 'clawrouter', input: ['text', 'image'] },
    { id: 'vision-b', name: 'B', provider: 'clawrouter', input: ['text', 'image'] },
  ];
  const rows = [
    { key: CONDUCTOR_KEY, model: 'vision-a', modelProvider: 'clawrouter' },
    { key: SESSION_KEY, model: 'vision-b', modelProvider: 'clawrouter' },
  ];
  const config = (models: unknown = catalog) => ({
    ok: true,
    result: { config: { models: { providers: { clawrouter: { models } } } } },
  });
  beforeEach(() => {
    useGatewayDispatcherSetup();
    h.sendMessage.mockClear();
    h.patchSession.mockReset().mockResolvedValue({ ok: true });
    h.listSessions.mockReset().mockResolvedValue({ ok: true, result: { sessions: rows } });
    h.getConfig.mockReset().mockResolvedValue(config());
    seed();
    useUiStore.setState({ modelCatalogByGateway: { [GATEWAY_ID]: catalog } });
  });

  it.each([false, true])('sends original image bytes for all verified targets: all=%s', async (all) => {
    const result = await composer.send(TASK_ID, {
      content: 'inspect',
      attachments: [image],
      presetModel: 'main-text-model',
      ...(all ? { mentionAll: true } : { mentions: [AGENT_ID] }),
    });
    expect(result.ok).toBe(true);
    expect(h.listSessions).toHaveBeenCalledTimes(2);
    expect(h.getConfig).toHaveBeenCalledTimes(2);
    expect(h.listSessions).toHaveBeenCalledWith(GATEWAY_ID);
    expect(h.patchSession).toHaveBeenCalledWith(GATEWAY_ID, SESSION_KEY, { model: 'clawrouter/vision-b' });
    const dispatched = h.sendMessage.mock.calls.filter((call) => call[3]);
    expect(dispatched.map((call) => call[1])).toEqual(all ? [CONDUCTOR_KEY, SESSION_KEY] : [SESSION_KEY]);
    for (const call of dispatched) expect(call[3]).toEqual([image]);
    composer.dispose();
  });

  it.each([
    'mixed',
    'unknown',
    'foreign-catalog',
    'session-read',
    'config-read',
    'config-throw',
    'pin-failure',
    'pin-throw',
    'readback-changed',
    'readback-failure',
  ] as const)('has zero dispatch for %s', async (failure) => {
    if (failure === 'mixed') h.getConfig.mockResolvedValue(config([catalog[0], { ...catalog[1], input: ['text'] }]));
    if (failure === 'unknown') h.listSessions.mockResolvedValue({ ok: true, result: { sessions: [rows[0]] } });
    if (failure === 'foreign-catalog') useUiStore.setState({ modelCatalogByGateway: { other: catalog } });
    if (failure === 'config-throw') h.getConfig.mockRejectedValue(new Error('config unavailable'));
    if (failure === 'pin-throw')
      h.patchSession.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('pin unavailable'));
    if (failure === 'readback-failure')
      h.listSessions
        .mockResolvedValueOnce({ ok: true, result: { sessions: rows } })
        .mockRejectedValueOnce(new Error('readback unavailable'));
    if (failure === 'session-read') h.listSessions.mockRejectedValue(new Error('read failure'));
    if (failure === 'config-read') h.getConfig.mockResolvedValue({ ok: false });
    if (failure === 'pin-failure')
      h.patchSession.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false });
    if (failure === 'readback-changed')
      h.listSessions
        .mockResolvedValueOnce({ ok: true, result: { sessions: rows } })
        .mockResolvedValueOnce({ ok: true, result: { sessions: [rows[0], { ...rows[1], model: 'vision-a' }] } });
    const result = await composer.send(TASK_ID, {
      content: 'inspect',
      attachments: [image],
      mentionAll: true,
      deferUserMessageUntilSent: true,
    });
    expect(result.ok).toBe(false);
    expect(h.sendMessage).not.toHaveBeenCalled();
    if (['pin-failure', 'pin-throw', 'readback-changed', 'readback-failure'].includes(failure))
      expect(h.patchSession).toHaveBeenCalledTimes(2);
    else expect(h.patchSession).not.toHaveBeenCalled();
    composer.dispose();
  });
});
