import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildChunkDrafts, type EmbeddingEngine } from '@clawwork/core';
import { closeDatabase, getSqlite, initDatabase } from '../src/main/db/index.js';
import { kbChunkStateCounts, replaceKbChunks, upsertKbSource } from '../src/main/db/kb.js';
import { createKbRuntime } from '../src/main/kb/bootstrap.js';

/**
 * 资料库服务的引导。
 *
 * 这一层只回答一个问题：**引擎起不来时怎么办。**
 *
 * 答案是：**服务照建**。模型没打进包、原生模块被杀软拦、磁盘不够 ——
 * 这些都只该让"向量检索"少一块，不该让用户连"搜我的资料"都做不到。
 * 而这条**很难靠手工发现**：开发机上模型永远在，只有用户的机器上才会缺；
 * 缺了之后界面上没有报错，只是搜索结果"好像不太准"。
 */
vi.mock('better-sqlite3', async () => ({
  default: (await import('./helpers/node-sqlite-shim.js')).NodeSqliteShim,
}));

function requireSqlite() {
  const sqlite = getSqlite();
  if (!sqlite) throw new Error('工作区库未初始化');
  return sqlite;
}

function seedNote() {
  const sqlite = requireSqlite();
  const text = '# 预算说明\n\n第三章讲的是收入与支出。';
  const upserted = upsertKbSource(sqlite, {
    id: 'kb-note-1',
    kind: 'note',
    path: '',
    title: '预算说明',
    contentHash: 'h1',
    contentText: text,
    bytes: Buffer.byteLength(text, 'utf8'),
    addedAt: '2026-09-19T00:00:00.000Z',
  });
  replaceKbChunks(sqlite, upserted.source.id, buildChunkDrafts(text, { chunkSize: 20, chunkOverlap: 0 }));
}

const fakeEngine: EmbeddingEngine = {
  model: 'test-model',
  dim: 3,
  embed: async (texts) => texts.map(() => [1, 0, 0]),
};

let workspace = '';

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'clawwork-kb-boot-'));
  initDatabase(workspace);
});

afterEach(() => {
  closeDatabase();
  rmSync(workspace, { recursive: true, force: true });
});

describe('createKbRuntime', () => {
  it('⭐ 引擎起不来 ⇒ **服务照建**（纯关键词检索是合法降级，不是错误）', async () => {
    const sqlite = requireSqlite();
    seedNote();
    const log = vi.fn();

    const runtime = await createKbRuntime({
      sqlite,
      modelRoot: '/有目录但引擎起不来',
      loadEngine: async () => null,
      log,
    });

    expect(runtime.engine).toBeNull();
    // 关键：服务在，而且是能用的服务（能搜）
    expect(runtime.service).toBeTruthy();
    const outcome = await runtime.service.search('收入');
    expect(outcome.degraded).toBe(true);
    expect(outcome.degradedReason).toBe('no-engine');
    // 块没被瞎写：还留在 pending
    expect(kbChunkStateCounts(sqlite, 'kb-note-1').embedded).toBe(0);
  });

  it('⭐ 根本没找到模型根目录（没打进包）⇒ 同样照建，且日志能区分这两种情况', async () => {
    const sqlite = requireSqlite();
    const log = vi.fn();

    const runtime = await createKbRuntime({
      sqlite,
      locate: { isPackaged: true, resourcesPath: undefined },
      loadEngine: async () => null,
      log,
    });

    expect(runtime.modelRoot).toBeUndefined();
    expect(runtime.service).toBeTruthy();
    // 日志里要能看出"连目录都没找到"，而不是"加载失败"—— 两种排查方向完全不同
    expect(log).toHaveBeenCalledWith('kb.runtime.no_model_root', expect.anything());
  });

  it('引擎可用 ⇒ 服务带向量检索；索引能把块嵌上', async () => {
    const sqlite = requireSqlite();
    seedNote();

    const runtime = await createKbRuntime({ sqlite, modelRoot: '/x', loadEngine: async () => fakeEngine });
    expect(runtime.engine?.model).toBe('test-model');

    const report = await runtime.service.indexPending();
    expect(report.embedded).toBeGreaterThan(0);
    expect(kbChunkStateCounts(sqlite, 'kb-note-1').pending_embedding).toBe(0);
  });

  it('⭐ 模型根目录由 locate 推（打包态用 resourcesPath，不猜路径）', async () => {
    const sqlite = requireSqlite();
    const seen: (string | undefined)[] = [];

    await createKbRuntime({
      sqlite,
      locate: { isPackaged: true, resourcesPath: 'X:/res' },
      loadEngine: async (opts) => {
        seen.push(opts.modelRoot);
        return null;
      },
    });

    expect(seen).toEqual([join('X:/res', 'kb-model')]);
  });

  it('⭐ 引擎只加载一次（90MB 模型、几百毫秒，不能每次索引都重来）', async () => {
    const sqlite = requireSqlite();
    const loadEngine = vi.fn(async () => fakeEngine);

    const runtime = await createKbRuntime({ sqlite, modelRoot: '/x', loadEngine });

    // 同一个 runtime 里反复索引用的是同一个引擎实例
    await runtime.service.indexPending();
    await runtime.service.indexPending();
    expect(loadEngine).toHaveBeenCalledTimes(1);
  });
});
