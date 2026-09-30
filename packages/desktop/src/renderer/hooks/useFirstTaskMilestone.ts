import { useCallback, useEffect, useState } from 'react';
import type { SessionActivity } from '@clawwork/core';
import { useArtifactDeliveryStore } from '@/stores/artifactDeliveryStore';
import {
  detectFirstTaskCompletion,
  loadFirstTaskMilestone,
  saveFirstTaskMilestone,
  type FirstTaskMilestoneRecord,
  type MilestoneMessage,
  type MilestoneStorage,
} from '@/lib/first-task-milestone';

interface UseFirstTaskMilestoneParams {
  userId: string;
  onboardingCompletedAt: string;
  taskId: string | null;
  messages: readonly MilestoneMessage[];
  activity: SessionActivity;
  storage?: MilestoneStorage;
}

interface MilestoneState {
  userId: string;
  record: FirstTaskMilestoneRecord | null;
  visibleTaskId: string | null;
  dismissed: boolean;
}

export function useFirstTaskMilestone({
  userId,
  onboardingCompletedAt,
  taskId,
  messages,
  activity,
  storage = window.localStorage,
}: UseFirstTaskMilestoneParams): { visible: boolean; dismiss: () => void } {
  const settled = useArtifactDeliveryStore((s) => s.settled);
  const [state, setState] = useState<MilestoneState>(() => ({
    userId,
    record: loadFirstTaskMilestone(userId, storage),
    visibleTaskId: null,
    dismissed: false,
  }));

  useEffect(() => {
    if (state.userId === userId) return;
    setState({
      userId,
      record: loadFirstTaskMilestone(userId, storage),
      visibleTaskId: null,
      dismissed: false,
    });
  }, [state.userId, storage, userId]);

  useEffect(() => {
    if (state.userId !== userId || state.record || !taskId) return;
    const record = detectFirstTaskCompletion({
      userId,
      taskId,
      onboardingCompletedAt,
      activity,
      messages,
      deliveredMessageIds: settled
        .filter((entry) => entry.taskId === taskId && entry.status === 'succeeded')
        .map((entry) => entry.messageId),
    });
    if (!record) return;
    saveFirstTaskMilestone(record, storage);
    setState({ userId, record, visibleTaskId: taskId, dismissed: false });
  }, [activity, messages, onboardingCompletedAt, state.record, state.userId, storage, taskId, userId, settled]);

  const dismiss = useCallback(() => {
    setState((current) => ({ ...current, dismissed: true }));
  }, []);

  return {
    visible: Boolean(state.userId === userId && state.record && state.visibleTaskId === taskId && !state.dismissed),
    dismiss,
  };
}
