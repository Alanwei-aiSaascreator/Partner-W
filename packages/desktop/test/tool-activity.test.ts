import type { ToolCall, ToolCallStatus } from '@clawwork/shared';
import { describe, expect, it } from 'vitest';
import { latestRunningCall, summarizeToolActivity } from '../src/renderer/lib/tool-activity';

function call(
  id: string,
  name: string,
  status: ToolCallStatus,
  startedAt = '2026-09-15T00:00:00.000Z',
  completedAt = '2026-09-15T00:00:01.000Z',
): ToolCall {
  return { id, name, status, startedAt, ...(status === 'running' ? {} : { completedAt }) };
}

describe('summarizeToolActivity', () => {
  it.each([
    ['', '2026-09-15T00:00:01.000Z'],
    ['invalid', '2026-09-15T00:00:01.000Z'],
    ['2026-09-15T00:00:01.164Z', '2026-09-15T00:00:01.145Z'],
  ])('does not display fabricated zero duration for invalid timing %s', (start, end) => {
    expect(summarizeToolActivity([call('1', 'agents_list', 'done', start, end)]).durationMs).toBeNull();
    expect(
      summarizeToolActivity([call('1', 'agents_list', 'done', start, end), call('2', 'ls', 'done')]).durationMs,
    ).toBeNull();
  });

  it('groups repeated tools into semantic activities', () => {
    const summary = summarizeToolActivity([
      call('1', 'ls', 'done'),
      call('2', 'list_directory', 'done'),
      call('3', 'exec', 'done'),
    ]);

    expect(summary.groups.map((group) => [group.kind, group.calls.length])).toEqual([
      ['listDirectory', 2],
      ['execute', 1],
    ]);
    expect(summary.completedCount).toBe(3);
    expect(summary.durationMs).toBe(1000);
  });

  it('keeps failed calls separate from successful calls', () => {
    const summary = summarizeToolActivity([call('1', 'ls', 'done'), call('2', 'ls', 'error')]);

    expect(summary.errorCount).toBe(1);
    expect(summary.groups.map((group) => group.status)).toEqual(['done', 'error']);
  });

  it('reports running work and safely classifies unknown tools', () => {
    const summary = summarizeToolActivity([call('1', 'mystery_tool', 'running')]);

    expect(summary.runningCount).toBe(1);
    expect(summary.durationMs).toBeNull();
    expect(summary.groups[0].kind).toBe('other');
  });

  it.each([
    ['read_file', 'readFile'],
    ['rg', 'search'],
    ['shell', 'execute'],
    ['apply_patch', 'writeFile'],
    ['browser.open', 'browseWeb'],
  ] as const)('classifies %s as %s', (name, kind) => {
    expect(summarizeToolActivity([call('1', name, 'done')]).groups[0].kind).toBe(kind);
  });
});

/**
 * 「此刻在跑哪一条」的**唯一出口**（§12）。
 *
 * 这个推导原来在**两处各写了一遍**（活动条 `ComposerActivity` 与工具汇总
 * `ToolCallSummary`）：都是 `[...calls].reverse().find(c => c.status === 'running')`。
 * 两处一字不差 ⇒ 迟早只改一处。收进来以后它可以被单测直接钉住。
 *
 * ⚠️ 它回答的是"**进行中**反馈该显示还是该收掉"—— 这个问题的四个相位都很容易写错：
 *    只显示不收（转圈永远不停）、失败不收（明明报错了还说在跑）、
 *    取消不收（那一轮已经作废了还挂着）。所以下面每一条都对着一个相位。
 */
describe('latestRunningCall —— 进行中反馈该显示谁', () => {
  it('还没开跑 ⇒ null（不显示"正在跑"）', () => {
    expect(latestRunningCall([])).toBeNull();
  });

  it('⭐ 开跑 ⇒ 就是它（"正在进行"要显示出来）', () => {
    const running = call('1', 'memory_search', 'running');
    expect(latestRunningCall([running])).toBe(running);
  });

  it('⭐ 结束了 ⇒ null（**收掉**，不能永远转圈）', () => {
    expect(latestRunningCall([call('1', 'memory_search', 'done')])).toBeNull();
  });

  it('⭐ 失败了 ⇒ null（失败了还显示"正在跑"，是在说谎）', () => {
    expect(latestRunningCall([call('1', 'memory_search', 'error')])).toBeNull();
  });

  it('⭐ 取**最近**一条，不是最早一条（长任务里前后会跑好几个）', () => {
    const first = call('1', 'ls', 'running');
    const second = call('2', 'memory_search', 'running');
    expect(latestRunningCall([first, second])).toBe(second);
  });

  it('已经被后面那条盖过的不算（结束的先来、新的一条在跑）', () => {
    const done = call('1', 'ls', 'done');
    const running = call('2', 'memory_search', 'running');
    expect(latestRunningCall([done, running])).toBe(running);
  });

  it('⚠️ 全是收尾态 ⇒ null（一轮跑完那一刻必须收掉）', () => {
    expect(latestRunningCall([call('1', 'ls', 'done'), call('2', 'exec', 'error')])).toBeNull();
  });

  it('不改动入参（纯函数，调用方常常是 React 的 render 路径）', () => {
    const calls = [call('1', 'ls', 'done'), call('2', 'exec', 'running')];
    const snapshot = calls.map((c) => c.id);
    latestRunningCall(calls);
    expect(calls.map((c) => c.id)).toEqual(snapshot);
  });
});
