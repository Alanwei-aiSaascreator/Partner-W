import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_ID_BY_WORKSPACE,
  ASSISTANT_TASK_IDS,
  ASSISTANT_TASK_PRESETS,
  resolveAssistantTaskPresets,
} from '../src/renderer/lib/assistant-task-presets';

describe('assistant task presets', () => {
  it('defines the stable task ids for all seven built-in assistants', () => {
    expect(ASSISTANT_TASK_IDS).toEqual({
      compass: ['goal-breakdown', 'execution-plan', 'option-comparison', 'comprehensive-analysis'],
      content: ['topic-planning', 'long-form-writing', 'short-video-script', 'rewrite-polish'],
      video: ['shooting-script', 'storyboard', 'editing-rhythm', 'title-cover'],
      ecommerce: ['product-copy', 'campaign-plan', 'competitor-analysis', 'review-customer-service'],
      office: ['document-writing', 'spreadsheet-analysis', 'meeting-minutes', 'presentation-outline'],
      research: ['source-organization', 'viewpoint-comparison', 'learning-plan', 'research-report'],
      family: ['travel-plan', 'family-checklist', 'purchase-comparison', 'schedule-plan'],
    });

    expect(ASSISTANT_TASK_PRESETS).toHaveLength(28);
    const presetIds = ASSISTANT_TASK_PRESETS.map((item) => item.id);
    expect(presetIds).toEqual([
      'compass:goal-breakdown',
      'compass:execution-plan',
      'compass:option-comparison',
      'compass:comprehensive-analysis',
      'content:topic-planning',
      'content:long-form-writing',
      'content:short-video-script',
      'content:rewrite-polish',
      'video:shooting-script',
      'video:storyboard',
      'video:editing-rhythm',
      'video:title-cover',
      'ecommerce:product-copy',
      'ecommerce:campaign-plan',
      'ecommerce:competitor-analysis',
      'ecommerce:review-customer-service',
      'office:document-writing',
      'office:spreadsheet-analysis',
      'office:meeting-minutes',
      'office:presentation-outline',
      'research:source-organization',
      'research:viewpoint-comparison',
      'research:learning-plan',
      'research:research-report',
      'family:travel-plan',
      'family:family-checklist',
      'family:purchase-comparison',
      'family:schedule-plan',
    ]);
    expect(new Set(presetIds).size).toBe(28);
  });

  it('defines four complete tasks for every built-in assistant', () => {
    expect(ASSISTANT_ID_BY_WORKSPACE).toEqual({
      compass: 'main',
      content: 'rongying-content',
      video: 'rongying-video',
      ecommerce: 'rongying-ecommerce',
      office: 'rongying-office',
      research: 'rongying-research',
      family: 'rongying-family',
    });

    for (const [workspaceKey, assistantId] of Object.entries(ASSISTANT_ID_BY_WORKSPACE)) {
      const presets = resolveAssistantTaskPresets(assistantId);
      expect(presets).toHaveLength(4);
      for (const [index, preset] of presets.entries()) {
        expect(preset.assistantId).toBe(assistantId);
        expect(preset.workspaceKey).toBe(workspaceKey);
        expect(preset.id).toBe(`${workspaceKey}:${ASSISTANT_TASK_IDS[preset.workspaceKey][index]}`);

        const keyPrefix = `assistantWorkspaces.${workspaceKey}.starters.${index + 1}`;
        expect(preset.titleKey).toBe(`${keyPrefix}.title`);
        expect(preset.descriptionKey).toBe(`${keyPrefix}.description`);
        expect(preset.promptKey).toBe(`${keyPrefix}.prompt`);
        expect(preset.materialHintKey).toBe(`${keyPrefix}.materialHint`);
        expect(preset.outputKey).toBe(`${keyPrefix}.output`);
        expect(preset.followUpPromptKey).toBe(`${keyPrefix}.followUpPrompt`);
      }
    }
  });

  it('fails closed for a custom or unknown assistant', () => {
    expect(resolveAssistantTaskPresets('customer-imported-agent')).toEqual([]);
    expect(resolveAssistantTaskPresets('rongying-content-copy')).toEqual([]);
  });
});
