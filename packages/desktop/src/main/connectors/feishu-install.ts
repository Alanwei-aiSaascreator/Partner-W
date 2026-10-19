import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * 飞书插件的**可信安装记录**（BUG-171，2026-10-18 同事 1.0.9 盘取证）。
 *
 * 内核 2026.9.3 的 `openChannelIngressQueue` 只对 `origin="bundled"` 或
 * `trustedOfficialInstall=true` 的插件开放。我们过去为了绕开 tgz 解压超时，
 * 直接把插件目录复制到 `state/extensions/feishu` —— 能加载、能出站，但**没有安装
 * 记录 ⇒ 收不到任何消息**（`reason=record-missing`，健康里 `ingressUnavailable:true`）。
 *
 * 记录存在 `state/openclaw.sqlite` 的 `config_machine_state.plugins.installedIndex`
 * 里（`installRecords.feishu`），由 `openclaw plugins install <npm spec>` 写入。
 * 本模块负责：
 *   ① 读记录判断是否已可信（不靠"目录存在"猜）；
 *   ② 用**随包 npm + 预置离线缓存**跑真正的官方安装，生成可信记录。
 */

export interface FeishuInstallRecord {
  source?: string;
  spec?: string;
  installPath?: string;
  resolvedName?: string;
  resolvedVersion?: string;
  resolvedSpec?: string;
}

interface DatabaseLike {
  prepare(sql: string): { get(...params: unknown[]): unknown };
  close(): void;
}

export type OpenInstallDatabase = (dbPath: string) => DatabaseLike;

function openBetterSqlite(dbPath: string): DatabaseLike {
  // 5s：连接器状态刷新与网关写入可能同时发生；1.5s 在高负载下会误判"没有记录"。
  const db = new Database(dbPath, { readonly: true, timeout: 5000 });
  return {
    prepare: (sql: string) => db.prepare(sql) as unknown as ReturnType<DatabaseLike['prepare']>,
    close: () => db.close(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `child` 是否**就在** `parent` 之下（含相等）。
 *
 * 2026-10-19 自审：安装记录的 `installPath` 是绝对路径，只判 `existsSync` 是不够的 ——
 * U 盘从 E: 换到 F: 后，如果 E: 被另一台同样装了本产品的电脑占用，旧路径会"恰好存在"，
 * 于是我们把它判成可信记录、不修，通道继续 ingressUnavailable（或更糟：由内核去用另一块盘上的插件）。
 * 可信必须同时满足"在本机当前 state 之下"。Windows 路径大小写不敏感 ⇒ 比较用归一化后的相对路径。
 */
function isUnderDirectory(child: string, parent: string): boolean {
  const from = path.resolve(parent).toLowerCase();
  const to = path.resolve(child).toLowerCase();
  const relative = path.relative(from, to);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * 读 `installRecords.feishu`。
 *
 * 返回 `null` 的情况一律按"不可信"处理：库不存在 / 没有 index / 没有 feishu 记录 /
 * 记录不是 npm 来源 / `installPath` 不存在（换盘后路径失效也算）。
 */
export function readFeishuInstallRecord(
  stateDir: string,
  deps: { openDatabase?: OpenInstallDatabase } = {},
): FeishuInstallRecord | null {
  const dbPath = path.join(stateDir, 'state', 'openclaw.sqlite');
  if (!existsSync(dbPath)) return null;
  let db: DatabaseLike | null = null;
  try {
    db = (deps.openDatabase ?? openBetterSqlite)(dbPath);
    const row = db
      .prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'plugins.installedIndex'")
      .get() as { value_json?: unknown } | undefined;
    if (!row || typeof row.value_json !== 'string') return null;
    const parsed: unknown = JSON.parse(row.value_json);
    if (!isRecord(parsed) || !isRecord(parsed['index'])) return null;
    const records = parsed['index']['installRecords'];
    if (!isRecord(records) || !isRecord(records['feishu'])) return null;
    const record = records['feishu'] as Record<string, unknown>;
    const installPath = typeof record['installPath'] === 'string' ? record['installPath'] : '';
    if (record['source'] !== 'npm' || !installPath) return null;
    // 换盘/换目录后记录还在、路径已经不存在 ⇒ 同样不可信（内核也会判 path-mismatch）。
    if (!existsSync(installPath)) return null;
    // 旧盘符撞上另一台装了本产品的电脑时，旧路径会"恰好存在" ⇒ 可信必须同时在本 state 之下。
    if (!isUnderDirectory(installPath, stateDir)) return null;
    return {
      source: 'npm',
      ...(typeof record['spec'] === 'string' ? { spec: record['spec'] } : {}),
      installPath,
      ...(typeof record['resolvedName'] === 'string' ? { resolvedName: record['resolvedName'] } : {}),
      ...(typeof record['resolvedVersion'] === 'string' ? { resolvedVersion: record['resolvedVersion'] } : {}),
      ...(typeof record['resolvedSpec'] === 'string' ? { resolvedSpec: record['resolvedSpec'] } : {}),
    };
  } catch {
    // 库被网关占着 / 半截写入：读不到就当没有，由调用方走安装或重试。
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // 忽略关闭失败
    }
  }
}

export interface FeishuInstallDeps {
  stateDir: string;
  /** 运行时部署里的 node（`<deployed>/node/node.exe`）。 */
  nodePath: string;
  /** 运行时部署里的 CLI（`<deployed>/node_modules/openclaw/openclaw.mjs`）。 */
  cliPath: string;
  /** 随包插件版本（从 `resources/connectors/feishu/package.json` 读）。 */
  pluginVersion: string;
  /**
   * 随包 npm 负载目录（`<resources>/runtime/node`：npm.cmd + node_modules/npm + npm-cache）。
   *
   * 运行时部署只复制 `node.exe`（部署凭据里没有 npm），所以首次安装前把它惰性复制到
   * `nodePath` 同级目录；已有部署不需要重新解压运行时。
   */
  payloadDir?: string;
  /** 注入用（测试）；默认 `child_process.spawn`。 */
  spawnProcess?: typeof spawn;
  timeoutMs?: number;
  /** 注入用（测试）：安装完成后复查记录。 */
  readRecord?: (stateDir: string) => FeishuInstallRecord | null;
  /** 额外环境变量（测试/排障）。 */
  env?: NodeJS.ProcessEnv;
}

export type FeishuInstallResult =
  | { ok: true; installed: boolean; record: FeishuInstallRecord }
  | {
      ok: false;
      reason: 'npm-missing' | 'version-missing' | 'timeout' | 'spawn-failed' | 'install-failed' | 'record-missing';
      detail: string;
    };

const INSTALL_TIMEOUT_MS = 240_000;

/**
 * 超时杀掉**整棵进程树**：CLI 会再 spawn npm（npm 又可能 spawn node），
 * 只 kill 父进程会把 npm 留在后台继续写 state。
 */
function killProcessTree(child: { pid?: number; kill: (signal?: NodeJS.Signals | number) => boolean }): void {
  if (process.platform === 'win32' && typeof child.pid === 'number') {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    } catch {
      // 退回 child.kill
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // 进程可能已经退出
  }
}

/**
 * 把随包 npm 负载复制到部署后的 node 目录（幂等）。
 *
 * 运行时的部署凭据只记录 `node.exe`，不会带 npm；而 npm 负载 40MB 又没必要每次
 * 重新解压整个运行时。这里在**第一次真正需要安装插件时**惰性复制：
 *   `<payloadDir>/npm.cmd` → `<nodeDir>/npm.cmd`
 *   `<payloadDir>/node_modules/npm` → `<nodeDir>/node_modules/npm`
 *   `<payloadDir>/npm-cache` → `<nodeDir>/npm-cache`
 * 目标已存在就跳过（按 npm.cmd + npm-cli.js + 离线缓存三个路径判断）。
 */
const npmPayloadInFlight = new Map<string, Promise<void>>();

async function ensureNpmPayload(nodeDir: string, payloadDir: string | undefined): Promise<void> {
  if (!payloadDir) return;
  const shim = path.join(nodeDir, 'npm.cmd');
  const cli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const cache = path.join(nodeDir, 'npm-cache');
  const sourceCache = path.join(payloadDir, 'npm-cache');
  const cacheNeeded = existsSync(sourceCache);
  // ⚠️ 三个都要查：只看 shim+cli 会在"缓存没复制全"时提前返回，随后 npm --offline
  //    必然失败（或退回联网），症状比缺 npm 更隐蔽。
  if (existsSync(shim) && existsSync(cli) && (!cacheNeeded || existsSync(cache))) return;
  const key = path.resolve(nodeDir);
  const running = npmPayloadInFlight.get(key);
  if (running) return running;
  const copy = (async () => {
    const sourceShim = path.join(payloadDir, 'npm.cmd');
    if (!existsSync(sourceShim)) return; // 旧运行时：交给上层报 npm-missing
    await cp(sourceShim, shim, { force: true });
    for (const name of ['node_modules/npm', 'npm-cache']) {
      const from = path.join(payloadDir, name);
      if (!existsSync(from)) continue;
      await cp(from, path.join(nodeDir, name), { recursive: true, force: true });
    }
  })();
  npmPayloadInFlight.set(key, copy);
  try {
    await copy;
  } finally {
    npmPayloadInFlight.delete(key);
  }
}

/**
 * 用随包 npm（`<nodeDir>/npm.cmd`）+ 预置离线缓存跑官方安装。
 *
 * 实测（2026-10-18）：缓存 25MB + npm 16MB，`NPM_CONFIG_OFFLINE=true` 时
 * `plugins install @openclaw/feishu@2026.9.3` **4 秒**完成，并写入真实 npm 安装记录。
 */
const installInFlight = new Map<string, Promise<FeishuInstallResult>>();

/**
 * 同一 state 目录只跑一次安装（连点/两个入口并发都会走到这里）。
 * 不同 state（另一块盘）各自独立。
 */
export async function installFeishuFromOfficialPackage(deps: FeishuInstallDeps): Promise<FeishuInstallResult> {
  const key = path.resolve(deps.stateDir);
  const running = installInFlight.get(key);
  if (running) return running;
  const task = installFeishuFromOfficialPackageOnce(deps);
  installInFlight.set(key, task);
  try {
    return await task;
  } finally {
    installInFlight.delete(key);
  }
}

async function installFeishuFromOfficialPackageOnce(deps: FeishuInstallDeps): Promise<FeishuInstallResult> {
  const readRecord = deps.readRecord ?? ((stateDir: string) => readFeishuInstallRecord(stateDir));
  const existing = readRecord(deps.stateDir);
  if (existing) return { ok: true, installed: false, record: existing };

  const nodeDir = path.dirname(deps.nodePath);
  try {
    await ensureNpmPayload(nodeDir, deps.payloadDir);
  } catch {
    // 复制失败不在这里判死：下面按 npm.cmd 是否存在给出准确原因。
  }
  const npmShim = path.join(nodeDir, 'npm.cmd');
  if (!existsSync(npmShim)) {
    return { ok: false, reason: 'npm-missing', detail: `missing ${npmShim}` };
  }
  const npmCache = path.join(nodeDir, 'npm-cache');
  // ⚠️ 读不到随包版本时**不许**静默回落一个写死的版本（2026-10-19 自审）：
  //    那会把一份未经验证的版本装进用户盘，而且结果看起来是"成功"。
  //    缺版本 = 交付包坏了，硬失败，由调用方按既有的"目录复制兜底 + 通道未就绪提示"处理。
  const pluginVersion = deps.pluginVersion.trim();
  if (!pluginVersion) {
    return {
      ok: false,
      reason: 'version-missing',
      detail: `resources/connectors/feishu/package.json 读不出版本号（bundled plugin dir）`,
    };
  }
  const spec = `@openclaw/feishu@${pluginVersion}`;
  const args = [
    deps.cliPath,
    'plugins',
    'install',
    spec,
    '--accept-capabilities',
    '--acknowledge-install-policy-warning',
  ];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...deps.env,
    OPENCLAW_STATE_DIR: deps.stateDir,
    NPM_CONFIG_CACHE: npmCache,
    // ⭐ 2026-10-19 现场：随包离线缓存是按 **npmmirror** 的 registry key 建的
    //    （packument：`registry.npmmirror.com/@openclaw%2ffeishu`；tarball：`cdn.npmmirror.com/...`）。
    //    不显式指定 registry，npm 会拿默认的 registry.npmjs.org 去查缓存 ⇒
    //    `ENOTCACHED: cache mode is 'only-if-cached' but no cached response` ⇒
    //    装机失败 ⇒ 没有可信记录 ⇒ 飞书工具不可用、收不到消息。
    NPM_CONFIG_REGISTRY: 'https://registry.npmmirror.com',
    ...(existsSync(npmCache) ? { NPM_CONFIG_OFFLINE: 'true' } : {}),
  };
  /**
   * ⭐ 2026-10-19 现场：**网关的 external 监督标记不能传给装机 CLI**。
   *
   * 内核 `assertGatewayServiceMutationAllowed()` 见到
   * `OPENCLAW_SUPERVISOR_MODE=external` 就拒绝任何需要停止/重启网关的命令：
   * 「managed by an external supervisor … Use that supervisor to stop the gateway」。
   * `plugins install` 会尝试管理网关 ⇒ 每次 exit 1 ⇒ 我们退回目录复制 ⇒
   * 永远没有可信安装记录 ⇒ 飞书只能发、不能收（reason=record-missing）。
   *
   * 这个标记只对**网关子进程**成立（`gateway-process.ts` 只加在 childEnv 上）；
   * 装机 CLI 是独立一次性命令，必须清掉（Windows 键大小写不敏感 ⇒ 逐键比大写）。
   */
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'OPENCLAW_SUPERVISOR_MODE') delete env[key];
  }
  // npm 命令由内核按 PATH 查找；把随包 node 目录放最前（npm.cmd 就在那里）。
  // ⚠️ Windows 上环境变量的键可能是 `Path` 而不是 `PATH`：沿用原有键名再改值，
  //    否则同一份环境里会出现两个 path 键，子进程取哪个不确定。
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = `${nodeDir}${path.delimiter}${env[pathKey] ?? ''}`;

  const spawnProcess = deps.spawnProcess ?? spawn;
  const timeoutMs = deps.timeoutMs ?? INSTALL_TIMEOUT_MS;

  interface AttemptResult {
    code: number | null;
    timedOut: boolean;
    error?: string;
    output: string;
  }

  const runAttempt = async (): Promise<AttemptResult> => {
    let output = '';
    const append = (chunk: Buffer | string) => {
      output = `${output}${chunk.toString()}`.slice(-8_000);
    };
    const result = await new Promise<{ code: number | null; timedOut: boolean; error?: string }>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      try {
        const child = spawnProcess(deps.nodePath, args, {
          env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout?.on('data', append);
        child.stderr?.on('data', append);
        child.on('error', (error) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve({ code: null, timedOut: false, error: error.message });
        });
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve({ code, timedOut: false });
        });
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          killProcessTree(child);
          // 给 taskkill/进程退出留一点收尾时间：立刻返回会让 CLI 再写几百毫秒的 state。
          setTimeout(() => resolve({ code: null, timedOut: true }), 1_500);
        }, timeoutMs);
      } catch (error) {
        resolve({ code: null, timedOut: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
    return { ...result, output };
  };

  /**
   * ⭐ 2026-10-19 现场（r52，E:）：装机真的开始下载后，CLI 报
   * `Could not start the CLI. Reason: config changed since last load`。
   * 原因是**时序竞态**：安装窗口里应用自身的配置写入（relay 初始化 / 能力边界 /
   * 网关重启）改了 `openclaw.json` ⇒ 装机 CLI 拒绝继续。
   * 这类失败**不是确定性错误**，重试即可；不重试的结果就是"我这台过、别人那台全挂"。
   * 只对这一个瞬时原因重试，其他失败（缓存缺失/权限/超时）照旧如实返回。
   */
  const TRANSIENT_INSTALL_FAILURE = /config changed since last load/i;
  const MAX_INSTALL_ATTEMPTS = 3;
  let last: AttemptResult | null = null;
  for (let attempt = 1; attempt <= MAX_INSTALL_ATTEMPTS; attempt += 1) {
    const result = await runAttempt();
    last = result;
    if (result.timedOut) return { ok: false, reason: 'timeout', detail: result.output.slice(-1_500) };
    if (result.error) return { ok: false, reason: 'spawn-failed', detail: result.error };
    if (result.code === 0) break;
    if (!TRANSIENT_INSTALL_FAILURE.test(result.output) || attempt === MAX_INSTALL_ATTEMPTS) {
      return {
        ok: false,
        reason: 'install-failed',
        detail: `exit ${result.code}: ${result.output.slice(-1_500)}`,
      };
    }
    // 1.5s / 3s：给并发写入一个收尾窗口；期间网关已由调用方停掉。
    await new Promise<void>((resolve) => setTimeout(resolve, 1_500 * attempt));
  }
  if (!last || last.code !== 0) {
    return {
      ok: false,
      reason: 'install-failed',
      detail: `exit ${last?.code ?? 'unknown'}: ${last?.output.slice(-1_500) ?? ''}`,
    };
  }
  const record = readRecord(deps.stateDir);
  if (!record) return { ok: false, reason: 'record-missing', detail: last?.output.slice(-1_500) ?? '' };
  return { ok: true, installed: true, record };
}
