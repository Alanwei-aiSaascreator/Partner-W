import { describe, expect, it } from 'vitest';
import type { ModelCatalogEntry } from '@clawwork/shared';
import { resolveModelLabel } from '../src/renderer/lib/model-display.js';

// 消息级模型的展示名。语义只有一条：**入参没有 modelId 就返回 undefined**，
// 调用方据此不渲染徽章 —— 绝不拿会话级模型 / picker 兜底（那是"选中的"，不是"生成它的"）。
describe('resolveModelLabel', () => {
  it('目录里有就用目录的展示名', () => {
    const catalog: ModelCatalogEntry[] = [{ id: 'glm-4.7', name: 'GLM 4.7', provider: 'clawrouter' }];

    expect(resolveModelLabel('glm-4.7', catalog)).toBe('GLM 4.7');
  });

  it('目录里没有就退回裸 id（并剥掉 provider 前缀）', () => {
    expect(resolveModelLabel('qwen-turbo', [])).toBe('qwen-turbo');
    expect(resolveModelLabel('clawrouter/kimi-k2-thinking', undefined)).toBe('kimi-k2-thinking');
  });

  it('目录还没加载完也不会把徽章吞掉', () => {
    expect(resolveModelLabel('glm-4.7', undefined)).toBe('glm-4.7');
  });

  it('没有 model 就是 undefined，不猜', () => {
    expect(resolveModelLabel(undefined, [])).toBeUndefined();
    expect(resolveModelLabel('', [])).toBeUndefined();
    expect(resolveModelLabel(null, [])).toBeUndefined();
  });

  // ⚠️ 反证：**不要**过 relayModelsFrom。那个过滤器回答的是"还能不能选来发消息"，
  // 而历史消息记的模型可能早已下架/换 provider —— 拿它过滤只会把本来能显示的名字
  // 降级成裸 id。展示不承担"可发送性"判断。
  it('非中转 provider 的历史模型照样解析展示名', () => {
    const catalog: ModelCatalogEntry[] = [{ id: 'legacy-モデル', name: 'Legacy Model', provider: 'openclaw' }];

    expect(resolveModelLabel('legacy-モデル', catalog)).toBe('Legacy Model');
  });

  it('目录条目没有 name 时退回裸 id，而不是显示空白', () => {
    const catalog: ModelCatalogEntry[] = [{ id: 'glm-4.7', provider: 'clawrouter' }];

    expect(resolveModelLabel('glm-4.7', catalog)).toBe('glm-4.7');
  });
});
