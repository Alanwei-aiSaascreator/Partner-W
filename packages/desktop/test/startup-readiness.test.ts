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

  // ⭐⭐ 2026-09-21（第二台机器实机：永远"正在准备模型"）：
  //    主进程**早就知道**那张卡绑在别的组织（`P0001` 已经被翻成安全码），可这份知识
  //    以前只活在 `RelayBootstrapResult` 与调试日志里 ⇒ 渲染层只能一直转圈。
  //    现在公开状态直接进推导：**已知的失败压过"猜出来的正在加载"**。
  it('⭐⭐ 中转确定性失败覆盖"正在加载模型"：落 error、给安全码、不再锁住输入框', () => {
    const result = deriveStartupReadiness({
      gatewayId: 'gw-1',
      gatewayStatus: 'connected',
      rawModelCatalog: undefined,
      catalogFailed: false,
      assistantSnapshot: { ...idleAssistants, phase: 'verifying' },
      relayState: { phase: 'blocked', errorCode: 'license_bound_elsewhere', updatedAt: 3 },
    });

    expect(result.ai.phase, '不许再停在"正在准备模型"').not.toBe('loading-models');
    expect(result.ai.phase).toBe('error');
    // 码**原样留着**（安全闭集），界面按它说话 —— 不是"有没有出错"这种散文判据。
    expect(result.relayFailure).toEqual({ kind: 'organization-mismatch', errorCode: 'license_bound_elsewhere' });
    expect(result.hasError).toBe(true);
    expect(result.conversationReady).toBe(false);
    expect(result.isReady).toBe(false);
  });

  it('⭐ 可重试的传输失败同样覆盖"正在加载模型"：出口是"再试一次"', () => {
    const result = deriveStartupReadiness({
      gatewayId: 'gw-1',
      gatewayStatus: 'connected',
      rawModelCatalog: undefined,
      catalogFailed: false,
      assistantSnapshot: { ...idleAssistants, phase: 'verifying' },
      relayState: { phase: 'retryable-error', errorCode: 'transport', updatedAt: 2 },
    });

    expect(result.ai.phase).not.toBe('loading-models');
    expect(result.relayFailure).toEqual({ kind: 'retryable', errorCode: 'transport' });
    expect(result.hasError).toBe(true);
  });

  /**
   * ⚠️ 判据是 `composerBlocked` —— 这一条就是 2026-09-20 那次"卡住"的形状：
   *    一旦把已知失败也算成"还在准备"，用户又被锁在输入框外，而且这次连"出错"都看不到。
   *    对照组很重要：**没有结论**（还在启动 / 目录还在取）时照旧拦 —— 别把这条读成"永远不拦"。
   */
  it('⭐⭐ 已知的中转失败不许再把用户锁在输入框外（composerBlocked 一律 false）', () => {
    const blockedCodes = [
      'license_required',
      'license_bound_elsewhere',
      'license_not_found',
      'license_inactive',
      'license_expired',
      'activation_limit_reached',
      'activation_failed',
    ] as const;

    for (const errorCode of blockedCodes) {
      const blocked = deriveStartupReadiness({
        gatewayId: 'gw-1',
        gatewayStatus: 'connected',
        rawModelCatalog: undefined,
        catalogFailed: false,
        assistantSnapshot: { ...idleAssistants, phase: 'verifying' },
        relayState: { phase: 'blocked', errorCode, updatedAt: 1 },
      });
      expect(blocked.composerBlocked, `${errorCode} 是终局结论，不该拦住输入框`).toBe(false);
    }

    const retryable = deriveStartupReadiness({
      gatewayId: 'gw-1',
      gatewayStatus: 'connected',
      rawModelCatalog: undefined,
      catalogFailed: false,
      assistantSnapshot: { ...idleAssistants, phase: 'verifying' },
      relayState: { phase: 'retryable-error', errorCode: 'relay_apply_failed', updatedAt: 1 },
    });
    expect(retryable.composerBlocked).toBe(false);

    // 对照组：确实还在准备（连接还没建立 / 目录还在取）时照旧拦着。
    const stillPreparing = deriveStartupReadiness({
      gatewayId: 'gw-1',
      gatewayStatus: 'connecting',
      rawModelCatalog: undefined,
      catalogFailed: false,
      assistantSnapshot: idleAssistants,
      relayState: { phase: 'running', updatedAt: 1 },
    });
    expect(stillPreparing.composerBlocked).toBe(true);
  });

  /**
   * ⭐ `idle` / `running` **不是失败**："还不知道"（从没跑过、显式登出）与"这一轮在跑"
   *    都沿用目录那条**有界**行为（最终会落到取到 / 确实没有 / 取不到三个结论之一），
   *    既不报错、也不冒进度。把 `idle` 说成"正在准备"正是原来那个无限等待的形状。
   */
  it('⭐ idle / running / ready 都不覆盖目录推断（"还不知道"不是失败）', () => {
    const phases = ['idle', 'running', 'ready'] as const;

    for (const phase of phases) {
      const waiting = deriveStartupReadiness({
        gatewayId: 'gw-1',
        gatewayStatus: 'connected',
        rawModelCatalog: undefined,
        catalogFailed: false,
        assistantSnapshot: idleAssistants,
        relayState: { phase, updatedAt: 1 },
      });
      expect(waiting.relayFailure, `${phase} 不是失败结论`).toBeNull();
      expect(waiting.ai.phase, `${phase} 不改变目录推断`).toBe('loading-models');
      expect(waiting.hasError).toBe(false);
      expect(waiting.composerBlocked, `${phase} 时"还在取目录"照样拦`).toBe(true);
    }

    // `ready` 的语义是"中转配置已经在网关上" —— **不等于**目录已经到了。
    const catalogArrived = deriveStartupReadiness({
      gatewayId: 'gw-1',
      gatewayStatus: 'connected',
      rawModelCatalog: [relayModel],
      catalogFailed: false,
      assistantSnapshot: readyAssistants,
      relayState: { phase: 'ready', updatedAt: 1 },
    });
    expect(catalogArrived.ai.phase).toBe('ready');
    expect(catalogArrived.isReady).toBe(true);
    expect(catalogArrived.relayFailure).toBeNull();
  });

  it('缺省（还没读到公开状态）与 idle 同义：不凭空报错', () => {
    const missing = deriveStartupReadiness({
      gatewayId: 'gw-1',
      gatewayStatus: 'connected',
      rawModelCatalog: undefined,
      catalogFailed: false,
      assistantSnapshot: idleAssistants,
    });

    expect(missing.relayFailure).toBeNull();
    expect(missing.ai.phase).toBe('loading-models');
    expect(missing.hasError).toBe(false);
  });
});
