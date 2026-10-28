import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingEngine } from '@clawwork/core';
import { closeDatabase, getSqlite, initDatabase } from '../src/main/db/index.js';
import { createKbService, type KbService } from '../src/main/kb/service.js';

/**
 * 资料库的**召回**：关键词召不回时，向量要能把它捞回来。
 *
 * ## 背景（这就是这条用例存在的原因）
 *
 * 召回那一步本来是**纯 FTS 关键词**（`searchKbChunks` 里只有 `WHERE kb_chunks_fts MATCH ?`），
 * 向量**只在重排时进场**（`rankKbCandidates` 只能给已被召回的候选打分）
 * ⇒ **FTS 没召回的，向量永远没机会看到**。
 * 而 `unicode61` 不切中文词，`收入主要来自软件订阅` 是**一整个 token**，于是：
 *
 *     正文里明明有"软件订阅"，查 `订阅` ⇒ 0 命中
 *     —— 即使本机 bge-small-zh 嵌得好好的、向量一个不缺
 *
 * 2026-09-19 实测记录过这个边界（`e8cc927`）；现在按用户拍板的**混合召回**改：
 * **FTS 关键词优先 + 向量补召回**（FTS 没填满结果页时才扫向量）。
 *
 * ## ⚠️ 上一版用例里我写错了一个东西（这版修掉）
 *
 * 老神谕引擎是 `text.includes('软件订阅') ? [1,0] : [0,1]` —— 而**查询**（`订阅`）
 * 并不包含 `软件订阅` ⇒ 查询被映到 `[0,1]`，和**其它块同向**，目标块反倒是 `[1,0]`
 * ⇒ 目标块的余弦是 **0**（所有块里最低）。老注释却写着"查询与那一块都映到 [1,0]
 * ⇒ 它必然排第一"—— **那句话是假的**。
 * 它没被发现，是因为老用例只断言"候选 0 条"，**根本没跑到排序**。
 *
 * 这版把"语义相同"显式写出来（见 `SEMANTIC_SAME`），神谕引擎才真的在表达
 * "这些查询与那一块同义"。
 */

vi.mock('better-sqlite3', async () => ({
  default: (await import('./helpers/node-sqlite-shim.js')).NodeSqliteShim,
}));

/** 语料：一段像真实资料的中文。 */
const CORPUS = [
  '# 预算说明',
  '',
  '第三章讲的是收入与支出。',
  '',
  '## 收入',
  '',
  '收入主要来自软件订阅与授权。',
  '',
  '## 支出',
  '',
  '支出主要是服务器与人力成本。',
].join('\n');

/** 本该被 `订阅` / `盈利来源` 命中的那一块（含这三个字）。 */
const INTENDED_MARKER = '软件订阅';

/**
 * 与那一块**语义相同**的查询 —— 神谕引擎把它们映到同一个方向。
 *
 * ⚠️ 这三个词里没有一个含 `INTENDED_MARKER`，所以必须**显式**列出来：
 * 引擎分不清"这是查询还是正文"，只能靠这个清单表达"它们同义"。
 * （老版本漏了这一步，于是查询与目标块**不同向**，余弦算出来是 0。）
 */
const SEMANTIC_SAME = new Set(['订阅', '盈利来源', 'software subscription']);

function isIntendedDirection(text: string): boolean {
  return text.includes(INTENDED_MARKER) || SEMANTIC_SAME.has(text.trim());
}

/**
 * 神谕引擎：**语义相同的东西映到同一个方向**（余弦 = 1），其余正交（余弦 = 0）。
 * ⇒ 只要目标块进得了候选，它就必然排第一。
 *
 * ⚠️ 结论与嵌入质量无关：换成真 bge-small-zh 也一样 —— 这里要证明的是
 * **候选集从哪来**，不是"嵌得好不好"。
 */
function createOracleEngine(): EmbeddingEngine {
  return {
    model: 'oracle-embed',
    dim: 2,
    async embed(texts: readonly string[]): Promise<number[][]> {
      return texts.map((text) => (isIntendedDirection(text) ? [1, 0] : [0, 1]));
    },
  };
}

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'clawwork-kb-recall-'));
  initDatabase(workspace);
});

afterEach(() => {
  closeDatabase();
  rmSync(workspace, { recursive: true, force: true });
});

async function seed(engine: EmbeddingEngine | null = createOracleEngine()): Promise<KbService> {
  const kb = createKbService({
    sqlite: getSqlite() as never,
    engine,
    chunking: { chunkSize: 40, chunkOverlap: 10 },
  });
  await kb.addNote({ title: '预算说明', text: CORPUS });
  return kb;
}

describe('资料库召回：关键词召不回时，向量要能捞回来', () => {
  it('⭐ 零字面重叠的查询也要命中（此前一条都召不回）', async () => {
    const kb = await seed();

    const stats = kb.getStats();
    expect(stats.chunks, '语料得先切出块来').toBeGreaterThan(0);

    for (const [query, label] of [
      ['订阅', '词中：正文里有这三个字，但 unicode61 不切词'],
      ['盈利来源', '同义改写：与正文零字面重叠（向量的本职）'],
      ['software subscription', '跨语言：零字面重叠'],
    ] as const) {
      const outcome = await kb.search(query);
      expect(outcome.hits.length, `「${query}」应当命中（${label}）`).toBeGreaterThan(0);
      expect(outcome.hits[0]!.text, `「${query}」的第一条应当就是含「${INTENDED_MARKER}」的那块`).toContain(
        INTENDED_MARKER,
      );
      expect(outcome.degradedReason, `「${query}」不该再报"没召回"`).not.toBe('no-recall');
    }
  });

  it('词首前缀那条路（纯 FTS）不受影响', async () => {
    const kb = await seed();

    const outcome = await kb.search('收入');
    expect(outcome.hits.length).toBeGreaterThan(0);
    expect(
      outcome.hits.some((hit) => hit.text.includes('收入')),
      '「收入」是词首前缀，FTS 本来就召得回',
    ).toBe(true);
  });

  it('召回结果不重复（同一块被两路都召回时只出现一次）', async () => {
    const kb = await seed();

    const outcome = await kb.search('收入主要来自软件订阅');
    const ids = outcome.hits.map((hit) => hit.chunkId);
    expect(new Set(ids).size, '同一个 chunkId 不许出现两次').toBe(ids.length);
  });

  it('⭐ 关键词已经填满结果页时**不**扫向量（那是全表扫，常见查询不该付这个代价）', async () => {
    const kb = await seed();

    // 关键词够填满 limit ⇒ 补召回不该被触发。
    // 判别办法：摘掉引擎后再搜一次（那条路**不可能**有补召回），候选数应当一样。
    // —— 补召回一旦被触发，候选数会因为多出一堆零关键词分的块而变大。
    const withEngine = await kb.search('收入', { limit: 1 });
    kb.setEmbeddingEngine(null);
    const withoutEngine = await kb.search('收入', { limit: 1 });

    expect(withEngine.candidateCount, '关键词已够用却仍扫了全表 ⇒ 这个数字会变大').toBe(withoutEngine.candidateCount);
  });

  it('命中数不超过 limit', async () => {
    const kb = await seed();

    const outcome = await kb.search('订阅', { limit: 1 });
    expect(outcome.hits.length).toBeLessThanOrEqual(1);
  });

  it('⚠️ 没有引擎时照旧是纯关键词：零字面重叠仍然零命中（不许假装能召回）', async () => {
    const kb = await seed(null);

    const outcome = await kb.search('订阅');
    expect(outcome.hits, '没引擎就没得补召回 —— 如实返回 0').toHaveLength(0);
    // 原因链是 no-engine → engine-error → no-recall：没引擎时先说'没引擎'（那才是根因）
    expect(outcome.degradedReason).toBe('no-engine');
    expect(outcome.mode).toBe('keyword');
  });
});
