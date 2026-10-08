/**
 * 「审核必须换另一家厂商」的厂商标识。
 *
 * 中转目录里所有模型的 `provider` 都是 `clawrouter`（见 model-families 的 RELAY_PROVIDER_ID），
 * 真正区分厂商的是模型 id 的家族前缀：deepseek-v4-flash / kimi-k3 / qwen3.5-27b / glm-4.7 / MiniMax-M2.5 …
 * 所以这里按**家族前缀**归并，不读 provider 字段。
 */
const VENDOR_PREFIXES = [
  'deepseek',
  'qwen',
  'kimi',
  'moonshot',
  'glm',
  'zhipu',
  'minimax',
  'claude',
  'gpt',
  'gemini',
  'grok',
  'ernie',
  'doubao',
  'hunyuan',
] as const;

const VENDOR_ALIASES: Record<string, string> = { moonshot: 'kimi', zhipu: 'glm' };

/** 从模型 id 或规范引用（`clawrouter/kimi-k3`）取厂商；认不出来返回空串（调用方应放行）。 */
export function modelVendor(modelOrRef: string): string {
  const tail = modelOrRef.trim().split('/').at(-1)?.toLowerCase() ?? '';
  if (!tail) return '';
  for (const prefix of VENDOR_PREFIXES) {
    if (tail.startsWith(prefix)) return VENDOR_ALIASES[prefix] ?? prefix;
  }
  return tail.split(/[-_.\d]/)[0] ?? '';
}

/** 两个模型是否来自不同厂商；任一侧认不出来都视为「满足」（不误拦）。 */
export function vendorsDistinct(a: string, b: string): boolean {
  const va = modelVendor(a);
  const vb = modelVendor(b);
  return !va || !vb || va !== vb;
}
