import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  aggregateFailureClass,
  classifyProbeFailure,
  deployedNodePathFor,
  isSupportedNodeVersionShape,
  loadNodeVersionContract,
  nodeCandidates,
  pickNode,
  probeNodeAsync,
  withBoundedProbeRetry,
  type NodeAttempt,
  type NodeProbeDiagnostics,
  type NodeProbeKind,
  type NodeProbeResult,
} from '../src/main/runtime/node-runtime.js';
import { SUPPORTED_NODE_RANGE, isSupportedNode } from './helpers/runtime-fixture.js';

/**
 * Node 解析 —— 「U 盘带 Node」那一半。
 *
 * 为什么值得单独一组测试：Electron 内嵌的 Node 20.19.1 起不了 openclaw
 * （要求 >=24.16 <25 || >=26.1，且用了 `node:sqlite`）。**必须先探版本再 spawn**，
 * 否则用户只会在网关 stderr 里看到一行 "Node.js ... is required"，
 * 根本看不出是装载器的锅。
 *
 * ⚠️ 版本区间**不硬编码**：区间由 openclaw 自己发布的 `node-version.mjs` 说了算
 * （`isSupportedOpenClawNodeVersion` / `SUPPORTED_NODE_VERSIONS`）。
 *
 * ⚠️⚠️ BUG-064（2026-10-10，换电脑卡 17% 现场；含 2026-10-10 晚 Codex 复核合同）：
 *  - 探测**异步 + 结构化分档**（missing/permission/timeout/exec-failed/unusable-output）；
 *  - `timeout` 的唯一依据是**我们自己的计时器触发**（`timeoutTriggered`），
 *    `killed`/`signal` 本身不说明终止原因；
 *  - **只有 timeout 有界重试**（≤2 次），而且是**同一单调时钟的 deadline**：
 *    每次探测拿到的是 `min(单次上限, 剩余预算)` —— 35s 预算 + 20s 单次
 *    不可能跑成 40s（评审反例在此转绿）；
 *  - 诊断逐字段保留（code/signal/exitCode/existedAtStart/timeoutTriggered/stderrHead）。
 */

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clawwork-node-'));
});

afterEach(() => {
  if (tmpRoot && tmpRoot.includes(path.join(os.tmpdir(), 'clawwork-node-'))) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

const RANGE = SUPPORTED_NODE_RANGE;
const realWorldSupport = isSupportedNode;

/** 结构化诊断默认值（缺席即 null，不伪造）。 */
const diag = (over: Partial<NodeProbeDiagnostics> = {}): NodeProbeDiagnostics => ({
  code: null,
  signal: null,
  exitCode: null,
  existedAtStart: null,
  timeoutTriggered: false,
  stderrHead: null,
  ...over,
});

const okResult = (version: string): NodeProbeResult => ({
  kind: 'ok',
  version,
  durationMs: 0,
  diagnostics: diag({ exitCode: 0 }),
});
const missingResult = (): NodeProbeResult => ({
  kind: 'missing',
  version: null,
  durationMs: 0,
  diagnostics: diag({ code: 'ENOENT', existedAtStart: false }),
});
const timeoutResult = (): NodeProbeResult => ({
  kind: 'timeout',
  version: null,
  durationMs: 0,
  diagnostics: diag({ timeoutTriggered: true, signal: 'SIGKILL' }),
});

/** 结构化探测的测试桩：版本号 → ok；null → missing。 */
function probeOf(versions: Record<string, string | null>): (exe: string) => Promise<NodeProbeResult> {
  return async (exe: string): Promise<NodeProbeResult> => {
    const version = versions[exe] ?? null;
    return version === null ? missingResult() : okResult(version);
  };
}

describe('nodeCandidates', () => {
  it('⭐ 顺序：CLAWWORK_NODE → 本机 deployed（**没有别的兜底**）', () => {
    const c = nodeCandidates({
      envNode: 'E:\\my-node\\node.exe',
      deployedNodePath: 'C:\\cache\\deployed\\k1\\node\\node.exe',
    });
    expect(c.map((x) => x.origin)).toEqual(['env', 'deployed']);
  });

  it('⭐ 没有 PATH 兜底 —— 部署自包含，不静默换用机器上的 Node', () => {
    const c = nodeCandidates({ deployedNodePath: 'C:\\cache\\deployed\\k1\\node\\node.exe' });
    expect(c.map((x) => x.origin)).toEqual(['deployed']);
    expect(c.some((x) => x.exe === 'node')).toBe(false);
  });

  it('⭐ 一个都不给 ⇒ 空列表（据此报错，而不是随便找一个顶替）', () => {
    expect(nodeCandidates({})).toEqual([]);
  });
});

describe('deployedNodePathFor', () => {
  it('⭐ 路径由**传入的根**决定 —— 换盘符（F→G）后探测的是新盘符下的同一个位置', () => {
    expect(deployedNodePathFor('G:\\Partner-W-运行数据\\portable-runtime-cache\\runtime\\deployed\\k1')).toBe(
      path.join('G:\\Partner-W-运行数据\\portable-runtime-cache\\runtime\\deployed\\k1', 'node', 'node.exe'),
    );
  });
});

describe('pickNode', () => {
  const candidates = nodeCandidates({
    envNode: 'E:\\my-node\\node.exe',
    deployedNodePath: 'C:\\cache\\deployed\\k1\\node\\node.exe',
  });

  it('⭐ 跳过不受支持的 20.19.1，选中 26.3.1', async () => {
    const res = await pickNode({
      candidates,
      probe: probeOf({
        'E:\\my-node\\node.exe': '20.19.1',
        'C:\\cache\\deployed\\k1\\node\\node.exe': '26.3.1',
      }),
      isSupported: realWorldSupport,
      supportedRange: RANGE,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.node.version).toBe('26.3.1');
    expect(res.node.origin).toBe('deployed');
    expect(res.attempts[0]).toMatchObject({
      origin: 'env',
      exe: 'E:\\my-node\\node.exe',
      kind: 'ok',
      version: '20.19.1',
      supported: false,
    });
  });

  it('⭐ env 显式指定的那个受支持就用它，短路不再探本机的', async () => {
    const probed: string[] = [];
    const res = await pickNode({
      candidates,
      probe: async (exe) => {
        probed.push(exe);
        return okResult('26.3.1');
      },
      isSupported: realWorldSupport,
      supportedRange: RANGE,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.node.origin).toBe('env');
    expect(probed).toEqual(['E:\\my-node\\node.exe']);
  });

  it('探不到的候选直接跳过（文件不在 / 不是可执行 / 超时）', async () => {
    const res = await pickNode({
      candidates,
      probe: async (exe) => (exe.startsWith('E:') ? missingResult() : okResult('26.3.1')),
      isSupported: realWorldSupport,
      supportedRange: RANGE,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.node.origin).toBe('deployed');
  });

  it('⭐ 全不可用时：错误**同时**带实际版本与要求区间', async () => {
    const res = await pickNode({
      candidates,
      probe: probeOf({ 'E:\\my-node\\node.exe': '20.19.1', 'C:\\cache\\deployed\\k1\\node\\node.exe': '22.4.0' }),
      isSupported: realWorldSupport,
      supportedRange: RANGE,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('20.19.1');
    expect(res.message).toContain('22.4.0');
    expect(res.message).toContain(RANGE);
    expect(res.message).toMatch(/node/i);
    expect(res.failureClass).toBe('version-unsupported');
  });

  it('一个候选都没有 ⇒ ok:false（不是崩，也不静默返回空）', async () => {
    const res = await pickNode({
      candidates: [],
      probe: async () => okResult('26.3.1'),
      isSupported: realWorldSupport,
      supportedRange: RANGE,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain(RANGE);
    expect(res.failureClass).toBe('none');
  });

  it('⭐ 环境变量指的那个不合格时**继续往下试**，不是立刻失败', async () => {
    const withEnv = nodeCandidates({
      envNode: 'E:\\electron\\electron.exe',
      deployedNodePath: 'C:\\cache\\deployed\\k1\\node\\node.exe',
    });
    const res = await pickNode({
      candidates: withEnv,
      probe: probeOf({ 'E:\\electron\\electron.exe': '20.19.1', 'C:\\cache\\deployed\\k1\\node\\node.exe': '26.3.1' }),
      isSupported: realWorldSupport,
      supportedRange: RANGE,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.node.origin).toBe('deployed');
  });

  it('attempts 逐条记录（origin / exe / 分档 / 版本 / 是否受支持 / 耗时 / 诊断对象）', async () => {
    const res = await pickNode({
      candidates: [candidates[1]],
      probe: async () => ({ kind: 'ok', version: '26.3.1', durationMs: 3, diagnostics: diag({ exitCode: 0 }) }),
      isSupported: realWorldSupport,
      supportedRange: RANGE,
    });
    expect(res.attempts).toEqual([
      {
        origin: 'deployed',
        exe: 'C:\\cache\\deployed\\k1\\node\\node.exe',
        kind: 'ok',
        version: '26.3.1',
        supported: true,
        durationMs: 3,
        diagnostics: diag({ exitCode: 0 }),
      },
    ]);
  });
});

describe('aggregateFailureClass（归因聚合）', () => {
  const attempt = (kind: NodeProbeKind, version: string | null = null, supported = false): NodeAttempt => ({
    origin: 'deployed',
    exe: 'C:\\x\\node.exe',
    kind,
    version,
    supported,
    durationMs: 1,
    diagnostics: diag(),
  });

  it('⭐ 确定性结论优先：缺失 > 版本不支持 > 权限 > 执行失败 > 超时', () => {
    expect(aggregateFailureClass([attempt('timeout'), attempt('missing')])).toBe('missing');
    expect(aggregateFailureClass([attempt('timeout'), attempt('ok', '20.0.0', false)])).toBe('version-unsupported');
    expect(aggregateFailureClass([attempt('exec-failed'), attempt('permission')])).toBe('permission');
    expect(aggregateFailureClass([attempt('timeout'), attempt('exec-failed')])).toBe('exec-failed');
    expect(aggregateFailureClass([attempt('timeout')])).toBe('timeout');
    expect(aggregateFailureClass([])).toBe('none');
  });
});

describe('classifyProbeFailure（异常分档，纯函数；合同 B）', () => {
  const base = { existedAtStart: true as const, timeoutTriggered: false };

  it('⭐ timeout 的唯一依据 = **我们的计时器触发**（timeoutTriggered）', () => {
    expect(classifyProbeFailure({ killed: true, signal: 'SIGKILL' }, { ...base, timeoutTriggered: true }).kind).toBe(
      'timeout',
    );
  });

  it('⭐ 被别的原因终止（有 killed/signal 但没有我们的计时器）**不判 timeout**，落 exec-failed', () => {
    const r = classifyProbeFailure({ killed: true, signal: 'SIGTERM', code: 137 }, base);
    expect(r.kind).toBe('exec-failed');
    // 诊断逐字段保留：signal 与退出码都在，不互相覆盖。
    expect(r.diagnostics.signal).toBe('SIGTERM');
    expect(r.diagnostics.exitCode).toBe(137);
  });

  it('⭐ K3：missing **只认系统原始 ENOENT** —— 存在性观测不盖掉原始错误', () => {
    expect(classifyProbeFailure({ code: 'ENOENT' }, base).kind).toBe('missing');
    expect(classifyProbeFailure({ code: 'ENOENT' }, { ...base, existedAtStart: false }).kind).toBe('missing');
    // 评审反例翻转：`existedAtStart=false + 数字退出码`不能证明"文件缺失" ⇒ exec-failed。
    expect(classifyProbeFailure({ code: 1 }, { ...base, existedAtStart: false }).kind).toBe('exec-failed');
  });

  it('⭐ K3：EACCES/EPERM ⇒ permission（existedAtStart 三态组合都拦不住原始权限错误）', () => {
    for (const code of ['EACCES', 'EPERM'] as const) {
      for (const existedAtStart of [true, false, null] as const) {
        const r = classifyProbeFailure({ code }, { ...base, existedAtStart });
        expect(r.kind).toBe('permission');
        expect(r.detail).toBe(code);
        expect(r.diagnostics.code).toBe(code);
      }
    }
  });

  it('⭐ K3：诊断文本走**已知模式净化**（Bearer/token/apiKey…），code/signal/exitCode 原样保留', () => {
    const canary = 'sk-canary-ABCDEF123456';
    const r = classifyProbeFailure({ code: 1, stderr: `Authorization: Bearer ${canary}` }, base);
    expect(r.kind).toBe('exec-failed');
    expect(r.diagnostics.stderrHead).toContain('***redacted***');
    expect(r.diagnostics.stderrHead).not.toContain(canary);
    expect(r.detail).not.toContain(canary);
    expect(r.diagnostics.exitCode).toBe(1);

    const q = classifyProbeFailure({ code: 'EACCES', stderr: `x token=${canary} y` }, base);
    expect(q.kind).toBe('permission');
    expect(q.detail).toBe('EACCES');
    expect(q.diagnostics.stderrHead ?? '').not.toContain(canary);

    const m = classifyProbeFailure({ code: 2, message: `boom password=${canary} end` }, base);
    expect(m.kind).toBe('exec-failed');
    expect(m.detail ?? '').not.toContain(canary);
    expect(m.diagnostics.exitCode).toBe(2);
  });

  it('其余 ⇒ exec-failed；stderr 与退出码**分字段**保留，detail 限长脱敏', () => {
    const long = 'x'.repeat(500);
    const r = classifyProbeFailure({ code: 1, stderr: long }, base);
    expect(r.kind).toBe('exec-failed');
    expect(r.diagnostics.exitCode).toBe(1);
    expect((r.diagnostics.stderrHead ?? '').length).toBeLessThanOrEqual(160);
    expect(r.diagnostics.stderrHead).toBe(long.slice(0, 160));
  });
});

describe('probeNodeAsync', () => {
  it('探不到（文件不存在）⇒ missing + 诊断（existedAtStart=false），不抛', async () => {
    const r = await probeNodeAsync(path.join(tmpRoot, 'does-not-exist.exe'));
    expect(r.kind).toBe('missing');
    expect(r.version).toBeNull();
    expect(r.diagnostics.existedAtStart).toBe(false);
  });

  it('能探到真正的 node（用当前进程的 node）⇒ ok + 版本', async () => {
    const r = await probeNodeAsync(process.execPath);
    expect(r.kind).toBe('ok');
    expect(isSupportedNodeVersionShape(r.version)).toBe(true);
    expect(r.diagnostics.timeoutTriggered).toBe(false);
  });

  it('⭐ 超时 ⇒ timeout（timeoutTriggered 证据）+ **子进程被清理**（PID 不再存活）', async () => {
    // 慢脚本：先把自己的 PID 写盘（供测试取回），再睡 30 秒。
    const pidFile = path.join(tmpRoot, 'slow.pid');
    const slow = path.join(tmpRoot, 'slow.cjs');
    fs.writeFileSync(
      slow,
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setTimeout(() => {}, 30000);`,
    );
    const r = await probeNodeAsync(process.execPath, { timeoutMs: 500, args: [slow] });
    expect(r.kind).toBe('timeout');
    expect(r.diagnostics.timeoutTriggered).toBe(true);
    expect(r.diagnostics.signal).toBe('SIGKILL');
    // 合同 §4.5：不只是"结果说 timeout"——真子进程的 PID 必须不再存活（有界等待回收）。
    const pid = Number(fs.readFileSync(pidFile, 'utf-8'));
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 3000;
    while (alive() && Date.now() < deadline) await new Promise((r2) => setTimeout(r2, 100));
    expect(alive()).toBe(false);
  });

  it('假文件（存在但根本不是可执行文件）⇒ exec-failed + 诊断（existedAtStart=true）', async () => {
    const fake = path.join(tmpRoot, 'node.exe');
    fs.writeFileSync(fake, 'not an executable');
    const r = await probeNodeAsync(fake, { timeoutMs: 3000 });
    expect(r.kind).toBe('exec-failed');
    expect(r.diagnostics.existedAtStart).toBe(true);
  });
});

describe('withBoundedProbeRetry（有界重试；合同 A/C）', () => {
  it('⭐ 首次超时后成功：重试一次即命中，attempts 两条', async () => {
    const scripted = [timeoutResult(), okResult('26.3.1')];
    let clock = 0;
    const { result, attempts } = await withBoundedProbeRetry(
      async () => {
        clock += 100;
        return scripted.shift()!;
      },
      { now: () => clock },
    );
    expect(result.kind).toBe('ok');
    expect(attempts.map((a) => a.kind)).toEqual(['timeout', 'ok']);
  });

  it('⭐ 持续超时 ⇒ 有界结束：最多 1 + 2 次尝试，绝不无限重试', async () => {
    let calls = 0;
    let clock = 0;
    const { result, attempts } = await withBoundedProbeRetry(
      async () => {
        calls += 1;
        clock += 100;
        return timeoutResult();
      },
      { now: () => clock },
    );
    expect(result.kind).toBe('timeout');
    expect(calls).toBe(3);
    expect(attempts).toHaveLength(3);
  });

  it('⭐⭐ 评审反例转绿（合同 A）：35s 预算 + 20s 单次 ⇒ 第二次只拿到 15s，总耗时不超过 35s', async () => {
    const receivedTimeouts: number[] = [];
    let clock = 0;
    const { attempts } = await withBoundedProbeRetry(
      async (timeoutMs) => {
        receivedTimeouts.push(timeoutMs);
        // 模拟"用满被给到的超时"（真实探测最多花掉 timeoutMs，不会更多）。
        clock += timeoutMs;
        return timeoutResult();
      },
      { timeoutMs: 20_000, budgetMs: 35_000, now: () => clock },
    );
    // ⚠️ 旧实现这里是两轮各 20000 = 40000（评审 15:24 独立复现的反例）；
    //    现在第二轮拿到的是**剩余预算** 15000，总耗时恰 35000，不再超支。
    expect(receivedTimeouts).toEqual([20_000, 15_000]);
    expect(attempts).toHaveLength(2);
    expect(clock).toBeLessThanOrEqual(35_000);
  });

  it('⭐ 剩余预算 ≤ 0 时**连子进程都不启动**：attempt 不被调用，结果为显式的 budget-exhausted', async () => {
    let calls = 0;
    const { result, attempts } = await withBoundedProbeRetry(
      async () => {
        calls += 1;
        return timeoutResult();
      },
      { deadlineMs: 0, now: () => 1 },
    );
    expect(calls).toBe(0);
    expect(attempts).toHaveLength(0);
    expect(result.kind).toBe('timeout');
    expect(result.detail).toBe('probe-budget-exhausted');
  });

  it('⭐ 缺失 / 权限拒绝 / 执行失败 / 输出异常一律**不重试**（确定性失败，重试只拖时间）', async () => {
    for (const kind of ['missing', 'permission', 'exec-failed', 'unusable-output'] as const) {
      let calls = 0;
      let clock = 0;
      const { result } = await withBoundedProbeRetry(
        async () => {
          calls += 1;
          clock += 5;
          return { kind, version: null, durationMs: 5, diagnostics: diag() };
        },
        { now: () => clock },
      );
      expect(result.kind).toBe(kind);
      expect(calls).toBe(1);
    }
  });

  it('首次即成功：只有一条 attempts', async () => {
    const clock = 0;
    const { attempts } = await withBoundedProbeRetry(async () => okResult('26.3.1'), { now: () => clock });
    expect(attempts).toHaveLength(1);
  });
});

describe('isSupportedNodeVersionShape', () => {
  it('收下常见的版本写法（含 v 前缀与空白）', () => {
    expect(isSupportedNodeVersionShape('26.3.1')).toBe(true);
    expect(isSupportedNodeVersionShape('v24.16.0')).toBe(true);
    expect(isSupportedNodeVersionShape('  26.3.1\n')).toBe(true);
  });

  it('拒掉不是版本的东西 —— 否则一个报错信息会被当成版本参与比较', () => {
    expect(isSupportedNodeVersionShape('')).toBe(false);
    expect(isSupportedNodeVersionShape('command not found')).toBe(false);
    expect(isSupportedNodeVersionShape('26')).toBe(false);
    expect(isSupportedNodeVersionShape(null)).toBe(false);
  });
});

describe('loadNodeVersionContract', () => {
  function writeContractPackage(body: string): string {
    const pkgRoot = path.join(tmpRoot, 'node_modules', 'openclaw');
    fs.mkdirSync(pkgRoot, { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, 'node-version.mjs'), body);
    return pkgRoot;
  }

  it('⭐ 从**部署后的 openclaw 包**里读区间，而不是我们硬编码', async () => {
    const pkgRoot = writeContractPackage(`
      export const SUPPORTED_NODE_VERSIONS = '>=24.16.0 <25, or >=26.1.0 (Node 26 recommended)';
      export function isSupportedOpenClawNodeVersion(v) {
        const [maj, min] = String(v).split('.').map(Number);
        return maj === 24 ? min >= 16 : maj >= 26;
      }
    `);

    const contract = await loadNodeVersionContract(pkgRoot);
    expect(contract.supportedRange).toBe(RANGE);
    expect(contract.isSupported('26.3.1')).toBe(true);
    expect(contract.isSupported('20.19.1')).toBe(false);
  });

  it('包里没有 node-version.mjs ⇒ 抛错要点名它（不能静默放行任何 Node）', async () => {
    const pkgRoot = path.join(tmpRoot, 'empty');
    fs.mkdirSync(pkgRoot, { recursive: true });
    await expect(loadNodeVersionContract(pkgRoot)).rejects.toThrow(/node-version\.mjs/);
  });

  it('包的导出形状不对 ⇒ 抛错（宁可起不来，也不要用一个"永远返回 false"的谓词）', async () => {
    const pkgRoot = writeContractPackage('export const somethingElse = 1;');
    await expect(loadNodeVersionContract(pkgRoot)).rejects.toThrow(
      /isSupportedOpenClawNodeVersion|SUPPORTED_NODE_VERSIONS/,
    );
  });
});
