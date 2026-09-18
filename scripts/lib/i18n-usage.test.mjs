import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectLiteralKeys, createI18nUsageMatcher, findMissingLiteralKeys } from './i18n-usage.mjs';

test('recognizes only supported assistant preset translation member calls', () => {
  const isUsed = createI18nUsageMatcher(`
    t(preset.titleKey);
    t(preset.descriptionKey);
    t(preset.materialHintKey);
    t(preset.outputKey);
    t(preset.promptKey);
    t(preset.followUpPromptKey);
  `);

  assert.equal(isUsed('assistantWorkspaces.compass.starters.1.title'), true);
  assert.equal(isUsed('assistantWorkspaces.research.starters.3.description'), true);
  assert.equal(isUsed('assistantWorkspaces.content.starters.1.materialHint'), true);
  assert.equal(isUsed('assistantWorkspaces.video.starters.4.output'), true);
  assert.equal(isUsed('assistantWorkspaces.office.starters.2.prompt'), true);
  assert.equal(isUsed('assistantWorkspaces.family.starters.4.followUpPrompt'), true);
  assert.equal(isUsed('totallyUnused.title'), false);
  assert.equal(isUsed('otherNamespace.item.materialHint'), false);
  assert.equal(isUsed('assistantWorkspaces.content.starters.5.output'), false);
});

test('recognizes only definition description calls for workspace descriptions', () => {
  const isUsed = createI18nUsageMatcher(`
    t(definition.descriptionKey);
    t(definition.titleKey);
  `);

  assert.equal(isUsed('assistantWorkspaces.family.description'), true);
  assert.equal(isUsed('assistantWorkspaces.family.title'), false);
  assert.equal(isUsed('totallyUnused.title'), false);
});

test('does not treat unsupported receivers or Key members as locale usage', () => {
  const isUsed = createI18nUsageMatcher(`
    interface Preset { followUpPromptKey: string; arbitraryKey: string }
    const followUpPromptKey = preset.followUpPromptKey;
    t(other.followUpPromptKey);
    t(other.outputKey);
  `);

  assert.equal(isUsed('assistantWorkspaces.content.starters.1.followUpPrompt'), false);
  assert.equal(isUsed('assistantWorkspaces.content.starters.1.output'), false);
});

test('retains complete literal and template-prefix usage detection', () => {
  const isUsed = createI18nUsageMatcher(`
    t('common.save');
    t(\`taskWorkbench.\${key}\`);
  `);

  assert.equal(isUsed('common.save'), true);
  assert.equal(isUsed('taskWorkbench.materialHint'), true);
  assert.equal(isUsed('common.missing'), false);
});

// ── 「代码 → 词表」方向（check-i18n 的反向断言）───────────────────────────
// 只查「词表 → 代码」（未用键）时，代码引用了某个键而 9 个 locale 全缺是**查不出来**的：
// 漏的键不在 en.json 里，未用键循环根本遍历不到它，界面上直接渲染出裸键。

test('collects every literal key regardless of quotes or line breaks', () => {
  const keys = collectLiteralKeys(`
    t('common.save');
    t("common.cancel");
    t('common.save', { count: 1 });
    t(
      'common.retry',
    );
  `);

  assert.deepEqual([...keys].sort(), ['common.cancel', 'common.retry', 'common.save']);
});

test('ignores template keys, dynamic arguments and non-t() text', () => {
  const keys = collectLiteralKeys(`
    t(\`taskWorkbench.\${key}\`);
    t(dynamicKey);
    translate('common.save');
    const label = 'common.save';
  `);

  // 模板键只有前缀确定 ⇒ 不算字面量（前缀按 createI18nUsageMatcher 的既有规则处理）；
  // 变量参数、别的函数名、以及普通字符串常量都不算"代码引用了这个键"
  assert.deepEqual([...keys], []);
});

test('findMissingLiteralKeys keeps only keys absent from the locale word list', () => {
  const known = new Set(['common.save', 'beta.title']);
  const missing = findMissingLiteralKeys(
    `
      t('common.save');
      t('beta.title');
      t('beta.localDataHint');
      t('mainArea.welcomeSubtitle');
    `,
    known,
  );

  assert.deepEqual(missing, ['beta.localDataHint', 'mainArea.welcomeSubtitle']);
});

/**
 * ⭐ 负对照：**窄正则丢键 = 假绿**。
 *
 * 放宽到真实源码的形状（双引号、键与右括号不同行）之后，窄正则一条都抓不到，
 * 于是"代码里的键 ⊆ 词表"照样判为通过 —— 这正是这个检查最容易退化的方式。
 */
test('⭐ 负对照：窄正则会静默丢键（这就是假绿）', () => {
  const source = `t("common.cancel");\nt(\n  'common.retry',\n);`;

  const narrowSameLineSingleQuoteOnly = /\bt\(\s*'([^']+)'\s*\)/g;
  assert.deepEqual(
    [...source.matchAll(narrowSameLineSingleQuoteOnly)].map((m) => m[1]),
    [],
  );

  // 真实现必须把这三种形状都算成"被引用"（否则 check-i18n 会漏报缺失键）
  assert.deepEqual([...collectLiteralKeys(source)].sort(), ['common.cancel', 'common.retry']);
  assert.deepEqual(findMissingLiteralKeys(source, new Set(['common.cancel'])), ['common.retry']);
});
