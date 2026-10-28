/**
 * T27（2026-10-16）：**每轮按提问检索**落到真文件上的那半条链。
 *
 * ```
 * 真 SQLite（25 条已确认） ──selectMemoriesForQuery(提问)──▶ MEMORY.md 受管区块（假网关文件）
 * ```
 *
 * 钉住三件事：
 *   ① 超预算时**换一个提问写进去的集合真的会变**（这是"本地检索"区别于"固定截断"的
 *      唯一可观测证据，也是本用例存在的全部理由）；
 *   ② 没超预算时 `recallMemoriesForTurn` **一次网关往返都不发**（少条目的用户零成本、
 *      行为与从前逐字一致）；
 *   ③ 检索只投给**这条会话自己的助手**（不为了每轮把盘上每个助手都写一遍）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEMORY_RECALL_TOP_N, memoryBlockEntryLines } from '@clawwork/core';

vi.mock('better-sqlite3', async () => ({
  default: (await import('./helpers/node-sqlite-shim.js')).NodeSqliteShim,
}));

import { closeDatabase, getSqlite, initDatabase } from '../src/main/db/index.js';
import { createMemoryStore, currentMemoryStore } from '../src/main/memory/store.js';
import { syncMemoryToAgents } from '../src/main/memory/sync.js';
import { recallMemoriesForTurn } from '../src/main/memory/recall-turn.js';
import type { MemorySyncGateway } from '../src/main/memory/sync.js';

const OWNER = 'user-a';
const AGENTS = ['main', 'agent-a'];

function fakeGateway(): {
  api: MemorySyncGateway;
  files: Record<string, string>;
  stats: { writes: number; reads: number; lists: number };
} {
  const files: Record<string, string> = {};
  const stats = { writes: 0, reads: 0, lists: 0 };
  const api: MemorySyncGateway = {
    async listAgents() {
      stats.lists += 1;
      return { agents: AGENTS.map((id) => ({ id })) };
    },
    async getAgentFile(agentId: string) {
      stats.reads += 1;
      return { file: { name: 'MEMORY.md', content: files[agentId] ?? '', missing: files[agentId] === undefined } };
    },
    async setAgentFile(agentId: string, _name: string, content: string) {
      stats.writes += 1;
      files[agentId] = content;
      return { ok: true };
    },
  };
  return { api, files, stats };
}

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memory-recall-'));
  initDatabase(dir);
});

afterEach(() => {
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

/** 播种 n 条已确认记忆（正文由调用方给）。 */
function seed(texts: string[]): void {
  const sqlite = getSqlite();
  if (!sqlite) throw new Error('库没打开');
  const store = createMemoryStore(sqlite);
  texts.forEach((text, index) => {
    const outcome = store.create({ ownerUserId: OWNER, text, source: 'user' });
    if (!outcome.ok) throw new Error(`seed 第 ${index} 条失败：${outcome.reason}`);
  });
}

function recallLines(files: Record<string, string>, agentId: string): string[] {
  return memoryBlockEntryLines(files[agentId] ?? '');
}

describe('每轮检索投影（真 SQLite + 假网关）', () => {
  it('⭐ 超预算：换一个提问，写进 MEMORY.md 的集合真的不一样', async () => {
    // ⚠️ 构造要让"集合必然随提问变化"**与列表顺序无关**：两组各 15 条、交错排列，
    //    都超过 `TOP_N - 15 = 5` 的零分名额 ⇒ 结果集合由相关性主导，不会因为库按
    //    创建时间正序/倒序返回而恰好相同（第一版就是踩了这个坑：两条相关的都落在
    //    20 条窗口内 ⇒ 两个集合完全相同，用例抓出来了）。
    const texts = Array.from({ length: MEMORY_RECALL_TOP_N + 10 }, (_, i) =>
      i % 2 === 0 ? `第 ${i} 条：报价相关的习惯，我习惯用含税价。` : `第 ${i} 条：宠物用品的品类，主要在电商上卖猫砂。`,
    );
    seed(texts);
    expect(currentMemoryStore()!.list({ ownerUserId: OWNER, status: 'confirmed' })).toHaveLength(
      MEMORY_RECALL_TOP_N + 10,
    );

    const gateway = fakeGateway();

    await syncMemoryToAgents({ gateway: gateway.api, ownerUserId: OWNER, query: '报价怎么给？', agentIds: ['main'] });
    const byPrice = recallLines(gateway.files, 'main');
    expect(byPrice).toHaveLength(MEMORY_RECALL_TOP_N);
    expect(byPrice[0]).toContain('含税价');
    const inPriceByPriceQuery = byPrice.filter((line) => line.includes('含税价')).length;
    const inCategoryByPriceQuery = byPrice.filter((line) => line.includes('猫砂')).length;

    await syncMemoryToAgents({
      gateway: gateway.api,
      ownerUserId: OWNER,
      query: '宠物用品品类卖什么？',
      agentIds: ['main'],
    });
    const byCategory = recallLines(gateway.files, 'main');
    expect(byCategory).toHaveLength(MEMORY_RECALL_TOP_N);
    expect(byCategory[0]).toContain('猫砂');
    const inCategoryByCategoryQuery = byCategory.filter((line) => line.includes('猫砂')).length;
    const inPriceByCategoryQuery = byCategory.filter((line) => line.includes('含税价')).length;

    // 提问换了 ⇒ 写进 MEMORY.md 的集合真的变了（这才是"本地检索"区别于"固定截断"的证据）。
    expect(new Set(byPrice)).not.toEqual(new Set(byCategory));
    // 而且变化是**朝相关的那一边**：报价提问以报价条目为主，品类提问以品类条目为主。
    expect(inPriceByPriceQuery).toBeGreaterThan(inCategoryByPriceQuery);
    expect(inCategoryByCategoryQuery).toBeGreaterThan(inPriceByCategoryQuery);
    expect(inPriceByPriceQuery).toBeGreaterThan(0);
    expect(inCategoryByCategoryQuery).toBeGreaterThan(0);
  });

  it('⭐ 没超预算 ⇒ 一次网关往返都不发（below-limit，行为与从前一致）', async () => {
    seed(['报价一律用含税价。', '不要在周末给我排任务。']);
    const gateway = fakeGateway();

    const outcome = await recallMemoriesForTurn({
      gateway: gateway.api,
      agentId: 'main',
      query: '报价',
      ownerUserId: OWNER,
    });

    expect(outcome).toEqual({ status: 'below-limit', confirmed: 2 });
    expect(gateway.stats).toEqual({ writes: 0, reads: 0, lists: 0 });
  });

  it('⭐ 超预算时只投给**这条会话自己的助手**（不把盘上每个助手都写一遍）', async () => {
    seed(Array.from({ length: MEMORY_RECALL_TOP_N + 2 }, (_, i) => `第 ${i} 条：无关内容。`));
    const gateway = fakeGateway();

    const outcome = await recallMemoriesForTurn({
      gateway: gateway.api,
      agentId: 'agent-a',
      query: '随便问问',
      ownerUserId: OWNER,
    });

    expect(outcome.status).toBe('synced');
    expect(gateway.files['agent-a']).toBeTruthy();
    expect(gateway.files.main).toBeUndefined();
    expect(gateway.stats.lists).toBe(0); // 给了 agentIds ⇒ 不去问名单
  });

  it('提问为空 ⇒ 不投影（不假装有相关性），如实返回 skipped', async () => {
    seed(Array.from({ length: MEMORY_RECALL_TOP_N + 2 }, (_, i) => `第 ${i} 条：无关内容。`));
    const gateway = fakeGateway();

    const outcome = await recallMemoriesForTurn({
      gateway: gateway.api,
      agentId: 'main',
      query: '   ',
      ownerUserId: OWNER,
    });

    expect(outcome).toEqual({ status: 'skipped', reason: 'empty-query' });
    expect(gateway.stats.writes).toBe(0);
  });

  it('库没打开 ⇒ skipped（永不抛；记忆是增强不是发送前置条件）', async () => {
    closeDatabase();
    const gateway = fakeGateway();
    const outcome = await recallMemoriesForTurn({
      gateway: gateway.api,
      agentId: 'main',
      query: '报价',
      ownerUserId: OWNER,
    });
    expect(outcome).toEqual({ status: 'skipped', reason: 'db-unavailable' });
  });
});
