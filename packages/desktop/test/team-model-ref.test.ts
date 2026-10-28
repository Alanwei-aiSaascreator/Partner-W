import { describe, expect, it } from 'vitest';
import type { ModelCatalogEntry } from '@clawwork/shared';
import { canonicalModelRef, resolveTeamModelRef } from '../src/renderer/lib/team-model-ref';

const models: ModelCatalogEntry[] = [
  { id: 'deepseek-v4-flash', provider: 'clawrouter', name: 'DeepSeek V4 Flash' },
  { id: 'clawrouter/qwen3.5-plus', provider: 'clawrouter', name: 'Qwen 3.5 Plus' },
];

describe('团队模型引用', () => {
  it('把目录里的短 id 变成网关需要的 provider/model 引用', () => {
    expect(canonicalModelRef(models[0])).toBe('clawrouter/deepseek-v4-flash');
    expect(canonicalModelRef(models[1])).toBe('clawrouter/qwen3.5-plus');
  });

  it('接受目录中的短 id、完整引用和展示名', () => {
    expect(resolveTeamModelRef('deepseek-v4-flash', models)).toBe('clawrouter/deepseek-v4-flash');
    expect(resolveTeamModelRef('clawrouter/qwen3.5-plus', models)).toBe('clawrouter/qwen3.5-plus');
    expect(resolveTeamModelRef('DeepSeek V4 Flash', models)).toBe('clawrouter/deepseek-v4-flash');
  });

  it('纠正模型返回的错误 openai provider，不让国内模型误走 Codex harness', () => {
    expect(resolveTeamModelRef('openai/deepseek-v4-flash', models)).toBe('clawrouter/deepseek-v4-flash');
  });

  it('目录里没有的模型不写入助手，改用网关默认模型', () => {
    expect(resolveTeamModelRef('gpt-4', models)).toBe('');
    expect(resolveTeamModelRef('openai/unknown-model', models)).toBe('');
  });

  it('网关标成 unavailable 的模型不能写入助手', () => {
    expect(
      resolveTeamModelRef('deepseek-v4-flash', [
        { ...models[0], available: false, unavailableReason: 'agent harness unavailable' },
      ]),
    ).toBe('');
  });
});
