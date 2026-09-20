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
      catalogFailed: false,
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
      catalogFailed: false,
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
      catalogFailed: false,
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
      catalogFailed: false,
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
      catalogFailed: false,
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
      catalogFailed: false,
      assistantSnapshot: readyAssistants,
    });

    expect(result.ai.phase).toBe('ready');
    expect(result.assistants.phase).toBe('ready');
    expect(result.isReady).toBe(true);
    expect(result.hasError).toBe(false);
  });

  // ⭐ 2026-09-20（用户报障「使用出现加载模型那个一直卡住」）：
  //    目录**取不到**（连接正常但取失败）原来与"还在取"共用 `undefined` ⇒ 相位永远是 loading，
  //    而 MainArea 的 `readinessBlocked = !conversationReady` 又把输入框一直禁用 ⇒
  //    用户被锁死在输入框外，且看不到任何"出错了"的信号。
  it('⭐ 目录取不到 ⇒ AI 相位是显式失败（不是一直在加载），且不把用户锁在输入框外', () => {
    const result = deriveStartupReadiness({
      gatewayId: 'gw-1',
      gatewayStatus: 'connected',
      rawModelCatalog: undefined,
      catalogFailed: true,
      assistantSnapshot: { ...idleAssistants, phase: 'verifying' },
    });

    expect(result.ai.phase).toBe('catalog-failed');
    expect(result.hasError).toBe(true);
    expect(result.conversationReady).toBe(false);
    expect(result.isReady).toBe(false);
    // 只有"还在准备"才拦输入框；一旦有结论（取不到也是结论）就得给出口。
    expect(result.composerBlocked).toBe(false);
  });

  it('只有"还在准备"才拦输入框（还在启动 / 还在取目录），有结论的一律不拦', () => {
    const starting = deriveStartupReadiness({
      gatewayId: 'gw-1',
      gatewayStatus: 'connecting',
      rawModelCatalog: undefined,
      catalogFailed: false,
      assistantSnapshot: idleAssistants,
    });
    expect(starting.composerBlocked).toBe(true);

    const loading = deriveStartupReadiness({
      gatewayId: 'gw-1',
      gatewayStatus: 'connected',
      rawModelCatalog: undefined,
      catalogFailed: false,
      assistantSnapshot: idleAssistants,
    });
    expect(loading.composerBlocked).toBe(true);

    const ready = deriveStartupReadiness({
      gatewayId: 'gw-1',
      gatewayStatus: 'connected',
      rawModelCatalog: [relayModel],
      catalogFailed: false,
      assistantSnapshot: readyAssistants,
    });
    expect(ready.composerBlocked).toBe(false);

    const noModels = deriveStartupReadiness({
      gatewayId: 'gw-1',
      gatewayStatus: 'connected',
      rawModelCatalog: [{ id: 'local-model', provider: 'local' } as ModelCatalogEntry],
      catalogFailed: false,
      assistantSnapshot: readyAssistants,
    });
    expect(noModels.composerBlocked).toBe(false);
  });
});
