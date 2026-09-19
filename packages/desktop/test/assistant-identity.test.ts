import { describe, expect, it } from 'vitest';
import { resolveAssistantIdentity } from '../src/renderer/layouts/MainArea/assistant-identity';

/**
 * T-a7 实机症状：团队派活时 worker 的消息头显示 `rongying-tpl-78b62899`，
 * 团队页里同一个 agent 却是「爆款内容教练」。
 *
 * 这里钉的是**接线**（不是纯函数 `resolvePerformerAgentName` 本身）：
 * 光有对的规则、展示层不调用它，症状一模一样。
 */
const WORKER_ID = 'rongying-tpl-78b62899';
const WORKER_SESSION = `agent:${WORKER_ID}:subagent:0e0b5f3a-1111-2222-3333-444455556666`;

function makeInput(overrides: {
  performers?: Array<{ sessionKey: string; agentId: string; agentName: string }>;
  agents?: Array<{ id: string; name?: string }>;
}): Parameters<typeof resolveAssistantIdentity>[0] {
  const performers = overrides.performers ?? [];
  return {
    task: undefined,
    sessionKey: WORKER_SESSION,
    gatewayId: 'gw1',
    performerBySessionKey: new Map(performers.map((p) => [p.sessionKey, p])),
    performerByAgentId: new Map(performers.map((p) => [p.agentId, p])),
    catalogAgentById: new Map((overrides.agents ?? []).map((a) => [a.id, a])),
    conductorLabel: '高效办公',
  };
}

describe('resolveAssistantIdentity —— worker 显示名', () => {
  it('⭐ 快照里存的是裸 agentId（存量数据就是这样）⇒ 显示目录里的中文名', () => {
    const identity = resolveAssistantIdentity(
      makeInput({
        performers: [{ sessionKey: WORKER_SESSION, agentId: WORKER_ID, agentName: WORKER_ID }],
        agents: [{ id: WORKER_ID, name: '爆款内容教练' }],
      }),
    );
    expect(identity.agentName).toBe('爆款内容教练');
    expect(identity.agentName).not.toBe(WORKER_ID);
  });

  it('目录里查不到（agent 被删了）⇒ 退回快照名，不是什么都不显示', () => {
    const identity = resolveAssistantIdentity(
      makeInput({
        performers: [{ sessionKey: WORKER_SESSION, agentId: WORKER_ID, agentName: '被删掉的助手' }],
        agents: [],
      }),
    );
    expect(identity.agentName).toBe('被删掉的助手');
  });

  it('目录与快照都没有 ⇒ 退回 sessionKey 里解析出的 agentId（与改动前的末位一致）', () => {
    const identity = resolveAssistantIdentity(makeInput({ performers: [], agents: [] }));
    expect(identity.agentName).toBe(WORKER_ID);
  });
});

describe('resolveAssistantIdentity —— conductor 那一支（改前就是对的，守回归）', () => {
  const CONDUCTOR_ID = 'rongying-office';
  const CONDUCTOR_SESSION = `agent:${CONDUCTOR_ID}:clawwork:dev1:task:t1`;

  function conductorInput() {
    const performers = [
      { sessionKey: CONDUCTOR_SESSION, agentId: CONDUCTOR_ID, agentName: CONDUCTOR_ID },
      { sessionKey: WORKER_SESSION, agentId: WORKER_ID, agentName: WORKER_ID },
    ];
    return {
      task: { sessionKey: CONDUCTOR_SESSION, agentId: CONDUCTOR_ID, ensemble: true },
      sessionKey: CONDUCTOR_SESSION,
      gatewayId: 'gw1',
      performerBySessionKey: new Map(performers.map((p) => [p.sessionKey, p])),
      performerByAgentId: new Map(performers.map((p) => [p.agentId, p])),
      catalogAgentById: new Map([
        [CONDUCTOR_ID, { id: CONDUCTOR_ID, name: '高效办公' }],
        [WORKER_ID, { id: WORKER_ID, name: '爆款内容教练' }],
      ]),
      conductorLabel: '高效办公',
    };
  }

  it('conductor 仍然取目录名', () => {
    expect(resolveAssistantIdentity(conductorInput()).agentName).toBe('高效办公');
  });

  it('conductor 显示目录名时，角色标签不再重复同一串（agentRoleLabel 置空）', () => {
    expect(resolveAssistantIdentity(conductorInput()).agentRoleLabel).toBeUndefined();
  });

  it('同一个房间里的 worker 也取目录名 —— 三个人显示三个不同的名字', () => {
    const both = conductorInput();
    const worker = resolveAssistantIdentity({ ...both, task: undefined, sessionKey: WORKER_SESSION });
    expect(worker.agentName).toBe('爆款内容教练');
    expect(worker.agentRoleLabel).toBeUndefined();
  });
});
