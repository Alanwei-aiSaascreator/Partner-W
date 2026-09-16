export interface PendingAttachment {
  file: File;
  previewUrl: string;
}

export interface DraftPromptRequest {
  id: string;
  prompt: string;
  presetId?: string;
  source: 'assistant-template' | 'goal-routing' | 'first-task-follow-up' | 'result-action';
}

export type DraftPromptResolution = 'applied' | 'appended' | 'replaced' | 'cancelled';
