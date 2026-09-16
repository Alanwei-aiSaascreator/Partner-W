export interface RecentAssistantTask {
  presetId: string;
  usedAt: string;
}

export interface AssistantTaskHistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PREFIX = 'rongying-cube:assistant-task-history:v1:';
const MAX_RECENT = 5;
const MAX_PRESET_ID_LENGTH = 100;
const MAX_USED_AT_LENGTH = 64;

function storageKey(userId: string): string {
  return `${PREFIX}${userId}`;
}

function resolveStorage(storage?: AssistantTaskHistoryStorage): AssistantTaskHistoryStorage | null {
  try {
    return storage ?? (typeof window === 'undefined' ? null : window.localStorage);
  } catch {
    return null;
  }
}

function isStrictIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function sanitizeHistory(value: unknown): RecentAssistantTask[] {
  if (!Array.isArray(value)) return [];

  const recent: RecentAssistantTask[] = [];
  const seenPresetIds = new Set<string>();

  for (const valueItem of value) {
    if (!valueItem || typeof valueItem !== 'object' || Array.isArray(valueItem)) continue;

    const item = valueItem as Record<string, unknown>;
    if (typeof item.presetId !== 'string' || typeof item.usedAt !== 'string') continue;

    const presetId = item.presetId.slice(0, MAX_PRESET_ID_LENGTH);
    const usedAt = item.usedAt.slice(0, MAX_USED_AT_LENGTH);
    if (!presetId || !isStrictIsoTimestamp(usedAt) || seenPresetIds.has(presetId)) continue;

    recent.push({ presetId, usedAt });
    seenPresetIds.add(presetId);
    if (recent.length === MAX_RECENT) break;
  }

  return recent;
}

export function loadRecentAssistantTasks(userId: string, storage?: AssistantTaskHistoryStorage): RecentAssistantTask[] {
  try {
    const resolvedStorage = resolveStorage(storage);
    if (!resolvedStorage) return [];
    return sanitizeHistory(JSON.parse(resolvedStorage.getItem(storageKey(userId)) ?? '[]') as unknown);
  } catch {
    return [];
  }
}

export function recordRecentAssistantTask(
  userId: string,
  presetId: string,
  storage?: AssistantTaskHistoryStorage,
  usedAt = new Date().toISOString(),
): RecentAssistantTask[] {
  const next = sanitizeHistory([{ presetId, usedAt }, ...loadRecentAssistantTasks(userId, storage)]);
  try {
    resolveStorage(storage)?.setItem(storageKey(userId), JSON.stringify(next));
  } catch {
    return next;
  }
  return next;
}
