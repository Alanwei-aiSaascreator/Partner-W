import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingEngine } from '@clawwork/core';
import { closeDatabase, getSqlite, initDatabase } from '../src/main/db/index.js';
import { listKbChunks, listKbSources, readKbMeta, searchKbChunks } from '../src/main/db/kb.js';
import { MAX_KB_FILE_BYTES, createKbService, readLocalTextFile, type KbService } from '../src/main/kb/service.js';

/**
 * 资料库**全流程**（取本地文本 → 切片 → 状态机 → 落库 → 检索）跑在真 SQLite 上，
 * 嵌入引擎是**假引擎**（T6a 不接真嵌入；T6b 实现同一个接口即可接上）。
 *
 * 这一层要钉住的四件事：
 * ① 没有引擎（离线/U 盘换机）时全流程照样可用，检索退化但不报错；
 * ② 断点续做：引擎中途失败，已嵌好的保住、下次只补没做的（不重头、不重复花钱）；
 * ③ 换模型 ⇒ 老块 stale、向量保留、检索时被跳过；
 * ④ 重建（删 chunks 再来一遍）逐行一致。
 */
vi.mock('better-sqlite3', async () => ({
  default: (await import('./helpers/node-sqlite-shim.js')).NodeSqliteShim,
}));

interface FakeEngine extends EmbeddingEngine {
  calls: string[][];
}

/** 确定性假引擎：默认按"字符桶"分布（同一个字进同一个维度 ⇒ 同主题文本余弦高）。 */
function createFakeEngine(
  model = 'fake-embed-v1',
  dim = 16,
  embed?: (texts: readonly string[]) => number[][],
): FakeEngine {
  const calls: string[][] = [];
  return {
    model,
    dim,
    calls,
    async embed(texts: readonly string[]): Promise<number[][]> {
      calls.push([...texts]);
      if (embed) return embed(texts);
      return texts.map((text) => {
        const vector = new Array<number>(dim).fill(0);
        for (const char of text) {
          vector[Number.parseInt(hashOf(char).slice(0, 8), 16) % dim] += 1;
        }
        return vector;
      });
    },
  };
}

function hashOf(text: string): string {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash = (hash ^ (char.codePointAt(0) ?? 0)) >>> 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function createOfflineEngine(model = 'fake-embed-v1'): FakeEngine {
  const calls: string[][] = [];
  return {
    model,
    dim: 4,
    calls,
    async embed(texts: readonly string[]): Promise<number[][]> {
      calls.push([...texts]);
      throw new Error('fetch failed: relay 不可达');
    },
  };
}

const NOTE = ['# 预算说明', '', '第三章讲的是收入与支出。', '', '## 收入', '', '收入主要来自软件订阅与授权。'].join(
  '\n',
);

let workspace: string;
let service: KbService;

function createService(engine: EmbeddingEngine | null = null, options: { batchSize?: number } = {}): KbService {
  return createKbService({
    sqlite: getSqlite() as never,
    engine,
    chunking: { chunkSize: 60, chunkOverlap: 15 },
    now: () => '2026-09-18T00:00:00.000Z',
    ...options,
  });
}

function seedArtifact(input: {
  id: string;
  name: string;
  localPath: string;
  contentText: string;
  size?: number;
}): void {
  const sqlite = getSqlite();
  if (!sqlite) throw new Error('工作区库未初始化');
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO tasks (id, session_key, session_id, title, status, created_at, updated_at, tags, artifact_dir, gateway_id)
       VALUES ('task-1', 'session-1', '', '任务', 'active', '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z', '[]', '', '')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO messages (id, task_id, role, content, timestamp, session_key)
       VALUES ('msg-1', 'task-1', 'assistant', '产物', '2026-09-18T00:00:00.000Z', 'session-1')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO artifacts (id, task_id, message_id, type, name, file_path, local_path, mime_type, size, source_key, content_text, created_at)
       VALUES (?, 'task-1', 'msg-1', 'file', ?, ?, ?, 'text/markdown', ?, '', ?, '2026-09-18T00:00:00.000Z')`,
    )
    .run(
      input.id,
      input.name,
      input.localPath,
      input.localPath,
      input.size ?? Buffer.byteLength(input.contentText),
      input.contentText,
    );
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'clawwork-kb-service-'));
  initDatabase(workspace);
  service = createService();
});

afterEach(() => {
  closeDatabase();
  rmSync(workspace, { recursive: true, force: true });
});

describe('没有嵌入引擎（离线默认路径）', () => {
  it('手工条目照样切片落库，检索走 FTS 关键词，且如实报告降级原因', async () => {
    const outcome = await service.addNote({ title: '预算说明', text: NOTE });

    expect(outcome.status).toBe('indexed');
    expect(outcome.chunkCount).toBeGreaterThan(0);
    expect(outcome.embeddedCount).toBe(0);
    expect(outcome.pendingCount).toBe(outcome.chunkCount); // 全在 pending，等联网再做

    const chunks = listKbChunks(getSqlite() as never, outcome.sourceId as string);
    expect(chunks.every((chunk) => chunk.vector === null && chunk.state === 'pending_embedding')).toBe(true);

    const result = await service.search('收入');
    expect(result.mode).toBe('keyword');
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe('no-engine');
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]).toMatchObject({ sourceTitle: '预算说明', sourceKind: 'note' });
    expect(service.getStats().meta.embeddingModel).toBeNull();
  });

  it('空文本 ⇒ 不建资料（skipped/empty），不会留下空壳 source', async () => {
    const outcome = await service.addNote({ title: '空的', text: '   \n  ' });

    expect(outcome).toMatchObject({ status: 'skipped', reason: 'empty', chunkCount: 0 });
    expect(service.getStats().sources).toBe(0);
  });
});

describe('有引擎：全流程（假引擎）', () => {
  it('本地文件 → 切片 → 嵌入 → 检索（命中片段带出处）', async () => {
    const engine = createFakeEngine();
    service = createService(engine);
    const filePath = join(workspace, '预算说明.md');
    writeFileSync(filePath, NOTE, 'utf8');

    const outcome = await service.addFile(filePath);

    expect(outcome.status).toBe('indexed');
    expect(outcome.embeddedCount).toBe(outcome.chunkCount);
    expect(outcome.pendingCount).toBe(0);
    expect(outcome.truncated).toBe(false);
    expect(readKbMeta(getSqlite() as never)).toMatchObject({ embeddingModel: 'fake-embed-v1', dim: 16 });

    const chunks = listKbChunks(getSqlite() as never, outcome.sourceId as string);
    expect(chunks.every((chunk) => chunk.state === 'embedded' && chunk.vector?.length === 16)).toBe(true);

    const result = await service.search('收入');
    expect(result.mode).toBe('hybrid');
    expect(result.degraded).toBe(false);
    expect(result.degradedReason).toBeUndefined();
    expect(result.hits[0].snippet).toContain('<<收入>>');
    expect(result.hits[0].sourceTitle).toBe('预算说明.md');
    expect(result.hits[0].vectorUsed).toBe(true);
  });

  it('产物（artifacts.content_text）也能入库；找不到/空产物如实跳过', async () => {
    service = createService(createFakeEngine());
    seedArtifact({ id: 'artifact-1', name: '复盘.md', localPath: 'task-1/复盘.md', contentText: NOTE });

    const indexed = await service.addArtifact('artifact-1');
    expect(indexed.status).toBe('indexed');
    expect(indexed.chunkCount).toBeGreaterThan(0);

    expect(await service.addArtifact('artifact-missing')).toMatchObject({ status: 'skipped', reason: 'missing' });
    seedArtifact({ id: 'artifact-2', name: '空的.md', localPath: 'task-1/空的.md', contentText: '' });
    expect(await service.addArtifact('artifact-2')).toMatchObject({ status: 'skipped', reason: 'empty' });
  });

  it('向量真的改变排序：关键词弱的块被向量顶上来（同一条用例内对照）', async () => {
    // 假引擎规则：文本里出现 0/1 次 Alpha ⇒ 与查询同向；出现更多次 ⇒ 正交。
    const engine = createFakeEngine('fake-embed-v1', 2, (texts) =>
      texts.map((text) => (text.split('Alpha').length - 1 <= 1 ? [1, 0] : [0, 1]) as number[]),
    );
    service = createService(engine);
    await service.addNote({ title: '一次', text: `${'填充文字。'.repeat(6)}Alpha` });
    await service.addNote({ title: '多次', text: `Alpha Alpha Alpha ${'填充文字。'.repeat(2)}` });

    const hybrid = await service.search('Alpha');
    const keywordOnly = await createService(null).search('Alpha');

    expect(hybrid.mode).toBe('hybrid');
    expect(keywordOnly.mode).toBe('keyword');
    // 关键词序：出现次数多的那条更靠前；加上向量后：与查询同向的那条反超
    expect(keywordOnly.hits.map((hit) => hit.sourceTitle)).toEqual(['多次', '一次']);
    expect(hybrid.hits.map((hit) => hit.sourceTitle)).toEqual(['一次', '多次']);
    expect(hybrid.hits[0].vectorUsed).toBe(true);
  });

  it('引擎抛错（断网）⇒ 不炸、块留在 pending、检索降级并说明是引擎问题', async () => {
    service = createService(createOfflineEngine());

    const outcome = await service.addNote({ title: '预算说明', text: NOTE });

    expect(outcome.status).toBe('indexed');
    expect(outcome.embeddedCount).toBe(0);
    expect(outcome.pendingCount).toBe(outcome.chunkCount);
    expect(outcome.engineError).toContain('relay 不可达');

    const result = await service.search('收入');
    expect(result.mode).toBe('keyword');
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe('engine-error'); // 「暂时」而不是「没有」
    expect(result.hits.length).toBeGreaterThan(0);
  });

  it('断点续做：联网后接着做，只补没做的（已嵌好的不再发给引擎）', async () => {
    const offline = createOfflineEngine();
    service = createService(offline);
    const outcome = await service.addNote({ title: '预算说明', text: NOTE });
    const sourceId = outcome.sourceId as string;
    expect(outcome.pendingCount).toBeGreaterThan(1);

    // 换一个"半通"的引擎：第一批成功、之后失败（模拟网络抖）
    let call = 0;
    const flaky: FakeEngine = {
      model: 'fake-embed-v1',
      dim: 2,
      calls: [],
      async embed(texts) {
        call += 1;
        flaky.calls.push([...texts]);
        if (call > 1) throw new Error('又断了');
        return texts.map(() => [1, 0]);
      },
    };
    const resumed = createKbService({
      sqlite: getSqlite() as never,
      engine: flaky,
      chunking: { chunkSize: 60, chunkOverlap: 15 },
      batchSize: 1,
    });

    const first = await resumed.indexPending();
    expect(first.embedded).toBe(1);
    expect(first.failed).toBeGreaterThan(0);
    expect(first.engineError).toContain('又断了');

    const healthy = createFakeEngine();
    resumed.setEmbeddingEngine(healthy);
    const second = await resumed.indexPending();

    const total = listKbChunks(getSqlite() as never, sourceId).length;
    expect(second.embedded).toBe(total - 1); // 只补剩下的那几块
    expect(healthy.calls.flat()).toHaveLength(total - 1);
    // 先前那块 embedded 的块没有被重做（引擎收到的文本里没有它）
    const firstEmbedded = listKbChunks(getSqlite() as never, sourceId).find((chunk) => chunk.vector !== null);
    expect(healthy.calls.flat()).not.toContain(firstEmbedded?.text);
    // 同一个模型接着做 ⇒ 已嵌好的块不标 stale（stale 只在真的换了模型时出现）
    expect(service.getStats().byState.stale).toBe(0);
    expect(resumed.getStats().meta.embeddingModel).toBe('fake-embed-v1');
  });
});

describe('换嵌入模型', () => {
  it('老块标 stale、向量保留；检索不再用它的向量；重嵌后恢复正常', async () => {
    const engineV1 = createFakeEngine('fake-v1');
    service = createService(engineV1);
    const outcome = await service.addNote({ title: '预算说明', text: NOTE });
    const sourceId = outcome.sourceId as string;
    const before = listKbChunks(getSqlite() as never, sourceId).map((chunk) => Array.from(chunk.vector ?? []));
    expect(before.every((vector) => vector.length > 0)).toBe(true);

    const switched = service.setEmbeddingEngine(createFakeEngine('fake-v2', 8));

    expect(switched).toMatchObject({ model: 'fake-v2', dim: 8 });
    expect(switched.staled).toBe(before.length);
    expect(readKbMeta(getSqlite() as never)).toMatchObject({ embeddingModel: 'fake-v2', dim: 8 });
    const staled = listKbChunks(getSqlite() as never, sourceId);
    expect(staled.every((chunk) => chunk.state === 'stale' && chunk.vector !== null)).toBe(true);
    // 向量没被删：切回原模型不用重新花钱（这里只是如实保留）
    expect(staled.map((chunk) => Array.from(chunk.vector ?? []))).toEqual(before);

    const staleSearch = await service.search('收入');
    expect(staleSearch.hits.every((hit) => hit.vectorUsed === false)).toBe(true);

    const reindexed = await service.indexPending();
    expect(reindexed.embedded).toBe(staled.length);
    const after = listKbChunks(getSqlite() as never, sourceId);
    expect(after.every((chunk) => chunk.state === 'embedded' && chunk.embeddingModel === 'fake-v2')).toBe(true);
    expect((await service.search('收入')).hits[0].vectorUsed).toBe(true);
  });

  it('同名换维（模型名不变、维度变了）：旧向量不能算"可用"，检索如实降级并指向"需要重建"', async () => {
    const dim4: EmbeddingEngine = { model: 'same-name', dim: 4, embed: async (texts) => texts.map(() => [1, 0, 0, 0]) };
    service = createService(dim4);
    const outcome = await service.addNote({ title: '预算说明', text: NOTE });
    const sourceId = outcome.sourceId as string;
    expect(listKbChunks(getSqlite() as never, sourceId).every((chunk) => chunk.vector?.length === 4)).toBe(true);

    const dim8: EmbeddingEngine = {
      model: 'same-name',
      dim: 8,
      embed: async (texts) => texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]),
    };
    const switched = service.setEmbeddingEngine(dim8);

    // 名字没变 ⇒ 状态机看不出任何异常（这正是"静默"的来源：不标 stale、也不重嵌）
    expect(switched).toMatchObject({ model: 'same-name', dim: 8 });
    expect(listKbChunks(getSqlite() as never, sourceId).every((chunk) => chunk.state === 'embedded')).toBe(true);
    expect(await service.indexPending()).toMatchObject({ attempted: 0, embedded: 0 });
    expect(readKbMeta(getSqlite() as never)).toMatchObject({ embeddingModel: 'same-name', dim: 8 });

    const result = await service.search('收入');

    expect(result.mode).toBe('keyword'); // 修复前是 hybrid（拿 4 维向量配 8 维查询算了半天 0）
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe('no-vectors'); // 界面据此提示"嵌入维度变了，需要重建"
    expect(result.hits.length).toBeGreaterThan(0); // 降级 ≠ 搜不到（设计 §五）
    expect(result.hits.every((hit) => hit.vectorUsed === false && hit.vectorScore === 0)).toBe(true);
    // 旧向量原样留着：切回 4 维不用重新花积分
    expect(listKbChunks(getSqlite() as never, sourceId).every((chunk) => chunk.vector?.length === 4)).toBe(true);
  });

  it('摘掉引擎（null）不算换模型：状态不动、meta 归零', async () => {
    service = createService(createFakeEngine('fake-v1'));
    const outcome = await service.addNote({ title: '预算说明', text: NOTE });
    const sourceId = outcome.sourceId as string;

    const removed = service.setEmbeddingEngine(null);

    expect(removed).toMatchObject({ model: null, staled: 0 });
    expect(listKbChunks(getSqlite() as never, sourceId).every((chunk) => chunk.state === 'embedded')).toBe(true);
  });

  it('重启时直接带引擎（T6b 从配置读出来）⇒ 走的是同一条路：落 meta + 标 stale', async () => {
    service = createService(createFakeEngine('fake-v1'));
    const outcome = await service.addNote({ title: '预算说明', text: NOTE });
    const sourceId = outcome.sourceId as string;

    const sameModel = createService(createFakeEngine('fake-v1'));
    expect(sameModel.getStats().meta).toMatchObject({ embeddingModel: 'fake-v1', dim: 16 });
    expect(sameModel.getStats().byState.stale).toBe(0);

    const otherModel = createService(createFakeEngine('fake-v2', 4));
    expect(otherModel.getStats().meta).toMatchObject({ embeddingModel: 'fake-v2', dim: 4 });
    expect(listKbChunks(getSqlite() as never, sourceId).every((chunk) => chunk.state === 'stale')).toBe(true);
  });
});

describe('重复入库与重建', () => {
  it('内容没变时重复加入 ⇒ unchanged：不重切、不重嵌、不重复花积分', async () => {
    const engine = createFakeEngine();
    service = createService(engine);
    const filePath = join(workspace, '预算说明.md');
    writeFileSync(filePath, NOTE, 'utf8');

    const first = await service.addFile(filePath);
    const callsAfterFirst = engine.calls.length;
    const second = await service.addFile(filePath);

    expect(second).toMatchObject({ status: 'unchanged', sourceId: first.sourceId, embeddedCount: 0 });
    expect(engine.calls).toHaveLength(callsAfterFirst);
    expect(service.getStats().sources).toBe(1);
  });

  it('内容变了 ⇒ 重切重嵌，同一份资料仍是同一个 source', async () => {
    service = createService(createFakeEngine());
    const filePath = join(workspace, '预算说明.md');
    writeFileSync(filePath, NOTE, 'utf8');
    const first = await service.addFile(filePath);

    // 注意「差旅」要放在词首：unicode61 下 `差旅*` 只匹配以它开头的 token（见 kb-store 那条边界用例）
    writeFileSync(filePath, `${NOTE}\n\n差旅：第四季度要压缩。`, 'utf8');
    const second = await service.addFile(filePath);

    expect(second.status).toBe('indexed');
    expect(second.sourceId).toBe(first.sourceId);
    expect(second.chunkCount).toBeGreaterThan(0);
    expect(service.getStats().sources).toBe(1);
    expect((await service.search('差旅')).hits.length).toBeGreaterThan(0);
    expect((await service.search('收入')).hits.length).toBeGreaterThan(0);
  });

  it('删掉 chunks 再重建 ⇒ 逐行一致（含向量），FTS 也一并重建', async () => {
    service = createService(createFakeEngine());
    const outcome = await service.addNote({ title: '预算说明', text: NOTE });
    const sourceId = outcome.sourceId as string;
    const snapshot = (): unknown[] =>
      listKbChunks(getSqlite() as never, sourceId).map(
        ({ id, ordinal, text, tokenEstimate, state, vector, embeddingModel }) => ({
          id,
          ordinal,
          text,
          tokenEstimate,
          state,
          vector: vector ? Array.from(vector) : null,
          embeddingModel,
        }),
      );
    const before = snapshot();
    expect(before.every((row) => (row as { vector: unknown }).vector !== null)).toBe(true);
    expect(searchKbChunks(getSqlite() as never, '收入').length).toBeGreaterThan(0);

    getSqlite()?.prepare('DELETE FROM kb_chunks WHERE source_id = ?').run(sourceId);
    expect(searchKbChunks(getSqlite() as never, '收入')).toHaveLength(0);

    const report = await service.rebuild();

    expect(report).toMatchObject({ sources: 1, chunks: before.length, embedded: before.length, failed: 0 });
    expect(snapshot()).toEqual(before); // 一行不差（id/序号/文本/token/状态/向量）
    expect(searchKbChunks(getSqlite() as never, '收入').length).toBeGreaterThan(0);
  });

  it('removeSource ⇒ 切片级联删掉，检索也搜不到', async () => {
    service = createService(createFakeEngine());
    const outcome = await service.addNote({ title: '预算说明', text: NOTE });

    expect(service.removeSource(outcome.sourceId as string)).toBe(true);

    expect(service.getStats()).toMatchObject({ sources: 0, chunks: 0 });
    expect((await service.search('收入')).hits).toEqual([]);
  });
});

describe('并发：单飞与"两代正文不串味"', () => {
  /** 闸门式引擎：每次调用挂起，测试自己决定什么时候放行（模拟 U 盘上很慢的嵌入）。 */
  function createGatedEngine(
    model = 'gated',
    dim = 2,
  ): { engine: FakeEngine; gates: Array<() => void>; releaseAll: () => void } {
    const gates: Array<() => void> = [];
    const calls: string[][] = [];
    // 默认每一批都要等测试放行。`releaseAll()` 之后**新来的批次不再挂起** —— 一轮索引
    // 可能发多批（batchSize 上限），要冻结的只是测试关心的那一批，尾部不该留在半空。
    let open = false;
    const releaseAll = (): void => {
      open = true;
      for (const release of gates.splice(0)) release();
    };
    return {
      gates,
      releaseAll,
      engine: {
        model,
        dim,
        calls,
        async embed(texts: readonly string[]): Promise<number[][]> {
          calls.push([...texts]);
          if (!open) await new Promise<void>((resolve) => gates.push(resolve));
          // 向量第一维 = 正文长度 ⇒ 任何"向量不是这块正文算出来的"都能一眼看出来
          return texts.map((text) => [text.length, 1]);
        },
      },
    };
  }

  it('并发的索引请求只把同一批文本送一遍（付费嵌入不能重复扣费）', async () => {
    const offline = createOfflineEngine('slow');
    service = createService(offline);
    const outcome = await service.addNote({ title: '预算说明', text: NOTE });
    expect(outcome.pendingCount).toBe(outcome.chunkCount); // 全是待嵌的

    const { engine, gates } = createGatedEngine('slow');
    service.setEmbeddingEngine(engine);

    const first = service.indexPending();
    const second = service.indexPending(); // 同时来的第二次请求
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates[0]();
    const [a, b] = await Promise.all([first, second]);

    // ⭐ 引擎只被调了**一次**，而且那批文本里没有重复（修复前：两批、同一批文本各来一遍）
    expect(engine.calls).toHaveLength(1);
    const sent = engine.calls.flat();
    expect(new Set(sent).size).toBe(sent.length);
    expect(sent.length).toBe(outcome.chunkCount);
    expect(a.embedded + b.embedded).toBeGreaterThan(0);
    expect(
      listKbChunks(getSqlite() as never, outcome.sourceId as string).every((chunk) => chunk.state === 'embedded'),
    ).toBe(true);
  });

  it('单飞期间新写进来的切片不会被吞掉：跑完补一轮', async () => {
    const { engine, gates } = createGatedEngine('slow');
    service = createService(engine);

    const first = service.addNote({ title: '第一份', text: NOTE });
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    // 第一轮还在嵌的时候，第二份资料入库（它的切片是"后面才出现的活"）
    const second = service.addNote({ title: '第二份', text: `${NOTE}\n\n## 追加\n\n又是一段新正文。` });
    gates[0]();
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates[1]();
    const [one, two] = await Promise.all([first, second]);

    expect(engine.calls).toHaveLength(2); // 第一轮 + 补的那一轮，没有第三轮空转
    expect(one.pendingCount).toBe(0);
    expect(two.pendingCount).toBe(0);
    for (const sourceId of [one.sourceId as string, two.sourceId as string]) {
      expect(
        listKbChunks(getSqlite() as never, sourceId).every(
          (chunk) => chunk.state === 'embedded' && chunk.vector?.[0] === chunk.text.length,
        ),
      ).toBe(true);
    }
  });

  it('同一份资料两代并发入库：第一代（慢）的向量不许写到第二代的正文上', async () => {
    const { engine, gates, releaseAll } = createGatedEngine('slow');
    service = createService(engine);
    const filePath = join(workspace, 'doc.md');
    writeFileSync(filePath, '第一代正文。'.repeat(60), 'utf8');

    const first = service.addFile(filePath);
    await vi.waitFor(() => expect(gates).toHaveLength(1));

    // 第一代还没嵌完，用户又加了一次同一个文件（U 盘上很常见）
    writeFileSync(filePath, '第二代完全不同的正文，长度也不一样。'.repeat(60), 'utf8');
    const second = service.addFile(filePath);
    // ⚠️ 这里**不能** await second：它要等第一代的嵌入放行（单飞），await 会死等
    const sourceId = (listKbSources(getSqlite() as never)[0] ?? { id: '' }).id;

    gates[0](); // 第一代的嵌入结果现在才回来（此时库里的正文已经是第二代）
    releaseAll(); // 补的那一轮可能分多批：放完第一批后其余批次自动放行
    const [firstOutcome] = await Promise.all([first, second]);

    const chunks = listKbChunks(getSqlite() as never, sourceId);
    expect(chunks.length).toBeGreaterThan(0);
    expect(firstOutcome.sourceId).toBe(sourceId); // 同一份资料，同一个 source
    expect(chunks.every((chunk) => chunk.state === 'embedded')).toBe(true);
    // ⭐ 每块向量编码的长度 == **它自己这块正文**的长度 ⇒ 没有一块带着上一代的向量
    expect(chunks.map((chunk) => chunk.vector?.[0])).toEqual(chunks.map((chunk) => chunk.text.length));
    // 补的那一轮确实把**第二代**的正文送进了引擎（没被单飞吞掉）
    expect(engine.calls.length).toBeGreaterThan(1);
    expect(engine.calls.slice(1).flat().join('\n')).toContain('第二代');
    expect((await service.search('第二代')).hits.length).toBeGreaterThan(0);
  });
});

describe('路径规范化（同一个文件只有一条资料）', () => {
  it('带 `..` 的写法与规范写法收敛到同一条（realpath）', async () => {
    service = createService(createFakeEngine());
    mkdirSync(join(workspace, 'sub'), { recursive: true });
    const filePath = join(workspace, '预算说明.md');
    writeFileSync(filePath, NOTE, 'utf8');

    const first = await service.addFile(filePath);
    // ⚠️ 不能用 `join(workspace, 'sub', '..', ...)`：`path.join` 自己会把 `..` 规范化掉，
    // 那样两条路径**本来就相等**，测试就成了假绿（实测：去掉 realpath 它照样通过）。
    const withDotDot = `${workspace}/sub/../预算说明.md`;
    const second = await service.addFile(withDotDot);

    expect(first.status).toBe('indexed');
    expect(second).toMatchObject({ status: 'unchanged', sourceId: first.sourceId });
    expect(service.getStats().sources).toBe(1);
  });

  it.runIf(process.platform === 'win32' || process.platform === 'darwin')(
    '大小写不同的同一路径也只能有一条（Windows/macOS 上路径大小写不敏感）',
    async () => {
      service = createService(createFakeEngine());
      const filePath = join(workspace, 'Budget.md');
      writeFileSync(filePath, NOTE, 'utf8');

      const first = await service.addFile(filePath);
      const second = await service.addFile(filePath.toUpperCase());

      expect(second).toMatchObject({ status: 'unchanged', sourceId: first.sourceId });
      expect(service.getStats().sources).toBe(1); // 修复前是 2（重复索引、重复扣费、检索里重复引用）
    },
  );
});

describe('本地文件读取（不出网、不改文件）', () => {
  it('非文本类扩展名直接拒绝', () => {
    const imagePath = join(workspace, '图.png');
    writeFileSync(imagePath, 'not really png', 'utf8');

    expect(readLocalTextFile(imagePath)).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('文件不存在 ⇒ unreadable，不抛错', () => {
    expect(readLocalTextFile(join(workspace, '没有这个.md'))).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('超过上限的只读前一段，并如实标 truncated（不是静默截断）', () => {
    const filePath = join(workspace, '长文.txt');
    writeFileSync(filePath, 'a'.repeat(64), 'utf8');

    const partial = readLocalTextFile(filePath, 16);

    expect(partial.truncated).toBe(true);
    expect(partial.bytes).toBe(64);
    expect(partial.text).toHaveLength(16);
    expect(readLocalTextFile(filePath)).toMatchObject({ ok: true, truncated: false, bytes: 64 });
    expect(MAX_KB_FILE_BYTES).toBe(2 * 1024 * 1024);
  });

  it('addFile 把不可读的文件如实回报为 skipped', async () => {
    const outcome = await service.addFile(join(workspace, '没有这个.md'));

    expect(outcome).toMatchObject({ status: 'skipped', reason: 'unreadable' });
  });
});
