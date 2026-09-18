/** 临时审阅探针 4（跑完即删）：维度错配 + 并发入库两代交叉。 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingEngine } from '@clawwork/core';
import { closeDatabase, getSqlite, initDatabase } from '../src/main/db/index.js';
import { listEmbeddableKbChunks, listKbChunks } from '../src/main/db/kb.js';
import { createKbService } from '../src/main/kb/service.js';

vi.mock('better-sqlite3', async () => ({
  default: (await import('./helpers/node-sqlite-shim.js')).NodeSqliteShim,
}));

const NOTE = ['# 预算说明', '', '第三章讲的是收入与支出。', '', '## 收入', '', '收入主要来自软件订阅与授权。'].join(
  '\n',
);

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'clawwork-review-probe4-'));
  initDatabase(workspace);
});

afterEach(() => {
  closeDatabase();
  rmSync(workspace, { recursive: true, force: true });
});

describe('探针 F：模型名没变、维度变了', () => {
  it('旧向量会被当成"可用"吗？会提示需要重建吗？', async () => {
    const dim4: EmbeddingEngine = { model: 'same-name', dim: 4, embed: async (t) => t.map(() => [1, 0, 0, 0]) };
    const service = createKbService({
      sqlite: getSqlite() as never,
      engine: dim4,
      chunking: { chunkSize: 60, chunkOverlap: 15 },
      now: () => 'x',
    });
    const added = await service.addNote({ title: '预算说明', text: NOTE });
    const sourceId = added.sourceId as string;
    expect(listKbChunks(getSqlite() as never, sourceId).every((c) => c.state === 'embedded')).toBe(true);

    const dim8: EmbeddingEngine = {
      model: 'same-name',
      dim: 8,
      embed: async (t) => t.map(() => [1, 0, 0, 0, 0, 0, 0, 0]),
    };
    const switched = service.setEmbeddingEngine(dim8);
    const chunks = listKbChunks(getSqlite() as never, sourceId);
    const result = await service.search('收入');
    const pending = await service.indexPending();

    console.log(
      '[probe F]',
      JSON.stringify({
        switched,
        meta: service.getStats().meta,
        chunkStates: chunks.map((c) => c.state),
        chunkVectorLens: chunks.map((c) => c.vector?.length ?? null),
        needEmbedding: listEmbeddableKbChunks(getSqlite() as never, { model: 'same-name' }).length,
        indexPending: pending,
        searchMode: result.mode,
        degraded: result.degraded,
        degradedReason: result.degradedReason ?? null,
        vectorUsed: result.hits.map((h) => h.vectorUsed),
        vectorScores: result.hits.map((h) => h.vectorScore),
      }),
    );
    expect(chunks.every((c) => c.vector?.length === 4)).toBe(true); // 旧向量原样留着
  });
});

describe('探针 G：同一份资料两代并发入库', () => {
  it('第一代（慢）的向量会不会盖到第二代的切片上', async () => {
    const gates: Array<() => void> = [];
    const engine: EmbeddingEngine = {
      model: 'gated',
      dim: 2,
      async embed(texts) {
        await new Promise<void>((resolve) => gates.push(resolve));
        return texts.map((text) => [text.length, 1]);
      },
    };
    const service = createKbService({
      sqlite: getSqlite() as never,
      engine,
      chunking: { chunkSize: 60, chunkOverlap: 15 },
      now: () => 'x',
    });
    const filePath = join(workspace, 'doc.md');
    writeFileSync(filePath, '第一代正文。'.repeat(60), 'utf8');

    const first = service.addFile(filePath);
    await vi.waitFor(() => expect(gates).toHaveLength(1));

    writeFileSync(filePath, '第二代完全不同的正文，长度也不一样。'.repeat(60), 'utf8');
    const second = service.addFile(filePath);
    await vi.waitFor(() => expect(gates).toHaveLength(2));

    gates[1](); // 第二代先落库
    await second;
    gates[0](); // 第一代（慢）后落库
    await first;

    const sourceId = (await service.search('第二代')).hits[0]?.sourceId as string;
    const chunks = listKbChunks(getSqlite() as never, sourceId);
    const mismatched = chunks.filter((chunk) => chunk.vector && chunk.vector[0] !== chunk.text.length);

    console.log(
      '[probe G]',
      JSON.stringify({
        chunks: chunks.length,
        states: chunks.map((c) => c.state),
        mismatchedVectors: mismatched.length,
        sample: mismatched.slice(0, 2).map((c) => ({ storedFirst: c.vector?.[0], textLen: c.text.length })),
      }),
    );
    expect(chunks.length).toBeGreaterThan(0);
  });
});
