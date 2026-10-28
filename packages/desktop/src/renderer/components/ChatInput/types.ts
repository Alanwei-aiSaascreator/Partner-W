export interface PendingAttachment {
  file: File;
  previewUrl: string;
}

export interface DraftPromptRequest {
  id: string;
  prompt: string;
  presetId?: string;
  /**
   * 这句话从哪来（只作来源标注，没有分支逻辑读它）。
   *
   * ⚠️ `expert-launch` 是 2026-10-16（全量总单第 24 行）加的：专家库卡片点了一下。
   *    它**不带 `presetId`** —— 专家不是 `ASSISTANT_TASK_PRESETS` 里的任务预设，
   *    所以"记进最近任务"那条路（`handleDraftResolved` 里按 presetId 走）不会触发。
   */
  source: 'assistant-template' | 'goal-routing' | 'first-task-follow-up' | 'result-action' | 'expert-launch';
  /**
   * 落进输入框后**立刻发送**（2026-10-17 用户：专家库点「开个任务」只得到一句草稿，
   * 看起来像没生效）。只给专家启动用 —— 它已经先问过"要请这位专家做什么"，
   * 用户点过确认，就该直接开跑。
   */
  autoSend?: boolean;
}

export type DraftPromptResolution = 'applied' | 'appended' | 'replaced' | 'cancelled';
