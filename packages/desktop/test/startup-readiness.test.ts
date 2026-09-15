import { describe, expect, it } from 'vitest';
import type { ModelCatalogEntry } from '@clawwork/shared';
import { deriveStartupReadiness } from '../src/renderer/lib/startup-readiness';
import type { PresetAgentBootstrapSnapshot } from '../src/renderer/lib/preset-agent-bootstrap';

const idleAssistants: PresetAgentBootstrapSnapshot = {
  phase: 'idle',
  completed: 0,
  total: 6,
  missingIds: [],
};

const readyAssistants: PresetAgentBootstrapSnapshot = {
  phase: 'ready',
  completed: 6,
  total: 6,
  missingIds: [],
};

const relayModel = { id: 'deepseek-v4-flash', provider: 'clawrouter' } as ModelCatalogEntry;

describe('deriveStartupReadiness', () => {
  it('waits for the AI service and assistants before a gateway connects', () => {
    const result = deriveStartupReadiness({
      gatewayId: 'gw-1',
      gatewayStatus: 'connecting',
      rawModelCatalog: undefined,
      assistantSnapshot: idleAssistants,
    });

    expect(result.ai.phase).toBe('starting');
    expect(result.assistants.phase).toBe('waiting');
    expect(result.isReady).toBe(false);
    expect(result.workspaceAvailable).toBe(true);
    expect(result.conversationReady).toBe(false);
  });

  it('keeps a connected missing model catalog in the loading state', () => {
    const result = deriveStartupReadiness({
      gatewayId: 'gw-1',
      gatewayStatus: 'connected',
      rawModelCatalog: undefined,
      assistantSnapshot: { ...idleAssistants, phase: 'verifying' },
    });

    expect(result.ai.phase).toBe('loading-models');
    expect(result.assistants.phase).toBe('verifying');
  });

  it('reports a model error only after a resolved catalog has no relay models', () => {
    const result = deriveStartupReadiness({
      gatewayId: 'gw-1',
      gatewayStatus: 'connected',
      rawModelCatalog: [{ id: 'local-model', provider: 'local' } as ModelCatalogEntry],
      assistantSnapshot: readyAssistants,
    });

    expect(result.ai.phase).toBe('error');
    expect(result.hasError).toBe(true);
    expect(result.isReady).toBe(false);
    expect(result.workspaceAvailable).toBe(true);
    expect(result.conversationReady).toBe(false);
  });

  it('preserves installation progress and current assistant', () => {
    const result = deriveStartupReadiness({
      gatewayId: 'gw-1',
      gatewayStatus: 'connected',
      rawModelCatalog: [relayModel],
      assistantSnapshot: {
        phase: 'installing',
        completed: 2,
        total: 6,
        currentId: 'rongying-office',
        missingIds: ['rongying-office'],
      },
    });

    expect(result.assistants).toMatchObject({
      phase: 'installing',
      completed: 2,
      total: 6,
      currentId: 'rongying-office',
    });
    expect(result.isReady).toBe(false);
    expect(result.workspaceAvailable).toBe(true);
    expect(result.conversationReady).toBe(true);
  });

  it('preserves assistant errors and missing role ids', () => {
    const result = deriveStartupReadiness({
      gatewayId: 'gw-1',
      gatewayStatus: 'connected',
      rawModelCatalog: [relayModel],
      assistantSnapshot: {
        phase: 'error',
        completed: 5,
        total: 6,
        missingIds: ['rongying-family'],
        error: 'write denied',
      },
    });

    expect(result.assistants.phase).toBe('error');
    expect(result.assistants.missingIds).toEqual(['rongying-family']);
    expect(result.hasError).toBe(true);
  });

  it('opens the workspace only when AI and assistants are ready', () => {
    const result = deriveStartupReadiness({
      gatewayId: 'gw-1',
      gatewayStatus: 'connected',
      rawModelCatalog: [relayModel],
      assistantSnapshot: readyAssistants,
    });

    expect(result.ai.phase).toBe('ready');
    expect(result.assistants.phase).toBe('ready');
    expect(result.isReady).toBe(true);
    expect(result.hasError).toBe(false);
  });
});
