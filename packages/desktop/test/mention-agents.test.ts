import { describe, expect, it } from 'vitest';
import { buildMentionAgents } from '../src/renderer/components/ChatInput/mention-agents';

/**
 * `@` 提及选择器那一行显示什么（T-a7 家族第三个显示面）。
 *
 * 症状：旧房间的快照里 `agentName` 存的是裸 id ⇒ 选择器显示 `partner-w-tpl-78b62899`。
 * 规则本身在 shared 的 `resolvePerformerAgentName`（目录 → 快照 → 裸 id，**唯一**一份），
 * 这里钉的是"这个面有没有用它"，以及拼装有没有把 `@` 需要的东西弄丢。
 */
const AGENT_ID = 'partner-w-tpl-78b62899';
const CATALOG_NAME = '爆款内容教练';
const SESSION_KEY = `agent:${AGENT_ID}:subagent:0e0b5f3a`;
const GATEWAY_ID = 'gw1';

type Params = Parameters<typeof buildMentionAgents>[0];

function input(overrides: {
  performers?: Params['performers'];
  catalogAgents?: Params['catalogAgents'];
  gatewayId?: string | undefined;
}): Params {
  return {
    performers:
      'performers' in overrides
        ? overrides.performers
        : [{ agentId: AGENT_ID, agentName: AGENT_ID, emoji: '🔥', sessionKey: SESSION_KEY }],
    catalogAgents: 'catalogAgents' in overrides ? overrides.catalogAgents : [{ id: AGENT_ID, name: CATALOG_NAME }],
    gatewayId: 'gatewayId' in overrides ? overrides.gatewayId : GATEWAY_ID,
  };
}

describe('buildMentionAgents —— @ 选择器里的 worker 名字', () => {
  it('⭐ 快照里是裸 id（存量脏数据）⇒ 显示目录里的名字', () => {
    expect(buildMentionAgents(input({}))[0].agentName).toBe(CATALOG_NAME);
  });

  it('⭐ 快照里是**旧名字**、目录里是新名字 ⇒ 目录优先（目录是活的）', () => {
    const result = buildMentionAgents(
      input({ performers: [{ agentId: AGENT_ID, agentName: '改名前的老称呼', sessionKey: SESSION_KEY }] }),
    );
    expect(result[0].agentName).toBe(CATALOG_NAME);
  });

  it('⭐ agentId / sessionKey 原样带着 —— 发消息时 @ 的载荷用的是 id，不是名字', () => {
    const entry = buildMentionAgents(input({}))[0];
    expect(entry.agentId).toBe(AGENT_ID);
    expect(entry.sessionKey).toBe(SESSION_KEY);
    expect(entry.gatewayId).toBe(GATEWAY_ID);
    expect(entry.emoji).toBe('🔥');
  });

  it('⭐ 头像从目录里取（目录有才取）', () => {
    const withAvatar = buildMentionAgents(
      input({ catalogAgents: [{ id: AGENT_ID, name: CATALOG_NAME, identity: { avatarUrl: 'https://x/a.png' } }] }),
    );
    expect(withAvatar[0].avatarUrl).toBe('https://x/a.png');

    const noAvatar = buildMentionAgents(input({ catalogAgents: [{ id: AGENT_ID, name: CATALOG_NAME }] }));
    expect(noAvatar[0].avatarUrl).toBeUndefined();
  });

  it('⚠️ 目录里没有这个 agent ⇒ 用快照里的名字（agent 被删了，快照是唯一还记得的）', () => {
    const result = buildMentionAgents(
      input({
        performers: [{ agentId: AGENT_ID, agentName: '老名字', sessionKey: SESSION_KEY }],
        catalogAgents: [],
      }),
    );
    expect(result[0].agentName).toBe('老名字');
  });

  it('⚠️ 目录里这一行 name 是空串 ⇒ 用快照（空串不算"有名字"）', () => {
    const result = buildMentionAgents(
      input({
        performers: [{ agentId: AGENT_ID, agentName: '老名字', sessionKey: SESSION_KEY }],
        catalogAgents: [{ id: AGENT_ID, name: '' }],
      }),
    );
    expect(result[0].agentName).toBe('老名字');
  });

  it('⚠️ 目录没有、快照也是空串 ⇒ 退回裸 agentId（不是空串，否则选择器那一行是空白）', () => {
    const result = buildMentionAgents(
      input({
        performers: [{ agentId: AGENT_ID, agentName: '', sessionKey: SESSION_KEY }],
        catalogAgents: [],
      }),
    );
    expect(result[0].agentName).toBe(AGENT_ID);
  });

  it('⚠️ 目录是按 **id 精确**匹配的，不是拿第一行', () => {
    const result = buildMentionAgents(
      input({
        catalogAgents: [
          { id: 'someone-else', name: '别人' },
          { id: AGENT_ID, name: CATALOG_NAME },
        ],
      }),
    );
    expect(result[0].agentName).toBe(CATALOG_NAME);
  });

  it('⚠️ 同一个 agentId 有两个会话 ⇒ 去重成一条（重复 @ 会重复派活）', () => {
    const result = buildMentionAgents(
      input({
        performers: [
          { agentId: AGENT_ID, agentName: AGENT_ID, sessionKey: SESSION_KEY },
          { agentId: AGENT_ID, agentName: AGENT_ID, sessionKey: `${SESSION_KEY}-2` },
        ],
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].agentName).toBe(CATALOG_NAME);
  });

  it('⚠️ 没有 performer（还没派活 / 房间没 hydrate）⇒ 空数组，不是 undefined', () => {
    expect(buildMentionAgents(input({ performers: [] }))).toEqual([]);
    expect(buildMentionAgents(input({ performers: undefined }))).toEqual([]);
  });

  it('⚠️ 目录还没拉到（undefined）⇒ 仍然给出条目，只是用快照名', () => {
    const result = buildMentionAgents(
      input({
        performers: [{ agentId: AGENT_ID, agentName: '老名字', sessionKey: SESSION_KEY }],
        catalogAgents: undefined,
      }),
    );
    expect(result[0].agentName).toBe('老名字');
  });

  it('⚠️ 不知道网关（gatewayId undefined）⇒ 条目照样给，gatewayId 是 undefined', () => {
    const result = buildMentionAgents(input({ gatewayId: undefined }));
    expect(result).toHaveLength(1);
    expect(result[0].gatewayId).toBeUndefined();
  });
});
