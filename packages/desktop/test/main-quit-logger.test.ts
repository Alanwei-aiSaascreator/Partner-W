import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadQuitHandler(close: () => Promise<void>) {
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  const start = source.lastIndexOf("app.on('before-quit',");
  if (start < 0) throw new Error('Missing production quit handler');
  const order: string[] = [];
  let handler: ((event: { preventDefault: () => void }) => void) | undefined;
  const closeLogger = vi.fn(() => {
    order.push('close-logger');
    return close();
  });
  const quit = vi.fn(() => order.push('quit'));
  const consoleError = vi.fn();
  runInNewContext(source.slice(start), {
    app: { on: (_name: string, callback: typeof handler) => (handler = callback), quit },
    isQuitting: false,
    isInstallingUpdate: () => false,
    getDebugLogger: () => ({ info: vi.fn(), flush: () => Promise.resolve(), close: closeLogger }),
    globalShortcut: { unregisterAll: vi.fn() },
    destroyUsageReporter: vi.fn(),
    // 退出链的新参与者（31eb737d 之后）：沙箱是**显式依赖白名单**，缺一个
    // 就 ReferenceError、链断在 closeLogger 前 —— 补进来即恢复，顺序断言不受影响
    // （这个桩不推 order）。
    destroyRelayLiveness: vi.fn(),
    teardownAnalytics: vi.fn(),
    // V4（2026-10-14）：执行历史 writer 停表 —— 同"显式依赖白名单"（不推 order）。
    stopExecutionHistory: vi.fn(),
    shutdownLocalGatewayRuntime: () => Promise.resolve(),
    destroyAllGateways: () => order.push('gateways'),
    destroyTray: () => order.push('tray'),
    destroyQuickLaunch: () => order.push('quick-launch'),
    closeDatabase: () => order.push('database'),
    console: { error: consoleError },
  });
  if (!handler) throw new Error('Production quit handler was not registered');
  handler({ preventDefault: vi.fn() });
  return { order, closeLogger, quit, consoleError };
}

describe('production main quit logger barrier', () => {
  it('closes logging after teardown and waits for it before exiting', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const result = loadQuitHandler(() => pending);
    try {
      await vi.waitFor(() => expect(result.closeLogger).toHaveBeenCalledOnce());
      expect(result.order).toEqual(['gateways', 'tray', 'quick-launch', 'database', 'close-logger']);
      expect(result.quit).not.toHaveBeenCalled();
    } finally {
      release?.();
    }
    await vi.waitFor(() => expect(result.quit).toHaveBeenCalledOnce());
    expect(result.order.at(-1)).toBe('quit');
  });

  it('reports a logger close failure without blocking application exit', async () => {
    const error = new Error('injected-close-failure');
    const result = loadQuitHandler(() => Promise.reject(error));
    await vi.waitFor(() => expect(result.quit).toHaveBeenCalledOnce());
    expect(result.closeLogger).toHaveBeenCalledOnce();
    expect(result.consoleError).toHaveBeenCalledWith('[debug] close failed:', error);
  });
});
