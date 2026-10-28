import { beforeEach, describe, expect, it } from 'vitest';
import {
  BETA_MODULES,
  BETA_STORAGE_KEY,
  createBetaStore,
  type BetaStorage,
} from '../src/renderer/features/internal-beta/beta-store';

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
   * 悬赏、成长中心（P3，迁移 45–47）；埋点分析（数据搬到运营看板）、隐私与合规
   * （搬到设置页「隐私与数据」，P4）。
   */
  it('已毕业的模块都不再列出（P1 广场/团队、P2 市场/创作者、P3 悬赏/成长、P4 埋点/合规）', () => {
    const keys = BETA_MODULES.map((module) => module.id);
    for (const gone of ['square', 'team', 'market', 'creator', 'bounty', 'game', 'analytics', 'compliance']) {
      expect(keys, gone).not.toContain(gone);
    }
    // 逐字相等而不是 arrayContaining：多挂一个假模块也必须红
    expect(keys).toEqual(['operations', 'updates']);
  });

  it('resets all demo changes to the versioned seed', () => {
    const store = createBetaStore(storage);
    store.getState().setAnnouncement('改过的公告');
    store.getState().adjustCredits(500);
    store.getState().resetDemo();

    expect(store.getState().operations.announcement).toBe('欢迎参加公司内测 1.0');
    expect(store.getState().operations.credits).toBe(5000);
  });

  it('covers the remaining operations actions', () => {
    const store = createBetaStore(storage);

    store.getState().toggleModel();
    store.getState().setModelRate(1.5);
    store.getState().setAnnouncement('今晚升级');
    expect(store.getState().operations).toMatchObject({
      modelEnabled: false,
      modelRate: 1.5,
      announcement: '今晚升级',
    });
  });

  /**
   * P4：埋点分析与隐私合规从内测中心毕业。
   *
   * ⚠️ 这一条钉的是**假接口本身**：只要 store 里还留着 `analyticsSummary` /
   *    `agreeCompliance` / `requestDataExport` / `requestDeletion` 或 `analytics` /
   *    `compliance` 这两块数据，界面上迟早会长回第二个（假的）隐私入口 ——
   *    而真入口已经在设置页「隐私与数据」。
   */
  it('⭐ 毕业的埋点分析与隐私合规不留假接口（store 层）', () => {
    const state: object = createBetaStore(storage).getState();
    for (const gone of [
      'analyticsSummary',
      'agreeCompliance',
      'requestDataExport',
      'requestDeletion',
      'analytics',
      'compliance',
    ]) {
      expect(gone in state, gone).toBe(false);
    }
  });

  /**
   * ⚠️ 老版本写进 localStorage 的历史事件**不能被静默抹掉**（那会凭空删掉用户的历史）。
   *    词表因此保留了已停发的事件名（P1/P2/P3 搬走的模块 + P4 毕业的合规申请），
   *    但同时**必须**继续过滤掉从未登记的垃圾类型 —— 白名单不能退化成"照单全收"。
   */
  it('⭐ 兼容旧 localStorage：停发的历史事件保留、未登记的垃圾类型仍被丢弃', () => {
    storage.setItem(
      BETA_STORAGE_KEY,
      JSON.stringify({
        activeModule: 'operations',
        events: [
          { id: 'e1', type: 'team_created', timestamp: '2026-09-01T00:00:00.000Z' },
          { id: 'e2', type: 'compliance_agreed', timestamp: '2026-09-02T00:00:00.000Z', module: 'compliance' },
          { id: 'e3', type: 'data_deletion_requested', timestamp: '2026-09-03T00:00:00.000Z', module: 'compliance' },
          { id: 'e4', type: 'module_opened', timestamp: '2026-09-04T00:00:00.000Z', module: 'operations' },
          { id: 'e5', type: 'not_a_real_event', timestamp: '2026-09-05T00:00:00.000Z' },
          { id: 'e6', type: 'module_opened' },
        ],
      }),
    );

    const events = createBetaStore(storage).getState().events;
    expect(events.map((event) => event.id)).toEqual(['e1', 'e2', 'e3', 'e4']);
    for (const event of events) {
      expect(Number.isFinite(Date.parse(event.timestamp))).toBe(true);
    }
  });

  /**
   * ⭐ F1：升级前点过「埋点分析 / 隐私与合规」的用户，localStorage 里留着
   *    `activeModule: 'analytics'`（这两个 id 已经毕业、不在 BETA_MODULES 里）。
   *    盲信它 ⇒ 内测中心 `BETA_MODULES.find(...)!` 给 undefined ⇒ 渲染时抛
   *    TypeError ⇒ 被根 ErrorBoundary 接成**整应用错误页**，重载后再点照样崩。
   *
   * ⚠️ 三种输入一起钉：两个真的会出现的旧 id，和一个纯粹不认识的值 ——
   *    判据是"在不在清单里"，不是"是不是那两个名字"。
   */
  it('⭐ 旧 blob 里已毕业/不认识的 activeModule 一律回落到清单第一个模块', () => {
    for (const stale of ['analytics', 'compliance', 'not_a_module']) {
      storage.setItem(BETA_STORAGE_KEY, JSON.stringify({ activeModule: stale, events: [] }));

      const state = createBetaStore(storage).getState();
      expect(state.activeModule, stale).toBe(BETA_MODULES[0].id);
      expect(
        BETA_MODULES.map((module) => module.id),
        stale,
      ).toContain(state.activeModule);
    }
  });

  /**
   * ⭐ F1 自愈：脏值不只是"这次不崩"，下一次写回就被干净值覆盖掉
   *    （否则用户每次启动都要再走一遍回落逻辑，且脏值永远留在盘上）。
   */
  it('⭐ 脏 activeModule 在下次写回时被干净值覆盖', () => {
    storage.setItem(BETA_STORAGE_KEY, JSON.stringify({ activeModule: 'compliance', events: [] }));

    const store = createBetaStore(storage);
    store.getState().adjustCredits(100);

    const written = JSON.parse(storage.getItem(BETA_STORAGE_KEY) ?? '{}') as { activeModule?: string };
    expect(written.activeModule).toBe(BETA_MODULES[0].id);
  });

  /**
   * ⭐ F3：老 blob 里的 `analytics` / `compliance` **残块**是"**语义级保留**"
   *    （值一字不差进内存、原样回写、没有任何界面消费）—— 这是**显式决定**，
   *    不是漏网之鱼，所以在这里钉死，别让它以后又被当成 bug 顺手改掉。
   *
   * 为什么保留而不清掉：这两块是老版本内测中心的模拟 UI 数据（计数器 + 三个
   * 布尔开关，没有用户正文），而"清用户本机已有的数据"属于**单独的数据迁移
   * 决策**，不是一次审阅修正能顺手做的（Task 15 遗留清单里记着这笔）。
   * ⚠️ 上面那条「六个名字一个都不许出现」只对**全新存储**成立：老 blob 的残块
   *    会被 `...parsed` 带进来，判据不同不是自相矛盾。
   * ⚠️ 与 `activeModule` 的区别（F1）：那个**必须** clamp，盲信它会让内测中心
   *    整页崩；这两块没有任何界面消费，留着不会崩。
   */
  it('⭐ 旧 blob 的 analytics / compliance 残块：原样保留、原样回写、无界面消费', () => {
    const legacyBlocks = {
      analytics: { launch: 7, login: 1 },
      compliance: { agreed: true, exportRequested: true, deletionRequested: false },
    };
    storage.setItem(
      BETA_STORAGE_KEY,
      JSON.stringify({
        activeModule: 'operations',
        operations: {
          users: 1,
          activeCodes: 2,
          credits: 3,
          modelEnabled: false,
          modelRate: 2,
          announcement: '旧公告',
          errorCount: 9,
        },
        ...legacyBlocks,
        events: [{ id: 'e1', type: 'compliance_agreed', timestamp: '2026-09-02T00:00:00.000Z', module: 'compliance' }],
      }),
    );

    const store = createBetaStore(storage);
    const state = store.getState() as unknown as Record<string, unknown>;
    // 值一字不差（不是被"归一化"过的近似值）
    expect(state.analytics).toEqual(legacyBlocks.analytics);
    expect(state.compliance).toEqual(legacyBlocks.compliance);
    // 认识的部分照样恢复 + 事件保留（兼容性不能一起砍掉）
    expect(store.getState().operations.announcement).toBe('旧公告');
    expect(store.getState().operations.modelRate).toBe(2);
    expect(store.getState().events.map((event) => event.id)).toEqual(['e1']);

    // 无界面消费：每个动作跑一遍，残块一个字节都没被碰过（没有任何 action 绑在上面）
    store.getState().adjustCredits(100);
    store.getState().toggleModel();
    store.getState().setModelRate(2);
    store.getState().setAnnouncement('新公告');
    store.getState().setActiveModule('updates');

    const written = JSON.parse(storage.getItem(BETA_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    expect(written.analytics).toEqual(legacyBlocks.analytics);
    expect(written.compliance).toEqual(legacyBlocks.compliance);
    expect(written.activeModule).toBe('updates');
    // 回写的是**原样**的两块，不是被清掉、也不是被补全过的形状
    expect(Object.keys(written).sort()).toEqual(['activeModule', 'analytics', 'compliance', 'events', 'operations']);
  });

  it('events 只留结构字段：没有用户内容、没有多余字段、条数有上限', () => {
    const store = createBetaStore(storage);
    store.getState().setActiveModule('operations');
    store.getState().setActiveModule('updates');

    const events = store.getState().events;
    expect(events).toHaveLength(2);

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
});
