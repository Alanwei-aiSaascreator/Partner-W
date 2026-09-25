import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ModelCatalogEntry, WorkspaceFsIdentity } from '@clawwork/shared';
import {
  deriveStartupReadiness,
  gatewayFailureText,
  startupBlockerText,
  startupFailureText,
} from '../src/renderer/lib/startup-readiness';
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

  /**
   * ⭐ 2026-09-21（复核）：`activation_limit_reached` 必须**单独一档**。
   *
   * 它和其它六个"卡失效"码的出口**不一样**：那些码的出路是"重新激活 / 换一张卡"，
   * 而这一条是**这张卡的名额满了** —— 复核实测激活页今天没有设备列表、也没有解绑入口，
   * 所以"去激活"对它是近似死路。混在一档里就等于给用户一个按了没用的按钮。
   */
  it('⭐ `activation_limit_reached` 单独一档（名额已满 ≠ 卡失效，出口不同）', () => {
    const result = deriveStartupReadiness({
      gatewayId: 'gw-1',
      gatewayStatus: 'connected',
      rawModelCatalog: undefined,
      catalogFailed: false,
      assistantSnapshot: { ...idleAssistants, phase: 'verifying' },
      relayState: { phase: 'blocked', errorCode: 'activation_limit_reached', updatedAt: 1 },
    });

    expect(result.relayFailure).toEqual({ kind: 'activation-limit-reached', errorCode: 'activation_limit_reached' });
    expect(result.hasError).toBe(true);
    expect(result.composerBlocked).toBe(false);

    // 对照：其余的确定性码仍然归"卡失效"那一档。
    for (const errorCode of [
      'license_not_found',
      'license_expired',
      'license_inactive',
      'activation_failed',
    ] as const) {
      const other = deriveStartupReadiness({
        gatewayId: 'gw-1',
        gatewayStatus: 'connected',
        rawModelCatalog: undefined,
        catalogFailed: false,
        assistantSnapshot: { ...idleAssistants, phase: 'verifying' },
        relayState: { phase: 'blocked', errorCode, updatedAt: 1 },
      });
      expect(other.relayFailure, `${errorCode} 仍归卡失效`).toEqual({ kind: 'entitlement-rejected', errorCode });
    }
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

/**
 * 助手失败时**到底该怪什么**（2026-09-25）。
 *
 * 真机形状：FAT32 的盘上六个预置助手全报 `unsafe workspace file`，界面只有一句"助手失败"，
 * 用户无从知道要换块盘。判据要**两个独立信号都对上**才敢说：
 * ①助手**确实**失败了（`assistants.phase === 'error'`）；②那次文件系统探测量到零身份/不可写。
 * 只有 ①：说不出所以然（照旧给通用那句）；只有 ②：不许冤枉一块好盘（探测可能是错的）。
 */
describe('deriveStartupReadiness —— 助手失败时的文件系统判据', () => {
  const failedAssistants: PresetAgentBootstrapSnapshot = {
    phase: 'error',
    completed: 0,
    total: 6,
    missingIds: ['rongying-content'],
    error: 'unsafe workspace file "IDENTITY.md"',
  };

  function deriveWith(identity: WorkspaceFsIdentity | null, assistantSnapshot = failedAssistants) {
    return deriveStartupReadiness({
      gatewayId: 'gw-1',
      gatewayStatus: 'connected',
      rawModelCatalog: [relayModel],
      catalogFailed: false,
      assistantSnapshot,
      workspaceFsIdentity: identity,
    });
  }

  it('⭐ 助手失败 + 零身份 ⇒ 判 workspace-filesystem-unsupported（FAT32 那条）', () => {
    expect(deriveWith({ state: 'unsupported-identity', dev: '0', ino: '851386624' }).assistantBlocker).toBe(
      'workspace-filesystem-unsupported',
    );
  });

  it('⭐ 助手失败 + 探测建不出文件 ⇒ 判 workspace-unwritable（只读盘/没权限）', () => {
    expect(deriveWith({ state: 'unwritable', dev: null, ino: null }).assistantBlocker).toBe('workspace-unwritable');
  });

  it('⭐ 负对照：文件系统正常但助手仍然失败 ⇒ **不许**怪文件系统', () => {
    expect(deriveWith({ state: 'ok', dev: '1611287400', ino: '4785074606070117' }).assistantBlocker).toBeNull();
  });

  it('⭐ 负对照：量到零身份但助手**没失败** ⇒ 不下结论（探测可能是错的，别冤枉一块好盘）', () => {
    expect(
      deriveWith({ state: 'unsupported-identity', dev: '0', ino: '1' }, readyAssistants).assistantBlocker,
    ).toBeNull();
  });

  it('unknown / 还没探测（null / 缺省）⇒ 不下结论', () => {
    expect(deriveWith({ state: 'unknown', dev: null, ino: null }).assistantBlocker).toBeNull();
    expect(deriveWith(null).assistantBlocker).toBeNull();
    expect(
      deriveStartupReadiness({
        gatewayId: 'gw-1',
        gatewayStatus: 'connected',
        rawModelCatalog: [relayModel],
        catalogFailed: false,
        assistantSnapshot: failedAssistants,
      }).assistantBlocker,
    ).toBeNull();
  });
});

describe('startupBlockerText / startupFailureText —— 说给用户的话', () => {
  const t = (key: string) => key;

  it('两档各说各的话（文件系统不支持 vs 不可写，出口不同）', () => {
    expect(startupBlockerText('workspace-filesystem-unsupported', t)).toBe(
      'startupReadiness.workspaceFilesystemUnsupported',
    );
    expect(startupBlockerText('workspace-unwritable', t)).toBe('startupReadiness.workspaceUnwritable');
  });

  it('没有 blocker ⇒ null（不许多说一句）', () => {
    expect(startupBlockerText(null, t)).toBeNull();
  });

  it('⭐ 欢迎屏那一格（startupFailureText）也要说这句 —— 用户最先看到的是它', () => {
    const readiness = deriveStartupReadiness({
      gatewayId: 'gw-1',
      gatewayStatus: 'connected',
      rawModelCatalog: [relayModel],
      catalogFailed: false,
      assistantSnapshot: {
        phase: 'error',
        completed: 0,
        total: 6,
        missingIds: ['rongying-content'],
        error: 'unsafe workspace file "IDENTITY.md"',
      },
      workspaceFsIdentity: { state: 'unsupported-identity', dev: '0', ino: '851386624' },
    });
    expect(startupFailureText(readiness, t)).toBe('startupReadiness.workspaceFilesystemUnsupported');
  });
});

describe('连接层已经放弃时，不许再说"正在准备模型"', () => {
  const base = {
    gatewayId: 'gw-1',
    gatewayStatus: 'disconnected' as const,
    rawModelCatalog: undefined,
    catalogFailed: false,
    assistantSnapshot: idleAssistants,
  };

  it('gaveUp 的连接是**有结论的失败**，不是"正在准备"', () => {
    const result = deriveStartupReadiness({
      ...base,
      gatewayReconnect: { attempt: 10, max: 10, gaveUp: true },
    });

    // 判据是"不许是准备相位"：这是用户报"一直准备模型"的那一格
    expect(result.ai.phase).not.toBe('starting');
    expect(result.ai.phase).not.toBe('loading-models');
    // 有结论就必须给出口：不能永远锁着输入框，也要让界面说得出"出错了"
    expect(result.composerBlocked).toBe(false);
    expect(result.hasError).toBe(true);
  });

  it('对照：还没放弃（第 3/10 次）时，照旧是"正在准备"', () => {
    const result = deriveStartupReadiness({
      ...base,
      gatewayReconnect: { attempt: 3, max: 10, gaveUp: false },
    });

    expect(result.ai.phase).toBe('starting');
    expect(result.composerBlocked).toBe(true);
  });

  it('对照：没有重连信息（从没连过）时，照旧是"正在准备"', () => {
    const result = deriveStartupReadiness({ ...base });

    expect(result.ai.phase).toBe('starting');
    expect(result.composerBlocked).toBe(true);
  });
});

/**
 * 本机运行时（18789 那个网关）起不来时，界面得说得出**是哪一类**失败。
 *
 * 判据只有一条：**知道的**要如实说出来，且只说得出闭集里的那个值；
 * 不知道的一律 `null`（界面自己编文案 = 猜）。而**连上了就必须清掉** ——
 * 否则会出现反向的假话：明明好了，界面上还挂着"18789 被别的东西占用"。
 */
describe('本机运行时起不来：把「为什么」如实说出来，连上了就闭嘴', () => {
  const base = {
    gatewayId: 'gw-1',
    gatewayStatus: 'disconnected' as const,
    rawModelCatalog: undefined,
    catalogFailed: false,
    assistantSnapshot: idleAssistants,
  };

  it('18789 被别的程序占用 ⇒ 有结论的失败，且说得出是哪一类', () => {
    const result = deriveStartupReadiness({ ...base, runtimeBootstrapFailure: 'port-occupied' });

    expect(result.ai.phase).toBe('error');
    expect(result.ai.failureReason).toBe('port-occupied');
    // 有结论就必须给出口：不能锁着输入框，也不能继续转圈
    expect(result.composerBlocked).toBe(false);
    expect(result.hasError).toBe(true);
  });

  it('等就绪超时与子进程早退各自说得出是哪一类，而且都给了出口', () => {
    const timedOut = deriveStartupReadiness({ ...base, runtimeBootstrapFailure: 'ready-timeout' });
    const exited = deriveStartupReadiness({ ...base, runtimeBootstrapFailure: 'process-exited' });

    expect(timedOut.ai.failureReason).toBe('ready-timeout');
    expect(exited.ai.failureReason).toBe('process-exited');
    // ⚠️ 只断言 reason 是不够的：一个"说出了原因、却还把输入框锁着"的实现会溜过去，
    //    而那正是用户最受不了的形状（看得见原因，一个字打不出去）。两个都钉。
    for (const result of [timedOut, exited]) {
      expect(result.ai.phase).toBe('error');
      expect(result.composerBlocked).toBe(false);
    }
  });

  it('⭐ 连上了就不许再说"坏着"：启动那一刻被占过，后来自己起来了也要清掉', () => {
    const result = deriveStartupReadiness({
      ...base,
      gatewayStatus: 'connected',
      rawModelCatalog: [relayModel],
      assistantSnapshot: readyAssistants,
      // 启动那一刻确实撞过端口 —— 但不能因为**曾经**坏过就一直挂着一句假话
      runtimeBootstrapFailure: 'port-occupied',
    });

    expect(result.ai.phase).toBe('ready');
    expect(result.ai.failureReason).toBeNull();
  });

  it('没有失败信号 ⇒ null（不知道就说不知道，界面不许自己编）', () => {
    expect(deriveStartupReadiness({ ...base }).ai.failureReason).toBeNull();
  });

  it('对照：还在起的时候不给失败原因（那时候确实还没结论）', () => {
    const result = deriveStartupReadiness({ ...base, gatewayStatus: 'connecting' });

    expect(result.ai.phase).toBe('starting');
    expect(result.ai.failureReason).toBeNull();
  });

  it('⭐ 连上了但网关不认我们（gaveUp + 原因）⇒ 说得出是"被拒绝"', () => {
    const result = deriveStartupReadiness({
      ...base,
      gatewayReconnect: { attempt: 10, max: 10, gaveUp: true, reason: 'auth-rejected' },
    });

    expect(result.ai.phase).toBe('error');
    expect(result.ai.failureReason).toBe('auth-rejected');
    expect(result.composerBlocked).toBe(false);
  });

  it('gaveUp 但说不出哪一类（没有原因）⇒ 仍然是有结论的失败，只是原因是 null', () => {
    const result = deriveStartupReadiness({
      ...base,
      gatewayReconnect: { attempt: 10, max: 10, gaveUp: true },
    });

    // ⚠️ 这两件事必须分开：**"有没有结论"**（phase）与**"说得出是哪一类"**（reason）。
    //    把 reason 的有无当成"有没有结论"，就会让说不出原因的那一类重新转圈。
    expect(result.ai.phase).toBe('error');
    expect(result.ai.failureReason).toBeNull();
  });

  it('⭐ 还没放弃时，连接层那个原因**不**上界面（还在重连，没有结论）', () => {
    const result = deriveStartupReadiness({
      ...base,
      gatewayReconnect: { attempt: 3, max: 10, gaveUp: false, reason: 'auth-rejected' },
    });

    expect(result.ai.phase).toBe('starting');
    expect(result.ai.failureReason).toBeNull();
  });

  it('⭐ 两处都有原因时：本机运行时没起来赢（它更接近根因）', () => {
    const result = deriveStartupReadiness({
      ...base,
      runtimeBootstrapFailure: 'port-occupied',
      gatewayReconnect: { attempt: 10, max: 10, gaveUp: true, reason: 'auth-rejected' },
    });

    expect(result.ai.failureReason).toBe('port-occupied');
  });

  it('中转失败是**另一件事**：它不冒充"本机运行时起不来"', () => {
    const result = deriveStartupReadiness({
      ...base,
      relayState: { phase: 'blocked', errorCode: 'license_bound_elsewhere', updatedAt: 3 },
    });

    expect(result.ai.phase).toBe('error');
    expect(result.relayFailure).toBeTruthy();
    expect(result.ai.failureReason).toBeNull();
  });
});

/**
 * ⭐ C2：**四类失败各自说得出话**。
 *
 * 原来只有一句笼统的「暂时没有可用模型」—— 端口被别的程序占着、凭据被拒、
 * 我们自己的子进程早退、等就绪等满超时，用户看到的是**同一句话**，
 * 而它们该做的事完全不同（关掉那个程序 / 查凭据 / 重新准备 / 等或重试）。
 */
describe('网关失败：四类各自说得出话，说不清的交给通用那句', () => {
  const key = (k: string) => k;
  /** 真的 zh 文案（`startupReadiness` 那一层）。 */
  const readZh = (): Record<string, string> =>
    (
      JSON.parse(readFileSync(new URL('../src/renderer/i18n/locales/zh.json', import.meta.url), 'utf8')) as {
        startupReadiness: Record<string, string>;
      }
    ).startupReadiness;
  const strip = (fullKey: string | null): string => (fullKey ?? '').replace('startupReadiness.', '');
  const withReason = (reason: 'port-occupied' | 'auth-rejected' | 'process-exited' | 'ready-timeout' | 'unknown') =>
    deriveStartupReadiness({
      gatewayId: 'gw-1',
      gatewayStatus: 'disconnected',
      rawModelCatalog: undefined,
      catalogFailed: false,
      assistantSnapshot: idleAssistants,
      runtimeBootstrapFailure: reason,
    });

  it('端口被占 ⇒ 说得出是"被别的程序占用"', () => {
    expect(gatewayFailureText(withReason('port-occupied'), key)).toBe('startupReadiness.gatewayPortOccupied');
  });

  it('凭据被拒 ⇒ 说得出是"网关拒绝了这次连接"', () => {
    expect(gatewayFailureText(withReason('auth-rejected'), key)).toBe('startupReadiness.gatewayAuthRejected');
  });

  it('子进程早退 / 等就绪超时 ⇒ 各自一句', () => {
    expect(gatewayFailureText(withReason('process-exited'), key)).toBe('startupReadiness.gatewayProcessExited');
    expect(gatewayFailureText(withReason('ready-timeout'), key)).toBe('startupReadiness.gatewayReadyTimeout');
  });

  it('⭐ `unknown` **不冒充**具体原因：交给通用那句', () => {
    expect(gatewayFailureText(withReason('unknown'), key)).toBeNull();
  });

  it('⭐ 没有结论时也不编（还没失败就没有失败的话）', () => {
    const clean = deriveStartupReadiness({
      gatewayId: 'gw-1',
      gatewayStatus: 'connecting',
      rawModelCatalog: undefined,
      catalogFailed: false,
      assistantSnapshot: idleAssistants,
    });
    expect(gatewayFailureText(clean, key)).toBeNull();
  });

  it('⭐⭐ 四句中文**两两不同**（抄错一句就会两处一模一样）', () => {
    // 用**真文案**而不是 key：key 天然互不相同，那样这条就白测了。
    const zh = readZh();
    // ⚠️ 返回的是**带前缀**的 key，查表前要去掉前缀（第一版就是栽在这里）。
    const texts = (['port-occupied', 'auth-rejected', 'process-exited', 'ready-timeout'] as const).map(
      (reason) => zh[strip(gatewayFailureText(withReason(reason), key))],
    );
    expect(texts.every((text) => typeof text === 'string' && text.length > 0)).toBe(true);
    expect(new Set(texts).size, '四句话必须互不相同').toBe(4);
  });

  it('⭐⭐ 被拒那句**不许带凭据类字样**（它要过 IPC、上界面、进截图）', () => {
    const zh = readZh();
    const text = zh[strip(gatewayFailureText(withReason('auth-rejected'), key))];
    expect(typeof text).toBe('string');
    for (const forbidden of ['token', 'Token', 'TOKEN', '密钥', '卡密', '手机号', '验证码']) {
      expect(text).not.toContain(forbidden);
    }
  });
});
