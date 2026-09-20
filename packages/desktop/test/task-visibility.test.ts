import { describe, expect, it } from 'vitest';
import { resolveTaskAgentId, visibleTasksForAgent } from '../src/renderer/lib/task-sort';

/**
 * 侧栏"这个任务该不该露脸"。
 *
 * ## 为什么单钉这一条（2026-09-20 用户报障：「聊天记录咋找不到」）
 *
 * 本地 `tasks` 表**没有 `agent_id` 列**（`db/index.ts` 只给 `messages` 加过它），
 * 所以**从库里读回来的任务 `agentId` 是 undefined**。而侧栏原判据是
 * `task.agentId === 当前助手` ⇒ 一个都匹配不上 ⇒ **侧栏整片空**。
 *
 * 实测（dev 客户端，CDP 直接读 store）：store 里 **43 个任务、43 个都没有 agentId**，
 * 而 `selectedAgentByGateway['local-runtime'] = 'rongying-content'` ⇒ `visibleTasks = []`。
 * 用户看到的就是"聊天记录没了"——**数据一直在库里**。
 *
 * 会话键里带着真身（`agent:<agentId>:…`）且**是落库的**（`tasks.session_key`）⇒ 拿它兜底。
 */
type V = { id: string; status: string; agentId?: string; sessionKey: string };

const t = (id: string, sessionKey: string, extra: Partial<V> = {}): V => ({
  id,
  status: 'active',
  sessionKey,
  ...extra,
});

const CONTENT = 'agent:rongying-content:clawwork:dev1:task:t1';
const RESEARCH = 'agent:rongying-research:clawwork:dev1:task:t2';

describe('resolveTaskAgentId —— 归属哪个助手', () => {
  it('⭐ 库里读回来的（没有 agentId）⇒ 按 sessionKey 推断', () => {
    expect(resolveTaskAgentId(t('a', CONTENT))).toBe('rongying-content');
  });

  it('有显式 agentId ⇒ 以它为准（哪怕是空串也走推断）', () => {
    expect(resolveTaskAgentId(t('a', RESEARCH, { agentId: 'rongying-content' }))).toBe('rongying-content');
    expect(resolveTaskAgentId(t('a', RESEARCH, { agentId: '' }))).toBe('rongying-research');
  });

  it('会话键认不出助手 ⇒ `main`（不消失，只是归到默认助手名下）', () => {
    expect(resolveTaskAgentId(t('a', 'clawwork:dev1:task:t9'))).toBe('main');
  });
});

describe('visibleTasksForAgent —— 侧栏该显示哪些', () => {
  it('⭐ 43 个没有 agentId 的库任务不该被"整片滤掉"（原 bug：一个都不露脸）', () => {
    const tasks = [t('a', CONTENT), t('b', CONTENT), t('c', RESEARCH), t('d', 'clawwork:dev1:task:t9')];

    const visible = visibleTasksForAgent(tasks, 'rongying-content');

    expect(visible.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('别的助手的任务不露脸（这正是那条过滤的本意）', () => {
    expect(visibleTasksForAgent([t('c', RESEARCH)], 'rongying-content')).toHaveLength(0);
  });

  it('归档的不露脸（否则归档等于没归档）', () => {
    expect(visibleTasksForAgent([t('a', CONTENT, { status: 'archived' })], 'rongying-content')).toHaveLength(0);
  });

  it('没选助手（空串）⇒ 不看归属，全都露脸（归档的除外）', () => {
    const tasks = [t('a', CONTENT), t('b', RESEARCH), t('c', CONTENT, { status: 'archived' })];

    expect(visibleTasksForAgent(tasks, '').map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('⭐ 不改原数组（store 里的数组不能被就地改）', () => {
    const tasks = [t('a', RESEARCH)];

    visibleTasksForAgent(tasks, 'rongying-content');

    expect(tasks.map((x) => x.id)).toEqual(['a']);
  });
});
