export const ASSISTANT_TASK_IDS = {
  compass: ['goal-breakdown', 'execution-plan', 'option-comparison', 'comprehensive-analysis'],
  content: ['topic-planning', 'long-form-writing', 'short-video-script', 'rewrite-polish'],
  video: ['shooting-script', 'storyboard', 'editing-rhythm', 'title-cover'],
  ecommerce: ['product-copy', 'campaign-plan', 'competitor-analysis', 'review-customer-service'],
  office: ['document-writing', 'spreadsheet-analysis', 'meeting-minutes', 'presentation-outline'],
  research: ['source-organization', 'viewpoint-comparison', 'learning-plan', 'research-report'],
  family: ['travel-plan', 'family-checklist', 'purchase-comparison', 'schedule-plan'],
} as const;

export type AssistantTaskWorkspaceKey = keyof typeof ASSISTANT_TASK_IDS;

export type BuiltInAssistantId =
  | 'main'
  | 'rongying-content'
  | 'rongying-video'
  | 'rongying-ecommerce'
  | 'rongying-office'
  | 'rongying-research'
  | 'rongying-family';

export const ASSISTANT_ID_BY_WORKSPACE = {
  compass: 'main',
  content: 'rongying-content',
  video: 'rongying-video',
  ecommerce: 'rongying-ecommerce',
  office: 'rongying-office',
  research: 'rongying-research',
  family: 'rongying-family',
} as const satisfies Record<AssistantTaskWorkspaceKey, BuiltInAssistantId>;

export interface AssistantTaskPreset {
  id: string;
  assistantId: BuiltInAssistantId;
  workspaceKey: AssistantTaskWorkspaceKey;
  titleKey: string;
  descriptionKey: string;
  promptKey: string;
  materialHintKey: string;
  outputKey: string;
  followUpPromptKey: string;
}

function typedKeys<T extends object>(value: T): Array<Extract<keyof T, string>> {
  return Object.keys(value) as Array<Extract<keyof T, string>>;
}

export const ASSISTANT_TASK_PRESETS: readonly AssistantTaskPreset[] = typedKeys(ASSISTANT_TASK_IDS).flatMap(
  (workspaceKey) => {
    const assistantId = ASSISTANT_ID_BY_WORKSPACE[workspaceKey];
    const ids = ASSISTANT_TASK_IDS[workspaceKey];

    return ids.map((id, index) => {
      const root = `assistantWorkspaces.${workspaceKey}.starters.${index + 1}`;
      return {
        id: `${workspaceKey}:${id}`,
        assistantId,
        workspaceKey,
        titleKey: `${root}.title`,
        descriptionKey: `${root}.description`,
        promptKey: `${root}.prompt`,
        materialHintKey: `${root}.materialHint`,
        outputKey: `${root}.output`,
        followUpPromptKey: `${root}.followUpPrompt`,
      };
    });
  },
);

export function resolveAssistantTaskPresets(agentId: string): readonly AssistantTaskPreset[] {
  return ASSISTANT_TASK_PRESETS.filter((item) => item.assistantId === agentId);
}
