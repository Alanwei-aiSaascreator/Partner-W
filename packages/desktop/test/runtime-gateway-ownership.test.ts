import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { delimiter, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  GATEWAY_PORT_OCCUPIED,
  buildGatewayEnvironment,
  buildGatewayArgs,
  classifyExistingGateway,
  ensureGatewayRunning,
} from '../src/main/runtime/gateway-process.js';
import type { GatewayChildProcess, StartupzProbe } from '../src/main/runtime/gateway-process.js';
import { setPortableRoots } from '../src/main/runtime/portable-root.js';

/**
 * 三态判定与 ownership —— **硬缺口 ③**（用户复审提出）。
 *
 * `/startupz` 通了只证明「端口上有个网关」，**不证明「这是我们的网关」**。
 * 把一个别人的 OpenClaw 当成自己的，后果不是"起不来"，而是：
 * 我们 `--force` 过去、把它 kill 掉、或者把我们的 token 写进它的配置。
 *
 * 所以这一组测试反复施加同一个压力：**只要认证没过，就一个动作都不许做**。
 */

const PORT = 18789;

function makeChild(pid = 4242): GatewayChildProcess & { killed: boolean; exitListeners: Array<() => void> } {
  const listeners: Array<() => void> = [];
  const child = {
    pid,
    killed: false,
    exitListeners: listeners,
    onExit: (cb: () => void) => listeners.push(cb),
    kill: () => {
      child.killed = true;
    },
  };
  return child;
}

const READY: StartupzProbe = { reachable: true, status: 'started' };
const DOWN: StartupzProbe = { reachable: false };

/** 认证多探的"立刻探完"预算（单测不真等秒级）。 */
const fastProbe = () => ({ attempts: 3, intervalMs: 0, sleep: async () => {} });
/** 占用者退场等待的"不等"预算（单测不真等 15 秒）。 */
const noWait = () => ({ timeoutMs: 0, intervalMs: 0, sleep: async () => {}, now: () => 0 });
/** 假时钟：`now` 跟着 `sleep` 走（与 waitForGatewayReady 的测法同款）。 */
function waitClock() {
  let nowMs = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => nowMs,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      nowMs += ms;
    },
  };
}

function baseOpts(over: Record<string, unknown> = {}) {
  const child = makeChild();
  const spawn = vi.fn((_opts: { nodeExe: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }) => child);
  const opts = {
    nodeExe: 'C:\\cache\\deployed\\k1\\node\\node.exe',
    cliPath: 'C:\\cache\\deployed\\k1\\node_modules\\openclaw\\openclaw.mjs',
    deployedRoot: 'C:\\cache\\deployed\\k1',
    stateDir: 'C:\\profile\\openclaw-state',
    token: 'tok-abc',
    port: PORT,
    probe: vi.fn(async () => DOWN),
    authenticate: vi.fn(async () => true),
    spawn,
    waitReady: vi.fn(async () => {}),
    ...over,
  };
  return { opts, child, spawn };
}

describe('classifyExistingGateway', () => {
  it('A. /startupz 不通 ⇒ spawn', () => {
    expect(classifyExistingGateway({ reachable: false, authenticated: false }).verdict).toBe('spawn');
  });

  it('B. started + 认证通过 ⇒ reuse（我们的网关还活着）', () => {
    expect(classifyExistingGateway({ reachable: true, status: 'started', authenticated: true }).verdict).toBe('reuse');
  });

  it('⭐ C. started + 认证失败 ⇒ foreign', () => {
    const d = classifyExistingGateway({ reachable: true, status: 'started', authenticated: false });
    expect(d.verdict).toBe('foreign');
  });

  it('⭐ 端口活着但**不是 started**（别人的服务 / 网关没起完）⇒ foreign，不当成"我们的"', () => {
    expect(classifyExistingGateway({ reachable: true, status: undefined, authenticated: true }).verdict).toBe(
      'foreign',
    );
    expect(classifyExistingGateway({ reachable: true, status: 'starting', authenticated: true }).verdict).toBe(
      'foreign',
    );
  });
});

/**
 * BUG-041 ②：网关子进程的 TEMP/TMP 要**跟着盘走**。
 *
 * 缺口（审计发现的）：应用数据、state、缓存都上了盘，唯独 `TEMP`/`TMP` 还是宿主机的
 * `%TEMP%` —— 网关/工具写下的临时文件留在别人电脑上（隐私与残留都说不通）。
 */
describe('BUG-041 ②：盘上运行的 TEMP/TMP 重定向', () => {
  const hostEnv = { TEMP: 'C:\\host-temp', TMP: 'C:\\host-tmp', PATH: 'C:\\Windows' };
  let fixture = '';

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'gateway-env-test-'));
  });

  afterEach(() => {
    setPortableRoots(null);
    vi.restoreAllMocks();
    rmSync(fixture, { recursive: true, force: true });
  });

  const portableRoots = (tempRoot: string) => ({
    volumeRoot: 'E:\\',
    programDir: 'E:\\荣盈魔方',
    dataRoot: 'E:\\荣盈魔方-运行数据',
    stateRoot: 'E:\\荣盈魔方-运行数据\\state',
    workspaceRoot: 'E:\\荣盈魔方工作区',
    cacheRoot: 'E:\\荣盈魔方-运行数据\\portable-runtime-cache',
    logsRoot: 'E:\\荣盈魔方-运行数据\\logs',
    tempRoot,
  });

  it('⭐ 盘上运行 ⇒ TEMP/TMP 指到 <dataRoot>/tmp，并把目录建好', () => {
    const tempRoot = join(fixture, 'tmp');
    setPortableRoots(portableRoots(tempRoot));

    const env = buildGatewayEnvironment(hostEnv, 'E:\\荣盈魔方-运行数据\\state\\x');

    expect(env.TEMP).toBe(tempRoot);
    expect(env.TMP).toBe(tempRoot);
    expect(existsSync(tempRoot)).toBe(true);
  });

  it('⭐ 非盘上形态 ⇒ 一字不动（安装形态的宿主 TEMP 不许被碰）', () => {
    setPortableRoots(null);
    const env = buildGatewayEnvironment(hostEnv, 'C:\\profile\\state');
    expect(env.TEMP).toBe('C:\\host-temp');
    expect(env.TMP).toBe('C:\\host-tmp');
  });

  it('⭐ 盘上临时目录建不出来 ⇒ 回落宿主 + 警告（绝不因临时目录把网关拦死）', () => {
    const blocker = join(fixture, 'blocker');
    writeFileSync(blocker, 'x');
    setPortableRoots(portableRoots(join(blocker, 'tmp')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const env = buildGatewayEnvironment(hostEnv, 'E:\\state');

    expect(env.TEMP).toBe('C:\\host-temp');
    expect(env.TMP).toBe('C:\\host-tmp');
    expect(warn).toHaveBeenCalled();
  });
});

describe('buildGatewayArgs', () => {
  it('形状与方案一致：cli gateway run --force --allow-unconfigured --port <n>', () => {
    expect(buildGatewayArgs({ cliPath: 'C:\\p\\openclaw.mjs', port: PORT })).toEqual([
      'C:\\p\\openclaw.mjs',
      'gateway',
      'run',
      '--force',
      '--allow-unconfigured',
      '--port',
      String(PORT),
    ]);
  });
});

describe('ensureGatewayRunning', () => {
  it('executes Node tool subprocesses with an otherwise empty PATH', () => {
    const env = buildGatewayEnvironment(
      { SystemRoot: process.env.SystemRoot, PATH: '' },
      'isolated-state',
      process.execPath,
    );
    const output = execFileSync(
      process.execPath,
      [
        '-e',
        `process.stdout.write(require('node:child_process').execFileSync('node', ['-e', 'process.stdout.write("ready")'], {windowsHide:true}))`,
      ],
      { env, windowsHide: true, encoding: 'utf8' },
    );
    expect(output).toBe('ready');
  });
  it('exposes the bundled Node directory to registered exec tools without a system Node install', async () => {
    const { opts, spawn } = baseOpts();
    await ensureGatewayRunning(opts);
    const env = spawn.mock.calls[0][0].env;
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH')!;
    expect(env[pathKey]?.split(delimiter)[0]).toBe(dirname(opts.nodeExe));
  });
  it('⭐ 网关子进程不继承宿主模型密钥，但保留运行必需的普通环境变量', () => {
    const env = buildGatewayEnvironment(
      {
        PATH: 'C:\\Windows\\System32',
        SystemRoot: 'C:\\Windows',
        TEMP: 'C:\\Temp',
        HTTP_PROXY: 'http://127.0.0.1:7890',
        NODE_EXTRA_CA_CERTS: 'C:\\corp\\ca.pem',
        DEEPSEEK_API_KEY: 'deep-secret',
        QWEN_API_KEY: 'qwen-secret',
        DASHSCOPE_API_KEY: 'dash-secret',
        SEARXNG_BASE_URL: 'http://127.0.0.1:8080',
        SLACK_WEBHOOK_URL: 'https://hooks.slack.invalid/test',
        MATTERMOST_URL: 'https://mattermost.invalid',
        TWILIO_PHONE_NUMBER: '+10000000000',
        OPENAI_API_KEY: 'openai-secret',
        GITHUB_TOKEN: 'github-secret',
        CLAWROUTER_API_KEY: 'product-relay-secret',
        OPENCLAW_GATEWAY_TOKEN: 'foreign-gateway-secret',
        NODE_OPTIONS: '--require C:\\foreign\\inject.js',
      },
      'C:\\profile\\openclaw-state',
    );

    expect(env.PATH).toBe('C:\\Windows\\System32');
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.TEMP).toBe('C:\\Temp');
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7890');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('C:\\corp\\ca.pem');
    expect(env.OPENCLAW_STATE_DIR).toBe('C:\\profile\\openclaw-state');
    expect(env.OPENCLAW_SUPERVISOR_MODE).toBe('external');
    expect(env).not.toHaveProperty('DEEPSEEK_API_KEY');
    expect(env).not.toHaveProperty('QWEN_API_KEY');
    expect(env).not.toHaveProperty('DASHSCOPE_API_KEY');
    expect(env).not.toHaveProperty('SEARXNG_BASE_URL');
    expect(env).not.toHaveProperty('SLACK_WEBHOOK_URL');
    expect(env).not.toHaveProperty('MATTERMOST_URL');
    expect(env).not.toHaveProperty('TWILIO_PHONE_NUMBER');
    expect(env).not.toHaveProperty('OPENCLAW_GATEWAY_TOKEN');
    expect(env).not.toHaveProperty('NODE_OPTIONS');
    // 非外置自动安装入口继续透传，避免破坏用户自己的工具/集成与随包 clawrouter。
    expect(env.OPENAI_API_KEY).toBe('openai-secret');
    expect(env.GITHUB_TOKEN).toBe('github-secret');
    expect(env.CLAWROUTER_API_KEY).toBe('product-relay-secret');
  });

  it('A. 端口上没有网关 ⇒ spawn 一次，ownership=spawned', async () => {
    const { opts, spawn } = baseOpts();
    const res = await ensureGatewayRunning(opts);

    expect(res.ownership).toBe('spawned');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(res.pid).toBe(4242);
  });

  it('⭐ spawn 用**本机部署目录**当 cwd，不是 U 盘（拔盘后运行期动态 import 靠它）', async () => {
    const { opts, spawn } = baseOpts();
    await ensureGatewayRunning(opts);
    expect(spawn.mock.calls[0][0].cwd).toBe('C:\\cache\\deployed\\k1');
  });

  it('⭐ spawn 的 env 带 state 目录与 external supervisor（幂等启动、禁用自更新）', async () => {
    const { opts, spawn } = baseOpts();
    await ensureGatewayRunning(opts);
    const env = spawn.mock.calls[0][0].env;
    expect(env.OPENCLAW_STATE_DIR).toBe('C:\\profile\\openclaw-state');
    expect(env.OPENCLAW_SUPERVISOR_MODE).toBe('external');
  });

  it('B. started + 认证通过 ⇒ **不 spawn**，ownership=reused（复用不抢占）', async () => {
    const { opts, spawn } = baseOpts({ probe: vi.fn(async () => READY) });
    const res = await ensureGatewayRunning(opts);

    expect(res.ownership).toBe('reused');
    expect(spawn).not.toHaveBeenCalled();
    expect(res.pid).toBeUndefined();
  });

  it('⭐ C. started + 认证失败 ⇒ **绝不 spawn / 不 force / 不 kill**，抛 port-occupied', async () => {
    const { opts, spawn, child } = baseOpts({
      probe: vi.fn(async () => READY),
      authenticate: vi.fn(async () => false),
    });

    await expect(ensureGatewayRunning(opts)).rejects.toMatchObject({ code: GATEWAY_PORT_OCCUPIED });

    // 三个"绝不"逐个断言 —— 少一个都可能悄悄改坏别人的网关
    expect(spawn).not.toHaveBeenCalled();
    expect(child.killed).toBe(false);
  });

  it('⭐ 认证失败的错误信息要**说清是端口被占**，而不是"启动失败"', async () => {
    const { opts } = baseOpts({ probe: vi.fn(async () => READY), authenticate: vi.fn(async () => false) });
    await expect(ensureGatewayRunning(opts)).rejects.toThrow(new RegExp(String(PORT)));
  });

  it('⭐ 只有 /startupz=started 时才去认证（不通就别浪费一次认证，更别误判 foreign）', async () => {
    const authenticate = vi.fn(async () => true);
    const { opts } = baseOpts({ probe: vi.fn(async () => DOWN), authenticate });
    await ensureGatewayRunning(opts);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('⭐ 认证探测抛异常 ⇒ 当成认证失败（保守：宁可报端口被占，也不要误 kill）', async () => {
    const { opts, spawn } = baseOpts({
      probe: vi.fn(async () => READY),
      authenticate: vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    });

    await expect(
      ensureGatewayRunning({ ...opts, authProbe: fastProbe(), foreignWait: noWait() }),
    ).rejects.toMatchObject({ code: GATEWAY_PORT_OCCUPIED });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('⭐ 没给 identityPath 又用默认认证 ⇒ 当场炸（不能伪装成"端口被占"）', async () => {
    const child = makeChild();
    const opts = {
      ...baseOpts().opts,
      // 用默认 authenticate（不注入），且不给 identityPath
      authenticate: undefined,
      identityPath: undefined,
      spawn: vi.fn(() => child),
      waitReady: vi.fn(async () => {}),
    };
    // 缺配置是**编程错误**：必须响亮地失败，而不是把自家网关误判成 foreign
    await expect(ensureGatewayRunning(opts)).rejects.toThrow(/identityPath/);
  });

  it('spawn 之后要等就绪（waitReady 被调用，且拿到的是刚 spawn 的子进程）', async () => {
    const { opts, child } = baseOpts();
    const waitReady = vi.fn(async (_c: GatewayChildProcess) => {});
    await ensureGatewayRunning({ ...opts, waitReady });
    expect(waitReady).toHaveBeenCalledTimes(1);
    expect(waitReady.mock.calls[0][0]).toBe(child);
  });
});

/**
 * ⭐ **preflight 与 readiness 必须严格分开**（用户复审特别点出的一条）。
 *
 * 两者看的是同一件事（`/startupz` 的 status），但**结论完全相反**：
 *   - **preflight**（还没 spawn 之前）：端口活着但不是 `started + auth OK`
 *     ⇒ foreign，一个动作都不做。
 *   - **readiness**（我们**自己刚 spawn 的**）：`starting` = 正常，**继续等**。
 *
 * 混淆的后果很具体：把自己刚启动、正在 `starting` 的网关判成 foreign，
 * 于是**永远起不来**（而且报的是"端口被占"，查错方向完全错）。
 */
describe('preflight vs readiness —— 同一件事，两个相反的结论', () => {
  it('⭐ preflight：端口活着但不是 started ⇒ foreign（不 spawn）', async () => {
    const { opts, spawn } = baseOpts({ probe: vi.fn(async () => ({ reachable: true, status: 'starting' })) });
    await expect(ensureGatewayRunning({ ...opts, foreignWait: noWait() })).rejects.toMatchObject({
      code: GATEWAY_PORT_OCCUPIED,
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  /**
   * BUG-040 · R1：「探测超时」不是「明确拒绝」。
   *
   * 实测形状（文件头那条 2026-09-13 的教训）：网关报 `started` 之后还要几秒才肯
   * 完成 WS 握手，这段时间认证探测是**挂住**（超时），不是拒绝。旧行为一次超时
   * 就判 foreign ⇒ 报"端口被占"，而端口上跑的正是我们上一轮自己起的网关。
   */
  describe('BUG-040 R1：认证"探不动"要有界多探，别一次就判死', () => {
    it('⭐ 超时两次后认证通过 ⇒ reuse（绝不 spawn）', async () => {
      let calls = 0;
      const { opts, spawn } = baseOpts({
        probe: vi.fn(async () => READY),
        authenticate: vi.fn(async () => (++calls < 3 ? ('unavailable' as const) : true)),
      });
      const res = await ensureGatewayRunning({ ...opts, authProbe: fastProbe() });
      expect(res.ownership).toBe('reused');
      expect(calls).toBe(3);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('⭐ 一直探不动 ⇒ 有界多探（3 次）后才判 foreign，且绝不 spawn', async () => {
      const authenticate = vi.fn(async () => 'unavailable' as const);
      const { opts, spawn } = baseOpts({ probe: vi.fn(async () => READY), authenticate });
      await expect(
        ensureGatewayRunning({ ...opts, authProbe: fastProbe(), foreignWait: noWait() }),
      ).rejects.toMatchObject({ code: GATEWAY_PORT_OCCUPIED });
      expect(authenticate).toHaveBeenCalledTimes(3);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('⭐ 明确拒绝（false）⇒ 一次就终态，不做多探、不等待（行为不变）', async () => {
      const clock = waitClock();
      const authenticate = vi.fn(async () => false);
      const { opts, spawn } = baseOpts({ probe: vi.fn(async () => READY), authenticate });
      await expect(
        ensureGatewayRunning({
          ...opts,
          authProbe: { attempts: 3, intervalMs: 1_000, sleep: clock.sleep },
          foreignWait: { timeoutMs: 15_000, intervalMs: 1_000, sleep: clock.sleep, now: clock.now },
        }),
      ).rejects.toMatchObject({ code: GATEWAY_PORT_OCCUPIED });
      expect(authenticate).toHaveBeenCalledTimes(1);
      expect(clock.sleeps).toEqual([]);
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  /**
   * BUG-040 · R4：孤儿占用者（崩溃/被杀留下的网关没起完）会一直占着端口。
   * spawn 之前先**有界等待**，看它是不是自己退场；真 foreign 的行为一个字不变。
   */
  describe('BUG-040 R4：占用者退场的有界等待', () => {
    it('⭐ 端口上有个"没起来"的服务，等它退场后 ⇒ 正常 spawn', async () => {
      const clock = waitClock();
      const probes: StartupzProbe[] = [
        { reachable: true, status: 'starting' },
        { reachable: true, status: 'starting' },
        { reachable: false },
      ];
      let index = 0;
      const { opts, spawn } = baseOpts({ probe: vi.fn(async () => probes[Math.min(index++, probes.length - 1)]) });
      const res = await ensureGatewayRunning({
        ...opts,
        foreignWait: { timeoutMs: 15_000, intervalMs: 1_000, sleep: clock.sleep, now: clock.now },
      });
      expect(res.ownership).toBe('spawned');
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(clock.sleeps.length).toBeGreaterThan(0);
      expect(clock.sleeps.length).toBeLessThan(15_000 / 1_000);
    });

    it('⭐ 等待期间对端变成 started 且认证通过 ⇒ reuse（不 spawn）', async () => {
      const clock = waitClock();
      const probes: StartupzProbe[] = [
        { reachable: true, status: 'starting' },
        { reachable: true, status: 'started' },
      ];
      let index = 0;
      const { opts, spawn } = baseOpts({ probe: vi.fn(async () => probes[Math.min(index++, probes.length - 1)]) });
      const res = await ensureGatewayRunning({
        ...opts,
        authenticate: vi.fn(async () => true),
        foreignWait: { timeoutMs: 15_000, intervalMs: 1_000, sleep: clock.sleep, now: clock.now },
      });
      expect(res.ownership).toBe('reused');
      expect(spawn).not.toHaveBeenCalled();
    });

    it('⭐ 等满窗口仍在 ⇒ 仍判 foreign；错误信息带**占用者线索**（净是"端口被占"没人能排障）', async () => {
      const clock = waitClock();
      const { opts, spawn } = baseOpts({ probe: vi.fn(async () => ({ reachable: true, status: 'starting' })) });
      const error = (await ensureGatewayRunning({
        ...opts,
        portOccupant: () => 'PID 4321（node.exe）',
        foreignWait: { timeoutMs: 15_000, intervalMs: 1_000, sleep: clock.sleep, now: clock.now },
      }).catch((reason: unknown) => reason)) as Error & { code?: string };
      expect(error.code).toBe(GATEWAY_PORT_OCCUPIED);
      expect(error.message).toContain('PID 4321');
      expect(error.message).toContain('15');
      expect(spawn).not.toHaveBeenCalled();
      expect(clock.sleeps.length).toBe(15);
    });
  });

  it('⭐ readiness：我们**自己 spawn 的**报 starting ⇒ 继续等，绝不判 foreign', async () => {
    // 先 DOWN（于是走 spawn），spawn 之后 /startupz 开始报 starting，
    // 最后才 started —— 这正是真实网关的冷启动过程（实测 ~38s）
    const probes = [DOWN, { reachable: true, status: 'starting' }, { reachable: true, status: 'starting' }, READY];
    let i = 0;
    const { opts, spawn } = baseOpts({ probe: vi.fn(async () => probes[Math.min(i++, probes.length - 1)]) });

    const res = await ensureGatewayRunning({ ...opts, waitReady: undefined, authenticate: vi.fn(async () => true) });

    expect(res.ownership).toBe('spawned');
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
