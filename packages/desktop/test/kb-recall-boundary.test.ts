import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingEngine } from '@clawwork/core';
import { closeDatabase, getSqlite, initDatabase } from '../src/main/db/index.js';
import { createKbService, type KbService } from '../src/main/kb/service.js';

/**
 * 资料库**召回边界**的实测（2026-09-19）。
 *
 * ## 为什么要有这个文件
 *
 * 队列里待决的第 1 项是"资料库召回不够" —— 但"不够"是个形容词。
 * 这个文件把它变成**数字**，用的正是队列里我自己提的那两条验收：
 * 「正文含"软件订阅"、查 `订阅` 能命中；查 `盈利来源`（无字面重叠）也能命中」。
 *
 * ## 它证明的机制（这才是可断言的部分）
 *
 * 召回那一步是**纯 FTS 关键词**（`db/kb.ts` 的 `searchKbChunks` 里只有
 * `WHERE kb_chunks_fts MATCH ?`），向量**只在重排时进场**（`rankKbCandidates`
 * 只能给 FTS 已经召回的候选打分）⇒ **FTS 没召回的，向量永远看不到**。
 *
 * 为了把这个机制**证明**出来而不是"读代码读出来的"，这里用了**神谕引擎**：
 * 它把"本该命中的那一块"和查询放在同一个方向上（余弦 = 1），
 * 另一块放到正交方向（余弦 = 0）。**如果**那一块能进候选，它必然排第一。
 * ⇒ 命中数仍然是 0，就说明向量**根本拿不到出手机会**。
 *
 * ⚠️ 结论与嵌入质量无关：这跟用的是 bge-small-zh 还是一个只会返回常量的假引擎没有关系，
 *    换成在线的大模型也一样 —— 因为候选集根本不从向量来。
 *
 * ⚠️ **断言的是机制，不是命中率**。下面那些 `toHaveLength(0)` 是"当前边界"的记录，
 *    不是"应该永远如此"。**召回一旦修好，这些断言必须跟着改**（它们红才是对的）。
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

/** 本该命中 `订阅` / `盈利来源` 的那一块（神谕引擎会把查询指向它）。 */
const INTENDED_MARKER = '软件订阅';

/**
 * 神谕引擎：把查询与"含 `INTENDED_MARKER` 的块"都映到 `[1,0]`，
 * 其余块映到 `[0,1]` ⇒ 只要那一块进了候选，它必然排第一。
 */
function createOracleEngine(): EmbeddingEngine {
  return {
    model: 'oracle-embed',
    dim: 2,
    async embed(texts: readonly string[]): Promise<number[][]> {
      return texts.map((text) => (text.includes(INTENDED_MARKER) ? [1, 0] : [0, 1]));
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

async function seed(): Promise<KbService> {
  const kb = createKbService({
    sqlite: getSqlite() as never,
    engine: createOracleEngine(),
    chunking: { chunkSize: 40, chunkOverlap: 10 },
  });
  await kb.addNote({ title: '预算说明', text: CORPUS });
  return kb;
}

/** 一次查询的实测结果（打印成表给决策用）。 */
interface Probe {
  query: string;
  label: string;
  candidates: number;
  hits: number;
  mode: string;
  reason: string | null;
}

async function probe(kb: KbService, query: string, label: string): Promise<Probe> {
  const outcome = await kb.search(query);
  return {
    query,
    label,
    candidates: outcome.candidateCount,
    hits: outcome.hits.length,
    mode: outcome.mode,
    reason: outcome.degradedReason ?? null,
  };
}

describe('资料库召回边界（实测）', () => {
  it('⭐ 无字面重叠的查询：**即使向量能把正确的块排到第一，也一条都召回不到**', async () => {
    const kb = await seed();

    // 先确认语料真的进去了（否则下面全是空的、测了个寂寞）
    const stats = kb.getStats();
    expect(stats.chunks, '语料得先切出块来').toBeGreaterThan(0);
    expect(
      (getSqlite() as never as { prepare: (s: string) => { get: () => unknown } })
        .prepare(`SELECT COUNT(*) AS n FROM kb_chunks WHERE text LIKE '%${INTENDED_MARKER}%'`)
        .get(),
    ).toMatchObject({ n: expect.any(Number) });

    const probes = [
      await probe(kb, '收入', '词首前缀（unicode61 下唯一能中的形态）'),
      await probe(kb, '订阅', '词中：正文里有这三个字，但 unicode61 不切词'),
      await probe(kb, '盈利来源', '同义改写：与正文零字面重叠（向量的本职）'),
      await probe(kb, 'software subscription', '跨语言：零字面重叠'),
    ];

    console.log(
      '\n资料库召回实测（语料含「收入主要来自软件订阅与授权。」，神谕引擎）\n' +
        probes
          .map(
            (p) =>
              `  ${p.query.padEnd(24)} 候选 ${String(p.candidates).padStart(3)}  命中 ${String(p.hits).padStart(3)}  ` +
              `mode=${p.mode}  ${p.reason ?? ''}  ← ${p.label}`,
          )
          .join('\n') +
        '\n',
    );

    // ---- 机制断言：候选只从 FTS 来 ----
    // 词首前缀能召回 ⇒ 证明 FTS 通路本身是好的（不是"整个检索坏了"）
    expect(probes[0].candidates, '词首前缀应当召回得到').toBeGreaterThan(0);

    // 另外三条：FTS 召不回 ⇒ 候选为 0 ⇒ 神谕引擎也没用武之地
    for (const p of probes.slice(1)) {
      expect(p.candidates, `「${p.query}」零字面重叠，FTS 召不回`).toBe(0);
      expect(p.hits, `「${p.query}」因此一条都没有 —— 向量拿不到出手机会`).toBe(0);
      // 系统自己也这么认为（这正是 `6c1cc65` 加的 `no-recall`）：
      // 界面据此说"换个说法再说试"，而不是那句害人去重建索引的"还没有向量索引"
      expect(p.reason, `「${p.query}」的降级原因应当是"没召回"，不是"没有向量"`).toBe('no-recall');
    }
  });
});
