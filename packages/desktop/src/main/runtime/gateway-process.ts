/**
 * 网关进程：探活 → 判定姿态 → （必要时）spawn → 等就绪 → 退出时按 ownership 收尾。
 *
 * ⚠️ **本模块最危险的一行代码是 `--force`**。`/startupz` 通了只说明
 * "端口上有个东西在答"，**不说明那是我们的网关**。把别人的 OpenClaw 当成自己的，
 * 后果不是"起不来"，而是我们把它的进程 kill 掉、或者把我们的 token 写进它的配置。
 * ⇒ 所以顺序**只能**是：先探活、再用**本 state 的 token** 认证，
 *   认证不过就**一个动作都不做**（不 spawn、不 force、不 kill），报端口被占。
 *
 * 三态（用户复审定的，见交付路线图阶段 1 修正 3）：
 *
 * | 情形 | 动作 |
 * |---|---|
 * | A. `/startupz` 不通 | 正常 spawn 我们自己的网关 |
 * | B. started **且**本 token 认证通过 | 视为我们的、复用，**不 spawn** |
 * | C. started **但**认证失败（或端口活着却不是 started） | **foreign** ⇒ 绝不 force/kill/覆盖配置；报 `runtime.gateway-port-occupied` |
 *
 * ⚠️ 另外三条实测出来的：
 *   - 就绪判据是 `GET /startupz` 返回 `{status:'started'}`。**不用 stdout 的 `ready`**
 *     （没有契约）、**不把 lock 文件当就绪**（崩溃残留的 lock 会让装载器等一个死进程）。
 *   - ⭐ **`started` 还不够，必须再认证上一次**（2026-09-13 实测，E2E 启动 2 就是被
 *     这条翻的）：`/startupz` 在上游自己的口径里是"可以放流量进来了"，但实测网关
 *     报 `started` 之后**还要几秒**才肯完成 WS 握手 —— 这段时间里认证探测是**挂住**
 *     （不是拒绝），5s 超时后返回 false。于是下一次启动会拿这个 false 去判
 *     **foreign**，报"端口被占"，而端口上跑的正是我们上一轮自己起的网关。
 *     ⇒ 对我们**自己刚 spawn 的**网关，`started + 认证通过` 才是就绪。
 *   - **子进程 exit 0 也可能是成功** —— 复用场景下进程本来就会退。所以 exit 只是
 *     "等待中止"的信号，不是"失败"的判据。
 */

import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import WebSocket from 'ws';
import { delimiter, dirname } from 'node:path';
import { getDebugLogger } from '../debug/index.js';
import { attachGatewayOutputStreams, gatewayOutputDigest } from './gateway-output.js';
import { BOOTSTRAP_PROCESS_EXITED, BOOTSTRAP_READY_TIMEOUT } from './bootstrap-retry.js';
import { inheritWindowsSystemProxy } from './gateway-proxy.js';

/** 端口被**别人**的网关占着（或占着的那个不可信）。 */
export const GATEWAY_PORT_OCCUPIED = 'runtime.gateway-port-occupied';

/**
 * 我们自己的网关**子进程很快就退出了**。
 *
 * 这是**唯一可重试**的一类失败 —— 白名单在 `bootstrap-retry.ts`，
 * 判据是**码**而不是文案（改文案不该改行为）。
 * 为什么它可以重试：它**快**（毫秒~秒级），再来一次的成本可忽略。
 */
export class GatewayProcessExitedError extends Error {
  readonly code = BOOTSTRAP_PROCESS_EXITED;
  constructor(message: string) {
    super(message);
    this.name = 'GatewayProcessExitedError';
  }
}

/**
 * 等网关就绪**等满了 180 秒**。⛔ **终态，绝不再试**。
 *
 * ⚠️ 必须与"早退"分开：两者看起来都是"网关没起来"，但代价差两个数量级 ——
 *    一次 180 秒，重试三次就是**九分钟**的等待（2026-09-25 复核抓到的洞）。
 */
export class GatewayReadyTimeoutError extends Error {
  readonly code = BOOTSTRAP_READY_TIMEOUT;
  constructor(message: string) {
    super(message);
    this.name = 'GatewayReadyTimeoutError';
  }
}

export class GatewayPortOccupiedError extends Error {
  readonly code = GATEWAY_PORT_OCCUPIED;
  constructor(message: string) {
    super(message);
    this.name = 'GatewayPortOccupiedError';
  }
}

/** `/startupz` 的探测结果。`reachable` = 这个端口上有东西在答 HTTP。 */
export interface StartupzProbe {
  reachable: boolean;
  /** 应答里的 `status`；不是我们的网关时为 undefined。 */
  status?: string;
}

export function generateGatewayToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * spawn 参数。
 *
 * ⚠️ `--allow-unconfigured` 是必需的：我们在 `openclaw.json` 里**刻意不写**
 * `gateway.mode`，没有这个开关网关会拒绝启动。
 */
export function buildGatewayArgs(opts: { cliPath: string; port: number }): string[] {
  return [opts.cliPath, 'gateway', 'run', '--force', '--allow-unconfigured', '--port', String(opts.port)];
}

export type ExistingGatewayVerdict = 'spawn' | 'reuse' | 'foreign';

export interface ExistingGatewayDecision {
  verdict: ExistingGatewayVerdict;
  /** 给人看的短句，进日志。 */
  reason: string;
}

/**
 * 三态判定（纯函数 —— 这行代码决定了我们会不会去动别人的进程，值得单独钉住）。
 *
 * ⚠️ 「端口活着但不是 `started`」也判 **foreign**：可能是别人的服务，
 * 也可能是某个网关没起完。两种情况我们都**没有资格**去 force/kill，
 * 保守报端口被占比误杀安全得多。
 */
export function classifyExistingGateway(opts: {
  reachable: boolean;
  status?: string;
  authenticated: boolean;
}): ExistingGatewayDecision {
  const { reachable, status, authenticated } = opts;

  if (!reachable) return { verdict: 'spawn', reason: '端口上没有网关' };
  if (status !== 'started') {
    return {
      verdict: 'foreign',
      reason: `端口上有个服务，但 /startupz 报的是 ${status ?? '无法识别'}（不是 started）`,
    };
  }
  if (authenticated) return { verdict: 'reuse', reason: '本 state 的 token 认证通过 —— 是我们自己的网关' };

  return { verdict: 'foreign', reason: '端口上的网关用本 state 的 token 认证失败 —— 不是我们的' };
}

// ---------------------------------------------------------------- 探活

type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  json: () => Promise<unknown>;
}>;

/**
 * 探 `/startupz`。
 *
 * ⚠️ **连不上不是异常**（ECONNREFUSED 正是"还没有网关"的正常表现），
 * 所以这里吞掉所有错误返回 `{reachable:false}`，而不是往上抛。
 */
export async function probeStartupz(opts: {
  port: number;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<StartupzProbe> {
  const { port, fetchImpl = fetch as unknown as FetchLike, timeoutMs = 2000 } = opts;
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/startupz`, { signal: AbortSignal.timeout(timeoutMs) });

    // ⚠️ 「答了 HTTP」和「答得像我们的网关」是两件事，必须分开：
    //    只要对方回了 HTTP（哪怕 404、哪怕 body 根本不是 JSON），**端口就是被占着的**。
    //    这里若因为"解析不出 status"就返回 reachable:false，上层会判成 spawn，
    //    于是我们往一个**已经有服务在听**的端口上再起一个网关 —— 正是三态判定要防的事。
    if (!res.ok) return { reachable: true };

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { reachable: true }; // 有人，但说的不是我们的协议 ⇒ status 未知
    }

    const status =
      body && typeof (body as { status?: unknown }).status === 'string'
        ? (body as { status: string }).status
        : undefined;
    return { reachable: true, status };
  } catch {
    // 只有"根本没连上"（ECONNREFUSED / 超时）才走这里
    return { reachable: false };
  }
}

/**
 * 用**本 state 的 token** 做最小认证探测：开 WS → 等 `connect.challenge` →
 * 发 `connect` → 看回的是不是 `hello-ok`。
 *
 * ⚠️ 用的是与真实客户端**同一套**握手帧（`{type:'req', id, method, params}`，
 * 应答数据在 `payload` 不是 `result`）—— 帧写错会让**我们自己的**网关被判成 foreign。
 *
 * ⚠️ `device-identity` 是**惰性 import** 的：那个模块顶层就 `import { app } from 'electron'`，
 * 静态引进来会把 electron 拖进本模块的单测。
 */
export async function probeGatewayAuth(opts: {
  port: number;
  token: string;
  clientVersion: string;
  identityPath: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const { port, token, clientVersion, identityPath, timeoutMs = 5000 } = opts;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);

  try {
    const { buildDeviceConnectPayload, loadOrCreateDeviceIdentity } = await import('../ws/device-identity.js');
    const identity = loadOrCreateDeviceIdentity(identityPath);
    const scopes = ['operator.admin', 'operator.write', 'operator.read', 'operator.approvals', 'operator.pairing'];

    return await new Promise<boolean>((resolve) => {
      const done = (ok: boolean): void => {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* 关不掉就算了，进程退出时自然回收 */
        }
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), timeoutMs);

      ws.on('message', (raw: Buffer) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        } catch {
          return;
        }

        if (frame.type === 'event' && frame.event === 'connect.challenge') {
          const payload = (frame.payload ?? {}) as Record<string, unknown>;
          const nonce = typeof payload.nonce === 'string' ? payload.nonce.trim() : '';
          const params = {
            minProtocol: 3,
            maxProtocol: 4,
            client: {
              id: 'gateway-client',
              displayName: 'ClawWork Desktop',
              version: clientVersion,
              platform: process.platform,
              mode: 'backend',
            },
            caps: ['tool-events'],
            auth: { token },
            role: 'operator',
            scopes,
            device: buildDeviceConnectPayload(identity, {
              clientId: 'gateway-client',
              clientMode: 'backend',
              role: 'operator',
              scopes,
              nonce,
              token,
              platform: process.platform,
              deviceFamily: null,
            }),
          };
          ws.send(JSON.stringify({ type: 'req', id: 'runtime-auth-probe', method: 'connect', params }));
          return;
        }

        if (frame.type === 'res' && frame.id === 'runtime-auth-probe') {
          if (frame.error) {
            done(false);
            return;
          }
          const payload = (frame.payload ?? {}) as Record<string, unknown>;
          done(payload.type === 'hello-ok');
        }
      });

      ws.on('error', () => done(false));
      ws.on('close', () => done(false));
    });
  } catch {
    try {
      ws.close();
    } catch {
      /* 见上 */
    }
    return false;
  }
}

// ---------------------------------------------------------------- 等就绪

/**
 * 轮询到网关**真的可用**。
 *
 * 两步，缺一不可：
 *   ① `GET /startupz` 返回 `{status:'started'}`
 *   ② **用本 state 的 token 认证通过**
 *
 * ⚠️ 第 ② 步不是锦上添花，是实测出来的**必需**（见文件头）：网关报 `started`
 * 之后还要几秒才肯完成 WS 握手，这期间认证探测会挂住并超时。少了它，下一轮启动
 * 会把我们自己的网关判成 foreign。
 *
 * 总超时 **180s** 是给首次启动留的：网关自身冷启动就要 ~38s，第一次还要解压
 * 35k 个文件（1–3 分钟），再加上面那个"started 之后还要几秒"的窗口。
 * 窗口先出来、有进度，别让它看着像卡死。
 *
 * ⚠️ **子进程退出要立刻中止等待**，否则会一直等满 180s 才发现进程早就没了 ——
 * 用户看到的是"转三分钟然后报一个含糊的超时"。
 */
export async function waitForGatewayReady(opts: {
  probe: () => Promise<StartupzProbe>;
  /**
   * 就绪的第二步。**必填** —— 让它可选就等于允许调用方把"started 就是就绪"
   * 这个已经证伪的假设再写回来。
   */
  authenticate: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  hasExited: () => boolean;
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
}): Promise<{ status: string }> {
  const { probe, authenticate, sleep, hasExited, intervalMs = 500, timeoutMs = 180_000, now = () => Date.now() } = opts;
  const deadline = now() + timeoutMs;
  let last = '（还没探到）';

  for (;;) {
    if (hasExited()) {
      // ⚠️ 带码：**可重试**的一类（子进程早退、代价小），白名单见 `bootstrap-retry.ts`。
      throw new GatewayProcessExitedError(`网关进程在就绪之前就退出了（最后一次探测：${last}）`);
    }

    let result: StartupzProbe;
    try {
      result = await probe();
    } catch {
      result = { reachable: false };
    }

    if (result.reachable && result.status === 'started') {
      // 认证探测自己抛（或超时）都只是"还没好" —— 不是"不是我们的"。
      // 这里**只有 spawn 之后**这一条路径，端口上的东西就是刚起的那个进程。
      let authenticated = false;
      try {
        authenticated = await authenticate();
      } catch {
        authenticated = false;
      }
      if (authenticated) return { status: 'started' };
      last = 'started，但本 token 还没认证上（网关还没肯完成 WS 握手）';
    } else {
      last = result.reachable ? `HTTP 在但 status=${result.status ?? '未知'}` : '连不上';
    }

    if (now() >= deadline) {
      // ⚠️ 另一类：**等满 180 秒**。这是终态 —— 再试一次就是再让用户等三分钟。
      throw new GatewayReadyTimeoutError(`等待网关就绪超时（${Math.round(timeoutMs / 1000)}s，最后一次探测：${last}）`);
    }
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------- 进程

export interface GatewayChildProcess {
  pid: number | undefined;
  /** 子进程退出时回调 —— 给 `waitForGatewayReady` 的 `hasExited` 用。 */
  onExit: (listener: () => void) => void;
  kill: () => void;
}

export type GatewaySpawnFn = (opts: {
  nodeExe: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  secrets: readonly string[];
}) => GatewayChildProcess;

function toGatewayChild(child: ChildProcess, secrets: readonly string[]): GatewayChildProcess {
  const output = attachGatewayOutputStreams(
    {
      stdout: child.stdout,
      stderr: child.stderr,
      onClose: (listener) => child.once('close', listener),
    },
    {
      secrets,
      onSinkError: (error) => console.error('[runtime] 网关输出日志写入失败（管道继续排空）:', error),
    },
    (line) => {
      getDebugLogger().info({
        domain: 'gateway',
        event: 'runtime.gateway.output',
        // stdout/stderr 是任意自由文本，可能含用户/模型正文。不能用换字段名绕过
        // shared debug 对 `text` 的隐私摘除；这里只落可关联的指纹与计数。
        data: {
          stream: line.stream,
          repeat: line.repeat,
          summary: line.summary,
          dropped: line.dropped,
          textBytes: Buffer.byteLength(line.text, 'utf8'),
          textDigest: gatewayOutputDigest(line.text),
        },
      });
    },
  );
  let exited = false;
  child.once('close', () => {
    // attachGatewayOutputStreams 先注册 close，故此处读到的是 flush 之后的最终统计。
    getDebugLogger().info({
      domain: 'gateway',
      event: 'runtime.gateway.output.closed',
      data: { ...output.stats() },
    });
  });
  child.once('exit', () => {
    exited = true;
  });
  return {
    pid: child.pid,
    onExit: (listener) => {
      if (exited) listener();
      else child.once('exit', listener);
    },
    kill: () => {
      try {
        child.kill();
      } catch {
        /* 已经死了 */
      }
    },
  };
}

const realSpawn: GatewaySpawnFn = ({ nodeExe, args, cwd, env, secrets }) =>
  toGatewayChild(nodeSpawn(nodeExe, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }), secrets);

export interface EnsureGatewayRunningOptions {
  nodeExe: string;
  /** 部署后的 OpenClaw CLI（`openclaw.mjs`）绝对路径。 */
  cliPath: string;
  /** **本机部署目录**（不是 U 盘）—— 运行期动态 import 靠它，拔盘也不能崩。 */
  deployedRoot: string;
  stateDir: string;
  token: string;
  port: number;
  clientVersion?: string;
  identityPath?: string;
  probe?: (port: number) => Promise<StartupzProbe>;
  authenticate?: (opts: { port: number; token: string }) => Promise<boolean>;
  spawn?: GatewaySpawnFn;
  waitReady?: (child: GatewayChildProcess) => Promise<void>;
}

export interface EnsureGatewayRunningResult {
  ownership: 'spawned' | 'reused';
  /** 只有 `spawned` 才有 pid —— 退出时也**只有这种**才允许我们去停它。 */
  pid?: number;
  child?: GatewayChildProcess;
  decision: ExistingGatewayDecision;
}

/**
 * 给随包 Gateway 的环境变量。
 *
 * 便携版会在同事/客户电脑上运行。真实现场里宿主的 `DEEPSEEK_API_KEY` /
 * `DASHSCOPE_API_KEY` 被 OpenClaw 当成“已配置外置插件”，于是自动调用 npm；随包
 * 运行时刻意不带 npm，网关直接以 `spawn npm.cmd ENOENT` 退出。
 *
 * 这里按随包 OpenClaw 2026.9.3 的官方 external provider/web/channel catalog 精确摘掉
 * **会触发外置插件安装**的环境入口。不能用 `*_TOKEN|*_SECRET` 这类广义正则：那会
 * 误删 GitHub/AWS/用户工具凭证和随包 `CLAWROUTER_API_KEY`，悄悄改变产品能力。
 * 普通 PATH、代理、企业证书等全部保留；外部 OPENCLAW_* 控制项与 NODE_OPTIONS/
 * NODE_PATH 仍统一清掉，再只写回我们自己拥有的两个 OPENCLAW_* 值。
 */
const EXTERNAL_PLUGIN_ENV_KEYS = new Set([
  'AI_GATEWAY_API_KEY',
  'ARCEEAI_API_KEY',
  'BASETEN_API_KEY',
  'BRAVE_API_KEY',
  'BYTEPLUS_API_KEY',
  'CEREBRAS_API_KEY',
  'CHUTES_API_KEY',
  'CHUTES_OAUTH_TOKEN',
  'CLOUDFLARE_AI_GATEWAY_API_KEY',
  'COMFY_API_KEY',
  'COMFY_CLOUD_API_KEY',
  'DASHSCOPE_API_KEY',
  'DEEPINFRA_API_KEY',
  'DEEPSEEK_API_KEY',
  'EXA_API_KEY',
  'FEATHERLESS_API_KEY',
  'FIRECRAWL_API_KEY',
  'FIREWORKS_API_KEY',
  'GOOGLE_CHAT_SERVICE_ACCOUNT',
  'GOOGLE_CHAT_SERVICE_ACCOUNT_FILE',
  'GROQ_API_KEY',
  'KILOCODE_API_KEY',
  'KIMI_API_KEY',
  'KIMICODE_API_KEY',
  'LONGCAT_API_KEY',
  'MISTRAL_API_KEY',
  'MODELSTUDIO_API_KEY',
  'MODEL_API_KEY',
  'MOONSHOT_API_KEY',
  'NOVITA_API_KEY',
  'OPENCODE_API_KEY',
  'OPENCODE_ZEN_API_KEY',
  'OPENROUTER_API_KEY',
  'PARALLEL_API_KEY',
  'PERPLEXITY_API_KEY',
  'QIANFAN_API_KEY',
  'QWEN_API_KEY',
  'QWEN_TOKEN_PLAN_API_KEY',
  'SEARXNG_BASE_URL',
  'STEPFUN_API_KEY',
  'SYNTHETIC_API_KEY',
  'TAVILY_API_KEY',
  'TOKENHUB_API_KEY',
  'TOKENPLAN_API_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_MESSAGING_SERVICE_SID',
  'TWILIO_PHONE_NUMBER',
  'TWILIO_SMS_FROM',
  'VENICE_API_KEY',
  'VOLCANO_ENGINE_API_KEY',
  'VOYAGE_API_KEY',
  'VYDRA_API_KEY',
  'XIAOMI_API_KEY',
  'XIAOMI_TOKEN_PLAN_API_KEY',
  'ZCA_PROFILE',
  'Z_AI_API_KEY',
  'ZAI_API_KEY',
]);

const EXTERNAL_CHANNEL_ENV_PREFIXES = [
  'BUZZ_',
  'CLICKCLACK_',
  'DISCORD_',
  'FEISHU_',
  'GOOGLECHAT_',
  'IMESSAGE_',
  'IRC_',
  'LINE_',
  'MATRIX_',
  'MATTERMOST_',
  'MSTEAMS_',
  'NEXTCLOUD_TALK_',
  'NOSTR_',
  'OPENCLAW_WEIXIN_',
  'OPENCLAW_ZALOCLAWBOT_',
  'QQBOT_',
  'RAFT_',
  'SIGNAL_',
  'SLACK_',
  'SMS_',
  'SYNOLOGY_CHAT_',
  'TLON_',
  'TWITCH_',
  'WECOM_',
  'WHATSAPP_',
  'YUANBAO_',
  'ZALO_',
  'ZALOUSER_',
] as const;

function triggersExternalPluginInstall(upperKey: string): boolean {
  return (
    EXTERNAL_PLUGIN_ENV_KEYS.has(upperKey) ||
    EXTERNAL_CHANNEL_ENV_PREFIXES.some((prefix) => upperKey.startsWith(prefix))
  );
}

export function buildGatewayEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  stateDir: string,
  nodeExe?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (upper.startsWith('OPENCLAW_') || upper === 'NODE_OPTIONS' || upper === 'NODE_PATH') continue;
    if (triggersExternalPluginInstall(upper)) continue;
    env[key] = value;
  }

  const childEnv = inheritWindowsSystemProxy(env);
  if (nodeExe) {
    const pathKeys = Object.keys(childEnv).filter((key) =>
      process.platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH',
    );
    const inheritedPath = pathKeys
      .map((key) => childEnv[key])
      .filter(Boolean)
      .join(delimiter);
    for (const key of pathKeys) delete childEnv[key];
    childEnv.PATH = [dirname(nodeExe), inheritedPath].filter(Boolean).join(delimiter);
  }
  childEnv.OPENCLAW_STATE_DIR = stateDir;
  childEnv.OPENCLAW_SUPERVISOR_MODE = 'external';
  return childEnv;
}

/**
 * 确保端口上跑着**我们的**网关。返回 `ownership` 决定退出时该怎么收尾。
 *
 * ⚠️ 判定在 spawn **之前**，而且判定为 foreign 时**直接抛错**：
 * 这一层不允许"先试一下不行再说"。
 */
export async function ensureGatewayRunning(opts: EnsureGatewayRunningOptions): Promise<EnsureGatewayRunningResult> {
  const {
    port,
    token,
    probe = (p) => probeStartupz({ port: p }),
    spawn = realSpawn,
    clientVersion = '0.0.0',
    identityPath = '',
  } = opts;

  // ⚠️ 默认认证探测**必须**有设备身份文件。少了它认证必然失败，
  //    于是我们自己的网关会被判成 foreign、拒绝复用 —— 那是个**配置错误**，
  //    要当场炸掉，而不是伪装成"端口被占"让人去查错方向。
  if (!opts.authenticate && !identityPath) {
    throw new Error(
      'ensureGatewayRunning：需要 identityPath（默认认证探测靠设备身份；缺了会把我们自己的网关误判成 foreign）',
    );
  }

  const authenticate =
    opts.authenticate ??
    ((o: { port: number; token: string }) => probeGatewayAuth({ ...o, clientVersion, identityPath }));

  const startupz = await probe(port);

  let authenticated = false;
  if (startupz.reachable && startupz.status === 'started') {
    try {
      authenticated = await authenticate({ port, token });
    } catch (err) {
      // 认证探测本身失败 ⇒ 当成认证没过（保守：宁可报端口被占，也不要误 kill）
      console.error('[runtime] 网关认证探测失败，按"不是我们的"处理:', err);
      authenticated = false;
    }
  }

  const decision = classifyExistingGateway({ reachable: startupz.reachable, status: startupz.status, authenticated });

  if (decision.verdict === 'reuse') {
    return { ownership: 'reused', decision };
  }

  if (decision.verdict === 'foreign') {
    throw new GatewayPortOccupiedError(
      `端口 ${port} 被另一个 OpenClaw 网关占用：${decision.reason}。` +
        '为避免破坏它，装载器不会强制启动、也不会结束它 —— 请先停掉那个网关，或改用其它端口。',
    );
  }

  const args = buildGatewayArgs({ cliPath: opts.cliPath, port });
  const env = buildGatewayEnvironment(process.env, opts.stateDir, opts.nodeExe);

  const child = spawn({ nodeExe: opts.nodeExe, args, cwd: opts.deployedRoot, env, secrets: [token] });
  await (
    opts.waitReady ??
    defaultWaitReady(
      child,
      () => probe(port),
      () => authenticate({ port, token }),
    )
  )(child);

  return { ownership: 'spawned', pid: child.pid, child, decision };
}

/**
 * 真等就绪：500ms 一探、总超时 180s、子进程一退立刻中止。
 *
 * ⚠️ 这里**复用外面那个 `probe` 与 `authenticate`**（而不是另起一套真 fetch）：
 * 同一件事用两套探测函数会出现"preflight 说 DOWN、readiness 说 started"这种
 * 自相矛盾的状态。
 */
function defaultWaitReady(
  child: GatewayChildProcess,
  probeOnce: () => Promise<StartupzProbe>,
  authenticateOnce: () => Promise<boolean>,
): (c: GatewayChildProcess) => Promise<void> {
  let exited = false;
  child.onExit(() => {
    exited = true;
  });
  return () =>
    waitForGatewayReady({
      probe: probeOnce,
      authenticate: authenticateOnce,
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      hasExited: () => exited,
    }).then(() => undefined);
}

// ---------------------------------------------------------------- 收尾

export interface StopGatewayOptions {
  nodeExe: string;
  cliPath: string;
  deployedRoot: string;
  stateDir: string;
  child?: GatewayChildProcess | null;
  runCommand?: (exe: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }) => void;
  taskkill?: (pid: number) => void;
  gracefulTimeoutMs?: number;
  forceTimeoutMs?: number;
}

/**
 * 停掉**我们 spawn 的**网关。
 *
 * 三步，加起来不超过 5s（`before-quit` 不能卡住退出）：
 *   ① `gateway stop --force`（≤3s）—— 让它自己收尾
 *   ② `child.kill()`
 *   ③ `taskkill /PID <pid> /T /F` 兜底 —— Windows 上 SIGTERM **不跑 JS handler**，
 *      硬杀在这里是可接受的
 *
 * ⚠️ **调用方必须先确认 ownership === 'spawned'**（见 `stopGatewayIfOwned`）。
 */
export async function stopGateway(opts: StopGatewayOptions): Promise<void> {
  const { nodeExe, cliPath, deployedRoot, stateDir, child, gracefulTimeoutMs = 3000, forceTimeoutMs = 2000 } = opts;

  const runCommand =
    opts.runCommand ??
    ((exe: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }) => {
      execFileSync(exe, args, { cwd: o.cwd, env: o.env, timeout: o.timeout, windowsHide: true, stdio: 'ignore' });
    });

  try {
    runCommand(nodeExe, [cliPath, 'gateway', 'stop', '--force'], {
      cwd: deployedRoot,
      env: buildGatewayEnvironment(process.env, stateDir, nodeExe),
      timeout: gracefulTimeoutMs,
    });
  } catch (err) {
    console.error('[runtime] gateway stop 失败（继续硬杀）:', err);
  }

  child?.kill();

  const pid = child?.pid;
  if (pid === undefined) return;

  const taskkill =
    opts.taskkill ??
    ((p: number) =>
      execFileSync('taskkill', ['/PID', String(p), '/T', '/F'], {
        timeout: forceTimeoutMs,
        windowsHide: true,
        stdio: 'ignore',
      }));
  try {
    taskkill(pid);
  } catch (err) {
    // 进程已经没了是常态（上面 kill 成功了）—— 不是错误
    console.error('[runtime] taskkill 兜底未成功（进程可能已退出）:', err);
  }
}

/**
 * 退出时的收尾决策 —— **硬要求**。
 *
 * ⚠️ 只有 `spawned` 才允许停。`reused` 意味着网关在客户端启动**之前**就存在
 * （用户自己的、或上一次留下的），**绝不能因为用户关掉客户端就把它带走**。
 *
 * 抽成独立函数是为了让这条规则可以被单测直接钉住，而不是埋在 `before-quit` 里。
 */
export async function stopGatewayIfOwned(opts: {
  ownership: 'spawned' | 'reused' | null | undefined;
  stop: () => Promise<void>;
}): Promise<boolean> {
  if (opts.ownership !== 'spawned') return false;
  await opts.stop();
  return true;
}
