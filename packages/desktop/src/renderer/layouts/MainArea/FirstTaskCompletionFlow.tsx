import type { SessionActivity } from '@clawwork/core';
import FirstTaskCompletionCard from '@/components/FirstTaskCompletionCard';
import { useFirstTaskMilestone } from '@/hooks/useFirstTaskMilestone';
import type { MilestoneMessage, MilestoneStorage } from '@/lib/first-task-milestone';

interface FirstTaskCompletionFlowProps {
  userId: string;
  onboardingCompletedAt: string;
  taskId: string | null;
  messages: readonly MilestoneMessage[];
  activity: SessionActivity;
  storage?: MilestoneStorage;
  onContinue: () => void;
  onNewTask: () => void;
  onViewUsage: () => void;
}

export default function FirstTaskCompletionFlow({
  userId,
  onboardingCompletedAt,
  taskId,
  messages,
  activity,
  storage,
  onContinue,
  onNewTask,
  onViewUsage,
}: FirstTaskCompletionFlowProps) {
  const milestone = useFirstTaskMilestone({
    userId,
    onboardingCompletedAt,
    taskId,
    messages,
    activity,
    storage,
  });

  if (!milestone.visible) return null;

  const runAndDismiss = (action: () => void) => {
    milestone.dismiss();
    action();
  };

  return (
    <FirstTaskCompletionCard
      onContinue={() => runAndDismiss(onContinue)}
      onNewTask={() => runAndDismiss(onNewTask)}
      onViewUsage={() => runAndDismiss(onViewUsage)}
      onDismiss={milestone.dismiss}
    />
  );
}
