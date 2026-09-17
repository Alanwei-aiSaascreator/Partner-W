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
    first.getState().setActiveModule('market');
    first.getState().installTemplate('tpl-content');
    first.getState().checkIn();

    const restarted = createBetaStore(storage);
    expect(restarted.getState().activeModule).toBe('market');
    expect(restarted.getState().installedTemplateIds).toContain('tpl-content');
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
    // 其余模块一个都不能少
    expect(keys).toEqual(
      expect.arrayContaining([
        'market',
        'bounty',
        'creator',
        'game',
        'operations',
        'updates',
        'analytics',
        'compliance',
      ]),
    );
  });

  it('supports the minimum bounty and creator publishing state flows', () => {
    const store = createBetaStore(storage);
    store.getState().publishBounty('整理销售日报');
    const bounty = store.getState().bounties.at(-1)!;
    store.getState().claimBounty(bounty.id);
    store.getState().submitBounty(bounty.id);
    expect(store.getState().bounties.at(-1)?.status).toBe('submitted');

    store.getState().createCreatorTemplate('复盘助手');
    const template = store.getState().creatorTemplates.at(-1)!;
    store.getState().toggleCreatorPublished(template.id);
    expect(store.getState().creatorTemplates.at(-1)?.status).toBe('published');
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

    store.getState().installTemplate('tpl-content');
    store.getState().installTemplate('tpl-content');
    store.getState().checkIn();
    store.getState().checkIn();
    store.getState().publishBounty('真实内容不会进入埋点');

    const events = store.getState().events;
    expect(events.filter((event) => event.type === 'template_installed')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'daily_check_in')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'bounty_published')).toHaveLength(1);
    expect(events.every((event) => Number.isFinite(Date.parse(event.timestamp)))).toBe(true);
    const serializedEvents = JSON.stringify(events);
    for (const forbidden of ['phone', 'licenseKey', 'token', 'prompt', 'content']) {
      expect(serializedEvents).not.toContain(`"${forbidden}"`);
    }
  });

  it('derives analytics from the explicit seed baseline and local events', () => {
    const store = createBetaStore(storage);
    const baseline = store.getState().analytics.activation;
    store.getState().installTemplate('tpl-content');
    store.getState().createCreatorTemplate('复盘助手');
    const analytics = store.getState().analyticsSummary();
    expect(analytics.activation).toBe(baseline + 1);
    expect(analytics.artifact).toBe(store.getState().analytics.artifact + 1);
  });
});
