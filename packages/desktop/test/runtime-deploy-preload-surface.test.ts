import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ClawWorkAPI } from '../src/preload/clawwork';

/**
 * 本机运行时**部署进度 + 自助重试**的 preload 表面（2026-10-07 区 7）。
 *
 * preload 是渲染层唯一能碰到的东西：少一个方法，界面上就是 "undefined is not a function"；
 * 通道名漂一个字，事件永远收不到、补读永远打空。这里三种检查（同
 * `commercial-preload-surface.test.ts`）：
 *   1. **源码文本**：方法名 ↔ 通道名 ↔ `clawwork.d.ts` 声明，三处同名同通道；
 *   2. **运行期**（真的把 preload 载进来，替身 electron）：读 / 重试真的打到那两条通道；
 *   3. **退订真的退掉** —— 退不掉的订阅会在每次重建窗口时越积越多，而源码看着完全正常。
 *
 * 还有一条本域特有的：`null` **必须原样送到回调** —— 它是"这一轮部署结束了"的唯一表达
 * （不是"没问题"，更不是"没有部署过"），被吞掉的话界面会一直挂着最后那条进度。
 */
const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8');
const declarations = readFileSync(new URL('../src/preload/clawwork.d.ts', import.meta.url), 'utf8');

const CHANNEL_READ = 'runtime:deploy-progress';
const CHANNEL_EVENT = 'runtime-deploy-progress';
const CHANNEL_RETRY = 'runtime:bootstrap-retry';

const renderer = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    listeners,
    invoke: vi.fn(async (...args: unknown[]) => args),
    send: vi.fn(),
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      const set = listeners.get(channel) ?? new Set<(...args: unknown[]) => void>();
      set.add(listener);
      listeners.set(channel, set);
    }),
    removeListener: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      listeners.get(channel)?.delete(listener);
    }),
    exposed: undefined as unknown,
    emit(channel: string, payload: unknown): void {
      for (const listener of [...(listeners.get(channel) ?? [])]) listener({}, payload);
    },
  };
});

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown): void => {
      if (key === 'clawwork') renderer.exposed = api;
    },
  },
  ipcRenderer: {
    invoke: renderer.invoke,
    on: renderer.on,
    removeListener: renderer.removeListener,
    send: renderer.send,
  },
}));

function exposedApi(): ClawWorkAPI {
  return renderer.exposed as ClawWorkAPI;
}

beforeAll(async () => {
  // preload 末尾会因为 contextIsolation 没开而直接抛 —— 这里按真实环境打开它。
  (process as unknown as { contextIsolated?: boolean }).contextIsolated = true;
  await import('../src/preload/index.js');
});

afterAll(() => {
  delete (process as unknown as { contextIsolated?: boolean }).contextIsolated;
});

describe('部署进度 / 自助重试的 preload 表面', () => {
  it('三个方法在 preload 与类型声明里都有', () => {
    for (const name of ['runtimeDeployProgress', 'onRuntimeDeployProgress', 'runtimeBootstrapRetry']) {
      expect(preload, `${name} 没有出现在 preload/index.ts`).toContain(`${name}:`);
      expect(declarations, `${name} 没有出现在 clawwork.d.ts`).toContain(`${name}:`);
    }
  });

  it('通道名逐字钉住（读 / 事件 / 重试三条）', () => {
    expect(preload).toContain(`invoke('${CHANNEL_READ}')`);
    expect(preload).toContain(`on('${CHANNEL_EVENT}'`);
    expect(preload).toContain(`invoke('${CHANNEL_RETRY}')`);
  });

  it('主进程真的处理了这三条通道（preload 有方法、主进程没 handler = 那次调用永远挂起）', () => {
    const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    expect(main, '缺 `runtime:deploy-progress` 的初始读').toContain(`ipcMain.handle('${CHANNEL_READ}'`);
    expect(main, '缺「重新准备」那条真的重跑 bootstrap 的通道').toContain(`ipcMain.handle('${CHANNEL_RETRY}'`);
    expect(main, '缺把进度推给渲染层的那一条').toContain(`'${CHANNEL_EVENT}'`);
  });

  it('⭐ DTO 只有一份：从 @clawwork/shared 来，不在 preload 里再抄一遍', () => {
    expect(declarations).toContain('RuntimeDeployProgress');
    expect(declarations, 'DTO 定义在 shared，声明文件只 import 它').not.toMatch(
      /(?:export )?interface RuntimeDeployProgress/,
    );
    expect(declarations).toMatch(
      /import type \{[\s\S]{0,4000}?RuntimeDeployProgress[\s\S]{0,4000}?\} from '@clawwork\/shared'/,
    );
  });

  it('⭐⭐ 运行期：读 / 重试打到对应通道，事件带载荷（含 `null`）回调，退订之后不再回调', async () => {
    const api = exposedApi();

    await api.runtimeDeployProgress();
    expect(renderer.invoke).toHaveBeenCalledWith(CHANNEL_READ);
    await api.runtimeBootstrapRetry();
    expect(renderer.invoke).toHaveBeenCalledWith(CHANNEL_RETRY);

    const callback = vi.fn();
    const unsubscribe = api.onRuntimeDeployProgress(callback);
    expect(renderer.on).toHaveBeenCalledWith(CHANNEL_EVENT, expect.any(Function));

    const snapshot = { phase: 'extract', done: 5, total: 10, startedAt: 1_000 };
    renderer.emit(CHANNEL_EVENT, snapshot);
    expect(callback).toHaveBeenCalledWith(snapshot);

    renderer.emit(CHANNEL_EVENT, null);
    expect(callback, '`null` = 这一轮部署结束，必须原样送到回调').toHaveBeenLastCalledWith(null);

    expect(typeof unsubscribe, '订阅必须返回退订函数').toBe('function');
    unsubscribe();
    expect(renderer.removeListener).toHaveBeenCalledWith(CHANNEL_EVENT, expect.any(Function));
    renderer.emit(CHANNEL_EVENT, snapshot);
    expect(callback, '退订之后主进程再发事件，渲染层不该再收到').toHaveBeenCalledTimes(2);
  });
});
