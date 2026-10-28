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
  | 'partner-w-content'
  | 'partner-w-video'
  | 'partner-w-ecommerce'
  | 'partner-w-office'
  | 'partner-w-research'
  | 'partner-w-family';

export const ASSISTANT_ID_BY_WORKSPACE = {
  compass: 'main',
  content: 'partner-w-content',
  video: 'partner-w-video',
  ecommerce: 'partner-w-ecommerce',
  office: 'partner-w-office',
  research: 'partner-w-research',
  family: 'partner-w-family',
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
