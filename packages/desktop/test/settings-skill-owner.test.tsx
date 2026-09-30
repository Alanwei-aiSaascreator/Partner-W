// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useUiStore } from '../src/renderer/stores/uiStore';
import SkillsSection from '../src/renderer/layouts/Settings/sections/SkillsSection';
import { toast } from '../src/renderer/lib/toast';
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
// Keep the real store but pause React notifications to exercise replies before the next render.
vi.mock('../src/renderer/stores/uiStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/stores/uiStore')>();
  return {
    ...actual,
    useUiStore: Object.assign(
      (select: (state: ReturnType<typeof actual.useUiStore.getState>) => unknown) =>
        select(actual.useUiStore.getState()),
      actual.useUiStore,
    ),
  };
});
const catalog = { defaultId: 'office', agents: [{ id: 'office' }, { id: 'video' }] };
let root: Root;
let container: HTMLDivElement;
const getSkillsStatus = vi.fn();
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(toast.error).mockClear();
  getSkillsStatus.mockReset().mockResolvedValue({ ok: true, result: { skills: [] } });
  window.clawwork = { getSkillsStatus } as unknown as Window['clawwork'];
  useUiStore.setState({
    gatewayStatusMap: { gateway: 'connected' },
    gatewayInfoMap: {},
    defaultGatewayId: 'gateway',
    agentCatalogByGateway: { gateway: catalog },
    skillsStatusByGateway: {},
  });
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));
async function render() {
  await act(async () => root.render(<SkillsSection />));
}
it('waits for the roster and then requests the actual management owner', async () => {
  useUiStore.setState({ agentCatalogByGateway: {} });
  await render();
  expect(getSkillsStatus).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalled();
  await act(async () => useUiStore.setState({ agentCatalogByGateway: { gateway: catalog } }));
  await render();
  expect(getSkillsStatus).toHaveBeenCalledWith('gateway', 'office');
  expect(useUiStore.getState().skillsStatusByGateway.gateway?.agentId).toBe('office');
});
it('does not guess an owner when a loaded roster is ambiguous', async () => {
  useUiStore.setState({ agentCatalogByGateway: { gateway: { ...catalog, defaultId: '' } } });
  await render();
  expect(getSkillsStatus).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalledTimes(1);
});
it.each(['owner', 'disconnect', 'reconnect', 'same-owner-roster'] as const)(
  'rejects an old reply synchronously after %s changes before render',
  async (kind) => {
    let finish!: (value: unknown) => void;
    getSkillsStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await act(async () => {
      if (kind === 'owner')
        useUiStore.setState({ agentCatalogByGateway: { gateway: { ...catalog, defaultId: 'video' } } });
      else if (kind === 'same-owner-roster')
        useUiStore.setState({ agentCatalogByGateway: { gateway: { ...catalog, agents: [...catalog.agents] } } });
      else {
        useUiStore.setState({ gatewayStatusMap: { gateway: 'disconnected' } });
        if (kind === 'reconnect') useUiStore.setState({ gatewayStatusMap: { gateway: 'connected' } });
      }
      finish({ ok: true, result: { agentId: 'office', skills: [] } });
      await Promise.resolve();
      expect(useUiStore.getState().skillsStatusByGateway.gateway?.agentId).not.toBe('office');
    });
  },
);
