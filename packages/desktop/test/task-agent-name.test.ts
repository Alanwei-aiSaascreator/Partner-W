import { describe, expect, it, vi } from 'vitest';
import { resolveTaskAgentName } from '../src/renderer/lib/task-agent-name';

/**
 * T-a7 **写入方**那一半：派活时往 `RoomPerformer.agentName` 快照里写什么名字。
 *
 * 实机症状（改之前）：worker 的消息头/团队页拿到的是裸 id `partner-w-tpl-78b62899`，
 * 不是「爆款内容教练」—— 因为两个写入方都写的是 `agentName = agentId`。
 *
 * 这个函数就是"两步查找"（taskId → 网关；网关目录里 → name）的**宿主侧一半**：
 * core 不认识网关目录，所以 core 只负责"问一次、问不到就降级成裸 id"，
 * 真正的规则在这里。规则错了 ⇒ 快照里的名字错了，而且是**落库**的错。
 *
 * ⚠️ 返回 `undefined` 是**正常路径**（任务还没落库 / 目录还没拉到 / agent 被删了都会走到），
 * 不是"出错"。所以下面每一条"找不到"都必须钉死是 undefined，而不是抛、也不是空串：
 * 空串写进快照 = 这个字段白存（`resolvePerformerAgentName` 会跳过空值）。
 */
const TASK_ID = 'task-1';
const GATEWAY_ID = 'gw1';
const AGENT_ID = 'partner-w-tpl-78b62899';

function makeInput(overrides: {
  tasks?: Array<{ id: string; gatewayId?: string }>;
  agents?: Array<{ id: string; name?: string }> | undefined;
  /**
   * ⚠️ 这个入口是必需的：有几条用例要断言"**根本没去查目录**"，靠的就是给一个 spy。
   * 早先没有这个入口 ⇒ 传进来的 spy 被下面那行默认值**悄悄盖掉**，
   * `expect(spy).not.toHaveBeenCalled()` 于是**永远为真**（变异 M10 抓到过这个假绿）。
   */
  agentsForGateway?: Parameters<typeof resolveTaskAgentName>[0]['agentsForGateway'];
  taskId?: string;
  agentId?: string;
}): Parameters<typeof resolveTaskAgentName>[0] {
  return {
    tasks: overrides.tasks ?? [{ id: TASK_ID, gatewayId: GATEWAY_ID }],
    agentsForGateway:
      overrides.agentsForGateway ??
      (() => ('agents' in overrides ? overrides.agents : [{ id: AGENT_ID, name: '爆款内容教练' }])),
    taskId: overrides.taskId ?? TASK_ID,
    agentId: overrides.agentId ?? AGENT_ID,
  };
}

describe('resolveTaskAgentName —— 快照要写目录里的**人名**', () => {
  it('⭐ 目录里有这个 agent ⇒ 返回目录里的名字（不是裸 id）', () => {
    expect(resolveTaskAgentName(makeInput({}))).toBe('爆款内容教练');
  });

  it('⭐ 任务表里有多行时按 id **精确**匹配，不是拿第一行', () => {
    const result = resolveTaskAgentName(
      makeInput({
        tasks: [
          { id: 'task-0', gatewayId: 'gw0' },
          { id: TASK_ID, gatewayId: GATEWAY_ID },
        ],
      }),
    );
    expect(result).toBe('爆款内容教练');
  });

  it('⭐ 同一个 agentId 必须拿**这个任务所属网关**的目录去查 —— 别的网关里有也不算数', () => {
    const asked: string[] = [];
    const result = resolveTaskAgentName({
      tasks: [{ id: TASK_ID, gatewayId: 'gw1' }],
      agentsForGateway: (gwId) => {
        asked.push(gwId);
        // 只有 gw2 的目录里有这个 id ⇒ 说明查错网关就会"查到一个名字"
        return gwId === 'gw2' ? [{ id: AGENT_ID, name: '另一个网关的同名 agent' }] : [];
      },
      taskId: TASK_ID,
      agentId: AGENT_ID,
    });
    expect(result).toBeUndefined();
    expect(asked).toEqual(['gw1']);
  });

  it('⚠️ 目录里 agent 的 name 是**空串** ⇒ 返回 undefined（空串存进快照等于什么都没记）', () => {
    expect(resolveTaskAgentName(makeInput({ agents: [{ id: AGENT_ID, name: '' }] }))).toBeUndefined();
  });

  it('⚠️ 目录里 agent 缺 name 字段 ⇒ 返回 undefined', () => {
    expect(resolveTaskAgentName(makeInput({ agents: [{ id: AGENT_ID }] }))).toBeUndefined();
  });

  it('⭐ 目录里没有这个 agentId ⇒ 返回 undefined', () => {
    expect(resolveTaskAgentName(makeInput({ agents: [{ id: 'someone-else', name: '别人' }] }))).toBeUndefined();
  });

  it('⚠️ 目录还没拉到（agentsForGateway 返回 undefined）⇒ 返回 undefined，不是抛错', () => {
    expect(resolveTaskAgentName(makeInput({ agents: undefined }))).toBeUndefined();
  });

  it('⭐ 任务表里找不到这个 taskId ⇒ 返回 undefined（任务还没落库是正常路径）', () => {
    expect(resolveTaskAgentName(makeInput({ tasks: [{ id: '另一个任务', gatewayId: GATEWAY_ID }] }))).toBeUndefined();
  });

  it('⚠️ 任务没有 gatewayId ⇒ 返回 undefined，**不许**拿别的网关的目录去猜', () => {
    const agentsForGateway = vi.fn(() => [{ id: AGENT_ID, name: '爆款内容教练' }]);
    expect(resolveTaskAgentName(makeInput({ tasks: [{ id: TASK_ID }], agentsForGateway }))).toBeUndefined();
    expect(agentsForGateway).not.toHaveBeenCalled();
  });

  it('⚠️ 空 taskId ⇒ 返回 undefined（任务查不到，也不去碰目录）', () => {
    const agentsForGateway = vi.fn(() => [{ id: AGENT_ID, name: '爆款内容教练' }]);
    expect(resolveTaskAgentName(makeInput({ taskId: '', agentsForGateway }))).toBeUndefined();
    expect(agentsForGateway).not.toHaveBeenCalled();
  });

  it('⚠️ 空 agentId ⇒ 返回 undefined，且不去碰目录', () => {
    const agentsForGateway = vi.fn(() => [{ id: AGENT_ID, name: '爆款内容教练' }]);
    expect(resolveTaskAgentName(makeInput({ agentId: '', agentsForGateway }))).toBeUndefined();
    expect(agentsForGateway).not.toHaveBeenCalled();
  });

  it('⚠️ 目录里有两行、id 相同的排在后面 ⇒ 仍然按 id 找，不是拿第一行', () => {
    const result = resolveTaskAgentName(
      makeInput({
        agents: [
          { id: AGENT_ID, name: '爆款内容教练' },
          { id: 'other', name: '别人' },
        ],
      }),
    );
    expect(result).toBe('爆款内容教练');
  });
});
