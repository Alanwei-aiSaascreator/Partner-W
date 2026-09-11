import { test, expect } from 'vitest';
import {
  modelFamilyKey,
  modelFamilyLabel,
  RELAY_PROVIDER_ID,
} from '../src/renderer/components/ChatInput/model-families.js';

/**
 * 背景（2026-09-11）：模型下拉里堆着上千个我们服务不了的模型（openclaw 全量目录），
 * 用户选到就会失败、且请求根本不发出去。要「只列能用的 + 按家族分组」。
 */

test('家族取开头的连续字母 —— 数字和点属于版本号，不是家族名', () => {
  expect(modelFamilyKey('deepseek-v4-flash')).toBe('deepseek');
  expect(modelFamilyKey('qwen3.6-plus')).toBe('qwen');
  expect(modelFamilyKey('qwen-turbo')).toBe('qwen');
  expect(modelFamilyKey('glm-4.6')).toBe('glm');
});

test('同一个家族的不同版本归到一类', () => {
  const group = new Set(['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v3.2', 'deepseek-r1'].map(modelFamilyKey));
  expect([...group]).toEqual(['deepseek']);
});

test('展示名用规范大小写', () => {
  expect(modelFamilyLabel('deepseek-v4-pro')).toBe('DeepSeek');
  expect(modelFamilyLabel('qwen3-max')).toBe('Qwen');
  expect(modelFamilyLabel('glm-4.6')).toBe('GLM');
});

test('认不出来归 other，**不猜** —— 猜错会把两个不相干的模型并到一起', () => {
  expect(modelFamilyKey('4x-turbo')).toBe('other');
  expect(modelFamilyLabel('4x-turbo')).toBe('其他');
});

test('首字母大写的输入也要认（模型名可能被规范化过）', () => {
  expect(modelFamilyKey('DeepSeek-V4-Flash')).toBe('deepseek');
});

test('中转 provider 的 id 就这一个 —— 改了要同步改筛法', () => {
  expect(RELAY_PROVIDER_ID).toBe('clawrouter');
});
