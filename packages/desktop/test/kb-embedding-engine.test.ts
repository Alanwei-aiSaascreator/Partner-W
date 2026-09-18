import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KB_EMBEDDING_MODEL_ID, loadEmbeddingEngine } from '../src/main/kb/embedding/engine';

/**
 * 本地嵌入引擎（T6b）。
 *
 * ## 最重要的一条是**它怎么失败**
 *
 * 这是随包发的模型 + 原生运行时，在别人机器上可能因为各种原因起不来
 *（DLL 缺失、被杀软拦、磁盘只剩一半…）。**这些都不许把应用带崩、也不许让资料库不可用** ——
 * 引擎加载失败 ⇒ 返回 `null` ⇒ 调用方降级成纯 FTS 检索（T6a 本来就有这个能力）。
 * "少一个功能"和"应用打不开"是完全不同量级的事故。
 *
 * ⚠️ 这里**不加载真模型**（90MB、几秒钟）：用注入的假 pipeline 钉行为。
 *    真模型的可运行性另有一次性探针验过（加载 457ms、3 条 25ms、语义区分正常）。
 */
function makeModelDir(files: Record<string, string> = { 'config.json': '{"hidden_size":512}' }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-model-'));
  // ⚠️ 形状必须是 `<root>/<modelId>/…` —— 引擎（和 transformers.js）按这个布局找模型。
  //    夹具写成平铺的话，测出来的是"模型不存在"这条降级路径，而不是被测的那条，
  //    而且**失败信息看起来像引擎的 bug**（我第一次就这么被骗了一下）。
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(root, KB_EMBEDDING_MODEL_ID, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return root;
}

/** 假 pipeline：把输入映射成固定向量，形状与真的一致（Tensor 有 dims + data）。 */
function fakePipeline() {
  return vi.fn(async (texts: string[]) => ({
    dims: [texts.length, 4],
    data: new Float32Array(texts.flatMap(() => [1, 0, 0, 0])),
  }));
}

let dirs: string[] = [];

beforeEach(() => {
  dirs = [];
});
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const tmpDir = (files?: Record<string, string>): string => {
  const d = makeModelDir(files);
  dirs.push(d);
  return d;
};

describe('loadEmbeddingEngine —— 加载失败必须降级，不能抛', () => {
  it('⭐ 模型目录不存在 ⇒ 返回 null 并说明原因（不是抛异常）', async () => {
    const log = vi.fn();

    const engine = await loadEmbeddingEngine({ modelRoot: 'X:/根本没这个目录', log });

    expect(engine).toBeNull();
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).toMatch(/kb\.embedding/);
  });

  it('⭐ pipeline 加载抛错 ⇒ 返回 null，错误信息带上原因（不能带崩应用）', async () => {
    const log = vi.fn();
    const broken = vi.fn(async () => {
      throw new Error('onnxruntime_binding.node 加载失败');
    });

    const engine = await loadEmbeddingEngine({
      modelRoot: tmpDir(),
      createPipeline: broken as never,
      log,
    });

    expect(engine).toBeNull();
    expect(JSON.stringify(log.mock.calls)).toContain('onnxruntime_binding.node 加载失败');
  });

  it('缺少 config.json ⇒ 也当加载失败（拿不到维度就不能写库）', async () => {
    const engine = await loadEmbeddingEngine({
      modelRoot: tmpDir({ 'other.txt': 'x' }),
      createPipeline: (async () => fakePipeline()) as never,
      log: vi.fn(),
    });

    expect(engine).toBeNull();
  });
});

describe('loadEmbeddingEngine —— 成功路径', () => {
  it('⭐ 维度取自模型 config（写进 kb_meta，写错了所有向量都得作废）', async () => {
    const engine = await loadEmbeddingEngine({
      modelRoot: tmpDir({ 'config.json': '{"hidden_size":768}' }),
      createPipeline: (async () => fakePipeline()) as never,
    });

    expect(engine?.dim).toBe(768);
  });

  it('modelId 是稳定常量（它落库成 kb_meta.embedding_model，换值=所有向量作废）', async () => {
    const engine = await loadEmbeddingEngine({
      modelRoot: tmpDir(),
      createPipeline: (async () => fakePipeline()) as never,
    });

    expect(engine?.modelId).toBe(KB_EMBEDDING_MODEL_ID);
  });

  it('⭐ 必须开 normalize —— 关了的话余弦相似度就不是点积，"归一化后点积"那套假设全崩', async () => {
    const pipe = fakePipeline();
    await loadEmbeddingEngine({ modelRoot: tmpDir(), createPipeline: (() => pipe) as never });

    await (await loadEmbeddingEngine({ modelRoot: tmpDir(), createPipeline: (() => pipe) as never }))!.embed(['x']);

    expect(pipe.mock.calls[0][1]).toMatchObject({ pooling: 'mean', normalize: true });
  });

  it('embed 空数组直接返回 []，不去打 pipeline', async () => {
    const pipe = fakePipeline();
    const engine = await loadEmbeddingEngine({ modelRoot: tmpDir(), createPipeline: (() => pipe) as never });

    expect(await engine!.embed([])).toEqual([]);
    expect(pipe).not.toHaveBeenCalled();
  });

  it('输出是 Float32Array（下游要按它 encodeVector 落库）', async () => {
    const engine = await loadEmbeddingEngine({ modelRoot: tmpDir(), createPipeline: (() => pipeHolder.pipe) as never });
    void pipeHolder;

    const out = await engine!.embed(['甲', '乙']);

    expect(out).toHaveLength(2);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(out[0]).toHaveLength(4);
  });

  it('⭐ 每条文本切出自己的那段（按 dims 切，不是整个 data 原样给）', async () => {
    const pipe = vi.fn(async (texts: string[]) => ({
      dims: [texts.length, 2],
      data: new Float32Array(texts.length === 2 ? [1, 2, 3, 4] : [1, 2]),
    }));
    const engine = await loadEmbeddingEngine({ modelRoot: tmpDir(), createPipeline: (() => pipe) as never });

    const out = await engine!.embed(['甲', '乙']);

    expect(Array.from(out[0])).toEqual([1, 2]);
    expect(Array.from(out[1])).toEqual([3, 4]);
  });
});

const pipeHolder = { pipe: fakePipeline() };
