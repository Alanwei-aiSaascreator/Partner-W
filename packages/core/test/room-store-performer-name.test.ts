import { describe, it, expect, vi } from 'vitest';
import { buildSessionKey } from '@clawwork/shared';
import { createRoomStore, type RoomStoreDeps } from '../src/stores/room-store';

/**
 * T-a7 的**写入方那一半**：`RoomPerformer.agentName` 是"派活那一刻的快照"，
 * 而**两个写入方都往它里面塞裸 agentId** —— 于是存量数据库里存的是
 * `rongying-tpl-78b62899` 这种串，而不是「爆款内容教练」。
 *
 * 展示层（`resolvePerformerAgentName`）已经改成**目录优先**，所以用户现在看不到脏数据；
 * 但快照本身还是错的：**agent 从网关删掉之后目录里就没有它了**，那时只剩快照还记得名字
 * —— 存裸 id 等于什么都没记。
 *
 * 所以这一刀把"名字"收进 store：**写入方不再自己拼名字**（连参数都不给了），
 * store 通过 `deps.resolveAgentName` 问一次目录，问不到就照旧降级成裸 id。
 */

const TASK = 'task-1';
const GATEWAY = 'gw-1';
const CONDUCTOR_KEY = buildSessionKey(TASK);
const SUBAGENT_KEY = 'agent:main:subagent:abc-123-def4-5678-90ab-cdef12345678';
/** 实测那个真身（2026-09-20 直连网关 `agents.list`）。 */
const WORKER_ID = 'rongying-tpl-78b62899';
const WORKER_NAME = '爆款内容教练';

function createDeps(overrides: Partial<RoomStoreDeps> = {}): RoomStoreDeps {
  return {
    createSession: vi.fn(async () => ({ ok: true })),
    abortChat: vi.fn(async () => ({})),
    listSessionsBySpawner: vi.fn(async () => ({ ok: true, result: { sessions: [] } })),
    persistRoom: vi.fn(async () => ({})),
    persistPerformer: vi.fn(async () => ({})),
    loadRoom: vi.fn(async () => ({ ok: true, room: { status: 'active', conductorReady: true }, performers: [] })),
    ...overrides,
  };
}

/** 建一个"房间已存在"的 store（先 hydrate 一次）。 */
async function storeWithRoom(deps: RoomStoreDeps) {
  const store = createRoomStore(deps);
  await store.getState().hydrateRoom(TASK, CONDUCTOR_KEY);
  return store;
}

const persistedName = (deps: RoomStoreDeps): string | undefined =>
  (deps.persistPerformer as unknown as { mock: { calls: Array<[{ agentName: string }]> } }).mock.calls.at(-1)?.[0]
    .agentName;

describe('registerPerformerKey —— 快照要写**人名**，不是裸 agentId', () => {
  it('⭐ 目录里有这个助手 ⇒ 快照与落盘都用目录里的名字', async () => {
    const deps = createDeps({
      resolveAgentName: (taskId, agentId) => (taskId === TASK && agentId === WORKER_ID ? WORKER_NAME : undefined),
    });
    const store = await storeWithRoom(deps);

    store.getState().registerPerformerKey(TASK, SUBAGENT_KEY, WORKER_ID);

    expect(store.getState().getRoom(TASK)?.performers[0]?.agentName).toBe(WORKER_NAME);
    expect(persistedName(deps)).toBe(WORKER_NAME);
  });

  it('⭐ 目录里问不到 ⇒ 降级成裸 id（宁可名字丑，也不要空）', async () => {
    const deps = createDeps({ resolveAgentName: () => undefined });
    const store = await storeWithRoom(deps);

    store.getState().registerPerformerKey(TASK, SUBAGENT_KEY, WORKER_ID);

    expect(store.getState().getRoom(TASK)?.performers[0]?.agentName).toBe(WORKER_ID);
    expect(persistedName(deps)).toBe(WORKER_ID);
  });

  it('⚠️ `resolveAgentName` 返回**空串**也降级成裸 id（空快照 = 没记住任何东西）', async () => {
    const deps = createDeps({ resolveAgentName: () => '' });
    const store = await storeWithRoom(deps);

    store.getState().registerPerformerKey(TASK, SUBAGENT_KEY, WORKER_ID);

    expect(store.getState().getRoom(TASK)?.performers[0]?.agentName).toBe(WORKER_ID);
  });

  it('⚠️ 没接线（没给 `resolveAgentName`）也**不炸**，照旧写裸 id', async () => {
    const deps = createDeps();
    const store = await storeWithRoom(deps);

    expect(() => store.getState().registerPerformerKey(TASK, SUBAGENT_KEY, WORKER_ID)).not.toThrow();
    expect(store.getState().getRoom(TASK)?.performers[0]?.agentName).toBe(WORKER_ID);
  });

  it('⭐ 解析这一下**抛错**也不炸派活流程 —— 降级成裸 id（fail-soft）', async () => {
    const deps = createDeps({
      resolveAgentName: () => {
        throw new Error('catalog not loaded yet');
      },
    });
    const store = await storeWithRoom(deps);

    expect(() => store.getState().registerPerformerKey(TASK, SUBAGENT_KEY, WORKER_ID)).not.toThrow();
    expect(store.getState().getRoom(TASK)?.performers[0]?.agentName).toBe(WORKER_ID);
  });

  it('⚠️ 幂等没被搞坏：同一个会话登记两次只留一条，并且不再落盘第二次', async () => {
    const deps = createDeps({ resolveAgentName: () => WORKER_NAME });
    const store = await storeWithRoom(deps);

    store.getState().registerPerformerKey(TASK, SUBAGENT_KEY, WORKER_ID);
    store.getState().registerPerformerKey(TASK, SUBAGENT_KEY, WORKER_ID);

    expect(store.getState().getRoom(TASK)?.performers).toHaveLength(1);
    expect(deps.persistPerformer).toHaveBeenCalledTimes(1);
  });
});

describe('verifyCandidates —— **第二个**写入方也要写人名', () => {
  it('⭐ 对账出来的成员，快照同样用目录里的名字', async () => {
    const deps = createDeps({
      resolveAgentName: (taskId, agentId) => (taskId === TASK && agentId === WORKER_ID ? WORKER_NAME : undefined),
      listSessionsBySpawner: vi.fn(async () => ({
        ok: true,
        result: { sessions: [{ key: SUBAGENT_KEY, agentId: WORKER_ID }] },
      })),
    });
    const store = await storeWithRoom(deps);

    await store.getState().verifyCandidates(TASK, GATEWAY);

    expect(store.getState().getRoom(TASK)?.performers[0]?.agentName).toBe(WORKER_NAME);
    expect(persistedName(deps)).toBe(WORKER_NAME);
  });

  it('会话里没带 agentId ⇒ 从 sessionKey 里解析，照样去问目录', async () => {
    const seen: Array<[string, string]> = [];
    const deps = createDeps({
      resolveAgentName: (taskId, agentId) => {
        seen.push([taskId, agentId]);
        return WORKER_NAME;
      },
      listSessionsBySpawner: vi.fn(async () => ({
        ok: true,
        result: { sessions: [{ key: SUBAGENT_KEY }] },
      })),
    });
    const store = await storeWithRoom(deps);

    await store.getState().verifyCandidates(TASK, GATEWAY);

    // sessionKey 是 `agent:main:subagent:…` ⇒ 解析出来的是 `main`
    expect(seen).toEqual([[TASK, 'main']]);
    expect(store.getState().getRoom(TASK)?.performers[0]?.agentName).toBe(WORKER_NAME);
  });
});
