// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESET_AGENT_DEFINITIONS } from '../src/renderer/lib/preset-agents';
import { createPresetAgentBootstrapCoordinator } from '../src/renderer/lib/preset-agent-bootstrap';
import { useUiStore } from '../src/renderer/stores/uiStore';
import { createBootstrapDeps } from '../src/renderer/hooks/useStartupReadiness';

const gatewayMocks = vi.hoisted(() => ({
  fetchAgentsForGateway: vi.fn(),
  reinitializeGatewayBootstrap: vi.fn(),
}));

vi.mock('../src/renderer/hooks/useGatewayDispatcherSetup', () => gatewayMocks);

interface CatalogAgent {
  id: string;
  name?: string;
  identity?: { name?: string };
}

describe('startup preset-agent production wiring', () => {
  const gatewayId = 'gw-1';
  let agents: Map<string, CatalogAgent>;
  let files: Map<string, Map<string, string>>;
  let failFirstContentSoul: boolean;
  let api: {
    getWorkspacePath: ReturnType<typeof vi.fn>;
    createAgent: ReturnType<typeof vi.fn>;
    updateAgent: ReturnType<typeof vi.fn>;
    getAgentFile: ReturnType<typeof vi.fn>;
    setAgentFile: ReturnType<typeof vi.fn>;
    deleteAgent: ReturnType<typeof vi.fn>;
  };

  const publishCatalog = (): void => {
    useUiStore.setState({
      agentCatalogByGateway: {
        [gatewayId]: { defaultId: 'main', agents: [...agents.values()] },
      },
    } as never);
  };

  const clearApiCalls = (): void => {
    api.createAgent.mockClear();
    api.updateAgent.mockClear();
    api.getAgentFile.mockClear();
    api.setAgentFile.mockClear();
    api.deleteAgent.mockClear();
  };

  beforeEach(() => {
    agents = new Map([['main', { id: 'main', name: 'Main' }]]);
    files = new Map();
    failFirstContentSoul = true;

    gatewayMocks.fetchAgentsForGateway.mockReset().mockImplementation(async () => publishCatalog());
    gatewayMocks.reinitializeGatewayBootstrap.mockReset();

    api = {
      getWorkspacePath: vi.fn(async () => 'E:/荣盈魔方工作区'),
      createAgent: vi.fn(async (_gatewayId: string, params: { name: string; workspace: string }) => {
        const agentId = params.workspace.split('/').at(-1) ?? params.name;
        agents.set(agentId, { id: agentId, name: agentId, identity: { name: agentId } });
        files.set(agentId, new Map());
        return { ok: true, result: { agentId } };
      }),
      updateAgent: vi.fn(async (_gatewayId: string, params: { agentId: string; name?: string }) => {
        const agent = agents.get(params.agentId);
        if (!agent) return { ok: false, error: 'agent not found' };
        if (params.name) agents.set(params.agentId, { ...agent, name: params.name, identity: { name: params.name } });
        return { ok: true, result: { agentId: params.agentId } };
      }),
      getAgentFile: vi.fn(async (_gatewayId: string, agentId: string, name: string) => {
        const content = files.get(agentId)?.get(name);
        return {
          ok: true,
          result: {
            agentId,
            file: content === undefined ? { name, missing: true, content: '' } : { name, missing: false, content },
          },
        };
      }),
      setAgentFile: vi.fn(async (_gatewayId: string, agentId: string, name: string, content: string) => {
        if (agentId === 'rongying-content' && name === 'SOUL.md' && failFirstContentSoul) {
          failFirstContentSoul = false;
          return { ok: false, error: 'simulated exFAT write failure' };
        }
        const agentFiles = files.get(agentId) ?? new Map<string, string>();
        agentFiles.set(name, content);
        files.set(agentId, agentFiles);
        return { ok: true };
      }),
      deleteAgent: vi.fn(async (_gatewayId: string, params: { agentId: string }) => {
        agents.delete(params.agentId);
        files.delete(params.agentId);
        return { ok: true };
      }),
    };

    Object.defineProperty(window, 'clawwork', {
      configurable: true,
      value: api,
    });
    publishCatalog();
  });

  it('⭐ 首轮保留半成品，次轮补齐，三启零写，并能修复 raw-ID 名称', async () => {
    const coordinator = createPresetAgentBootstrapCoordinator();
    const deps = createBootstrapDeps(gatewayId);

    const first = await coordinator.run(gatewayId, deps);
    expect(first.phase).toBe('error');
    expect(first.missingIds).toContain('rongying-content');
    expect(agents.has('rongying-content')).toBe(true);
    expect(files.get('rongying-content')?.has('IDENTITY.md')).toBe(true);
    expect(files.get('rongying-content')?.has('SOUL.md')).toBe(false);
    expect(api.deleteAgent).not.toHaveBeenCalled();

    clearApiCalls();
    const second = await coordinator.run(gatewayId, deps);
    expect(second.phase).toBe('ready');
    expect(api.createAgent).not.toHaveBeenCalled();
    expect(api.updateAgent).not.toHaveBeenCalled();
    expect(api.setAgentFile).toHaveBeenCalledOnce();
    expect(api.setAgentFile).toHaveBeenCalledWith(
      gatewayId,
      'rongying-content',
      'SOUL.md',
      PRESET_AGENT_DEFINITIONS[0].soulMd,
    );
    expect(api.deleteAgent).not.toHaveBeenCalled();

    clearApiCalls();
    const third = await coordinator.run(gatewayId, deps);
    expect(third.phase).toBe('ready');
    expect(api.getAgentFile).toHaveBeenCalledTimes(PRESET_AGENT_DEFINITIONS.length * 2);
    expect(api.createAgent).not.toHaveBeenCalled();
    expect(api.updateAgent).not.toHaveBeenCalled();
    expect(api.setAgentFile).not.toHaveBeenCalled();
    expect(api.deleteAgent).not.toHaveBeenCalled();

    const content = agents.get('rongying-content');
    agents.set('rongying-content', {
      ...content,
      id: 'rongying-content',
      name: 'rongying-content',
      identity: { name: 'rongying-content' },
    });
    clearApiCalls();
    const repairedName = await coordinator.run(gatewayId, deps);
    expect(repairedName.phase).toBe('ready');
    expect(api.updateAgent).toHaveBeenCalledOnce();
    expect(api.updateAgent).toHaveBeenCalledWith(gatewayId, {
      agentId: 'rongying-content',
      name: expect.not.stringMatching(/^rongying-content$/),
    });
    expect(api.setAgentFile).not.toHaveBeenCalled();
  });
});
