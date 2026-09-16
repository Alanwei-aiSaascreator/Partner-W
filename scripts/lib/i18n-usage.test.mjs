import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createI18nUsageMatcher } from './i18n-usage.mjs';

test('recognizes only supported assistant preset translation member calls', () => {
  const isUsed = createI18nUsageMatcher(`
    t(preset.titleKey);
    t(preset.descriptionKey);
    t(preset.materialHintKey);
    t(preset.outputKey);
    t(preset.promptKey);
  `);

  assert.equal(isUsed('assistantWorkspaces.compass.starters.1.title'), true);
  assert.equal(isUsed('assistantWorkspaces.research.starters.3.description'), true);
  assert.equal(isUsed('assistantWorkspaces.content.starters.1.materialHint'), true);
  assert.equal(isUsed('assistantWorkspaces.video.starters.4.output'), true);
  assert.equal(isUsed('assistantWorkspaces.office.starters.2.prompt'), true);
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
