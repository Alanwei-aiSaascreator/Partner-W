import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    expect([...new Set(found)].sort()).toEqual([
      'commercialRelayBootstrapRetry',
      'commercialRelayBootstrapState',
      'commercialRelayLivenessProbe',
      'commercialRelayLivenessState',
    ]);
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

/**
 * 分层护栏：`@clawwork/shared` 里那份**可变状态**只许主进程**按值** import。
 *
 * ## 为什么（不是洁癖，是打包行为）
 *
 * `relayBootstrapPublicStateStore` 是**模块初始化**那一刻建出来的单例，而
 * `@clawwork/shared` 的 `package.json` **没有** `sideEffects: false` ⇒ 打包器
 * （vite/rollup/esbuild 都一样）**不能**把那句初始化删掉。渲染层一旦按值 import，
 * 就会在自己的包里留下一个"谁也没用、但真的存在"的**包内单例** —— 而注释里
 * "进程级单例"这句话在渲染层**根本不成立**（每个窗口/上下文各一份，而且和主进程
 * 那份毫无关系）。渲染层要的是 `import type`：类型在编译期被擦除，什么都不会带进去。
 *
 * ⚠️ 这里**只扫源码文本**（同上面 `preload` 那几条的做法）：`import type { … }` 与
 *    逐项 `type X` 都不算按值；`import * as ns` / 默认导入算按值（整个模块都进来了）。
 */
const GUARDED_VALUE_EXPORTS = [
  'createRelayBootstrapPublicStateStore',
  'relayBootstrapPublicStateStore',
  'resetRelayBootstrapPublicState',
  'createRelayLivenessPublicStateStore',
  'relayLivenessPublicStateStore',
];

/** 一段源码里，从 `@clawwork/shared` **按值**引进来的东西（只看被护栏盯住的那三个）。 */
function sharedValueImports(source: string): string[] {
  const found: string[] = [];
  // ⚠️ 子句里**不许出现 `;`**（`[^;]*?`，不是 `[\s\S]*?`）：prettier 的 `semi: true` 保证
  //    每条 import 都以 `;` 收尾，不加这条约束的话惰性匹配会**跨过好几条语句**，把
  //    `import { StrictMode } from 'react';` 一路吃到后面那行 `from '@clawwork/shared'`
  //    （实测：`renderer/main.tsx` 就是这么被误报成"整包导入"的）。
  const statement = /(?:^|\n)[ \t]*(?:import|export)\s+([^;]*?)\s+from\s+['"]@clawwork\/shared['"]/g;
  for (const match of source.matchAll(statement)) {
    const clause = (match[1] ?? '').trim();
    if (/^type\b/.test(clause)) continue; // 整条 `import type { … }`：编译期擦除
    if (!clause.startsWith('{')) {
      // 默认 / 命名空间导入：整个模块都进来了，那三个名字自然也够得着 —— 直接算违规。
      found.push(`整包（${clause.replace(/\s+/g, ' ')}）`);
      continue;
    }
    for (const raw of clause.replace(/[{}]/g, '').split(',')) {
      const specifier = raw.trim();
      if (!specifier || /^type\b/.test(specifier)) continue; // 逐项 `type X`
      found.push(specifier.split(/\s+as\s+/)[0]!.trim());
    }
  }
  return found.filter((name) => name.startsWith('整包（') || GUARDED_VALUE_EXPORTS.includes(name));
}

/** 一个目录下的全部 `.ts` / `.tsx`（含子目录）。 */
function sourceFilesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFilesUnder(full));
    else if (/\.tsx?$/.test(entry.name)) files.push(full);
  }
  return files;
}

describe('分层护栏 —— 那份可变状态只许主进程按值 import', () => {
  const srcRoot = fileURLToPath(new URL('../src', import.meta.url));
  const guardedDirs = ['renderer', 'preload'].map((name) => join(srcRoot, name));
  const scanned = guardedDirs.flatMap((dir) => sourceFilesUnder(dir));

  it('🔎 护栏自己：给一段**按值** import 必须报出来，`import type` 必须放过（否则整条是假绿）', () => {
    expect(sharedValueImports(`import { relayBootstrapPublicStateStore } from '@clawwork/shared';`)).toEqual([
      'relayBootstrapPublicStateStore',
    ]);
    expect(
      sharedValueImports(
        `import {\n  type RelayBootstrapPublicState,\n  resetRelayBootstrapPublicState,\n} from '@clawwork/shared';`,
      ),
    ).toEqual(['resetRelayBootstrapPublicState']);
    expect(sharedValueImports(`import type { RelayBootstrapPublicState } from '@clawwork/shared';`)).toEqual([]);
    expect(sharedValueImports(`import * as shared from '@clawwork/shared';`)).toHaveLength(1);
  });

  it('⭐ 扫描范围不为空（空集 = 假绿：护栏必须真的扫到那两个目录）', () => {
    expect(scanned.length, 'renderer 里有两百多个 ts/tsx，扫不到就说明走错了目录').toBeGreaterThan(200);
    expect(
      scanned.filter((file) => file.includes(`${join('src', 'preload')}`)).length,
      'preload 两个文件都要在扫描范围里（index.ts 是它自己）',
    ).toBeGreaterThanOrEqual(2);
  });

  it('⭐⭐ renderer / preload 里没有任何文件**按值** import 它们', () => {
    const offenders: string[] = [];
    for (const file of scanned) {
      const text = readFileSync(file, 'utf8');
      for (const name of sharedValueImports(text)) {
        offenders.push(`${relative(srcRoot, file).split('\\').join('/')} → ${name}`);
      }
    }
    expect(
      offenders,
      '这两个目录只能 `import type`：按值 import 会在渲染层的包里留下一份没人用、但真的存在的"包内单例"（shared 没写 sideEffects:false，打包器删不掉那句初始化）',
    ).toEqual([]);
  });
});
