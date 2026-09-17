import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_TASK_PRESET_TAG_PREFIX,
  encodeAssistantTaskPresetTag,
  resolveAssistantTaskPresetIdFromTags,
  upsertAssistantTaskPresetTag,
} from '../src/renderer/lib/assistant-task-preset-tags';

describe('assistant task preset tags', () => {
  it('encodes and resolves only canonical preset ids', () => {
    expect(encodeAssistantTaskPresetTag('content:short-video-script')).toBe(
      `${ASSISTANT_TASK_PRESET_TAG_PREFIX}content:short-video-script`,
    );
    expect(encodeAssistantTaskPresetTag('content:unknown')).toBeNull();
    expect(
      resolveAssistantTaskPresetIdFromTags([
        'private',
        `${ASSISTANT_TASK_PRESET_TAG_PREFIX}content:unknown`,
        `${ASSISTANT_TASK_PRESET_TAG_PREFIX}content:short-video-script`,
      ]),
    ).toBe('content:short-video-script');
    expect(resolveAssistantTaskPresetIdFromTags([`${ASSISTANT_TASK_PRESET_TAG_PREFIX}content:unknown`])).toBeNull();
  });

  it('preserves ordinary tags and replaces every preset tag with one canonical tag', () => {
    expect(
      upsertAssistantTaskPresetTag(
        [
          'private',
          `${ASSISTANT_TASK_PRESET_TAG_PREFIX}content:topic-planning`,
          `${ASSISTANT_TASK_PRESET_TAG_PREFIX}content:unknown`,
          'important',
        ],
        'video:storyboard',
      ),
    ).toEqual(['private', 'important', `${ASSISTANT_TASK_PRESET_TAG_PREFIX}video:storyboard`]);
  });

  it('fails closed for an unknown preset without retaining preset-like tags', () => {
    expect(
      upsertAssistantTaskPresetTag(
        ['private', `${ASSISTANT_TASK_PRESET_TAG_PREFIX}content:topic-planning`],
        'custom:secret prompt',
      ),
    ).toEqual(['private']);
  });
});
