import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSessionKey } from '@clawwork/shared';
import { createExecutionProjection, reduceExecutionProjection, type ExecutionEvent } from '@clawwork/core';
import { createExecutionHistory, type ExecutionHistoryStore } from '../src/main/execution/history';

/**
 * 2026-10-14 集中修复批（V owner）· R1 / R3 / R4 / history-order 的**仓库内正向合同**。
 *
 * 口径（preflight R1/R3/R4 + history-order 复审的最小修法）：
 *  - R1：业务身份（原生 sessionKey/runId）与物理路径组件**分离** —— 文件系统用稳定编码，
 *        append/list/read 同一映射，记录内校验原始身份；不允许「仅放开冒号」或「`_` 清洗」；
 *  - R3：队列预算按**条数 + 字节**双项、入队前反复腾位/拒收；gap 计入同一预算且按
 *        (session,run) 有界；queueBytes ≡ 队列内容实际编码字节总和；
 *  - R4：listRuns 在**应用限额之前**按可信元数据（mtime）确定最新候选，readdir 顺序不参与；
 *  - history-order：持久化（落盘）顺序 ≡ 接收顺序 —— 来源 seq 只在同域内解释，
 *        readRun 不再按 seq 重排（不同生产者/重建后的 seq 域不可比）。
 */

function makeRecord(over: Partial<ExecutionEvent> = {}): ExecutionEvent {
  return {
    schemaVersion: 1,
    eventId: over.eventId ?? 'f1#0',
    seq: over.seq ?? 0,
    runId: 'run-a',
    taskId: 'task-1',
    source: {
      gatewayId: 'gw-1',
      channel: 'main',
      nativeSessionKey: 'agent:main:clawwork:task:task-1',
      nativeRunId: 'run-native-a',
      event: 'agent',
      stream: 'tool',
      derivedIndex: 0,
    },
    evidence: 'observed',
    receivedAt: 1_000,
    type: 'step.dispatched',
    payload: { toolCallId: 'tc-1', name: 'read', phase: 'update' },
    ...over,
  } as ExecutionEvent;
}

type InstrumentedStore = ExecutionHistoryStore & {
  diagnostics: Array<Record<string, unknown>>;
};

function makeStore(rootDir: string, over: Record<string, unknown> = {}): InstrumentedStore {
  const diagnostics: Array<Record<string, unknown>> = [];
  const store = createExecutionHistory({
    rootDir,
    workspaceKey: 'ws-1',
    maxQueueEntries: 8,
    maxQueueBytes: 16 * 1024,
    maxEntryBytes: 4096,
    maxRunBytes: 8 * 1024,
    maxDirBytes: 1024 * 1024,
    retentionDays: 0,
    flushIntervalMs: 3_600_000,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic as unknown as Record<string, unknown>),
    ...over,
  });
  return Object.assign(store, { diagnostics });
}

function listAll(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out;
}

describe('R1 · 真实 sessionKey/runId 的身份映射（业务身份 ≠ 物理路径）', () => {
  it('⭐ 真实 buildSessionKey（含/不含设备域，含 >64 字符长键）append→flush→重建实例→list/read→恢复投影', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-identity-'));
    const plain = buildSessionKey('task-1'); // agent:main:clawwork:task:task-1（含冒号）
    const longDevice = 'device-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const withDevice = buildSessionKey('task-1', 'main', longDevice);
    expect(plain.length).toBeLessThanOrEqual(64);
    expect(withDevice.length).toBeGreaterThan(64); // 旧 VALID_KEY_RE 的 64 上限反例

    const h = makeStore(root);
    h.append(plain, [makeRecord({ runId: 'run-plain', eventId: 'p#0' })]);
    h.append(withDevice, [makeRecord({ runId: 'run-device', eventId: 'd#0' })]);
    await h.flush();
    await h.close();

    // 销毁实例 → 重建（模拟应用重启）
    const h2 = makeStore(root);
    expect(await h2.listRuns(plain)).toEqual(['run-plain']);
    expect(await h2.listRuns(withDevice)).toEqual(['run-device']);
    const read = await h2.readRun(plain, 'run-plain');
    expect(read.records.map((r) => r.eventId)).toEqual(['p#0']);

    // 恢复投影：真实记录喂归约，落盘前后一致
    let live = createExecutionProjection('run-plain');
    live = reduceExecutionProjection(live, makeRecord({ runId: 'run-plain', eventId: 'p#0' }));
    let recovered = createExecutionProjection('run-plain');
    for (const record of read.records) recovered = reduceExecutionProjection(recovered, record);
    expect(Object.values(recovered.steps)[0]?.state).toBe(Object.values(live.steps)[0]?.state);
    h2.close();
  });

  it('⭐ 原始身份不同但简单清洗（`_` 替换）会相同的键互不覆盖', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-collide-'));
    const h = makeStore(root);
    // 清洗型映射会把这三个键映射到同一个物理名 ⇒ 后写覆盖前写
    h.append('a:b', [makeRecord({ runId: 'r1', eventId: 'x1' })]);
    h.append('a_b', [makeRecord({ runId: 'r1', eventId: 'x2' })]);
    h.append('a%b', [makeRecord({ runId: 'r1', eventId: 'x3' })]);
    await h.flush();

    expect((await h.readRun('a:b', 'r1')).records.map((r) => r.eventId)).toEqual(['x1']);
    expect((await h.readRun('a_b', 'r1')).records.map((r) => r.eventId)).toEqual(['x2']);
    expect((await h.readRun('a%b', 'r1')).records.map((r) => r.eventId)).toEqual(['x3']);
    expect(await h.listRuns('a:b')).toEqual(['r1']);
    expect(await h.listRuns('a_b')).toEqual(['r1']);
    h.close();
  });

  it('⭐ 穿越/非法身份输入：不在目录外写读、不抛异常、显式诊断', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-escape-'));
    const h = makeStore(root);
    for (const bad of ['../escape', '..', 'a/../../b', 'a\\b', '', 'a\u0001b']) {
      h.append(bad, [makeRecord({ runId: 'r-escape', eventId: `e:${bad}` })]);
    }
    h.append('s1', [makeRecord({ runId: '../run-escape', eventId: 'nested-run' })]);
    await h.flush();

    const files = listAll(root);
    expect(files.some((f) => f.includes('escape') || f.includes('..'))).toBe(false);
    expect(await h.listRuns('../escape')).toEqual([]);
    const read = await h.readRun('../escape', 'r-escape');
    expect(read.records).toEqual([]);
    expect(
      h.diagnostics.some((d) => d.reason === 'invalid-key'),
      '非法身份必须走脱敏诊断出口（不静默）',
    ).toBe(true);
    h.close();
  });

  it('⭐ 记录内校验原始身份：文件里混入 runId 不符的记录 ⇒ 拒收该条并记缺口', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-inner-'));
    const h = makeStore(root);
    h.append('s1', [makeRecord({ runId: 'run-a', eventId: 'ok#0' })]);
    await h.flush();
    const files = listAll(root).filter((f) => f.endsWith('.ndjson'));
    expect(files).toHaveLength(1);
    // 混入一条身份不符的记录（同文件、不同 runId）
    writeFileSync(files[0], `${JSON.stringify(makeRecord({ runId: 'run-b', eventId: 'alien#0' }))}\n`, {
      flag: 'a',
    });

    const read = await h.readRun('s1', 'run-a');
    expect(read.records.map((r) => r.eventId)).toEqual(['ok#0']);
    expect(
      read.gaps.some((g) => g.reason === 'identity-mismatch'),
      '身份不符必须显式记缺口，不冒充本 run 证据',
    ).toBe(true);
    h.close();
  });
});

describe('R3 · 队列预算（条数 + 字节双项，gap 计入同一预算）', () => {
  it('⭐ 填满后追加 10× 队列长度：条数/字节恒不越界、gap 有界、queueBytes = 实际编码字节总和', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-overflow-'));
    const h = makeStore(root, { maxQueueEntries: 4, maxQueueBytes: 4096 });
    // 统一形状的进度记录（等长 eventId 与 seq）⇒ 每条编码字节数一致，queueBytes 必须是它的整数倍
    const sample = makeRecord({ eventId: 'p000', seq: 100 });
    const bytesPerRecord = Buffer.byteLength(JSON.stringify(sample));

    for (let i = 0; i < 40; i += 1) {
      h.append('s1', [makeRecord({ eventId: `p${String(i).padStart(3, '0')}`, seq: 100 + i })]);
      const stats = h.queueStats();
      expect(stats.entries, `第 ${i} 条后队列条数不越界`).toBeLessThanOrEqual(4);
      expect(stats.bytes, `第 ${i} 条后队列字节不越界`).toBeLessThanOrEqual(4096);
      expect(stats.bytes, 'queueBytes ≡ 队列内容实际编码字节总和').toBe(stats.entries * bytesPerRecord);
    }

    await h.flush();
    const result = await h.readRun('s1', 'run-a');
    expect(
      result.gaps.filter((g) => g.reason === 'queue-full').length,
      '缺口记录本身有界：同 run 一次 flush 至多一条合并缺口',
    ).toBeLessThanOrEqual(1);
    const overflowDropped = result.gaps
      .filter((g) => g.reason === 'queue-full')
      .reduce((sum, gap) => sum + gap.dropped, 0);
    expect(overflowDropped, '缺口如实报告丢了多少条').toBeGreaterThan(0);
    h.close();
  });

  it('⭐ 终态也受限：全终态队列满时入队被拒并显式报告缺证（不吹"永不丢终态"）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-terminal-'));
    const h = makeStore(root, { maxQueueEntries: 4, maxQueueBytes: 4096 });
    const terminal = (runId: string, eventId: string) =>
      makeRecord({
        runId,
        eventId,
        type: 'step.result',
        payload: { toolCallId: 'tc-1', name: 'read', isError: false },
      });
    for (let i = 0; i < 8; i += 1) {
      h.append('s1', [terminal(`run-${i}`, `t${i}#0`)]);
      const stats = h.queueStats();
      expect(stats.entries).toBeLessThanOrEqual(4);
      expect(stats.bytes).toBeLessThanOrEqual(4096);
    }
    expect(
      h.diagnostics.some((d) => d.reason === 'queue-full' && Number(d.dropped) >= 1),
      '容不下终态时必须有诊断，不能静默丢',
    ).toBe(true);

    await h.flush();
    // 被拒的终态在其 run 上留下缺证记录（按 run 关联）
    const droppedRunFiles = listAll(root).filter((f) => f.endsWith('.ndjson')).length;
    expect(droppedRunFiles).toBeGreaterThan(0);
    h.close();
  });

  it('⭐ 大记录（超单条预算）不入队：显式 entry-budget 诊断', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-bigentry-'));
    const h = makeStore(root, { maxEntryBytes: 512 });
    h.append('s1', [
      makeRecord({
        eventId: 'big#0',
        type: 'step.result',
        payload: { toolCallId: 'tc-1', name: 'read', isError: false, resultText: 'x'.repeat(2000) },
      }),
    ]);
    expect(h.diagnostics.some((d) => d.reason === 'entry-budget')).toBe(true);
    expect(h.queueStats().entries).toBe(0);
    await h.flush();
    expect(await h.readRun('s1', 'run-a')).toMatchObject({ records: [] });
    h.close();
  });
});

describe('R4 · listRuns 在限额前按可信元数据确定最新候选', () => {
  it('⭐ 9+ run、最新一个最后写入：listRuns 最新在前（readdir 顺序不参与），限额 slice(0,8) 内', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-latest-'));
    const h = makeStore(root);
    const older = ['a-old', 'b-old', 'c-old', 'd-old', 'e-old', 'f-old', 'g-old', 'h-old'];
    for (const runId of older) {
      h.append('s1', [makeRecord({ runId, eventId: `${runId}#0` })]);
      await h.flush();
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
    h.append('s1', [makeRecord({ runId: 'z-latest', eventId: 'z#0' })]);
    await h.flush();

    const runs = await h.listRuns('s1');
    expect(runs).toHaveLength(9);
    expect(runs[0], '最新 run 必须在应用限额之前就排在最前').toBe('z-latest');
    expect(runs.slice(0, 8), '调用方 slice(0,8) 必须包含最新 run').toContain('z-latest');
    h.close();
  });

  it('⭐ 同 mtime 的稳定排序：重复调用顺序一致（确定性，不靠 readdir 抖动）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-stable-'));
    const h = makeStore(root);
    h.append('s1', [makeRecord({ runId: 'r-b-x', eventId: 'b#0' })]);
    await h.flush();
    h.append('s1', [makeRecord({ runId: 'r-a-x', eventId: 'a#0' })]);
    await h.flush();
    // 强制同一 mtime
    for (const file of listAll(root).filter((f) => f.endsWith('.ndjson'))) {
      const at = new Date(1_700_000_000_000);
      utimesSync(file, at, at);
    }
    const first = await h.listRuns('s1');
    const second = await h.listRuns('s1');
    expect(first).toEqual(second);
    expect(first).toEqual(['r-a-x', 'r-b-x']); // 同时间 ⇒ 名字升序（确定性）
    h.close();
  });

  it('⭐ 最新 run 之后又有新写入 ⇒ 最新在前跟随真实证据（append 更新 mtime）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-follow-'));
    const h = makeStore(root);
    h.append('s1', [makeRecord({ runId: 'run-old', eventId: 'o#0' })]);
    await h.flush();
    await new Promise((resolve) => setTimeout(resolve, 8));
    h.append('s1', [makeRecord({ runId: 'run-newer', eventId: 'n#0' })]);
    await h.flush();
    await new Promise((resolve) => setTimeout(resolve, 8));
    h.append('s1', [makeRecord({ runId: 'run-old', eventId: 'o#1', seq: 1 })]);
    await h.flush();
    const runs = await h.listRuns('s1');
    expect(runs[0], '最近仍被写入的 run 才是在场的那个').toBe('run-old');
    h.close();
  });
});

describe('history-order · 持久化消费顺序与来源 seq 分离', () => {
  it('⭐ 跨生产者 seq 域（20 → 21 → 0 重建）+ 同 receivedAt：落盘顺序 ≡ 接收顺序，恢复与现场一致', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-order-'));
    const h = makeStore(root);
    const requested = makeRecord({
      eventId: 'req#0',
      seq: 20,
      type: 'cancel.requested',
      payload: { stopTicketId: 'ticket-1' },
    });
    const unconfirmed = makeRecord({
      eventId: 'unc#0',
      seq: 21,
      type: 'cancel.unconfirmed',
      payload: { stopTicketId: 'ticket-1', reason: 'timeout' },
    });
    const confirmed = makeRecord({
      eventId: 'conf#0',
      seq: 0, // 生产者重建：计数重置，seq 域不可比
      type: 'cancel.confirmed',
      payload: { stopTicketId: 'ticket-1' },
    });
    h.append('s1', [requested]);
    h.append('s1', [unconfirmed]);
    h.append('s1', [confirmed]);
    await h.flush();

    const read = await h.readRun('s1', 'run-a');
    expect(
      read.records.map((r) => r.eventId),
      'readRun 不得按 seq 重排（不同 seq 域不可比）',
    ).toEqual(['req#0', 'unc#0', 'conf#0']);

    let live = createExecutionProjection('run-a');
    for (const event of [requested, unconfirmed, confirmed]) live = reduceExecutionProjection(live, event);
    let recovered = createExecutionProjection('run-a');
    for (const record of read.records) recovered = reduceExecutionProjection(recovered, record);
    expect(live.stop.state).toBe('confirmed');
    expect(recovered.stop.state, '落盘前后恢复投影一致').toBe(live.stop.state);
    h.close();
  });

  it('⭐ 审批终态恢复：requested(seq 高) → resolved(seq 低) 仍按接收顺序归约', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-approval-'));
    const h = makeStore(root);
    const requested = makeRecord({
      eventId: 'ap-req#0',
      seq: 30,
      type: 'approval.requested',
      payload: { approvalId: 'ap-1', toolCallId: 'tc-1', status: 'pending' },
    });
    const resolved = makeRecord({
      eventId: 'ap-res#0',
      seq: 1,
      type: 'approval.resolved',
      payload: { approvalId: 'ap-1', toolCallId: 'tc-1', decision: 'allow' },
    });
    h.append('s1', [requested]);
    h.append('s1', [resolved]);
    await h.flush();

    const read = await h.readRun('s1', 'run-a');
    expect(read.records.map((r) => r.eventId)).toEqual(['ap-req#0', 'ap-res#0']);
    let recovered = createExecutionProjection('run-a');
    for (const record of read.records) recovered = reduceExecutionProjection(recovered, record);
    expect(Object.values(recovered.approvals)[0]?.state).toBe('resolved');
    h.close();
  });

  it('⭐ 双生产者 seq 交错（dispatcher/main 各自从 0 起）：交错顺序也是持久化顺序', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-interleave-'));
    const h = makeStore(root);
    const dispatchSide = makeRecord({ eventId: 'd-5#0', seq: 5 });
    const mainSide = makeRecord({
      eventId: 'main#x',
      seq: 0,
      type: 'delivery.started',
      payload: { operationId: 'op-1', kind: 'video' },
    });
    h.append('s1', [dispatchSide]);
    h.append('s1', [mainSide]);
    await h.flush();
    const read = await h.readRun('s1', 'run-a');
    expect(read.records.map((r) => r.eventId)).toEqual(['d-5#0', 'main#x']);
    h.close();
  });

  it('⭐ 落盘顺序在关闭重开（close）后保持：close 排水也按入队顺序', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-close-'));
    const h = makeStore(root);
    const first = makeRecord({ eventId: 'c1#0', seq: 9 });
    const second = makeRecord({ eventId: 'c2#0', seq: 1 });
    h.append('s1', [first]);
    h.append('s1', [second]);
    await h.close();
    const h2 = makeStore(root);
    expect((await h2.readRun('s1', 'run-a')).records.map((r) => r.eventId)).toEqual(['c1#0', 'c2#0']);
    h2.close();
  });
});
