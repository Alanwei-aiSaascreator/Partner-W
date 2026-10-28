/**
 * 启动期「库 → `MEMORY.md`」同步的**连接竞态**（2026-10-17 实机取证）。
 *
 * 现场证据：三次冷启动（盘符 S→U→V）日志逐字相同 ——
 *
 * ```
 * [error] gateway.req.rejected.not-connected { data: { method: 'agents.list' } }
 * [info]  memory.startup-sync { data: { ok: false, reason: 'list-failed' } }
 * ```
 *
 * `kickMemoryInjection()` 在 `app.whenReady()` 里**不等连接**就发 `agents.list`，
 * 而 WS 握手要晚几百毫秒 ⇒ 每次都撞上 `GATEWAY_NOT_CONNECTED`。
 * 同一个函数里另外两个注入（能力边界 / 记忆契约）都带 5/15/30s 退避，
 * **唯独真正写记忆的这一跳没有** ⇒ 用户已确认的记忆在每次冷启动都没投影进
 * 助手的 `MEMORY.md`（等于这一轮助手读不到记忆），只能等下一次改动才补。
 *
 * 这里钉的就是：那一跳必须**重试到连上为止**，且只重试"暂时性"的失败。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('better-sqlite3', async () => ({
  default: (await import('./helpers/node-sqlite-shim.js')).NodeSqliteShim,
}));

import { closeDatabase, initDatabase } from '../src/main/db/index.js';
import type { MemorySyncGateway } from '../src/main/memory/sync.js';
import { syncMemoryToAgentsWithRetry } from '../src/main/memory/sync.js';

/** 真库（临时目录）：没有它 `syncMemoryToAgents` 会在第一步就返回 db-unavailable。 */
let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memory-sync-retry-'));
  initDatabase(dir);
});
afterEach(() => {
  // 先关库再删目录：Windows 上仍打开的 `.db` 会把整个目录钉住（EPERM）。
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

function noSleep(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    sleep: async (ms: number) => {
      calls.push(ms);
    },
    get calls() {
      return calls;
    },
  };
}

describe('syncMemoryToAgentsWithRetry', () => {
  it('网关还没连上（listAgents 抛 not connected）⇒ 退避重试，连上后成功', async () => {
    // 复刻现场：前两次都撞在握手完成之前，第三次才通。
    let attempts = 0;
    const gateway: MemorySyncGateway = {
      async listAgents() {
        attempts += 1;
        if (attempts <= 2) throw new Error('not connected');
        return { agents: [{ id: 'main' }] };
      },
      async getAgentFile() {
        return { file: { name: 'MEMORY.md', content: '', missing: true } };
      },
      async setAgentFile() {
        return { ok: true };
      },
    };

    const clock = noSleep();
    const outcome = await syncMemoryToAgentsWithRetry(gateway, { sleep: clock.sleep, delaysMs: [10, 20, 30] });

    expect(attempts).toBe(3);
    expect(clock.calls).toEqual([10, 20]);
    // 走到 materialize 就说明真的连上并投影了（不是"重试成功但什么也没做"）。
    expect(outcome.ok).toBe(true);
  });

  it('一直连不上 ⇒ 用尽退避后如实返回 list-failed（不假装成功）', async () => {
    let attempts = 0;
    const gateway: MemorySyncGateway = {
      async listAgents() {
        attempts += 1;
        throw new Error('not connected');
      },
      async getAgentFile() {
        return { file: { name: 'MEMORY.md', content: '', missing: true } };
      },
      async setAgentFile() {
        return { ok: true };
      },
    };

    const clock = noSleep();
    const outcome = await syncMemoryToAgentsWithRetry(gateway, { sleep: clock.sleep, delaysMs: [10, 20, 30] });

    expect(attempts).toBe(4); // 首次 + 三次退避
    expect(clock.calls).toEqual([10, 20, 30]);
    expect(outcome).toEqual({ ok: false, reason: 'list-failed' });
  });

  it('"网关说没有助手"这类结果不重试 —— 别把确定性失败拖成 50 秒', async () => {
    const listAgents = vi.fn(async () => ({ agents: [] }));
    const gateway: MemorySyncGateway = {
      listAgents,
      async getAgentFile() {
        return { file: { name: 'MEMORY.md', content: '', missing: true } };
      },
      async setAgentFile() {
        return { ok: true };
      },
    };

    const clock = noSleep();
    const outcome = await syncMemoryToAgentsWithRetry(gateway, { sleep: clock.sleep, delaysMs: [10, 20, 30] });

    expect(outcome).toEqual({ ok: false, reason: 'no-agents' });
    expect(listAgents).toHaveBeenCalledTimes(1); // 连上了、名单确实是空的 ⇒ 立刻收手
    expect(clock.calls).toEqual([]);
  });
});
