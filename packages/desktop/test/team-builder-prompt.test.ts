// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  buildTeamBuilderSystemPrompt,
  defaultTeamPositionForRole,
  isTeamConfigValid,
  parseTeamConfig,
} from '../src/renderer/components/TeamBuilderDialog';
import { toSlug } from '../src/renderer/layouts/TeamsPanel/utils';

describe('AI 创建团队提示词', () => {
  it('carries the selected language into deliverables and generated identities, with user override', () => {
    const prompt = buildTeamBuilderSystemPrompt(['model-a'], 'zh');
    expect(prompt).toContain('Default response language: Simplified Chinese.');
    expect(prompt).toContain('visible text in generated pages, documents, and presentations');
    expect(prompt).toContain('Each generated identity must retain this response-language policy');
    expect(prompt).toContain('user explicitly requests another language');
  });
  it('derives stable distinct ids from Chinese AI names without changing their identity', () => {
    const names = ['\u878d\u8d44\u4e3b\u7ba1', '\u5546\u4e1a\u5206\u6790\u5e08', '\u6f14\u793a\u8bbe\u8ba1\u5e08'];
    const rawAgents = names.map((name, index) => ({
      name,
      role: index === 0 ? 'coordinator' : 'worker',
      identity: `Identity ${index}`,
    }));
    const text = '```team-config\n' + JSON.stringify({ agents: rawAgents }) + '\n```';
    const parsed = parseTeamConfig(text, []);

    expect(parsed?.agents?.map((agent) => agent.id)).toEqual(names.map(toSlug));
    expect(parseTeamConfig(text, [])).toEqual(parsed);
    expect(parsed?.agents?.map((agent) => agent.name)).toEqual(names);
    expect(parsed?.agents?.map((agent) => agent.identity)).toEqual(rawAgents.map((agent) => agent.identity));
  });

  it('deduplicates colliding normalized names within the runtime id length limit', () => {
    const names = ['\u878d\u8d44 A1', '\u5546\u4e1a A1', 'A1-2', 'x'.repeat(80), 'x'.repeat(80)];
    const text = '```team-config\n' + JSON.stringify({ agents: names.map((name) => ({ name })) }) + '\n```';
    const ids = parseTeamConfig(text, [])?.agents?.map((agent) => agent.id) ?? [];

    expect(new Set(ids).size).toBe(names.length);
    expect(ids.every((id) => typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id))).toBe(true);
    expect(parseTeamConfig(text, [])?.agents?.map((agent) => agent.id)).toEqual(ids);
  });

  it('中文界面生成中文团队名、成员名和说明，英文只保留协议枚举与模型 ID', () => {
    const prompt = buildTeamBuilderSystemPrompt(['openai/deepseek-v4-flash'], 'zh-CN');

    expect(prompt).toContain('Simplified Chinese (简体中文)');
    expect(prompt).toContain('研究分析团队');
    expect(prompt).toContain('研究主管');
    expect(prompt).toContain('数据分析师');
    expect(prompt).toContain('openai/deepseek-v4-flash');
    expect(prompt).toContain('"role":"coordinator"');
    expect(prompt).toContain('"role":"worker"');
    expect(prompt).not.toContain('MUST be in English');
    expect(prompt).not.toContain('Research Lead');
  });

  it('繁体中文界面使用繁体示例', () => {
    const prompt = buildTeamBuilderSystemPrompt(['model-a'], 'zh-TW');

    expect(prompt).toContain('Traditional Chinese (繁體中文)');
    expect(prompt).toContain('研究分析團隊');
    expect(prompt).toContain('資料分析師');
  });

  it('非中文界面仍按当前语言生成，同时维持稳定协议字段', () => {
    const prompt = buildTeamBuilderSystemPrompt(['model-a', 'model-b'], 'en');

    expect(prompt).toContain('Research Team');
    expect(prompt).toContain('model-a, model-b');
    expect(prompt).toContain('"role":"coordinator"');
  });

  it('⭐ 中文界面拒绝模型偏航出的全英文团队，避免英文配置直接安装', () => {
    expect(
      isTeamConfigValid(
        {
          name: 'Research Team',
          emoji: '🔬',
          description: 'Research and analysis',
          agents: [
            {
              name: 'Research Lead',
              role: 'coordinator',
              description: 'Coordinates research',
              model: 'model-a',
              identity: 'You coordinate the research workflow.',
            },
            {
              name: 'Analyst',
              role: 'worker',
              description: 'Analyzes data',
              model: 'model-a',
              identity: 'You analyze evidence and report findings.',
            },
          ],
        },
        'zh-CN',
      ),
    ).toBe(false);
  });

  it('⭐ 只有完整的中文身份与有效模型才能创建，空 description/identity/model 不再落盘', () => {
    const complete = {
      name: '研究团队',
      emoji: '🔬',
      description: '负责研究与分析',
      agents: [
        {
          name: '研究主管',
          role: 'coordinator' as const,
          description: '负责统筹研究',
          model: 'model-a',
          identity: '你负责制定研究计划并整合结论。',
        },
        {
          name: '数据分析师',
          role: 'worker' as const,
          description: '负责分析资料',
          model: 'model-a',
          identity: '你负责核对数据并给出可验证结论。',
        },
      ],
    };

    expect(isTeamConfigValid(complete, 'zh-CN')).toBe(true);
    expect(
      isTeamConfigValid(
        {
          ...complete,
          agents: complete.agents.map((agent, index) => (index === 1 ? { ...agent, identity: '' } : agent)),
        },
        'zh-CN',
      ),
    ).toBe(false);
  });

  it('AI 建队的讨论岗位有确定默认值：主管主持，成员是领域专家', () => {
    expect(defaultTeamPositionForRole('coordinator')).toBe('moderator');
    expect(defaultTeamPositionForRole('worker')).toBe('expert');
  });

  it('⭐ 模型给错顶层字段类型时只丢弃坏字段，不把数字/对象写进 React state 导致 trim 崩屏', () => {
    const parsed = parseTeamConfig('\n```team-config\n{"name":123,"emoji":{},"description":[],"agents":[]}\n```\n', []);

    expect(parsed).toEqual({ agents: [] });
  });
});
