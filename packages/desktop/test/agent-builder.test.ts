import { describe, expect, it, vi } from 'vitest';
import { createAgentWithRollback } from '../src/renderer/lib/agent-builder';

describe('createAgentWithRollback', () => {
  it('rolls back the created agent when model update fails', async () => {
    const api = {
      createAgent: vi.fn(async () => ({ ok: true, result: { agentId: 'agent-1' } })),
      updateAgent: vi.fn(async () => ({ ok: false, error: 'invalid model' })),
      deleteAgent: vi.fn(async () => ({ ok: true })),
    };

    const result = await createAgentWithRollback(api, {
      gatewayId: 'gw-1',
      name: 'Writer',
      workspace: 'agents/writer',
      avatar: 'avatar-data',
      model: 'bad-model',
    });

    expect(result).toEqual({ ok: false, error: 'invalid model' });
    expect(api.createAgent).toHaveBeenCalledWith('gw-1', {
      name: 'Writer',
      workspace: 'agents/writer',
      avatar: 'avatar-data',
    });
    expect(api.updateAgent).toHaveBeenCalledWith('gw-1', {
      agentId: 'agent-1',
      model: 'bad-model',
    });
    expect(api.deleteAgent).toHaveBeenCalledWith('gw-1', {
      agentId: 'agent-1',
      deleteFiles: true,
    });
  });

  it('includes rollback failure in the surfaced error', async () => {
    const api = {
      createAgent: vi.fn(async () => ({ ok: true, result: { agentId: 'agent-1' } })),
      updateAgent: vi.fn(async () => ({ ok: false, error: 'invalid model' })),
      deleteAgent: vi.fn(async () => ({ ok: false, error: 'permission denied' })),
    };

    const result = await createAgentWithRollback(api, {
      gatewayId: 'gw-1',
      name: 'Writer',
      workspace: 'agents/writer',
      model: 'bad-model',
    });

    expect(result).toEqual({
      ok: false,
      error: 'invalid model (rollback failed: permission denied)',
    });
  });

  it('rolls back when writing the generated identity fails', async () => {
    const api = {
      createAgent: vi.fn(async () => ({ ok: true, result: { agentId: 'agent-1' } })),
      updateAgent: vi.fn(async () => ({ ok: true })),
      setAgentFile: vi.fn(async () => ({ ok: false, error: 'file write failed' })),
      deleteAgent: vi.fn(async () => ({ ok: true })),
    };

    const result = await createAgentWithRollback(api, {
      gatewayId: 'gw-1',
      name: 'Podcast Planner',
      workspace: 'agents/podcast-planner',
      model: 'deepseek-v4-flash',
      identityContent: '# Identity\nPlan podcast episodes.',
    });

    expect(result).toEqual({ ok: false, error: 'file write failed' });
    expect(api.setAgentFile).toHaveBeenCalledWith(
      'gw-1',
      'agent-1',
      'IDENTITY.md',
      '# Identity\nPlan podcast episodes.',
    );
    expect(api.deleteAgent).toHaveBeenCalledWith('gw-1', { agentId: 'agent-1', deleteFiles: true });
  });

  it('returns an existing assistant with the same generated name without creating a duplicate', async () => {
    const api = {
      createAgent: vi.fn(async () => ({ ok: true, result: { agentId: 'new-agent' } })),
      updateAgent: vi.fn(async () => ({ ok: true })),
      deleteAgent: vi.fn(async () => ({ ok: true })),
    };

    const result = await createAgentWithRollback(api, {
      gatewayId: 'gw-1',
      name: 'Podcast Planner',
      workspace: 'agents/podcast-planner',
      existingAgents: [{ id: 'existing-agent', name: 'Podcast Planner' }],
    });

    expect(result).toEqual({ ok: true, result: { agentId: 'existing-agent', reused: true } });
    expect(api.createAgent).not.toHaveBeenCalled();
  });
});
