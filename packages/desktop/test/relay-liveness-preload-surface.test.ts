import { readFileSync } from 'node:fs';
import { vi, beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { ClawWorkAPI } from '../src/preload/clawwork';

/**
 * relay 存活状态的 **preload 表面**（同 `commercial-preload-surface.test.ts` 的做法）：
 * 源码文本三处同名同通道 + 运行期真载入 + 退订真退。少一个方法/漂一个通道名，
 * 界面就是 "undefined is not a function" 或事件永远收不到，而源码看着完全正常。
 */
const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8');
const declarations = readFileSync(new URL('../src/preload/clawwork.d.ts', import.meta.url), 'utf8');
const mainHandlers = readFileSync(new URL('../src/main/ipc/commercial-handlers.ts', import.meta.url), 'utf8');

const CHANNEL_STATE = 'commercial:relay-liveness-state';
const CHANNEL_CHANGED = 'commercial:relay-liveness-state-changed';
const CHANNEL_PROBE = 'commercial:relay-liveness-probe';

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
    /** 主进程那边"发了一条事件"。 */
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

beforeAll(async () => {
  (process as unknown as { contextIsolated?: boolean }).contextIsolated = true;
  await import('../src/preload/index.js');
});
afterAll(() => {
  delete (process as unknown as { contextIsolated?: boolean }).contextIsolated;
});

describe('relay 存活状态 preload 表面', () => {
  it('三个方法在 preload 与类型声明里都有', () => {
    for (const name of [
      'commercialRelayLivenessState',
      'onCommercialRelayLivenessState',
      'commercialRelayLivenessProbe',
    ]) {
      expect(preload, `${name} 没有出现在 preload/index.ts`).toContain(`${name}:`);
      expect(declarations, `${name} 没有出现在 clawwork.d.ts`).toContain(`${name}:`);
    }
  });

  it('通道名逐字钉住（preload 三条 + main handlers 两条 invoke）', () => {
    expect(preload).toContain(CHANNEL_STATE);
    expect(preload).toContain(CHANNEL_CHANGED);
    expect(preload).toContain(CHANNEL_PROBE);
    expect(mainHandlers).toContain(`'${CHANNEL_STATE}'`);
    expect(mainHandlers).toContain(`'${CHANNEL_PROBE}'`);
  });

  it('⭐ DTO 只有一份：从 @clawwork/shared 来，不在声明里再抄一遍', () => {
    expect(declarations).toContain('RelayLivenessPublicState');
    expect(declarations, 'DTO 定义在 shared，声明文件只 import 它').not.toMatch(/export type RelayLivenessPublicState/);
  });

  it('⭐⭐ 运行期：读 / 探打到对应通道，事件带载荷回调，退订之后不再回调', async () => {
    const api = renderer.exposed as ClawWorkAPI;

    await api.commercialRelayLivenessState();
    expect(renderer.invoke).toHaveBeenCalledWith(CHANNEL_STATE);
    await api.commercialRelayLivenessProbe();
    expect(renderer.invoke).toHaveBeenCalledWith(CHANNEL_PROBE);

    const callback = vi.fn();
    const unsubscribe = api.onCommercialRelayLivenessState(callback);
    expect(renderer.on).toHaveBeenCalledWith(CHANNEL_CHANGED, expect.any(Function));

    renderer.emit(CHANNEL_CHANGED, { phase: 'down', updatedAt: 1 });
    expect(callback).toHaveBeenCalledWith({ phase: 'down', updatedAt: 1 });

    expect(typeof unsubscribe, '订阅必须返回退订函数').toBe('function');
    unsubscribe();
    expect(renderer.removeListener).toHaveBeenCalledWith(CHANNEL_CHANGED, expect.any(Function));
    renderer.emit(CHANNEL_CHANGED, { phase: 'up', updatedAt: 2 });
    expect(callback, '退订之后主进程再发事件，渲染层不该再收到').toHaveBeenCalledTimes(1);
  });
});
