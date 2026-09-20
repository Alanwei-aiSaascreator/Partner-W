#!/usr/bin/env node
/**
 * 网关探针（T-a8 取证）：网关卡死时（**端口在听、连接能建、但所有 RPC 超时**）**先留证据再杀进程**。
 *
 * 用法：
 *   node scripts/gateway-probe.mjs                          # 自动找 %APPDATA%\@clawwork\desktop\openclaw-state
 *   node scripts/gateway-probe.mjs <stateDir>               # 指定 state 目录
 *   node scripts/gateway-probe.mjs <stateDir> --samples 30 --interval-ms 500
 *   node scripts/gateway-probe.mjs <stateDir> --out D:\probe  # 报告目录（默认：系统临时目录下的一个新夹子）
 *   node scripts/gateway-probe.mjs <stateDir> --json         # 只打机器可读的事实（不写报告）
 *
 * 它取什么（= Codex 复核 T-a8 时点名要的几类证据，见 `docs/plan/2026-09-20-自主任务队列.md`）：
 *   ① 连接过程（握手/等 challenge/connect 各自多少毫秒）；
 *   ② 默认五条 RPC 的**耗时**（`health`/`config.get`/`tools.catalog`/`sessions.list`/`skills.status`）；
 *   ③ 连续多次的**完整** `health.eventLoop`（`delayMaxMs`/`delayP99Ms`/`utilization`/`cpuCoreRatio`/
 *      `degraded`/`degradedSinceMs`/`reasons`）—— 唯一能证明"事件循环被堵住"的仪表；
 *   ④ `openclaw.json` 的 sha256/size/mtime + 探针窗口内的**写入时间线**（+ 备份轮转的 mtime）；
 *   ⑤ 端口拥有者 PID / 父 PID / 命令行 / 内存 / 探针窗口内进程 CPU（**从外面数**，与网关自报的两个口径互相印证）；
 *   ⑥ 客户端调试日志最近 N 分钟的**时间窗**（另存一份 ndjson，不塞进报告正文）。
 *
 * ⚠️ **只读**：不写用户的 state 目录、不改配置、不杀进程。写盘只在报告目录里发生。
 * ⚠️ **退出码说的是"探针自己跑没跑成"**（0 = 报告出来了），**不是**"网关好不好"——
 *    网关卡死时探针照样退出 0（它的活儿就是把证据留下来）。判读在报告的【判读】一行里。
 * ⚠️ `connect.challenge` 之后必须发 `connect` 才拿得到 RPC 权限；本脚本的握手参数抄自
 *    `packages/desktop/src/main/ws/gateway-client.ts`（同一套 client/caps/scopes）。
 * ⚠️ 只做 Windows（`netstat`/`tasklist`/`powershell`）—— 这个工具的目标机器就是 Windows。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  buildRpcParams,
  DEFAULT_RPC_METHODS,
  DEFAULT_SAMPLE_INTERVAL_MS,
  DEFAULT_SAMPLES,
  diffConfigTimeline,
  filterNdjsonWindow,
  judgeProbe,
  makeRpcRunner,
  pickAgentId,
  processCpuRatio,
  readEventLoop,
  renderReport,
  REPORT_NAME,
  RPC_TIMEOUT_MS,
  summarizeEventLoop,
} from './lib/gateway-probe.mjs';

const USAGE = `用法：node scripts/gateway-probe.mjs [stateDir] [选项]

  stateDir             网关 state 目录（默认：%APPDATA%\\@clawwork\\desktop\\openclaw-state）
  --samples N          连续采样次数（默认 ${DEFAULT_SAMPLES}）
  --interval-ms N      采样间隔毫秒（默认 ${DEFAULT_SAMPLE_INTERVAL_MS}）
  --timeout-ms N       单条 RPC 超时上限（默认 ${RPC_TIMEOUT_MS}）
  --out <目录|文件>     报告落点（默认：系统临时目录下 gateway-probe-<时间戳>/）
  --log-window-min N   客户端调试日志取最近几分钟（默认 2）
  --no-process-facts   不取端口/PID/进程 CPU（机器上没有 netstat/powershell 时用）
  --json               只打 JSON 事实，不写报告
  -h, --help           这一屏

退出码：0 = 探针自己跑成了（报告已写；**不代表网关是好的**）；2 = 用法/配置读不到。`;

function parseArgs(argv) {
  const flags = new Map();
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    if (inline !== undefined) flags.set(name, inline);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags.set(name, argv[++i]);
    else flags.set(name, true);
  }
  return { flags, positional };
}

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function defaultStateDir() {
  const appdata = process.env.APPDATA;
  return appdata ? path.join(appdata, '@clawwork', 'desktop', 'openclaw-state') : null;
}

function readConfig(configPath) {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return {
    token: cfg?.gateway?.auth?.token,
    port: typeof cfg?.gateway?.port === 'number' ? cfg.gateway.port : 18789,
  };
}

function sha256File(file) {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

function configEntry(configPath) {
  try {
    const stat = fs.statSync(configPath);
    return { sha256: sha256File(configPath), size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
  } catch {
    return null;
  }
}

/** Windows：谁在听这个端口（可能多条：0.0.0.0 与 127.0.0.1 各一条）。 */
function portOwners(port) {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const match = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
      if (match && Number(match[1]) === port) pids.add(Number(match[2]));
    }
    return [...pids];
  } catch {
    return [];
  }
}

function processFacts(pid) {
  const facts = { pid, ppid: null, name: null, commandLine: null, workingSetBytes: null, cpuSeconds: null };
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { "$($p.ParentProcessId)|$($p.Name)|$($p.CommandLine)" }`,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 },
    ).trim();
    const [ppid, name, commandLine] = out.split('|');
    facts.ppid = ppid ? Number(ppid) : null;
    facts.name = name || null;
    facts.commandLine = commandLine || null;
  } catch {
    /* 取不到就留 null —— 报告里会写成"没取到" */
  }
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid}).CPU; (Get-Process -Id ${pid}).WorkingSet64`,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 },
    ).trim();
    const [cpu, mem] = out.split(/\r?\n/);
    const cpuSeconds = Number(cpu);
    const memory = Number(mem);
    if (Number.isFinite(cpuSeconds)) facts.cpuSeconds = cpuSeconds;
    if (Number.isFinite(memory)) facts.workingSetBytes = memory;
  } catch {
    /* 同上 */
  }
  return facts;
}

function clientLogWindow(logDir, { nowMs, windowMinutes }) {
  try {
    const files = fs
      .readdirSync(logDir)
      .filter((name) => /^debug-.*\.ndjson$/i.test(name))
      .map((name) => ({ name, mtimeMs: fs.statSync(path.join(logDir, name)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (files.length === 0) return { found: false, path: logDir, warning: `日志目录里没有 debug-*.ndjson：${logDir}` };
    const newest = path.join(logDir, files[0].name);
    const text = fs.readFileSync(newest, 'utf8');
    const window = filterNdjsonWindow(text, { fromMs: nowMs - windowMinutes * 60_000, toMs: nowMs });
    return { found: true, path: newest, windowMinutes, ...window };
  } catch (error) {
    return { found: false, path: logDir, warning: `读客户端日志失败：${error?.message ?? error}` };
  }
}

function configBackups(stateDir) {
  try {
    return fs
      .readdirSync(stateDir)
      .filter((name) => /^openclaw\.json(\.bak(\.\d+)?|\.last-good)$/.test(name))
      .map((name) => {
        const stat = fs.statSync(path.join(stateDir, name));
        return { name, mtimeMs: Math.round(stat.mtimeMs), size: stat.size };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}

/** 握手：等 challenge → 发 connect（参数抄客户端）。返回连接层的事实。 */
function handshake(ws, token, { timeoutMs }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let challengeMs = null;
    const giveUp = setTimeout(
      () =>
        resolve({
          reachable: true,
          connectOk: false,
          handshakeMs: null,
          challengeMs,
          error: `等待 challenge 超时（${timeoutMs}ms）`,
        }),
      timeoutMs,
    );

    ws.addEventListener('message', (event) => {
      let frame = null;
      try {
        frame = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      if (frame.type === 'event' && frame.event === 'connect.challenge') {
        challengeMs = Date.now() - startedAt;
        const id = randomUUID();
        ws.send(
          JSON.stringify({
            type: 'req',
            id,
            method: 'connect',
            params: {
              minProtocol: 3,
              maxProtocol: 4,
              client: {
                id: 'gateway-client',
                displayName: 'gateway-probe',
                version: '0.0.1',
                platform: process.platform,
                mode: 'backend',
              },
              caps: ['tool-events'],
              auth: { token },
              role: 'operator',
              scopes: ['operator.admin', 'operator.write', 'operator.read', 'operator.approvals', 'operator.pairing'],
            },
          }),
        );
        return;
      }
      if (frame.type === 'res' && challengeMs !== null && frame.ok !== undefined) {
        clearTimeout(giveUp);
        resolve({
          reachable: true,
          connectOk: frame.ok === true,
          handshakeMs: Date.now() - startedAt,
          challengeMs,
          error: frame.error?.message ?? null,
        });
      }
    });
  });
}

async function main(argv) {
  const { flags, positional } = parseArgs(argv);
  if (flags.has('-h') || flags.has('--help')) {
    console.log(USAGE);
    return 0;
  }

  const stateDir = path.resolve(String(positional[0] ?? flags.get('--state-dir') ?? defaultStateDir() ?? '.'));
  const configPath = path.join(stateDir, 'openclaw.json');
  if (!fs.existsSync(configPath)) {
    console.error(`读不到网关配置：${configPath}\n（stateDir 传对了吗？）\n\n${USAGE}`);
    return 2;
  }
  const { token, port } = readConfig(configPath);
  if (!token) {
    console.error(`配置里没有网关 token（gateway.auth.token）：${configPath}`);
    return 2;
  }

  const samples = Math.round(num(flags.get('--samples'), DEFAULT_SAMPLES));
  const intervalMs = Math.round(num(flags.get('--interval-ms'), DEFAULT_SAMPLE_INTERVAL_MS));
  const timeoutMs = Math.round(num(flags.get('--timeout-ms'), RPC_TIMEOUT_MS));
  const logWindowMinutes = Math.round(num(flags.get('--log-window-min'), 2));
  const withProcessFacts = !flags.has('--no-process-facts');

  const startedAtMs = Date.now();
  const warnings = [];
  const runCommand = `node scripts/gateway-probe.mjs "${stateDir}" --samples ${samples} --interval-ms ${intervalMs}`;

  // ① 连接
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Authorization: `Bearer ${token}` } });
  const opened = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(true);
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  let connection = { reachable: opened, connectOk: false, handshakeMs: null, challengeMs: null, error: null };
  if (!opened) warnings.push(`WS 连不上 127.0.0.1:${port}（端口上没东西在听？还是被防火墙挡了？）`);

  let owner = { agentId: undefined, source: 'none', agentsCount: null };
  const rpcs = [];
  const healthSamples = [];
  const configSamples = [];
  const cpuSamples = [];
  let processInfo = { found: false };
  let logs = { found: false, warning: '没跑（没连上）' };

  if (opened) {
    connection = { ...connection, ...(await handshake(ws, token, { timeoutMs })) };
    const rpc = makeRpcRunner(ws, timeoutMs); // 统一的 RPC 出口：超时/回包都走同一套状态词表（lib 里）

    // ② owner：先问 agents.list（多 agent 配置下后面几条必须带 owner）
    const agentsRun = await rpc('agents.list', buildRpcParams('agents.list'));
    rpcs.push({ ...agentsRun, payload: undefined, paramsSummary: '{}' });
    if (agentsRun.status === 'ok') {
      const agentId = pickAgentId(agentsRun.payload);
      const list = agentsRun.payload?.agents;
      owner = {
        agentId,
        source: agentId ? (agentsRun.payload?.defaultId ? 'defaultId' : 'agents[0]') : 'none',
        agentsCount: Array.isArray(list) ? list.length : null,
      };
    } else {
      warnings.push(
        `agents.list 没成功（${agentsRun.status}${agentsRun.message ? `：${agentsRun.message.slice(0, 120)}` : ''}）⇒ 后面几条只能不带 owner`,
      );
    }
    if (!owner.agentId) warnings.push('没解析出 agent owner ⇒ tools.catalog 只能退回 agentScope=all（报告里会写明）');

    // ③ 默认五条：各跑一次，量耗时（第一条 health 用 probe:true 强制新鲜快照）
    for (const [index, method] of DEFAULT_RPC_METHODS.entries()) {
      const params = buildRpcParams(method, { agentId: owner.agentId, probe: method === 'health' && index === 0 });
      const run = await rpc(method, params);
      const summary = JSON.stringify(params);
      rpcs.push({
        ...run,
        payload: undefined,
        paramsSummary: summary.length > 60 ? `${summary.slice(0, 57)}...` : summary,
      });
    }

    // ④ 进程与端口（先取 PID，才能在采样窗口两头数 CPU）
    if (withProcessFacts) {
      const pids = portOwners(port);
      if (pids.length === 0) {
        processInfo = { found: false };
        warnings.push(`没取到端口 ${port} 的拥有者（netstat 里没有 LISTENING 行？权限不够？）`);
      } else {
        processInfo = { found: true, ...processFacts(pids[0]), allPids: pids };
        if (pids.length > 1)
          warnings.push(`端口 ${port} 有 ${pids.length} 个 LISTENING 的 PID：${pids.join('/')}（报告取的是第一个）`);
        if (typeof processInfo.cpuSeconds === 'number') {
          cpuSamples.push({ atMs: Date.now() - startedAtMs, cpuSeconds: processInfo.cpuSeconds });
        } else {
          warnings.push('没取到网关进程的 CPU 时间（Get-Process 失败）⇒ 报告里不会有"进程 CPU"这一项');
        }
      }
    } else {
      warnings.push('按参数跳过了端口/PID/进程 CPU（--no-process-facts）—— 这几项记为"没测"，不是"没问题"');
    }

    // ⑤ 连续采样：完整 health.eventLoop + 配置时间线
    // ⚠️ 采样用的是**不带 probe** 的 health：网关会走缓存分支，但 `eventLoop` 那一段是**实时合并**进去的
    //    （`dist/health-*.mjs` 的 `mergeCachedHealthRuntimeState`）⇒ 既能拿到最新仪表，又不给网关加负担。
    for (let index = 0; index < samples; index++) {
      const atMs = Date.now() - startedAtMs;
      const run = await rpc('health', buildRpcParams('health'));
      configSamples.push({ atMs, entry: configEntry(configPath) ?? undefined });
      healthSamples.push({
        atMs,
        status: run.status,
        eventLoop: run.status === 'ok' ? readEventLoop(run.payload) : null,
      });
      if (index < samples - 1) await sleep(intervalMs);
    }
    if (configSamples.every((sample) => !sample.entry))
      warnings.push(`窗口内读不到 ${configPath} 的 stat/sha（文件被锁？）`);

    // ⑥ 客户端日志窗口
    const appdata = process.env.APPDATA;
    logs = appdata
      ? clientLogWindow(path.join(appdata, '@clawwork', 'desktop', 'logs'), {
          nowMs: Date.now(),
          windowMinutes: logWindowMinutes,
        })
      : { found: false, warning: '环境变量 APPDATA 不在 ⇒ 找不到客户端日志目录' };
    if (!logs.found) warnings.push(logs.warning ?? '没取到客户端日志窗口');

    if (withProcessFacts && processInfo.found) {
      const again = processFacts(processInfo.pid);
      if (typeof again.cpuSeconds === 'number')
        cpuSamples.push({ atMs: Date.now() - startedAtMs, cpuSeconds: again.cpuSeconds });
      processInfo = { ...processInfo, ...again, found: true };
    }
    try {
      ws.close();
    } catch {
      /* 已经断了 */
    }
  }

  // 采样结果收口：失败**按条数**记账（不是每条刷一条 warning）
  const failedSamples = healthSamples.filter((sample) => sample.status !== 'ok');
  if (failedSamples.length > 0) {
    warnings.push(
      `采样时 health 有 ${failedSamples.length}/${healthSamples.length} 次没成功（第一条是 ${failedSamples[0].status}）⇒ 那几格的 eventLoop 是空的`,
    );
  }
  const summary = summarizeEventLoop(
    healthSamples.map((sample) => ({ atMs: sample.atMs, eventLoop: sample.eventLoop })),
  );

  const timeline = diffConfigTimeline(configSamples.filter((sample) => sample.entry));
  const cpuRatio = processCpuRatio(cpuSamples);

  const facts = {
    generatedAt: new Date().toISOString(),
    probe: {
      stateDir,
      configPath,
      port,
      tokenPresent: true,
      samples,
      intervalMs,
      timeoutMs,
      elapsedMs: Date.now() - startedAtMs,
      rerunCommand: runCommand,
    },
    connection,
    owner,
    rpcs: rpcs.map((run) => ({ ...run, payload: undefined })),
    health: { samples: healthSamples.length, summary },
    config: {
      ...(configEntry(configPath) ?? {}),
      timeline,
      backups: configBackups(stateDir),
    },
    process: processInfo.found ? { ...processInfo, cpuSamples, cpuRatio } : { found: false, cpuRatio: null },
    logs,
    warnings,
  };
  if (processInfo.found && cpuRatio === null) {
    warnings.push('进程 CPU 只数到一个点（或计数回退）⇒ 没算出窗口占用率，这一项记为"没测"');
  }

  if (flags.has('--json')) {
    console.log(JSON.stringify(facts));
    return 0;
  }

  const outArg = flags.get('--out');
  const isFileOut = typeof outArg === 'string' && path.extname(outArg).toLowerCase() === '.txt';
  const outDir =
    typeof outArg === 'string' && outArg.length > 0
      ? isFileOut
        ? path.dirname(path.resolve(outArg))
        : path.resolve(outArg)
      : path.join(os.tmpdir(), `gateway-probe-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = isFileOut ? path.resolve(outArg) : path.join(outDir, REPORT_NAME);

  // 日志窗口先落盘，好让报告里那一行直接写上它的路径（报告只渲染一次，不做二次覆盖写）
  let logPath = null;
  if (logs.found && logs.keptCount > 0) {
    logPath = path.join(outDir, 'client-log-window.ndjson');
    fs.writeFileSync(logPath, `${logs.kept.join('\n')}\n`, 'utf8');
    facts.logs = { ...logs, writtenPath: logPath };
  }

  const judged = judgeProbe(facts);
  const report = renderReport(facts);
  fs.writeFileSync(reportPath, `\uFEFF${report}`, 'utf8');

  console.log(`判读：${judged.headline}`);
  console.log(`判读编号：${judged.verdict}`);
  for (const caveat of judged.caveats) console.log(`  · ${caveat}`);
  const timeouts = facts.rpcs.filter((run) => run.status === 'timeout').length;
  console.log(
    `RPC：${facts.rpcs.length} 条，超时 ${timeouts} 条；采样 ${samples} 次，收到 eventLoop ${summary.received} 次`,
  );
  console.log(
    `配置时间线：${timeline.length === 0 ? '窗口内没观察到写入' : `${timeline.length} 个事件（changed ${timeline.filter((e) => e.kind === 'changed').length} 个）`}`,
  );
  if (warnings.length) console.log(`没取到的：${warnings.length} 条（报告【7】里逐条写着）`);
  console.log(`\n报告：${reportPath}`);
  if (logPath) console.log(`客户端日志窗口：${logPath}`);
  console.log('把这两份文件整个发回来即可。');
  return 0;
}

process.exit(await main(process.argv.slice(2)));
