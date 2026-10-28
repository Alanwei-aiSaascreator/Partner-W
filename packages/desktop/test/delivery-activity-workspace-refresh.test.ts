import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ end: vi.fn() }));
vi.mock('../src/renderer/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  systemSessionService: { end: mocks.end },
}));
vi.mock('../src/renderer/lib/session-sync', () => ({
  hydrateFromLocal: async () => undefined,
  resetHydration: vi.fn(),
}));
vi.mock('../src/renderer/hooks/useGatewayDispatcherSetup', () => ({
  reinitializeGatewayBootstrap: async () => undefined,
}));
vi.mock('../src/renderer/features/team-meeting/instance', () => ({
  teamMeetingController: { reset: vi.fn(), load: async () => undefined },
}));

it('clears main delivery activity synchronously before awaiting old side-session cleanup', async () => {
  (globalThis.window ??= {} as typeof window).clawwork = {
    getSettings: async () => ({ gateways: [], workspacePath: 'C:\\new-workspace' }),
    listTeams: async () => ({ ok: true, result: [] }),
  } as unknown as typeof window.clawwork;
  const { useTaskStore } = await import('../src/renderer/stores/taskStore');
  const { useDeliveryActivityStore } = await import('../src/renderer/stores/deliveryActivityStore');
  useTaskStore.setState({ workspaceEpoch: 0 });
  useDeliveryActivityStore.setState({ workspaceEpoch: 0 });
  useDeliveryActivityStore.getState().record(
    {
      taskId: 'old-task',
      sessionKey: 'old-session',
      messageId: 'old-message',
      operationId: 'old-operation',
      workspaceScope: 'old-owner',
      workspaceRevision: 1,
      sequence: 1,
      startedAt: 100,
      phase: 'generating-presentation',
      status: 'active',
    },
    0,
  );
  let complete!: () => void;
  mocks.end.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  const { refreshRendererAfterWorkspaceChange } = await import('../src/renderer/lib/workspace-refresh');
  const pending = refreshRendererAfterWorkspaceChange();
  expect(useDeliveryActivityStore.getState().active).toEqual([]);
  expect(useDeliveryActivityStore.getState().workspaceEpoch).toBe(1);
  complete();
  await pending;
});
