/**
 * 点团队卡片上的「开始对话」时，**该不该真的进会话**。
 *
 * 判据原本内联在 `TeamsPanel` 的 `handleStartChat` 里，而它只看"团队里有没有助手"、
 * **不看那个助手在不在本机** ⇒ 盘上带来一个本机没装的团队时，点下去照样跳进会话，
 * 用户到那儿才发现不对（跳过去的那一屏才会说"这个助手不在本机"）。
 *
 * 收成纯函数是为了**可证伪**：写在组件里的话，删掉判据不会有任何测试变红。
 */
import { describe, expect, it } from 'vitest';
import { decideTeamChatEntry } from '../src/renderer/lib/team-chat-entry';

const manager = { agentId: 'partner-w-content', isManager: true };
const member = { agentId: 'helper-a' };
const BOTH_INSTALLED = { agents: [{ id: 'partner-w-content' }, { id: 'helper-a' }] };

describe('decideTeamChatEntry', () => {
  it('主管在本机 ⇒ 进主管的会话', () => {
    expect(decideTeamChatEntry({ agents: [member, manager], catalog: BOTH_INSTALLED })).toEqual({
      kind: 'start',
      agentId: 'partner-w-content',
    });
  });

  it('没有主管 ⇒ 用第一个（既有行为，别顺手改）', () => {
    expect(decideTeamChatEntry({ agents: [member], catalog: BOTH_INSTALLED })).toEqual({
      kind: 'start',
      agentId: 'helper-a',
    });
  });

  it('团队里一个助手都没有 ⇒ no-agents（既有行为）', () => {
    expect(decideTeamChatEntry({ agents: [], catalog: BOTH_INSTALLED })).toEqual({ kind: 'no-agents' });
  });

  it('⭐ 选中的那个助手不在本机 ⇒ agent-missing：**不许**跳进会话', () => {
    expect(decideTeamChatEntry({ agents: [manager], catalog: { agents: [{ id: 'someone-else' }] } })).toEqual({
      kind: 'agent-missing',
    });
  });

  it('⭐ 主管缺装、成员装着 ⇒ 仍然是 agent-missing（判的是**要进的那一个**）', () => {
    expect(decideTeamChatEntry({ agents: [member, manager], catalog: { agents: [{ id: 'helper-a' }] } })).toEqual({
      kind: 'agent-missing',
    });
  });

  it('⭐ 目录还没拉回来 ⇒ 照旧进（不许把"还没拉到"说成"不在本机"）', () => {
    // 这条与 `resolveRequestedAgent` 的三态是同一条纪律：`loading` 时判缺失就是**误报**，
    // 而误报比静默更坏 —— 用户会去"装"一个其实已经装好的助手。
    expect(decideTeamChatEntry({ agents: [manager], catalog: undefined })).toEqual({
      kind: 'start',
      agentId: 'partner-w-content',
    });
  });

  it('空目录（拉回来了、确实是空的）⇒ agent-missing，不是 loading', () => {
    expect(decideTeamChatEntry({ agents: [manager], catalog: { agents: [] } })).toEqual({ kind: 'agent-missing' });
  });
});
