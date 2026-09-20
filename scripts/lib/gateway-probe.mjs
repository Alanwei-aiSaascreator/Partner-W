/**
 * 网关探针的**纯逻辑**：判定"端口在听、连接能建、但所有 RPC 超时"（队列 T-a8）并产出**可回传的报告**。
 *
 * 为什么要重做（不是"顺手升级"）：老探针（`%TEMP%/claude/gw-probe.mjs`，本仓库外的临时区）
 * 只打印**载荷字节数**，于是 Codex 复核时点出两个不足：
 *   ① 没保存 `health.eventLoop` 的 `delayMaxMs`/`degraded`/`reasons` —— 那是**唯一**能证明
 *      "事件循环被堵住"的仪表（T-a22 就是靠它把 1 秒停顿归因到配置重载的）；
 *   ② `tools.catalog` 不带 `agentId` ⇒ 多 agent 下回 `INVALID_REQUEST` 是**合法**响应，
 *      老探针把它算成"网关还活着" ⇒ 一条假证据。
 * 本模块把这两条变成判据（见 `gateway-probe.test.mjs`），并且**"没取到"必须照实写进报告**
 * —— 报告里留白会被后人读成"没问题"。
 *
 * ⚠️ 本模块**不 import fs、不起进程、不连网**：要么是纯函数，要么副作用全部由调用方注入
 *    （`makeRpcRunner` 拿的是注入进来的 socket）⇒ 判据可以在**任何机器**上用夹具跑。
 *    副作用（读配置、连 WS、tasklist）全部在 CLI（`scripts/gateway-probe.mjs`）里。
 *
 * ⚠️ 字段名、阈值、owner 规则**都不是猜的**，每一条的出处写在对应常量/函数上（下同）。
 */

import { randomUUID } from 'node:crypto';

/**
 * 默认探的五个 RPC —— 就是 T-a8 现场实测**全部超时**的那五条
 * （`docs/plan/2026-09-20-自主任务队列.md` T-a8 段：`health` / `config.get` / `tools.catalog` /
 * `sessions.list` / `skills.status`，另加 `agents.list` 重试 148 次）。
 */
export const DEFAULT_RPC_METHODS = ['health', 'config.get', 'tools.catalog', 'sessions.list', 'skills.status'];

/**
 * **必须显式带 owner** 的方法（多 agent 配置下不带会被整条拒）。
 * 出处：`packages/core/src/services/gateway-dispatcher.ts:1817` 起的注释
 * （`tools.catalog` / 斜杠命令必须带 `agentId`，否则 composer 的工具菜单永远空着且不报错），
 * 以及实测撞过三次的 `tools.catalog` / `sessions.usage` / `usage.cost`
 * （过界看到的 `code` 是 `INVALID_REQUEST`，**不是**内部的 `AGENT_SELECTION_REQUIRED`）。
 */
export const OWNER_GATED_METHODS = ['tools.catalog'];

/** 没有 owner 时的退路：`agentScope: 'all'`（与 `agentId` **不能同时给**，给了会被拒）。 */
export const OWNER_FALLBACK_SCOPE = 'all';

/** 单条 RPC 的超时上限。老探针用的也是 8 秒，不改（改了就没法和历史数据比）。 */
export const RPC_TIMEOUT_MS = 8000;

/** 连续采样次数与间隔（`delayMaxMs` 是"距上次快照以来"的最坏值 ⇒ 必须连续看，不能只看一次）。 */
export const DEFAULT_SAMPLES = 20;
export const DEFAULT_SAMPLE_INTERVAL_MS = 1000;

/**
 * `health.eventLoop` 什么情况下**整段不出现**：网关自己的采样器只在
 * `delayMaxMs >= 1000ms || intervalMs >= 1000ms` 时才更新快照（否则直接返回）。
 * 出处：随包运行时 `<deployed>/node_modules/openclaw/dist/server-start-*.mjs`
 * （`EVENT_LOOP_DELAY_WARN_MS = 1e3`、`SUSTAINED_LOAD_SAMPLE_MIN_INTERVAL_MS = 1e3`）。
 */
export const EVENT_LOOP_DELAY_WARN_MS = 1000;

/** "no explicit owner" 的判据（两种原文：`... has no explicit owner` / `no explicit owner. Pass agentId`）。 */
export const NEEDS_OWNER_PATTERN = /no explicit owner/i;

/** 全超时 + 进程 CPU 低于这个值 ⇒ 报告里额外记一句"与'忙'不符"（**记事实，不定因**）。 */
export const CPU_BUSY_CAVEAT_THRESHOLD = 0.05;

/** 报告文件名（给人回传的那份）。 */
export const REPORT_NAME = '荣盈魔方-网关探针报告.txt';

const asString = (value) => (typeof value === 'string' && value.length > 0 ? value : undefined);
const asNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * 这条方法的 params。**owner 规则在这里收口**（别在 CLI 里另写一套）：
 *   - `tools.catalog`：有 agentId 就给 agentId；没有就 `agentScope: 'all'`；
 *     ⚠️ **绝不发空参数**（老探针就是发空的 ⇒ 拿回一个合法的 `INVALID_REQUEST`）。
 *   - `skills.status`：不带也能落到 ambient owner（实机注释见
 *     `packages/desktop/src/renderer/lib/gateway-skill-label.ts`：网关侧是
 *     `params.agentId ?? tryResolveAmbientOwnerAgentId(cfg)`），给了就带上。
 *   - `health`：`probe: true` 强制**新鲜**快照（否则网关会拿 60 秒内的缓存回你）。
 *     出处：`dist/health-*.mjs` 的 `const wantsProbe = params?.probe === true;`。
 */
export function buildRpcParams(method, { agentId, probe } = {}) {
  switch (method) {
    case 'tools.catalog':
      return agentId ? { includePlugins: true, agentId } : { includePlugins: true, agentScope: OWNER_FALLBACK_SCOPE };
    case 'skills.status':
      return agentId ? { agentId } : {};
    case 'health':
      return probe ? { probe: true } : {};
    default:
      return {};
  }
}

/**
 * 从 `agents.list` 的载荷里取 owner，判据与客户端**同一套**
 * （`gateway-dispatcher.ts:1827`：`agentCatalog?.defaultId ?? agentCatalog?.agents?.[0]?.id`）。
 */
export function pickAgentId(payload) {
  return asString(payload?.defaultId) ?? asString(payload?.agents?.[0]?.id);
}

/**
 * 把 `health` 载荷里的 `eventLoop` 段读出来；**没有这一段就是 `null`**。
 *
 * ⚠️ 唯一权威形状是**载荷顶层**的 `eventLoop`（`dist/sessions-*.mjs` 的 `HealthSnapshotSchema`：
 * `ok` / `ts` / `durationMs` / `eventLoop` / `plugins` / ... 都是顶层字段）。
 * 不去 `payload.health.eventLoop` 之类的地方"兼容着找"：形状漂移要**当场看得见**，
 * 不能被兼容层藏起来（这个仓库在"读派生字段而不读产出方字段"上栽过）。
 * ⚠️ 字段缺或类型不对 ⇒ 记 `null` / 空数组，**绝不编造 0**（0 会被读成"没有延迟"）。
 */
export function readEventLoop(payload) {
  const loop = payload?.eventLoop;
  if (!loop || typeof loop !== 'object') return null;
  return {
    degraded: loop.degraded === true,
    degradedSinceMs: asNumber(loop.degradedSinceMs),
    reasons: Array.isArray(loop.reasons) ? loop.reasons.filter((reason) => typeof reason === 'string') : [],
    intervalMs: asNumber(loop.intervalMs),
    delayP99Ms: asNumber(loop.delayP99Ms),
    delayMaxMs: asNumber(loop.delayMaxMs),
    utilization: asNumber(loop.utilization),
    cpuCoreRatio: asNumber(loop.cpuCoreRatio),
  };
}

/** 一条 RPC 的结论分四态。`needs-owner` **单独一态**：它证明"网关会回话"，**不证明"网关活着"**。 */
export function classifyRpcResult(result = {}) {
  if (result.status === 'TIMEOUT' || result.status === 'timeout') return 'timeout';
  if (result.ok === true) return 'ok';
  const code = result.error?.code ?? result.error?.details?.code ?? null;
  const message = typeof result.error?.message === 'string' ? result.error.message : '';
  if (code === 'INVALID_REQUEST' && NEEDS_OWNER_PATTERN.test(message)) return 'needs-owner';
  return 'error';
}

/**
 * RPC 结论的**闭集**（唯一的产出方是 `classifyRpcResult`）。
 * ⚠️ 为什么要把这个词表写出来：第一版 CLI 在超时分支直接写了大写 `'TIMEOUT'`（抄老探针），
 *    而判读比的是小写 ⇒ **6 条全超时被判成"网关活着"**（2026-09-20 假网关实测抓到）。
 *    有了这个词表，任何"不认识的结论"都只能落到"判读不可信"，**永远不会**变成"活着"。
 */
export const RPC_STATUSES = ['ok', 'timeout', 'needs-owner', 'error'];

/** 连续采样的汇总。峰值一律取"最坏的那个样本"；一条都没收到 ⇒ 峰值是 `null` 不是 0。 */
export function summarizeEventLoop(samples = []) {
  const loops = samples.map((sample) => sample?.eventLoop).filter(Boolean);
  const peakOf = (key) => {
    const values = loops
      .map((loop) => loop[key])
      .filter((value) => typeof value === 'number' && Number.isFinite(value));
    return values.length ? Math.max(...values) : null;
  };
  const since = loops.map((loop) => loop.degradedSinceMs).filter((value) => typeof value === 'number');
  return {
    samples: samples.length,
    received: loops.length,
    present: loops.length > 0,
    degradedAny: loops.some((loop) => loop.degraded === true),
    reasons: [...new Set(loops.flatMap((loop) => loop.reasons ?? []))].sort(),
    degradedSinceMs: since.length ? Math.max(...since) : null,
    peak: {
      delayMaxMs: peakOf('delayMaxMs'),
      delayP99Ms: peakOf('delayP99Ms'),
      utilization: peakOf('utilization'),
      cpuCoreRatio: peakOf('cpuCoreRatio'),
      intervalMs: peakOf('intervalMs'),
    },
  };
}

/**
 * 配置时间线（`openclaw.json` 在探针窗口里被谁动过、什么时候）。
 * `samples[].atMs` 是**相对探针起点**的毫秒偏移（由 CLI 统一换算），`entry` = `{sha256,size,mtimeMs}`。
 *
 * 三态：`baseline`（起点那一份）/ `changed`（**字节真变** —— T-a22 证明只有这种会触发重载）
 * / `touched`（mtime 或 size 变了但字节没变：有写入、但不一定重载）。
 */
export function diffConfigTimeline(samples = []) {
  const events = [];
  let previous = null;
  for (const sample of samples) {
    const entry = sample?.entry;
    if (!entry) continue;
    const event = {
      offsetMs: typeof sample.atMs === 'number' ? sample.atMs : null,
      sha256: entry.sha256,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
    };
    if (previous === null) events.push({ kind: 'baseline', ...event });
    else if (entry.sha256 !== previous.sha256) events.push({ kind: 'changed', ...event });
    else if (entry.mtimeMs !== previous.mtimeMs || entry.size !== previous.size)
      events.push({ kind: 'touched', ...event });
    previous = entry;
  }
  return events;
}

/**
 * 客户端调试日志（ndjson，每行 `{ts: ISO, ...}`）按**时间窗**取证据。
 * 出处：`packages/desktop/src/main/debug/index.ts`（`ts: new Date().toISOString()`）。
 * 时间戳读不出来的行**单独记账**（`skippedCount`），不静默丢 —— 丢了多少要能看见。
 */
export function filterNdjsonWindow(text, { fromMs, toMs } = {}) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const kept = [];
  let skippedCount = 0;
  for (const line of lines) {
    let ts = null;
    try {
      const raw = JSON.parse(line)?.ts;
      const parsed = typeof raw === 'string' ? Date.parse(raw) : NaN;
      if (Number.isFinite(parsed)) ts = parsed;
    } catch {
      ts = null;
    }
    if (ts === null) {
      skippedCount++;
      continue;
    }
    if ((fromMs === undefined || ts >= fromMs) && (toMs === undefined || ts <= toMs)) kept.push(line);
  }
  return { kept, keptCount: kept.length, totalCount: lines.length, skippedCount };
}

/**
 * 一条 RPC 的**统一出口**：超时、回包、错误，全部收敛成同一个 `status` 词表（`RPC_STATUSES`）。
 *
 * ⚠️ 为什么它必须在这里、而不是在 CLI 里现写：第一版 CLI 的超时分支直接写了大写 `'TIMEOUT'`
 *    （抄老探针）⇒ 判读把所有超时都漏掉、6 条全超时判成"活着"。放在这里 + 下面两条判据，
 *    这个形状就再也回不来了。
 * 副作用只有"往注入进来的 `socket` 写一帧"和"起一个计时器"；socket 由调用方给。
 */
export function makeRpcRunner(socket, timeoutMs = RPC_TIMEOUT_MS) {
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    let frame = null;
    try {
      frame = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);
    entry.resolve(frame);
  });

  function rpc(method, params) {
    const id = randomUUID();
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({
          method,
          status: classifyRpcResult({ status: 'TIMEOUT' }),
          ok: false,
          elapsedMs: Date.now() - startedAt,
        });
      }, timeoutMs);
      pending.set(id, {
        resolve: (frame) => {
          clearTimeout(timer);
          resolve({
            method,
            status: classifyRpcResult(frame),
            ok: frame.ok === true,
            elapsedMs: Date.now() - startedAt,
            payload: frame.payload,
            payloadBytes: frame.payload === undefined ? 0 : JSON.stringify(frame.payload).length,
            code: frame.error?.code ?? frame.error?.details?.code ?? null,
            message: frame.error?.message ?? null,
          });
        },
      });
      socket.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }
  return rpc;
}

/**
 * 窗口内网关进程**自己**烧掉几个核（≈ 整机的一个核的倍数）。
 * ⚠️ 这个数与网关自报的 `cpuCoreRatio` **口径不同**：后者是 `(user+system)/intervalMs` 的进程内测量，
 *    这里是探针从外面数 `Get-Process .CPU` 的增量 ⇒ 只能互相印证，不能互相替代。
 * 样本不够 / 时间没走 / 计数回退（进程重启）⇒ `null`（**不许**给 0：0 会被读成"没占 CPU"）。
 */
export function processCpuRatio(samples = []) {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dtMs = last.atMs - first.atMs;
  const deltaCpu = last.cpuSeconds - first.cpuSeconds;
  if (!Number.isFinite(dtMs) || dtMs <= 0) return null;
  if (!Number.isFinite(deltaCpu) || deltaCpu < 0) return null;
  return Math.round((deltaCpu / (dtMs / 1000)) * 1000) / 1000;
}

/**
 * 判读。六态**互相排斥**，顺序不能改（先"有没有连上"，再"握手过没过"，最后才谈 RPC）：
 *   `unreachable`（WS 都连不上）/ `connect-failed`（连上了但 connect 握手失败 —— 那是**拒绝**，不是卡死）
 *   / `stall`（默认五条**全部**超时 = T-a8 的现场）/ `partial` / `alive` / `unknown`（没跑成任何一条）。
 * 附注（`caveats`）只写**事实与它的边界**，不下"根因"结论。
 */
export function judgeProbe(facts = {}) {
  const connection = facts.connection ?? {};
  const rpcs = Array.isArray(facts.rpcs) ? facts.rpcs : [];
  const caveats = [];

  if (connection.reachable === false) {
    return { verdict: 'unreachable', headline: 'WS 没连上 —— 这不是"卡死"，先确认网关进程在不在、端口对不对', caveats };
  }
  if (connection.connectOk === false) {
    return {
      verdict: 'connect-failed',
      headline: 'WS 连上了但 connect 握手失败 —— 是拒绝/不认，不是卡死（原文见报告）',
      caveats,
    };
  }

  const known = rpcs.filter((run) => RPC_STATUSES.includes(run?.status));
  const unknown = rpcs.filter((run) => !RPC_STATUSES.includes(run?.status));
  const timeouts = known.filter((run) => run?.status === 'timeout');
  const needsOwner = known.filter((run) => run?.status === 'needs-owner');

  let verdict = 'unknown';
  let headline = '没跑成任何一条 RPC —— 连接或脚本有问题，先看【1】【2】两节';
  if (known.length === 0 && rpcs.length > 0) {
    verdict = 'unknown';
    headline = '一条 RPC 的结论**都说不清**（状态不在词表里）—— 判读不可信，先看【2】的原文';
  } else if (known.length > 0 && timeouts.length === known.length) {
    verdict = 'stall';
    headline = `${known.length}/${known.length} 条 RPC 全超时 —— 与 T-a8 现场（端口在听、连接能建、RPC 全超时）一致`;
  } else if (timeouts.length > 0) {
    verdict = 'partial';
    headline = `${timeouts.length}/${known.length} 条 RPC 超时 —— 网关很慢/被堵住，但不是全停`;
  } else if (unknown.length > 0) {
    // 有响应、但**有条数说不清**（状态不在词表里）⇒ 不许说"全好"
    verdict = 'partial';
    headline = `${known.length} 条 RPC 有响应，另有 ${unknown.length} 条结论**说不清** —— 判读按"部分可信"算`;
  } else if (known.length > 0) {
    verdict = 'alive';
    headline = `${known.length} 条 RPC 全部有响应 —— 网关这次是活的`;
  }

  if (unknown.length > 0) {
    const seen = [...new Set(unknown.map((run) => String(run?.status)))].join('/');
    caveats.push(
      `有 ${unknown.length} 条 RPC 的状态**不在词表里**（${seen}；词表=${RPC_STATUSES.join('/')}）—— ` +
        '**判读不可信**，先看【2】的原文（这个形状栽过：全部大写 TIMEOUT 被判成"活着"）',
    );
  }
  if (needsOwner.length > 0) {
    caveats.push(
      `${needsOwner.map((run) => run.method).join('/')} 被拒（INVALID_REQUEST: no explicit owner）—— ` +
        '这是**合法**拒绝，**不算"网关活着"的证据**（老探针把这一条当成有响应过）',
    );
  }
  if (facts.health?.summary && facts.health.summary.present === false) {
    caveats.push(
      `网关这次**没报** health.eventLoop 这一段：按网关自己的采样器，` +
        `只有 delayMaxMs ≥ ${EVENT_LOOP_DELAY_WARN_MS}ms 或采样间隔 ≥ ${EVENT_LOOP_DELAY_WARN_MS}ms 才会出现这一段 ⇒ ` +
        '缺这一段 = "这段时间没越过 1000ms 门槛"，**不等于**"没测"',
    );
  }
  const cpuRatio = facts.process?.cpuRatio;
  if (timeouts.length > 0 && typeof cpuRatio === 'number' && cpuRatio < CPU_BUSY_CAVEAT_THRESHOLD) {
    caveats.push(
      `全超时的同时，探针从外面数到的网关进程 CPU ≈ ${cpuRatio} 核（近乎不动）—— ` +
        '与"忙不过来"**不符**（记事实，不定因）',
    );
  }
  return { verdict, headline, caveats };
}

function renderRpcLine(run) {
  const elapsed = typeof run.elapsedMs === 'number' ? `${run.elapsedMs}ms` : '—';
  const detail = run.status === 'ok' ? `载荷 ${run.payloadBytes ?? 0}B` : (run.message ?? '').slice(0, 160);
  const suffix = run.code ? ` [${run.code}]` : '';
  return `  ${String(run.method).padEnd(18)}${String(run.status).padEnd(12)}${elapsed.padStart(8)}  ${detail}${suffix}`;
}

function renderEventLoopSection(health) {
  const summary = health?.summary;
  const lines = [];
  if (!summary) return ['  （没跑采样）'];
  lines.push(`  采样 ${summary.samples} 次，其中**收到 eventLoop** 的 ${summary.received} 次`);
  if (!summary.present) {
    lines.push(
      `  ⚠️ 一次都没收到 eventLoop 段 —— 按网关采样器判据（阈值 ${EVENT_LOOP_DELAY_WARN_MS}ms），` +
        '这说明窗口内**没有**越过门槛的样本；**不是**"没测到"，也不代表"没问题"（判据出处见【8】）',
    );
    return lines;
  }
  lines.push(
    `  峰值：delayMaxMs=${summary.peak.delayMaxMs}ms  delayP99Ms=${summary.peak.delayP99Ms}ms  ` +
      `utilization=${summary.peak.utilization}  cpuCoreRatio=${summary.peak.cpuCoreRatio}（网关进程自己）`,
  );
  lines.push(
    `  degraded：${summary.degradedAny ? '有' : '没有'}；reasons=${summary.reasons.length ? summary.reasons.join(',') : '（空）'}；` +
      `degradedSinceMs=${summary.degradedSinceMs ?? '—'}`,
  );
  return lines;
}

function renderConfigSection(config) {
  const lines = [];
  const timeline = Array.isArray(config?.timeline) ? config.timeline : [];
  lines.push(
    `  当前：size=${config?.size ?? '—'}B  sha256=${String(config?.sha256 ?? '—').slice(0, 16)}  mtimeMs=${config?.mtimeMs ?? '—'}`,
  );
  if (timeline.length === 0) {
    lines.push('  窗口内**没观察到**写入（探针期间配置没被动过）');
  } else {
    for (const event of timeline) {
      lines.push(
        `  ${String(event.kind).padEnd(9)}+${event.offsetMs ?? '—'}ms  sha256=${String(event.sha256 ?? '—').slice(0, 16)}  ${event.size ?? '—'}B`,
      );
    }
    if (!timeline.some((event) => event.kind === 'changed')) {
      lines.push('  （只有 baseline/touched：**字节没变** ⇒ 按 T-a22 的实测，这种写入不触发重载）');
    }
  }
  const backups = Array.isArray(config?.backups) ? config.backups : [];
  if (backups.length > 0) {
    lines.push('  备份轮转（间接线索，不是写入日志）：');
    for (const backup of backups)
      lines.push(`    ${backup.name}  mtimeMs=${backup.mtimeMs ?? '—'}  ${backup.size ?? '—'}B`);
  }
  return lines;
}

function renderProcessSection(process) {
  if (!process || process.found !== true) {
    return ['  **没取到**端口拥有者/PID（原因见【7】）—— 这一项缺了不要说成"没有异常进程"'];
  }
  const lines = [`  PID：${process.pid}  进程名：${process.name ?? '—'}  父进程 PID：${process.ppid ?? '—'}`];
  if (process.workingSetBytes !== null && process.workingSetBytes !== undefined) {
    lines.push(`  内存（WorkingSet）：${Math.round(process.workingSetBytes / (1024 * 1024))}MB`);
  }
  if (typeof process.cpuRatio === 'number') lines.push(`  探针窗口内 CPU：≈ ${process.cpuRatio} 核`);
  if (process.commandLine) lines.push(`  命令行：${String(process.commandLine).slice(0, 400)}`);
  return lines;
}

function renderLogsSection(logs) {
  if (!logs || logs.found !== true) {
    return ['  **没取到**客户端调试日志窗口（原因见【7】）'];
  }
  return [
    `  取自：${logs.path}`,
    `  窗口：最近 ${logs.windowMinutes} 分钟；保留 ${logs.keptCount} 行（总 ${logs.totalCount} 行，时间戳读不出的 ${logs.skippedCount} 行未收）`,
    logs.writtenPath ? `  已另存：${logs.writtenPath}` : '',
  ].filter(Boolean);
}

/**
 * 报告正文。**结构固定**：先一句话判读，再六类证据，最后"没做到的"与出处。
 * ⚠️ 任何一项没取到，都要在【7】里点名写出来 —— 报告里的留白会被读成"没问题"。
 */
export function renderReport(facts = {}) {
  const judged = judgeProbe(facts);
  const lines = [];
  lines.push('荣盈魔方 · 网关探针报告（T-a8「网关卡死」取证）');
  lines.push(`生成时间：${facts.generatedAt ?? '—'}`);
  lines.push(`判读：${judged.headline}`);
  lines.push(`判读编号：${judged.verdict}`);
  for (const caveat of judged.caveats) lines.push(`  · 附注：${caveat}`);
  lines.push('');

  lines.push('【1】连接');
  lines.push(`  stateDir：${facts.probe?.stateDir ?? '—'}`);
  lines.push(
    `  配置文件：${facts.probe?.configPath ?? '—'}（token ${facts.probe?.tokenPresent ? '已读到' : '**没读到**'}）`,
  );
  lines.push(`  端口：${facts.probe?.port ?? '—'}`);
  lines.push(
    `  WS 可达：${facts.connection?.reachable === true ? '是' : '否'}；握手 ${facts.connection?.handshakeMs ?? '—'}ms；` +
      `等 challenge ${facts.connection?.challengeMs ?? '—'}ms；connect：${facts.connection?.connectOk === true ? 'ok' : `失败（${facts.connection?.error ?? '见日志'}）`}`,
  );
  lines.push(
    `  agent owner：${facts.owner?.agentId ?? '**没解析出来**'}（来源 ${facts.owner?.source ?? '—'}；agents ${facts.owner?.agentsCount ?? '—'} 条）`,
  );
  lines.push('');

  lines.push(`【2】RPC 耗时（默认 ${DEFAULT_RPC_METHODS.length} 条 + agents.list；单条超时上限 ${RPC_TIMEOUT_MS}ms）`);
  for (const run of Array.isArray(facts.rpcs) ? facts.rpcs : []) lines.push(renderRpcLine(run));
  if (!facts.rpcs?.length) lines.push('  （一条都没跑成）');
  lines.push('');

  lines.push(`【3】health.eventLoop（连续 ${facts.health?.samples ?? DEFAULT_SAMPLES} 次采样）`);
  lines.push(...renderEventLoopSection(facts.health));
  lines.push('');

  lines.push('【4】配置时间线（openclaw.json）');
  lines.push(...renderConfigSection(facts.config));
  lines.push('');

  lines.push('【5】进程与端口');
  lines.push(...renderProcessSection(facts.process));
  lines.push('');

  lines.push('【6】证据附件');
  lines.push(...renderLogsSection(facts.logs));
  lines.push('');

  lines.push('【7】没做到的 / 没取到的（照实列，别当"没问题"）');
  const warnings = Array.isArray(facts.warnings) ? facts.warnings : [];
  lines.push(...(warnings.length ? warnings.map((warning) => `  · ${warning}`) : ['  · （无）']));
  lines.push('');

  lines.push('【8】出处与可重跑命令');
  lines.push(
    `  重跑：${facts.probe?.rerunCommand ?? 'node scripts/gateway-probe.mjs "<stateDir>"'}（仓库根目录，Node 22+）`,
  );
  lines.push(
    '  eventLoop 字段/阈值出处：随包运行时 <deployed>/node_modules/openclaw/dist/ 下 health-*.d.ts 与 sessions-*.mjs 的',
  );
  lines.push('    `HealthSnapshotSchema`（eventLoop 在 health 载荷**顶层**、可缺省），以及 server-start-*.mjs 的');
  lines.push(
    `    EVENT_LOOP_DELAY_WARN_MS=${EVENT_LOOP_DELAY_WARN_MS} / SUSTAINED_LOAD_SAMPLE_MIN_INTERVAL_MS=${EVENT_LOOP_DELAY_WARN_MS}。`,
  );
  lines.push(
    '  owner 出处：packages/core/src/services/gateway-dispatcher.ts 的 fetchCatalogs 注释（tools.catalog 必须带 agentId）。',
  );
  return lines.join('\n');
}
