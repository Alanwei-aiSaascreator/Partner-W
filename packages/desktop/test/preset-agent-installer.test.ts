import { describe, expect, it, vi, type Mocked } from 'vitest';
import { PRESET_AGENT_DEFINITIONS } from '../src/renderer/lib/preset-agents';
import { installPresetAgentPack, type PresetAgentInstallerApi } from '../src/renderer/lib/preset-agent-installer';

function createApi(): Mocked<PresetAgentInstallerApi> {
  return {
    createAgent: vi.fn<PresetAgentInstallerApi['createAgent']>(),
    updateAgent: vi.fn<PresetAgentInstallerApi['updateAgent']>().mockResolvedValue({ ok: true }),
    getAgentFile: vi
      .fn<PresetAgentInstallerApi['getAgentFile']>()
      .mockImplementation(async (_gatewayId, agentId, name) => ({
        ok: true,
        result: { agentId, file: { name, missing: false, content: '# existing\n' } },
      })),
    setAgentFile: vi.fn<PresetAgentInstallerApi['setAgentFile']>().mockResolvedValue({ ok: true }),
    deleteAgent: vi.fn<PresetAgentInstallerApi['deleteAgent']>().mockResolvedValue({ ok: true }),
  };
}

describe('installPresetAgentPack', () => {
  it('⭐ second startup verifies complete presets with zero mutations', async () => {
    const api = createApi();

    const result = await installPresetAgentPack({
      gatewayId: 'gw-1',
      workspaceRoot: 'E:/cube',
      currentAgentIds: ['main', 'rongying-content'],
      verifyExisting: true,
      definitions: PRESET_AGENT_DEFINITIONS.slice(0, 1),
      displayNames: { 'rongying-content': '内容创作' },
      api,
    });

    expect(result).toEqual({ installed: [], skipped: ['rongying-content'], failed: [] });
    expect(api.getAgentFile).toHaveBeenCalledTimes(2);
    expect(api.createAgent).not.toHaveBeenCalled();
    expect(api.updateAgent).not.toHaveBeenCalled();
    expect(api.setAgentFile).not.toHaveBeenCalled();
    expect(api.deleteAgent).not.toHaveBeenCalled();
  });

  it('skips existing roles and configures only missing roles', async () => {
    const api = createApi();
    api.createAgent.mockResolvedValue({
      ok: true,
      result: { agentId: 'rongying-video' },
    });

    const result = await installPresetAgentPack({
      gatewayId: 'gw-1',
      workspaceRoot: 'D:/cube',
      currentAgentIds: ['main', 'rongying-content'],
      verifyExisting: true,
      definitions: PRESET_AGENT_DEFINITIONS.slice(0, 2),
      displayNames: {
        'rongying-content': 'Content Creation',
        'rongying-video': 'Video Production',
      },
      api,
    });

    expect(result).toEqual({
      installed: ['rongying-video'],
      skipped: ['rongying-content'],
      failed: [],
    });
    expect(api.createAgent).toHaveBeenCalledOnce();
    expect(api.createAgent).toHaveBeenCalledWith('gw-1', {
      name: 'rongying-video',
      workspace: 'D:/cube/rongying-agents/rongying-video',
      emoji: '🎬',
    });
    expect(api.updateAgent).toHaveBeenCalledWith('gw-1', {
      agentId: 'rongying-video',
      name: 'Video Production',
    });
    expect(api.setAgentFile).toHaveBeenCalledTimes(2);
    expect(api.setAgentFile).toHaveBeenNthCalledWith(
      1,
      'gw-1',
      'rongying-video',
      'IDENTITY.md',
      PRESET_AGENT_DEFINITIONS[1].identityMd,
    );
    expect(api.setAgentFile).toHaveBeenNthCalledWith(
      2,
      'gw-1',
      'rongying-video',
      'SOUL.md',
      PRESET_AGENT_DEFINITIONS[1].soulMd,
    );
    expect(api.getAgentFile).toHaveBeenCalledTimes(2);
  });

  it('leaves an incomplete new role for idempotent repair instead of creating an exFAT deletion tombstone', async () => {
    const api = createApi();
    api.createAgent.mockResolvedValue({
      ok: true,
      result: { agentId: 'rongying-content' },
    });
    api.setAgentFile.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, error: 'write denied' });

    const result = await installPresetAgentPack({
      gatewayId: 'gw-1',
      workspaceRoot: 'D:/cube/',
      currentAgentIds: ['main'],
      preservePartialOnFailure: true,
      definitions: PRESET_AGENT_DEFINITIONS.slice(0, 1),
      displayNames: { 'rongying-content': 'Content Creation' },
      api,
    });

    expect(result.installed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([{ id: 'rongying-content', error: 'write denied' }]);
    expect(api.deleteAgent).not.toHaveBeenCalled();
  });

  it('⭐⭐ repairs a missing SOUL file without deleting, recreating, or rewriting an existing identity/name', async () => {
    const api = createApi();
    api.getAgentFile.mockImplementation(async (_gatewayId, agentId, name) => ({
      ok: true,
      result: {
        agentId,
        file: name === 'SOUL.md' ? { name, missing: true, content: '' } : { name, missing: false, content: '# kept\n' },
      },
    }));

    const result = await installPresetAgentPack({
      gatewayId: 'gw-1',
      workspaceRoot: 'E:/cube',
      currentAgentIds: ['main', 'rongying-content'],
      verifyExisting: true,
      definitions: PRESET_AGENT_DEFINITIONS.slice(0, 1),
      displayNames: { 'rongying-content': '内容创作' },
      api,
    });

    expect(result).toEqual({ installed: ['rongying-content'], skipped: [], failed: [] });
    expect(api.createAgent).not.toHaveBeenCalled();
    expect(api.deleteAgent).not.toHaveBeenCalled();
    expect(api.updateAgent).not.toHaveBeenCalled();
    expect(api.setAgentFile).toHaveBeenCalledOnce();
    expect(api.setAgentFile).toHaveBeenCalledWith(
      'gw-1',
      'rongying-content',
      'SOUL.md',
      PRESET_AGENT_DEFINITIONS[0].soulMd,
    );
  });

  it('⭐ repairs a stable-id display name while preserving two complete user-editable files', async () => {
    const api = createApi();

    const result = await installPresetAgentPack({
      gatewayId: 'gw-1',
      workspaceRoot: 'E:/cube',
      currentAgentIds: ['main', 'rongying-content'],
      repairAgentIds: ['rongying-content'],
      definitions: PRESET_AGENT_DEFINITIONS.slice(0, 1),
      displayNames: { 'rongying-content': '内容创作' },
      api,
    });

    expect(result).toEqual({ installed: ['rongying-content'], skipped: [], failed: [] });
    expect(api.createAgent).not.toHaveBeenCalled();
    expect(api.updateAgent).toHaveBeenCalledWith('gw-1', {
      agentId: 'rongying-content',
      name: '内容创作',
    });
    expect(api.setAgentFile).not.toHaveBeenCalled();
    expect(api.deleteAgent).not.toHaveBeenCalled();
  });
});
