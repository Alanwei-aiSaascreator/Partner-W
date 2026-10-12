/**
 * 解析出一个**能跑 openclaw** 的 Node。
 *
 * ⚠️ 为什么非要有这一层（实测，不是推测）：
 *   Electron 34.5.8 内嵌的 Node 是 **20.19.1**，而 openclaw 2026.9.3 要求
 *   `>=24.16.0 <25 || >=26.1.0`，并在 `openclaw.mjs:72` **无条件**跑版本守卫
 *   （不满足直接 `exit 1`）；它还 import `node:sqlite`（Node 20 没有）。
 *   ⇒ `process.execPath` + `ELECTRON_RUN_AS_NODE` **彻底不通**，必须解析外部 Node。
 *
 * ⚠️ **版本区间不硬编码**：区间由 openclaw 自己发布的 `<pkgRoot>/node-version.mjs`
 *   说了算（`isSupportedOpenClawNodeVersion` / `SUPPORTED_NODE_VERSIONS`）。
 *   上游改区间，我们跟着走 —— 我们自己写一份迟早和上游漂移。
 *
 * ⚠️ **必须先探版本再 spawn**：不探的话用户只会在网关 stderr 里看到一行
 *   "Node.js ... is required"，看不出是装载器选错了 Node。
 *
 * ⚠️⚠️ BUG-064（2026-10-10）：探测是**结构化 + 异步**的，并且**只对"超时"做有界重试**。
 *   现场（换电脑卡 17%）：1.0.1/1.0.3 的探测用 `execFileSync` 单发 5 秒，把超时/权限/
 *   缺失全吞成 null（原始 code/signal 丢失，环境原因无从定案），而且同步阻塞主进程。
 *   现在的分档：`missing`（不存在）/`permission`（权限拒绝）/`timeout`（超时未响应）/
 *   `exec-failed`（执行异常）/`unusable-output`（输出不成版本号）——
 *   每个 kind 在界面上有自己的话（见 shared 的 GatewayFailureReason 与 `startup-readiness.ts`）。
 *   重试规则：**只有 timeout 重试**（最多 {@link NODE_PROBE_MAX_RETRIES} 次、总预算
 *   {@link NODE_PROBE_RETRY_BUDGET_MS} 封顶、超时子进程被 kill 清理）；
 *   缺失/权限/版本不支持**一律不重试**（确定性失败，重试只是拖时间）。
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { redactGatewayOutput } from './gateway-output.js';

/**
 * 候选来源，顺序即优先级。
 *
 * ⚠️ **刻意没有 `source`（U 盘）与 `path`（环境 PATH）**：部署成功即代表
 * `deployed/<key>/node/node.exe` 已验过 hash 且自包含，运行期就该**只**用它。
 * 留一个 PATH 兜底会把"这台机器上恰好有个合格 Node"变成一个**静默**的替代品 ——
 * 用户跑的是哪个 Node 就成了机器相关的，出问题无从解释。
 * 要临时改用别的 Node，用 `CLAWWORK_NODE` **显式**指定（那不是偷偷的）。
 */
export type NodeCandidateOrigin = 'env' | 'deployed';

export interface NodeCandidate {
  /** 可执行文件绝对路径；`path` 来源是命令名，交给 PATH 解析。 */
  exe: string;
  origin: NodeCandidateOrigin;
}

/** 一次探测的结果分档（BUG-064：不再用 null 吞掉一切）。 */
export type NodeProbeKind = 'ok' | 'missing' | 'permission' | 'timeout' | 'exec-failed' | 'unusable-output';

/**
 * 结构化诊断（BUG-064 合同 B）：原始错误**逐字段保留**，缺席填 null、不伪造。
 * 只进日志与本地 reason —— 原始路径/敏感内容不上界面（界面只消费 shared 闭集）。
 */
export interface NodeProbeDiagnostics {
  /** 原始 `error.code`（字符串如 ENOENT/EACCES，或数字退出码）；没有就 null。 */
  code: string | number | null;
  /** 终止信号（我们自己超时杀进程时是 'SIGKILL'）；没有就 null。 */
  signal: string | null;
  /** 数字退出码（非信号终止时）；没有就 null。 */
  exitCode: number | null;
  /**
   * 探测发起那一刻目标文件是否存在。
   * ⚠️ 只有**绝对路径**才判定；命令名（交给 PATH 解析）与判定不适用时填 null。
   */
  existedAtStart: boolean | null;
  /**
   * **我们自己**的超时计时器是否触发过 —— `timeout` 分档的**唯一依据**。
   * `killed`/`signal` 只表示"收到过终止信号"，本身不说明终止原因（合同 B）。
   */
  timeoutTriggered: boolean;
  /** 限长脱敏的 stderr 头部；没有就 null。 */
  stderrHead: string | null;
  /**
   * ⚠️ BUG-064 K1：本次探测启动的**自己的**子进程是否已确认退出。
   * `false` = 清理宽限（≤1s）到点仍未确认（返回值固定 `exec-failed` +
   * `detail:'probe-cleanup-unconfirmed'`），且在那个子进程真正 exit 前**不得**
   * 再启动任何新探测进程。缺席/true = 已确认（回调或 exit 事件到达）。
   */
  cleanupConfirmed?: boolean;
}

export interface NodeProbeResult {
  kind: NodeProbeKind;
  /** 只有 `ok`（或版本形状正常但不受支持）时非空。 */
  version: string | null;
  durationMs: number;
  /** 限长脱敏的补充诊断（给人看的一句话），给日志用。 */
  detail?: string;
  diagnostics: NodeProbeDiagnostics;
}

export interface NodeAttempt {
  origin: NodeCandidateOrigin;
  exe: string;
  /** 探测分档（历史字段 `version===null` 的替代；两者并存便于排障）。 */
  kind: NodeProbeKind;
  /** null = 探不到可用版本（任何非 ok 分档，或输出不成版本号）。 */
  version: string | null;
  supported: boolean;
  durationMs: number;
  detail?: string;
  diagnostics: NodeProbeDiagnostics;
}

export interface PickedNode {
  exe: string;
  version: string;
  origin: NodeCandidateOrigin;
}

/** 失败归因的分档（用于选 bootstrap 失败码；与 attempts 的 kind 聚合而来）。 */
export type NodeFailureClass =
  | 'missing'
  | 'permission'
  | 'timeout'
  | 'exec-failed'
  | 'unusable-output'
  | 'version-unsupported'
  | 'none';

/**
 * 归因分档 → bootstrap 失败码（BUG-064）。每个码在 `@clawwork/shared` 的
 * GatewayFailureReason 闭集里都有一档界面话术；`none` 走通用 no-usable-node（→ unknown，不猜）。
 */
export const NODE_MISSING_CODE = 'runtime.node-missing';
export const NODE_PERMISSION_CODE = 'runtime.node-permission-denied';
export const NODE_PROBE_TIMEOUT_CODE = 'runtime.node-probe-timeout';
export const NODE_EXEC_FAILED_CODE = 'runtime.node-exec-failed';
export const NODE_VERSION_UNSUPPORTED_CODE = 'runtime.node-version-unsupported';
export const NODE_GENERIC_CODE = 'runtime.no-usable-node';

export function nodeFailureCodeOf(failureClass: NodeFailureClass): string {
  switch (failureClass) {
    case 'missing':
      return NODE_MISSING_CODE;
    case 'permission':
      return NODE_PERMISSION_CODE;
    case 'timeout':
      return NODE_PROBE_TIMEOUT_CODE;
    case 'exec-failed':
    case 'unusable-output':
      return NODE_EXEC_FAILED_CODE;
    case 'version-unsupported':
      return NODE_VERSION_UNSUPPORTED_CODE;
    case 'none':
      return NODE_GENERIC_CODE;
  }
}

export type PickNodeResult =
  | { ok: true; node: PickedNode; attempts: NodeAttempt[]; probeRecords?: ProbeRetryRecord[]; contractMs?: number }
  | {
      ok: false;
      attempts: NodeAttempt[];
      failureClass: NodeFailureClass;
      message: string;
      probeRecords?: ProbeRetryRecord[];
      contractMs?: number;
    };

/** openclaw 的版本契约（从它自己的包里读出来）。 */
export interface NodeVersionContract {
  isSupported: (version: string) => boolean;
  /** 给人看的区间串，直接进错误信息。 */
  supportedRange: string;
}

/** 探测单次执行的默认超时（BUG-064：5s → 10s；首扫/慢盘环境需要一个完整窗口）。 */
export const NODE_PROBE_DEFAULT_TIMEOUT_MS = 10_000;

/** 自动重试上限（派发给 timeout 一档；合同：最多两次）。 */
export const NODE_PROBE_MAX_RETRIES = 2;

/**
 * 探测（含重试）的总预算 —— **同一单调时钟上的 deadline**（BUG-064 合同 A）。
 * ⚠️ 它不是"单次上限"、更不是"每次重试都重新获得整段预算"：每次执行前取
 *    `remaining = deadline - now`，把 `min(单次上限, remaining)` 传给该次探测；
 *    `remaining <= 0` 就不再启动子进程。多个候选**共享同一个 deadline**。
 */
export const NODE_PROBE_RETRY_BUDGET_MS = 35_000;

/**
 * ⚠️ BUG-064 K1：末次清理宽限 —— 超时 kill 之后最多再等这么久**确认**自己的
 * 子进程退出。对外口径如实："35s 探测预算 + 最多 1s 末次清理宽限"；前面各次
 * 清理同样消耗共享 deadline；事件循环可能延迟调度，**不承诺**绝对墙钟 35s。
 */
export const NODE_PROBE_CLEANUP_GRACE_MS = 1_000;

/** 每次探测尝试的记录（含自动重试），进日志。 */
export interface ProbeRetryRecord {
  attempt: number;
  kind: NodeProbeKind;
  /** 以调用方注入的单调时钟量得（含重试间等待与诊断回调的耗时）。 */
  durationMs: number;
  detail?: string;
  diagnostics: NodeProbeDiagnostics;
}

/**
 * 候选顺序：`CLAWWORK_NODE` → **本机 deployed**。
 *
 * ⚠️ 本机 deployed 排在（不存在的）"盘上那份"**前面**的同源理由：运行期只该用
 * 部署缓存里的 node；盘上的那份只在**部署时**当来源 —— 否则拔盘就崩。
 *
 * ⚠️ 调用方**不再按 existsSync 决定要不要给 deployed 候选**（BUG-064）：
 * "文件不存在"本身是**有信息量的失败分档**（missing），要让它走到界面上；
 * 静默不给候选只会得到一句"没有任何候选"。
 */
export function nodeCandidates(opts: { envNode?: string; deployedNodePath?: string }): NodeCandidate[] {
  const out: NodeCandidate[] = [];
  if (opts.envNode) out.push({ exe: opts.envNode, origin: 'env' });
  if (opts.deployedNodePath) out.push({ exe: opts.deployedNodePath, origin: 'deployed' });
  return out;
}

/** 部署缓存里 Node 的固定位置（唯一真源；F→G 换盘符时由调用方传入的 deployedRoot 决定）。 */
export function deployedNodePathFor(deployedRoot: string): string {
  return path.join(deployedRoot, 'node', 'node.exe');
}

/** 输出得像不像一个版本号。不像就当"探不到" —— 免得把报错信息当版本参与比较。 */
export function isSupportedNodeVersionShape(value: unknown): value is string {
  return typeof value === 'string' && /^v?\d+\.\d+\.\d+/.test(value.trim());
}

/**
 * 限长 + **已知模式净化**（BUG-064 K3）：先过 `redactGatewayOutput` 的规则
 * （Bearer/token/apiKey/password/URL 凭据），再折叠空白、截断到 160。
 * ⚠️ 如实：这是**已知模式**净化，不声称能识别任意无标签秘密。
 */
function sanitizeDetail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const collapsed = redactGatewayOutput(value, []).replace(/\s+/g, ' ').trim();
  if (!collapsed) return undefined;
  return collapsed.slice(0, 160);
}

interface ProbeFailureShape {
  code?: unknown;
  killed?: unknown;
  signal?: unknown;
  stderr?: unknown;
  stdout?: unknown;
  message?: unknown;
}

/**
 * 异常 → 失败分档（**纯函数**，单独可测）。
 *
 * ⚠️ BUG-064 合同 B：`timeout` 的**唯一依据**是 `diagnostics.timeoutTriggered`
 *    （我们自己的计时器触发过）—— `killed`/`signal` 只说明"收到过终止信号"，
 *    不说明终止原因；别的进程杀掉它、系统结掉它都不该被当成"超时"去自动重试。
 *    原始 code/signal/退出码**逐字段保留**（detail 不再用 stderr 覆盖退出码）。
 */
export function classifyProbeFailure(
  error: ProbeFailureShape,
  base: Omit<NodeProbeDiagnostics, 'code' | 'signal' | 'exitCode' | 'stderrHead'>,
): { kind: NodeProbeKind; detail?: string; diagnostics: NodeProbeDiagnostics } {
  const code: string | number | null =
    typeof error.code === 'string' || typeof error.code === 'number' ? error.code : null;
  const signal = typeof error.signal === 'string' ? error.signal : null;
  const exitCode = typeof error.code === 'number' ? error.code : null;
  const stderrHead = sanitizeDetail(error.stderr) ?? null;
  const diagnostics: NodeProbeDiagnostics = { ...base, code, signal, exitCode, stderrHead };

  if (base.timeoutTriggered) {
    return { kind: 'timeout', detail: 'probe-timeout', diagnostics };
  }
  // ⚠️ BUG-064 K3：`missing` **只认系统原始 ENOENT** ——"发起时文件不存在"只是辅助
  //    观测，不能盖掉系统原始错误；`existedAtStart=false + 数字退出码`也不能证明缺失。
  if (code === 'ENOENT') {
    return { kind: 'missing', diagnostics };
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return { kind: 'permission', detail: String(code), diagnostics };
  }
  const detail =
    stderrHead ??
    sanitizeDetail(error.message) ??
    (exitCode !== null ? `exit ${exitCode}` : undefined) ??
    (typeof code === 'string' ? code : undefined);
  return { kind: 'exec-failed', detail, diagnostics };
}

/**
 * 探一个可执行文件的 Node 版本（**异步**，不阻塞主进程 —— BUG-064）；
 * 失败返回分档结果而不是 null。
 *
 * ⚠️ 超时由**我们自己的计时器**负责（不用 `execFile` 的 `timeout` 选项）——
 *    这样 `timeoutTriggered` 是显式证据（合同 B）；计时器到点即 `SIGKILL` 清理子进程。
 *
 * ⚠️⚠️ BUG-064 K1（2026-10-10 终审）：超时的**终止与清理必须有界**——
 *   `kill()` 的返回值/`killed` 都**不能证明进程已终止**（Node 官方文档明确）。
 *   所以：
 *    ① 超时后先登记"未确认退出的子进程"（模块级引用），再进入
 *       {@link NODE_PROBE_CLEANUP_GRACE_MS} 清理宽限；
 *    ② 只有在**确认自己的子进程已退出**（execFile 回调或 `exit` 事件）之后，
 *       才返回可重试的 `timeout`；宽限到点仍没确认 ⇒ 返回 `exec-failed` +
 *       `detail:'probe-cleanup-unconfirmed'` + `cleanupConfirmed:false`（如实，
 *       不伪造 OS 错误；真实 code/signal/exitCode 原样保留）；
 *    ③ 未确认退出的子进程**真正 exit 前**，后续候选与用户再点「重新准备」都
 *       不得另起探测进程（入口直接给同形态的未确认失败）；它自己退出后自动解除。
 *       **不按进程名杀 Node、不凭 PID 数值杀陌生进程**；
 *    ④ `withBoundedProbeRetry` / `pickNode` 见到 `cleanupConfirmed:false` 都**停**。
 *   披露：kill 后到回调返回之间存在有界清理延迟（计入 durationMs）；加上清理宽限，
 *   对外口径是"探测预算 + 最多 1s 末次清理宽限"，事件循环可能延迟调度，
 *   **不承诺**绝对墙钟精确到毫秒。
 */

/** 未确认退出的探测子进程（最多一个；K1.4 的模块级引用）。 */
let unreapedProbeChild: ReturnType<typeof execFile> | null = null;

/** 子进程是否已退出（exitCode 为数字 / signalCode 为字符串，即已被 OS 回收）。 */
function probeChildExited(child: ReturnType<typeof execFile>): boolean {
  return typeof child.exitCode === 'number' || typeof child.signalCode === 'string';
}

/** 测试/诊断用：当前是否挡着一个未确认退出的探测子进程。 */
export function hasUnreapedProbeChild(): boolean {
  return unreapedProbeChild !== null && !probeChildExited(unreapedProbeChild);
}

export function probeNodeAsync(
  exe: string,
  opts: { timeoutMs?: number; args?: readonly string[] } = {},
): Promise<NodeProbeResult> {
  const timeoutMs = opts.timeoutMs ?? NODE_PROBE_DEFAULT_TIMEOUT_MS;
  const args = opts.args ?? ['-p', 'process.versions.node'];
  const startedAt = performance.now();
  // ⚠️ 只有绝对路径才判定"发起时是否存在"；命令名交给 PATH 解析，判定不适用 → null。
  const existedAtStart = path.isAbsolute(exe) ? existsSync(exe) : null;
  const base = { existedAtStart, timeoutTriggered: false } as const;

  // K1.4 入口闸：上一个探测子进程没确认退出 ⇒ 一个都不再起（如实失败，不假装探测过）。
  if (hasUnreapedProbeChild()) {
    return Promise.resolve({
      kind: 'exec-failed',
      version: null,
      durationMs: 0,
      detail: 'probe-cleanup-unconfirmed',
      diagnostics: {
        ...base,
        code: null,
        signal: null,
        exitCode: null,
        stderrHead: null,
        cleanupConfirmed: false,
      },
    });
  }
  unreapedProbeChild = null;

  return new Promise<NodeProbeResult>((resolve) => {
    let timeoutTriggered = false;
    let settled = false;
    let child: ReturnType<typeof execFile> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
    let callbackError: ProbeFailureShape | null = null;
    let stderrPrefix = '';

    const diagnostics = (cleanupConfirmed: boolean): NodeProbeDiagnostics => ({
      ...base,
      timeoutTriggered,
      code:
        typeof callbackError?.code === 'string' || typeof callbackError?.code === 'number' ? callbackError.code : null,
      signal:
        typeof callbackError?.signal === 'string'
          ? callbackError.signal
          : ((child?.signalCode as string | null) ?? null),
      exitCode: typeof callbackError?.code === 'number' ? callbackError.code : (child?.exitCode ?? null),
      stderrHead: sanitizeDetail(callbackError?.stderr ?? stderrPrefix) ?? null,
      cleanupConfirmed,
    });
    const finish = (partial: Omit<NodeProbeResult, 'durationMs'>): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      resolve({ ...partial, durationMs: Math.max(0, performance.now() - startedAt) });
    };
    const finishTimeout = (): void => {
      if (unreapedProbeChild === child) unreapedProbeChild = null;
      finish({ kind: 'timeout', version: null, detail: 'probe-timeout', diagnostics: diagnostics(true) });
    };

    timer = setTimeout(() => {
      timeoutTriggered = true;
      if (!child || probeChildExited(child)) {
        finishTimeout();
        return;
      }
      // 子进程还活着：登记"未确认退出"（它 exit 前挡住任何新探测），进入清理宽限。
      unreapedProbeChild = child;
      cleanupTimer = setTimeout(() => {
        if (child && probeChildExited(child)) {
          finishTimeout();
          return;
        }
        // 到点仍未确认 ⇒ 如实报"清理未确认"（可诊断、不伪造 OS 错误；引用继续保留到它 exit）。
        finish({
          kind: 'exec-failed',
          version: null,
          detail: 'probe-cleanup-unconfirmed',
          diagnostics: diagnostics(false),
        });
      }, NODE_PROBE_CLEANUP_GRACE_MS);
      cleanupTimer.unref?.();
      try {
        child.kill('SIGKILL');
      } catch (error) {
        // kill 本身失败也是证据（回调可能永不到来）；记录进诊断，不停在这里。
        callbackError =
          error !== null && typeof error === 'object' ? (error as ProbeFailureShape) : { message: String(error) };
      }
    }, timeoutMs);
    timer.unref?.();

    const settleError = (error: unknown): void => {
      const shaped = (
        error !== null && typeof error === 'object' ? error : { message: String(error) }
      ) as ProbeFailureShape;
      // stderr 采集合并：killed 路径的 callbackError.stderr 常为空，用监听到的前缀兜底。
      const classified = classifyProbeFailure(
        { ...shaped, stderr: shaped.stderr ?? stderrPrefix },
        { ...base, timeoutTriggered },
      );
      finish({
        kind: classified.kind,
        version: null,
        ...(classified.detail ? { detail: classified.detail } : {}),
        diagnostics: { ...classified.diagnostics, cleanupConfirmed: true },
      });
    };

    try {
      child = execFile(exe, [...args], { encoding: 'utf-8', windowsHide: true }, (error, stdout) => {
        if (settled) return;
        if (timeoutTriggered) {
          // ⚠️ K1.2：超时已触发 ⇒ 这次的结论**不再被迟到的合法 stdout 翻转**；
          //    回调到达 = 子进程已退出 ⇒ 清理确认，返回可重试的 timeout。
          callbackError = error;
          if (child && probeChildExited(child)) finishTimeout();
          return;
        }
        if (error) {
          settleError(error);
          return;
        }
        const out = typeof stdout === 'string' ? stdout.trim() : '';
        const okDiagnostics: NodeProbeDiagnostics = {
          ...base,
          code: null,
          signal: null,
          exitCode: 0,
          stderrHead: null,
          cleanupConfirmed: true,
        };
        if (isSupportedNodeVersionShape(out)) {
          finish({ kind: 'ok', version: out.replace(/^v/, ''), diagnostics: okDiagnostics });
          return;
        }
        finish({
          kind: 'unusable-output',
          version: null,
          detail: sanitizeDetail(out),
          diagnostics: okDiagnostics,
        });
      });
      const observedChild = child;
      child.stderr?.on('data', (chunk: unknown) => {
        if (stderrPrefix.length >= 1_024) return;
        const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
        stderrPrefix = (stderrPrefix + text).slice(0, 1_024);
      });
      child.once('exit', () => {
        // 自己这一个子进程退出 ⇒ 解除阻挡（K1.4）；若超时已触发，这就是确认。
        if (unreapedProbeChild === observedChild) unreapedProbeChild = null;
        if (timeoutTriggered) finishTimeout();
      });
    } catch (error) {
      // ⚠️ Windows 上 execFile 对"根本不是可执行文件"的目标会**同步抛**
      //    （实测 `spawn UNKNOWN`，不走进回调）—— 探测的契约是"绝不抛、只分档"，
      //    这一支必须接住，否则一个坏文件会把整个 node 解析打穿。
      settleError(error);
    }
  });
}

export interface BoundedProbeRetryOptions {
  /** 单次探测上限（实际执行时取 `min(它, 剩余预算)`）。 */
  timeoutMs?: number;
  maxRetries?: number;
  budgetMs?: number;
  /**
   * 多个候选**共享**的 deadline（同一单调时钟刻度）。
   * ⚠️ 传了它，候选切换不重新获得整段预算（合同 A）。
   */
  deadlineMs?: number;
  /** 单调时钟（生产用 `performance.now`；测试注入可控时钟）。 */
  now?: () => number;
  /** 每次尝试做完就回调（日志/诊断用）。 */
  onAttempt?: (record: ProbeRetryRecord) => void;
}

/** 预算用尽、连一次都没启动时的兜底结果（显式、可诊断，不伪装成"探测过）。 */
function budgetExhaustedResult(): NodeProbeResult {
  return {
    kind: 'timeout',
    version: null,
    durationMs: 0,
    detail: 'probe-budget-exhausted',
    diagnostics: {
      code: null,
      signal: null,
      exitCode: null,
      existedAtStart: null,
      timeoutTriggered: false,
      stderrHead: null,
    },
  };
}

/**
 * 有界重试的核心（BUG-064 合同 A/C）：**只有 `timeout` 会重试**；
 * 每次执行前在**同一单调时钟**上取 `remaining = deadline - now`，
 * 把 `min(单次上限, remaining)` **传给该次探测**（剩余预算限制生效：
 * 35s 预算 + 20s 单次 ⇒ 第二次只给 15s，绝不再跑满 40s）；
 * `remaining <= 0` 连子进程都不启动。计时包含重试间的全部耗时
 * （`now()` 在 attempt 前后各取一次）。
 */
export async function withBoundedProbeRetry(
  attempt: (timeoutMs: number) => Promise<NodeProbeResult>,
  opts: BoundedProbeRetryOptions = {},
): Promise<{ result: NodeProbeResult; attempts: ProbeRetryRecord[] }> {
  const now = opts.now ?? (() => performance.now());
  const timeoutMs = opts.timeoutMs ?? NODE_PROBE_DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? NODE_PROBE_MAX_RETRIES;
  const deadline = Math.min(
    opts.deadlineMs ?? Number.POSITIVE_INFINITY,
    now() + (opts.budgetMs ?? NODE_PROBE_RETRY_BUDGET_MS),
  );
  const records: ProbeRetryRecord[] = [];
  let result: NodeProbeResult = budgetExhaustedResult();

  for (let attemptIndex = 0; attemptIndex <= maxRetries; attemptIndex += 1) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    const startedAt = now();
    result = await attempt(Math.min(timeoutMs, remaining));
    const record: ProbeRetryRecord = {
      attempt: attemptIndex + 1,
      kind: result.kind,
      durationMs: Math.max(0, now() - startedAt),
      ...(result.detail ? { detail: result.detail } : {}),
      diagnostics: result.diagnostics,
    };
    records.push(record);
    opts.onAttempt?.(record);
    // ⚠️ K1.5：清理未确认（exec-failed + cleanupConfirmed:false）**必须停** ——
    //    现有分支已因 kind!=='timeout' 停，这里加显式保护，防止未来误分 timeout 后重试。
    if (result.diagnostics.cleanupConfirmed === false) break;
    if (result.kind !== 'timeout') break;
  }
  return { result, attempts: records };
}

/** 生产入口：把真实探测接进有界重试（每次探测拿到的是剩余预算内的超时）。 */
export function probeNodeWithBoundedRetry(
  exe: string,
  opts: BoundedProbeRetryOptions = {},
): Promise<{ result: NodeProbeResult; attempts: ProbeRetryRecord[] }> {
  return withBoundedProbeRetry((timeoutMs) => probeNodeAsync(exe, { timeoutMs }), opts);
}

/**
 * 按顺序挑第一个**探得到且受支持**的 Node（异步，BUG-064）。
 *
 * 全都不行时返回 `ok: false` 并带一条**同时含实际版本与要求区间**的信息 ——
 * 这是排障时唯一有用的东西，外加 `failureClass`（聚合归因，调用方据此选失败码）。
 */
export async function pickNode(opts: {
  candidates: readonly NodeCandidate[];
  probe: (exe: string) => Promise<NodeProbeResult>;
  isSupported: (version: string) => boolean;
  supportedRange: string;
}): Promise<PickNodeResult> {
  const { candidates, probe, isSupported, supportedRange } = opts;
  const attempts: NodeAttempt[] = [];

  for (const c of candidates) {
    const result = await probe(c.exe);
    const version = result.kind === 'ok' ? result.version : null;
    const supported = version !== null && isSupported(version);
    attempts.push({
      origin: c.origin,
      exe: c.exe,
      kind: result.kind,
      version,
      supported,
      durationMs: result.durationMs,
      ...(result.detail ? { detail: result.detail } : {}),
      diagnostics: result.diagnostics,
    });
    // ⚠️ K1.5：上一个候选的探测子进程未确认退出 ⇒ 不再对下一个候选起新进程。
    if (result.diagnostics.cleanupConfirmed === false) break;
    if (supported) {
      return { ok: true, node: { exe: c.exe, version: version as string, origin: c.origin }, attempts };
    }
  }

  return {
    ok: false,
    attempts,
    failureClass: aggregateFailureClass(attempts),
    message: renderNoUsableNode(attempts, supportedRange),
  };
}

/**
 * 聚合归因（一次失败里可能有多个候选的多种分档）。
 *
 * 优先级按"用户最该先知道的那件事"排：**确定性**的（文件缺失 / 版本不受支持）
 * 排在前面 —— 它们是可执行的结论；权限/执行异常居中；**超时排最后**
 * （它已经自动重试过，说"超时"只是描述现象，不是用户的下一步）。
 */
export function aggregateFailureClass(attempts: readonly NodeAttempt[]): NodeFailureClass {
  const kinds = new Set<NodeProbeKind>(attempts.map((a) => a.kind));
  const hasUnsupportedVersion = attempts.some((a) => a.kind === 'ok' && a.version !== null && !a.supported);
  if (kinds.has('missing')) return 'missing';
  if (hasUnsupportedVersion) return 'version-unsupported';
  if (kinds.has('permission')) return 'permission';
  if (kinds.has('exec-failed')) return 'exec-failed';
  if (kinds.has('unusable-output')) return 'unusable-output';
  if (kinds.has('timeout')) return 'timeout';
  return 'none';
}

function attemptLine(a: NodeAttempt): string {
  const seen =
    a.kind === 'missing'
      ? '文件不存在'
      : a.kind === 'permission'
        ? '权限被拒绝（可能被安全软件或系统策略拦截）'
        : a.kind === 'timeout'
          ? `未在时限内完成启动${a.detail && a.detail !== 'probe-timeout' ? `（${a.detail}）` : ''}`
          : a.kind === 'exec-failed'
            ? `执行失败${a.detail ? `（${a.detail}）` : ''}`
            : a.kind === 'unusable-output'
              ? `输出无法识别为版本号${a.detail ? `（${a.detail}）` : ''}`
              : a.version !== null
                ? `${a.version}（版本不受支持）`
                : '未知';
  return `  - ${a.origin.padEnd(8)} ${a.exe} → ${seen}`;
}

function renderNoUsableNode(attempts: readonly NodeAttempt[], supportedRange: string): string {
  const lines = attempts.map(attemptLine);
  if (lines.length === 0) lines.push('  （没有任何候选）');
  return [
    '找不到可用的 Node —— OpenClaw 网关起不来。',
    `要求版本：${supportedRange}`,
    '已尝试：',
    ...lines,
    '提示：运行时应随包携带 Node（`node/node.exe`），或用 CLAWWORK_NODE 指定。',
  ].join('\n');
}

/**
 * 从**部署后的 openclaw 包**里读出它的版本契约。
 *
 * ⚠️ 用 `pathToFileURL()` 而不是拼 `file://` 字符串：Windows 盘符与中文路径
 * 拼字符串必炸（本仓库既有规则也要求这么做）。
 *
 * ⚠️ 导出形状不对就**抛错**：一个"永远返回 false"的谓词会让所有 Node 都被判不合格，
 * 而现象是"没有任何 Node 可用" —— 与真实原因（契约读取失败）差得很远。
 */
export async function loadNodeVersionContract(pkgRoot: string): Promise<NodeVersionContract> {
  const file = path.join(pkgRoot, 'node-version.mjs');
  if (!existsSync(file)) {
    throw new Error(`openclaw 包里没有 node-version.mjs（找的是 ${file}）—— 无法判定 Node 版本要求`);
  }

  const mod: unknown = await import(pathToFileURL(file).href);
  const record = mod as Record<string, unknown>;
  const isSupported = record.isSupportedOpenClawNodeVersion;
  const supportedRange = record.SUPPORTED_NODE_VERSIONS;

  if (typeof isSupported !== 'function') {
    throw new Error(`${file} 没有导出 isSupportedOpenClawNodeVersion —— 拒绝用一个不可信的版本判据`);
  }
  if (typeof supportedRange !== 'string' || supportedRange.length === 0) {
    throw new Error(`${file} 没有导出 SUPPORTED_NODE_VERSIONS —— 错误信息里就没法说清要求区间`);
  }

  return {
    isSupported: (version: string) => (isSupported as (v: string) => unknown)(version) === true,
    supportedRange,
  };
}
