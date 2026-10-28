import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeProbeDiagnostics, NodeProbeResult } from '../src/main/runtime/node-runtime.js';

/**
 * ⚠️ BUG-064 K1（2026-10-10 终审）：探测超时的**终止与清理必须真正有界**。
 *
 * 这一档用 **mock 的 child_process** 做故障注入（真实进程无法可靠伪造"kill 失败且
 * 回调永不到来"）——对应终审 receipt-proofs 的内存变换反例，逐条转 GREEN：
 *  - 无回调/未退出 ⇒ 清理宽限（1s）到点**必然落定**（exec-failed probe-cleanup-unconfirmed）；
 *  - 迟到的合法 stdout **不能**把已触发超时的结果翻回 ok；
 *  - 未确认退出的子进程真正 exit 前，**任何**新探测都被拒绝（含"重新准备"路径）；
 *    它自己退出后自动解除；
 *  - 迟到的 exit 事件（回调未到）也能确认清理并给可重试 timeout；
 *  - `withBoundedProbeRetry` / `pickNode` 见 cleanupConfirmed:false 一律停。
 * 真实子进程路径（PID 清理等）仍由 runtime-node.test.ts 的无 mock 档钉住。
 */

interface FakeChild {
  pid: number;
  exitCode: number | null;
  signalCode: string | null;
  kill: ReturnType<typeof vi.fn>;
  once: (event: string, cb: () => void) => FakeChild;
  stderr: { on: (event: string, cb: (chunk: unknown) => void) => unknown };
  emitExit: () => void;
  emitStderr: (text: string) => void;
}

const ctl = vi.hoisted(() => ({
  spawnCount: 0,
  killReturn: true,
  children: [] as FakeChild[],
  callbacks: [] as Array<(error: unknown, stdout?: string) => void>,
}));

function makeFakeChild(pid: number): FakeChild {
  const listeners: Record<string, Array<() => void>> = {};
  const stderrListeners: Array<(chunk: unknown) => void> = [];
  const child: FakeChild = {
    pid,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => {
      if (!ctl.killReturn) return false;
      return true;
    }),
    once: (event, cb) => {
      (listeners[event] ??= []).push(cb);
      return child;
    },
    stderr: {
      on: (_event, cb) => {
        stderrListeners.push(cb);
        return child;
      },
    },
    emitExit: () => {
      child.signalCode = 'SIGKILL';
      for (const cb of listeners['exit'] ?? []) cb();
    },
    emitStderr: (text: string) => {
      for (const cb of stderrListeners) cb(text);
    },
  };
  return child;
}

vi.mock('node:child_process', () => ({
  execFile: (
    _exe: string,
    _args: readonly string[],
    _opts: unknown,
    cb: (error: unknown, stdout?: string) => void,
  ): FakeChild => {
    ctl.spawnCount += 1;
    ctl.callbacks.push(cb);
    const child = makeFakeChild(9_000 + ctl.spawnCount);
    ctl.children.push(child);
    return child;
  },
}));

const diag = (over: Partial<NodeProbeDiagnostics> = {}): NodeProbeDiagnostics => ({
  code: null,
  signal: null,
  exitCode: null,
  existedAtStart: null,
  timeoutTriggered: false,
  stderrHead: null,
  ...over,
});

async function freshModule() {
  vi.resetModules();
  return import('../src/main/runtime/node-runtime.js');
}

beforeEach(() => {
  vi.useFakeTimers();
  ctl.spawnCount = 0;
  ctl.killReturn = true;
  ctl.children.length = 0;
  ctl.callbacks.length = 0;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('probeNodeAsync 清理有界（K1，故障注入）', () => {
  it('⭐ 无回调且子进程未退出 ⇒ 宽限到点必然落定：exec-failed + probe-cleanup-unconfirmed，且不再挂起', async () => {
    ctl.killReturn = false; // 模拟 kill 返回 false（文档：不能证明进程已终止）
    const mod = await freshModule();
    const pending = mod.probeNodeAsync('C:\\fake\\node.exe', { timeoutMs: 300 });
    await vi.advanceTimersByTimeAsync(300); // 超时触发（kill 失败，回调不来）
    await vi.advanceTimersByTimeAsync(1_000); // 清理宽限到点
    const result = await pending;
    expect(result.kind).toBe('exec-failed');
    expect(result.detail).toBe('probe-cleanup-unconfirmed');
    expect(result.diagnostics.cleanupConfirmed).toBe(false);
    expect(result.diagnostics.timeoutTriggered).toBe(true);
    // 终审反例：推进一小时仍 pending —— 现在必然已落定且计时器清空。
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('⭐⭐ 迟到的合法 stdout 不能把已超时的结果翻回 ok（超时后回调=清理确认 ⇒ timeout）', async () => {
    const mod = await freshModule();
    const pending = mod.probeNodeAsync('C:\\fake\\node.exe', { timeoutMs: 300 });
    await vi.advanceTimersByTimeAsync(300);
    // 迟到回调：真实世界回调到达即代表子进程已退出 —— 伪件同步置退出标记再回回调。
    ctl.children[0]!.signalCode = 'SIGKILL';
    ctl.callbacks[0]!(null, '26.3.1');
    const result = await pending;
    expect(result.kind).toBe('timeout');
    expect(result.version).toBeNull();
    expect(result.diagnostics.cleanupConfirmed).toBe(true);
    expect(result.diagnostics.signal).toBe('SIGKILL');
  });

  it('⭐⭐ 未确认退出的子进程 exit 之前，任何新探测都被拒绝；它退出后自动解除', async () => {
    ctl.killReturn = false;
    const mod = await freshModule();
    const first = mod.probeNodeAsync('C:\\fake\\node.exe', { timeoutMs: 300 });
    await vi.advanceTimersByTimeAsync(300 + 1_000);
    await first;
    expect(mod.hasUnreapedProbeChild()).toBe(true);
    const spawnsBefore = ctl.spawnCount;

    // 后续候选 / 用户再点重新准备：同形态的未确认失败，**不起新进程**。
    const blocked = await mod.probeNodeAsync('C:\\fake\\node.exe', { timeoutMs: 300 });
    expect(blocked.detail).toBe('probe-cleanup-unconfirmed');
    expect(blocked.diagnostics.cleanupConfirmed).toBe(false);
    expect(ctl.spawnCount).toBe(spawnsBefore);

    // 它自己真正退出 ⇒ 解除阻挡，下一次探测照常起进程。
    ctl.children[0]!.emitExit();
    expect(mod.hasUnreapedProbeChild()).toBe(false);
    const pending = mod.probeNodeAsync('C:\\fake\\node.exe', { timeoutMs: 300 });
    expect(ctl.spawnCount).toBe(spawnsBefore + 1);
    // 新探测照常走完整生命周期：这次让它正常返回版本（证明解除后功能恢复）。
    ctl.callbacks.at(-1)!(null, '26.3.1');
    const result = await pending;
    expect(result.kind).toBe('ok');
    expect(result.version).toBe('26.3.1');
    // 收尾：把这次探测的子进程退出，避免模块级引用泄漏进后续用例。
    ctl.children.at(-1)!.emitExit();
  });

  it('⭐ 迟到的 exit 事件（回调未到）也能确认清理并给可重试 timeout', async () => {
    const mod = await freshModule();
    const pending = mod.probeNodeAsync('C:\\fake\\node.exe', { timeoutMs: 300 });
    await vi.advanceTimersByTimeAsync(300);
    ctl.children[0]!.emitExit();
    const result = await pending;
    expect(result.kind).toBe('timeout');
    expect(result.diagnostics.cleanupConfirmed).toBe(true);
  });

  it('stderr 前缀在超时被杀（回调 stderr 为空）时仍进诊断', async () => {
    const mod = await freshModule();
    const pending = mod.probeNodeAsync('C:\\fake\\node.exe', { timeoutMs: 300 });
    ctl.children[0]!.emitStderr('boom-detail');
    await vi.advanceTimersByTimeAsync(300);
    ctl.children[0]!.signalCode = 'SIGKILL';
    ctl.callbacks[0]!(Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL' }));
    const result = await pending;
    expect(result.diagnostics.stderrHead).toContain('boom-detail');
    expect(result.detail).toBe('probe-timeout');
  });
});

describe('K1.5：cleanupConfirmed=false 的传播保护', () => {
  const unconfirmed = (): NodeProbeResult => ({
    kind: 'exec-failed',
    version: null,
    durationMs: 0,
    detail: 'probe-cleanup-unconfirmed',
    diagnostics: diag({ timeoutTriggered: true, cleanupConfirmed: false }),
  });

  it('⭐ withBoundedProbeRetry 见到未确认清理立刻停（不重试、不再起进程）', async () => {
    const mod = await freshModule();
    let calls = 0;
    let clock = 0;
    const { result, attempts } = await mod.withBoundedProbeRetry(
      async () => {
        calls += 1;
        clock += 10;
        return unconfirmed();
      },
      { now: () => clock },
    );
    expect(calls).toBe(1);
    expect(attempts).toHaveLength(1);
    expect(result.kind).toBe('exec-failed');
  });

  it('⭐ pickNode 见到未确认清理**不试下一个候选**（break，不掩盖）', async () => {
    const mod = await freshModule();
    const probed: string[] = [];
    const res = await mod.pickNode({
      candidates: [
        { origin: 'env', exe: 'E:\\a\\node.exe' },
        { origin: 'deployed', exe: 'C:\\b\\node.exe' },
      ],
      probe: async (exe) => {
        probed.push(exe);
        return unconfirmed();
      },
      isSupported: () => true,
      supportedRange: '>=26',
    });
    expect(probed).toEqual(['E:\\a\\node.exe']);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failureClass).toBe('exec-failed');
  });
});
