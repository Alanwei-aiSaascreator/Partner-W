import type { ModelCatalogEntry } from '@clawwork/shared';

export function canonicalModelRef(model: ModelCatalogEntry): string {
  const id = model.id.trim();
  const provider = model.provider?.trim();
  if (!id || id.includes('/') || !provider) return id;
  return `${provider}/${id}`;
}

function modelTail(value: string): string {
  return value.trim().split('/').at(-1)?.toLowerCase() ?? '';
}

export function resolveTeamModelRef(raw: string | undefined, catalog: ModelCatalogEntry[]): string {
  const value = raw?.trim();
  if (!value) return '';
  const normalized = value.toLowerCase();
  const tail = modelTail(value);
  const matches = catalog.filter((entry) => {
    if (entry.available === false) return false;
    const canonical = canonicalModelRef(entry).toLowerCase();
    return (
      canonical === normalized ||
      entry.id.trim().toLowerCase() === normalized ||
      entry.name?.trim().toLowerCase() === normalized ||
      modelTail(canonical) === tail
    );
  });
  return matches.length === 1 ? canonicalModelRef(matches[0]) : '';
}
