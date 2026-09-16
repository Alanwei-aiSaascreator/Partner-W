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

  it('covers the remaining social, operations, update, and compliance actions', () => {
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

    store.getState().checkUpdate();
    store.getState().advanceUpdate();
    store.getState().advanceUpdate();
    expect(store.getState().update).toMatchObject({ status: 'installed', current: '1.0.1-beta' });
    store.getState().rollbackUpdate();
    expect(store.getState().update.status).toBe('rolledBack');

    store.getState().agreeCompliance();
    store.getState().requestDataExport();
    store.getState().requestDeletion();
    expect(store.getState().compliance).toEqual({ agreed: true, exportRequested: true, deletionRequested: true });
  });
});
