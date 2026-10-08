import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TASK_MODE,
  FAST_MODEL_ALIAS_ID,
  MODE_BASE_MODEL_ID,
  MODE_POLICY,
  TASK_MODES,
  isModeAliasModelId,
  isTaskMode,
  normalizeTaskMode,
  normalizeTaskModeSetting,
  resolveEffectiveTaskMode,
  resolveModeModelId,
} from '../src/index.js';

/**
 * 任务模式映射（快速 / 智能 / 深度）—— **单一真源**的纯函数面。
 *
 * 这里钉三件事（错了就是用户白发一轮钱或模式被静默换掉）：
 *   1. 三档 → 模型/思考档的映射本身；
 *   2. 快速档的**别名回退**（别名是另一路并行上线的 relay 条目，目录里没有时
 *      必须优雅回退到 `qwen3.7-flash`，而不是发一个目录里不存在的模型）；
 *   3. **存量保护**：旧行（mode 为空）一律按 custom 处理 —— 不得劫持其既有
 *      `task.model`（用户以前选过的具体模型）。
 */
describe('任务模式映射（单一真源）', () => {
  it('三档顺序与默认档 = 智能', () => {
    expect(TASK_MODES).toEqual(['fast', 'smart', 'deep']);
    expect(DEFAULT_TASK_MODE).toBe('smart');
  });

  it('MODE_POLICY：快速=别名+minimal、智能=基础+medium、深度=基础+high', () => {
    expect(MODE_POLICY.fast).toEqual({ modelId: FAST_MODEL_ALIAS_ID, thinkingLevel: 'minimal' });
    expect(MODE_POLICY.smart).toEqual({ modelId: MODE_BASE_MODEL_ID, thinkingLevel: 'medium' });
    expect(MODE_POLICY.deep).toEqual({ modelId: MODE_BASE_MODEL_ID, thinkingLevel: 'high' });
  });

  it('别名 = qwen3.7-flash-fast；基础模型 = qwen3.7-flash（id 本体，不带 clawrouter/ 前缀）', () => {
    expect(FAST_MODEL_ALIAS_ID).toBe('qwen3.7-flash-fast');
    expect(MODE_BASE_MODEL_ID).toBe('qwen3.7-flash');
  });

  describe('resolveModeModelId（对着目录解析）', () => {
    it('别名在目录 ⇒ 快速档用别名', () => {
      expect(resolveModeModelId('fast', ['deepseek-v4-flash', FAST_MODEL_ALIAS_ID])).toBe(FAST_MODEL_ALIAS_ID);
    });

    it('⭐ 别名不在目录 ⇒ 快速档优雅回退到 qwen3.7-flash', () => {
      expect(resolveModeModelId('fast', ['deepseek-v4-flash', MODE_BASE_MODEL_ID])).toBe(MODE_BASE_MODEL_ID);
    });

    it('智能 / 深度固定用 qwen3.7-flash（不看别名）', () => {
      const catalog = [FAST_MODEL_ALIAS_ID, MODE_BASE_MODEL_ID];
      expect(resolveModeModelId('smart', catalog)).toBe(MODE_BASE_MODEL_ID);
      expect(resolveModeModelId('deep', catalog)).toBe(MODE_BASE_MODEL_ID);
    });

    it('两个都没有 ⇒ undefined（调用方保持现状、不拦截）', () => {
      expect(resolveModeModelId('fast', ['deepseek-v4-flash'])).toBeUndefined();
      expect(resolveModeModelId('smart', ['deepseek-v4-flash'])).toBeUndefined();
      expect(resolveModeModelId('deep', [])).toBeUndefined();
    });

    it('目录 id 带命名空间（clawrouter/…）也认，返回**目录里那个 id 本体**', () => {
      expect(resolveModeModelId('smart', ['clawrouter/qwen3.7-flash'])).toBe('clawrouter/qwen3.7-flash');
      expect(resolveModeModelId('fast', ['clawrouter/qwen3.7-flash-fast'])).toBe('clawrouter/qwen3.7-flash-fast');
    });
  });

  describe('别名在高级列表里隐藏', () => {
    it('别名 id 被认出（含带命名空间的写法）', () => {
      expect(isModeAliasModelId(FAST_MODEL_ALIAS_ID)).toBe(true);
      expect(isModeAliasModelId(`clawrouter/${FAST_MODEL_ALIAS_ID}`)).toBe(true);
    });

    it('基础模型与普通模型不是别名', () => {
      expect(isModeAliasModelId(MODE_BASE_MODEL_ID)).toBe(false);
      expect(isModeAliasModelId('deepseek-v4-flash')).toBe(false);
    });
  });

  describe('存量保护：mode 为空 ⇒ custom（不劫持既有 task.model）', () => {
    it('⭐ 旧行（有 model、无 mode）⇒ custom', () => {
      expect(resolveEffectiveTaskMode({ model: 'deepseek-v4-pro' })).toBe('custom');
      expect(resolveEffectiveTaskMode({ mode: null, model: 'deepseek-v4-pro' })).toBe('custom');
    });

    it('旧行（无 model、无 mode）⇒ 仍是 custom —— "一律按 custom"是硬要求', () => {
      expect(resolveEffectiveTaskMode({})).toBe('custom');
      expect(resolveEffectiveTaskMode({ mode: null })).toBe('custom');
    });

    it('显式 mode 原样生效', () => {
      expect(resolveEffectiveTaskMode({ mode: 'fast' })).toBe('fast');
      expect(resolveEffectiveTaskMode({ mode: 'smart', model: 'deepseek-v4-pro' })).toBe('smart');
      expect(resolveEffectiveTaskMode({ mode: 'deep' })).toBe('deep');
      expect(resolveEffectiveTaskMode({ mode: 'custom' })).toBe('custom');
    });

    it('脏值（不是四选一）⇒ 当作旧的空值处理（custom），不猜', () => {
      expect(resolveEffectiveTaskMode({ mode: 'turbo' })).toBe('custom');
      expect(resolveEffectiveTaskMode({ mode: 42 })).toBe('custom');
    });
  });

  describe('normalize', () => {
    it('isTaskMode 只认三档', () => {
      expect(isTaskMode('fast')).toBe(true);
      expect(isTaskMode('custom')).toBe(false);
      expect(isTaskMode(undefined)).toBe(false);
    });

    it('normalizeTaskMode 认三档、其余 undefined', () => {
      expect(normalizeTaskMode('deep')).toBe('deep');
      expect(normalizeTaskMode('custom')).toBeUndefined();
      expect(normalizeTaskMode('')).toBeUndefined();
    });

    it('normalizeTaskModeSetting 还认 custom（持久化值）', () => {
      expect(normalizeTaskModeSetting('custom')).toBe('custom');
      expect(normalizeTaskModeSetting('smart')).toBe('smart');
      expect(normalizeTaskModeSetting(null)).toBeUndefined();
      expect(normalizeTaskModeSetting('TURBO')).toBeUndefined();
    });
  });
});
