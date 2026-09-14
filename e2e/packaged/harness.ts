import { chromium, type Browser, type Page } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { freshProfile, safeRemoveTree } from '../helpers/temp-root.js';

/**
 * 打包态 E2E 的公共脚手架：起 app、等网关、连 CDP、读模型目录。
 *
 * ⚠️ 与 `packaged-runtime.spec.ts`（阶段 1）里的同名逻辑是**刻意分开**的 ——
 * 那份是已验证的基线，不为复用去动它。
 */

export const REPO_ROOT = path.resolve(__dirname, '../..');
export const APP_EXE = path.join(REPO_ROOT, 'packages/desktop/dist/win-unpacked/魔方罗盘.exe');
export const RUNTIME_OUT = path.join(REPO_ROOT, 'runtime-out');
export const ARTIFACTS = path.join(REPO_ROOT, 'packages/desktop/e2e-artifacts');
export const GATEWAY_PORT = 18789;

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function portHasGateway(port = GATEWAY_PORT): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/startupz`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 开一个全新的隔离 profile。
 *
 * ⚠️ 落在**统一临时根**下（见 `e2e/helpers/temp-root.ts`），不再直接堆在 `%TEMP%`：
 * 每次打包态场景都会在这个目录里重新部署一遍完整运行时（~600MB），
 * 而 `%TEMP%` 在 C 盘上 —— 实测一天跑出 261 个目录、70GB，把 C 盘撑到只剩 15GB。
 */
export function freshUserData(tag: string): string {
  return freshTrackedProfile(`2a-${tag}`);
}

export interface LaunchedApp {
  proc: ChildProcess;
  cdpPort: number;
  /** 子进程 stdout/stderr 的尾巴（排障用）。 */
  outputTail: () => string;
}

// ---------------------------------------------------------------- profile 台账
//
// 每次打包态场景都开一个**新 profile**，并在里面部署一份完整运行时（~600MB）。
// 从前这些目录**从不回收** —— 一天就堆出 70GB 把 C 盘撑爆。现在的规矩：
//
//   全部通过 → 本 suite 建的 profile 全删
//   有失败   → **留着**那一次的证据（但下次 suite 启动前按保留策略扫）

const createdProfiles: string[] = [];
let anyTestFailed = false;

/** 记一笔"这个 profile 是我建的"（**正常路径不用手调**，见 `freshTrackedProfile`）。 */
export function trackProfile(dir: string): void {
  if (dir && !createdProfiles.includes(dir)) createdProfiles.push(dir);
}

/**
 * 开一个 profile 并**当场登记** —— 打包态 E2E 里创建大型 profile 的唯一入口。
 *
 * ⚠️ 收口在这里是**刻意的**，不是洁癖。拆成「先 `freshProfile` 再 `trackProfile`」
 * 两步时，调用方一定会忘，而且忘了**不会报错** —— 只是那个 profile 悄悄活到天荒地老：
 *
 *   2026-09-13 实测：packaged suite 建了 6 个 profile，收摊**只删掉 5 个**，
 *   漏网的 `clawwork-2a-clean-WRtSp4`（634 MB / 36392 个文件）正是**唯一**
 *   绕开 `bootConfigured`、自己手写创建流程的场景 1 —— 它少写了一句 `trackProfile`，
 *   于是压根没进台账，`cleanupProfiles()` 根本不知道有它。
 *
 * ⇒ 拿到目录就等于已在台账里，`cleanupProfiles()` 收摊时必然覆盖到。
 */
export function freshTrackedProfile(tag: string): string {
  const dir = freshProfile(tag);
  trackProfile(dir);
  return dir;
}

/** 标记"这次 suite 出过错" ⇒ 收摊时不删，留证据。 */
export function markFailure(): void {
  anyTestFailed = true;
}

/** 测试用：清空台账。 */
export function resetProfileLedger(): void {
  createdProfiles.length = 0;
  anyTestFailed = false;
}

export interface ProfileCleanupResult {
  removed: string[];
  kept: string[];
  reason: string;
}

/**
 * 收摊：把本 suite 建的 profile 按成败处理。
 *
 * ⚠️ 删除一律走 `safeRemoveTree`（junction-safe）—— profile 里有目录 junction，
 * 用 `rm -rf` 会把链接指向的真实目录删掉（项目里真的发生过）。
 */
export function cleanupProfiles(): ProfileCleanupResult {
  if (anyTestFailed) {
    return { removed: [], kept: [...createdProfiles], reason: '有失败 ⇒ 保留现场（下次启动前由保留策略清理）' };
  }
  const removed: string[] = [];
  for (const dir of createdProfiles) {
    try {
      safeRemoveTree(dir);
      removed.push(dir);
    } catch (error) {
      // 删不掉不该让**测试结果**变红：这属于环境问题，如实告警即可。
      console.warn(`[e2e-clean] 删不掉 ${dir}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const kept = createdProfiles.filter((d) => fs.existsSync(d));
  return { removed, kept, reason: kept.length === 0 ? '全部通过 ⇒ 已删除' : '全部通过，但有目录没删掉' };
}

/**
 * ⚠️ **必须把子进程的 stdout/stderr 读掉，否则会把应用卡死。**
 *
 * 打包态的 Electron 主进程把调试日志（`getDebugLogger()` 的 console 传输，
 * 见 `debug/logger.ts`）写到 stdout。而 `stdio: 'pipe'` 且**没人读**时，
 * 管道缓冲区（Windows 上 64KB）一满，子进程的 `console.log` 就**阻塞** ——
 * 整个主进程的事件循环停住，所有 IPC（包括 `page.evaluate` 走的那条）再也不回。
 *
 * 症状极具迷惑性，实测被骗了好几轮：应用"活着"、`/startupz` 200、网关进程也在、
 * 独立 CLI 也能 RPC，唯独界面侧的调用全部超时；而且**只有真的发消息**
 * （日志量暴涨）才触发 —— 看着像"发请求把网关/RPC 打挂了"，
 * 实际是测试自己把 stdout 堵死了。
 */
export function drainAndKeepTail(proc: ChildProcess, keepBytes = 8000): () => string {
  // 有上限的环形缓冲：**绝不无界 push 到内存**。
  let tail = '';
  for (const stream of [proc.stdout, proc.stderr]) {
    stream?.on('data', (buf: Buffer) => {
      tail = (tail + buf.toString()).slice(-keepBytes);
    });
    // ⚠️ 消费者**自己**抛异常会把 drain 断掉、于是又把子进程堵死 —— 必须吞。
    stream?.on('error', () => {});
  }
  return () => tail;
}

/** 起打包好的 app（隔离 userData，真实 runtime source）。 */
export function launchApp(userDataDir: string, cdpPort: number): LaunchedApp {
  const proc = spawn(APP_EXE, [`--user-data-dir=${userDataDir}`, `--remote-debugging-port=${cdpPort}`], {
    cwd: path.dirname(APP_EXE),
    env: {
      ...process.env,
      CLAWWORK_RUNTIME_DIR: RUNTIME_OUT,
      // 显式清掉：不让"这台机器恰好有个合格 Node"或 dev 的 userData 覆盖混进来
      CLAWWORK_NODE: '',
      CLAWWORK_USER_DATA_DIR: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  return { proc, cdpPort, outputTail: drainAndKeepTail(proc) };
}

/** 收 app 整棵进程树（网关是它的子进程）。 */
export function killApp(app: LaunchedApp | null): void {
  if (!app?.proc.pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(app.proc.pid), '/T', '/F'], {
      timeout: 15_000,
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch {
    /* 已经退出了 */
  }
}

/** 进程表里所有 node.exe 的 (pid, 可执行文件路径)。 */
export function nodeProcesses(): Array<{ pid: number; exe: string }> {
  const ps = [
    '-NoProfile',
    '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }`,
  ];
  try {
    const out = execFileSync('powershell', ps, { encoding: 'utf-8', timeout: 30_000, windowsHide: true });
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf('|');
        return { pid: Number(l.slice(0, i)), exe: l.slice(i + 1) };
      })
      .filter((p) => Number.isFinite(p.pid) && p.exe);
  } catch {
    return [];
  }
}

/**
 * 杀掉**跑在这个 profile 里**的网关。
 *
 * ⚠️ 为什么不能只靠 `killApp`（实测踩过，两次）：应用的进程树被 `taskkill /T` 收掉时，
 * 网关**不一定跟着走**（它已经是被 openclaw 接管的独立进程了）。残留的网关继续占着
 * 18789 → 下一次启动的"端口是不是空的"检查直接通过 → 但那个网关属于**上一个 profile**，
 * 于是后面每一步都在等一个永远不会来的状态，一直撞满测试超时。
 *
 * 判据用**可执行文件路径**（`<profile>/runtime/deployed/.../node.exe`）而不是进程名 ——
 * 这台机器上还有别的 node.exe，误杀是灾难。
 */
export function killProfileGateways(userDataDir: string): void {
  if (!userDataDir) return;
  const root = path.join(userDataDir, 'runtime').toLowerCase();
  for (const p of nodeProcesses()) {
    if (!p.exe.toLowerCase().startsWith(root)) continue;
    try {
      execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], {
        timeout: 15_000,
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      /* 已经退出了 */
    }
  }
}

/**
 * 当前占着 18789 的网关进程的 PID（没有就 null）。
 *
 * ⚠️ 判据用**端口**而不是进程名：这台机器上还有别的 node.exe，按名找必然误伤
 * （与 `killProfileGateways` 同一口径）。给「登录把网关重启了」这类断言用 ——
 * 网关一旦重启，PID 必变。
 */
export function gatewayPid(): number | null {
  const ps = [
    '-NoProfile',
    '-Command',
    `$c = Get-NetTCPConnection -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1;` +
      `if ($c) { Write-Output $c.OwningProcess }`,
  ];
  try {
    const out = execFileSync('powershell', ps, { encoding: 'utf-8', timeout: 30_000, windowsHide: true }).trim();
    const n = Number(out);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** 彻底收摊：app + 这个 profile 的网关，然后**确认端口真空出来**。 */
export async function stopEverything(app: LaunchedApp | null, userDataDir: string): Promise<void> {
  killApp(app);
  killProfileGateways(userDataDir);
  for (let i = 0; i < 30 && (await portHasGateway()); i++) await sleep(1000);
}

/** 等网关 /startupz 通。 */
export async function waitForGateway(timeoutMs = 10 * 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portHasGateway()) return true;
    await sleep(2000);
  }
  return false;
}

export async function connect(cdpPort: number, timeoutMs = 60_000): Promise<{ browser: Browser; page: Page }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
      const page = browser.contexts().flatMap((c) => c.pages())[0];
      if (page) return { browser, page };
      await browser.close().catch(() => {});
    } catch {
      /* CDP 还没起来 */
    }
    if (Date.now() >= deadline) throw new Error(`连不上 CDP :${cdpPort}`);
    await sleep(1000);
  }
}

export interface ModelSummary {
  total: number;
  relay: Array<{ id: string; name: string; provider: string }>;
}

/**
 * 读**真实**的 `models.list`（走 preload 暴露的 IPC，不是模拟）。
 *
 * ⚠️ 判据必须是 `provider === 'clawrouter'` —— 网关返回的是 openclaw 的全量目录
 * （实测 31 条，含 claude、gpt 等我们服务不了的），
 * 只有 provider 是 clawrouter 的那些才走中转。
 */
export async function readModels(page: Page): Promise<ModelSummary> {
  const res = (await page.evaluate(async () => {
    const api = (window as unknown as { clawwork: { listModels: (id: string) => Promise<unknown> } }).clawwork;
    return (await api.listModels('local-runtime')) as {
      ok: boolean;
      result?: { models?: Array<{ id?: string; name?: string; provider?: string }> };
    };
  })) as { ok: boolean; result?: { models?: Array<{ id?: string; name?: string; provider?: string }> } };

  const all = res.result?.models ?? [];
  return {
    total: all.length,
    relay: all
      .filter((m) => m.provider === 'clawrouter')
      .map((m) => ({ id: String(m.id ?? ''), name: String(m.name ?? ''), provider: String(m.provider ?? '') })),
  };
}

/** 轮询到中转模型出现（网关目录是异步热的）。 */
export async function waitForRelayModels(page: Page, minCount = 1, timeoutMs = 180_000): Promise<ModelSummary> {
  const deadline = Date.now() + timeoutMs;
  let last: ModelSummary = { total: 0, relay: [] };
  for (;;) {
    last = await readModels(page);
    if (last.relay.length >= minCount) return last;
    if (Date.now() >= deadline) return last;
    await sleep(5000);
  }
}

export function ensureArtifacts(): void {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
}
