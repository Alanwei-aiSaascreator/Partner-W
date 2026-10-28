import { describe, expect, it } from 'vitest';
import { mostRecentTaskIdForAgent, resolveTaskAgentId, visibleTasksForAgent } from '../src/renderer/lib/task-sort';

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
 * 而 `selectedAgentByGateway['local-runtime'] = 'partner-w-content'` ⇒ `visibleTasks = []`。
 * 用户看到的就是"聊天记录没了"——**数据一直在库里**。
 *
 * 会话键里带着真身（`agent:<agentId>:…`）且**是落库的**（`tasks.session_key`）⇒ 拿它兜底。
 */
type V = {
  id: string;
  status: string;
  agentId?: string;
  sessionKey: string;
  updatedAt: string;
  pinnedAt?: string;
  gatewayId?: string;
};

const t = (id: string, sessionKey: string, extra: Partial<V> = {}): V => ({
  id,
  status: 'active',
  sessionKey,
  updatedAt: '2026-09-20T00:00:00Z',
  ...extra,
});

const CONTENT = 'agent:partner-w-content:clawwork:dev1:task:t1';
const RESEARCH = 'agent:partner-w-research:clawwork:dev1:task:t2';

describe('resolveTaskAgentId —— 归属哪个助手', () => {
  it('⭐ 库里读回来的（没有 agentId）⇒ 按 sessionKey 推断', () => {
    expect(resolveTaskAgentId(t('a', CONTENT))).toBe('partner-w-content');
  });

  it('有显式 agentId ⇒ 以它为准（哪怕是空串也走推断）', () => {
    expect(resolveTaskAgentId(t('a', RESEARCH, { agentId: 'partner-w-content' }))).toBe('partner-w-content');
    expect(resolveTaskAgentId(t('a', RESEARCH, { agentId: '' }))).toBe('partner-w-research');
  });

  it('会话键认不出助手 ⇒ `main`（不消失，只是归到默认助手名下）', () => {
    expect(resolveTaskAgentId(t('a', 'clawwork:dev1:task:t9'))).toBe('main');
  });
});

describe('visibleTasksForAgent —— 侧栏该显示哪些', () => {
  it('⭐ 43 个没有 agentId 的库任务不该被"整片滤掉"（原 bug：一个都不露脸）', () => {
    const tasks = [t('a', CONTENT), t('b', CONTENT), t('c', RESEARCH), t('d', 'clawwork:dev1:task:t9')];

    const visible = visibleTasksForAgent(tasks, 'partner-w-content');

    expect(visible.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('别的助手的任务不露脸（这正是那条过滤的本意）', () => {
    expect(visibleTasksForAgent([t('c', RESEARCH)], 'partner-w-content')).toHaveLength(0);
  });

  it('归档的不露脸（否则归档等于没归档）', () => {
    expect(visibleTasksForAgent([t('a', CONTENT, { status: 'archived' })], 'partner-w-content')).toHaveLength(0);
  });

  it('没选助手（空串）⇒ 不看归属，全都露脸（归档的除外）', () => {
    const tasks = [t('a', CONTENT), t('b', RESEARCH), t('c', CONTENT, { status: 'archived' })];

    expect(visibleTasksForAgent(tasks, '').map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('⭐ 不改原数组（store 里的数组不能被就地改）', () => {
    const tasks = [t('a', RESEARCH)];

    visibleTasksForAgent(tasks, 'partner-w-content');

    expect(tasks.map((x) => x.id)).toEqual(['a']);
  });
});

/**
 * 「切回某个助手时，主区该显示哪一段对话」。
 *
 * ## 为什么要有这条（同事真机反馈 ②「来回切换管家内容会丢失（不知道在哪里找到）」）
 *
 * 2026-09-25 真机复核定性：**内容没丢**（任务全在「最近任务」里），丢的是**回去的路** ——
 * 切换助手的那个 hook 无条件 `setActiveTask(null)`，于是切回来是一片欢迎屏。
 *
 * 归属判定与 `visibleTasksForAgent` **共用同一条规则**（`resolveTaskAgentId`：
 * 显式 `agentId` 优先，否则从 `session_key` 推断）—— 理由见上面那条 describe：
 * **库里读回来的任务 `agentId` 是 undefined**，只看 `agentId` 会一条都匹配不上。
 *
 * ⚠️ **置顶不参与这个判断**（下面有一条专门钉它）：这里问的是"我上次跟它说到哪了"，
 * 是**时间**问题；置顶是"这条我想随手够得着"，是**收藏**问题。两者混在一起会出怪事 ——
 * 刚跟它聊完 A、切走再切回，却因为 B 是置顶而撞进 B。
 */
describe('mostRecentTaskIdForAgent —— 切回这个助手该回到哪次对话', () => {
  const NEWER = '2026-09-20T10:00:00Z';
  const OLDER = '2026-09-01T00:00:00Z';

  it('⭐ 回到这个助手最近更新过的那条', () => {
    const tasks = [t('旧', CONTENT, { updatedAt: OLDER }), t('新', CONTENT, { updatedAt: NEWER })];

    expect(mostRecentTaskIdForAgent(tasks, 'partner-w-content')).toBe('新');
  });

  it('别的助手的对话不抢（哪怕它更新更近）', () => {
    const tasks = [t('我的', CONTENT, { updatedAt: OLDER }), t('别人的', RESEARCH, { updatedAt: NEWER })];

    expect(mostRecentTaskIdForAgent(tasks, 'partner-w-content')).toBe('我的');
  });

  it('⭐ 归属照样按 sessionKey 推断（库里读回来的没有 agentId —— 与上面那条同一个坑）', () => {
    expect(mostRecentTaskIdForAgent([t('库任务', CONTENT, { updatedAt: NEWER })], 'partner-w-content')).toBe('库任务');
  });

  it('归档的不算（否则切回来会撞开一个已经归档的对话）', () => {
    const tasks = [
      t('还在的', CONTENT, { updatedAt: OLDER }),
      t('归档的', CONTENT, { status: 'archived', updatedAt: NEWER }),
    ];

    expect(mostRecentTaskIdForAgent(tasks, 'partner-w-content')).toBe('还在的');
  });

  it('⭐ 置顶不参与：“上次跟它说话”问的是时间，不是收藏', () => {
    const tasks = [
      t('置顶的', CONTENT, { updatedAt: OLDER, pinnedAt: '2026-09-21T00:00:00Z' }),
      t('刚聊过的', CONTENT, { updatedAt: NEWER }),
    ];

    expect(mostRecentTaskIdForAgent(tasks, 'partner-w-content')).toBe('刚聊过的');
  });

  it('它还没有对话 ⇒ null（回欢迎屏，不许随便挑一条别人的）', () => {
    expect(mostRecentTaskIdForAgent([t('别人的', RESEARCH)], 'partner-w-content')).toBeNull();
    expect(mostRecentTaskIdForAgent([], 'partner-w-content')).toBeNull();
  });

  it('只剩归档的 ⇒ 也是 null（归档等于说“别再自动撞开它”）', () => {
    expect(mostRecentTaskIdForAgent([t('归档的', CONTENT, { status: 'archived' })], 'partner-w-content')).toBeNull();
  });

  it('没给出助手（空串）⇒ null（空串不是“谁都要”，与 visibleTasksForAgent 的语义**不同**）', () => {
    expect(mostRecentTaskIdForAgent([t('a', CONTENT)], '')).toBeNull();
  });

  it('不改原数组', () => {
    const tasks = [t('a', CONTENT, { updatedAt: OLDER }), t('b', CONTENT, { updatedAt: NEWER })];

    mostRecentTaskIdForAgent(tasks, 'partner-w-content');

    expect(tasks.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('⭐ 网关**不**参与判断（只在**归属**上跟界面对齐，别顺手加一层网关过滤）', () => {
    // 理由：任务列表本来就不按网关过滤（`filterTasksForPanel` 只看状态与标题），
    // 而且 `tasks.gateway_id` 有 `DEFAULT ''` —— 拿它当判据会重演
    // 「43 个任务没有 agentId ⇒ 整片失配」那次（见本文件顶部）。多网关是例外形态，
    // 真要收紧，先想清楚老行怎么办。
    const tasks = [t('别的网关的', CONTENT, { updatedAt: NEWER, gatewayId: 'gw-9' })];

    expect(mostRecentTaskIdForAgent(tasks, 'partner-w-content')).toBe('别的网关的');
  });
});
