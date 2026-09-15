import type { OnboardingProfile } from '@/lib/user-onboarding';
import { goalAnalysisVersion } from '@/lib/user-onboarding';
import { PRESET_AGENT_IDS, type PresetAgentId } from '@/lib/preset-agents';

export interface GoalAnalysisStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

interface GoalAnalysisBase {
  summary: string;
  reason: string;
  model: string;
  starters: [string, string, string];
}

export interface PresetGoalAnalysis extends GoalAnalysisBase {
  kind: 'preset';
  assistantId: PresetAgentId;
}

export interface CustomGoalAnalysis extends GoalAnalysisBase {
  kind: 'custom';
  draft: {
    name: string;
    description: string;
    identity: string;
    boundaries: string;
  };
}

export type GoalAnalysisResult = PresetGoalAnalysis | CustomGoalAnalysis;

const RESULT_RE = /```goal-analysis\s*([\s\S]*?)\s*```/;
const STORAGE_PREFIX = 'rongying-cube:goal-analysis:v1:';
const BASE_KEYS = new Set(['kind', 'summary', 'reason', 'model', 'starters', 'assistantId', 'draft']);
const DRAFT_KEYS = new Set(['name', 'description', 'identity', 'boundaries']);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return null;
  return normalized;
}

function threeStarters(value: unknown): [string, string, string] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const parsed = value.map((item) => boundedString(item, 160));
  if (parsed.some((item) => item === null)) return null;
  return parsed as [string, string, string];
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

export function parseGoalAnalysis(content: string): GoalAnalysisResult | null {
  const match = content.match(RESULT_RE);
  if (!match) return null;

  try {
    const value = record(JSON.parse(match[1]));
    if (!value || !hasOnlyKeys(value, BASE_KEYS)) return null;
    const summary = boundedString(value.summary, 240);
    const reason = boundedString(value.reason, 400);
    const model = boundedString(value.model, 160);
    const starters = threeStarters(value.starters);
    if (!summary || !reason || !model || !starters) return null;

    if (value.kind === 'preset') {
      if (typeof value.assistantId !== 'string') return null;
      if (!PRESET_AGENT_IDS.includes(value.assistantId as PresetAgentId)) return null;
      return { kind: 'preset', assistantId: value.assistantId as PresetAgentId, summary, reason, model, starters };
    }

    if (value.kind === 'custom') {
      const draft = record(value.draft);
      if (!draft || !hasOnlyKeys(draft, DRAFT_KEYS)) return null;
      const name = boundedString(draft.name, 80);
      const description = boundedString(draft.description, 200);
      const identity = boundedString(draft.identity, 2_400);
      const boundaries = boundedString(draft.boundaries, 600);
      if (!name || !/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(name) || !description || !identity || !boundaries) return null;
      return {
        kind: 'custom',
        summary,
        reason,
        model,
        starters,
        draft: { name, description, identity, boundaries },
      };
    }

    return null;
  } catch {
    return null;
  }
}

export function buildGoalAnalysisPrompt(profile: OnboardingProfile, modelIds: readonly string[]): string {
  return `你是荣盈魔方的目标分析器。只分析用户主动填写的目标，不要声称已经查看电脑、文件或外部数据。

用户常用场景：${profile.useCases.join('、') || '未选择'}
用户目标：${profile.customGoal.trim()}
可用预置助手：${PRESET_AGENT_IDS.join('、')}
可用模型：${modelIds.join('、') || 'deepseek-v4-flash'}

优先匹配预置助手。只有六个助手都不适合时才返回 custom。输出必须以一个 \`\`\`goal-analysis JSON 代码块结束，不要增加其他字段。

preset 格式：{"kind":"preset","assistantId":"rongying-content","summary":"目标摘要","reason":"推荐理由","model":"deepseek-v4-flash","starters":["任务1","任务2","任务3"]}
custom 格式：{"kind":"custom","summary":"目标摘要","reason":"为什么需要专属助手","model":"deepseek-v4-flash","starters":["任务1","任务2","任务3"],"draft":{"name":"ASCII Name","description":"一句职责","identity":"简洁系统角色提示","boundaries":"不能做或需要确认的边界"}}`;
}

export function goalAnalysisStorageKey(profile: OnboardingProfile): string {
  return `${STORAGE_PREFIX}${profile.userId}:${goalAnalysisVersion(profile)}`;
}

export function loadGoalAnalysis(
  profile: OnboardingProfile,
  storage: GoalAnalysisStorage = window.localStorage,
): GoalAnalysisResult | null {
  try {
    const raw = storage.getItem(goalAnalysisStorageKey(profile));
    if (!raw) return null;
    return parseGoalAnalysis(`\`\`\`goal-analysis\n${raw}\n\`\`\``);
  } catch {
    return null;
  }
}

export function saveGoalAnalysis(
  profile: OnboardingProfile,
  result: GoalAnalysisResult,
  storage: GoalAnalysisStorage = window.localStorage,
): void {
  storage.setItem(goalAnalysisStorageKey(profile), JSON.stringify(result));
}
