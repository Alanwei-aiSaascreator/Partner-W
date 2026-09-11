/**
 * 模型列表的「只列能用的 + 按家族分组」。
 *
 * ## 为什么必须过滤
 *
 * 网关的 `models.list` 返回的是 **openclaw 的全量模型目录**（实测 44 个 provider、
 * 1018 个模型），里面绝大多数**我们服务不了** —— 没有对应的 provider 配置。
 * 用户在里面随便挑一个（比如 `deepseek-v4-pro` 之外的 `claude-opus-4`），
 * 得到的是一条失败消息，而且**请求根本没发出去**。
 *
 * 2026-09-11 实测：会话选了非中转模型后，网关日志是
 * `agent errorCode=UNAVAILABLE errorMessage=The selected model was not found by the provider`。
 *
 * ⇒ 只列中转服务真正提供的那些（网关侧它们的 provider 是 `clawrouter`）。
 *
 * ⚠️ 这是**按名字**筛。主进程那边的用量去重刻意用了「按 baseUrl 认」而不是按名字
 *（名字用户可改）。这里做不到 —— 渲染层拿不到网关配置。留作已知局限：
 * 将来若允许用户自定义 provider，这个筛法要跟着改。
 */
export const RELAY_PROVIDER_ID = 'clawrouter';

/** 家族展示名。键是小写前缀。 */
const FAMILY_LABELS: Record<string, string> = {
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  glm: 'GLM',
  kimi: 'Kimi',
  moonshot: 'Kimi',
  minimax: 'MiniMax',
  abab: 'MiniMax',
  llama: 'Llama',
  gpt: 'GPT',
  claude: 'Claude',
  gemini: 'Gemini',
};

/**
 * 从模型 id 取出家族键。`deepseek-v4-flash` → `deepseek`；`qwen3.6-plus` → `qwen`。
 *
 * 取**开头连续字母**作前缀 —— 数字和点属于版本，不是家族名。
 * 认不出来就归到 `other`，**不猜**（猜错会把两个不相干的模型并到一起）。
 */
export function modelFamilyKey(modelId: string): string {
  const m = /^[a-z]+/i.exec(modelId.trim());
  return m ? m[0].toLowerCase() : 'other';
}

/** 家族展示名；认不出时用 `other`。 */
export function modelFamilyLabel(modelId: string): string {
  const key = modelFamilyKey(modelId);
  if (FAMILY_LABELS[key]) return FAMILY_LABELS[key];
  return key === 'other' ? '其他' : key.charAt(0).toUpperCase() + key.slice(1);
}
