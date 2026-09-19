import { describe, expect, it } from 'vitest';
import { resolvePerformerAgentName } from '../src/constants';

/**
 * 实机症状（T-a7）：团队派活时消息头显示 `rongying-tpl-78b62899`，
 * 而团队页里同一个 agent 叫「爆款内容教练」。
 *
 * 根因不是"没查到名字"，而是**名字的两个来源抢了优先级**：
 * 房间记录（`RoomPerformer.agentName`）是**派活那一刻写的快照**，历史上两处写入方
 * 都把裸 `agentId` 塞进了这个字段；而展示层把快照排在网关目录**前面** ⇒
 * 目录里的真名**永远轮不到**。conductor 那一支一直是目录优先（对的），
 * 只有 performer 这一支是反的 —— 所以问题只在 worker 身上显形。
 */
describe('resolvePerformerAgentName', () => {
  const performer = { agentId: 'rongying-tpl-78b62899', agentName: 'rongying-tpl-78b62899' };
  const catalog = { id: 'rongying-tpl-78b62899', name: '爆款内容教练' };

  it('⭐ 快照里存的是裸 agentId（存量数据就是这样）⇒ 用网关目录里的真名', () => {
    expect(resolvePerformerAgentName(performer, catalog)).toBe('爆款内容教练');
  });

  it('⭐ 快照里存的是旧名、目录里是改名后的 ⇒ 用目录（目录才是活的）', () => {
    expect(resolvePerformerAgentName({ agentId: 'a', agentName: '旧名字' }, { id: 'a', name: '新名字' })).toBe(
      '新名字',
    );
  });

  it('目录里查不到（agent 被删了）⇒ 退回快照，不至于什么都不显示', () => {
    expect(resolvePerformerAgentName({ agentId: 'gone', agentName: '被删掉的助手' }, undefined)).toBe('被删掉的助手');
  });

  it('目录与快照都没有 ⇒ 退回裸 agentId（宁可显示生 id，也不要空白）', () => {
    expect(resolvePerformerAgentName({ agentId: 'x', agentName: '' }, undefined)).toBe('x');
  });

  it('压根没有 performer 记录，但目录里有 ⇒ 用目录', () => {
    expect(resolvePerformerAgentName(undefined, catalog)).toBe('爆款内容教练');
  });

  it('目录条目的 name 是空串 ⇒ 继续往下退（空串不是名字）', () => {
    expect(resolvePerformerAgentName(performer, { id: 'x', name: '' })).toBe('rongying-tpl-78b62899');
  });

  it('什么都没有 ⇒ 空串，不炸', () => {
    expect(resolvePerformerAgentName(undefined, undefined)).toBe('');
  });
});
