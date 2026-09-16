import { beforeEach, describe, expect, it } from 'vitest';
import { createBetaStore, type BetaStorage } from '../src/renderer/features/internal-beta/beta-store';

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
    first.getState().createTeam('增长实验组');
    first.getState().installTemplate('tpl-content');
    first.getState().checkIn();

    const restarted = createBetaStore(storage);
    expect(restarted.getState().activeModule).toBe('market');
    expect(restarted.getState().team?.name).toBe('增长实验组');
    expect(restarted.getState().installedTemplateIds).toContain('tpl-content');
    expect(restarted.getState().game.checkedInToday).toBe(true);
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
    store.getState().createTeam('临时团队');
    store.getState().publishPost('今天完成内测框架');
    store.getState().adjustCredits(500);
    store.getState().resetDemo();

    expect(store.getState().team).toBeNull();
    expect(store.getState().feed.some((post) => post.content === '今天完成内测框架')).toBe(false);
    expect(store.getState().operations.credits).toBe(5000);
  });

  it('covers the remaining social, operations, and compliance actions', () => {
    const store = createBetaStore(storage);
    store.getState().joinTeam('RY778899');
    expect(store.getState().team?.members).toHaveLength(2);
    store.getState().leaveTeam();
    expect(store.getState().team).toBeNull();

    store.getState().publishPost('内测反馈');
    const post = store.getState().feed[0]!;
    store.getState().likePost(post.id);
    store.getState().commentPost(post.id, '已记录');
    expect(store.getState().feed[0]).toMatchObject({ likes: 1, comments: ['已记录'] });

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
    const initialFeedLength = store.getState().feed.length;
    expect(store.getState().publishPost('   ')).toBe(false);
    expect(store.getState().feed).toHaveLength(initialFeedLength);

    store.getState().installTemplate('tpl-content');
    store.getState().installTemplate('tpl-content');
    store.getState().checkIn();
    store.getState().checkIn();
    store.getState().publishPost('真实内容不会进入埋点');

    const events = store.getState().events;
    expect(events.filter((event) => event.type === 'template_installed')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'daily_check_in')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'post_published')).toHaveLength(1);
    expect(events.every((event) => Number.isFinite(Date.parse(event.timestamp)))).toBe(true);
    const serializedEvents = JSON.stringify(events);
    for (const forbidden of ['phone', 'licenseKey', 'token', 'prompt', 'content']) {
      expect(serializedEvents).not.toContain(`"${forbidden}"`);
    }
  });

  it('derives analytics from the explicit seed baseline and local events', () => {
    const store = createBetaStore(storage);
    const baseline = store.getState().analytics.chat;
    store.getState().publishPost('内测动态');
    store.getState().installTemplate('tpl-content');
    const analytics = store.getState().analyticsSummary();
    expect(analytics.chat).toBe(baseline + 1);
    expect(analytics.activation).toBe(store.getState().analytics.activation + 1);
  });
});
