// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
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
    selector({ data: mocks.data, loading: false, fetch: mocks.fetchDashboard }),
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
    mocks.fetchDashboard.mockClear();
    mocks.loadCommercial.mockClear();
    mocks.refreshCommercial.mockClear();
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

  it('keeps transparent billing details behind an explicit action', () => {
    const { container, unmount } = render(<Dashboard />);

    expect(container.textContent).not.toContain('dashboard.ledger.officialPrice');
    const detailsButton = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('dashboard.showBillingDetails'),
    );
    expect(detailsButton).toBeTruthy();
    act(() => detailsButton?.click());
    expect(container.textContent).toContain('dashboard.ledger.officialPrice');
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
