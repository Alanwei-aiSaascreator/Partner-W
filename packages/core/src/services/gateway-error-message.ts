/**
 * 把网关返回的错误原文翻成人话。
 *
 * 为什么需要它：`sessions.patch` 之类失败的原文是英文，例如
 * `thinkingLevel "minimal" is not supported for clawrouter/deepseek-r1 (use off)`。
 * 2026-09-12 之前这些原文被调用方**整个丢掉**，用户只看到一句「发送失败」，
 * 完全无法判断是模型不支持、模型不存在，还是网络问题。现在把原文透出来，
 * 但直接给中文用户看英文不合适，所以加这一层。
 *
 * ⚠️ 这是**按 message 字符串**匹配的兜底 —— 契约并不稳定，网关改一个字就失效。
 * 正解是与网关约定**错误码**（见 `docs/superpowers/plans/2026-09-11-模型子系统.md` 的 P1-4），
 * 届时本表应改写成「错误码 → 文案」。
 *
 * 认不出来的一律**返回 null**，由调用方回退到网关原文 ——
 * 网关的原文比我们编的话准，宁可给英文也不要给一句错的中文。
 */

/** 思考档位的协议 id → 中文。与 `ChatInput/constants.ts` 的展示名保持一致。 */
const THINKING_LEVEL_LABELS: Record<string, string> = {
  off: '关闭',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  adaptive: '自适应',
  xhigh: '极高',
  max: '最高',
};

function thinkingLabel(id: string): string {
  return THINKING_LEVEL_LABELS[id] ?? id;
}

/**
 * 例：`thinkingLevel "minimal" is not supported for clawrouter/deepseek-r1 (use off)`
 * → `当前模型（clawrouter/deepseek-r1）不支持「最低」档思考，只能用「关闭」。`
 */
function translateThinkingLevelUnsupported(raw: string): string | null {
  const m = /thinkingLevel\s+"([^"]+)"\s+is not supported for\s+(\S+)\s*(?:\(use\s+([^)]+)\))?/i.exec(raw);
  if (!m) return null;
  const [, level, model, allowed] = m;
  const head = `当前模型（${model}）不支持「${thinkingLabel(level)}」档思考`;
  return allowed ? `${head}，只能用「${thinkingLabel(allowed.trim())}」。` : `${head}。`;
}

/** 例：`The selected model was not found by the provider. Check the model id ...` */
function translateModelNotFound(raw: string): string | null {
  if (!/the selected model was not found by the provider/i.test(raw)) return null;
  return '该模型在当前服务上不存在。请换一个模型再试。';
}

const TRANSLATORS = [translateThinkingLevelUnsupported, translateModelNotFound];

/** 命中已知错误返回中文；认不出来返回 null（调用方应回退到网关原文）。 */
export function translateGatewayError(raw: string | undefined): string | null {
  if (!raw) return null;
  for (const translate of TRANSLATORS) {
    const out = translate(raw);
    if (out) return out;
  }
  return null;
}

/**
 * 给界面用的统一入口：已知错误给中文，未知错误给**网关原文**，都没有才给兜底文案。
 */
export function describeGatewayError(raw: string | undefined, fallback: string): string {
  const translated = translateGatewayError(raw);
  if (translated) return translated;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : fallback;
}
