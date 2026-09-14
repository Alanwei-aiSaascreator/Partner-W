import { describe, expect, it, vi } from 'vitest';
import { PRESET_AGENT_DEFINITIONS } from '../src/renderer/lib/preset-agents';
import { installPresetAgentPack } from '../src/renderer/lib/preset-agent-installer';

function createApi() {
  return {
    createAgent: vi.fn(),
    updateAgent: vi.fn(async () => ({ ok: true })),
    setAgentFile: vi.fn(async () => ({ ok: true })),
    deleteAgent: vi.fn(async () => ({ ok: true })),
  };
}

describe('installPresetAgentPack', () => {
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
  });

  it('rolls back an incomplete new role and reports it for retry', async () => {
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
      definitions: PRESET_AGENT_DEFINITIONS.slice(0, 1),
      displayNames: { 'rongying-content': 'Content Creation' },
      api,
    });

    expect(result.installed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([{ id: 'rongying-content', error: 'write denied' }]);
    expect(api.deleteAgent).toHaveBeenCalledWith('gw-1', {
      agentId: 'rongying-content',
      deleteFiles: true,
    });
  });
});
