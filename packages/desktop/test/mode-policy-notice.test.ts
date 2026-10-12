// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { COMMERCIAL_DEFAULT_MODEL_ID } from '@clawwork/shared';
import {
  markModePolicyNotified,
  modePolicyNoticeKey,
  shouldNotifyModePolicyChange,
  type ModePolicyNoticeStorage,
} from '../src/renderer/lib/mode-policy-notice';

/**
 * 「存量模式任务首次采用新策略」的一次性提示（2026-10-10 Cephalon 批 · Task 4）。
 *
 * 契约（错了的代价：要么用户"被换模型"却毫不知情，要么每轮都弹）：
 *   ① 存量（记录模型 ≠ 将运行的模型、且记录的不是当前默认）⇒ 提示一次；
 *   ② 按当前策略创建/设置的任务（记录 = 当前商业默认）⇒ 永不提示（差异只来自内部路由）；
 *   ③ custom / 解析不出目标 / 无记录模型 ⇒ 不提示（没有可说的变化，不许瞎说）；
 *   ④ 提示过就记标记（localStorage，随盘走；不动 tasks 表结构）。
 */

function memoryStorage(): ModePolicyNoticeStorage & { dump: () => Record<string, string> } {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    dump: () => Object.fromEntries(values),
  };
}

describe('shouldNotifyModePolicyChange（纯判据）', () => {
  it('⭐ 存量模式任务（记录旧默认、将跑 glm）⇒ 提示', () => {
    expect(
      shouldNotifyModePolicyChange({
        sendMode: 'smart',
        task: { id: 'task-1', model: 'deepseek-v4-flash' },
        effectiveModelId: 'glm-5.3-flash',
        storage: memoryStorage(),
      }),
    ).toBe(true);
  });

  it('⭐ 记录 = 当前商业默认 ⇒ 不提示（按当前策略创建的任务；差异只可能是内部路由）', () => {
    expect(
      shouldNotifyModePolicyChange({
        sendMode: 'smart',
        task: { id: 'task-1', model: COMMERCIAL_DEFAULT_MODEL_ID },
        effectiveModelId: 'deepseek-v4-flash-cephalon',
        storage: memoryStorage(),
      }),
    ).toBe(false);
    // 带命名空间的记录同样按末段比对
    expect(
      shouldNotifyModePolicyChange({
        sendMode: 'fast',
        task: { id: 'task-1', model: `clawrouter/${COMMERCIAL_DEFAULT_MODEL_ID}` },
        effectiveModelId: 'deepseek-v4-flash-cephalon',
        storage: memoryStorage(),
      }),
    ).toBe(false);
  });

  it('记录与将运行的模型一致（含命名空间写法）⇒ 不提示', () => {
    expect(
      shouldNotifyModePolicyChange({
        sendMode: 'deep',
        task: { id: 'task-1', model: 'glm-4.7' },
        effectiveModelId: 'clawrouter/glm-4.7',
        storage: memoryStorage(),
      }),
    ).toBe(false);
  });

  it('custom（用户显式选过模型）⇒ 不提示 —— 那一档不归模式策略管', () => {
    expect(
      shouldNotifyModePolicyChange({
        sendMode: 'custom',
        task: { id: 'task-1', model: 'deepseek-v4-flash' },
        effectiveModelId: 'glm-5.3-flash',
        storage: memoryStorage(),
      }),
    ).toBe(false);
  });

  it('解析不出将运行的模型（目录没拉到 / 下架）⇒ 不提示（没有可说的变化）', () => {
    expect(
      shouldNotifyModePolicyChange({
        sendMode: 'smart',
        task: { id: 'task-1', model: 'deepseek-v4-flash' },
        effectiveModelId: undefined,
        storage: memoryStorage(),
      }),
    ).toBe(false);
  });

  it('任务没有记录模型（老会话 / 网关发现）⇒ 不提示（无对照，不能断言"变了"）', () => {
    for (const model of [undefined, null, '', '   ', 42]) {
      expect(
        shouldNotifyModePolicyChange({
          sendMode: 'smart',
          task: { id: 'task-1', model },
          effectiveModelId: 'glm-5.3-flash',
          storage: memoryStorage(),
        }),
      ).toBe(false);
    }
  });

  it('⭐ 提示过（标记在）⇒ 不再提示；标记按任务 id 隔离', () => {
    const storage = memoryStorage();
    markModePolicyNotified('task-1', storage);
    expect(storage.dump()).toEqual({ [modePolicyNoticeKey('task-1')]: expect.any(String) });
    expect(
      shouldNotifyModePolicyChange({
        sendMode: 'smart',
        task: { id: 'task-1', model: 'deepseek-v4-flash' },
        effectiveModelId: 'glm-5.3-flash',
        storage,
      }),
    ).toBe(false);
    // 另一个任务不受影响
    expect(
      shouldNotifyModePolicyChange({
        sendMode: 'smart',
        task: { id: 'task-2', model: 'deepseek-v4-flash' },
        effectiveModelId: 'glm-5.3-flash',
        storage,
      }),
    ).toBe(true);
  });

  it('存储读不了 ⇒ 宁可不提示（不冒"每轮都弹"的风险）', () => {
    const throwing: ModePolicyNoticeStorage = {
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => undefined,
    };
    expect(
      shouldNotifyModePolicyChange({
        sendMode: 'smart',
        task: { id: 'task-1', model: 'deepseek-v4-flash' },
        effectiveModelId: 'glm-5.3-flash',
        storage: throwing,
      }),
    ).toBe(false);
  });

  it('⭐ BUG-066：写入失败（setItem 抛）⇒ 同样不向外抛（最坏下次再提示一次）', () => {
    const throwing: ModePolicyNoticeStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
    };
    expect(() => markModePolicyNotified('task-1', throwing)).not.toThrow();
  });

  it('⭐ BUG-066：获取 window.localStorage 本身抛异常（SecurityError 型）⇒ 不提示、不写入、更不许向外抛', () => {
    // HTML 规范：localStorage getter 在存储策略拒绝等条件下可抛 SecurityError。
    // 提示层绝不允许把这种接口失败变成"发送被阻断"（useChatSend 里这个异常曾直接
    // 进发送失败出口，composer 调用为 0）。
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('synthetic storage unavailable', 'SecurityError');
      },
    });
    try {
      expect(
        shouldNotifyModePolicyChange({
          sendMode: 'smart',
          task: { id: 'task-1', model: 'deepseek-v4-flash' },
          effectiveModelId: 'glm-5.3-flash',
        }),
      ).toBe(false);
      expect(() => markModePolicyNotified('task-1')).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});
