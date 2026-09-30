import type { SessionActivity } from '@clawwork/core';
import type { MessageRole } from '@clawwork/shared';

export interface MilestoneStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export interface MilestoneMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: string;
}

export interface FirstTaskMilestoneRecord {
  version: 1;
  userId: string;
  taskId: string;
  assistantMessageId: string;
  completedAt: string;
}

interface DetectFirstTaskCompletionParams {
  userId: string;
  taskId: string;
  onboardingCompletedAt: string;
  activity: SessionActivity;
  messages: readonly MilestoneMessage[];
  deliveredMessageIds: readonly string[];
}

const STORAGE_PREFIX = 'rongying-cube:first-task:v1:';

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

function validTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function detectFirstTaskCompletion({
  userId,
  taskId,
  onboardingCompletedAt,
  activity,
  messages,
  deliveredMessageIds,
}: DetectFirstTaskCompletionParams): FirstTaskMilestoneRecord | null {
  if (!userId || !taskId || activity !== 'idle') return null;

  const onboardingTimestamp = validTimestamp(onboardingCompletedAt);
  if (onboardingTimestamp === null) return null;

  const userIndex = messages.findIndex((message) => {
    const timestamp = validTimestamp(message.timestamp);
    return message.role === 'user' && timestamp !== null && timestamp >= onboardingTimestamp;
  });
  if (userIndex < 0) return null;

  const userTimestamp = validTimestamp(messages[userIndex].timestamp);
  if (userTimestamp === null) return null;

  const assistant = messages.slice(userIndex + 1).find((message) => {
    const timestamp = validTimestamp(message.timestamp);
    return (
      message.role === 'assistant' &&
      deliveredMessageIds.includes(message.id) &&
      message.content.trim().length > 0 &&
      timestamp !== null &&
      timestamp >= userTimestamp
    );
  });
  if (!assistant) return null;

  return {
    version: 1,
    userId,
    taskId,
    assistantMessageId: assistant.id,
    completedAt: assistant.timestamp,
  };
}

export function loadFirstTaskMilestone(
  userId: string,
  storage: MilestoneStorage = window.localStorage,
): FirstTaskMilestoneRecord | null {
  try {
    const raw = storage.getItem(storageKey(userId));
    if (!raw) return null;
    const record = JSON.parse(raw) as Partial<FirstTaskMilestoneRecord>;
    if (
      record.version !== 1 ||
      record.userId !== userId ||
      typeof record.taskId !== 'string' ||
      typeof record.assistantMessageId !== 'string' ||
      typeof record.completedAt !== 'string' ||
      validTimestamp(record.completedAt) === null
    ) {
      return null;
    }
    return record as FirstTaskMilestoneRecord;
  } catch {
    return null;
  }
}

export function saveFirstTaskMilestone(
  record: FirstTaskMilestoneRecord,
  storage: MilestoneStorage = window.localStorage,
): boolean {
  try {
    storage.setItem(storageKey(record.userId), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}
