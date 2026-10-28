import { COMMERCIAL_DEFAULT_MODEL_ID } from '@clawwork/shared';
import type { ModelCatalogEntry } from '@clawwork/shared';

/**
 * ⚠️ 定义在 `@clawwork/shared/constants.ts`（**唯一真源**，main 进程也要用它写网关
 * 默认模型）。这里 re-export 是为了不动既有 import 面。
 */
export { COMMERCIAL_DEFAULT_MODEL_ID };
export const COMMERCIAL_DEFAULT_MODEL_LABEL = 'DeepSeek V4 Flash';

export function resolveCommercialDefaultModel(catalog: ModelCatalogEntry[]) {
  const entry = catalog.find((model) => model.id.split('/').at(-1) === COMMERCIAL_DEFAULT_MODEL_ID);
  if (!entry) return undefined;
  return {
    id: entry.id,
    provider: entry.provider,
    label: entry.name ?? COMMERCIAL_DEFAULT_MODEL_LABEL,
  };
}
