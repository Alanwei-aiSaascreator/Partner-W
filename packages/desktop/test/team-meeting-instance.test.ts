import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommercialAccountOverview, Team } from '@clawwork/shared';
import { buildMeetingPlan } from '../src/renderer/features/team-meeting/plan';
import { expectedArtifactKindsFromRequest } from '../src/main/artifact/claim-guard';

const captured = vi.hoisted(() => ({ ports: undefined as unknown }));
vi.mock('../src/renderer/features/team-meeting/controller', () => ({
  createTeamMeetingController: (ports: unknown) => {
    captured.ports = ports;
    return { store: {} };
  },
}));
vi.mock('../src/renderer/lib/session-sync', () => ({ syncRun: vi.fn() }));

describe('meeting production ports', () => {
  beforeEach(() => vi.resetModules());
  async function setup() {
    (globalThis.window ??= {} as Window & typeof globalThis).clawwork = {
      abortChat: vi.fn(async () => ({ ok: true, result: { aborted: true } })),
    } as unknown as typeof window.clawwork;
    const platform = await import('../src/renderer/platform');
    const { useCommercialStore } = await import('../src/renderer/stores/commercialStore');
    const team = { id: 'team', gatewayId: 'gw', agents: [{ agentId: 'a' }, { agentId: 'b' }] } as Team;
    platform.useTeamStore.setState({ teams: { team } });
    platform.useUiStore.setState({
      gatewayStatusMap: { gw: 'connected' },
      agentCatalogByGateway: { gw: { agents: [{ id: 'a' }, { id: 'b' }], defaultId: 'a' } },
      modelCatalogByGateway: { gw: [{ id: 'model', provider: 'clawrouter', name: 'model', available: true }] },
    });
    const refresh = vi.fn(async () => {});
    useCommercialStore.setState({
      status: 'ready',
      overview: {
        account: {},
        license: { activated: true, status: 'active', tokenQuotaMicros: 100, tokenUsedMicros: 10 },
      } as CommercialAccountOverview,
      refresh,
    });
    await import('../src/renderer/features/team-meeting/instance');
    const ports = captured.ports as import('../src/renderer/features/team-meeting/controller').MeetingControllerPorts;
    const plan = buildMeetingPlan({
      team,
      members: ['a', 'b'].map((agentId) => ({ agentId, name: agentId, model: 'clawrouter/model' })),
      question: 'q',
      title: 't',
      deviceId: 'device',
    });
    return { platform, useCommercialStore, refresh, ports, plan };
  }
  it('checks current catalogs and quota before creation and again per stage', async () => {
    const h = await setup();
    await h.ports.validateStart!(h.plan);
    await h.ports.preflight(h.plan.tasks[0], new AbortController().signal);
    expect(h.refresh).toHaveBeenCalledTimes(2);
    h.platform.useUiStore.setState({ gatewayStatusMap: {} });
    await expect(h.ports.validateStart!(h.plan)).rejects.toThrow();
  });
  it('uses the current production locale for discussion requests without implying file delivery', async () => {
    const h = await setup();
    const { default: i18n } = await import('../src/renderer/i18n');
    const originalLanguage = i18n.language;
    try {
      for (const language of ['zh', 'en', 'zh-TW', 'ja', 'ko', 'pt', 'de', 'es', 'fr']) {
        await i18n.changeLanguage(language);
        for (const stage of ['proposal', 'review'] as const) {
          const expected = i18n.getResource(language, 'translation', `meeting.stage.${stage}`);
          expect(typeof expected).toBe('string');
          expect(expected.trim()).not.toBe('');
          expect(h.ports.stageRequest(stage)).toBe(expected);
          expect(h.ports.stageRequest(stage)).not.toBe(`meeting.stage.${stage}`);
          expect(expectedArtifactKindsFromRequest(h.ports.stageRequest(stage))).toEqual([]);
        }
      }
    } finally {
      await i18n.changeLanguage(originalLanguage);
    }
  });
  it('rejects disappeared members and unavailable models without substitutions', async () => {
    const h = await setup();
    h.platform.useUiStore.setState({ agentCatalogByGateway: { gw: { agents: [{ id: 'a' }], defaultId: 'a' } } });
    await expect(h.ports.validateStart!(h.plan)).rejects.toThrow();
    h.platform.useUiStore.setState({ modelCatalogByGateway: { gw: [] } });
    await expect(h.ports.preflight(h.plan.tasks[0], new AbortController().signal)).rejects.toThrow();
  });
  it('fails closed on quota degrade instead of silently downgrading the model', async () => {
    const h = await setup();
    const overview = structuredClone(h.useCommercialStore.getState().overview!);
    overview.license!.tokenUsedMicros = 96;
    h.useCommercialStore.setState({ overview });
    await expect(h.ports.preflight(h.plan.tasks[0], new AbortController().signal)).rejects.toThrow();
    expect(h.plan.tasks[0].model).toBe('clawrouter/model');
  });
  it('never aborts a newer active run when stopping a recovered receipt', async () => {
    const h = await setup();
    const task = h.plan.tasks[0];
    h.platform.useTaskStore.getState().registerPersistedTasks([task]);
    h.platform.useMessageStore.setState({
      activeTurnBySession: { [task.sessionKey]: { runId: 'new-run' } as import('@clawwork/core').ActiveTurn },
    });
    const abortChat = window.clawwork.abortChat;
    const result = await h.ports.abort(task, { sessionKey: task.sessionKey, runId: 'old-run' });
    expect(result).toBeUndefined();
    expect(abortChat).not.toHaveBeenCalled();
    expect(h.platform.useMessageStore.getState().activeTurnBySession[task.sessionKey].runId).toBe('new-run');
  });
});
