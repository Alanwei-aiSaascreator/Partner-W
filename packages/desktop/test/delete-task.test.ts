import { describe, expect, it, vi } from 'vitest';
import type { Task } from '@clawwork/shared';
import { deleteTaskAfterAcknowledgment } from '../src/renderer/lib/delete-task';

describe('acknowledged task deletion', () => {
  const task = { id: 'task', gatewayId: 'gateway', sessionKey: 'session' } as Task;
  it('does not clear messages or delete the gateway session when the local guard refuses', async () => {
    const removeTask = vi.fn(async () => {
      throw new Error('active meeting');
    });
    const clearMessages = vi.fn();
    const deleteSession = vi.fn();
    await expect(deleteTaskAfterAcknowledgment(task, { removeTask, clearMessages, deleteSession })).rejects.toThrow(
      'active meeting',
    );
    expect(clearMessages).not.toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();
  });
  it('waits for the local receipt before clearing messages and checks gateway deletion errors', async () => {
    const order: string[] = [];
    await expect(
      deleteTaskAfterAcknowledgment(task, {
        removeTask: async () => {
          order.push('local');
        },
        clearMessages: () => {
          order.push('messages');
        },
        deleteSession: async () => {
          order.push('gateway');
          return { ok: false, error: 'offline' };
        },
      }),
    ).rejects.toThrow('offline');
    expect(order).toEqual(['local', 'messages', 'gateway']);
  });
});
