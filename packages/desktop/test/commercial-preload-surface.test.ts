import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ClawWorkAPI } from '../src/preload/clawwork';

/**
 * 中转 bootstrap 公开状态的 **preload 表面**。
 *
 * preload 是渲染层唯一能碰到的东西：少一个方法，界面上就是
 * "undefined is not a function"；通道名漂一个字，事件永远收不到。
 *
 * 这里**三种**检查，缺一不可：
 *   1. **源码文本**：方法名 ↔ 通道名 ↔ `clawwork.d.ts` 声明，三处同名同通道
 *      （同 `community-preload-surface.test.ts` / `analytics-preload-surface.test.ts`）；
 *   2. **运行期**（真的把 preload 载进来，替身 electron）：读 / 重试真的打到那两条通道；
 *   3. **退订真的退掉** —— 事件订阅的返回值必须把监听器从 `ipcRenderer` 上摘掉。
 *      只断言"订阅存在"是不够的：退不掉的订阅会在每次重建窗口时越积越多，
 *      而源码看着完全正常。（这条由变异验证过：把退订改成空函数它就会红。）
 */
const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8');
const declarations = readFileSync(new URL('../src/preload/clawwork.d.ts', import.meta.url), 'utf8');

const CHANNEL_STATE = 'commercial:relay-bootstrap-state';
const CHANNEL_CHANGED = 'commercial:relay-bootstrap-state-changed';
const CHANNEL_RETRY = 'commercial:relay-bootstrap-retry';

/**
 * 替身 electron：`ipcRenderer` 维护一张**真的**监听器表（`on` 加、`removeListener` 删），
 * 这样"退订之后还收不收得到"是可观测的，而不是靠读源码猜。
 */
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

describe('commercial relay bootstrap preload surface', () => {
  it('三个方法在 preload 与类型声明里都有', () => {
    for (const name of [
      'commercialRelayBootstrapState',
      'onCommercialRelayBootstrapState',
      'commercialRelayBootstrapRetry',
    ]) {
      expect(preload, `${name} 没有出现在 preload/index.ts`).toContain(`${name}:`);
      expect(declarations, `${name} 没有出现在 clawwork.d.ts`).toContain(`${name}:`);
    }
  });

  it('通道名逐字钉住（读 / 事件 / 重试三条）', () => {
    expect(preload).toContain(CHANNEL_STATE);
    expect(preload).toContain(CHANNEL_CHANGED);
    expect(preload).toContain(CHANNEL_RETRY);
  });

  it('⭐ DTO 只有一份：从 @clawwork/shared 来，不在 preload 里再抄一遍', () => {
    expect(declarations).toContain('RelayBootstrapPublicState');
    expect(declarations, 'DTO 定义在 shared，声明文件只 import 它').not.toMatch(
      /export type RelayBootstrapPublicState/,
    );
    expect(declarations).toMatch(
      /import type \{[\s\S]{0,4000}?RelayBootstrapPublicState[\s\S]{0,4000}?\} from '@clawwork\/shared'/,
    );
  });

  it('不额外暴露任何 commercialRelay 前缀的方法（闭集）', () => {
    const found = [...preload.matchAll(/\bcommercialRelay\w*/g)].map((m) => m[0]);
    expect([...new Set(found)].sort()).toEqual(['commercialRelayBootstrapRetry', 'commercialRelayBootstrapState']);
  });

  it('⭐⭐ 运行期：读 / 重试打到对应通道，事件带着载荷回调，**退订之后不再回调**', async () => {
    const api = exposedApi();

    await api.commercialRelayBootstrapState();
    expect(renderer.invoke).toHaveBeenCalledWith(CHANNEL_STATE);
    await api.commercialRelayBootstrapRetry();
    expect(renderer.invoke).toHaveBeenCalledWith(CHANNEL_RETRY);

    const callback = vi.fn();
    const unsubscribe = api.onCommercialRelayBootstrapState(callback);
    expect(renderer.on).toHaveBeenCalledWith(CHANNEL_CHANGED, expect.any(Function));

    const state = { phase: 'blocked', errorCode: 'license_bound_elsewhere', updatedAt: 1 };
    renderer.emit(CHANNEL_CHANGED, state);
    expect(callback).toHaveBeenCalledWith(state);

    expect(typeof unsubscribe, '订阅必须返回退订函数').toBe('function');
    unsubscribe();

    expect(renderer.removeListener).toHaveBeenCalledWith(CHANNEL_CHANGED, expect.any(Function));
    renderer.emit(CHANNEL_CHANGED, { ...state, updatedAt: 2 });
    expect(callback, '退订之后主进程再发事件，渲染层不该再收到').toHaveBeenCalledTimes(1);
  });
});
