// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-a7 **写入方**那一半的**接线**测试：从真的 `platform/index.ts` 出发，
 * 真 `roomStore` → 真 `deps.resolveAgentName` → 真 `resolveTaskAgentName` → 真 `persistPerformer`。
 *
 * 为什么非要有这一条：队列里那一刀修的正是"两个写入方把裸 id 当名字写进快照"。
 * 光有对的规则（`lib/task-agent-name.ts`）、**宿主不把它接进 `createRoomStore`**，
 * 落库的仍然是 `partner-w-tpl-78b62899` —— 症状一模一样。
 * 这个仓库里其它 desktop 测试都把 `../src/renderer/platform` 整个 mock 掉了，
 * 所以"接线有没有接"只有这一条守着（见文件末尾的说明）。
 *
 * ⚠️ 这里**故意** import 真的 platform 模块（不 mock）：mock 掉它就等于没测。
 *    只把 `window.clawwork` 换成假的（这是进程边界，不是被测对象）。
 */
const h = vi.hoisted(() => {
  // ⚠️ spy 的**参数**必须声明出来：不声明的话 `mock.calls` 是长度 0 的元组，
  //    `calls.at(-1)?.[0]` 直接编不过（tsc 报 TS2493）。这也正是我要读的载荷。
  const persistPerformer = vi.fn(async (_params: { agentName?: string; agentId?: string }) => ({ ok: true }));
  const persistRoom = vi.fn(async (_params: unknown) => ({ ok: true }));
  const loadRoom = vi.fn(async (_taskId: string) => ({ ok: true, room: null, performers: [] }));
  const createSession = vi.fn(async (_gwId: string, _params: unknown) => ({ ok: true }));
  const api: Record<string, unknown> = { persistPerformer, persistRoom, loadRoom, createSession };
  (globalThis as unknown as { window: { clawwork: unknown } }).window.clawwork = new Proxy(api, {
    get: (target, prop) => (prop in target ? target[prop as string] : vi.fn(async () => ({ ok: true }))),
  });
  return { persistPerformer, persistRoom, loadRoom, createSession };
});

import { useRoomStore, useTaskStore, useUiStore } from '../src/renderer/platform';

const TASK_ID = 'task-1';
const GATEWAY_ID = 'gw1';
const AGENT_ID = 'partner-w-tpl-78b62899';
const AGENT_NAME = '爆款内容教练';
const SESSION_KEY = `agent:${AGENT_ID}:subagent:0e0b5f3a-1111-2222-3333-444455556666`;

/** 只 seed 被测代码真正读的那几个字段（任务表那一行只用来查 gatewayId）。 */
function seed(opts: { taskGatewayId?: string | undefined; agents?: Array<{ id: string; name?: string }> }) {
  const task: { id: string; gatewayId?: string } = { id: TASK_ID };
  if (opts.taskGatewayId !== undefined) task.gatewayId = opts.taskGatewayId;
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
        conductorSessionKey: `agent:conductor:${TASK_ID}`,
        conductorReady: true,
        status: 'active',
        performers: [],
      },
    },
    subagentKeyMap: {},
  } as never);
}

function performer() {
  return useRoomStore.getState().rooms[TASK_ID]?.performers[0];
}

function lastPersisted() {
  return h.persistPerformer.mock.calls.at(-1)?.[0];
}

describe('写入方接线 —— 快照里的 agentName 必须来自网关目录', () => {
  beforeEach(() => {
    h.persistPerformer.mockClear();
    h.persistRoom.mockClear();
  });

  it('⭐ registerPerformerKey 写进 store 的 agentName 是目录里的名字，不是裸 agentId', () => {
    seed({ taskGatewayId: GATEWAY_ID });
    useRoomStore.getState().registerPerformerKey(TASK_ID, SESSION_KEY, AGENT_ID);

    expect(performer()?.agentName).toBe(AGENT_NAME);
    expect(performer()?.agentId).toBe(AGENT_ID);
  });

  it('⭐ 落盘的也是人名（persistPerformer 的载荷）—— 存量脏数据就是这么来的', () => {
    seed({ taskGatewayId: GATEWAY_ID });
    useRoomStore.getState().registerPerformerKey(TASK_ID, SESSION_KEY, AGENT_ID);

    expect(lastPersisted()?.agentName).toBe(AGENT_NAME);
  });

  it('⭐ 真接线里同一个 id 在两个网关下名字不同 ⇒ 走的是**这个任务所属网关**的目录', () => {
    // 反向对照：目录里没有这个名字（换个网关）⇒ 必须退回裸 id，
    // 证明上面那条绿不是"函数写死了一个名字"。
    seed({ taskGatewayId: 'gw2' });
    useRoomStore.getState().registerPerformerKey(TASK_ID, SESSION_KEY, AGENT_ID);

    expect(performer()?.agentName).toBe(AGENT_ID);
  });

  it('⚠️ 目录里没有这个 agent ⇒ 落库降级成裸 id，但**派活不能炸**（performer 照登记、照落盘）', () => {
    seed({ taskGatewayId: GATEWAY_ID, agents: [{ id: 'someone-else', name: '别人' }] });
    useRoomStore.getState().registerPerformerKey(TASK_ID, SESSION_KEY, AGENT_ID);

    expect(performer()?.agentName).toBe(AGENT_ID);
    expect(useRoomStore.getState().rooms[TASK_ID]?.performers).toHaveLength(1);
    expect(h.persistPerformer).toHaveBeenCalledTimes(1);
  });

  it('⚠️ 任务还没落库（任务表里没有这一行）⇒ 降级成裸 id，派活照走', () => {
    seed({ taskGatewayId: GATEWAY_ID });
    useTaskStore.setState({ tasks: [] as never });
    useRoomStore.getState().registerPerformerKey(TASK_ID, SESSION_KEY, AGENT_ID);

    expect(performer()?.agentName).toBe(AGENT_ID);
    expect(h.persistPerformer).toHaveBeenCalledTimes(1);
  });

  it('⚠️ 目录还没拉到（agentCatalogByGateway 是空的）⇒ 降级成裸 id，派活照走', () => {
    seed({ taskGatewayId: GATEWAY_ID });
    useUiStore.setState({ agentCatalogByGateway: {} } as never);
    useRoomStore.getState().registerPerformerKey(TASK_ID, SESSION_KEY, AGENT_ID);

    expect(performer()?.agentName).toBe(AGENT_ID);
    expect(h.persistPerformer).toHaveBeenCalledTimes(1);
  });
});
