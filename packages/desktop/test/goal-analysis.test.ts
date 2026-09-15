import { describe, expect, it } from 'vitest';
import type { OnboardingProfile } from '../src/renderer/lib/user-onboarding';
import {
  goalAnalysisStorageKey,
  loadGoalAnalysis,
  parseGoalAnalysis,
  saveGoalAnalysis,
  type GoalAnalysisStorage,
} from '../src/renderer/features/goal-routing/goal-analysis';

function memoryStorage(): GoalAnalysisStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

const profile: OnboardingProfile = {
  version: 1,
  userId: 'user-1',
  nickname: '小荣',
  useCases: ['content'],
  customGoal: '每周生成三个短视频脚本',
  completedAt: '2026-09-15T00:00:00.000Z',
};

describe('goal analysis', () => {
  it('parses a fenced recommendation for a known preset assistant', () => {
    const result = parseGoalAnalysis(`说明文字
\`\`\`goal-analysis
{"kind":"preset","assistantId":"rongying-content","summary":"短视频内容","reason":"需要选题和脚本","model":"deepseek-v4-flash","starters":["整理素材","生成选题","写脚本"]}
\`\`\``);

    expect(result).toEqual({
      kind: 'preset',
      assistantId: 'rongying-content',
      summary: '短视频内容',
      reason: '需要选题和脚本',
      model: 'deepseek-v4-flash',
      starters: ['整理素材', '生成选题', '写脚本'],
    });
  });

  it('parses a complete custom assistant draft', () => {
    const result = parseGoalAnalysis(`\`\`\`goal-analysis
{"kind":"custom","summary":"周更播客","reason":"现有助手不覆盖音频制作","model":"deepseek-v4-flash","starters":["确定主题","整理提纲","生成节目单"],"draft":{"name":"Podcast Planner","description":"规划播客选题、提纲和节目流程","identity":"你是播客策划助手，只根据用户提供的资料规划节目。","boundaries":"不声称已录音或发布节目。"}}
\`\`\``);

    expect(result?.kind).toBe('custom');
    if (result?.kind === 'custom') expect(result.draft.name).toBe('Podcast Planner');
  });

  it('rejects unknown assistants and incomplete custom drafts', () => {
    expect(
      parseGoalAnalysis(
        '```goal-analysis\n{"kind":"preset","assistantId":"mystery","summary":"x","reason":"y","model":"deepseek-v4-flash","starters":["1","2","3"]}\n```',
      ),
    ).toBeNull();
    expect(
      parseGoalAnalysis(
        '```goal-analysis\n{"kind":"custom","summary":"x","reason":"y","model":"deepseek-v4-flash","starters":["1","2","3"],"draft":{"name":"Helper"}}\n```',
      ),
    ).toBeNull();
  });

  it('stores a successful result by account and normalized goal version', () => {
    const storage = memoryStorage();
    const result = parseGoalAnalysis(
      '```goal-analysis\n{"kind":"preset","assistantId":"rongying-content","summary":"短视频内容","reason":"需要选题和脚本","model":"deepseek-v4-flash","starters":["整理素材","生成选题","写脚本"]}\n```',
    );
    expect(result).not.toBeNull();

    saveGoalAnalysis(profile, result!, storage);

    expect(loadGoalAnalysis(profile, storage)).toEqual(result);
    expect(goalAnalysisStorageKey(profile)).toContain('user-1');
    expect(loadGoalAnalysis({ ...profile, customGoal: '另一个目标' }, storage)).toBeNull();
  });
});
