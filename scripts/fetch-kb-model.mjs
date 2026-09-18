/**
 * 抓资料库要用的**本地嵌入模型**（T6b）。
 *
 * ## 为什么从 ModelScope 而不是 HuggingFace
 *
 * 2026-09-18 实测：`huggingface.co` 在这台机器上**连不上**（curl 12 秒超时、http_code 000），
 * 而 `modelscope.cn` 0.5 秒返回 200。**模型不能从 HF 拉** —— 那是国内网络环境下的死路。
 * 用户拍板"模型随包发"，所以这个脚本是**发版构建的前置**，不是运行时的下载器。
 *
 * ## 为什么用 Xenova 那份
 *
 * `Xenova/bge-small-zh-v1.5` 是 transformers.js 的 ONNX 转换版：目录里直接有
 * `onnx/model.onnx` + `tokenizer.json`，形状跟 `@huggingface/transformers` 期望的**一字不差**。
 * 用原版 `BAAI/bge-small-zh-v1.5` 还得自己转 ONNX。
 *
 * ## 为什么选 fp32（90.5MB）而不是 int8（22.9MB）
 *
 * 量化版小四倍，但**嵌入质量会悄悄变差** —— 而"检索结果有点不对"是没人会去查的那类问题
 * （同 `vector-math.ts` 头注释里那条顾虑）。用户已经认可了这个体积，先不做这个赌。
 *
 * ⚠️ 产物落在 `runtime-out/kb-model/`（**已经被 .gitignore 忽略**，不动 .gitignore 那条纪律）。
 *    验证过一次：往那里放文件 `git status` 看不见。
 *
 * 用法：
 *   node scripts/fetch-kb-model.mjs            # 缺什么下什么
 *   node scripts/fetch-kb-model.mjs --force    # 全部重下
 *   node scripts/fetch-kb-model.mjs --verify-only
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 模型 id 同时是目录名 —— 它会写进 `kb_meta.embedding_model`，改它等于让所有向量作废。 */
export const KB_MODEL_ID = 'bge-small-zh-v1.5';
export const KB_MODEL_DIR_NAME = 'kb-model';

const SOURCE = {
  owner: 'Xenova',
  repo: KB_MODEL_ID,
  revision: 'master',
};

/** 缺一不可：config 定架构，tokenizer 定切词，onnx 是权重。 */
const FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'onnx/model.onnx'];

function parseArgs(argv) {
  const out = { force: false, verifyOnly: false };
  for (const a of argv) {
    if (a === '--force') out.force = true;
    else if (a === '--verify-only') out.verifyOnly = true;
  }
  return out;
}

/** ModelScope 的原始文件下载口。 */
export function fileUrl(filePath) {
  return `https://www.modelscope.cn/api/v1/models/${SOURCE.owner}/${SOURCE.repo}/repo?Revision=${SOURCE.revision}&FilePath=${encodeURIComponent(filePath)}`;
}

export function modelRoot(repoRoot = REPO_ROOT) {
  return path.join(repoRoot, 'runtime-out', KB_MODEL_DIR_NAME, KB_MODEL_ID);
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // 先写临时文件再改名：下到一半断了不会留下一个"看起来存在"的坏文件。
  const tmp = `${dest}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
  return buf.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = modelRoot();
  console.log(`[kb-model] 目标目录 ${path.relative(REPO_ROOT, root)}`);

  for (const file of FILES) {
    const dest = path.join(root, file);
    const exists = fs.existsSync(dest);

    if (args.verifyOnly) {
      if (!exists) throw new Error(`[kb-model] ✗ 缺文件 ${file}`);
      continue;
    }
    if (exists && !args.force) {
      console.log(`[kb-model] 已有 ${file}（${(fs.statSync(dest).size / 1048576).toFixed(1)}MB）跳过`);
      continue;
    }

    process.stdout.write(`[kb-model] 下载 ${file} … `);
    const bytes = await download(fileUrl(file), dest);
    console.log(`${(bytes / 1048576).toFixed(1)}MB`);
  }

  // 落一份哈希清单：发版构建据此核对"打进包里的模型跟这儿一致"。
  const manifest = { modelId: KB_MODEL_ID, source: SOURCE, files: {} };
  for (const file of FILES) {
    const buf = fs.readFileSync(path.join(root, file));
    manifest.files[file] = { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
  }
  fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const total = Object.values(manifest.files).reduce((sum, f) => sum + f.bytes, 0);
  console.log(`\n[kb-model] ✓ ${FILES.length} 个文件齐了，合计 ${(total / 1048576).toFixed(1)}MB`);
  for (const [file, info] of Object.entries(manifest.files)) {
    console.log(`  ${info.sha256.slice(0, 16)}…  ${String(info.bytes).padStart(9)}  ${file}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[kb-model] ✗ ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
