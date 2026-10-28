import { observeChatRun } from '@clawwork/core';
import type { ChatComposer, GatewayTransportPort, RunSyncResult } from '@clawwork/core';
import { hasUnresolvedTeamMeetingAbort, isTeamMeetingActive } from '@clawwork/shared';
import type {
  ChatDispatchReceipt,
  CreateTeamMeetingInput,
  IpcResult,
  SaveTeamMeetingInput,
  Task,
  TeamMeetingRecord,
} from '@clawwork/shared';
import { buildMeetingStageContext } from './plan';
import { createTeamMeetingStore, initialMeetingState } from './store';

export interface MeetingControllerPorts {
  create(input: CreateTeamMeetingInput): Promise<IpcResult<CreateTeamMeetingInput>>;
  save(input: SaveTeamMeetingInput): Promise<IpcResult<TeamMeetingRecord>>;
  list(): Promise<IpcResult<TeamMeetingRecord[]>>;
  send: ChatComposer['send'];
  abort(task: Task, receipt?: ChatDispatchReceipt): Promise<IpcResult | undefined>;
  syncRun(taskId: string, receipt: ChatDispatchReceipt): Promise<RunSyncResult>;
  preflight(task: Task, signal: AbortSignal): Promise<void>;
  validateStart?(input: CreateTeamMeetingInput): Promise<void>;
  context?(task: Task): Promise<string>;
  stageRequest(stage: 'proposal' | 'review'): string;
  registerTasks(tasks: Task[]): void;
  getTask(id: string): Task | undefined;
  gateway: Pick<GatewayTransportPort, 'onGatewayEvent' | 'onGatewayStatus'>;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  syncAttempts?: number;
}

interface Runtime {
  epoch: number;
  record: TeamMeetingRecord;
  signal: AbortController;
  stopped: boolean;
  submitted: boolean;
  terminal: boolean;
  task?: Task;
  receipt?: ChatDispatchReceipt;
  chain: Promise<unknown>;
  stopWork?: Promise<void>;
  executionDone?: boolean;
  stopDone?: boolean;
}

class Cancelled extends Error {}
const activeTurn = (status: string) => ['dispatching', 'running', 'syncing'].includes(status);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createTeamMeetingController(deps: MeetingControllerPorts) {
  const store = createTeamMeetingStore();
  const runtimes = new Map<string, Runtime>();
  const startingTeams = new Set<string>();
  let epoch = 0;
  let loading: Promise<void> | undefined;
  const current = (run: Runtime) => run.epoch === epoch;
  const check = (run: Runtime) => {
    if (!current(run) || run.stopped) throw new Cancelled();
  };
  const upsert = (record: TeamMeetingRecord) =>
    store.setState((state) => ({ records: [...state.records.filter((row) => row.id !== record.id), record] }));
  const report = (id: string, error: unknown) =>
    store.setState((state) => ({ errors: { ...state.errors, [id]: message(error) } }));
  function save(run: Runtime, update: (record: TeamMeetingRecord) => void, stopped = false): Promise<void> {
    const operation = run.chain.then(async () => {
      if (!current(run) || (run.stopped && !stopped)) throw new Cancelled();
      const record = structuredClone(run.record);
      update(record);
      const result = await deps.save({ record, expectedRevision: run.record.revision });
      if (!current(run)) throw new Cancelled();
      if (!result.ok || !result.result) throw new Error(result.error ?? 'Meeting persistence failed');
      run.record = result.result;
      upsert(
        run.stopped && run.record.status === 'running'
          ? { ...run.record, status: 'stopping', stopRequested: true }
          : run.record,
      );
    });
    run.chain = operation.catch(() => {});
    return operation;
  }
  async function abort(run: Runtime): Promise<TeamMeetingRecord['abortStatus']> {
    if (!run.task || !run.submitted || !current(run)) return 'not-running';
    let timer: number | undefined;
    try {
      const result = await Promise.race([
        deps.abort(run.task, run.receipt),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(resolve, 5000);
        }),
      ]);
      const value = result?.result as { aborted?: unknown } | undefined;
      return result?.ok && value?.aborted === true
        ? 'confirmed'
        : result?.ok && value?.aborted === false
          ? 'not-running'
          : 'unconfirmed';
    } catch {
      return 'unconfirmed';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async function stopped(
    run: Runtime,
    receipt?: ChatDispatchReceipt,
    acknowledgment?: TeamMeetingRecord['abortStatus'],
  ): Promise<void> {
    if (!current(run)) return;
    const abortStatus = acknowledgment ?? (await abort(run));
    if (!current(run)) return;
    await save(
      run,
      (record) => {
        record.status = 'stopped';
        record.stopRequested = true;
        record.abortStatus = abortStatus;
        for (const turn of record.turns) {
          if (turn.taskId === run.task?.id && receipt) turn.runId = receipt.runId;
          if (turn.status !== 'completed') turn.status = 'stopped';
        }
      },
      true,
    );
  }
  const sleep =
    deps.sleep ??
    ((ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener('abort', done, { once: true });
        if (signal.aborted) done();
      }));
  async function execute(run: Runtime) {
    const prior: Array<{ name: string; content: string }> = [];
    try {
      for (let index = 0; index < run.record.turns.length; index++) {
        check(run);
        const turn = run.record.turns[index];
        const task = deps.getTask(turn.taskId);
        if (!task || task.sessionKey !== turn.sessionKey || task.gatewayId !== run.record.gatewayId)
          throw new Error('Meeting task ownership changed');
        run.task = task;
        run.receipt = undefined;
        run.submitted = false;
        run.terminal = false;
        await deps.preflight(task, run.signal.signal);
        check(run);
        const context = await deps.context?.(task);
        check(run);
        await save(run, (record) => {
          record.status = 'running';
          record.turns[index].status = 'dispatching';
        });
        check(run);
        const observer = observeChatRun({
          gateway: deps.gateway,
          gatewayId: task.gatewayId,
          sessionKey: task.sessionKey,
          signal: run.signal.signal,
        });
        try {
          run.submitted = true;
          const question = [run.record.question, ...run.record.addenda].join('\n\n');
          const result = await deps.send(task.id, {
            content: turn.stage === 'summary' ? question : deps.stageRequest(turn.stage),
            contextPrefix: [context, buildMeetingStageContext(turn.stage, prior, question)]
              .filter(Boolean)
              .join('\n\n'),
            presetModel: task.model,
            presetThinking: task.thinkingLevel,
            signal: run.signal.signal,
            deferUserMessageUntilSent: true,
          });
          if (!current(run)) return;
          const receipt = result.ok ? result.dispatch : undefined;
          if (receipt?.sessionKey === task.sessionKey && typeof receipt.runId === 'string' && receipt.runId.trim())
            run.receipt = receipt;
          if (run.stopped) {
            if (receipt) {
              const acknowledgment = await abort(run);
              await run.stopWork;
              await stopped(run, receipt, acknowledgment);
            }
            return;
          }
          if (!result.ok) throw new Error('Meeting send failed');
          if (!receipt || receipt.sessionKey !== task.sessionKey || !receipt.runId.trim())
            throw new Error('Meeting acceptance could not be confirmed');
          observer.bind(receipt);
          await save(run, (record) => {
            record.turns[index].runId = receipt.runId;
            record.turns[index].status = 'running';
          });
          check(run);
          const terminal = await observer.terminal;
          check(run);
          run.terminal = terminal.kind === 'final' || terminal.kind === 'error' || terminal.kind === 'aborted';
          if (terminal.kind !== 'final')
            throw new Error(`Meeting run ${terminal.kind}${'reason' in terminal ? `: ${terminal.reason}` : ''}`);
          await save(run, (record) => {
            record.turns[index].status = 'syncing';
          });
          check(run);
          let ack: RunSyncResult = { kind: 'pending' };
          for (let attempt = 0; attempt < (deps.syncAttempts ?? 18); attempt++) {
            ack = await deps.syncRun(task.id, receipt);
            check(run);
            if (ack.kind !== 'pending') break;
            if (attempt + 1 < (deps.syncAttempts ?? 18))
              await sleep(Math.min(500 * 2 ** attempt, 5000), run.signal.signal);
            check(run);
          }
          if (ack.kind !== 'completed' || !ack.messageIds.length || !ack.content.trim())
            throw new Error(`Canonical completion unconfirmed${ack.kind === 'failed' ? `: ${ack.reason}` : ''}`);
          const completed = ack;
          await save(run, (record) => {
            record.turns[index].status = 'completed';
            record.turns[index].messageIds = completed.messageIds;
          });
          check(run);
          prior.push({ name: turn.agentName, content: completed.content });
        } finally {
          observer.dispose();
        }
      }
      await save(run, (record) => {
        record.status = 'completed';
      });
    } catch (error) {
      if (!current(run) || error instanceof Cancelled || run.stopped) return;
      report(run.record.id, error);
      const abortStatus = run.submitted && !run.terminal ? await abort(run) : undefined;
      if (!current(run)) return;
      const update = (record: TeamMeetingRecord) => {
        record.status = 'interrupted';
        if (abortStatus) record.abortStatus = abortStatus;
        for (const turn of record.turns)
          if (activeTurn(turn.status)) {
            if (turn.taskId === run.task?.id && run.receipt) turn.runId = run.receipt.runId;
            turn.status = 'interrupted';
            turn.failure = message(error);
          }
      };
      try {
        await save(run, update);
      } catch (failure) {
        if (current(run)) {
          const record = structuredClone(run.record);
          update(record);
          upsert(record);
          report(record.id, failure);
        }
      }
    } finally {
      run.executionDone = true;
      if (current(run) && (!run.stopped || run.stopDone)) runtimes.delete(run.record.id);
    }
  }
  function load(): Promise<void> {
    if (store.getState().loaded) return Promise.resolve();
    if (loading) return loading;
    const generation = epoch;
    store.setState({ loading: true, error: null });
    loading = (async () => {
      try {
        const result = await deps.list();
        if (generation !== epoch) return;
        if (!result.ok || !result.result) throw new Error(result.error ?? 'Meeting load failed');
        for (const original of result.result) {
          if (generation !== epoch) return;
          let record = structuredClone(original);
          if (
            ['draft', 'running', 'stopping'].includes(record.status) ||
            record.turns.some((turn) => activeTurn(turn.status))
          ) {
            if (record.turns.some((turn) => activeTurn(turn.status))) record.abortStatus = 'unconfirmed';
            record.status = 'interrupted';
            record.stopRequested = true;
            for (const turn of record.turns)
              if (activeTurn(turn.status)) {
                turn.status = 'interrupted';
                turn.failure = 'interrupted-after-restart';
              }
            const saved = await deps.save({ record, expectedRevision: original.revision });
            if (generation !== epoch) return;
            if (saved.ok && saved.result) record = saved.result;
            else report(record.id, saved.error ?? 'Meeting recovery persistence failed');
          }
          upsert(record);
        }
        store.setState({ loaded: true });
      } catch (error) {
        if (generation === epoch) {
          store.setState({ error: message(error) });
          throw error;
        }
      } finally {
        if (generation === epoch) {
          loading = undefined;
          store.setState({ loading: false });
        }
      }
    })();
    return loading;
  }
  async function start(input: CreateTeamMeetingInput): Promise<string> {
    const team = input.record.teamId;
    if (startingTeams.has(team) || [...runtimes.values()].some((run) => run.record.teamId === team))
      throw new Error('Team already has an active meeting');
    startingTeams.add(team);
    const generation = epoch;
    try {
      await load();
      if (generation !== epoch) throw new Cancelled();
      if (store.getState().records.some((record) => record.teamId === team && isTeamMeetingActive(record)))
        throw new Error('Team already has an active meeting');
      await deps.validateStart?.(input);
      if (generation !== epoch) throw new Cancelled();
      const created = await deps.create(input);
      if (generation !== epoch) throw new Cancelled();
      if (!created.ok || !created.result) throw new Error(created.error ?? 'Meeting creation failed');
      deps.registerTasks(created.result.tasks);
      const run: Runtime = {
        epoch,
        record: created.result.record,
        signal: new AbortController(),
        stopped: false,
        submitted: false,
        terminal: false,
        chain: Promise.resolve(),
      };
      runtimes.set(run.record.id, run);
      upsert(run.record);
      void execute(run);
      return run.record.id;
    } finally {
      if (generation === epoch) startingTeams.delete(team);
    }
  }
  function stop(id: string): Promise<void> {
    let run = runtimes.get(id);
    if (!run) {
      const record = store.getState().records.find((row) => row.id === id);
      const turn = record?.turns.find((row) => row.status === 'interrupted' || row.status === 'stopped');
      const task = turn ? deps.getTask(turn.taskId) : undefined;
      if (
        !record ||
        !['stopped', 'interrupted'].includes(record.status) ||
        !hasUnresolvedTeamMeetingAbort(record) ||
        !task ||
        !turn ||
        task.sessionKey !== turn.sessionKey ||
        task.gatewayId !== record.gatewayId
      )
        return Promise.resolve();
      run = {
        epoch,
        record,
        signal: new AbortController(),
        stopped: false,
        submitted: true,
        terminal: false,
        task,
        receipt: turn.runId ? { sessionKey: turn.sessionKey, runId: turn.runId } : undefined,
        chain: Promise.resolve(),
        executionDone: true,
      };
      runtimes.set(id, run);
    }
    if (!run) return Promise.resolve();
    if (run.stopWork) return run.stopWork;
    run.stopped = true;
    run.signal.abort();
    const cancellation = abort(run);
    upsert({ ...run.record, status: 'stopping', stopRequested: true });
    run.stopWork = (async () => {
      try {
        await save(
          run,
          (record) => {
            record.status = 'stopping';
            record.stopRequested = true;
            record.abortStatus = 'requested';
          },
          true,
        ).catch((error) => {
          if (current(run)) report(id, error);
        });
        await stopped(run, undefined, await cancellation);
      } catch (error) {
        if (current(run)) {
          report(id, error);
          upsert({ ...run.record, status: 'interrupted', stopRequested: true, abortStatus: 'unconfirmed' });
        }
      } finally {
        run.stopDone = true;
        if (current(run) && run.executionDone) runtimes.delete(id);
      }
    })();
    return run.stopWork;
  }
  function reset() {
    for (const run of runtimes.values()) {
      run.stopped = true;
      run.signal.abort();
      if (run.submitted && !run.terminal && run.task) void deps.abort(run.task, run.receipt).catch(() => {});
    }
    epoch++;
    runtimes.clear();
    startingTeams.clear();
    loading = undefined;
    store.setState(initialMeetingState());
  }
  return { store, start, stop, load, reset, getGeneration: () => epoch };
}
