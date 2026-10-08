import { describe, expect, it, vi } from 'vitest';
import { stopGateway, stopGatewayIfOwned } from '../src/main/runtime/gateway-process.js';
import type { GatewayChildProcess } from '../src/main/runtime/gateway-process.js';

/**
 * 退出时的 ownership —— **硬测试项**（用户复审提出）。
 *
 * 规则只有一条，但它决定"用户关掉客户端会不会把**别人的**网关带走"：
 *
 *   **只有 `ownership === 'spawned'` 才允许停。`reused` 绝不。**
 *
 * `reused` 意味着那个网关在客户端启动**之前**就存在（用户自己起的、或上一次留下的）。
 * 因为关一个客户端就把它杀掉，是那种"看着正常、用户丢了会话才发现"的事故。
 */

function makeChild(pid = 777): GatewayChildProcess & { killed: boolean; exited: boolean; exitNow: () => void } {
  const listeners: Array<() => void> = [];
  const c = {
    pid,
    killed: false,
    exited: false,
    // 与真实包装 `toGatewayChild` 语义一致：已退出则**同步**回调，否则挂监听。
    onExit: (listener: () => void) => {
      if (c.exited) listener();
      else listeners.push(listener);
    },
    kill: () => {
      c.killed = true;
    },
    exitNow: () => {
      c.exited = true;
      for (const listener of listeners.splice(0)) listener();
    },
  };
  return c;
}

const stopOpts = (child: GatewayChildProcess | null) => ({
  nodeExe: 'C:\\cache\\deployed\\k1\\node\\node.exe',
  cliPath: 'C:\\cache\\deployed\\k1\\node_modules\\openclaw\\openclaw.mjs',
  deployedRoot: 'C:\\cache\\deployed\\k1',
  stateDir: 'C:\\profile\\openclaw-state',
  child,
  runCommand: vi.fn(),
  taskkill: vi.fn(),
});

describe('stopGatewayIfOwned', () => {
  it('⭐ spawned ⇒ 停（这是我们起的，走了要收拾）', async () => {
    const stop = vi.fn(async () => {});
    await expect(stopGatewayIfOwned({ ownership: 'spawned', stop })).resolves.toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('⭐ reused ⇒ **绝不**停（硬测试项：网关是先于客户端存在的）', async () => {
    const stop = vi.fn(async () => {});
    await expect(stopGatewayIfOwned({ ownership: 'reused', stop })).resolves.toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });

  it('没有 ownership（启动就没成功）⇒ 也不停', async () => {
    const stop = vi.fn(async () => {});
    expect(await stopGatewayIfOwned({ ownership: null, stop })).toBe(false);
    expect(await stopGatewayIfOwned({ ownership: undefined, stop })).toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });

  it('spawned 时 stop 抛错要冒泡（调用方负责加超时；这里不静默吞）', async () => {
    const stop = vi.fn(async () => {
      throw new Error('kill failed');
    });
    await expect(stopGatewayIfOwned({ ownership: 'spawned', stop })).rejects.toThrow('kill failed');
  });
});

describe('stopGateway', () => {
  it('三步收尾：gateway stop --force → child.kill → taskkill 兜底', async () => {
    const child = makeChild(777);
    const opts = stopOpts(child);
    await stopGateway(opts);

    expect(opts.runCommand).toHaveBeenCalledTimes(1);
    expect(opts.runCommand.mock.calls[0][1]).toEqual([
      'C:\\cache\\deployed\\k1\\node_modules\\openclaw\\openclaw.mjs',
      'gateway',
      'stop',
      '--force',
    ]);
    expect(child.killed).toBe(true);
    expect(opts.taskkill).toHaveBeenCalledWith(777);
  });

  it('优雅停止失败**不中断**收尾（继续硬杀，否则进程会变孤儿）', async () => {
    const child = makeChild(777);
    const opts = stopOpts(child);
    opts.runCommand = vi.fn(() => {
      throw new Error('gateway stop 超时');
    });
    await expect(stopGateway(opts)).resolves.toBeUndefined();

    expect(child.killed).toBe(true);
    expect(opts.taskkill).toHaveBeenCalledWith(777);
  });

  it('⭐ 子进程已退出（句柄已关）⇒ 绝不对这个 pid 再打 taskkill —— pid 可能已被系统复用', async () => {
    // 生产 stderr 的常态：收尾时网关早已退出（`taskkill … status 128`）。
    // 那一刻 Node 已回收子进程句柄 —— Windows 可以把同一个 pid 发给**任何**新进程，
    // `taskkill /PID /T /F` 会连它整棵子树一起杀。所以只在"还没退出"时才允许兜底。
    const child = makeChild(777);
    child.exitNow();
    const opts = stopOpts(child);
    await stopGateway(opts);
    expect(opts.runCommand).toHaveBeenCalledTimes(1); // 优雅 stop 照旧
    expect(child.killed).toBe(true); // child.kill 是 handle 级操作，安全，照旧
    expect(opts.taskkill).not.toHaveBeenCalled();
  });

  it('⭐ 退出事件已送达（优雅 stop 期间自己退的）⇒ 同样不打 taskkill', async () => {
    const child = makeChild(888);
    const opts = stopOpts(child);
    opts.runCommand = vi.fn(() => {
      child.exitNow();
    });
    await stopGateway(opts);
    expect(child.killed).toBe(true);
    expect(opts.taskkill).not.toHaveBeenCalled();
  });

  it('taskkill 失败也不抛（进程往往已经死了，那是常态）', async () => {
    const child = makeChild(777);
    const opts = stopOpts(child);
    opts.taskkill = vi.fn(() => {
      throw new Error('not found');
    });
    await expect(stopGateway(opts)).resolves.toBeUndefined();
  });

  it('没有子进程（复用场景）⇒ 仍然尝试优雅 stop，但不 taskkill 一个不存在的 pid', async () => {
    const opts = stopOpts(null);
    await stopGateway(opts);
    expect(opts.runCommand).toHaveBeenCalledTimes(1);
    expect(opts.taskkill).not.toHaveBeenCalled();
  });

  it('优雅停止带 3s 超时（before-quit 不能卡住退出）', async () => {
    const opts = stopOpts(makeChild());
    await stopGateway(opts);
    expect(opts.runCommand.mock.calls[0][2].timeout).toBe(3000);
  });

  it('优雅停止要求网关用 state 目录（否则停的是别的网关）', async () => {
    const opts = stopOpts(makeChild());
    await stopGateway(opts);
    expect(opts.runCommand.mock.calls[0][2].env.OPENCLAW_STATE_DIR).toBe('C:\\profile\\openclaw-state');
  });

  it('优雅停止也使用隔离环境，不能在 stop 阶段又触发外置 provider 自动安装', async () => {
    const before = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'host-secret';
    try {
      const opts = stopOpts(makeChild());
      await stopGateway(opts);
      expect(opts.runCommand.mock.calls[0][2].env).not.toHaveProperty('DEEPSEEK_API_KEY');
    } finally {
      if (before === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = before;
    }
  });
});
