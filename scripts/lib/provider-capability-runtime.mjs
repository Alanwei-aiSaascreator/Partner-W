import { createHash } from 'node:crypto';

/**
 * rongying-provider-capability-v1（2026-10-07 · 质量战役 I 项）
 *
 * 修因：openclaw 构建产物 `provider-catalog-Cdx84e9y.mjs` 的 inferInput 按**模型名正则**
 * 猜看图能力（只认 claude-/gemini-/gpt-4o/gpt-5）——产品全部中转模型名字不命中 ⇒
 * input 恒为 ["text"] ⇒ context-media-runtime 把用户图片**静默丢弃**（只注入 omission
 * 说明），用户被告知"没有图片识别能力"（BUG-027 调查结论）。且 relay 目录即使给模型
 * 加了 image 能力声明也不会被读取。
 *
 * 补丁语义：**目录声明优先，声明缺失才回退原正则**（行为等价：现全部中转模型
 * capabilities 非空但无 image 词 ⇒ 仍得 ["text"]；未来 relay 目录给某模型加
 * image/vision/multimodal 声明 ⇒ 立刻 ["text","image"]，无需再改 runtime）。
 *
 * 应用方式：① pack-runtime 重打包链（注册进 pack-runtime.mjs，见其 import 区）；
 * ② 对既有归档单文件更新（7z 提取→patch→`7z u` 回写→重算 manifest sha256）。
 * 两种方式共用本模块；幂等（重复应用返回原串）。
 */

export const PROVIDER_CAPABILITY_ENTRY = 'node_modules/openclaw/dist/provider-catalog-Cdx84e9y.mjs';
export const PROVIDER_CAPABILITY_SOURCE_SHA256 = '62501ce1b490a3a27d31368a10fe5863fe4760de5cd3960b94e3fd7cd05de20f';
export const PROVIDER_CAPABILITY_PATCH_ID = 'rongying-provider-capability-v1';

const ORIGINAL_FN = [
  'function inferInput(providerId, modelId) {',
  '\tconst id = `${providerId}/${modelId}`.toLowerCase();',
  '\treturn /(?:claude-|gemini-|gpt-4o|gpt-5)/u.test(id) ? ["text", "image"] : ["text"];',
  '}',
].join('\n');

const PATCHED_FN = [
  'function inferInput(providerId, modelId, declaredCapabilities) {',
  '\t// rongying-provider-capability-v1: 目录声明优先（relay catalog capabilities），声明缺失才回退按名猜（原行为）',
  '\tif (Array.isArray(declaredCapabilities) && declaredCapabilities.length > 0) {',
  '\t\treturn declaredCapabilities.some((c) => /image|vision|multimodal/iu.test(String(c))) ? ["text", "image"] : ["text"];',
  '\t}',
  '\tconst id = `${providerId}/${modelId}`.toLowerCase();',
  '\treturn /(?:claude-|gemini-|gpt-4o|gpt-5)/u.test(id) ? ["text", "image"] : ["text"];',
  '}',
].join('\n');

const ORIGINAL_CALL = 'input: inferInput(provider.id, model.id),';
const PATCHED_CALL = 'input: inferInput(provider.id, model.id, model.capabilities),';

export function patchProviderCapabilityRuntime(source, expectedHash = PROVIDER_CAPABILITY_SOURCE_SHA256) {
  if (source.includes('rongying-provider-capability-v1')) return source; // 幂等
  const hash = createHash('sha256').update(source).digest('hex');
  if (hash !== expectedHash) throw new Error(`provider capability source hash drift: ${hash}`);
  if (source.split(ORIGINAL_FN).length !== 2) throw new Error('provider capability fn anchor drift');
  if (source.split(ORIGINAL_CALL).length !== 2) throw new Error('provider capability call anchor drift');
  return source.replace(ORIGINAL_FN, PATCHED_FN).replace(ORIGINAL_CALL, PATCHED_CALL);
}
