import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clients: vi.fn(),
  stateDir: vi.fn(() => 'active-local-state'),
  available: vi.fn(() => true),
}));

vi.mock('../src/main/ws/index.js', () => ({ getAllGatewayClients: mocks.clients }));
vi.mock('../src/main/runtime/index.js', () => ({ getActiveLocalGatewayStateDir: mocks.stateDir }));
vi.mock('../src/main/runtime/bundled-search.js', () => ({ hasInstalledSearchProvider: mocks.available }));
vi.mock('../src/main/runtime/state-config.js', () => ({ LOCAL_GATEWAY_ID: 'local-runtime' }));
vi.mock('../src/main/commercial/client.js', () => ({ getCommercialClient: vi.fn() }));
vi.mock('../src/main/commercial/auth.js', () => ({ probeAuth: vi.fn() }));
vi.mock('../src/main/commercial/license.js', () => ({
  deviceFingerprint: vi.fn(),
  mapActivationError: vi.fn(),
  readLicenseStatus: vi.fn(),
}));
vi.mock('../src/main/commercial/relay-cleanup.js', () => ({
  buildCommercialAccessCleanupDeps: vi.fn(),
  drainPendingCommercialAccessCleanup: vi.fn(),
}));
vi.mock('../src/main/workspace/config.js', () => ({ readConfig: vi.fn() }));
vi.mock('../src/main/window-manager.js', () => ({ getMainWindow: vi.fn() }));
vi.mock('../src/main/ws/window-utils.js', () => ({ sendToWindow: vi.fn() }));
vi.mock('../src/main/debug/index.js', () => ({ getDebugLogger: vi.fn() }));

function gateway(isConnected = true) {
  return { isConnected, getConfig: vi.fn(), patchConfig: vi.fn(), runConfigMutation: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stateDir.mockReturnValue('active-local-state');
  mocks.available.mockReturnValue(true);
});

describe('selected gateway search evidence', () => {
  it('enables installed search only for the connected local runtime and its active state dir', async () => {
    const local = gateway();
    mocks.clients.mockReturnValue(
      new Map([
        ['external', gateway()],
        ['local-runtime', local],
      ]),
    );
    const { findConnectedGateway } = await import('../src/main/commercial/relay-startup.js');
    const selected = findConnectedGateway();
    expect(selected?.bundledWebSearchAvailable).toBe(true);
    expect(mocks.available).toHaveBeenCalledWith('active-local-state');
  });

  it.each([false, true])(
    'does not borrow local plugin evidence for a fallback gateway (local exists: %s)',
    async (localExists) => {
      const clients = new Map([['external', gateway()]]);
      if (localExists) clients.set('local-runtime', gateway(false));
      mocks.clients.mockReturnValue(clients);
      const { findConnectedGateway } = await import('../src/main/commercial/relay-startup.js');
      expect(findConnectedGateway()?.bundledWebSearchAvailable).toBe(false);
      expect(mocks.available).not.toHaveBeenCalled();
      expect(mocks.stateDir).not.toHaveBeenCalled();
    },
  );

  it('does not advertise search when the installed relay search plugin is not ready', async () => {
    mocks.clients.mockReturnValue(new Map([['local-runtime', gateway()]]));
    mocks.available.mockReturnValue(false);
    const { findConnectedGateway } = await import('../src/main/commercial/relay-startup.js');
    expect(findConnectedGateway()?.bundledWebSearchAvailable).toBe(false);
  });
});
