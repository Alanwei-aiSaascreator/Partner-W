import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayPortOccupiedError } from '../src/main/runtime/gateway-process.js';
import type { RuntimeBootstrapDeps } from '../src/main/runtime/index.js';

/**
 * 编排层：**只有顺序，没有逻辑**。
 *
 * 这里钉的是两件在真实机器上很难复现的事：
 *   ① **顺序** —— 先部署（或先认本机缓存）再起网关；token 对齐在两者之前。
 *   ② **软失败** —— 部署失败**不能抛**，要 resolve 出一个带原因的结果：
 *      上一轮留下的、或用户自己的网关可能还活着，`initAllGateways()` 照常要去连它，
 *      让 ConnectionBanner 说真话。抛出去 = 整个启动挂掉 = 用户看到白屏。
 *
 * electron 只是为了让依赖链上的模块能加载（本层不碰 app）。
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => 'C:\\fake\\userdata'), getVersion: vi.fn(() => '0.0.0') },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false), encryptString: vi.fn(), decryptString: vi.fn() },
}));

const USER_DATA = 'C:\\fake\\userdata';

function makeDeps(over: Partial<RuntimeBootstrapDeps> = {}) {
  const calls: string[] = [];
  const deps: RuntimeBootstrapDeps = {
    alignClientConfig: vi.fn(async () => {
      calls.push('alignClientConfig');
      return { token: 'tok-1', stateDir: 'C:\\fake\\userdata\\openclaw-state' };
    }),
    readCached: vi.fn(() => {
      calls.push('readCached');
      return { status: 'missing' as const };
    }),
    deployFromMedia: vi.fn(async () => {
      calls.push('deployFromMedia');
      return {
        status: 'deployed' as const,
        deploymentKey: 'k1',
        deployedRoot: 'C:\\fake\\userdata\\runtime\\deployed\\k1',
        nodePath: 'C:\\fake\\userdata\\runtime\\deployed\\k1\\node\\node.exe',
        cliPath: 'C:\\fake\\userdata\\runtime\\deployed\\k1\\node_modules\\openclaw\\openclaw.mjs',
      };
    }),
    resolveNode: vi.fn(async () => {
      calls.push('resolveNode');
      return {
        ok: true as const,
        node: {
          exe: 'C:\\fake\\userdata\\runtime\\deployed\\k1\\node\\node.exe',
          version: '26.3.1',
          origin: 'deployed' as const,
        },
        attempts: [],
      };
    }),
    startGateway: vi.fn(async () => {
      calls.push('startGateway');
      return { ownership: 'spawned' as const, pid: 123, decision: { verdict: 'spawn' as const, reason: 'x' } };
    }),
    setStateDirEnv: vi.fn((dir: string) => {
      calls.push(`setStateDirEnv:${dir}`);
    }),
    log: vi.fn(),
    now: () => 1000,
    ...over,
  };
  return { deps, calls };
}

describe('bootstrapLocalGatewayRuntime', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('⭐ 顺序：对齐配置 → 认缓存 → 部署 → 解析 Node → 起网关', async () => {
    const { deps, calls } = makeDeps();
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');

    const res = await bootstrapLocalGatewayRuntime({ userDataDir: USER_DATA, deps });

    expect(calls).toEqual([
      'alignClientConfig',
      'setStateDirEnv:C:\\fake\\userdata\\openclaw-state',
      'readCached',
      'deployFromMedia',
      'resolveNode',
      'startGateway',
    ]);
    expect(res.ok).toBe(true);
    expect(res.ownership).toBe('spawned');
  });

  it('⭐ 本机缓存可用 ⇒ **不去碰盘**（拔盘后走的就是这条）', async () => {
    const { deps, calls } = makeDeps({
      readCached: vi.fn(() => ({
        status: 'ok' as const,
        deploymentKey: 'k1',
        deployedRoot: 'C:\\cache\\k1',
        nodePath: 'C:\\cache\\k1\\node\\node.exe',
        cliPath: 'C:\\cache\\k1\\node_modules\\openclaw\\openclaw.mjs',
      })),
    });
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');

    const res = await bootstrapLocalGatewayRuntime({ userDataDir: USER_DATA, deps });

    expect(calls).not.toContain('deployFromMedia');
    expect(calls).toContain('startGateway');
    expect(res.ok).toBe(true);
    expect(res.deploymentKey).toBe('k1');
  });

  it('⭐ state 目录要写进进程 env（media/resolve 读的就是它，不设的话聊天里的图片静默读不到）', async () => {
    const { deps, calls } = makeDeps();
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');

    await bootstrapLocalGatewayRuntime({ userDataDir: USER_DATA, deps });

    expect(calls).toContain('setStateDirEnv:C:\\fake\\userdata\\openclaw-state');
    // 必须早于起网关
    expect(calls.indexOf('setStateDirEnv:C:\\fake\\userdata\\openclaw-state')).toBeLessThan(
      calls.indexOf('startGateway'),
    );
  });

  it('⭐ 部署失败 ⇒ **resolve 出带原因的结果，不抛**（界面照常起来，让 Banner 说真话）', async () => {
    const { deps, calls } = makeDeps({
      deployFromMedia: vi.fn(async () => {
        calls.push('deployFromMedia');
        throw new Error('运行时盘上找不到 Node 可执行文件：Z:\\node\\node.exe');
      }),
    });
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');

    const res = await bootstrapLocalGatewayRuntime({ userDataDir: USER_DATA, deps });

    expect(res.ok).toBe(false);
    expect(res.reason).toContain('Z:\\node\\node.exe');
    expect(res.deploymentKey).toBeUndefined();
    // 没部署成功就不要再去起网关
    expect(calls).not.toContain('startGateway');
  });

  it('⭐ 端口被别人的网关占着 ⇒ 结果里带明确 code（界面据此说"端口冲突"）', async () => {
    const { deps } = makeDeps({
      startGateway: vi.fn(async () => {
        throw new GatewayPortOccupiedError('端口 18789 被另一个 OpenClaw 网关占用');
      }),
    });
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');

    const res = await bootstrapLocalGatewayRuntime({ userDataDir: USER_DATA, deps });

    expect(res.ok).toBe(false);
    expect(res.code).toBe('runtime.gateway-port-occupied');
    expect(res.reason).toContain('18789');
  });

  it('⭐ 找不到可用 Node ⇒ 原因要带**实际版本与要求区间**（不能只说"没有可用的 Node"）', async () => {
    const { deps } = makeDeps({
      resolveNode: vi.fn(async () => ({
        ok: false as const,
        attempts: [],
        message: '找不到可用的 Node。\n要求版本：>=24.16.0 <25, or >=26.1.0\n  - env  …→ 20.19.1（版本不受支持）',
      })),
    });
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');

    const res = await bootstrapLocalGatewayRuntime({ userDataDir: USER_DATA, deps });

    expect(res.ok).toBe(false);
    expect(res.reason).toContain('20.19.1');
    expect(res.reason).toContain('>=24.16.0');
  });

  it('挂掉的那次也要留下可排查的日志（事件名带 runtime. 前缀）', async () => {
    const log = vi.fn();
    const { deps } = makeDeps({
      deployFromMedia: vi.fn(async () => {
        throw new Error('boom');
      }),
      log,
    });
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');

    await bootstrapLocalGatewayRuntime({ userDataDir: USER_DATA, deps });

    const events = log.mock.calls.map((c) => String(c[0]));
    expect(events.some((e) => e.startsWith('runtime.'))).toBe(true);
    expect(events).toContain('runtime.bootstrap.failed');
  });

  it('reused 也照样 ok（复用了本来就在跑的网关，不是错误）', async () => {
    const { deps } = makeDeps({
      startGateway: vi.fn(async () => ({
        ownership: 'reused' as const,
        decision: { verdict: 'reuse' as const, reason: 'y' },
      })),
    });
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');

    const res = await bootstrapLocalGatewayRuntime({ userDataDir: USER_DATA, deps });

    expect(res.ok).toBe(true);
    expect(res.ownership).toBe('reused');
  });
});
