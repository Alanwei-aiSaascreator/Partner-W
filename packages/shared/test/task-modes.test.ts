import { describe, expect, it } from 'vitest';
import {
  COMMERCIAL_DEFAULT_MODEL_ID,
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
 *   1. 三档 → 模型/思考档的映射本身（2026-10-10 Cephalon 批：三档统一
 *      `glm-5.3-flash`，只差思考强度 low/high/max）；
 *   2. 目录解析：**只认目录里真实存在的 id**（含命名空间写法），目录里没有它
 *      ⇒ `undefined`（调用方保持现状、不拦截）；旧 Qwen 快速别名仍是隐藏条目
 *      （relay 保留在售、下拉隐藏，只是不再被任何一档使用）；
 *   3. **存量保护**：旧行（mode 为空）一律按 custom 处理 —— 不得劫持其既有
 *      `task.model`（用户以前选过的具体模型）。
 */
describe('任务模式映射（单一真源）', () => {
  it('三档顺序与默认档 = 智能', () => {
    expect(TASK_MODES).toEqual(['fast', 'smart', 'deep']);
    expect(DEFAULT_TASK_MODE).toBe('smart');
  });

  it('⭐ MODE_POLICY（2026-10-17）：三档按能力分模型 —— flash / flashx / glm-5.3，思考档 low / high / max', () => {
    expect(MODE_POLICY.fast).toEqual({ modelId: 'glm-5.3-flash', thinkingLevel: 'low' });
    expect(MODE_POLICY.smart).toEqual({ modelId: 'glm-5.3-flashx', thinkingLevel: 'high' });
    expect(MODE_POLICY.deep).toEqual({ modelId: 'glm-5.3', thinkingLevel: 'max' });
  });

  it('默认档（智能）的模型 = MODE_BASE_MODEL_ID = COMMERCIAL_DEFAULT_MODEL_ID', () => {
    expect(MODE_BASE_MODEL_ID).toBe(MODE_POLICY.smart.modelId);
    expect(MODE_BASE_MODEL_ID).toBe(COMMERCIAL_DEFAULT_MODEL_ID);
    // 别名是另一路并行上线的 relay 条目（保留在售、下拉隐藏）；三档已不再使用它。
    expect(FAST_MODEL_ALIAS_ID).toBe('qwen3.7-flash-fast');
  });

  describe('resolveModeModelId（对着目录解析）', () => {
    it('⭐ 三档各自解析到自己的模型（旧别名在目录里也不误用）', () => {
      const catalog = [FAST_MODEL_ALIAS_ID, 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.3', 'deepseek-v4-flash'];
      expect(resolveModeModelId('fast', catalog)).toBe('glm-5.3-flash');
      expect(resolveModeModelId('smart', catalog)).toBe('glm-5.3-flashx');
      expect(resolveModeModelId('deep', catalog)).toBe('glm-5.3');
    });

    it('某档模型不在目录里 ⇒ 只有那一档 undefined（其余档不受影响）', () => {
      expect(resolveModeModelId('fast', ['deepseek-v4-flash', FAST_MODEL_ALIAS_ID])).toBeUndefined();
      expect(resolveModeModelId('smart', ['qwen3.7-flash'])).toBeUndefined();
      expect(resolveModeModelId('deep', [])).toBeUndefined();
      // 关键：缺档不连坐 —— 有 glm-5.3 时深度档照常解析
      expect(resolveModeModelId('deep', ['glm-5.3'])).toBe('glm-5.3');
    });

    it('目录 id 带命名空间（clawrouter/…）也认，返回**目录里那个 id 本体**', () => {
      expect(resolveModeModelId('smart', ['clawrouter/glm-5.3-flashx'])).toBe('clawrouter/glm-5.3-flashx');
      expect(resolveModeModelId('fast', ['clawrouter/glm-5.3-flash'])).toBe('clawrouter/glm-5.3-flash');
      expect(resolveModeModelId('deep', ['clawrouter/glm-5.3'])).toBe('clawrouter/glm-5.3');
    });
  });

  describe('别名在高级列表里隐藏', () => {
    it('别名 id 被认出（含带命名空间的写法）', () => {
      expect(isModeAliasModelId(FAST_MODEL_ALIAS_ID)).toBe(true);
      expect(isModeAliasModelId(`clawrouter/${FAST_MODEL_ALIAS_ID}`)).toBe(true);
    });

    it('基础模型与普通模型不是别名；新 Cephalon 渠道 SKU 也不许误入隐藏名单', () => {
      expect(isModeAliasModelId(MODE_BASE_MODEL_ID)).toBe(false);
      expect(isModeAliasModelId('deepseek-v4-flash')).toBe(false);
      expect(isModeAliasModelId('deepseek-v4-flash-cephalon')).toBe(false);
      expect(isModeAliasModelId('clawrouter/deepseek-v4-flash-cephalon')).toBe(false);
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
