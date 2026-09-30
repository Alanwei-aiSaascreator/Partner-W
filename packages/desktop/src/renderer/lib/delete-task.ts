import type { IpcResult, Task } from '@clawwork/shared';

export async function deleteTaskAfterAcknowledgment(
  task: Task,
  ports: {
    removeTask(id: string): Promise<void>;
    clearMessages(id: string): void;
    deleteSession(gatewayId: string, sessionKey: string): Promise<IpcResult>;
  },
): Promise<void> {
  await ports.removeTask(task.id);
  ports.clearMessages(task.id);
  const result = await ports.deleteSession(task.gatewayId, task.sessionKey);
  if (!result.ok) throw new Error(result.error ?? 'Gateway session deletion failed');
}
