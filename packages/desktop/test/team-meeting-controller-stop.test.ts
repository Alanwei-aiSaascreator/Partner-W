import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferred, nextPlan, setup } from './helpers/team-meeting-controller-fixture';
import type { ChatComposer } from '@clawwork/core';
import type { IpcResult, TeamMeetingRecord } from '@clawwork/shared';

describe('team meeting stop and recovery', () => {
  afterEach(() => vi.useRealTimers());
  it('stops before send when a preflight await is pending', async () => {
    const h = setup();
    const gate = deferred<void>();
    h.preflight.mockReturnValueOnce(gate.promise);
    await h.controller.start(h.plan);
    await vi.waitFor(() => expect(h.preflight).toHaveBeenCalledTimes(1));
    await h.controller.stop(h.plan.record.id);
    gate.resolve();
    await vi.waitFor(() => expect(h.controller.store.getState().records[0].status).toBe('stopped'));
    expect(h.send).not.toHaveBeenCalled();
    h.controller.reset();
  });

  it('aborts again on a late acceptance after stop and preserves its receipt', async () => {
    const h = setup();
    const accepted = deferred<Awaited<ReturnType<ChatComposer['send']>>>();
    h.send.mockReturnValueOnce(accepted.promise);
    h.abort.mockResolvedValueOnce({ ok: true, result: { aborted: false } });
    await h.controller.start(h.plan);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    await h.controller.stop(h.plan.record.id);
    expect(h.send.mock.calls[0][1].signal?.aborted).toBe(true);
    accepted.resolve({
      ok: true,
      taskId: h.plan.tasks[0].id,
      dispatch: { sessionKey: h.plan.tasks[0].sessionKey, runId: 'late-run' },
    });
    await vi.waitFor(() => expect(h.abort).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(h.rows.get(h.plan.record.id)?.abortStatus).toBe('confirmed'));
    expect(h.rows.get(h.plan.record.id)).toMatchObject({ status: 'stopped', turns: [{ runId: 'late-run' }, {}, {}] });
    expect(h.send).toHaveBeenCalledTimes(1);
    h.controller.reset();
  });

  it('does not let an older stop acknowledgment overwrite the late accepted-run cancellation', async () => {
    const h = setup();
    const accepted = deferred<Awaited<ReturnType<ChatComposer['send']>>>();
    const earlyAbort = deferred<IpcResult>();
    h.send.mockReturnValueOnce(accepted.promise);
    h.abort.mockReturnValueOnce(earlyAbort.promise);
    await h.controller.start(h.plan);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    const stopping = h.controller.stop(h.plan.record.id);
    await vi.waitFor(() => expect(h.abort).toHaveBeenCalledTimes(1));
    accepted.resolve({
      ok: true,
      taskId: h.plan.tasks[0].id,
      dispatch: { sessionKey: h.plan.tasks[0].sessionKey, runId: 'late-run' },
    });
    await Promise.resolve();
    await Promise.resolve();
    earlyAbort.resolve({ ok: true, result: { aborted: false } });
    await stopping;
    await vi.waitFor(() => expect(h.abort).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(h.rows.get(h.plan.record.id)?.abortStatus).toBe('confirmed'));
    h.controller.reset();
  });

  it.each(['yielded', 'disconnected', 'legacy'] as const)('does not advance on %s evidence', async (kind) => {
    const h = setup();
    if (kind === 'legacy') h.send.mockResolvedValueOnce({ ok: true, taskId: h.plan.tasks[0].id });
    await h.controller.start(h.plan);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    if (kind === 'yielded') {
      h.emit(0, 'final', { yielded: true });
      await Promise.resolve();
      expect(h.syncRun).not.toHaveBeenCalled();
      await h.controller.stop(h.plan.record.id);
    }
    if (kind === 'disconnected')
      for (const listener of h.statuses) listener({ gatewayId: 'gateway', connected: false });
    if (kind !== 'yielded')
      await vi.waitFor(() => expect(h.controller.store.getState().records[0].status).toBe('interrupted'));
    expect(h.send).toHaveBeenCalledTimes(1);
    h.controller.reset();
  });

  it('never dispatches when the dispatching journal write fails', async () => {
    const h = setup();
    h.save.mockResolvedValueOnce({ ok: false, error: 'disk full' });
    await h.controller.start(h.plan);
    await vi.waitFor(() => expect(h.controller.store.getState().errors[h.plan.record.id]).toContain('disk full'));
    expect(h.send).not.toHaveBeenCalled();
    h.controller.reset();
  });

  it('still aborts accepted work when saving stop intent fails', async () => {
    const h = setup();
    await h.controller.start(h.plan);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    h.save.mockResolvedValue({ ok: false, error: 'stop disk failure' });
    await h.controller.stop(h.plan.record.id);
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.controller.store.getState().records[0].status).toBe('interrupted');
    h.controller.reset();
  });
  it('dispatches cancellation even while a metadata write is stalled', async () => {
    const h = setup();
    const journal = deferred<IpcResult<TeamMeetingRecord>>();
    const realSave = h.save.getMockImplementation()!;
    h.save.mockImplementation((input) =>
      input.record.turns[0].status === 'running' ? journal.promise : realSave(input),
    );
    await h.controller.start(h.plan);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    const stopping = h.controller.stop(h.plan.record.id);
    await vi.waitFor(() => expect(h.abort).toHaveBeenCalledTimes(1));
    journal.resolve({ ok: false, error: 'stalled write' });
    await stopping;
    h.controller.reset();
  });

  it('keeps the team locked until an in-flight stop acknowledgment settles', async () => {
    const h = setup();
    const ack = deferred<IpcResult>();
    h.abort.mockReturnValueOnce(ack.promise);
    await h.controller.start(h.plan);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    const stopping = h.controller.stop(h.plan.record.id);
    await vi.waitFor(() => expect(h.abort).toHaveBeenCalledTimes(1));
    const other = structuredClone(h.plan);
    other.record.id = 'different';
    await expect(h.controller.start(other)).rejects.toThrow();
    ack.resolve({ ok: true, result: { aborted: true } });
    await stopping;
    h.controller.reset();
  });

  it.each([true, false])(
    'keeps an unconfirmed stop locked until explicit retry reports aborted=%s',
    async (aborted) => {
      const h = setup();
      h.abort.mockResolvedValueOnce({ ok: false, error: 'connection lost' });
      await h.controller.start(h.plan);
      await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
      await h.controller.stop(h.plan.record.id);
      await vi.waitFor(() =>
        expect(h.rows.get(h.plan.record.id)).toMatchObject({ status: 'stopped', abortStatus: 'unconfirmed' }),
      );
      await expect(h.controller.start(nextPlan())).rejects.toThrow('active meeting');
      expect(h.create).toHaveBeenCalledTimes(1);
      expect(h.send).toHaveBeenCalledTimes(1);
      h.abort.mockResolvedValueOnce({ ok: true, result: { aborted } });
      await h.controller.stop(h.plan.record.id);
      expect(h.rows.get(h.plan.record.id)?.abortStatus).toBe(aborted ? 'confirmed' : 'not-running');
      const gate = deferred<void>();
      h.preflight.mockReturnValueOnce(gate.promise);
      await expect(h.controller.start(nextPlan())).resolves.toBeTruthy();
      expect(h.create).toHaveBeenCalledTimes(2);
      expect(h.send).toHaveBeenCalledTimes(1);
      h.controller.reset();
      gate.resolve();
    },
  );

  it.each([
    ['stopped', 'requested'],
    ['stopped', 'unconfirmed'],
    ['interrupted', 'requested'],
    ['interrupted', 'unconfirmed'],
  ] as const)(
    'blocks recovered %s meetings with %s abort without creating tasks or resending',
    async (status, abortStatus) => {
      const h = setup();
      const record = structuredClone(h.plan.record);
      record.status = status;
      record.abortStatus = abortStatus;
      record.stopRequested = true;
      record.turns[0].status = status;
      record.turns[0].runId = 'accepted';
      h.rows.set(record.id, record);
      await expect(h.controller.start(nextPlan())).rejects.toThrow('active meeting');
      expect(h.create).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
      expect(h.abort).not.toHaveBeenCalled();
      h.controller.reset();
    },
  );

  it('blocks a recovered running turn until an explicit cancellation resolves it', async () => {
    const h = setup();
    const record = structuredClone(h.plan.record);
    record.status = 'running';
    record.turns[0].status = 'running';
    record.turns[0].runId = 'accepted';
    h.rows.set(record.id, record);
    await expect(h.controller.start(nextPlan())).rejects.toThrow('active meeting');
    expect(h.rows.get(record.id)).toMatchObject({ status: 'interrupted', abortStatus: 'unconfirmed' });
    expect(h.create).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    h.controller.reset();
  });

  it.each(['unrelated', 'completed', 'failed'] as const)('does not lock %s meetings', async (kind) => {
    const gate = deferred<void>();
    const h = setup(2, { preflight: async () => gate.promise });
    const record = structuredClone(h.plan.record);
    record.abortStatus = 'unconfirmed';
    if (kind !== 'completed') {
      record.status = kind === 'failed' ? 'failed' : 'stopped';
      if (kind === 'failed') record.abortStatus = 'not-running';
      record.turns[0].status = 'stopped';
    } else {
      record.status = 'completed';
      for (const turn of record.turns) {
        turn.status = 'completed';
        turn.runId = `completed-${turn.id}`;
        turn.messageIds = [`canonical-${turn.id}`];
      }
    }
    h.rows.set(record.id, record);
    await expect(h.controller.start(nextPlan(kind === 'unrelated' ? 'other-team' : 'team'))).resolves.toBeTruthy();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.send).not.toHaveBeenCalled();
    h.controller.reset();
    gate.resolve();
  });

  it('aborts accepted work when saving its receipt fails', async () => {
    const h = setup();
    const realSave = h.save.getMockImplementation()!;
    h.save.mockImplementation(async (input) =>
      input.record.turns.some((turn) => turn.runId) ? { ok: false, error: 'receipt disk failure' } : realSave(input),
    );
    await h.controller.start(h.plan);
    await vi.waitFor(() => expect(h.abort).toHaveBeenCalledTimes(1));
    expect(h.send).toHaveBeenCalledTimes(1);
    h.controller.reset();
  });

  it.each(['truncated', 'unconfirmed', 'empty'] as const)('never advances an %s discussion', async (kind) => {
    const h = setup();
    if (kind === 'unconfirmed') h.syncRun.mockResolvedValue({ kind: 'pending' });
    if (kind === 'empty') h.syncRun.mockResolvedValue({ kind: 'completed', messageIds: ['m1'], content: '' });
    await h.controller.start(h.plan);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    h.emit(0, 'final', kind === 'truncated' ? { stopReason: 'length' } : {});
    await vi.waitFor(() => expect(h.controller.store.getState().records[0].status).toBe('interrupted'));
    expect(h.send).toHaveBeenCalledTimes(1);
    h.controller.reset();
  });

  it('hydrates unfinished records as interrupted without sending or changing completed turns', async () => {
    const h = setup();
    const record = structuredClone(h.plan.record);
    record.status = 'running';
    record.turns[0] = { ...record.turns[0], status: 'completed', runId: 'done', messageIds: ['m1'] };
    record.turns[1].status = 'dispatching';
    h.rows.set(record.id, record);
    await h.controller.load();
    expect(h.rows.get(record.id)).toMatchObject({
      status: 'interrupted',
      turns: [record.turns[0], { status: 'interrupted' }, {}],
    });
    expect(h.send).not.toHaveBeenCalled();
    h.controller.reset();
  });

  it('hydrates a never-dispatched draft as interrupted rather than a permanently active meeting', async () => {
    const h = setup();
    h.rows.set(h.plan.record.id, structuredClone(h.plan.record));
    await h.controller.load();
    expect(h.rows.get(h.plan.record.id)?.status).toBe('interrupted');
    expect(h.send).not.toHaveBeenCalled();
    h.controller.reset();
  });

  it('marks recovered work unconfirmed and only aborts it after an explicit stop', async () => {
    const h = setup();
    const record = structuredClone(h.plan.record);
    record.status = 'running';
    record.turns[0].status = 'running';
    record.turns[0].runId = 'accepted';
    h.rows.set(record.id, record);
    h.plan.tasks.forEach((task) => h.tasks.set(task.id, task));
    await h.controller.load();
    expect(h.rows.get(record.id)?.abortStatus).toBe('unconfirmed');
    expect(h.abort).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    await h.controller.stop(record.id);
    expect(h.abort).toHaveBeenCalledWith(h.plan.tasks[0], {
      sessionKey: h.plan.tasks[0].sessionKey,
      runId: 'accepted',
    });
    expect(h.rows.get(record.id)).toMatchObject({ status: 'stopped', abortStatus: 'confirmed' });
    expect(h.send).not.toHaveBeenCalled();
    h.controller.reset();
  });

  it.each([
    ['stopped', 'requested'],
    ['interrupted', 'requested'],
    ['stopped', 'unconfirmed'],
    ['interrupted', 'unconfirmed'],
  ] as const)('retries cancellation for %s with %s acknowledgment', async (status, abortStatus) => {
    const h = setup();
    const record = structuredClone(h.plan.record);
    record.status = status;
    record.abortStatus = abortStatus;
    record.stopRequested = true;
    record.turns[0].status = status;
    record.turns[0].runId = 'accepted';
    h.rows.set(record.id, record);
    h.plan.tasks.forEach((task) => h.tasks.set(task.id, task));
    await h.controller.load();
    await h.controller.stop(record.id);
    expect(h.abort).toHaveBeenCalledWith(h.plan.tasks[0], {
      sessionKey: h.plan.tasks[0].sessionKey,
      runId: 'accepted',
    });
    expect(h.rows.get(record.id)).toMatchObject({ status: 'stopped', abortStatus: 'confirmed' });
    expect(h.send).not.toHaveBeenCalled();
    h.controller.reset();
  });

  it('drops stale workspace completions before any later write or send', async () => {
    const h = setup();
    const gate = deferred<void>();
    h.preflight.mockReturnValueOnce(gate.promise);
    await h.controller.start(h.plan);
    await vi.waitFor(() => expect(h.preflight).toHaveBeenCalledTimes(1));
    h.controller.reset();
    const saves = h.save.mock.calls.length;
    gate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.save).toHaveBeenCalledTimes(saves);
    expect(h.controller.store.getState().records).toEqual([]);
  });

  it('rejects same-team concurrent starts before creating another set of tasks', async () => {
    const h = setup();
    await h.controller.start(h.plan);
    const other = structuredClone(h.plan);
    other.record.id = 'another-meeting';
    await expect(h.controller.start(other)).rejects.toThrow();
    expect(h.create).toHaveBeenCalledTimes(1);
    await h.controller.stop(h.plan.record.id);
    h.controller.reset();
  });
});
