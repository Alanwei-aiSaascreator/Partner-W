import { describe, expect, it, vi } from 'vitest';
import { MAX_ROUNDTABLE_SPEAKERS, runRoundtable } from '../src/renderer/lib/team-roundtable-runner';
import type { Speaker } from '../src/renderer/lib/team-roundtable';

const sp = (agentId: string, position: string, name?: string): Speaker => ({
  agentId,
  name: name ?? agentId,
  position: position as Speaker['position'],
});

const speakers: Speaker[] = [
  sp('m', 'moderator', '主持人'),
  sp('e', 'expert', '领域专家'),
  sp('s', 'scribe', '记录员'),
];

/** 从拼好的提示里把"前序发言"的正文抽出来（用来判断这一位看到了谁的话）。 */
const priorSeen = (prompt: string): string[] => [...prompt.matchAll(/— .+?：(.+)/g)].map((m) => m[1] ?? '');

/**
 * 圆桌运行器（2026-09-20）。
 *
 * ⚠️ **刻意串行**。并行的话"后一位看到前一位"根本不成立；而且额度是 org 级共享池、
 *    relay 没有并发闸门 ⇒ 并行 N 个会把超支上界抬到 N 倍，先烧的还会饿死后面的。
 *
 * `send` 是**注入**的："发出去并等到这一轮真的结束"怎么实现由调用方决定
 * （真身见 `hooks/useTeamRoundtable.ts`：等 `lifecycle.end`）。这样这一段最容易
 * 写错的顺序逻辑可以被直接测掉，不用起网关。
 */
describe('runRoundtable', () => {
  it('⭐ 串行：第 2 位发出时，第 1 位的正文已经拿到手', async () => {
    const seen: string[][] = [];
    const send = vi.fn(async (agentId: string, prompt: string) => {
      seen.push(priorSeen(prompt));
      return `来自 ${agentId} 的发言`;
    });

    await runRoundtable({ question: 'Q', speakers, send });

    expect(send).toHaveBeenCalledTimes(3);
    expect(seen[0]).toEqual([]); // 主持人没人可看
    expect(seen[1]).toEqual(['来自 m 的发言']); // 领域专家看得到主持人
    expect(seen[2]).toEqual(['来自 m 的发言', '来自 e 的发言']); // 记录员看得到前两位
  });

  it('⭐ 发言顺序按职位，不按传入顺序', async () => {
    const order: string[] = [];
    const send = vi.fn(async (agentId: string) => {
      order.push(agentId);
      return 'x';
    });
    await runRoundtable({ question: 'Q', speakers: [speakers[2]!, speakers[0]!, speakers[1]!], send });
    expect(order).toEqual(['m', 'e', 's']);
  });

  it('把每一轮的发言按顺序回调出去（界面要按顺序显示）', async () => {
    const onTurn = vi.fn();
    await runRoundtable({ question: 'Q', speakers, send: async (a) => `t-${a}`, onTurn });
    expect(onTurn.mock.calls.map((c) => c[0].agentId)).toEqual(['m', 'e', 's']);
    expect(onTurn.mock.calls.map((c) => c[1])).toEqual([0, 1, 2]);
  });

  it('⚠️ 第 2 位失败 ⇒ 停在他那里，不再往下发（不能拿半截讨论去汇总）', async () => {
    const send = vi.fn(async (agentId: string) => {
      if (agentId === 'e') throw new Error('boom');
      return 'x';
    });
    const r = await runRoundtable({ question: 'Q', speakers, send });

    expect(send).toHaveBeenCalledTimes(2);
    expect(r.stoppedAt).toBe('e');
    expect(r.turns).toHaveLength(1);
  });

  it('⚠️ 用户中途停止 ⇒ 立刻不再往下发', async () => {
    let stop = false;
    const send = vi.fn(async (agentId: string) => {
      if (agentId === 'e') stop = true;
      return 'x';
    });
    const r = await runRoundtable({ question: 'Q', speakers, send, shouldStop: () => stop });

    expect(send).toHaveBeenCalledTimes(2);
    expect(r.stoppedByUser).toBe(true);
    expect(r.turns).toHaveLength(2);
  });

  it('已经在停止状态 ⇒ 一位都不发', async () => {
    const send = vi.fn(async () => 'x');
    const r = await runRoundtable({ question: 'Q', speakers, send, shouldStop: () => true });
    expect(send).not.toHaveBeenCalled();
    expect(r.stoppedByUser).toBe(true);
  });

  it('⭐ 超过 4 位直接拒绝 —— 积分消耗随人数线性涨，4 是能承受的上限', async () => {
    const many = [sp('a', 'expert'), sp('b', 'expert'), sp('c', 'expert'), sp('d', 'expert'), sp('e', 'expert')];
    const send = vi.fn(async () => 'x');

    await expect(runRoundtable({ question: 'Q', speakers: many, send })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(MAX_ROUNDTABLE_SPEAKERS).toBe(4);
  });

  it('刚好 4 位是允许的（边界不能一刀切成 3）', async () => {
    const four = [sp('a', 'expert'), sp('b', 'expert'), sp('c', 'expert'), sp('d', 'expert')];
    const send = vi.fn(async () => 'x');
    const r = await runRoundtable({ question: 'Q', speakers: four, send });
    expect(send).toHaveBeenCalledTimes(4);
    expect(r.turns).toHaveLength(4);
  });

  it('没人发言时不调 send，也不炸', async () => {
    const send = vi.fn(async () => 'x');
    const r = await runRoundtable({ question: 'Q', speakers: [], send });
    expect(send).not.toHaveBeenCalled();
    expect(r.turns).toEqual([]);
  });
});
