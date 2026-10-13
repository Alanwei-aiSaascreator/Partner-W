import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionEvent } from '@clawwork/core';
import { createExecutionHistory, type ExecutionHistoryStore } from '../src/main/execution/history';

/**
 * V4（2026-10-13 step 5）· 执行历史 writer 红例（main 侧模块）。
 *
 * 口径：待写队列/单 run/目录总量三档预算；队列或磁盘耗尽**显式记 gap/降级**；
 * fire-and-forget（append 只入队，绝不阻塞）；半行 JSON 容忍；重启同 ID 重放不重复计；
 * 跨 workspace 读取拒（实例按 workspaceKey 隔离）；保留期只清理**我们自己的**文件。
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

function makeStore(
  rootDir: string,
  over: Record<string, unknown> = {},
): ExecutionHistoryStore & {
  diagnostics: Array<Record<string, unknown>>;
} {
  const diagnostics: Array<Record<string, unknown>> = [];
  const store = createExecutionHistory({
    rootDir,
    workspaceKey: 'ws-1',
    maxQueueEntries: 8,
    maxQueueBytes: 16 * 1024,
    maxEntryBytes: 4096,
    maxRunBytes: 8 * 1024,
    maxDirBytes: 32 * 1024,
    retentionDays: 7,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic as unknown as Record<string, unknown>),
    ...over,
  });
  return Object.assign(store, { diagnostics });
}

describe('V4 · createExecutionHistory —— 有界写入', () => {
  it('⭐ fire-and-forget：append 只入队（同步返回），flush 才落盘', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-'));
    const h = makeStore(root);
    h.append('s1', [makeRecord()]);
    // 同步返回：不需要 await 任何磁盘动作
    expect(h.diagnostics).toHaveLength(0);
    await h.flush();
    const files = listAll(root);
    expect(files).toHaveLength(1);
    h.close();
  });

  it('⭐ 队列满 ⇒ 显式记 gap、进度先丢、终态保留', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-'));
    const h = makeStore(root, { maxQueueEntries: 4 });
    // 3 条进度 + 1 条终态 = 满；再进 1 条进度 ⇒ 溢出
    h.append('s1', [makeRecord({ eventId: 'p1', seq: 0 }), makeRecord({ eventId: 'p2', seq: 1 })]);
    h.append('s1', [
      makeRecord({
        eventId: 't1',
        seq: 2,
        type: 'step.result',
        payload: { toolCallId: 'tc-1', name: 'read', isError: false },
      }),
    ]);
    h.append('s1', [makeRecord({ eventId: 'p3', seq: 3 })]);
    h.append('s1', [makeRecord({ eventId: 'p4', seq: 4 })]);

    await h.flush();
    const result = await h.readRun('s1', 'run-a');
    expect(result.gaps, '溢出必须显式记 gap').toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: 'queue-full' })]),
    );
    expect(
      result.records.some((r) => r.type === 'step.result'),
      '终态不因溢出丢失',
    ).toBe(true);
    h.close();
  });

  it('⭐ 单 run 超预算 ⇒ 进度不再写入、显式 gap（终态仍尽力保留）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-'));
    const h = makeStore(root, { maxRunBytes: 1024 });
    for (let i = 0; i < 8; i += 1) {
      h.append('s1', [
        makeRecord({
          eventId: `p${i}`,
          seq: i,
          payload: { toolCallId: 'tc-1', name: 'read', phase: 'update', startedAtMs: i },
        }),
      ]);
    }
    h.append('s1', [
      makeRecord({
        eventId: 't-final',
        seq: 99,
        type: 'step.result',
        payload: { toolCallId: 'tc-1', name: 'read', isError: false, resultText: 'done' },
      }),
    ]);

    await h.flush();
    const result = await h.readRun('s1', 'run-a');
    expect(result.truncated).toBe(true);
    expect(result.gaps.some((g) => g.reason === 'run-budget')).toBe(true);
    expect(result.records.filter((r) => r.type === 'step.result')).toHaveLength(1);
    h.close();
  });

  it('⭐ 半行 JSON ⇒ 读取跳过残缺行、完整记录照常恢复', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-'));
    const h = makeStore(root);
    h.append('s1', [makeRecord({ eventId: 'ok-1' })]);
    await h.flush();
    // 模拟崩溃留下的半行（按真实落盘位置找文件 —— 物理名是身份编码，不写死）
    const [file] = listAll(root).filter((f) => f.endsWith('.ndjson'));
    expect(file).toBeTruthy();
    writeFileSync(file, '{"eventId":"half', { flag: 'a' });

    const result = await h.readRun('s1', 'run-a');
    expect(result.records.map((r) => r.eventId)).toContain('ok-1');
    expect(result.records.some((r) => r.eventId === 'half')).toBe(false);
    h.close();
  });

  it('⭐ 重启同 ID 重放：readRun 两次一致；事件 ID 稳定（不重新生成）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-'));
    const h = makeStore(root);
    h.append('s1', [makeRecord({ eventId: 'f1#0', seq: 0 })]);
    await h.flush();

    const first = await h.readRun('s1', 'run-a');
    const second = await h.readRun('s1', 'run-a');
    expect(second.records.map((r) => r.eventId)).toEqual(first.records.map((r) => r.eventId));
    expect(first.records[0].eventId).toBe('f1#0');
    h.close();
  });

  it('⭐ 跨 workspace 读取拒：实例隔离，另一个 workspace 看不到本 workspace 的 run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-'));
    const a = makeStore(root); // workspaceKey 'ws-1'
    a.append('s1', [makeRecord()]);
    await a.flush();

    const b = makeStore(root, { workspaceKey: 'ws-2' });
    const listed = await b.listRuns('s1');
    expect(listed, '不同 workspace 的 run 不可见').toEqual([]);
    a.close();
    b.close();
  });

  it('⭐ 磁盘写失败 ⇒ 只记诊断、不崩溃（write-error 闩锁，flush 不抛）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-'));
    // 先正常写一次拿到真实落盘路径（物理名 = 身份编码，不写死）
    const probe = makeStore(root);
    probe.append('s1', [makeRecord()]);
    await probe.flush();
    const [file] = listAll(root).filter((f) => f.endsWith('.ndjson'));
    expect(file).toBeTruthy();
    // 把文件换成同名**目录** ⇒ 之后的 appendFile 必失败
    nodeFs.rmSync(file, { force: true });
    mkdirSync(file, { recursive: true });

    const h = makeStore(root);
    h.append('s1', [makeRecord()]);
    await expect(h.flush(), 'flush 不把磁盘错误抛给调用方').resolves.toBeUndefined();

    expect(
      h.diagnostics.some((d) => d.reason === 'write-error'),
      '写失败必须显式诊断',
    ).toBe(true);
    h.close();
    probe.close();
  });

  it('⭐ 保留期只清理我们自己的文件：非本模块文件与未过期文件不删', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-'));
    const h = makeStore(root);
    const ourDir = join(root, 'ws-1', 's1');
    mkdirSync(ourDir, { recursive: true });
    // 过期的自有文件（mtime 8 天前）
    writeFileSync(join(ourDir, 'old-run.ndjson'), '{}\n');
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    nodeFs.utimesSync(join(ourDir, 'old-run.ndjson'), old, old);
    // 别人的文件（非 ndjson）与未过期文件
    writeFileSync(join(ourDir, 'user-notes.txt'), 'keep me');
    writeFileSync(join(ourDir, 'fresh-run.ndjson'), '{}\n');

    const h2 = makeStore(root);
    h2.start();
    // 保留期清理是 start 里的异步 fire-and-forget ⇒ 等它完成
    await vi.waitFor(() => {
      expect(
        listAll(root).some((f) => f.endsWith('old-run.ndjson')),
        '过期自有文件已清',
      ).toBe(false);
    });
    h2.stop();

    const left = listAll(root);
    expect(
      left.some((f) => f.endsWith('user-notes.txt')),
      '非本模块文件绝不删',
    ).toBe(true);
    expect(
      left.some((f) => f.endsWith('fresh-run.ndjson')),
      '未过期不删',
    ).toBe(true);
    h.close();
    h2.close();
  });

  it('⭐ 路径穿越拒：sessionKey/runId 含分隔符被拒（只在本目录内读写）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-'));
    const h = makeStore(root);
    h.append('../escape', [makeRecord()]);
    await h.flush();
    const outside = listAll(root).filter((f) => f.includes('escape') || f.includes('..'));
    expect(outside).toHaveLength(0);
    h.close();
  });
});

function listAll(root: string): string[] {
  const { readdirSync, statSync } = nodeFs;
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (statSync(full).isFile()) out.push(full);
    }
  };
  walk(root);
  return out;
}
