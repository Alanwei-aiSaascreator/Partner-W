/**
 * 资料库的**本地嵌入引擎**（T6b）。
 *
 * ## 用户 2026-09-18 拍板：本地 ONNX，不走 relay
 *
 * 推翻了设计文档里"走 relay `/v1/embeddings` + 价目表加行"的旧口径。理由：
 * 内容完全不出设备、离线可用（U 盘形态）、用户不额外付费、不用动计费和隐私政策。
 * 模型与运行时**随包发**（用户选的口径）。
 *
 * ## ⚠️ 本模块最重要的性质是「**它怎么失败**」
 *
 * 这是"随包的原生运行时 + 90MB 模型文件"，在别人机器上可能因为各种原因起不来
 *（DLL 被杀软拦、磁盘只剩一半、架构不对…）。**这些一律不许把应用带崩、
 * 也不许让资料库不可用**：加载失败 ⇒ 返回 `null` ⇒ 调用方降级成纯 FTS 检索
 *（T6a 本来就有这个能力，也是当初留它的意义）。
 * "少一个功能"和"应用打不开"是完全不同量级的事故。
 *
 * ## 为什么用 `@huggingface/transformers` 而不是裸 onnxruntime + 自己写分词
 *
 * BERT 的中文分词（CJK 逐字切、WordPiece 续接）细节极多，**写错了不报错**，
 * 只是嵌入质量悄悄变差 —— 检索结果"看起来有点不对"，没人会怀疑到分词头上。
 * 用参考实现换掉这个风险。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { EmbeddingEngine } from '@clawwork/core';

/**
 * 模型 id。**会落库成 `kb_meta.embedding_model`，也是目录名。**
 *
 * ⚠️ 改这个值 = 既有的所有向量都判为 stale、必须重嵌入（T6a 的状态机会处理，
 * 但用户会看到"需要重建索引"）。所以它是个**稳定常量**，不是随手起的名字。
 */
export const KB_EMBEDDING_MODEL_ID = 'bge-small-zh-v1.5';

// ⚠️ 引擎的接口**不在本文件定义**，直接用 core 的 `EmbeddingEngine`（T6a 就定好的那个）：
//    两者形状一致（`model` / `dim` / `embed`）时，引擎可以**直接**喂给 core 的
//    `embedPendingChunks`，不需要中间再套一层适配器。自己另立一份的话，
//    两份接口一旦漂移就是这么坏：类型都对、运行时才发现字段名不是那个。
//
/** 真 pipeline 的最小形状（只声明我们用到的那点）。 */
interface FeatureExtractionPipeline {
  (
    texts: string[],
    options: { pooling: 'mean'; normalize: boolean },
  ): Promise<{
    dims: readonly number[];
    data: ArrayLike<number>;
  }>;
}

interface LoadEmbeddingEngineOptions {
  /** 模型根目录，其下是 `<modelId>/`。打包态指向 `<resources>/kb-model`。 */
  modelRoot: string;
  modelId?: string;
  /** 注入点：默认动态 import 真 pipeline。测试用它避开 90MB 模型。 */
  createPipeline?: (modelId: string, modelRoot: string) => Promise<FeatureExtractionPipeline>;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

/** 读模型 config 的 `hidden_size`；读不到返回 null（拿不到维度就不能写库）。 */
function readHiddenSize(modelDir: string): number | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(modelDir, 'config.json'), 'utf-8'));
    const value = (raw as { hidden_size?: unknown })?.hidden_size;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

async function defaultCreatePipeline(modelId: string, modelRoot: string): Promise<FeatureExtractionPipeline> {
  const { pipeline, env } = await import('@huggingface/transformers');

  // ⚠️ 锁死"只用本地文件"：默认是要联网去 HuggingFace 拉的，而**国内根本连不上**
  //（2026-09-18 实测 huggingface.co 12 秒超时；modelscope.cn 0.5 秒 200）。
  // 不锁的话表现是"索引卡在那儿不动"，很难查。
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = modelRoot.endsWith(path.sep) ? modelRoot : `${modelRoot}${path.sep}`;

  return (await pipeline('feature-extraction', modelId, { dtype: 'fp32' })) as unknown as FeatureExtractionPipeline;
}

/**
 * 加载引擎。**任何失败都返回 `null`（并记一条日志），绝不抛** —— 见文件头注释。
 */
export async function loadEmbeddingEngine(opts: LoadEmbeddingEngineOptions): Promise<EmbeddingEngine | null> {
  const modelId = opts.modelId ?? KB_EMBEDDING_MODEL_ID;
  const log = opts.log ?? (() => {});
  const modelDir = path.join(opts.modelRoot, modelId);

  if (!fs.existsSync(modelDir)) {
    log('kb.embedding.model_missing', { modelDir });
    return null;
  }

  const dim = readHiddenSize(modelDir);
  if (dim === null) {
    log('kb.embedding.config_unreadable', { modelDir });
    return null;
  }

  let pipe: FeatureExtractionPipeline;
  try {
    pipe = await (opts.createPipeline ?? defaultCreatePipeline)(modelId, opts.modelRoot);
  } catch (err) {
    // 这里是最可能的失败点（原生二进制加载不了、模型文件损坏、内存不够）。
    // 一律降级 —— 资料库退化成纯关键词检索，比整个应用起不来好得多。
    log('kb.embedding.load_failed', { modelId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }

  log('kb.embedding.ready', { modelId, dim });

  return {
    model: modelId,
    dim,
    async embed(texts) {
      if (texts.length === 0) return [];

      // ⚠️ `normalize: true` 不能省：落库的向量按"归一化过"对待，
      //    之后余弦相似度直接用点积算（消费方是 core 的
      //    `services/kb/vectors.ts` → `retrieval.ts` 用它排序）。
      //    这里关了的话检索排序会整体失真，而且不报错。
      //
      // ⚠️⚠️ **这一行就是池化与归一化的实现。**
      //    本仓库曾经另有一份手写的 `vector-math.ts`（`meanPool` / `l2Normalize`），
      //    内容正确、有手算用例，但**从未被任何生产代码调用** —— 而它的头注释
      //    读起来像是"我们自己在做池化"。那份文件已删：它不提供任何保障，
      //    却会让来查排序问题的人改一个**根本不执行**的地方。
      //    要改池化/归一化语义就改这一行；`kb-embedding-engine.test.ts` 钉着它。
      //
      // ⚠️ `pooling: 'mean'` 是**按 attention mask 加权**的均值（库的语义），
      //    不是把整段平铺求平均。padding 位在模型输出里不是精确的 0，而是
      //    "看起来像噪声"的小值 ⇒ 简单平均会把短句的向量往噪声方向拉，
      //    短句越多偏得越厉害 —— 又一次"不报错、只是排序悄悄变差"。
      const out = await pipe([...texts], { pooling: 'mean', normalize: true });

      const width = out.dims[out.dims.length - 1];
      const rows = out.data.length / width;
      const result: number[][] = [];
      for (let i = 0; i < rows; i++) {
        // 按行切出来 —— 整块 data 原样给的话，每条切片都会拿到所有人的向量。
        const row: number[] = [];
        for (let d = 0; d < width; d += 1) row.push(out.data[i * width + d]);
        result.push(row);
      }
      return result;
    },
  };
}
