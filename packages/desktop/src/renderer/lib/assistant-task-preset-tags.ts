import { ASSISTANT_TASK_PRESETS } from './assistant-task-presets';

export const ASSISTANT_TASK_PRESET_TAG_PREFIX = 'assistant-task-preset:';

const CANONICAL_PRESET_IDS = new Set(ASSISTANT_TASK_PRESETS.map((preset) => preset.id));

function isCanonicalPresetId(value: string): boolean {
  return CANONICAL_PRESET_IDS.has(value);
}

export function encodeAssistantTaskPresetTag(presetId: string): string | null {
  return isCanonicalPresetId(presetId) ? `${ASSISTANT_TASK_PRESET_TAG_PREFIX}${presetId}` : null;
}

export function resolveAssistantTaskPresetIdFromTags(tags: readonly string[]): string | null {
  for (const tag of tags) {
    if (!tag.startsWith(ASSISTANT_TASK_PRESET_TAG_PREFIX)) continue;
    const presetId = tag.slice(ASSISTANT_TASK_PRESET_TAG_PREFIX.length);
    if (isCanonicalPresetId(presetId)) return presetId;
  }
  return null;
}

export function upsertAssistantTaskPresetTag(tags: readonly string[], presetId: string): string[] {
  const nonPresetTags = tags.filter((tag) => !tag.startsWith(ASSISTANT_TASK_PRESET_TAG_PREFIX));
  const presetTag = encodeAssistantTaskPresetTag(presetId);
  return presetTag ? [...nonPresetTags, presetTag] : nonPresetTags;
}
