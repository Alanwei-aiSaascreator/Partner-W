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
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

export interface NodeAttempt {
  origin: NodeCandidateOrigin;
  exe: string;
  /** null = 探不到（不存在 / 不是可执行 / 超时 / 输出不是版本号）。 */
  version: string | null;
  supported: boolean;
}

export interface PickedNode {
  exe: string;
  version: string;
  origin: NodeCandidateOrigin;
}

export type PickNodeResult =
  | { ok: true; node: PickedNode; attempts: NodeAttempt[] }
  | { ok: false; attempts: NodeAttempt[]; message: string };

/** openclaw 的版本契约（从它自己的包里读出来）。 */
export interface NodeVersionContract {
  isSupported: (version: string) => boolean;
  /** 给人看的区间串，直接进错误信息。 */
  supportedRange: string;
}

/**
 * 候选顺序：`CLAWWORK_NODE` → **本机 deployed** → 盘上的 → PATH。
 *
 * ⚠️ 本机 deployed 排在盘上那份**前面**：运行期只该用本机缓存里的 node。
 * 盘上的那份只在**部署时**当来源 —— 否则拔盘就崩（这正是「U 盘带 Node」
 * 必须"随部署一起进本机缓存"的原因）。
 */
export function nodeCandidates(opts: { envNode?: string; deployedNodePath?: string }): NodeCandidate[] {
  const out: NodeCandidate[] = [];
  if (opts.envNode) out.push({ exe: opts.envNode, origin: 'env' });
  if (opts.deployedNodePath) out.push({ exe: opts.deployedNodePath, origin: 'deployed' });
  return out;
}

/** 输出得像不像一个版本号。不像就当"探不到" —— 免得把报错信息当版本参与比较。 */
export function isSupportedNodeVersionShape(value: unknown): value is string {
  return typeof value === 'string' && /^v?\d+\.\d+\.\d+/.test(value.trim());
}

/**
 * 探一个可执行文件的 Node 版本；探不到返回 null。
 *
 * ⚠️ **不抛**：探测失败在真实世界里是常态（盘拔了、路径不对、权限），
 * 让它抛会把"换下一个候选"这件事变成异常流程。
 */
export function probeNodeVersion(exe: string, timeoutMs = 5000): string | null {
  try {
    const out = execFileSync(exe, ['-p', 'process.versions.node'], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      windowsHide: true,
    }).trim();
    return isSupportedNodeVersionShape(out) ? out.replace(/^v/, '') : null;
  } catch {
    return null;
  }
}

/**
 * 按顺序挑第一个**探得到且受支持**的 Node。
 *
 * 全都不行时返回 `ok: false` 并带一条**同时含实际版本与要求区间**的信息 ——
 * 这是排障时唯一有用的东西（"没有可用的 Node" 这种话等于没说）。
 */
export function pickNode(opts: {
  candidates: readonly NodeCandidate[];
  probe: (exe: string) => string | null;
  isSupported: (version: string) => boolean;
  supportedRange: string;
}): PickNodeResult {
  const { candidates, probe, isSupported, supportedRange } = opts;
  const attempts: NodeAttempt[] = [];

  for (const c of candidates) {
    const version = probe(c.exe);
    const supported = version !== null && isSupported(version);
    attempts.push({ origin: c.origin, exe: c.exe, version, supported });
    if (supported) {
      return { ok: true, node: { exe: c.exe, version, origin: c.origin }, attempts };
    }
  }

  return { ok: false, attempts, message: renderNoUsableNode(attempts, supportedRange) };
}

function renderNoUsableNode(attempts: readonly NodeAttempt[], supportedRange: string): string {
  const lines = attempts.map((a) => {
    const seen = a.version === null ? '探不到（文件不存在或无法执行）' : `${a.version}（版本不受支持）`;
    return `  - ${a.origin.padEnd(8)} ${a.exe} → ${seen}`;
  });
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
