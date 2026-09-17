import { beforeEach, describe, expect, it } from 'vitest';
import { BETA_MODULES, createBetaStore, type BetaStorage } from '../src/renderer/features/internal-beta/beta-store';

function memoryStorage(): BetaStorage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
}

describe('internal beta store', () => {
  let storage: BetaStorage;

  beforeEach(() => {
    storage = memoryStorage();
  });

  it('persists the selected module and demo mutations across a restart', () => {
    const first = createBetaStore(storage);
    first.getState().setActiveModule('bounty');
    first.getState().publishBounty('整理销售日报');
    first.getState().checkIn();

    const restarted = createBetaStore(storage);
    expect(restarted.getState().activeModule).toBe('bounty');
    expect(restarted.getState().bounties.some((b) => b.title === '整理销售日报')).toBe(true);
    expect(restarted.getState().game.checkedInToday).toBe(true);
  });

  /**
   * 广场与团队已经**毕业**到主界面（真后端：迁移 35–38 + CommunityPanel）。
   * 内测中心不能再列它们 —— 列着就又是一份假实现，而且和真功能同名，
   * 用户分不清点进去的是哪一个。
   */
  it('广场和团队已毕业到主界面，内测中心不再列出它们', () => {
    const keys = BETA_MODULES.map((module) => module.id);
    expect(keys).not.toContain('square');
    expect(keys).not.toContain('team');
    // P2 之后：助手市场与创作者中心也毕业了（真实现在主界面的「助手市场」面板）
    expect(keys).not.toContain('market');
    expect(keys).not.toContain('creator');
    // 其余模块一个都不能少
    expect(keys).toEqual(
      expect.arrayContaining(['bounty', 'game', 'operations', 'updates', 'analytics', 'compliance']),
    );
  });

  it('supports the minimum bounty flow', () => {
    const store = createBetaStore(storage);
    store.getState().publishBounty('整理销售日报');
    const bounty = store.getState().bounties.at(-1)!;
    store.getState().claimBounty(bounty.id);
    store.getState().submitBounty(bounty.id);
    expect(store.getState().bounties.at(-1)?.status).toBe('submitted');
  });

  it('resets all demo changes to the versioned seed', () => {
    const store = createBetaStore(storage);
    store.getState().publishBounty('今天完成内测框架');
    store.getState().adjustCredits(500);
    store.getState().resetDemo();

    expect(store.getState().bounties.some((item) => item.title === '今天完成内测框架')).toBe(false);
    expect(store.getState().operations.credits).toBe(5000);
  });

  it('covers the remaining operations and compliance actions', () => {
    const store = createBetaStore(storage);

    store.getState().toggleModel();
    store.getState().setModelRate(1.5);
    store.getState().setAnnouncement('今晚升级');
    expect(store.getState().operations).toMatchObject({
      modelEnabled: false,
      modelRate: 1.5,
      announcement: '今晚升级',
    });

    store.getState().agreeCompliance();
    store.getState().requestDataExport();
    store.getState().requestDeletion();
    expect(store.getState().compliance).toEqual({ agreed: true, exportRequested: true, deletionRequested: true });
  });

  it('records bounded redacted events and rejects empty user content', () => {
    const store = createBetaStore(storage);
    expect(store.getState().publishBounty('   ')).toBe(false);

    store.getState().checkIn();
    store.getState().checkIn();
    store.getState().publishBounty('真实内容不会进入埋点');
    store.getState().publishBounty('再来一条');

    const events = store.getState().events;
    expect(events.filter((event) => event.type === 'bounty_published')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'daily_check_in')).toHaveLength(1);
    expect(events.every((event) => Number.isFinite(Date.parse(event.timestamp)))).toBe(true);
    const serializedEvents = JSON.stringify(events);
    for (const forbidden of ['phone', 'licenseKey', 'token', 'prompt', 'content']) {
      expect(serializedEvents).not.toContain(`"${forbidden}"`);
    }
  });

  it('derives analytics from the explicit seed baseline and local events', () => {
    const store = createBetaStore(storage);
    const baseline = store.getState().analytics.launch;
    store.getState().setActiveModule('bounty');
    const analytics = store.getState().analyticsSummary();
    // 只剩 module_opened → launch 这条映射了（市场/创作者毕业后，它们的映射也删了）
    expect(analytics.launch).toBe(baseline + 1);
  });
});
