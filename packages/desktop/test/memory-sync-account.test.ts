/**
 * 端到端：**库（真 SQLite 文件）→ `MEMORY.md`（假网关）** 的那条链，按**账号**过滤。
 *
 * 这是"长时记忆召回"的完整证据链，也是"换账号不串记忆"的落点：
 *
 * ```
 * 真 SQLite 表  ──list(owner)──▶  受管区块  ──setAgentFile──▶  假网关的文件
 *                                                   └──getAgentFile 回读──▶ readback
 * ```
 *
 * 三条断言是这一整批的核心：
 *   ① **换账号重投之后，文件里只剩新账号那批** —— 上一账号的记忆不会通过提示词泄给下一账号；
 *   ② **草案永远进不了 `MEMORY.md`** —— 用户没点头就不算记住；
 *   ③ 回读出来的条目行 == 库里那批（写进文件 ⇒ 助手下一轮真会读到）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryBlockEntryLines } from '@clawwork/core';

vi.mock('better-sqlite3', async () => ({
  default: (await import('./helpers/node-sqlite-shim.js')).NodeSqliteShim,
}));

import { closeDatabase, getSqlite, initDatabase } from '../src/main/db/index.js';
import { createMemoryStore } from '../src/main/memory/store.js';
import { syncMemoryToAgents, readMemoryRecallSnapshot } from '../src/main/memory/sync.js';
import type { MemorySyncGateway } from '../src/main/memory/sync.js';

const OWNER_A = 'user-a';
const OWNER_B = 'user-b';
const AGENTS = ['main', 'agent-a'];

/** 假网关：内存里的文件表 + `agents.list` 载荷。 */
function fakeGateway(): {
  api: MemorySyncGateway;
  files: Record<string, string>;
  writes: number;
} {
  const files: Record<string, string> = {};
  const state = { writes: 0 };
  const api: MemorySyncGateway = {
    async listAgents() {
      return { agents: AGENTS.map((id) => ({ id })) };
    },
    async getAgentFile(agentId: string) {
      return { file: { name: 'MEMORY.md', content: files[agentId] ?? '', missing: files[agentId] === undefined } };
    },
    async setAgentFile(agentId: string, _name: string, content: string) {
      state.writes += 1;
      files[agentId] = content;
      return { ok: true };
    },
  };
  return {
    api,
    files,
    get writes() {
      return state.writes;
    },
  };
}

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memory-sync-'));
  initDatabase(dir);
});

afterEach(() => {
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

function store() {
  const sqlite = getSqlite();
  if (!sqlite) throw new Error('库没打开');
  return createMemoryStore(sqlite);
}

describe('记忆同步：库 → MEMORY.md（按账号过滤）', () => {
  it('⭐ 已确认的一条，投影之后助手真的读得到（回读与库里那批逐字一致）', async () => {
    const db = store();
    db.create({ ownerUserId: OWNER_A, text: '用户希望结论先行。', source: 'user' });
    db.create({ ownerUserId: OWNER_A, text: '用户所在行业是电商。', source: 'user' });

    const gateway = fakeGateway();
    const outcome = await syncMemoryToAgents({ gateway: gateway.api, ownerUserId: OWNER_A });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(gateway.files['main']).toContain('- 用户希望结论先行。');
    expect(gateway.files['agent-a']).toContain('- 用户所在行业是电商。');
    for (const agentId of AGENTS) {
      expect(outcome.result.readback[agentId]).toEqual(['用户希望结论先行。', '用户所在行业是电商。']);
    }

    // 只读取证：不改文件，只把每个助手里现在真实躺着的东西读回来
    const proof = await readMemoryRecallSnapshot({ gateway: gateway.api, ownerUserId: OWNER_A });
    expect(proof.ok).toBe(true);
    if (!proof.ok) return;
    expect(proof.entries.map((entry) => entry.text)).toEqual(['用户希望结论先行。', '用户所在行业是电商。']);
    expect(proof.files['main']).toEqual(['用户希望结论先行。', '用户所在行业是电商。']);
  });

  it('⭐ 换账号重投 ⇒ 文件里**只剩新账号那批**（上一账号的记忆不会泄给下一账号）', async () => {
    const db = store();
    db.create({ ownerUserId: OWNER_A, text: 'A 的偏好：结论先行。', source: 'user' });
    db.create({ ownerUserId: OWNER_B, text: 'B 的偏好：先看数据。', source: 'user' });

    const gateway = fakeGateway();
    await syncMemoryToAgents({ gateway: gateway.api, ownerUserId: OWNER_A });
    expect(memoryBlockEntryLines(gateway.files['main'])).toEqual(['A 的偏好：结论先行。']);

    await syncMemoryToAgents({ gateway: gateway.api, ownerUserId: OWNER_B });
    expect(memoryBlockEntryLines(gateway.files['main'])).toEqual(['B 的偏好：先看数据。']);
    expect(gateway.files['main']).not.toContain('A 的偏好');
    expect(gateway.files['agent-a']).not.toContain('A 的偏好');

    // 换回 A：B 的记忆也不许留在里面
    await syncMemoryToAgents({ gateway: gateway.api, ownerUserId: OWNER_A });
    expect(memoryBlockEntryLines(gateway.files['main'])).toEqual(['A 的偏好：结论先行。']);
    expect(gateway.files['main']).not.toContain('B 的偏好');
  });

  it('🔴 草案**永远**进不了 MEMORY.md（未确认 = 助手读不到）', async () => {
    const db = store();
    db.propose({ ownerUserId: OWNER_A, text: '助手想的：用户可能喜欢周报。' });

    const gateway = fakeGateway();
    const outcome = await syncMemoryToAgents({ gateway: gateway.api, ownerUserId: OWNER_A });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.entries).toEqual([]);
    expect(gateway.files['main']).toContain('当前没有已确认的长期记忆');
    expect(gateway.files['main']).not.toContain('助手想的');
  });

  it('⭐ 确认之后才进文件；删除之后又从文件里消失', async () => {
    const db = store();
    const proposed = db.propose({ ownerUserId: OWNER_A, text: '用户在跨境电商行业。' });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;

    const gateway = fakeGateway();
    await syncMemoryToAgents({ gateway: gateway.api, ownerUserId: OWNER_A });
    expect(gateway.files['main']).not.toContain('用户在跨境电商行业。');

    expect(db.confirm({ ownerUserId: OWNER_A, id: proposed.entry.id }).ok).toBe(true);
    await syncMemoryToAgents({ gateway: gateway.api, ownerUserId: OWNER_A });
    expect(memoryBlockEntryLines(gateway.files['main'])).toEqual(['用户在跨境电商行业。']);

    expect(db.remove({ ownerUserId: OWNER_A, id: proposed.entry.id }).ok).toBe(true);
    await syncMemoryToAgents({ gateway: gateway.api, ownerUserId: OWNER_A });
    expect(gateway.files['main']).not.toContain('用户在跨境电商行业。');
    expect(gateway.files['main']).toContain('当前没有已确认的长期记忆');
  });

  it('被拒绝的草案同样进不了 MEMORY.md', async () => {
    const db = store();
    const proposed = db.propose({ ownerUserId: OWNER_A, text: '一条被拒绝的草案' });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(db.reject({ ownerUserId: OWNER_A, id: proposed.entry.id }).ok).toBe(true);

    const gateway = fakeGateway();
    await syncMemoryToAgents({ gateway: gateway.api, ownerUserId: OWNER_A });
    expect(gateway.files['main']).not.toContain('一条被拒绝的草案');
  });

  it('第二次同步是幂等的：内容没变 ⇒ 一次写都不发', async () => {
    const db = store();
    db.create({ ownerUserId: OWNER_A, text: '稳定的一条', source: 'user' });
    const gateway = fakeGateway();

    await syncMemoryToAgents({ gateway: gateway.api, ownerUserId: OWNER_A });
    const writes = gateway.writes;
    const second = await syncMemoryToAgents({ gateway: gateway.api, ownerUserId: OWNER_A });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.result.written).toEqual([]);
    expect(gateway.writes).toBe(writes);
  });

  it('网关拿不到助手名单 ⇒ 如实失败（不假装同步成功）', async () => {
    const db = store();
    db.create({ ownerUserId: OWNER_A, text: '一条记忆', source: 'user' });
    const api: MemorySyncGateway = {
      listAgents: async () => {
        throw new Error('gateway down');
      },
      getAgentFile: async () => ({ file: { content: '', missing: true } }),
      setAgentFile: async () => ({ ok: true }),
    };
    expect(await syncMemoryToAgents({ gateway: api, ownerUserId: OWNER_A })).toEqual({ ok: false, reason: 'list-failed' });
  });

  it('助手名单为空 ⇒ no-agents（不静默成功）', async () => {
    const db = store();
    db.create({ ownerUserId: OWNER_A, text: '一条记忆', source: 'user' });
    const api: MemorySyncGateway = {
      listAgents: async () => ({ agents: [] }),
      getAgentFile: async () => ({ file: { content: '', missing: true } }),
      setAgentFile: async () => ({ ok: true }),
    };
    expect(await syncMemoryToAgents({ gateway: api, ownerUserId: OWNER_A })).toEqual({ ok: false, reason: 'no-agents' });
  });

  it('载荷形状不对的助手名单（agents 不是数组）⇒ 当空名单处理', async () => {
    const db = store();
    db.create({ ownerUserId: OWNER_A, text: '一条记忆', source: 'user' });
    const api: MemorySyncGateway = {
      listAgents: async () => ({ agents: 'main' }),
      getAgentFile: async () => ({ file: { content: '', missing: true } }),
      setAgentFile: async () => ({ ok: true }),
    };
    expect(await syncMemoryToAgents({ gateway: api, ownerUserId: OWNER_A })).toEqual({ ok: false, reason: 'no-agents' });
  });
});
