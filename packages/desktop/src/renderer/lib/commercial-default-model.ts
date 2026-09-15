import type { ModelCatalogEntry } from '@clawwork/shared';

export const COMMERCIAL_DEFAULT_MODEL_ID = 'deepseek-v4-flash';
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
