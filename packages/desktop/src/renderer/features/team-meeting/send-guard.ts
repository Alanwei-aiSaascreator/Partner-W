import { teamMeetingController } from './instance';

export function isMeetingTaskBusy(taskId: string | undefined): boolean {
  return (
    !!taskId &&
    teamMeetingController.store
      .getState()
      .records.some(
        (record) =>
          (record.status === 'draft' ||
            record.status === 'running' ||
            record.status === 'stopping' ||
            ((record.status === 'interrupted' || record.status === 'stopped') &&
              (record.abortStatus === 'unconfirmed' || record.abortStatus === 'requested'))) &&
          record.turns.some((turn) => turn.taskId === taskId),
      )
  );
}
