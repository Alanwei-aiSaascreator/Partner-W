import { describe, expect, it } from 'vitest';
import type { OnboardingProfile } from '../src/renderer/lib/user-onboarding';
import {
  buildGoalAnalysisPrompt,
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

/**
 * 目标分析**提示词**（2026-10-10 Cephalon 批）——三处旧的 `deepseek-v4-flash`
 * 硬编码改为"目录现状"：优先智能档默认（glm-5.3-flash）；目录没有它时只选
 * 实际存在的首个目录项；目录未取得时**明确未取得**，不许拿格式示例当可用能力证明。
 * ⚠️ 只改提示串；解析器对旧模型 ID 的兼容、用户已保存的旧推荐/选择/历史缓存一律不动。
 */
describe('goal analysis — 提示词里的模型字段（复用目录现状，不硬编码旧 DeepSeek）', () => {
  it('⭐ 优先使用目录里的 glm-5.3-flash；格式示例引用它而不是旧 DeepSeek', () => {
    const prompt = buildGoalAnalysisPrompt(profile, ['deepseek-v4-flash', 'glm-5.3-flash']);
    expect(prompt).toContain('可用模型：deepseek-v4-flash、glm-5.3-flash');
    expect(prompt).toContain('"model":"glm-5.3-flash"');
    expect(prompt).not.toContain('"model":"deepseek-v4-flash"');
  });

  it('目录里没有 glm ⇒ 只选实际存在的目录项，绝不虚构', () => {
    const prompt = buildGoalAnalysisPrompt(profile, ['deepseek-v4-flash']);
    expect(prompt).toContain('可用模型：deepseek-v4-flash');
    expect(prompt).toContain('"model":"deepseek-v4-flash"');
  });

  it('⭐ 目录未取得 ⇒ 明确未取得、不许编造模型名，并要求不要输出代码块', () => {
    const prompt = buildGoalAnalysisPrompt(profile, []);
    expect(prompt).toContain('（目录尚未取到）');
    expect(prompt).not.toContain('glm-5.3-flash');
    expect(prompt).not.toContain('deepseek-v4-flash');
    expect(prompt).toContain('不要输出 goal-analysis 代码块');
  });
});
