// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  error: null as string | null,
  fetchDashboard: vi.fn(),
  loadCommercial: vi.fn(),
  refreshCommercial: vi.fn(),
  data: {
    totalTasks: 12,
    activeDays: 4,
    totalMessages: 36,
    totalArtifacts: 3,
    breakdowns: {
      models: [],
      gateways: [{ name: 'main', count: 12, percent: 100 }],
      agents: [
        { name: 'main', count: 7, percent: 58 },
        { name: 'rongying-video', count: 5, percent: 42 },
      ],
    },
    last30d: {
      input: 1200,
      output: 800,
      costMicros: 20_000_000,
      daily: [{ date: '2026-09-14', input: 1200, output: 800, costMicros: 20_000_000 }],
    },
    modelUsage: [
      {
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        calls: 3,
        inputTokens: 1200,
        outputTokens: 800,
        cachedTokens: 0,
        totalTokens: 2000,
        costMicros: 20_000_000,
        saleInputYuanPerMtok: 1,
        saleOutputYuanPerMtok: 2,
        saleCachedYuanPerMtok: null,
        officialInputYuanPerMtok: 0.5,
        officialOutputYuanPerMtok: 1,
        officialCachedYuanPerMtok: null,
        officialCachePricingMode: 'none',
        targetMultiplier: 1.6,
        pricingVariants: 1,
        pricingMixed: false,
        settledCalls: 3,
        officialReferenceCoveredCalls: 3,
        officialReferenceCostMicros: 12_500_000,
        officialReferenceComplete: true,
        effectiveMultiplier: 1.6,
      },
    ],
  },
  overview: {
    account: { id: 'user-1' },
    license: { tokenQuotaMicros: 800_000_000, tokenUsedMicros: 200_000_000 },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactElement }) => <div>{children}</div>,
  LineChart: ({ children }: { children: ReactElement }) => <div>{children}</div>,
  CartesianGrid: () => null,
  Legend: () => null,
  Line: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

vi.mock('@/stores/dashboardStore', () => ({
  useDashboardStore: (selector: (state: unknown) => unknown) =>
    selector({ data: mocks.data, loading: false, error: mocks.error, fetch: mocks.fetchDashboard }),
}));

vi.mock('@/stores/commercialStore', () => ({
  useCommercialStore: (selector: (state: unknown) => unknown) =>
    selector({
      overview: mocks.overview,
      status: 'ready',
      load: mocks.loadCommercial,
      refresh: mocks.refreshCommercial,
    }),
}));

import Dashboard from '../src/renderer/layouts/Dashboard';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(ui: ReactElement): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('Dashboard overview', () => {
  beforeEach(() => {
    mocks.error = null;
    mocks.fetchDashboard.mockClear();
    mocks.loadCommercial.mockClear();
    mocks.refreshCommercial.mockClear();
  });

  it('shows a failed request distinctly from unavailable statistics', () => {
    mocks.error = 'private RPC error';
    const { container, unmount } = render(<Dashboard />);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('errors.requestFailed');
    expect(container.textContent).not.toContain('private RPC error');
    unmount();
  });

  it('⭐ 每个数字都带口径，且**标签必须挨着它标的那个数字**（本机=这块盘 / 账号=服务端账本）', () => {
    const { container, unmount } = render(<Dashboard />);
    // ⚠️ 要连 `<span>` 一起查：`SectionHeader` 的标题是 span（只查 div 会取到 undefined）。
    const nodes = [...container.querySelectorAll('div, span')];
    // ⚠️ 两个定位都取**最深**的那个（文档序里祖先在前）：`find` 会拿到**包裹整页的根节点**，
    //    它天然包含别处的口径 key（提示磁贴无条件渲染 localScope）⇒ 断言会假绿。实测过。
    const deepestContaining = (text: string): HTMLElement | undefined =>
      nodes.filter((el) => el.textContent?.includes(text)).at(-1) as HTMLElement | undefined;
    const deepestExact = (text: string): HTMLElement | undefined =>
      nodes.filter((el) => el.textContent === text).at(-1) as HTMLElement | undefined;

    // ① 「账户积分」卡底部那行是**本机**数字（消息/文件数）⇒ 自己必须带本机口径，
    //    且**每个数都跟在自己的标签后面**。⚠️ 只查"这一行里出现过 36 / 3"会被两种退化骗过（复核者实测）：
    //    ① 两个数**对调**（MQ1 ⇒ 全绿，而 DOM 真的变成"消息数显示文件数"）
    //    ② 清掉文件数后，剩下的 `3` 被 `36` 里的那个数字满足（MQ3 ⇒ 全绿）。
    const totalsLine = deepestContaining('dashboard.totalMessages');
    expect(totalsLine?.children.length).toBe(0); // ← 钉住上面那个"取最深"的定位本身（根节点是有子节点的）
    expect(totalsLine?.textContent).toBe(
      'dashboard.localScope · dashboard.totalMessages 36 · dashboard.totalArtifacts 3',
    );

    // ② 「助手排行」来自本机聚合（`data.breakdowns.agents`）⇒ 口径标签必须是标题的**下一个兄弟**。
    //    ⚠️ 不能用 `parentElement` + 包含：标签不渲染时标题与 wrapper 文本相同 ⇒ 命中 wrapper，
    //    父节点变成**整张卡**，"卡里出现过这个串"就绿了（复核者用 MG 变异实测过这条假绿）。
    const topAgentsLabel = deepestExact('dashboard.topAgents');
    expect(topAgentsLabel?.nextElementSibling?.textContent).toBe('dashboard.localScope');

    // ③ 反向：账号口径的板块**不许**被顺手改成"本机"（否则修法把它改错方向也全绿）。
    const modelUsageLabel = deepestExact('dashboard.modelUsage');
    expect(modelUsageLabel?.nextElementSibling?.textContent).toBe('dashboard.accountScope');

    // ③b 反向的**另一半**：「最近 30 天」同样是**账号**口径 ⇒ **摘掉**它也是错的。
    //    ⚠️ 只钉「模型消耗」会漏掉这里（复核者 MQ2：摘掉 ⇒ 全绿）。
    const last30dLabel = deepestExact('dashboard.last30dSection');
    expect(last30dLabel?.nextElementSibling?.textContent).toBe('dashboard.accountScope');

    unmount();
  });

  it('puts understandable account and assistant information before technical detail', () => {
    const { container, unmount } = render(<Dashboard />);

    expect(container.textContent).toContain('dashboard.title');
    expect(container.textContent).toContain('12');
    expect(container.textContent).toContain('4');
    expect(container.textContent).toContain('600.00');
    expect(container.textContent).toContain('mainArea.compassAssistant');
    expect(container.textContent).toContain('presetAgents.roles.video');
    expect(container.textContent).toContain('deepseek-v4-flash');
    expect(container.textContent).toContain('3 dashboard.calls');
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('75');
    expect(mocks.fetchDashboard).toHaveBeenCalledOnce();
    expect(mocks.loadCommercial).toHaveBeenCalledOnce();
    unmount();
  });

  /**
   * 产品决定（2026-09-17）：**用户界面只显示「消耗 X 积分」**。
   *
   * 之前这里挂着一个「显示计费明细」开关，展开后能看到官方参考价 / 官方参考费用 /
   * 目标倍率 / 实际售价 / 实际结算倍率 / tokens / cached / 人民币换算 —— 那些是
   * 运营侧口径，摆给普通用户既看不懂也过度暴露商业细节。
   *
   * ⚠️ 数据层（服务端账本、`DashboardModelUsage` 里的字段、admin console）**不动**：
   *    只是不再往用户界面上渲染。
   */
  it('shows only credits and never exposes billing internals to the end user', () => {
    const { container, unmount } = render(<Dashboard />);

    // 该有的：模型名 + 消耗积分 + 调用次数
    expect(container.textContent).toContain('deepseek-v4-flash');
    expect(container.textContent).toContain('20.00');
    expect(container.textContent).toContain('3 dashboard.calls');

    // 不该有的：计费明细的任何一项，连入口都不该存在
    for (const forbidden of [
      'dashboard.ledger.officialPrice',
      'dashboard.ledger.officialCost',
      'dashboard.ledger.actualTokens',
      'dashboard.ledger.actualCharge',
      'dashboard.ledger.targetMultiplier',
      'dashboard.ledger.saleRate',
      'dashboard.ledger.effectiveMultiplier',
    ]) {
      expect(container.textContent).not.toContain(forbidden);
    }
    const detailsButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('dashboard.showBillingDetails'),
    );
    expect(detailsButton).toBeUndefined();
    // token 数也不再出现在用户界面（2,000 是 fixture 里那一行的总 token）
    expect(container.textContent).not.toContain('2,000');
    unmount();
  });

  it('refreshes dashboard and commercial data together', () => {
    const { container, unmount } = render(<Dashboard />);
    const refreshButton = container.querySelector<HTMLButtonElement>('button[aria-label="dashboard.refresh"]');

    act(() => refreshButton?.click());
    expect(mocks.fetchDashboard).toHaveBeenLastCalledWith(true);
    expect(mocks.refreshCommercial).toHaveBeenCalledOnce();
    unmount();
  });
});
