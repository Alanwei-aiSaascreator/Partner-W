import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IpcResult } from '@clawwork/shared';
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

  /**
   * 🔴 2026-10-16（BUG-097 / E1 复核）：**事件先于 RPC 返回**。
   *
   * 网关侧 `sessions.compact` 的 `sessions.changed` 与 RPC 回包走**同一条 ws 连接**，
   * 合法的同批 FIFO 收包下，渲染器**可能先处理事件、后恢复 `invoke` 的 await**
   *（可达性已由真实 ws Receiver / Electron IPC 夹具证明）。
   *
   * 从前的时序：事件那条 `currentCompactionEpisode` 现开**第 1 轮**并播报；
   * RPC 返回后 `noteManualCompactionResult` 又开**第 2 轮** ⇒ 兜底再播一次，
   * **一次压缩用户看到两条**。
   *
   * 修法：这次压缩的**身份在发 RPC 之前**就定下来，事件与回包都归到它上面。
   */
  it('🔴 事件早于 RPC 返回（同批时序）⇒ 同一次压缩只报一条', async () => {
    const store = createMessageStore({ persistMessage: vi.fn().mockResolvedValue({ ok: true }) });
    const deps = { getStore: () => store.getState(), translate: (key: string) => key };
    let release: (value: IpcResult) => void = () => {};
    const compactSession = vi.fn((): Promise<IpcResult> => new Promise((resolve) => (release = resolve)));
    const systemContents = (): string[] =>
      (store.getState().messagesByTask[TID] ?? []).filter((m) => m.role === 'system').map((m) => m.content);
    vi.useFakeTimers();

    const pending = runManualCompaction(
      { ...deps, compactSession },
      { gatewayId: 'gw-1', sessionKey: SK, taskId: TID },
    );
    // RPC 还在途 ⇒ 网关的事件先到（这正是同批 FIFO 下的真实顺序）
    announceCompaction(deps, { taskId: TID, sessionKey: SK, episode: currentCompactionEpisode(deps, SK) });
    expect(systemContents(), '事件那条先报了一次').toEqual([NOTICE]);

    release({ ok: true, result: { compacted: true } });
    await pending;
    vi.advanceTimersByTime(COMPACTION_FALLBACK_MS * 2);
    expect(systemContents(), '同一次压缩只能有一条（兜底那次必须被幂等挡掉）').toEqual([NOTICE]);
  });

  it('🔴 事件早于 RPC 返回时，事件与回包落在**同一个身份**上（不是各开一轮）', async () => {
    const store = createMessageStore({ persistMessage: vi.fn().mockResolvedValue({ ok: true }) });
    const deps = { getStore: () => store.getState(), translate: (key: string) => key };
    let release: (value: IpcResult) => void = () => {};
    const compactSession = vi.fn((): Promise<IpcResult> => new Promise((resolve) => (release = resolve)));
    vi.useFakeTimers();

    const pending = runManualCompaction(
      { ...deps, compactSession },
      { gatewayId: 'gw-1', sessionKey: SK, taskId: TID },
    );
    // 发 RPC 之前身份就该定下来 ⇒ 事件读到的是它，而不是事件自己现开的一轮
    const beforeReply = currentCompactionEpisode(deps, SK);
    release({ ok: true, result: { compacted: true } });
    await pending;
    expect(store.getState().compactionEpisodeBySession[SK], '回包不许再开新一轮（否则兜底会算到新身份上）').toBe(
      beforeReply,
    );
    vi.advanceTimersByTime(COMPACTION_FALLBACK_MS * 2);
  });

  it('🔴 跨会话不串归属：两个会话各自压缩一次，各报一条', async () => {
    const store = createMessageStore({ persistMessage: vi.fn().mockResolvedValue({ ok: true }) });
    const deps = { getStore: () => store.getState(), translate: (key: string) => key };
    const OTHER = 'agent:main:clawwork:task:t2';
    const contents = (sk: string): string[] =>
      (store.getState().messagesByTask[TID] ?? [])
        .filter((m) => m.role === 'system' && m.sessionKey === sk)
        .map((m) => m.content);
    vi.useFakeTimers();

    await runManualCompaction(
      { ...deps, compactSession: vi.fn().mockResolvedValue({ ok: true, result: { compacted: true } }) },
      { gatewayId: 'gw-1', sessionKey: SK, taskId: TID },
    );
    await runManualCompaction(
      { ...deps, compactSession: vi.fn().mockResolvedValue({ ok: true, result: { compacted: true } }) },
      { gatewayId: 'gw-1', sessionKey: OTHER, taskId: TID },
    );
    vi.advanceTimersByTime(COMPACTION_FALLBACK_MS);

    expect(contents(SK), 'SK 一条').toEqual([NOTICE]);
    expect(contents(OTHER), '另一个会话也要有自己的那一条').toEqual([NOTICE]);
  });

  it('🔴 RPC 失败（未开成一个身份）后，迟到的事件仍只报一条', async () => {
    const store = createMessageStore({ persistMessage: vi.fn().mockResolvedValue({ ok: true }) });
    const deps = { getStore: () => store.getState(), translate: (key: string) => key };
    const systemContents = (): string[] =>
      (store.getState().messagesByTask[TID] ?? []).filter((m) => m.role === 'system').map((m) => m.content);
    vi.useFakeTimers();

    await runManualCompaction(
      { ...deps, compactSession: vi.fn().mockResolvedValue({ ok: false, error: 'gateway busy' }) },
      { gatewayId: 'gw-1', sessionKey: SK, taskId: TID },
    );
    vi.advanceTimersByTime(COMPACTION_FALLBACK_MS * 2);
    expect(systemContents(), 'RPC 失败本身不报').toHaveLength(0);

    // 网关其实压了，事件后来到 ⇒ 报一次（不能因为回包失败就漏报，也不能报两次）
    announceCompaction(deps, { taskId: TID, sessionKey: SK, episode: currentCompactionEpisode(deps, SK) });
    vi.advanceTimersByTime(COMPACTION_FALLBACK_MS * 2);
    expect(systemContents()).toEqual([NOTICE]);
  });
});
