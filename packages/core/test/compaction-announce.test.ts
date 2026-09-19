import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMessageStore } from '../src/stores/message-store';
import {
  COMPACTION_FALLBACK_MS,
  announceCompaction,
  currentCompactionEpisode,
  noteManualCompactionResult,
  runManualCompaction,
} from '../src/services/compaction-announce';

/**
 * 「会话已压缩」的**统一出口**（B8）。
 *
 * 这一层的职责是**去重与兜底**，所以每条断言都盯着"**恰好一条**"：
 * - 只认"真的压了"（`compacted === true`）—— `ok`、缺字段、字符串 `'true'` 都不算；
 * - 事件先到 ⇒ 兜底不许再报；
 * - 兜底报过 ⇒ 迟到的事件不许再报；
 * - 但**下一轮**压缩要能再说一次（去重按"轮"，不是按"会话"）。
 *
 * ⚠️ 轮次号而不是时间戳：这条规矩是**测试抓出来的** —— 最早用 `Date.now()` 当轮次标识，
 *    两轮压缩落在同一毫秒时，第二轮会被"同一轮只报一次"误杀。
 */

const SK = 'agent:main:clawwork:task:t1';
const TID = 'task-1';
const NOTICE = 'session.contextCompacted';

function setup() {
  const store = createMessageStore({ persistMessage: vi.fn().mockResolvedValue({ ok: true }) });
  const deps = { getStore: () => store.getState(), translate: (key: string) => key };
  const systemContents = (): string[] =>
    (store.getState().messagesByTask[TID] ?? []).filter((m) => m.role === 'system').map((m) => m.content);
  return { store, deps, systemContents };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('压缩播报：只认"真的压了"', () => {
  it('⭐ `compacted` 不是严格的 true ⇒ 不安排兜底（`ok`、缺字段、字符串 true 都不算）', () => {
    for (const bad of [undefined, null, false, 'true', 1]) {
      const { deps, systemContents } = setup();
      vi.useFakeTimers();

      const armed = noteManualCompactionResult(deps, { taskId: TID, sessionKey: SK, compacted: bad });
      vi.advanceTimersByTime(COMPACTION_FALLBACK_MS * 2);

      expect(armed, `compacted=${JSON.stringify(bad)} 不该被当成"压了"`).toBe(false);
      expect(systemContents(), `compacted=${JSON.stringify(bad)} 不该报`).toHaveLength(0);
      vi.useRealTimers();
    }
  });

  it('⭐ `compacted === true` 且**没等到**事件 ⇒ 等够兜底时长后报一次', () => {
    const { deps, systemContents } = setup();
    vi.useFakeTimers();

    expect(noteManualCompactionResult(deps, { taskId: TID, sessionKey: SK, compacted: true })).toBe(true);
    expect(systemContents(), '刚点完不该立刻报 —— 先等网关的事件').toHaveLength(0);

    vi.advanceTimersByTime(COMPACTION_FALLBACK_MS);
    expect(systemContents(), '等够了就兜底报一次').toEqual([NOTICE]);
  });

  it('⭐ 事件先到 ⇒ 兜底**不再**报（否则用户看到两条）', () => {
    const { deps, systemContents } = setup();
    vi.useFakeTimers();

    noteManualCompactionResult(deps, { taskId: TID, sessionKey: SK, compacted: true });
    // 网关的 sessions.changed 先到（同一轮）
    announceCompaction(deps, { taskId: TID, sessionKey: SK, episode: currentCompactionEpisode(deps, SK) });
    expect(systemContents()).toEqual([NOTICE]);

    vi.advanceTimersByTime(COMPACTION_FALLBACK_MS * 2);
    expect(systemContents(), '兜底那次必须被幂等挡掉').toEqual([NOTICE]);
  });

  it('⭐ 兜底先报 ⇒ **迟到的**事件不再报（这条顺序也要挡住）', () => {
    const { deps, systemContents } = setup();
    vi.useFakeTimers();

    noteManualCompactionResult(deps, { taskId: TID, sessionKey: SK, compacted: true });
    vi.advanceTimersByTime(COMPACTION_FALLBACK_MS);
    expect(systemContents()).toEqual([NOTICE]);

    // 事件迟到（同一轮）
    announceCompaction(deps, { taskId: TID, sessionKey: SK, episode: currentCompactionEpisode(deps, SK) });
    expect(systemContents(), '晚到的事件不许再说一遍').toEqual([NOTICE]);
  });

  it('⭐ 下一轮压缩要能再说一次（去重按"轮"，不是按会话）', () => {
    const { deps, systemContents } = setup();
    vi.useFakeTimers();

    // 第一轮
    noteManualCompactionResult(deps, { taskId: TID, sessionKey: SK, compacted: true });
    vi.advanceTimersByTime(COMPACTION_FALLBACK_MS);
    expect(systemContents()).toEqual([NOTICE]);

    // 第二轮（用户又点了一次）：**同一毫秒内**也不行 —— 这正是轮次号存在的理由
    noteManualCompactionResult(deps, { taskId: TID, sessionKey: SK, compacted: true });
    vi.advanceTimersByTime(COMPACTION_FALLBACK_MS);
    expect(systemContents(), '长会话会压缩多次，不能只报第一次').toEqual([NOTICE, NOTICE]);
  });

  it('取"当前轮次"在没开过时会**开一轮**（事件先到、start 没收到时用）', () => {
    const { deps, systemContents } = setup();

    const episode = currentCompactionEpisode(deps, SK);
    expect(episode, '没开过就要现开一轮，不能是 0（否则幂等会把它当成"已经报过"）').toBeGreaterThan(0);

    expect(announceCompaction(deps, { taskId: TID, sessionKey: SK, episode })).toBe(true);
    expect(systemContents()).toEqual([NOTICE]);
  });
});

/**
 * **手动压缩的共享入口**（B8）：两条 UI 路径（斜杠命令 / 右键菜单）都走它。
 *
 * ⚠️ 这一组盯的是那句老毛病的**反面**：从前"RPC 被接受"（`ok`）就被当成"压缩完成"，
 *    于是用户可能收到一句根本没压成的"会话已压缩"。
 */
describe('手动压缩共享入口：只认 compacted === true', () => {
  function depsWith(result: unknown) {
    const store = createMessageStore({ persistMessage: vi.fn().mockResolvedValue({ ok: true }) });
    const compactSession = vi.fn().mockResolvedValue(result);
    return {
      deps: { getStore: () => store.getState(), translate: (key: string) => key, compactSession },
      compactSession,
      systemContents: (): string[] =>
        (store.getState().messagesByTask[TID] ?? []).filter((m) => m.role === 'system').map((m) => m.content),
    };
  }

  it('⭐ RPC 成功且真的压了 ⇒ 走统一出口，等够兜底时长后报一次', async () => {
    const { deps, systemContents } = depsWith({ ok: true, result: { compacted: true } });
    vi.useFakeTimers();

    await expect(runManualCompaction(deps, { gatewayId: 'gw-1', sessionKey: SK, taskId: TID })).resolves.toBe(true);
    expect(systemContents(), '先等网关的事件').toHaveLength(0);

    vi.advanceTimersByTime(COMPACTION_FALLBACK_MS);
    expect(systemContents()).toEqual([NOTICE]);
  });

  it('⭐ RPC 成功但**没真压成** ⇒ 一条都不报（"被接受"不等于"压完了"）', async () => {
    for (const result of [{ ok: true, result: { compacted: false, reason: 'no transcript' } }, { ok: true }]) {
      const { deps, systemContents } = depsWith(result);
      vi.useFakeTimers();

      await expect(runManualCompaction(deps, { gatewayId: 'gw-1', sessionKey: SK, taskId: TID })).resolves.toBe(true);
      vi.advanceTimersByTime(COMPACTION_FALLBACK_MS * 2);

      expect(systemContents(), `${JSON.stringify(result)} 不该报`).toHaveLength(0);
      vi.useRealTimers();
    }
  });

  it('RPC 本身就失败 ⇒ 返回 false、不报', async () => {
    const { deps, systemContents } = depsWith({ ok: false, error: 'gateway busy' });
    vi.useFakeTimers();

    await expect(runManualCompaction(deps, { gatewayId: 'gw-1', sessionKey: SK, taskId: TID })).resolves.toBe(false);
    vi.advanceTimersByTime(COMPACTION_FALLBACK_MS * 2);
    expect(systemContents()).toHaveLength(0);
  });

  it('入参原样传给 RPC（gatewayId / sessionKey 不能被调换）', async () => {
    const { deps, compactSession } = depsWith({ ok: true, result: { compacted: true } });
    vi.useFakeTimers();

    await runManualCompaction(deps, { gatewayId: 'gw-9', sessionKey: SK, taskId: TID });
    expect(compactSession).toHaveBeenCalledWith('gw-9', SK);
    vi.advanceTimersByTime(COMPACTION_FALLBACK_MS);
  });
});
