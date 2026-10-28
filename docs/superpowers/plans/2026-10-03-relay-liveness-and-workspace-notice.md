# relay 运行期可见性 + 工作区重建告知 —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 两条感知缺口各补一个最小闭环：①relay 运行中断开 → 周期探活 + 命名横幅（不锁输入框）；②工作区被就地重建（`recreated`）→ 非阻断告知（就绪页 + 工作台）。

**Architecture:** 完全镜像既有三件套——shared 的公开状态 store（单调 updatedAt + 显式挑选字段）＋ 主进程推送桥（`sendToWindow`）＋ renderer 纯判据函数 + InlineNotice 组件。探活复用 `activeRelayBaseUrl()` 出口与无鉴权 GET `/v1/catalog`（2xx/4xx＝活、5xx/超时/拒连＝断）。

**Tech Stack:** Electron 34 / React 18 / vitest（jsdom + node）/ @clawwork/shared DTO / i18n 九语言。

**Spec:** `docs/superpowers/specs/2026-10-03-relay-liveness-and-workspace-notice-design.md`（已提交 `c900fd9b`）。

**工作树:** `D:\Desktop\new project\partner-w\partner-w-desktop\.worktrees\codex-release-blockers`（分支 `codex/native-ppt-controlled-validation`）。⚠️ 树上有 codex 在途 WIP——**每刀只 `git add` 本刀点名文件**，绝不 `add -A`。

**统一命令**（根目录 = 工作树根）：

- 定向测试：`pnpm --filter @clawwork/desktop exec vitest run test/<file>`
- shared 测试：`pnpm --filter @clawwork/shared exec vitest run test/<file>`
- 门禁四件：`pnpm check:architecture && pnpm check:ui-contract && pnpm check:renderer-copy && pnpm check:i18n`
- 类型/格式：`pnpm typecheck && pnpm typecheck:tests`；`pnpm format:check`；`pnpm lint`
- 回归族：11 个 relay 测试 + startup-readiness/entry-preparation 相关族（见各刀"收尾"步）

---

## 文件地图

### 切片 1（relay 运行期可见性）

| 动作 | 文件                                                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| 新建 | `packages/shared/src/relay-liveness-state.ts`                                                                                |
| 改   | `packages/shared/src/index.ts`（第 6 行后加一行 export）                                                                     |
| 新建 | `packages/shared/test/relay-liveness-state.test.ts`                                                                          |
| 新建 | `packages/desktop/src/main/commercial/relay-liveness.ts`                                                                     |
| 新建 | `packages/desktop/test/relay-liveness.test.ts`                                                                               |
| 改   | `packages/desktop/src/main/ipc/commercial-handlers.ts`（文件尾加两个 handler + 两行 import）                                 |
| 改   | `packages/desktop/src/main/index.ts`（`:41` import、`:577` init、`:634` destroy）                                            |
| 改   | `packages/desktop/src/preload/index.ts`（`:642` 之后加三件套）                                                               |
| 改   | `packages/desktop/src/preload/clawwork.d.ts`（`:912` 之后加声明）                                                            |
| 新建 | `packages/desktop/test/relay-liveness-preload-surface.test.ts`                                                               |
| 改   | `packages/desktop/test/commercial-preload-surface.test.ts`（闭集改为 4 名 + `GUARDED_VALUE_EXPORTS` 加 2 名）                |
| 新建 | `packages/desktop/src/renderer/lib/relay-connection-notice.ts`                                                               |
| 新建 | `packages/desktop/test/relay-connection-notice.test.ts`                                                                      |
| 新建 | `packages/desktop/src/renderer/components/RelayConnectionBanner.tsx`                                                         |
| 新建 | `packages/desktop/test/relay-connection-banner.test.tsx`                                                                     |
| 改   | `packages/desktop/src/renderer/layouts/MainArea/index.tsx`（import + `:1388` 后挂载）                                        |
| 改   | 9 个 locale：`packages/desktop/src/renderer/i18n/locales/{zh,zh-TW,en,ja,ko,de,fr,es,pt}.json`（`connection` 对象各加 1 键） |

### 切片 2（工作区重建告知）

| 动作 | 文件                                                                                                                                                        |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新建 | `packages/desktop/src/main/workspace/startup-notice.ts`                                                                                                     |
| 新建 | `packages/desktop/test/workspace-startup-notice.test.ts`                                                                                                    |
| 改   | `packages/desktop/src/main/workspace/startup.ts`（`:252` 决策日志行之后记录）                                                                               |
| 改   | `packages/desktop/src/main/ipc/workspace-handlers.ts`（`:110` `workspace:setup` 与 `:125` `workspace:change` 清空；`:170` 前加 `workspace:startup-notice`） |
| 改   | `packages/desktop/src/preload/index.ts`（workspace 段加 1 方法）                                                                                            |
| 改   | `packages/desktop/src/preload/clawwork.d.ts`（加声明）                                                                                                      |
| 新建 | `packages/desktop/src/renderer/components/WorkspaceRecreatedNotice.tsx`                                                                                     |
| 新建 | `packages/desktop/test/workspace-recreated-notice.test.tsx`                                                                                                 |
| 改   | `packages/desktop/src/renderer/layouts/EntryPreparation/index.tsx`（状态行区插入组件）                                                                      |
| 改   | `packages/desktop/src/renderer/layouts/MainArea/index.tsx`（欢迎屏 `:1025` 区插入组件）                                                                     |
| 改   | 9 个 locale（`workspaceNotice` 段各加 3 键）                                                                                                                |

---

## 切片 1 · Task 1：shared 的 relay 存活公开状态

**Files:**

- Create: `packages/shared/src/relay-liveness-state.ts`
- Modify: `packages/shared/src/index.ts:6`
- Test: `packages/shared/test/relay-liveness-state.test.ts`

- [ ] **Step 1: 写失败测试** `packages/shared/test/relay-liveness-state.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import {
  createRelayLivenessPublicStateStore,
  relayLivenessPublicStateStore,
  type RelayLivenessPhase,
  type RelayLivenessPublicState,
} from '../src/index.js';

/**
 * relay 存活公开状态 —— 与 `commercial-relay-state.test.ts` 同一条纪律：
 * 严格单调 updatedAt、字段闭集、退订真退、订阅者抛错不伤别人。
 */
describe('relay 存活公开状态 store', () => {
  it('初始态是 unknown（还没探过）', () => {
    const store = createRelayLivenessPublicStateStore({ now: () => 1_000 });
    expect(store.get()).toEqual({ phase: 'unknown', updatedAt: 1_000 });
  });

  it('⭐ updatedAt 严格递增：时钟不动也一次比一次大', () => {
    const store = createRelayLivenessPublicStateStore({ now: () => 5_000 });
    const first = store.set({ phase: 'up' });
    const second = store.set({ phase: 'down' });
    expect(first.updatedAt).toBe(5_001);
    expect(second.updatedAt).toBe(5_002);
  });

  it('⭐ 时钟倒退也不许让 updatedAt 变小', () => {
    let t = 10_000;
    const store = createRelayLivenessPublicStateStore({ now: () => t });
    const first = store.set({ phase: 'up' });
    t = 1;
    expect(store.set({ phase: 'down' }).updatedAt).toBeGreaterThan(first.updatedAt);
  });

  it('⭐ 载荷字段是闭集（phase / updatedAt 一个不多）', () => {
    const store = createRelayLivenessPublicStateStore({ now: () => 1_000 });
    for (const phase of ['unknown', 'up', 'down'] as const) {
      expect(Object.keys(store.set({ phase })).sort()).toEqual(['phase', 'updatedAt']);
    }
  });

  it('🔴 `as` 硬塞的多余字段进不来', () => {
    const store = createRelayLivenessPublicStateStore({ now: () => 1_000 });
    const smuggled = { phase: 'down', detail: 'raw message' } as { phase: 'down' };
    const state = store.set(smuggled);
    expect(Object.keys(state).sort()).toEqual(['phase', 'updatedAt']);
    expect(JSON.stringify(state)).not.toContain('detail');
  });

  it('⭐ 每次 set 都通知；退订幂等；订阅者抛错不伤别人与状态', () => {
    const store = createRelayLivenessPublicStateStore({ now: () => 1_000 });
    const seen: RelayLivenessPublicState[] = [];
    const unsub = store.subscribe((s) => seen.push(s));
    store.subscribe(() => {
      throw new Error('boomer');
    });
    store.subscribe((s) => seen.push(s));
    expect(() => store.set({ phase: 'up' })).not.toThrow();
    expect(seen.map((s) => s.phase)).toEqual(['up', 'up']);
    unsub();
    unsub();
    store.set({ phase: 'down' });
    expect(seen).toHaveLength(2);
    expect(store.get().phase).toBe('down');
  });

  it('⭐⭐ 相位恰好是这三个（闭集护栏）', () => {
    const ALL: Record<RelayLivenessPhase, true> = { unknown: true, up: true, down: true };
    expect(Object.keys(ALL)).toHaveLength(3);
  });

  it('单例存在且可写', () => {
    relayLivenessPublicStateStore.set({ phase: 'down' });
    expect(relayLivenessPublicStateStore.get().phase).toBe('down');
    relayLivenessPublicStateStore.set({ phase: 'unknown' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**：`pnpm --filter @clawwork/shared exec vitest run test/relay-liveness-state.test.ts` ⇒ FAIL（模块不存在）。

- [ ] **Step 3: 实现** `packages/shared/src/relay-liveness-state.ts`

```ts
/**
 * relay 的**运行期存活状态** —— ready 之后那条"还在不在"的公开结论。
 *
 * ## 为什么单独一份、不并进 `commercial-relay-state`
 *
 * bootstrap 那份的相位是**启动语义**的闭集（idle/running/ready/blocked/retryable-error，
 * 来源与教义见那个文件头），它是"这一轮跑到哪了"；本模块回答的是另一个问题：
 * "已经 ready 的服务，现在还能不能访问"。两者写者不同（bootstrap 调度器 vs 探活
 * monitor）、时间尺度不同（一次启动 vs 每 30 秒），并进一份会把两套教义搅在一起。
 *
 * 纪律与那份完全一致：updatedAt 严格单调（渲染层按它取舍）、字段闭集（显式挑选，
 * 挡 `as` 硬塞）、订阅者抛错不伤别人。**从不携带** URL / 错误原文 / 任何凭据。
 */
export type RelayLivenessPhase = 'unknown' | 'up' | 'down';

export interface RelayLivenessPublicState {
  phase: RelayLivenessPhase;
  updatedAt: number;
}

export interface RelayLivenessPublicStateStore {
  get: () => RelayLivenessPublicState;
  set: (next: { phase: RelayLivenessPhase }) => RelayLivenessPublicState;
  subscribe: (listener: (state: RelayLivenessPublicState) => void) => () => void;
}

/** 建一个存活状态 store。`now` 只给测试注入（默认 `Date.now`）。 */
export function createRelayLivenessPublicStateStore(opts: { now?: () => number } = {}): RelayLivenessPublicStateStore {
  const now = opts.now ?? ((): number => Date.now());
  let current: RelayLivenessPublicState = { phase: 'unknown', updatedAt: now() };
  const listeners = new Set<(state: RelayLivenessPublicState) => void>();

  return {
    get: () => current,
    set: (next) => {
      // 严格单调（与 `commercial-relay-state` 同一条理由：同一毫秒里连翻两次是常态）。
      const updatedAt = Math.max(now(), current.updatedAt + 1);
      // 显式挑选——**不是** `{ ...next, updatedAt }`。这一行是"永不泄漏"的卡口。
      current = { phase: next.phase, updatedAt };
      for (const listener of [...listeners]) {
        try {
          listener(current);
        } catch {
          // 订阅者自己的问题：吞掉，继续通知下一个。
        }
      }
      return current;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** **进程级单例**：主进程里写它的（探活 monitor）与读它的（IPC handlers 转发）必须同一个。 */
export const relayLivenessPublicStateStore = createRelayLivenessPublicStateStore();
```

- [ ] **Step 4: 导出**：`packages/shared/src/index.ts` 第 6 行 `export * from './commercial-relay-state.js';` 的**下一行**加：

```ts
export * from './relay-liveness-state.js';
```

- [ ] **Step 5: 跑测试确认通过**：同 Step 2 命令 ⇒ PASS（8 用例）。

- [ ] **Step 6: 提交**（切片 1 完成前**不单独提交**——随切片 1 一起，见 Task 5）。

## 切片 1 · Task 2：主进程探活 monitor

**Files:**

- Create: `packages/desktop/src/main/commercial/relay-liveness.ts`
- Test: `packages/desktop/test/relay-liveness.test.ts`

- [ ] **Step 1: 写失败测试** `packages/desktop/test/relay-liveness.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRelayBootstrapPublicStateStore,
  createRelayLivenessPublicStateStore,
  type RelayBootstrapPublicPhase,
} from '@clawwork/shared';
import {
  RELAY_LIVENESS_FAIL_THRESHOLD,
  RELAY_LIVENESS_INTERVAL_MS,
  createRelayLivenessMonitor,
  probeRelayReachability,
} from '../src/main/commercial/relay-liveness.js';

/**
 * 探活 monitor —— 判据全在纯逻辑里，用假定时器 + 注入探针驱动。
 * 真探针（`probeRelayReachability`）的判据单独一组，注入 fetch 桩。
 */
function harness(initial: RelayBootstrapPublicPhase = { phase: 'ready' }) {
  const bootstrap = createRelayBootstrapPublicStateStore({ now: () => 1_000 });
  bootstrap.set(initial);
  const state = createRelayLivenessPublicStateStore({ now: () => 1_000 });
  const probe = vi.fn(async () => true);
  const logs: string[] = [];
  const monitor = createRelayLivenessMonitor({
    bootstrap,
    state,
    probe,
    baseUrl: () => 'http://127.0.0.1:8791',
    intervalMs: RELAY_LIVENESS_INTERVAL_MS,
    log: (event) => logs.push(event),
  });
  return { bootstrap, state, probe, logs, monitor };
}

describe('relay 探活 monitor', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('bootstrap 没到 ready ⇒ 不探、状态停在 unknown', async () => {
    const h = harness({ phase: 'idle' });
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(RELAY_LIVENESS_INTERVAL_MS * 3);
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.state.get().phase).toBe('unknown');
    h.monitor.stop();
  });

  it('⭐ ready ⇒ 立刻探一次；两连败才 down；一胜即 up', async () => {
    const h = harness();
    h.probe.mockResolvedValue(false);
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.state.get().phase, '一次失败还不够判死').toBe('unknown');
    await vi.advanceTimersByTimeAsync(RELAY_LIVENESS_INTERVAL_MS);
    expect(h.probe).toHaveBeenCalledTimes(2);
    expect(h.state.get().phase).toBe('down');
    h.probe.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(RELAY_LIVENESS_INTERVAL_MS);
    expect(h.state.get().phase, '一次成功就恢复').toBe('up');
    h.monitor.stop();
  });

  it('⭐ 抖动（一败一胜）判不出 down', async () => {
    const h = harness();
    h.probe.mockResolvedValueOnce(false).mockResolvedValue(true);
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(RELAY_LIVENESS_INTERVAL_MS * 2);
    expect(h.state.get().phase).toBe('up');
    h.monitor.stop();
  });

  it('探针抛错按失败算（不许炸 monitor）', async () => {
    const h = harness();
    h.probe.mockRejectedValue(new Error('boom'));
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(RELAY_LIVENESS_INTERVAL_MS);
    expect(h.state.get().phase).toBe('down');
    expect(h.logs).toContain('relay.liveness.probe-failed');
    h.monitor.stop();
  });

  it('⭐ 离开 ready ⇒ 回 unknown 且停探；再回 ready 恢复探', async () => {
    const h = harness();
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    h.bootstrap.set({ phase: 'retryable-error', errorCode: 'transport' });
    expect(h.state.get().phase).toBe('unknown');
    const calls = h.probe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(RELAY_LIVENESS_INTERVAL_MS * 3);
    expect(h.probe).toHaveBeenCalledTimes(calls);
    h.bootstrap.set({ phase: 'ready' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.probe).toHaveBeenCalledTimes(calls + 1);
    h.monitor.stop();
  });

  it('stop() 之后不再探、不再发', async () => {
    const h = harness();
    h.probe.mockResolvedValue(false);
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(RELAY_LIVENESS_INTERVAL_MS);
    h.monitor.stop();
    const snapshot = JSON.stringify(h.state.get());
    await vi.advanceTimersByTimeAsync(RELAY_LIVENESS_INTERVAL_MS * 5);
    expect(JSON.stringify(h.state.get())).toBe(snapshot);
    h.monitor.stop();
  });

  it('probeNow() 立刻探（[立即重试] 的通道）', async () => {
    const h = harness();
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    const calls = h.probe.mock.calls.length;
    await h.monitor.probeNow();
    expect(h.probe.mock.calls.length).toBe(calls + 1);
    h.monitor.stop();
  });
});

describe('probeRelayReachability 判据', () => {
  const baseUrl = 'http://127.0.0.1:8791';
  it.each([
    [200, true],
    [401, true],
    [404, true],
    [500, false],
    [502, false],
    [503, false],
  ])('HTTP %i ⇒ %s（2xx/4xx=活；5xx=断）', async (status, expected) => {
    const fetchImpl = vi.fn(async () => ({ status }) as Response);
    expect(await probeRelayReachability(baseUrl, { fetchImpl, timeoutMs: 10 })).toBe(expected);
  });

  it('网络错误 / 超时 ⇒ 断', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await probeRelayReachability(baseUrl, { fetchImpl, timeoutMs: 10 })).toBe(false);
  });

  it('探的是 /v1/catalog、目标就是传入的 baseUrl（末尾斜杠归一）', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 401 }) as Response);
    await probeRelayReachability(`${baseUrl}/`, { fetchImpl, timeoutMs: 10 });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${baseUrl}/v1/catalog`);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**：`pnpm --filter @clawwork/desktop exec vitest run test/relay-liveness.test.ts` ⇒ FAIL（模块不存在）。

- [ ] **Step 3: 实现** `packages/desktop/src/main/commercial/relay-liveness.ts`

```ts
/**
 * relay 的**运行期探活** —— 补的是"ready 之后被杀，界面无感"那条缺口（2026-10-03 真机）。
 *
 * ## 形状（与 relay-startup 的桥同一条纪律）
 *
 *   - 只跟随 `relayBootstrapPublicStateStore`：到 `ready` 才开探，离开 `ready`
 *     立刻回 `unknown` 并停探（启动期的失败有 bootstrap 那套完整表达，不在这里重复说）；
 *   - 探针 = 无鉴权 `GET {base}/v1/catalog`：**2xx/4xx＝有应答＝活**（401 是正常应答），
 *     **5xx / 超时 / 拒连＝断**（502/504 是"服务死着"，不是"活着"）；
 *   - 节律 30s、**连续 2 次失败才判 down**（防单次抖动）、**1 次成功即回 up**；
 *   - 失败只吞错 + 记 debug 日志，绝不抛给调用方。
 */
import {
  relayBootstrapPublicStateStore,
  relayLivenessPublicStateStore,
  type RelayBootstrapPublicPhase,
  type RelayBootstrapPublicState,
  type RelayLivenessPublicStateStore,
} from '@clawwork/shared';
import { activeRelayBaseUrl } from './relay-config.js';
import { getDebugLogger } from '../debug/index.js';
import { sendToWindow } from '../ws/window-utils.js';
import { getMainWindow } from '../window-manager.js';

export const RELAY_LIVENESS_INTERVAL_MS = 30_000;
export const RELAY_LIVENESS_TIMEOUT_MS = 5_000;
export const RELAY_LIVENESS_FAIL_THRESHOLD = 2;
export const RELAY_LIVENESS_STATE_CHANGED_CHANNEL = 'commercial:relay-liveness-state-changed';

/** 真探针：判据见文件头。可注入 `fetchImpl`（单测）。 */
export async function probeRelayReachability(
  baseUrl: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/v1/catalog`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? RELAY_LIVENESS_TIMEOUT_MS),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

export interface RelayLivenessMonitor {
  start(): void;
  stop(): void;
  /** 手动立刻探一次（[立即重试] 的出口）。仍受"bootstrap 必须 ready"约束。 */
  probeNow(): Promise<void>;
}

export interface RelayLivenessMonitorDeps {
  probe?: (baseUrl: string) => Promise<boolean>;
  baseUrl?: () => string;
  state?: RelayLivenessPublicStateStore;
  bootstrap?: Pick<
    { get: () => RelayBootstrapPublicState; subscribe: (l: (s: RelayBootstrapPublicState) => void) => () => void },
    'get' | 'subscribe'
  >;
  intervalMs?: number;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export function createRelayLivenessMonitor(deps: RelayLivenessMonitorDeps = {}): RelayLivenessMonitor {
  const probe = deps.probe ?? ((baseUrl: string) => probeRelayReachability(baseUrl));
  const getBaseUrl = deps.baseUrl ?? activeRelayBaseUrl;
  const state = deps.state ?? relayLivenessPublicStateStore;
  const bootstrap = deps.bootstrap ?? relayBootstrapPublicStateStore;
  const intervalMs = deps.intervalMs ?? RELAY_LIVENESS_INTERVAL_MS;
  const setIntervalImpl = deps.setIntervalImpl ?? setInterval;
  const clearIntervalImpl = deps.clearIntervalImpl ?? clearInterval;
  const log =
    deps.log ??
    ((event: string, data?: Record<string, unknown>) =>
      getDebugLogger().info({ domain: 'commercial', event, data: data ?? {} }));

  let timer: ReturnType<typeof setInterval> | null = null;
  let failures = 0;
  let running = false;
  let unsubscribe: (() => void) | null = null;

  const publish = (phase: 'unknown' | 'up' | 'down'): void => {
    if (state.get().phase !== phase) state.set({ phase });
  };
  const stopTimer = (): void => {
    if (timer !== null) {
      clearIntervalImpl(timer);
      timer = null;
    }
  };

  const probeOnce = async (): Promise<void> => {
    // 探之前、探之后都要看：中途离开 ready（账户切换）时，在途结果作废。
    if (bootstrap.get().phase !== 'ready') return;
    let ok = false;
    try {
      ok = await probe(getBaseUrl());
    } catch {
      ok = false;
    }
    if (!running || bootstrap.get().phase !== 'ready') return;
    if (ok) {
      failures = 0;
      publish('up');
    } else {
      failures += 1;
      log('relay.liveness.probe-failed', { failures });
      if (failures >= RELAY_LIVENESS_FAIL_THRESHOLD) publish('down');
    }
  };

  const syncToBootstrap = (phase: RelayBootstrapPublicPhase): void => {
    if (!running) return;
    if (phase === 'ready') {
      if (timer === null) {
        timer = setIntervalImpl(() => void probeOnce(), intervalMs);
        void probeOnce(); // 立刻探第一次，不等到下一个节拍
      }
    } else {
      stopTimer();
      failures = 0;
      publish('unknown');
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      unsubscribe = bootstrap.subscribe((s) => syncToBootstrap(s.phase));
      syncToBootstrap(bootstrap.get().phase);
    },
    stop() {
      running = false;
      stopTimer();
      unsubscribe?.();
      unsubscribe = null;
      failures = 0;
    },
    probeNow: probeOnce,
  };
}

/** 进程级 monitor（`initRelayLiveness` 建、`destroyRelayLiveness` 拆）。 */
let monitor: RelayLivenessMonitor | null = null;
let rendererBridgeReady = false;

/** 主进程启动时调一次（挂在 `main/index.ts` 的 `initUsageReporter()` 旁）。 */
export function initRelayLiveness(): void {
  if (!monitor) {
    monitor = createRelayLivenessMonitor();
    monitor.start();
  }
  if (!rendererBridgeReady) {
    // 与 relay-startup 的桥同一形状：窗口没建时 `sendToWindow` 返回 false、事件丢掉，
    // 渲染层靠 `commercial:relay-liveness-state` 的初读兜底。
    rendererBridgeReady = true;
    relayLivenessPublicStateStore.subscribe((s) => {
      sendToWindow(getMainWindow(), RELAY_LIVENESS_STATE_CHANGED_CHANNEL, s);
    });
  }
}

/** 应用退出时调（挂在 `destroyUsageReporter()` 旁）。 */
export function destroyRelayLiveness(): void {
  monitor?.stop();
  monitor = null;
}

/** [立即重试] 的 IPC 出口：只**请求**，不等它跑完（进度跟状态事件走）。 */
export function probeRelayLivenessNow(): void {
  void monitor?.probeNow();
}
```

- [ ] **Step 4: 跑测试确认通过**：同 Step 2 命令 ⇒ PASS（monitor 7 + 探针 9）。

## 切片 1 · Task 3：IPC + preload + 守卫测试

**Files:**

- Modify: `packages/desktop/src/main/ipc/commercial-handlers.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/preload/index.ts`
- Modify: `packages/desktop/src/preload/clawwork.d.ts`
- Create: `packages/desktop/test/relay-liveness-preload-surface.test.ts`
- Modify: `packages/desktop/test/commercial-preload-surface.test.ts`

- [ ] **Step 1: 写失败测试** `packages/desktop/test/relay-liveness-preload-surface.test.ts`（镜像 `commercial-preload-surface.test.ts` 的三个检查，规模更小）

```ts
import { readFileSync } from 'node:fs';
import { vi, beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { ClawWorkAPI } from '../src/preload/clawwork';

/**
 * relay 存活状态的 **preload 表面**（同 `commercial-preload-surface.test.ts` 的做法）：
 * 源码文本三处同名同通道 + 运行期真载入 + 退订真退。
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

  it('通道名逐字钉住（三处：preload / d.ts 注释不查 / main handlers）', () => {
    for (const channel of [CHANNEL_STATE, CHANNEL_CHANGED, CHANNEL_PROBE]) {
      const mainChannel = channel.replace('commercial:relay-liveness-', 'commercial:relay-liveness-');
      expect(preload).toContain(mainChannel);
    }
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
    unsubscribe();
    renderer.emit(CHANNEL_CHANGED, { phase: 'up', updatedAt: 2 });
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**：`pnpm --filter @clawwork/desktop exec vitest run test/relay-liveness-preload-surface.test.ts` ⇒ FAIL。

- [ ] **Step 3: main handlers**：`commercial-handlers.ts` 顶部 import 区加：

```ts
import { relayLivenessPublicStateStore } from '@clawwork/shared';
import { probeRelayLivenessNow } from '../commercial/relay-liveness.js';
```

在 `commercial:relay-bootstrap-retry`（`:182-185`）**之后**加：

```ts
/**
 * relay **运行期存活**的快照（初读）与手动探（[立即重试]）。
 * 与 bootstrap 那对的分工相同：事件只覆盖"挂上之后"，初读补"挂上之前"。
 */
ipcMain.handle('commercial:relay-liveness-state', () => ({
  ok: true,
  result: relayLivenessPublicStateStore.get(),
}));
ipcMain.handle('commercial:relay-liveness-probe', () => {
  probeRelayLivenessNow();
  return { ok: true };
});
```

- [ ] **Step 4: 生命周期**：`main/index.ts` — `:41` 的 `import { initUsageReporter, destroyUsageReporter } from './commercial/usage-reporter.js';` 下一行加：

```ts
import { initRelayLiveness, destroyRelayLiveness } from './commercial/relay-liveness.js';
```

`:577` `initUsageReporter();` 下一行加：

```ts
initRelayLiveness();
```

`:634` `destroyUsageReporter();` 下一行加：

```ts
destroyRelayLiveness();
```

- [ ] **Step 5: preload**：`preload/index.ts` — `commercialRelayBootstrapRetry`（`:642`）之后加：

```ts
    // ── relay 运行期存活（ready 之后的"还在不在"）────────────────────────
    // 与上面那对同纪律：初读补"挂上之前"、事件覆盖"挂上之后"（按 updatedAt 取舍）。
    commercialRelayLivenessState: () => ipcRenderer.invoke('commercial:relay-liveness-state'),
    onCommercialRelayLivenessState: (callback: (state: RelayLivenessPublicState) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: RelayLivenessPublicState): void => {
        callback(state);
      };
      ipcRenderer.on('commercial:relay-liveness-state-changed', listener);
      return () => {
        ipcRenderer.removeListener('commercial:relay-liveness-state-changed', listener);
      };
    },
    commercialRelayLivenessProbe: () => ipcRenderer.invoke('commercial:relay-liveness-probe'),
```

并在文件顶部 shared 类型 import 列表（`:22` 一带）加 `RelayLivenessPublicState`。

- [ ] **Step 6: d.ts**：`clawwork.d.ts` — `:912` `commercialRelayBootstrapRetry` 声明之后加：

```ts
  /**
   * relay **运行期存活**（无密 DTO，定义在 `@clawwork/shared`）。与 bootstrap 那对同纪律：
   * `commercialRelayLivenessState()` 初读、`onCommercialRelayLivenessState(cb)` 订阅
   * （返回退订）、`commercialRelayLivenessProbe()` 请求立刻探一次（不等结果，进度跟事件走）。
   */
  commercialRelayLivenessState: () => Promise<IpcResult<RelayLivenessPublicState>>;
  onCommercialRelayLivenessState: (callback: (state: RelayLivenessPublicState) => void) => () => void;
  commercialRelayLivenessProbe: () => Promise<IpcResult>;
```

顶部 import type 列表加 `RelayLivenessPublicState`。

- [ ] **Step 7: 更新两条既有守卫**：`commercial-preload-surface.test.ts`：
  - `:110-113` 闭集断言改为：

```ts
expect([...new Set(found)].sort()).toEqual([
  'commercialRelayBootstrapRetry',
  'commercialRelayBootstrapState',
  'commercialRelayLivenessProbe',
  'commercialRelayLivenessState',
]);
```

- `:155-159` `GUARDED_VALUE_EXPORTS` 改为：

```ts
const GUARDED_VALUE_EXPORTS = [
  'createRelayBootstrapPublicStateStore',
  'relayBootstrapPublicStateStore',
  'resetRelayBootstrapPublicState',
  'createRelayLivenessPublicStateStore',
  'relayLivenessPublicStateStore',
];
```

- [ ] **Step 8: 跑表面测试**：`pnpm --filter @clawwork/desktop exec vitest run test/relay-liveness-preload-surface.test.ts test/commercial-preload-surface.test.ts` ⇒ PASS。

## 切片 1 · Task 4：渲染层判据 + 横幅 + 挂载 + i18n

**Files:**

- Create: `packages/desktop/src/renderer/lib/relay-connection-notice.ts`
- Create: `packages/desktop/test/relay-connection-notice.test.ts`
- Create: `packages/desktop/src/renderer/components/RelayConnectionBanner.tsx`
- Create: `packages/desktop/test/relay-connection-banner.test.tsx`
- Modify: `packages/desktop/src/renderer/layouts/MainArea/index.tsx`
- Modify: 9 × locale json

- [ ] **Step 1: 写失败测试** `packages/desktop/test/relay-connection-notice.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { deriveRelayConnectionNotice } from '../src/renderer/lib/relay-connection-notice.js';
import type { RelayLivenessPublicState } from '@clawwork/shared';

describe('deriveRelayConnectionNotice', () => {
  it.each([
    [{ phase: 'down', updatedAt: 2 } as RelayLivenessPublicState, 'connection.relayUnreachable'],
    [{ phase: 'up', updatedAt: 3 } as RelayLivenessPublicState, null],
    [{ phase: 'unknown', updatedAt: 4 } as RelayLivenessPublicState, null],
    [null, null],
    [undefined, null],
  ])('%o ⇒ %s', (liveness, expected) => {
    const notice = deriveRelayConnectionNotice({ liveness });
    expect(notice?.textKey ?? null).toBe(expected);
  });
});
```

- [ ] **Step 2: 跑失败** ⇒ FAIL。

- [ ] **Step 3: 实现判据** `packages/desktop/src/renderer/lib/relay-connection-notice.ts`

```ts
import type { RelayLivenessPublicState } from '@clawwork/shared';

/**
 * relay 存活状态 → 横幅该不该出现、说哪句话（纯函数，组件只渲染）。
 *
 * 只有 `down` 出横幅：`unknown`＝还没结论 / 不在探活窗口（启动期有自己的表达），
 * `up`＝一切正常。与 gateway 横幅同一条纪律：**"不知道"不许说成"断了"**。
 */
export interface RelayConnectionNotice {
  textKey: 'connection.relayUnreachable';
}

export function deriveRelayConnectionNotice(input: {
  liveness: RelayLivenessPublicState | null | undefined;
}): RelayConnectionNotice | null {
  return input.liveness?.phase === 'down' ? { textKey: 'connection.relayUnreachable' } : null;
}
```

- [ ] **Step 4: 跑通过**。然后写组件测试 `test/relay-connection-banner.test.tsx`：

```tsx
// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import RelayConnectionBanner from '../src/renderer/components/RelayConnectionBanner';
import type { RelayLivenessPublicState } from '@clawwork/shared';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let emit: ((state: RelayLivenessPublicState) => void) | null;
let unsubscribe: ReturnType<typeof vi.fn>;
let probe: ReturnType<typeof vi.fn>;

function mount(): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render((<RelayConnectionBanner />) as ReactElement));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const flush = () => act(async () => {});

describe('RelayConnectionBanner', () => {
  beforeEach(() => {
    emit = null;
    unsubscribe = vi.fn();
    probe = vi.fn(async () => ({ ok: true }));
    Object.assign(window, {
      clawwork: {
        onCommercialRelayLivenessState: (cb: (s: RelayLivenessPublicState) => void) => {
          emit = cb;
          return unsubscribe;
        },
        commercialRelayLivenessState: async () => ({ ok: true, result: { phase: 'unknown', updatedAt: 1 } }),
        commercialRelayLivenessProbe: probe,
      },
    });
  });
  afterEach(() => vi.clearAllMocks());

  it('初读 unknown ⇒ 什么都不显示', async () => {
    const { container, unmount } = mount();
    await flush();
    expect(container.textContent).toBe('');
    unmount();
  });

  it('⭐ down ⇒ 出横幅 + [立即重试] 真的请求探测', async () => {
    const { container, unmount } = mount();
    await flush();
    await act(async () => emit?.({ phase: 'down', updatedAt: 2 }));
    expect(container.textContent).toContain('connection.relayUnreachable');
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('connection.retryNow'));
    expect(retry, '断线必须有出口').toBeTruthy();
    act(() => retry?.click());
    expect(probe).toHaveBeenCalled();
    unmount();
  });

  it('⭐ 恢复（up）⇒ 横幅静默消失', async () => {
    const { container, unmount } = mount();
    await flush();
    await act(async () => emit?.({ phase: 'down', updatedAt: 2 }));
    expect(container.textContent).not.toBe('');
    await act(async () => emit?.({ phase: 'up', updatedAt: 3 }));
    expect(container.textContent).toBe('');
    unmount();
  });

  it('⭐ 晚到的旧事件不许覆盖更新的结论（按 updatedAt 取舍）', async () => {
    const { container, unmount } = mount();
    await flush();
    await act(async () => emit?.({ phase: 'up', updatedAt: 9 }));
    await act(async () => emit?.({ phase: 'down', updatedAt: 5 }));
    expect(container.textContent, 'updatedAt=5 比手头的 9 旧，不许翻回去').toBe('');
    unmount();
  });

  it('卸载时退订（返回的退订函数真的被调）', async () => {
    const { unmount } = mount();
    await flush();
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: 写组件实现** `packages/desktop/src/renderer/components/RelayConnectionBanner.tsx`

```tsx
import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { RelayLivenessPublicState } from '@clawwork/shared';
import InlineNotice from '@/components/semantic/InlineNotice';
import ToolbarButton from '@/components/semantic/ToolbarButton';
import { deriveRelayConnectionNotice } from '@/lib/relay-connection-notice';

/**
 * relay（商业服务）**运行期断开**的横幅（2026-10-03 真机缺口：杀了 8791 工作台无感）。
 *
 * ⚠️ 刻意**不锁输入框**：缺口在"无感"，不在"可用"——本地功能（历史 / 文件）照用，
 *    发送失败时既有错误路径照旧。与网关横幅的分工：那条断=全停（所以离线只读），
 *    这条断=模型调用会失败（所以只明示 + 给重试）。
 * 事件纪律与 `useStartupReadiness` 的 relay 订阅完全一致：先订阅、后补读、按
 * `updatedAt` 取舍（晚到的旧结论不许翻回来）。
 */
function useRelayLiveness(): RelayLivenessPublicState | null {
  const [state, setState] = useState<RelayLivenessPublicState | null>(null);
  useEffect(() => {
    const api = window.clawwork;
    if (typeof api?.onCommercialRelayLivenessState !== 'function') return;
    let active = true;
    const accept = (next: RelayLivenessPublicState): void => {
      setState((current) => (current && current.updatedAt >= next.updatedAt ? current : next));
    };
    const unsubscribe = api.onCommercialRelayLivenessState((next) => {
      if (active) accept(next);
    });
    void api
      .commercialRelayLivenessState()
      .then((result) => {
        if (!active) return;
        if (result?.ok && result.result) accept(result.result);
      })
      .catch(() => {
        // 读不到 = 没有结论，什么都不改。
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return state;
}

export default function RelayConnectionBanner() {
  const { t } = useTranslation();
  const liveness = useRelayLiveness();
  const notice = deriveRelayConnectionNotice({ liveness });
  if (!notice) return null;
  return (
    <div className="px-4 pt-2">
      <InlineNotice
        tone="warning"
        action={
          <ToolbarButton
            size="sm"
            variant="outline"
            onClick={() => void window.clawwork.commercialRelayLivenessProbe()}
          >
            {t('connection.retryNow')}
          </ToolbarButton>
        }
      >
        <span className="inline-flex items-center gap-2">
          <AlertTriangle size={13} className="flex-shrink-0" />
          {t(notice.textKey)}
        </span>
      </InlineNotice>
    </div>
  );
}
```

- [ ] **Step 6: 挂载**：`MainArea/index.tsx` — `:2` `import ConnectionBanner from '@/components/ConnectionBanner';` 下一行加 `import RelayConnectionBanner from '@/components/RelayConnectionBanner';`；`:1388` `<ConnectionBanner />` 下一行加 `<RelayConnectionBanner />`。

- [ ] **Step 7: i18n**：9 个 locale 的 `connection` 对象各加一键（插在字母序 `reconnected`/`reconnecting` 一带）：

| locale | `relayUnreachable`                                                                                                         |
| ------ | -------------------------------------------------------------------------------------------------------------------------- |
| zh     | 商业服务连接异常 —— 模型调用可能失败，正在自动重试…                                                                        |
| zh-TW  | 商業服務連線異常 —— 模型呼叫可能失敗，正在自動重試…                                                                        |
| en     | Commercial service connection is failing — model calls may fail; retrying automatically…                                   |
| ja     | コマーシャルサービスに接続できません。モデル呼び出しが失敗する可能性があります。自動で再試行しています…                    |
| ko     | 상용 서비스 연결에 문제가 있습니다. 모델 호출이 실패할 수 있으며 자동으로 재시도 중입니다…                                 |
| de     | Verbindung zum kommerziellen Dienst gestört – Modellaufrufe können fehlschlagen. Automatischer Wiederholungsversuch läuft… |
| fr     | Connexion au service commercial en échec — les appels de modèle peuvent échouer. Nouvelle tentative automatique…           |
| es     | Conexión al servicio comercial con problemas: las llamadas al modelo pueden fallar. Reintentando automáticamente…          |
| pt     | Falha na conexão com o serviço comercial — chamadas de modelo podem falhar. Tentando novamente automaticamente…            |

- [ ] **Step 8: 跑渲染测试 + i18n 检查**：`pnpm --filter @clawwork/desktop exec vitest run test/relay-connection-notice.test.ts test/relay-connection-banner.test.tsx` ⇒ PASS；`pnpm check:i18n` ⇒ PASS。

## 切片 1 · Task 5：门禁 + 提交

- [ ] **Step 1: 回归族**：`pnpm --filter @clawwork/desktop exec vitest run test/relay-bootstrap.test.ts test/relay-bundled-search.test.ts test/relay-bundled-search-runtime.integration.test.ts test/relay-cleanup.test.ts test/relay-config.test.ts test/relay-endpoint.test.ts test/relay-entitlement-flow.test.tsx test/relay-media-config.test.ts test/relay-search-preference.test.ts test/relay-search-wiring.test.ts test/relay-startup.test.ts test/relay-liveness.test.ts test/relay-liveness-preload-surface.test.ts test/relay-connection-notice.test.ts test/relay-connection-banner.test.tsx test/connection-banner.test.tsx test/commercial-preload-surface.test.ts test/startup-readiness.test.ts test/entry-preparation.test.tsx` ⇒ 全 PASS（个别文件名若不存在则去掉该项并在提交信息里如实标注）。再跑 shared：`pnpm --filter @clawwork/shared exec vitest run test/relay-liveness-state.test.ts test/commercial-relay-state.test.ts`。
- [ ] **Step 2: 门禁**：`pnpm typecheck && pnpm typecheck:tests` ⇒ RC=0；`pnpm format:check` ⇒ RC=0（红了先 `pnpm exec prettier --write <改动文件>`）；`pnpm lint` ⇒ RC=0；`pnpm check:architecture && pnpm check:ui-contract && pnpm check:renderer-copy && pnpm check:i18n` ⇒ 全 RC=0。
- [ ] **Step 3: 提交（只 add 本刀文件）**：`git add` 以下逐一点名（不动 codex WIP）：

```
packages/shared/src/relay-liveness-state.ts
packages/shared/src/index.ts
packages/shared/test/relay-liveness-state.test.ts
packages/desktop/src/main/commercial/relay-liveness.ts
packages/desktop/test/relay-liveness.test.ts
packages/desktop/src/main/ipc/commercial-handlers.ts
packages/desktop/src/main/index.ts
packages/desktop/src/preload/index.ts
packages/desktop/src/preload/clawwork.d.ts
packages/desktop/test/relay-liveness-preload-surface.test.ts
packages/desktop/test/commercial-preload-surface.test.ts
packages/desktop/src/renderer/lib/relay-connection-notice.ts
packages/desktop/test/relay-connection-notice.test.ts
packages/desktop/src/renderer/components/RelayConnectionBanner.tsx
packages/desktop/test/relay-connection-banner.test.tsx
packages/desktop/src/renderer/layouts/MainArea/index.tsx
packages/desktop/src/renderer/i18n/locales/zh.json
packages/desktop/src/renderer/i18n/locales/zh-TW.json
packages/desktop/src/renderer/i18n/locales/en.json
packages/desktop/src/renderer/i18n/locales/ja.json
packages/desktop/src/renderer/i18n/locales/ko.json
packages/desktop/src/renderer/i18n/locales/de.json
packages/desktop/src/renderer/i18n/locales/fr.json
packages/desktop/src/renderer/i18n/locales/es.json
packages/desktop/src/renderer/i18n/locales/pt.json
```

⚠️ `preload/index.ts`、`clawwork.d.ts`、`MainArea/index.tsx`、`commercial-handlers.ts` 可能同时被 codex WIP 碰过——`git add <file>` 会把**该文件全部改动**（含别人未提交的）一起带上。提交前先 `git diff <file>` 逐个看：若含与本刀无关的改动，先只提交我改的 hunk（`git add -p` 不可交互 → 改用：把无关 hunk 先 `git diff > /tmp/x.patch` 存档后逐 hunk 处理，或与用户的"不吞并 WIP"纪律一致地**暂缓该文件**并报告）。按惯例：这些文件本会话先前已提交过我们的改动（文件已在版本库），diff 里出现 codex 新 WIP 就说一声、该文件改用最小 hunk 提交。

提交信息：

```
feat(relay): 运行期探活 + 命名横幅，中转断开不再无感

2026-10-03 真机：杀 relay(8791) 后工作台无感（对照 gateway 已有命名横幅）。
补 30s 周期探活（无鉴权 GET /v1/catalog：2xx/4xx=活、5xx/超时/拒连=断），
两连败才判 down、一胜即 up；新公开状态走与 bootstrap 同纪律的小通道
（updatedAt 单调、先订阅后补读、字段闭集）；workbench 出命名横幅 + [立即重试]，
不锁输入框（缺口在无感不在可用）。含 shared store / monitor / IPC / preload /
纯判据 / 横幅 / 九语言 + 各自钉子测试。

Co-Authored-By: Claude Code <noreply@anthropic.com>
```

- [ ] **Step 4: 提交后复议**：`git show --stat HEAD` 文件清单与本刀一致；`git log -1 --format=%H` 记下尖端；逐文件 `git show HEAD:<file> | sha256sum` 与工作树 `sha256sum <file>` 对拍一致（钩子可能在 add/commit 间改内容）。

---

## 切片 2 · Task 6：主进程启动通知记录 + IPC

**Files:**

- Create: `packages/desktop/src/main/workspace/startup-notice.ts`
- Create: `packages/desktop/test/workspace-startup-notice.test.ts`
- Modify: `packages/desktop/src/main/workspace/startup.ts`
- Modify: `packages/desktop/src/main/ipc/workspace-handlers.ts`
- Modify: `packages/desktop/src/preload/index.ts`、`packages/desktop/src/preload/clawwork.d.ts`

- [ ] **Step 1: 写失败测试** `packages/desktop/test/workspace-startup-notice.test.ts`

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearWorkspaceStartupNotice,
  readWorkspaceStartupNotice,
  recordWorkspaceStartupDecision,
} from '../src/main/workspace/startup-notice.js';

describe('workspace 启动通知', () => {
  beforeEach(() => clearWorkspaceStartupNotice());

  it('⭐ 只有 recreated 出通知', () => {
    recordWorkspaceStartupDecision({ kind: 'recreated', path: 'C:\\ws' }, 100);
    expect(readWorkspaceStartupNotice()).toEqual({ kind: 'recreated', path: 'C:\\ws', at: 100 });
  });

  it.each([
    [{ kind: 'configured', path: 'C:\\ws' }],
    [
      {
        kind: 'healed',
        path: 'E:\\ws',
        from: 'F:\\ws',
        via: { path: 'E:\\ws', origin: 'same-letter', evidence: 'volume-marker' },
      },
    ],
    [{ kind: 'auto-portable', path: 'E:\\ws', volumeRoot: 'E:\\' }],
    [{ kind: 'default', path: 'C:\\h' }],
    [{ kind: 'ask-user', recordedPath: 'E:\\ws', candidates: [] }],
  ] as const)('其余 kind（%o）⇒ null', (decision) => {
    recordWorkspaceStartupDecision(decision as never, 100);
    expect(readWorkspaceStartupNotice()).toBeNull();
  });

  it('重记会覆盖；clear 清空（切工作区后旧通知不许挂着）', () => {
    recordWorkspaceStartupDecision({ kind: 'recreated', path: 'C:\\a' }, 1);
    recordWorkspaceStartupDecision({ kind: 'default', path: 'C:\\b' }, 2);
    expect(readWorkspaceStartupNotice()).toBeNull();
    recordWorkspaceStartupDecision({ kind: 'recreated', path: 'C:\\c' }, 3);
    clearWorkspaceStartupNotice();
    expect(readWorkspaceStartupNotice()).toBeNull();
  });
});
```

- [ ] **Step 2: 跑失败** ⇒ FAIL。

- [ ] **Step 3: 实现** `packages/desktop/src/main/workspace/startup-notice.ts`

```ts
import type { WorkspaceStartupDecision } from './portable.js';

/**
 * 「这次启动把工作区**重建**过」这条结论的**可读记录**（渲染层用它做非阻断告知）。
 *
 * ## 边界（教义照抄 `portable.ts`，别扩大）
 *
 * - 只有 `recreated`（本机目录被删、卷还在）出通知；`healed` 是"找回了原工作区"
 *   （数据完好，刻意静默）、`ask-user` 自己会弹框、`auto-portable`/`default` 是首启
 *   ——一律 `null`。
 * - **不改行为**：重建照旧、不阻断、绝不改成选盘对话框。
 * - 生命周期 = 一次启动：条件天然只存活这一轮（重建后的目录下次启动就"存在"了）；
 *   用户在设置里切换工作区 ⇒ `clear`（`workspace:setup` / `workspace:change` 两处）。
 */
export interface WorkspaceStartupNotice {
  kind: 'recreated';
  path: string;
  at: number;
}

let current: WorkspaceStartupNotice | null = null;

export function recordWorkspaceStartupDecision(decision: WorkspaceStartupDecision, now = Date.now()): void {
  current = decision.kind === 'recreated' ? { kind: 'recreated', path: decision.path, at: now } : null;
}

export function readWorkspaceStartupNotice(): WorkspaceStartupNotice | null {
  return current;
}

export function clearWorkspaceStartupNotice(): void {
  current = null;
}
```

- [ ] **Step 4: 接进启动路径**：`startup.ts` — `ctx.log('workspace.startup.decision', { kind: decision.kind });`（`:252`）**下一行**加：

```ts
// 只记"重建过"这一条（渲染层做非阻断告知；其余 kind 见 startup-notice.ts 的边界）。
recordWorkspaceStartupDecision(decision);
```

文件顶部 import 区加 `import { recordWorkspaceStartupDecision } from './startup-notice.js';`。

- [ ] **Step 5: IPC**：`workspace-handlers.ts` — import 区加 `import { clearWorkspaceStartupNotice, readWorkspaceStartupNotice } from '../workspace/startup-notice.js';`；在 `workspace:setup`（`:110`）与 `workspace:change`（`:125`）两个 handler **开头**各加 `clearWorkspaceStartupNotice();`；在 `workspace:fs-identity`（`:170`）**之前**加：

```ts
/**
 * 启动时的"工作区被重建"通知（`null` = 没有这回事）。
 * 只读；不带路径以外的任何东西。
 */
ipcMain.handle('workspace:startup-notice', () => ({ ok: true, result: readWorkspaceStartupNotice() }));
```

- [ ] **Step 6: preload + d.ts**：`preload/index.ts` workspace 段（`workspaceTeamPath` 一带）加：

```ts
    workspaceStartupNotice: () => ipcRenderer.invoke('workspace:startup-notice'),
```

`clawwork.d.ts` workspace 段对应加：

```ts
workspaceStartupNotice: () => Promise<IpcResult<{ kind: 'recreated'; path: string; at: number } | null>>;
```

- [ ] **Step 7: 跑测试** ⇒ `pnpm --filter @clawwork/desktop exec vitest run test/workspace-startup-notice.test.ts` PASS。

## 切片 2 · Task 7：渲染层组件 + 两处挂载 + i18n

**Files:**

- Create: `packages/desktop/src/renderer/components/WorkspaceRecreatedNotice.tsx`
- Create: `packages/desktop/test/workspace-recreated-notice.test.tsx`
- Modify: `packages/desktop/src/renderer/layouts/EntryPreparation/index.tsx`、`MainArea/index.tsx`、9 locale json

- [ ] **Step 1: 写失败测试** `packages/desktop/test/workspace-recreated-notice.test.tsx`

```tsx
// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import WorkspaceRecreatedNotice, {
  resetWorkspaceNoticeForTest,
} from '../src/renderer/components/WorkspaceRecreatedNotice';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let setSettingsSection: ReturnType<typeof vi.fn>;
let setSettingsOpen: ReturnType<typeof vi.fn>;
let noticeResult: unknown;

function mount(): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render((<WorkspaceRecreatedNotice />) as ReactElement));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}
const flush = () => act(async () => {});

describe('WorkspaceRecreatedNotice', () => {
  beforeEach(() => {
    resetWorkspaceNoticeForTest();
    setSettingsSection = vi.fn();
    setSettingsOpen = vi.fn();
    noticeResult = null;
    Object.assign(window, {
      clawwork: { workspaceStartupNotice: async () => ({ ok: true, result: noticeResult }) },
    });
  });

  it('没有通知 ⇒ 什么都不渲染', async () => {
    const { container, unmount } = mount();
    await flush();
    expect(container.textContent).toBe('');
    unmount();
  });

  it('⭐ recreated ⇒ 出告知 + 两个出口（去设置 / 知道了）', async () => {
    noticeResult = { kind: 'recreated', path: 'C:\\ws', at: 1 };
    const { container, unmount } = mount();
    await flush();
    expect(container.textContent).toContain('workspaceNotice.recreated');
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(buttons.some((t) => t.includes('workspaceNotice.openSettings'))).toBe(true);
    expect(buttons.some((t) => t.includes('workspaceNotice.dismiss'))).toBe(true);
    unmount();
  });

  it('⭐ [知道了] 之后本次会话不再出现（重挂载也不许回来）', async () => {
    noticeResult = { kind: 'recreated', path: 'C:\\ws', at: 1 };
    const first = mount();
    await flush();
    const dismiss = [...first.container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('workspaceNotice.dismiss'),
    );
    act(() => dismiss?.click());
    expect(first.container.textContent).toBe('');
    first.unmount();

    const second = mount();
    await flush();
    expect(second.container.textContent, '同一会话里的另一个挂点不许重新冒出来').toBe('');
    second.unmount();
  });

  it('[打开工作区设置] 打开设置的系统页', async () => {
    noticeResult = { kind: 'recreated', path: 'C:\\ws', at: 1 };
    const { container, unmount } = mount();
    await flush();
    const open = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('workspaceNotice.openSettings'),
    );
    act(() => open?.click());
    expect(setSettingsSection).toHaveBeenCalledWith('system');
    expect(setSettingsOpen).toHaveBeenCalledWith(true);
    unmount();
  });
});
```

- [ ] **Step 2: 跑失败** ⇒ FAIL。

- [ ] **Step 3: 实现组件** `packages/desktop/src/renderer/components/WorkspaceRecreatedNotice.tsx`

```tsx
import { useEffect, useState } from 'react';
import { FolderWarning } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import InlineNotice from '@/components/semantic/InlineNotice';
import ToolbarButton from '@/components/semantic/ToolbarButton';
import { useUiStore } from '@/stores/uiStore';

/**
 * 「原工作区目录不存在、已新建空工作区」的**非阻断告知**（2026-10-03 真机缺口：
 * 断盘模拟后 `kind:"recreated"` 静默重建，就绪页/工作台零告知）。
 *
 * ⚠️ 行为边界（教义，抄 `portable.ts` / `startup-notice.ts`）：只告知，**不阻断**、
 *    不弹框、绝不把"本机目录被删"改成"问用户选盘"——那是便携形态另一条分支的事。
 * ⚠️「知道了」是**会话级**（模块变量）：就绪页与工作台欢迎屏是两个挂点，
 *    用户在任一处关掉，另一处也不许再冒出来；条件本身只存活这一轮启动，
 *    所以不需要落盘。
 */
let dismissedThisSession = false;

/** 测试用：会话内关闭标记复位。 */
export function resetWorkspaceNoticeForTest(): void {
  dismissedThisSession = false;
}

interface WorkspaceRecreatedNoticePayload {
  kind: 'recreated';
  path: string;
  at: number;
}

function useWorkspaceRecreatedNotice(): WorkspaceRecreatedNoticePayload | null {
  const [notice, setNotice] = useState<WorkspaceRecreatedNoticePayload | null>(null);
  useEffect(() => {
    if (dismissedThisSession) return;
    let active = true;
    void Promise.resolve(window.clawwork?.workspaceStartupNotice?.())
      .then((result) => {
        if (!active || dismissedThisSession) return;
        if (result?.ok && result.result?.kind === 'recreated') setNotice(result.result);
      })
      .catch(() => {
        // 问不出来 = 没有结论，什么都不说。
      });
    return () => {
      active = false;
    };
  }, []);
  return notice;
}

export default function WorkspaceRecreatedNotice() {
  const { t } = useTranslation();
  const setSettingsSection = useUiStore((s) => s.setSettingsSection);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const notice = useWorkspaceRecreatedNotice();
  if (!notice) return null;
  const dismiss = (): void => {
    dismissedThisSession = true;
    window.dispatchEvent(new CustomEvent('workspace-notice-dismissed'));
  };
  return (
    <div className="px-4 pt-2">
      <InlineNotice
        tone="warning"
        action={
          <div className="flex items-center gap-2">
            <ToolbarButton
              size="sm"
              variant="outline"
              onClick={() => {
                setSettingsSection('system');
                setSettingsOpen(true);
              }}
            >
              {t('workspaceNotice.openSettings')}
            </ToolbarButton>
            <ToolbarButton size="sm" variant="ghost" onClick={dismiss}>
              {t('workspaceNotice.dismiss')}
            </ToolbarButton>
          </div>
        }
      >
        <span className="inline-flex items-center gap-2">
          <FolderWarning size={13} className="flex-shrink-0" />
          {t('workspaceNotice.recreated')}
        </span>
      </InlineNotice>
    </div>
  );
}
```

⚠️ 实现细节：`dismiss` 之后本组件要消失——把 `notice` 存进 state，dismiss 时同时 `setNotice(null)`；上面那段用 CustomEvent 是为了**同页另一挂点**也不复活：两个挂点通常不同屏（就绪页 vs 工作台），模块变量已够；把 dismiss 写成：

```tsx
const dismiss = (): void => {
  dismissedThisSession = true;
  setNotice(null);
};
```

（`setNotice` 用 `useState` 的 setter；`useWorkspaceRecreatedNotice` 需要把 setter 一并返回，或把 dismiss 逻辑并入该 hook —— 实现时二者取一，测试钉的行为不变。）

- [ ] **Step 4: 挂载两处**：
  - `EntryPreparation/index.tsx`：状态行 `<div role={failure ? 'alert' : 'status'}` 块（`:161-168`）**之后**、按钮组之前加：

```tsx
<WorkspaceRecreatedNotice />
```

顶部 import 加 `import WorkspaceRecreatedNotice from '@/components/WorkspaceRecreatedNotice';`。

- `MainArea/index.tsx` 欢迎屏分支（`:1024`）`{!startupReadiness.isReady && <StartupReadinessPanel … />}` **下一行**加：

```tsx
<WorkspaceRecreatedNotice />
```

- [ ] **Step 5: i18n**：9 个 locale 顶层各加一个 `workspaceNotice` 段（3 键）：

| locale | recreated                                                                                                                                                                                                                          | openSettings                              | dismiss    |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------- |
| zh     | 原工作区目录不存在（可能已被移动或删除），已在本机新建空工作区。如需找回旧数据：请检查原目录，或切换工作区。                                                                                                                       | 打开工作区设置                            | 知道了     |
| zh-TW  | 原工作區目錄不存在（可能已被移動或刪除），已在本機新建空白工作區。如需找回舊資料：請檢查原目錄，或切換工作區。                                                                                                                     | 開啟工作區設定                            | 知道了     |
| en     | The original workspace folder no longer exists (it may have been moved or deleted), so a new empty workspace was created. To recover old data: check the original folder or switch workspaces.                                     | Open workspace settings                   | Got it     |
| ja     | 元のワークスペースフォルダーが存在しないため（移動または削除された可能性があります）、新しい空のワークスペースを作成しました。以前のデータを復元するには、元のフォルダーを確認するかワークスペースを切り替えてください。           | ワークスペース設定を開く                  | 了解       |
| ko     | 원래 작업 공간 폴더가 없어져(이동 또는 삭제됨) 새 빈 작업 공간을 만들었습니다. 이전 데이터를 복구하려면 원래 폴더를 확인하거나 작업 공간을 전환하세요.                                                                             | 작업 공간 설정 열기                       | 확인       |
| de     | Der ursprüngliche Arbeitsbereichsordner existiert nicht mehr (verschoben oder gelöscht) – ein neuer leerer Arbeitsbereich wurde erstellt. Um alte Daten wiederzufinden: ursprünglichen Ordner prüfen oder Arbeitsbereich wechseln. | Arbeitsbereich-Einstellungen öffnen       | Verstanden |
| fr     | Le dossier d'espace de travail d'origine n'existe plus (déplacé ou supprimé) ; un nouvel espace vide a été créé. Pour retrouver les anciennes données : vérifiez le dossier d'origine ou changez d'espace de travail.              | Ouvrir les paramètres d'espace de travail | Compris    |
| es     | La carpeta de espacio de trabajo original ya no existe (pudo moverse o eliminarse), así que se creó uno nuevo vacío. Para recuperar datos antiguos: revisa la carpeta original o cambia de espacio de trabajo.                     | Abrir ajustes de espacio de trabajo       | Entendido  |
| pt     | A pasta do espaço de trabalho original não existe mais (pode ter sido movida ou excluída), então um novo espaço vazio foi criado. Para recuperar dados antigos: verifique a pasta original ou troque de espaço de trabalho.        | Abrir configurações do espaço de trabalho | Entendi    |

- [ ] **Step 6: 跑渲染测试 + i18n**：`pnpm --filter @clawwork/desktop exec vitest run test/workspace-recreated-notice.test.tsx` ⇒ PASS；`pnpm check:i18n` ⇒ PASS。

## 切片 2 · Task 8：门禁 + 提交

- [ ] **Step 1: 回归族**：`pnpm --filter @clawwork/desktop exec vitest run test/workspace-startup-notice.test.ts test/workspace-recreated-notice.test.tsx` + 与 workspace/startup 相关的既有族（`ls test | grep -i "workspace\|startup"` 查全，逐个跑）⇒ 全 PASS。
- [ ] **Step 2: 门禁**：同切片 1 的四件套 + typecheck×2 + format:check + lint ⇒ 全 RC=0。
- [ ] **Step 3: 提交（只 add 本刀文件）**：逐一点名（本刀文件清单见文件地图；同样先 `git diff` 检查共享文件有没有混入 codex WIP）。提交信息：

```
feat(workspace): 工作区被重建时给出非阻断告知，不再静默

2026-10-03 真机：断盘模拟（本机目录被删）触发 kind:"recreated" 就静默重建空工作区，
就绪页/工作台零告知。记录该决策（只映射 recreated）、新 workspace:startup-notice IPC、
就绪页 + 工作台欢迎屏两处 warning 内联条（[打开工作区设置] / [知道了]，会话级关闭）。
行为不动：重建照旧、不阻断、不弹框（教义见 portable.ts）。

Co-Authored-By: Claude Code <noreply@anthropic.com>
```

- [ ] **Step 4: 提交后复议**：同切片 1 Task 5 Step 4。

---

## 收尾（两刀都落地后）

- [ ] 真机验收（需候选包）：按 spec §6 的验收步骤执行（①杀 relay ≤90s 出横幅；②删工作区目录重启出告知）——**属于后续"重出候选"批次**，本计划不含真机执行。
- [ ] 交接记录：把两刀尖端记入 `CLAUDE-9H-QUEUE-20261003.md` 换班段落 + resume-here 记忆。

## Self-Review 记录（写完即查）

1. **Spec coverage**：spec §2 探活/通道/渲染 → Task 1-4；§3 记录/IPC/组件/两挂点 → Task 6-7；§4 边界 → 实现注释 + 测试（闭集/吞错/九语言）；§5 测试计划 → 各 Task 的测试步；§6 切片与验收 → Task 5/8 + 收尾。无缺口。
2. **Placeholder scan**：无 TBD/TODO；Task 7 Step 3 有一处**显式说明的取舍**（dismiss 的 setter 归属），给了两个等价实现且测试不变——属于实现自由度，不是占位。
3. **Type consistency**：`RelayLivenessPublicState{phase,updatedAt}` / `createRelayLivenessPublicStateStore` / `probeRelayReachability` / `createRelayLivenessMonitor` / `probeRelayLivenessNow` / `WorkspaceStartupNotice` / `recordWorkspaceStartupDecision` 在定义与使用处同名同形；通道名三处一致（`commercial:relay-liveness-state` / `-state-changed` / `-probe`）。
