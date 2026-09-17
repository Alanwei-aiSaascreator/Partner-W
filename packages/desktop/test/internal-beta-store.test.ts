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
    first.getState().setActiveModule('operations');
    first.getState().setAnnouncement('今晚升级');
    first.getState().adjustCredits(500);

    const restarted = createBetaStore(storage);
    expect(restarted.getState().activeModule).toBe('operations');
    expect(restarted.getState().operations.announcement).toBe('今晚升级');
    expect(restarted.getState().operations.credits).toBe(5500);
  });

  /**
   * 已经**毕业**到主界面的模块，内测中心不能再列 —— 列着就又是一份假实现，
   * 而且和真功能同名，用户分不清点进去的是哪一个。
   *
   * 毕业清单：广场、团队（P1，迁移 35–38）；助手市场、创作者中心（P2，迁移 39–41）；
   * 悬赏、成长中心（P3，迁移 45–47）。
   */
  it('已毕业的模块都不再列出（P1 广场/团队、P2 市场/创作者、P3 悬赏/成长）', () => {
    const keys = BETA_MODULES.map((module) => module.id);
    for (const gone of ['square', 'team', 'market', 'creator', 'bounty', 'game']) {
      expect(keys, gone).not.toContain(gone);
    }
    // 其余模块一个都不能少
    expect(keys).toEqual(expect.arrayContaining(['operations', 'updates', 'analytics', 'compliance']));
  });

  it('resets all demo changes to the versioned seed', () => {
    const store = createBetaStore(storage);
    store.getState().setAnnouncement('改过的公告');
    store.getState().adjustCredits(500);
    store.getState().resetDemo();

    expect(store.getState().operations.announcement).toBe('欢迎参加公司内测 1.0');
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

  it('events 只留结构字段：没有用户内容、没有多余字段、条数有上限', () => {
    const store = createBetaStore(storage);
    store.getState().setActiveModule('analytics');
    store.getState().agreeCompliance();
    store.getState().requestDataExport();

    const events = store.getState().events;
    // 重复同意不再追加（同一个人只记一次）
    store.getState().agreeCompliance();
    expect(store.getState().events).toHaveLength(events.length);

    expect(events.every((event) => Number.isFinite(Date.parse(event.timestamp)))).toBe(true);
    // 每条事件只允许这四个键；尤其**不能有**任何正文/手机号/密钥字段
    for (const event of events) {
      for (const key of Object.keys(event)) {
        expect(['id', 'type', 'timestamp', 'module']).toContain(key);
      }
    }
    const serialized = JSON.stringify(events);
    for (const forbidden of ['phone', 'licenseKey', 'token', 'prompt', 'content', 'title']) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }

    // 上限 100：灌 120 条也只留最后 100
    for (let i = 0; i < 120; i += 1) store.getState().setActiveModule('operations');
    expect(store.getState().events.length).toBeLessThanOrEqual(100);
  });

  it('derives analytics from the explicit seed baseline and local events', () => {
    const store = createBetaStore(storage);
    const baseline = store.getState().analytics.launch;
    store.getState().setActiveModule('operations');
    const analytics = store.getState().analyticsSummary();
    // 只剩 module_opened → launch 这条映射了（毕业后其他映射一并删掉）
    expect(analytics.launch).toBe(baseline + 1);
  });
});
