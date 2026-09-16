export function createI18nUsageMatcher(sourceText) {
  const dynamicPrefixRe = /t\(\s*`([^$`]+)\$\{/g;
  const dynamicPrefixes = [];
  let match;
  while ((match = dynamicPrefixRe.exec(sourceText)) !== null) {
    dynamicPrefixes.push(match[1]);
  }

  const workspaceSegment = '(?:compass|content|video|ecommerce|office|research|family)';
  const presetLeaves = ['title', 'description', 'prompt', 'materialHint', 'output'];
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
