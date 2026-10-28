import WebSocketImpl from 'ws';

// Electron 34 and the release CI both use Node 20.  Newer supabase-js versions
// eagerly construct their Realtime client even for plain auth calls and require
// a WebSocket implementation at construction time.  The packaged main process
// installs the same `ws` implementation in commercial/client.ts; install it in
// the shared test runtime as well so integration tests exercise the supported
// Node 20 shape instead of failing before the request under test is sent.
if (typeof globalThis.WebSocket === 'undefined') {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = WebSocketImpl;
}

/**
 * 测试环境兜底：给 jsdom 补上 `window.localStorage`。
 *
 * 事实（2026-09-17 实测，用一个只 import vitest 的探针文件确认过）：
 * 本仓库的 jsdom 28 + vitest 3.2.7 组合下 `window.localStorage` 是 **undefined**
 * （`sessionStorage` 却有），而 `new Storage()` 会抛 `Illegal constructor`。
 * 于是直接调 `window.localStorage.clear()` 的 4 个既有测试文件
 * （login-screen / onboarding-screen / internal-beta-hub / assistant-task-workbench-flow）
 * 在 `beforeEach` 就抛 `Cannot read properties of undefined (reading 'clear')`，
 * 合计 33 条用例**从来就没真正跑过**。
 *
 * ⚠️ 方法装在 `Storage.prototype` 上、而不是实例上：`assistant-task-workbench-flow`
 *    用 `vi.spyOn(Storage.prototype, 'setItem')` 断言「只写了一次」，实例自有的方法
 *    会绕开这个 spy，那两条用例仍然会红。
 *
 * ⚠️ 只在环境**确实没有** localStorage 的时候装：node 环境的测试、以及自己
 *    `vi.stubGlobal('localStorage', …)` 过的测试都不受影响。
 *    这是唯一目的 —— 不改产品代码、不改任何用例的断言。
 */
const storagePrototype = (globalThis as unknown as { Storage?: { prototype: Storage } }).Storage?.prototype;

if (typeof window !== 'undefined' && !window.localStorage && storagePrototype) {
  const areas = new WeakMap<Storage, Map<string, string>>();

  function areaFor(self: Storage): Map<string, string> {
    let area = areas.get(self);
    if (!area) {
      area = new Map<string, string>();
      areas.set(self, area);
    }
    return area;
  }

  storagePrototype.setItem = function (this: Storage, key: string, value: string): void {
    areaFor(this).set(String(key), String(value));
  };
  storagePrototype.getItem = function (this: Storage, key: string): string | null {
    const value = areaFor(this).get(String(key));
    return value === undefined ? null : value;
  };
  storagePrototype.removeItem = function (this: Storage, key: string): void {
    areaFor(this).delete(String(key));
  };
  storagePrototype.clear = function (this: Storage): void {
    areaFor(this).clear();
  };
  storagePrototype.key = function (this: Storage, index: number): string | null {
    return [...areaFor(this).keys()][index] ?? null;
  };
  try {
    Object.defineProperty(storagePrototype, 'length', {
      configurable: true,
      get(this: Storage): number {
        return areaFor(this).size;
      },
    });
  } catch {
    // 某些 jsdom 版本把 length 定义成不可配置；缺了它不影响任何用例
  }

  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    writable: true,
    value: Object.create(storagePrototype) as Storage,
  });
}

// jsdom 同样没有实现 scrollIntoView（组件里用它做「滚到底」），缺了就补个空实现。
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}
