import { describe, expect, it, vi } from 'vitest';
import { createAgentWithRollback } from '../src/renderer/lib/agent-builder';
import { toSlug } from '../src/renderer/layouts/TeamsPanel/utils';

describe('createAgentWithRollback', () => {
  it('creates a Chinese assistant with a stable legacy id then restores its name without losing identity', async () => {
    const name = '\u878d\u8d44\u4e3b\u7ba1';
    const id = toSlug(name);
    const api = {
      createAgent: vi.fn(async (_gatewayId: string, params: { name: string }) => ({
        ok: true,
        result: { agentId: params.name },
      })),
      updateAgent: vi.fn(async () => ({ ok: true })),
      setAgentFile: vi.fn(async () => ({ ok: true })),
      deleteAgent: vi.fn(async () => ({ ok: true })),
    };
    const result = await createAgentWithRollback(api, {
      gatewayId: 'gw-1',
      name,
      workspace: `/w/${id}`,
      identityContent: 'Custom identity body',
      model: 'model-1',
    });

    expect(result).toMatchObject({ ok: true, result: { agentId: id } });
    expect(api.createAgent).toHaveBeenCalledWith('gw-1', { name: id, workspace: `/w/${id}`, avatar: undefined });
    expect(api.setAgentFile).toHaveBeenCalledWith('gw-1', id, 'IDENTITY.md', `Custom identity body\n\n- Name: ${name}`);
    expect(api.updateAgent).toHaveBeenLastCalledWith('gw-1', { agentId: id, name });
    expect(api.updateAgent.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      api.setAgentFile.mock.invocationCallOrder[0],
    );
  });

  it('does not conflate different display names sharing the same ASCII suffix', async () => {
    const api = {
      createAgent: vi.fn(async (_gatewayId: string, params: { name: string }) => ({
        ok: true,
        result: { agentId: params.name },
      })),
      updateAgent: vi.fn(async () => ({ ok: true })),
      deleteAgent: vi.fn(async () => ({ ok: true })),
    };
    const result = await createAgentWithRollback(api, {
      gatewayId: 'gw-1',
      name: '\u878d\u8d44 A1',
      workspace: '/w/a1-2',
      existingAgents: [{ id: 'a1', name: '\u5546\u4e1a A1' }],
    });

    expect(result).toMatchObject({ ok: true, result: { agentId: 'a1-2' } });
  });

  it('rolls back when setting the display name fails even without a model', async () => {
    const api = {
      createAgent: vi.fn(async () => ({ ok: true, result: { agentId: 'writer' } })),
      updateAgent: vi.fn(async () => ({ ok: false, error: 'name rejected' })),
      deleteAgent: vi.fn(async () => ({ ok: true })),
    };
    const result = await createAgentWithRollback(api, { gatewayId: 'gw-1', name: 'Writer', workspace: '/w/writer' });

    expect(result).toMatchObject({ ok: false, error: 'name rejected' });
    expect(api.deleteAgent).toHaveBeenCalledWith('gw-1', { agentId: 'writer', deleteFiles: true });
  });

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
      name: 'writer',
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
      '# Identity\nPlan podcast episodes.\n\n- Name: Podcast Planner',
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
