import { describe, expect, it, vi } from 'vitest';
import { PRESET_AGENT_IDS } from '../src/renderer/lib/preset-agents';
import {
  createPresetAgentBootstrapCoordinator,
  type PresetAgentBootstrapDeps,
  type PresetAgentBootstrapSnapshot,
} from '../src/renderer/lib/preset-agent-bootstrap';

function createDeps(agentIds: string[]): {
  deps: PresetAgentBootstrapDeps;
  setAgentIds: (ids: string[]) => void;
} {
  let currentAgentIds = agentIds;
  return {
    deps: {
      refreshAgents: vi.fn(async () => {}),
      readAgentIds: vi.fn(() => currentAgentIds),
      install: vi.fn(async () => ({ installed: [], skipped: [], failed: [] })),
    },
    setAgentIds: (ids) => {
      currentAgentIds = ids;
    },
  };
}

describe('preset agent bootstrap coordinator', () => {
  it('verifies file completeness even when all bundled assistant IDs already exist', async () => {
    const coordinator = createPresetAgentBootstrapCoordinator();
    const { deps } = createDeps(['main', ...PRESET_AGENT_IDS]);

    const snapshot = await coordinator.run('gw-1', deps);

    expect(snapshot).toMatchObject({ phase: 'ready', completed: 6, total: 6, missingIds: [] });
    expect(deps.refreshAgents).toHaveBeenCalledTimes(2);
    expect(deps.install).toHaveBeenCalledOnce();
  });

  it('⭐ installer 报半成品失败时，即使 ID 已出现也不能误判 ready', async () => {
    const coordinator = createPresetAgentBootstrapCoordinator();
    const { deps } = createDeps(['main', ...PRESET_AGENT_IDS]);
    vi.mocked(deps.install).mockResolvedValue({
      installed: [],
      skipped: PRESET_AGENT_IDS.slice(1),
      failed: [{ id: PRESET_AGENT_IDS[0], error: 'SOUL.md write failed' }],
    });

    const snapshot = await coordinator.run('gw-1', deps);

    expect(snapshot.phase).toBe('error');
    expect(snapshot.missingIds).toContain(PRESET_AGENT_IDS[0]);
    expect(snapshot.error).toContain('SOUL.md write failed');
  });

  it('refreshes before and after installation and trusts the reconciled catalog', async () => {
    const coordinator = createPresetAgentBootstrapCoordinator();
    const { deps, setAgentIds } = createDeps(['main']);
    vi.mocked(deps.install).mockImplementation(async (_ids, onProgress) => {
      onProgress({ completed: 6, total: 6, currentId: 'rongying-family' });
      setAgentIds(['main', ...PRESET_AGENT_IDS]);
      return {
        installed: [...PRESET_AGENT_IDS],
        skipped: [],
        failed: [],
      };
    });

    const snapshot = await coordinator.run('gw-1', deps);

    expect(deps.refreshAgents).toHaveBeenCalledTimes(2);
    expect(deps.install).toHaveBeenCalledWith(['main'], expect.any(Function));
    expect(snapshot.phase).toBe('ready');
  });

  it('publishes real verification and installation progress', async () => {
    const coordinator = createPresetAgentBootstrapCoordinator();
    const { deps, setAgentIds } = createDeps(['main', 'rongying-content']);
    const snapshots: PresetAgentBootstrapSnapshot[] = [];
    coordinator.subscribe('gw-1', (snapshot) => snapshots.push(snapshot));
    vi.mocked(deps.install).mockImplementation(async (_ids, onProgress) => {
      onProgress({ completed: 2, total: 6, currentId: 'rongying-video' });
      setAgentIds(['main', ...PRESET_AGENT_IDS]);
      return { installed: [], skipped: [], failed: [] };
    });

    await coordinator.run('gw-1', deps);

    expect(snapshots.map((snapshot) => snapshot.phase)).toContain('verifying');
    expect(snapshots).toContainEqual(
      expect.objectContaining({
        phase: 'installing',
        completed: 2,
        total: 6,
        currentId: 'rongying-video',
      }),
    );
  });

  it('shares one in-flight run for simultaneous lifecycle triggers', async () => {
    const coordinator = createPresetAgentBootstrapCoordinator();
    let releaseRefresh: (() => void) | undefined;
    const refreshBarrier = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const { deps } = createDeps(['main', ...PRESET_AGENT_IDS]);
    vi.mocked(deps.refreshAgents).mockReturnValue(refreshBarrier);

    const first = coordinator.run('gw-1', deps);
    const second = coordinator.run('gw-1', deps);

    expect(second).toBe(first);
    expect(deps.refreshAgents).toHaveBeenCalledOnce();
    releaseRefresh?.();
    await first;
  });

  it('reports exactly the roles that remain missing after reconciliation', async () => {
    const coordinator = createPresetAgentBootstrapCoordinator();
    const incompleteIds = PRESET_AGENT_IDS.filter((id) => id !== 'rongying-family');
    const { deps, setAgentIds } = createDeps(['main']);
    vi.mocked(deps.install).mockImplementation(async () => {
      setAgentIds(['main', ...incompleteIds]);
      return {
        installed: [...incompleteIds],
        skipped: [],
        failed: [{ id: 'rongying-family', error: 'write denied' }],
      };
    });

    const snapshot = await coordinator.run('gw-1', deps);

    expect(snapshot).toMatchObject({
      phase: 'error',
      missingIds: ['rongying-family'],
      error: 'write denied',
    });
  });

  it('reports zero completed roles when the initial catalog refresh fails', async () => {
    const coordinator = createPresetAgentBootstrapCoordinator();
    const { deps } = createDeps(['main']);
    vi.mocked(deps.refreshAgents).mockRejectedValue(new Error('gateway unavailable'));

    const snapshot = await coordinator.run('gw-1', deps);

    expect(snapshot).toMatchObject({
      phase: 'error',
      completed: 0,
      total: 6,
      missingIds: PRESET_AGENT_IDS,
      error: 'gateway unavailable',
    });
  });

  it('allows a clean retry after a failed run is reset', async () => {
    const coordinator = createPresetAgentBootstrapCoordinator();
    const { deps, setAgentIds } = createDeps(['main']);
    vi.mocked(deps.install)
      .mockResolvedValueOnce({
        installed: [],
        skipped: [],
        failed: [{ id: 'rongying-content', error: 'gateway busy' }],
      })
      .mockImplementationOnce(async () => {
        setAgentIds(['main', ...PRESET_AGENT_IDS]);
        return { installed: [...PRESET_AGENT_IDS], skipped: [], failed: [] };
      });

    expect((await coordinator.run('gw-1', deps)).phase).toBe('error');
    coordinator.reset('gw-1');
    expect((await coordinator.run('gw-1', deps)).phase).toBe('ready');
    expect(deps.install).toHaveBeenCalledTimes(2);
  });
});
