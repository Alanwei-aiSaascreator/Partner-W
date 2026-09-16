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
  artifactCount: number;
  onContinue: () => void;
  onNewTask: () => void;
  onViewUsage: () => void;
  onGenerateFile: () => void;
  onViewArtifacts: () => void;
}

export default function FirstTaskCompletionFlow({
  userId,
  onboardingCompletedAt,
  taskId,
  messages,
  activity,
  storage,
  artifactCount,
  onContinue,
  onNewTask,
  onViewUsage,
  onGenerateFile,
  onViewArtifacts,
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
      artifactCount={artifactCount}
      onContinue={() => runAndDismiss(onContinue)}
      onNewTask={() => runAndDismiss(onNewTask)}
      onViewUsage={() => runAndDismiss(onViewUsage)}
      onGenerateFile={() => runAndDismiss(onGenerateFile)}
      onViewArtifacts={() => runAndDismiss(onViewArtifacts)}
      onDismiss={milestone.dismiss}
    />
  );
}
