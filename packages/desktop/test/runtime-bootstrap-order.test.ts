import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayPortOccupiedError, GatewayReadyTimeoutError } from '../src/main/runtime/gateway-process.js';
import { bootstrapWithRetry } from '../src/main/runtime/bootstrap-retry.js';
import type { DeployProgress } from '../src/main/runtime/deploy.js';
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
const PORTABLE_USER_DATA = 'E:\\Partner-W-运行数据';
const LOCAL_USER_DATA = 'C:\\Users\\u\\AppData\\Roaming\\@clawwork\\desktop';
const LOCAL_RUNTIME_CACHE = `${LOCAL_USER_DATA}\\portable-runtime-cache\\${'a'.repeat(64)}`;

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
    selfCheckLinks: vi.fn(() => {
      calls.push('selfCheckLinks');
      return { checked: 0, broken: 0, repaired: 0, failures: [], stillBroken: [], notes: [], summary: '干净' };
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
  it('records node resolution and gateway startup durations without credentials', async () => {
    let clock = 1000;
    const { deps } = makeDeps({ now: () => clock });
    const resolveNode = deps.resolveNode;
    deps.resolveNode = async (options) => {
      const result = await resolveNode(options);
      clock += 64;
      return result;
    };
    const startGateway = deps.startGateway;
    deps.startGateway = async (options) => {
      const result = await startGateway(options);
      clock += 110000;
      return result;
    };
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');
    await bootstrapLocalGatewayRuntime({ userDataDir: USER_DATA, deps });
    // ⚠️ BUG-064 后这个事件的载荷多了结构化诊断（contractMs/attempts/probeRecords，
    //    测试桩的 resolveNode 返回里没有 ⇒ undefined）；耗时与 ok 照旧钉死。
    expect(deps.log).toHaveBeenCalledWith(
      'runtime.node.resolve.done',
      expect.objectContaining({ durationMs: 64, ok: true }),
    );
    expect(deps.log).toHaveBeenCalledWith('runtime.gateway.start', {});
    expect(deps.log).toHaveBeenCalledWith('runtime.gateway.ready', { durationMs: 110000, ownership: 'spawned' });
    expect(JSON.stringify(vi.mocked(deps.log).mock.calls)).not.toContain('tok-1');
  });

  it('does not deploy or start a gateway when portable state migration is blocked', async () => {
    const error = Object.assign(new Error('state is busy'), { code: 'runtime.portable-state-migration-blocked' });
    const { deps } = makeDeps({
      alignClientConfig: vi.fn(async () => {
        throw error;
      }),
    });
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');
    expect(await bootstrapLocalGatewayRuntime({ userDataDir: PORTABLE_USER_DATA, deps })).toMatchObject({
      ok: false,
      code: 'runtime.portable-state-migration-blocked',
    });
    expect(deps.deployFromMedia).not.toHaveBeenCalled();
    expect(deps.startGateway).not.toHaveBeenCalled();
    expect(deps.setStateDirEnv).not.toHaveBeenCalled();
  });

  it('keeps state on portable userData when only the disposable runtime cache is local', async () => {
    const { deps } = makeDeps();
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');
    await bootstrapLocalGatewayRuntime({
      userDataDir: PORTABLE_USER_DATA,
      runtimeCacheUserDataDir: LOCAL_RUNTIME_CACHE,
      portableWorkspacePath: 'E:\\workspace',
      deps,
    });

    expect(deps.alignClientConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        stateUserDataDir: PORTABLE_USER_DATA,
      }),
    );
  });

  beforeEach(() => {
    vi.resetModules();
  });

  it('⭐ 顺序：对齐配置 → 认缓存 → 部署 → 坏链自检 → 解析 Node → 起网关', async () => {
    const { deps, calls } = makeDeps();
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');

    const res = await bootstrapLocalGatewayRuntime({ userDataDir: USER_DATA, deps });

    expect(calls).toEqual([
      'alignClientConfig',
      'setStateDirEnv:C:\\fake\\userdata\\openclaw-state',
      'readCached',
      'deployFromMedia',
      // 自检紧跟部署：`deployedRoot` 刚到手的那个，先把 state 里的链接对齐它，再谈起网关
      'selfCheckLinks',
      'resolveNode',
      'startGateway',
    ]);
    expect(res.ok).toBe(true);
    expect(res.ownership).toBe('spawned');
  });

  it('⭐ 盘上形态：登录状态留在 U 盘，运行时与 OpenClaw 内部 state 只读写本机缓存', async () => {
    const localStateDir = `${LOCAL_USER_DATA}\\state\\0123456789abcdef01234567`;
    const { deps } = makeDeps({
      alignClientConfig: vi.fn(async () => ({ token: 'tok-1', stateDir: localStateDir })),
      // 故意放一份结构完整但来源不明的旧缓存：便携版必须拿随包 manifest
      // 重新算目标 key，不能因它“看起来能跑”就直接跳过出厂运行时。
      readCached: vi.fn(() => ({
        status: 'ok' as const,
        deploymentKey: 'stale-installed-runtime',
        deployedRoot: 'C:\\installed-cache\\stale-installed-runtime',
        nodePath: 'C:\\installed-cache\\stale-installed-runtime\\node\\node.exe',
        cliPath: 'C:\\installed-cache\\stale-installed-runtime\\node_modules\\openclaw\\openclaw.mjs',
      })),
    });
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');

    await bootstrapLocalGatewayRuntime({
      userDataDir: PORTABLE_USER_DATA,
      runtimeCacheUserDataDir: LOCAL_RUNTIME_CACHE,
      stateCacheUserDataDir: LOCAL_USER_DATA,
      deps,
    });

    expect(deps.alignClientConfig).toHaveBeenCalledWith({
      userDataDir: PORTABLE_USER_DATA,
      stateUserDataDir: LOCAL_USER_DATA,
    });
    expect(deps.readCached).not.toHaveBeenCalled();
    expect(deps.deployFromMedia).toHaveBeenCalledWith({ userDataDir: LOCAL_RUNTIME_CACHE });
    expect(deps.resolveNode).toHaveBeenCalledWith({
      userDataDir: LOCAL_RUNTIME_CACHE,
      deploymentKey: 'k1',
      deployedRoot: 'C:\\fake\\userdata\\runtime\\deployed\\k1',
    });
    expect(deps.selfCheckLinks).toHaveBeenCalledWith({
      stateDir: localStateDir,
      deployedRoot: 'C:\\fake\\userdata\\runtime\\deployed\\k1',
    });
    expect(deps.startGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        stateDir: localStateDir,
        // 设备身份属于登录/授权身份，仍随 U 盘；不能因 state 拆到本机而悄悄换一份。
        identityPath: `${PORTABLE_USER_DATA}\\device-identity.json`,
        deployedRoot: 'C:\\fake\\userdata\\runtime\\deployed\\k1',
      }),
    );
  });

  it('⭐ 自检要拿到**这一轮真正在用的**那个 deployedRoot（不是猜的、也不是上一次的）', async () => {
    const { deps } = makeDeps();
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');

    await bootstrapLocalGatewayRuntime({ userDataDir: USER_DATA, deps });

    expect(deps.selfCheckLinks).toHaveBeenCalledWith({
      stateDir: 'C:\\fake\\userdata\\openclaw-state',
      deployedRoot: 'C:\\fake\\userdata\\runtime\\deployed\\k1',
    });
  });

  it('⭐ 自检**炸了也不能拦住启动**（软失败：它只是额外的一层保险，不是必经之路）', async () => {
    const log = vi.fn();
    const { deps, calls } = makeDeps({
      selfCheckLinks: vi.fn(() => {
        calls.push('selfCheckLinks');
        throw new Error('EPERM: 这个卷建不了链接');
      }),
      log,
    });
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');

    const res = await bootstrapLocalGatewayRuntime({ userDataDir: USER_DATA, deps });

    expect(res.ok).toBe(true); // ← 照常起网关
    expect(calls).toContain('startGateway');
    expect(log.mock.calls.map((c) => String(c[0]))).toContain('runtime.links.failed');
  });

  it('自检的结论要能一路带出去（界面/日志靠它说"修了几条"）', async () => {
    const { deps } = makeDeps({
      selfCheckLinks: vi.fn(() => ({
        checked: 4,
        broken: 2,
        repaired: 1,
        failures: [{ path: 'C:\\x\\b', target: null, reason: '读不出目标串' }],
        stillBroken: [{ path: 'C:\\x\\c', kind: 'real-dir' as const, target: null }],
        notes: [],
        summary: '坏链自检：探了 4 条，坏的 2 条，修好 1 条，修不了 1 条',
      })),
    });
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');

    const res = await bootstrapLocalGatewayRuntime({ userDataDir: USER_DATA, deps });

    expect(res.links?.checked).toBe(4);
    expect(res.links?.broken).toBe(2);
    expect(res.links?.repaired).toBe(1);
    expect(res.links?.failed).toBe(1);
    expect(res.links?.summary).toContain('修好 1 条');
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

  it('⭐ 部署失败带 `runtime.deploy-failed`（界面的出口在**盘**上，不是笼统的 unknown）', async () => {
    const { deps } = makeDeps({
      deployFromMedia: vi.fn(async () => {
        throw new Error('运行时盘上找不到归档：Z:\\runtime\\openclaw.7z');
      }),
    });
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');

    const res = await bootstrapLocalGatewayRuntime({ userDataDir: USER_DATA, deps });

    expect(res.ok).toBe(false);
    expect(res.code).toBe('runtime.deploy-failed');
    // 原文（带路径）照旧只进日志，不进公开 code —— 那条纪律由 toPublicBootstrapStatus 守
    expect(res.reason).toContain('Z:\\runtime\\openclaw.7z');
  });

  it('⚠️ 已经带码的失败不被改判成 deploy-failed（端口占用等类别各有各的出口）', async () => {
    const coded = Object.assign(new Error('18789 被占用'), { code: 'runtime.gateway-port-occupied' });
    const { deps } = makeDeps({
      deployFromMedia: vi.fn(async () => {
        throw coded;
      }),
    });
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');

    const res = await bootstrapLocalGatewayRuntime({ userDataDir: USER_DATA, deps });

    expect(res.code).toBe('runtime.gateway-port-occupied');
  });

  it('⭐ 部署进度透传到调用方（这条信号以前在编排层被丢掉：首跑 1–20 分钟界面看不到东西）', async () => {
    const seen: string[] = [];
    const { deps } = makeDeps({
      deployFromMedia: vi.fn(async (opts: { userDataDir: string; onProgress?: (p: DeployProgress) => void }) => {
        opts.onProgress?.({ phase: 'verify', done: 0, total: 2 });
        opts.onProgress?.({ phase: 'extract', done: 5, total: 10 });
        return {
          status: 'deployed' as const,
          deploymentKey: 'k1',
          deployedRoot: 'C:\\fake\\userdata\\runtime\\deployed\\k1',
          nodePath: 'C:\\fake\\userdata\\runtime\\deployed\\k1\\node\\node.exe',
          cliPath: 'C:\\fake\\userdata\\runtime\\deployed\\k1\\node_modules\\openclaw\\openclaw.mjs',
        };
      }),
    });
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');

    await bootstrapLocalGatewayRuntime({
      userDataDir: USER_DATA,
      onDeployProgress: (p) => seen.push(`${p.phase}:${p.done}/${p.total}`),
      deps,
    });

    expect(seen).toEqual(['verify:0/2', 'extract:5/10']);
  });

  it('没人听进度时**不带** onProgress 这个键（调用形状保持干净，别被一个恒为 undefined 的键污染）', async () => {
    const { deps } = makeDeps();
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');

    await bootstrapLocalGatewayRuntime({ userDataDir: USER_DATA, deps });

    expect(deps.deployFromMedia).toHaveBeenCalledWith({ userDataDir: USER_DATA });
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
        // BUG-064 归因分档：本 fixture 明确表达"版本不受支持"（终审 K4-1）。
        failureClass: 'version-unsupported' as const,
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

  it('⭐ 所有权是**单调**的：起过一次之后，后一次 reused 不能把 ownership 覆盖掉', async () => {
    // 实测形状（E2E 启动 3）：同一进程里 bootstrap 第二次判成 reused，它的 child
    // 是空的。覆盖掉就丢了"这是我们起的"这条 ⇒ 退出时谁都不去停 ⇒ 下一个场景
    // 直接 EADDRINUSE。
    //
    // ⚠️ pid 刻意留空：真 `stopGateway` 会 `taskkill /PID`，单测里绝不能真跑。
    const child = { pid: undefined, onExit: vi.fn(), kill: vi.fn() };
    const { deps: first } = makeDeps({
      startGateway: vi.fn(async () => ({
        ownership: 'spawned' as const,
        pid: 4321,
        child,
        decision: { verdict: 'spawn' as const, reason: 'x' },
      })),
    });
    const { bootstrapLocalGatewayRuntime, shutdownLocalGatewayRuntime } = await import('../src/main/runtime/index.js');

    await bootstrapLocalGatewayRuntime({ userDataDir: USER_DATA, deps: first });

    const { deps: second } = makeDeps({
      startGateway: vi.fn(async () => ({
        ownership: 'reused' as const,
        decision: { verdict: 'reuse' as const, reason: 'y' },
      })),
    });
    const res2 = await bootstrapLocalGatewayRuntime({ userDataDir: USER_DATA, deps: second });
    expect(res2.ownership).toBe('reused');

    // 退出收尾**仍然**要停它 —— 这一条就是回归断言
    const stopped = await shutdownLocalGatewayRuntime();
    expect(stopped).toBe(true);
    expect(child.kill).toHaveBeenCalled();
  });

  /**
   * BUG-040 ③④ 的接线（编排层的两条）：
   *  - 失败结果要带**部署标记** —— 上层靠它决定"ready 超时要不要自动再跑一轮"
   *    （`bootstrap-retry.ts` 的 `isReadyTimeoutWorthRetry`：`deployed` 或 `skipped`）；
   *  - 失败时要查**崩溃循环熔断**，熔断中换码（不可重试）+ reason 带指引。
   */
  it('⭐ 失败结果带部署标记（deployStatus=deployed ⇒ 首启可自动重试一次）', async () => {
    const { deps } = makeDeps({
      startGateway: vi.fn(async () => {
        throw Object.assign(new Error('网关进程在就绪之前就退出了'), { code: 'runtime.gateway-process-exited' });
      }),
    });
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');

    const res = await bootstrapLocalGatewayRuntime({ userDataDir: USER_DATA, deps });

    expect(res).toMatchObject({ ok: false, code: 'runtime.gateway-process-exited', deployStatus: 'deployed' });
  });

  it('⭐ 熔断中 ⇒ 换码（不可重试）+ reason 带"等几分钟"指引 + 日志明示', async () => {
    const log = vi.fn();
    const inspectBreaker = vi.fn(() => ({
      available: true,
      tripped: true,
      uncleanBoots: 3,
      retryAfterMs: 300_000,
    }));
    const { deps } = makeDeps({
      startGateway: vi.fn(async () => {
        throw Object.assign(new Error('网关进程在就绪之前就退出了'), { code: 'runtime.gateway-process-exited' });
      }),
      inspectBreaker,
      log,
    });
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');

    const res = await bootstrapLocalGatewayRuntime({ userDataDir: USER_DATA, deps });

    expect(inspectBreaker).toHaveBeenCalledWith('C:\\fake\\userdata\\openclaw-state');
    expect(res.code).toBe('runtime.gateway-crash-loop-breaker');
    expect(res.reason).toMatch(/crash_loop_breaker/u);
    expect(res.reason).toMatch(/退出应用/u);
    expect(log.mock.calls.map((entry) => String(entry[0]))).toContain('runtime.gateway-crash-loop-breaker');
  });

  it('⭐ 熔断中**不去撞墙**：预检经 `beforeSpawn` 只在真 spawn 分支上闸（每次尝试都会延长那 5 分钟窗口）', async () => {
    const log = vi.fn();
    const inspectBreaker = vi.fn(() => ({
      available: true,
      tripped: true,
      uncleanBoots: 3,
      retryAfterMs: 240_000,
    }));
    // 模拟真实 `ensureGatewayRunning`：spawn 分支先拉闸，判 reuse/foreign 时不拉。
    const { deps } = makeDeps({
      inspectBreaker,
      log,
      startGateway: vi.fn(async (opts: { beforeSpawn?: () => void | Promise<void> }) => {
        await opts.beforeSpawn?.();
        return { ownership: 'spawned' as const, pid: 123, decision: { verdict: 'spawn' as const, reason: 'x' } };
      }),
    });
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');

    const res = await bootstrapLocalGatewayRuntime({ userDataDir: USER_DATA, deps });

    expect(res.code).toBe('runtime.gateway-crash-loop-breaker');
    expect(res.reason).toMatch(/退出应用/u);
    // 预检**不再**拦在 startGateway 之前（BUG-059 附 F4：那样连复用也被否决）——
    // 它随 startGateway 的入参下传，由 spawn 分支决定何时拉闸。
    expect(deps.startGateway).toHaveBeenCalledWith(expect.objectContaining({ beforeSpawn: expect.any(Function) }));
    expect(inspectBreaker).toHaveBeenCalledWith('C:\\fake\\userdata\\openclaw-state');
    expect(log.mock.calls.map((entry) => String(entry[0]))).toContain('runtime.gateway-crash-loop-breaker');
  });

  it('⭐ 熔断中但端口上是我们健康的网关（reused）⇒ 照常复用，不被白等窗口（BUG-059 附 F4）', async () => {
    const inspectBreaker = vi.fn(() => ({
      available: true,
      tripped: true,
      uncleanBoots: 3,
      retryAfterMs: 240_000,
    }));
    const { deps } = makeDeps({
      inspectBreaker,
      startGateway: vi.fn(async () => ({
        ownership: 'reused' as const,
        decision: { verdict: 'reuse' as const, reason: 'started + 认证通过' },
      })),
    });
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');

    const res = await bootstrapLocalGatewayRuntime({ userDataDir: USER_DATA, deps });

    expect(res).toMatchObject({ ok: true, ownership: 'reused' });
  });

  it('⭐ 对齐配置就失败（拿不到 stateDir）⇒ 不去碰熔断表（诊断不该在无路径时猜）', async () => {
    const inspectBreaker = vi.fn();
    const { deps } = makeDeps({
      alignClientConfig: vi.fn(async () => {
        throw Object.assign(new Error('state is busy'), { code: 'runtime.portable-state-migration-blocked' });
      }),
      inspectBreaker,
    });
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');

    const res = await bootstrapLocalGatewayRuntime({ userDataDir: USER_DATA, deps });

    expect(res.code).toBe('runtime.portable-state-migration-blocked');
    expect(inspectBreaker).not.toHaveBeenCalled();
  });
});

/**
 * 2026-10-15 P-B 便携首启硬合同 —— **真实编排入口**的组合测试。
 *
 * 用户事故类（可复现的确定缺口，不是从事故日志倒推的猜测）：带预部署缓存的盘换新机，
 * 便携态运行时缓存随盘走（`cache-scope.ts`）⇒ 部署快路径报 `skipped`；新机冷读
 * （冷读 + 杀软首扫）把网关就绪顶出 180 秒窗口 ⇒ 旧策略一次即终态、界面落到人工
 * 「重新准备」。这里用 `bootstrapWithRetry`（= `main/index.ts` 包着
 * `bootstrapLocalGatewayRuntime` 的那一层；启动路径与「重新准备」共用同一段）组合出
 * 真实入口，钉住修复后的行为与重入安全性。
 *
 * 重入安全依据（编码进断言）：
 *  - 复跑的是**整轮编排**，每一步都是幂等的：对齐配置（ensure 语义）、部署快路径
 *    （stamp/内容键命中 ⇒ 再报 skipped，不重新解压）、坏链自检（只修悬空）、
 *    Node 探测（无副作用）、网关三态判定（已就绪 ⇒ reused；没起来 ⇒ 有界等待/spawn，
 *    绝不 force/kill 别人的进程）。
 *  - 预算就是既有那套：只多一轮、延迟 3s、**顺序 await（不重叠）**，最坏墙钟 ≈363s。
 */
describe('P-B：缓存命中（skipped）+ ready 超时 ⇒ 编排层自动再跑一轮（真实入口）', () => {
  function skippedDeploy() {
    return {
      status: 'skipped' as const,
      deploymentKey: 'k1',
      deployedRoot: 'C:\\fake\\userdata\\runtime\\deployed\\k1',
      nodePath: 'C:\\fake\\userdata\\runtime\\deployed\\k1\\node\\node.exe',
      cliPath: 'C:\\fake\\userdata\\runtime\\deployed\\k1\\node_modules\\openclaw\\openclaw.mjs',
    };
  }

  beforeEach(() => {
    vi.resetModules();
  });

  it('⭐ 预部署缓存命中 + 首次等就绪超时 ⇒ 同一入口内自动恢复，无需人工重试', async () => {
    const sleeps: number[] = [];
    const retryEvents: Array<{ attempt: number; delayMs: number }> = [];
    let gatewayAttempts = 0;
    const { deps, calls } = makeDeps({
      deployFromMedia: vi.fn(async () => {
        calls.push('deployFromMedia');
        return skippedDeploy();
      }),
      startGateway: vi.fn(async () => {
        calls.push('startGateway');
        gatewayAttempts += 1;
        if (gatewayAttempts === 1) {
          throw new GatewayReadyTimeoutError('等待网关就绪超时（180s）');
        }
        return { ownership: 'spawned' as const, pid: 4321, decision: { verdict: 'spawn' as const, reason: 'x' } };
      }),
    });
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');

    const result = await bootstrapWithRetry({
      attempt: () =>
        bootstrapLocalGatewayRuntime({
          userDataDir: PORTABLE_USER_DATA,
          runtimeCacheUserDataDir: LOCAL_RUNTIME_CACHE,
          deps,
        }),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onRetry: (info) => retryEvents.push({ attempt: info.attempt, delayMs: info.delayMs }),
    });

    expect(result).toMatchObject({ ok: true, deployStatus: 'skipped', ownership: 'spawned' });
    expect(gatewayAttempts).toBe(2);
    expect(sleeps).toEqual([3_000]);
    expect(retryEvents).toEqual([{ attempt: 2, delayMs: 3_000 }]);
    // 幂等重入：复跑的是**整轮编排**（不是只重起网关），且第二轮与第一轮**步骤与顺序完全相同**
    // —— 部署一直走缓存快路径（skipped），没有重新解压任何东西。
    const round = [
      'alignClientConfig',
      `setStateDirEnv:${USER_DATA}\\openclaw-state`,
      'deployFromMedia',
      'selfCheckLinks',
      'resolveNode',
      'startGateway',
    ];
    expect(calls).toEqual([...round, ...round]);
    expect(deps.deployFromMedia).toHaveBeenCalledWith({ userDataDir: LOCAL_RUNTIME_CACHE });
  });

  it('⭐ 第二轮发现网关已就绪 ⇒ 以 reused 收敛（三态判定原样保留，不重复 spawn）', async () => {
    const sleeps: number[] = [];
    let gatewayAttempts = 0;
    const { deps } = makeDeps({
      deployFromMedia: vi.fn(async () => skippedDeploy()),
      startGateway: vi.fn(async () => {
        gatewayAttempts += 1;
        if (gatewayAttempts === 1) {
          throw new GatewayReadyTimeoutError('等待网关就绪超时（180s）');
        }
        // 真实三态判定在"上一轮的网关已经起来了"时给的就是这个。
        return { ownership: 'reused' as const, decision: { verdict: 'reuse' as const, reason: '认证通过' } };
      }),
    });
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');

    const result = await bootstrapWithRetry({
      attempt: () =>
        bootstrapLocalGatewayRuntime({
          userDataDir: PORTABLE_USER_DATA,
          runtimeCacheUserDataDir: LOCAL_RUNTIME_CACHE,
          deps,
        }),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(result).toMatchObject({ ok: true, ownership: 'reused' });
    expect(gatewayAttempts).toBe(2);
    expect(sleeps).toEqual([3_000]);
  });

  it('⭐ 控制项：Node 版本类失败（终态）不因"缓存命中"被重试（编排入口）', async () => {
    const sleeps: number[] = [];
    const { deps } = makeDeps({
      deployFromMedia: vi.fn(async () => skippedDeploy()),
      resolveNode: vi.fn(async () => ({
        ok: false as const,
        attempts: [],
        failureClass: 'version-unsupported' as const,
        message: '环境里的 node 版本不受支持（20.19.1 / 要求 >=24.16.0）',
      })),
    });
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');

    const result = await bootstrapWithRetry({
      attempt: () =>
        bootstrapLocalGatewayRuntime({
          userDataDir: PORTABLE_USER_DATA,
          runtimeCacheUserDataDir: LOCAL_RUNTIME_CACHE,
          deps,
        }),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(result).toMatchObject({ ok: false, code: 'runtime.node-version-unsupported' });
    expect(deps.resolveNode).toHaveBeenCalledTimes(1);
    expect(deps.startGateway).not.toHaveBeenCalled();
    expect(sleeps).toEqual([]);
  });
});
