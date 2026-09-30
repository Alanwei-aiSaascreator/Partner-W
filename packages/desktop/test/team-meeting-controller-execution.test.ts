import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferred, setup } from './helpers/team-meeting-controller-fixture';
import type { RunSyncResult } from '@clawwork/core';
import { expectedArtifactKindsFromRequest } from '../src/main/artifact/claim-guard';

describe('team meeting canonical execution', () => {
  afterEach(() => vi.useRealTimers());
  it('invalidates an admission token synchronously when a workspace resets', () => {
    const h = setup();
    const generation = h.controller.getGeneration();
    h.controller.reset();
    expect(h.controller.getGeneration()).not.toBe(generation);
  });
  it('assigns final file delivery only to summary while retaining the complete question as discussion context', async () => {
    const h = setup();
    h.plan.record.question = '请讨论融资方案，最终生成 Word 文件';
    h.plan.record.addenda = ['请保留数据来源，不确定的数据明确标注'];
    for (const task of h.plan.tasks) task.title = '讨论';
    await h.controller.start(h.plan);
    for (let index = 0; index < 3; index++) {
      await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(index + 1));
      const options = h.send.mock.calls[index][1];
      if (index < 2) {
        expect(expectedArtifactKindsFromRequest(options.content)).toEqual([]);
        expect(options.contextPrefix).toContain(h.plan.record.question);
        expect(options.contextPrefix).toContain(h.plan.record.addenda[0]);
      } else {
        expect(options.content).toBe([h.plan.record.question, ...h.plan.record.addenda].join('\n\n'));
        expect(expectedArtifactKindsFromRequest(options.content)).toContain('docx');
      }
      h.emit(index);
    }
    await vi.waitFor(() => expect(h.controller.store.getState().records[0].status).toBe('completed'));
    h.controller.reset();
  });
  it.each([2, 3])('runs exactly three real tasks serially for %i members using canonical context', async (count) => {
    const h = setup(count);
    await h.controller.start(h.plan);
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(i + 1));
      expect(h.send.mock.calls[i][0]).toBe(h.plan.tasks[i].id);
      expect(h.send.mock.calls[i][1]).toMatchObject({
        content: i === 2 ? 'question' : `Discuss ${i === 0 ? 'proposal' : 'review'} stage.`,
        presetModel: h.plan.tasks[i].model,
        presetThinking: 'high',
        signal: expect.any(AbortSignal),
      });
      if (i > 0) expect(h.send.mock.calls[i][1].contextPrefix).toContain('real canonical text');
      h.emit(i);
    }
    await vi.waitFor(() => expect(h.controller.store.getState().records[0].status).toBe('completed'));
    expect(h.send).toHaveBeenCalledTimes(3);
    expect(h.events.size).toBe(0);
    expect(JSON.stringify(h.rows.get(h.plan.record.id))).not.toContain('real canonical text');
    h.controller.reset();
  });

  it('waits for the durable canonical acknowledgment after final before sending review', async () => {
    const h = setup();
    const ack = deferred<RunSyncResult>();
    h.syncRun.mockReturnValueOnce(ack.promise);
    await h.controller.start(h.plan);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    h.emit(0);
    await vi.waitFor(() => expect(h.syncRun).toHaveBeenCalledTimes(1));
    expect(h.send).toHaveBeenCalledTimes(1);
    ack.resolve({ kind: 'completed', messageIds: ['m1'], content: 'persisted only' });
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
    expect(h.send.mock.calls[1][1].contextPrefix).toContain('persisted only');
    await h.controller.stop(h.plan.record.id);
    h.controller.reset();
  });

  it('binds an early final emitted before the send receipt resolves', async () => {
    const h = setup();
    h.send.mockImplementationOnce(async (taskId) => {
      h.emit(0);
      return { ok: true, taskId, dispatch: { sessionKey: h.plan.tasks[0].sessionKey, runId: `run-${taskId}` } };
    });
    await h.controller.start(h.plan);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
    await h.controller.stop(h.plan.record.id);
    h.controller.reset();
  });

  it('waits beyond six seconds for canonical history without resending', async () => {
    vi.useFakeTimers();
    const h = setup(2, { sleep: undefined, syncAttempts: undefined });
    const started = Date.now();
    h.syncRun.mockImplementation(async () =>
      Date.now() - started < 6000
        ? { kind: 'pending' }
        : { kind: 'completed', messageIds: ['late-history'], content: 'canonical after six seconds' },
    );
    await h.controller.start(h.plan);
    await vi.advanceTimersByTimeAsync(1);
    h.emit(0);
    await vi.advanceTimersByTimeAsync(6000);
    expect(h.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls[1][1].contextPrefix).toContain('canonical after six seconds');
    await h.controller.stop(h.plan.record.id);
    h.controller.reset();
  });
});
