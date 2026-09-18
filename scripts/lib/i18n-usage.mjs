/**
 * 代码里**字面量**写死的翻译键：`t('common.save')` / `t("common.save")` / `t('common.save', { … })`。
 *
 * ⚠️ 模板键（`` t(`taskWorkbench.${key}`) ``）**不算字面量** —— 它只有前缀是确定的，
 *    前缀按 `createI18nUsageMatcher` 的既有规则处理，不参与「代码 → 词表」的反向断言。
 * ⚠️ 正则必须**两种引号都能认、且允许键与右括号不在同一行**：窄正则（只认单引号、
 *    或要求 `t('x')` 同行闭合）会**静默漏键** —— 漏掉的键照样"检查通过"，这就是假绿。
 *    负对照见 `i18n-usage.test.mjs`。
 */
const literalKeyRe = /\bt\(\s*(['"])((?:(?!\1)[^\\\n])*)\1/g;

export function collectLiteralKeys(sourceText) {
  const keys = new Set();
  literalKeyRe.lastIndex = 0;
  let match;
  while ((match = literalKeyRe.exec(sourceText)) !== null) {
    keys.add(match[2]);
  }
  return keys;
}

/**
 * 「代码 → 词表」方向的判定：代码里字面量引用了、但词表（en.json）里没有的键。
 * 排序后返回，便于报错信息稳定可对比。
 */
export function findMissingLiteralKeys(sourceText, knownKeys) {
  const missing = [];
  for (const key of collectLiteralKeys(sourceText)) {
    if (!knownKeys.has(key)) missing.push(key);
  }
  return missing.sort();
}

export function createI18nUsageMatcher(sourceText) {
  const dynamicPrefixRe = /t\(\s*`([^$`]+)\$\{/g;
  const dynamicPrefixes = [];
  let match;
  while ((match = dynamicPrefixRe.exec(sourceText)) !== null) {
    dynamicPrefixes.push(match[1]);
  }

  const workspaceSegment = '(?:compass|content|video|ecommerce|office|research|family)';
  const presetLeaves = ['title', 'description', 'prompt', 'materialHint', 'output', 'followUpPrompt'];
  const usedPresetPatterns = [];
  for (const leaf of presetLeaves) {
    const callRe = new RegExp(`\\bt\\(\\s*preset\\.${leaf}Key\\s*(?=[,)])`);
    if (callRe.test(sourceText)) {
      usedPresetPatterns.push(new RegExp(`^assistantWorkspaces\\.${workspaceSegment}\\.starters\\.[1-4]\\.${leaf}$`));
    }
  }

  const definitionDescriptionUsed = /\bt\(\s*definition\.descriptionKey\s*(?=[,)])/.test(sourceText);
  const workspaceDescriptionRe = new RegExp(`^assistantWorkspaces\\.${workspaceSegment}\\.description$`);

  return (key) =>
    sourceText.includes(key) ||
    dynamicPrefixes.some((prefix) => key.startsWith(prefix)) ||
    usedPresetPatterns.some((pattern) => pattern.test(key)) ||
    (definitionDescriptionUsed && workspaceDescriptionRe.test(key));
}
