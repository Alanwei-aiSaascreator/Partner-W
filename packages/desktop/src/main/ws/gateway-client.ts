import WebSocket, { type ClientOptions } from 'ws';
import { app } from 'electron';
import { randomUUID } from 'crypto';
import {
  GATEWAY_WS_PORT,
  HEARTBEAT_INTERVAL_MS,
  RECONNECT_DELAY_MS,
  MAX_RECONNECT_ATTEMPTS,
  gatewayFailureReasonFrom,
  parseTaskIdFromSessionKey,
  summarizePayload,
} from '@clawwork/shared';
import type {
  GatewayFrame,
  GatewayReqFrame,
  GatewayResFrame,
  GatewayConnectParams,
  GatewayClientConfig,
  GatewayAuth,
  ChatAttachment,
} from '@clawwork/shared';
import { sendToWindow } from './window-utils.js';
import { createAdvertisedSurface, helloFeatureLogData, parseHelloFeatures } from './hello-features.js';
import { getMainWindow } from '../window-manager.js';
import {
  loadOrCreateDeviceIdentity,
  buildDeviceConnectPayload,
  saveDeviceToken,
  loadDeviceToken,
  type DeviceIdentity,
} from './device-identity.js';
import { getDebugLogger } from '../debug/index.js';
import { LOCAL_GATEWAY_ID } from '../runtime/state-config.js';
import {
  noteGatewayTurnLifecycle,
  reconcileGatewayTurnSessions,
  releaseGatewayTurnSessions,
  retryPendingGatewayTurnStops,
} from '../artifact/turn-lifecycle.js';
import { ensureGatewayWindowsSystemTrust } from './tls-trust.js';
import { convergeLateLocalRuntimeReady, getRuntimeBootstrapStatus } from '../runtime/bootstrap-status.js';
import { probeStartupz } from '../runtime/gateway-process.js';

/**
 * 本机运行时网关的地址面：规范 loopback + 18789。
 *
 * ⚠️ 只认这几样，不做任何"看起来像本机"的宽判：晚就绪收敛只对**我们自己那个**
 *    本地运行时成立，远端网关的连接成功绝不能去改"本机运行时起没起来"的快照。
 */
const LOCAL_RUNTIME_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
function isLocalRuntimeUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'ws:' && LOCAL_RUNTIME_HOSTS.has(url.hostname) && url.port === String(GATEWAY_WS_PORT);
  } catch {
    return false;
  }
}

const WS_CLOSE_POLICY_VIOLATION = 1008;
/**
 * `message too big`（RFC 6455）：某一帧超过网关的单帧上限（`policy.maxPayload`）时
 * 网关会以此码**主动断开连接**。
 *
 * ⚠️ 与 1008 的区别是**必须区分**的（2026-10-07 质量战役区 2 · P1-1）：
 *    1008 = "服务端明确拒绝我们" ⇒ 刻意不重连；1009 = "这一帧太大" ⇒ 照常重连，
 *    但失败原因必须能说清"是这次发的内容太大"，不能混进"网络断了/正在重连"。
 *    这句消息会一路走到发送失败的系统消息（`translateGatewayError` 翻成人话）。
 */
const WS_CLOSE_MESSAGE_TOO_BIG = 1009;
/** 1009 的**可识别**失败消息（进出两侧同一份：状态事件 + 在途请求拒绝）。 */
const GATEWAY_MESSAGE_TOO_BIG_ERROR = 'message too large for gateway frame limit (close code 1009)';
const WS_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * 连上之后**等 `connect.challenge`** 的上限。
 *
 * 这段等待过去**没有任何计时器**：`ws.on('open')` 只记一条日志 `Waiting for connect challenge`，
 * 而那条 15 秒请求超时只有**收到 challenge、发出 `connect`** 之后才开始跑
 * ⇒ 网关事件循环卡死时（T-a8 那种：端口在听、TCP 能连、RPC 全超时）客户端**静默挂**在这一段：
 * 界面状态一直是 `undefined`，**连横幅都不会出现**，用户比"正在尝试重连"更没得判断。
 *
 * 取 15 秒 = 与 RPC 请求超时同一个数（客户端对"网关多久算没反应"只留一个口径）。
 */
const CHALLENGE_WAIT_TIMEOUT_MS = 15_000;

/**
 * 我们自己造的**传输层**失败码（不是网关说的）。
 *
 * ⚠️ 用途只有一个：区分「网关明确拒绝」（认证 / 配对 / 协议）与「这次连接本身没成」。
 * 见 `isGatewayRejection`。
 */
const CLIENT_TRANSPORT_FAILURE_CODES = new Set([
  'TIMEOUT',
  'SEND_FAILED',
  'GATEWAY_NOT_CONNECTED',
  'GATEWAY_CONNECTION_CLOSED',
]);

type HandshakeFailure = Error & { code?: string; details?: Record<string, unknown> };

type GatewayRequestFailure = Error & { code?: string };

function isUnsafeWorkspacePostWriteFailure(error: unknown, name: string): error is GatewayRequestFailure {
  return (
    error instanceof Error &&
    (error as GatewayRequestFailure).code === 'INVALID_REQUEST' &&
    error.message === `unsafe workspace file "${name}"`
  );
}

function isVerifiedAgentFileWrite(
  payload: Record<string, unknown>,
  agentId: string,
  name: string,
  content: string,
): boolean {
  if (payload['agentId'] !== agentId) return false;
  const file = payload['file'];
  if (typeof file !== 'object' || file === null || Array.isArray(file)) return false;
  const record = file as Record<string, unknown>;
  return record['name'] === name && record['missing'] === false && record['content'] === content;
}

const MAX_AGENT_NAME_CONFIG_RETRIES = 3;
const AGENT_VISIBILITY_BACKOFF_MS = [100, 200, 400, 800, 1_000, 1_000, 1_500, 1_500, 2_000] as const;
const AGENT_VISIBILITY_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAgentListed(payload: unknown, agentId: string): boolean {
  if (!isRecord(payload) || !Array.isArray(payload['agents'])) return false;
  return payload['agents'].some((agent) => isRecord(agent) && agent['id'] === agentId);
}

function isVerifiedAgentIdentityName(payload: Record<string, unknown>, agentId: string, expectedName: string): boolean {
  if (payload['agentId'] !== agentId) return false;
  const file = payload['file'];
  if (!isRecord(file) || file['name'] !== 'IDENTITY.md' || file['missing'] !== false) return false;
  if (typeof file['content'] !== 'string') return false;

  const nameLine = file['content']
    .split(/\r?\n/u)
    .map((line) => /^\s*-\s*Name:\s*(.*?)\s*$/iu.exec(line)?.[1])
    .find((name): name is string => typeof name === 'string');
  return nameLine === expectedName;
}

function readAgentConfigEntry(snapshot: unknown, agentId: string): Record<string, unknown> | null {
  if (!isRecord(snapshot) || !isRecord(snapshot['config'])) return null;
  const agents = snapshot['config']['agents'];
  if (!isRecord(agents) || !isRecord(agents['entries'])) return null;
  const entry = agents['entries'][agentId];
  return isRecord(entry) ? entry : null;
}

function isAgentNameConfigApplied(snapshot: unknown, agentId: string, expectedName: string): boolean {
  const entry = readAgentConfigEntry(snapshot, agentId);
  return entry?.['name'] === expectedName && isRecord(entry['identity']) && entry['identity']['name'] === expectedName;
}

function configHashOf(snapshot: unknown): string | null {
  if (!isRecord(snapshot)) return null;
  return typeof snapshot['hash'] === 'string' && snapshot['hash'] ? snapshot['hash'] : null;
}

function isConfigHashConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as GatewayRequestFailure).code === 'INVALID_REQUEST' &&
    /config changed since last load|base hash|re-run config\.get and retry/iu.test(error.message)
  );
}

/**
 * 这次握手失败，是**网关明确拒绝**，还是**这次连接本身没成**？只有前者该停止重连。
 *
 * 停止重连是 `d1abc55e` 的意图（"pairing required, auth denied" 就别再敲了）——那是对的。
 * 但"这次连接没成"必须照常重连：网关预热慢（首次部署要分钟级）、或事件循环卡一下
 * （T-a8：端口在听、连接能建、RPC 全超时）都会让**第一次** `connect` 请求 15 秒超时；
 * 把它当成"服务端拒绝"的代价是客户端**永久**停在"连不上"，用户只能重启应用
 * （2026-09-20 现场截图：横幅一直「正在尝试重连… (0/10)」+「离线模式 — 只读」
 * + 准备面板「准备时间比平时更久」）。
 */
function isGatewayRejection(err: HandshakeFailure): boolean {
  // `details` 只有 `handleResponse` 会填 ⇒ 它非空就说明网关真的回了一个 `res.error`
  // （`PAIRING_REQUIRED` 就是放在 `details.code` 里的形状）。
  if (err.details && typeof err.details['code'] === 'string') return true;
  if (typeof err.code !== 'string') return false; // 连码都没有 ⇒ 我们这边的异常，按可重试算
  return !CLIENT_TRANSPORT_FAILURE_CODES.has(err.code);
}

type GatewayClientOptions = {
  noReconnect?: boolean;
  onPairingSuccess?: (gatewayId: string) => void;
  /**
   * 审批专用连接（根因与理由见 `APPROVAL_CHANNEL_CAPS`）。
   *
   * 只为"能被网关推 exec 审批"而存在：走完整握手、心跳与重连，但**不订阅会话事件、
   * 不报界面连接状态** —— 那两件事是主连接的职责，重复做的后果是每条会话事件翻倍、
   * 以及两条连接在界面上互相覆盖连接状态。
   */
  approvalChannel?: boolean;
};

export interface GatewayConfigMutationTx {
  getConfig: () => Promise<Record<string, unknown>>;
  setConfig: (params: { raw: string; baseHash?: string }) => Promise<Record<string, unknown>>;
  patchConfig: (params: {
    raw: string;
    baseHash?: string;
    replacePaths?: string[];
    sessionKey?: string;
    note?: string;
    restartDelayMs?: number;
  }) => Promise<Record<string, unknown>>;
}

type PendingReq = {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
  startedAt: number;
  requestId: string;
  sessionKey?: string;
  taskId?: string;
};

const REQ_TIMEOUT_MS = 15_000;
const MAX_REQ_TIMEOUT_MS = 60_000;
const SKILL_UPDATE_TIMEOUT_MS = 60_000;
const MAX_RECONNECT_BACKOFF_EXPONENT = 5;

export function calculateReconnectDelay(attempt: number): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), MAX_RECONNECT_BACKOFF_EXPONENT);
  return RECONNECT_DELAY_MS * Math.pow(2, exponent);
}

function isSecureGatewayWebSocketUrl(raw: string): boolean {
  try {
    const protocol = new URL(raw.trim()).protocol;
    return protocol === 'wss:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 审批专用连接的 `caps` —— exec 审批**永远送不到用户面前**的修法。
 *
 * ## 现场（2026-09-27，用户真机的 `operator_approvals` 表）
 *
 * 助手跑 `node -e "...createServer(...).listen(8080)"` 想在本机起个服务给用户看刚
 * 生成的 HTML，审批在 **17 毫秒**后就被判死 —— `terminal_reason="no-route"`、
 * `resolver_id="no-approval-route"`，用户**来不及看见任何弹窗**，于是读成"工具调用失败"。
 * 同一天三次全是这个死法。
 *
 * ## 判死条件（运行时源码，不是推断）
 *
 * ```js
 * // ① 一条能收的连接都没有 ⇒ 直接 expire
 * hasExecApprovalClients: (excludeConnId) => {
 *   for (const gatewayClient of clients) {
 *     if (excludeConnId && gatewayClient.connId === excludeConnId) continue;  // ★ 跳过请求者
 *     if (canDeliverApprovals(gatewayClient, "exec")) return true;
 *   }
 * // ② 单条连接要满足 scope + 四选一
 * canDeliverApprovals = (scopes ∋ operator.admin|operator.approvals)
 *   && (internal.approvalRuntime || id ∈ {CONTROL_UI} || caps ∋ approvals
 *       || (exec && (id ∈ EXEC_APPROVAL_CLIENT_IDS || caps ∋ exec-approvals)))
 * ```
 *
 * 我们发的是 `id='gateway-client'`、`caps=['tool-events']` ⇒ scope 那条**够**
 * （`operator.approvals` 早在 scopes 里），**四选一全不满足** ⇒ 没有任何一条连接能收
 * ⇒ 每条 exec 审批秒死。
 *
 * ## ⚠️ 两个字段别搞混（第一版就在这里读错了）
 *
 * | 字段 | 谁在用 | 含义 |
 * | --- | --- | --- |
 * | **`connId`** | `hasExecApprovalClients(excludeConnId)` 的排除 | **每条 WS 连接独有** |
 * | `client.id` | `canDeliverApprovals` 的四选一 | 客户端自报的身份 |
 *
 * `excludeConnId` 把**发起请求的那条连接**跳过了（网关刻意不问"提问者本人"），
 * 所以给主连接补 cap 没用 —— 必须**另开一条**。但既然比的是 `connId`，
 * 第二条**保持同一个 `client.id`** 就够了，**不该**换 id：配对记录里存着
 * `device.clientId`，换掉有配对失配风险而收益为零。
 * 网关也不会踢掉第二条：`server-ws-runtime-*.mjs` 里唯一的"踢旧"是
 * `existing.worker?.environmentId === next.worker.environmentId`，只针对 worker。
 *
 * ## 为什么"恰好"只有这一项
 *
 * 刻意**不**加通用 `approvals` cap —— 那会让 `plugin.approval.*` / `openclaw.approval.*`
 * 也变成可投递，而那两个家族我们**没接线**（收到只会被丢掉）。那是另一刀的事。
 */
export const APPROVAL_CHANNEL_CAPS: readonly string[] = ['exec-approvals'];

/**
 * 审批连接**只**把这几个事件转发给渲染器。
 *
 * ⚠️ **不能转发全部**：`tick` / `health` / `presence` / `node.*` / `talk.*` 这类是
 *    **广播**事件，两条连接都会收到 ⇒ 渲染器每条都会看到两遍。
 *    这条连接存在的唯一理由是收 `exec.approval.*`（主连接因为"请求者被排除"收不到），
 *    那就只转发这一族。
 *
 * ⚠️ 将来网关新增审批族（`plugin.approval.*` / `openclaw.approval.*`）时，**要显式加进来**：
 *    没加 = 静默丢掉（本项目在 `lifecycle`/`item.status` 上已经栽过三次同样形状的坑）。
 *    那两个族目前**没接线**，加了 cap 也不投递（见 `APPROVAL_CHANNEL_CAPS`）。
 */
const APPROVAL_CHANNEL_EVENTS = new Set(['exec.approval.requested', 'exec.approval.resolved']);

export class GatewayClient {
  private ws: WebSocket | null = null;
  private authenticated = false;
  private reconnectAttempts = 0;
  /** BUG-064 D：本机运行时已判定失败 ⇒ 自动重连被抑制（显式 reconnect 不受影响）。 */
  private runtimeDownSuppressed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private challengeTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pendingRequests = new Map<string, PendingReq>();
  private destroyed = false;
  private noReconnect = false;
  private wsUrl: string;
  private auth: GatewayAuth;
  private tlsVerify: boolean;
  private gatewayId: string;
  private gatewayName: string;
  private connectNonce: string | null = null;
  private deviceIdentity: DeviceIdentity;
  private lastError: string | null = null;
  private lastErrorCode: string | null = null;
  private serverVersion: string | undefined;
  /** 最近一次 close 的 WS 关闭码（1008/1009 等语义见 `handleClose`；cleanup 里用来给在途请求一个可识别的失败原因）。 */
  private lastCloseCode: number | undefined;
  /**
   * 网关**协商下来**的单帧字节上限（`hello-ok.policy.maxPayload`，2026-10-07 在随包运行时
   * dist 实读确认该字段每次握手必发）。渲染层的发送字节预算读它（经 gateway-status →
   * ui-store），拿不到时回落默认值 —— 客户端原来把 25MB 硬编码三处、从不读这个值
   * （质量战役区 2 · P1-1）。
   */
  private maxPayloadBytes: number | undefined;
  /**
   * 网关自报的方法表（`hello-ok.features.methods`）。
   *
   * ⚠️ **只用于诊断**：`sendReq` 里查一下"这个方法广告过吗"，没广告过就记一条
   *    （每个方法只记一次）。**不拦请求**——拦了就是行为变更，那是另一刀的事。
   */
  private readonly advertisedSurface = createAdvertisedSurface();
  private onPairingSuccess?: (gatewayId: string) => void;
  /**
   * OpenClaw 的 config.get/config.patch 与 agents.create/update/delete 共用一份配置。
   * 把整段事务接到同一条尾链，避免冷启时 relay 和预置助手互相打掉 baseHash。
   */
  private configMutationTail: Promise<void> = Promise.resolve();
  /** 见 `APPROVAL_CHANNEL_CAPS`：这条连接只为了能被推 exec 审批。 */
  private approvalChannel = false;
  /**
   * ⭐ V2（2026-10-13 step 2）：本**连接实例**的传输纪元 —— 主/审批连接各自生成一次，
   * 随每帧 `meta` 送往下游（renderer 不得猜 channel/epoch；重连 = 新实例 = 新纪元）。
   */
  private readonly connectionEpoch: string = randomUUID();

  constructor(config: GatewayClientConfig, opts?: GatewayClientOptions) {
    this.gatewayId = config.id;
    this.gatewayName = config.name;
    this.wsUrl = config.url;
    this.auth = config.auth;
    this.tlsVerify = config.tlsVerify !== false;
    this.deviceIdentity = loadOrCreateDeviceIdentity();
    if (opts?.noReconnect) this.noReconnect = true;
    this.onPairingSuccess = opts?.onPairingSuccess;
    this.approvalChannel = opts?.approvalChannel === true;
  }

  get id(): string {
    return this.gatewayId;
  }

  get name(): string {
    return this.gatewayName;
  }

  updateConfig(config: Partial<GatewayClientConfig>): void {
    if (config.id !== undefined) this.gatewayId = config.id;
    if (config.name !== undefined) this.gatewayName = config.name;
    if (config.url !== undefined) this.wsUrl = config.url;
    if (config.auth !== undefined) this.auth = config.auth;
    if (config.tlsVerify !== undefined) this.tlsVerify = config.tlsVerify !== false;
    this.reconnectAttempts = 0;
    this.connect();
  }

  runConfigMutation<T>(work: (tx: GatewayConfigMutationTx) => Promise<T>): Promise<T> {
    const tx: GatewayConfigMutationTx = {
      getConfig: () => this.sendReq('config.get', {}),
      setConfig: (params) => this.sendReq('config.set', params),
      patchConfig: (params) => this.sendReq('config.patch', params),
    };
    const operation = this.configMutationTail.then(() => work(tx));
    // 失败只属于本次调用；队列尾必须恢复为 fulfilled，否则后续写会永久被毒死。
    this.configMutationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  connect(): void {
    if (this.destroyed) return;
    ensureGatewayWindowsSystemTrust(app.getPath('userData'));
    this.cleanup();
    this.lastError = null;

    getDebugLogger().info({
      domain: 'gateway',
      event: 'gateway.connect.start',
      gatewayId: this.gatewayId,
      attempt: this.reconnectAttempts + 1,
      data: { wsUrl: this.wsUrl },
    });
    const wsOptions: ClientOptions = { handshakeTimeout: WS_HANDSHAKE_TIMEOUT_MS };
    if (isSecureGatewayWebSocketUrl(this.wsUrl) && !this.tlsVerify) {
      wsOptions.rejectUnauthorized = false;
    }
    this.ws = new WebSocket(this.wsUrl, wsOptions);

    this.ws.on('open', () => {
      getDebugLogger().info({
        domain: 'gateway',
        event: 'gateway.ws.open',
        gatewayId: this.gatewayId,
        message: 'Waiting for connect challenge',
      });
      // ⭐ 从这里开始**必须有人喊**：网关不发 challenge 时以前是静默挂住（见常量上的注释）
      this.startChallengeTimer();
    });

    this.ws.on('message', (raw) => {
      this.handleRaw(raw.toString());
    });

    this.ws.on('close', (code, reason) => {
      const reasonStr = reason.toString();
      this.lastCloseCode = code;
      // ⭐ 1009（message too big）：帧超过网关单帧上限时网关主动断连。这条**不是**
      //    "服务端拒绝我们"（区别于 1008：不改变重连语义），但失败原因必须可识别 ——
      //    原来只认 1008，1009 落进"普通断线"，用户只看到"连接断开、正在重连"，
      //    完全看不出是"这次发的内容太大"（质量战役区 2 · P1-1）。
      //    ① 状态事件带上可识别 error（见常量注释）；② cleanup() 用它拒绝在途请求 ⇒
      //    发送失败的系统消息能经 `translateGatewayError` 说成人话。
      const messageTooBig = code === WS_CLOSE_MESSAGE_TOO_BIG;
      if (messageTooBig && !this.lastError) {
        this.lastError = GATEWAY_MESSAGE_TOO_BIG_ERROR;
      }
      const error =
        this.lastError ?? (code === WS_CLOSE_POLICY_VIOLATION ? reasonStr || 'policy violation' : undefined);
      getDebugLogger().warn({
        domain: 'gateway',
        event: messageTooBig ? 'gateway.ws.close.message-too-big' : 'gateway.ws.close',
        gatewayId: this.gatewayId,
        data: {
          code,
          reason: reasonStr,
          pendingRequests: this.pendingRequests.size,
        },
      });
      this.authenticated = false;
      this.serverVersion = undefined;
      this.maxPayloadBytes = undefined;
      this.cleanup();
      // ⭐ 1008 = 服务端明确拒绝，我们**刻意不重连**（`d1abc55e`）。那就必须把
      //    "不再自动重连"如实报出去：以前这里一律报 `gaveUp:false`，界面于是**永远**
      //    显示「正在尝试重连… (attempt/max)」（而且是 `(0/10)` —— 一次都没试过），
      //    用户看不出"其实已经放弃了"，界面上也**没有任何出路**（只有重启应用）。
      //    报 `gaveUp:true` 后横幅会换成收尾态：`立即重试` + `打开设置`。
      const rejected = code === WS_CLOSE_POLICY_VIOLATION;
      // ⭐ 光说"放弃了"不够：界面得说得出**是哪一类**拒绝 —— "网关不认我们"和
      //    "连不上"要用户做的事完全不同（前者去查凭据/配对，后者等一等就好）。
      //    ⚠️ 只在**有结论**时才给（`rejected`）：普通断线（1006 之类）还没有结论，
      //    给了就是猜。值走 `@clawwork/shared` 的**闭集** —— 上面那句 `error` 原文
      //    留在原地，它进日志，**不进**这个字段。
      const failureReason = rejected ? gatewayFailureReasonFrom({ closeCode: code }) : undefined;
      sendToWindow(getMainWindow(), 'gateway-status', {
        gatewayId: this.gatewayId,
        connected: false,
        error,
        reconnectAttempt: this.reconnectAttempts,
        maxAttempts: MAX_RECONNECT_ATTEMPTS,
        gaveUp: rejected,
        reason: failureReason,
      });
      if (rejected) return;
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      this.lastError = err.message;
      getDebugLogger().error({
        domain: 'gateway',
        event: 'gateway.ws.error',
        gatewayId: this.gatewayId,
        error: { name: err.name, message: err.message, stack: err.stack },
      });
      sendToWindow(getMainWindow(), 'gateway-status', {
        gatewayId: this.gatewayId,
        connected: false,
        error: err.message,
      });
    });
  }

  private handleRaw(raw: string): void {
    let frame: GatewayFrame;
    try {
      frame = JSON.parse(raw) as GatewayFrame;
    } catch {
      getDebugLogger().error({
        domain: 'gateway',
        event: 'gateway.frame.invalid-json',
        gatewayId: this.gatewayId,
        data: { raw },
      });
      return;
    }

    if (frame.type === 'event') {
      if (typeof frame.event !== 'string' || !frame.payload || typeof frame.payload !== 'object') {
        getDebugLogger().error({
          domain: 'gateway',
          event: 'gateway.frame.invalid-shape',
          gatewayId: this.gatewayId,
        });
        return;
      }
      getDebugLogger().debug({
        domain: 'gateway',
        event: 'gateway.event.received',
        gatewayId: this.gatewayId,
        seq: frame.seq,
        data: {
          name: frame.event,
          payload: summarizePayload(frame.payload),
        },
      });
      this.handleEvent(frame as { event: string; payload: Record<string, unknown>; seq?: number });
      return;
    }

    if (frame.type === 'res') {
      this.handleResponse(frame);
      return;
    }
  }

  private handleEvent(frame: { event: string; payload: Record<string, unknown>; seq?: number }): void {
    if (frame.event === 'connect.challenge') {
      // challenge 到了 ⇒ 等待结束（不取消的话它会在 15 秒时误报"没收到 challenge"）
      this.clearChallengeTimer();
      const nonce = frame.payload && typeof frame.payload.nonce === 'string' ? frame.payload.nonce.trim() : '';
      if (!nonce) {
        getDebugLogger().error({
          domain: 'gateway',
          event: 'gateway.challenge.invalid',
          gatewayId: this.gatewayId,
          data: { payload: summarizePayload(frame.payload) },
        });
        this.ws?.close(WS_CLOSE_POLICY_VIOLATION, 'connect challenge missing nonce');
        return;
      }
      this.connectNonce = nonce;
      getDebugLogger().info({
        domain: 'gateway',
        event: 'gateway.challenge.received',
        gatewayId: this.gatewayId,
        seq: frame.seq,
      });
      this.handleChallenge(nonce);
      return;
    }

    if (frame.event === 'tick') {
      getDebugLogger().debug({
        domain: 'gateway',
        event: 'gateway.tick.received',
        gatewayId: this.gatewayId,
        seq: frame.seq,
      });
      return;
    }

    const sessionKey = typeof frame.payload.sessionKey === 'string' ? frame.payload.sessionKey : undefined;
    const taskId = sessionKey ? (parseTaskIdFromSessionKey(sessionKey) ?? undefined) : undefined;
    getDebugLogger().debug({
      domain: 'gateway',
      event: `gateway.${frame.event.replace(/[^a-z0-9]+/gi, '.').toLowerCase()}`,
      gatewayId: this.gatewayId,
      sessionKey,
      taskId,
      seq: frame.seq,
      data: { payload: summarizePayload(frame.payload) },
    });

    // ⚠️ DOCX-205 合同（2026-10-10）B 块：主进程侧记录「一轮在跑」的真实生命周期
    //    （`agent` 流的 lifecycle 相位 + `chat` 的终态，与渲染层 processingBySession 同源；
    //    消费方 = `data-handlers.isArtifactTurnInFlight` 的普通发送单飞门）。
    //    - lifecycle.start → 这一轮在跑；
    //    - chat final / lifecycle.end → 有界宽限（终态消息几十毫秒内会 claim，
    //      bare final 这类无人 claim 的僵尸到点释放）；
    //    - chat error / aborted、lifecycle.error → 立即释放（这一轮不会再交付；
    //      自动重发只等 ~1.5 秒，宽限来不及）。
    //    审批连接只转发审批事件，不参与这个软状态（避免双份 start/end）。
    if (!this.approvalChannel && sessionKey) {
      // ⭐ B1：随帧带上归属网关 —— 这个网关被永久移除/失败终结时只释放**自己**的记录。
      // ⭐ P-R2-1（2026-10-14 第二轮）：终态路由**带原生 run 身份**（帧带才有）——
      //    turn-lifecycle 据此核对"这一帧说的是不是这张停止票据的 run"：
      //    本 run 明确 aborted ⇒ 票据收口 confirmed；普通 end/error ⇒ 只折
      //    cancel.unconfirmed{run-terminated}（"该 run 已结束"≠"已执行停止请求"）；
      //    身份对不上/缺失 ⇒ 一个事件都不发（不把别的 run 的终态算到本票据头上）。
      //    ⚠️ chat `aborted` 不再折成 'error'：两者对票据的语义不同（见上）。
      const nativeRunId = typeof frame.payload.runId === 'string' ? frame.payload.runId : undefined;
      if (frame.event === 'agent' && frame.payload.stream === 'lifecycle') {
        const phase = (frame.payload.data as { phase?: unknown } | undefined)?.phase;
        if (phase === 'start' || phase === 'end' || phase === 'error') {
          noteGatewayTurnLifecycle(phase, sessionKey, this.gatewayId, nativeRunId);
        }
      } else if (frame.event === 'chat') {
        const state = frame.payload.state;
        if (state === 'aborted') noteGatewayTurnLifecycle('aborted', sessionKey, this.gatewayId, nativeRunId);
        else if (state === 'error') noteGatewayTurnLifecycle('error', sessionKey, this.gatewayId, nativeRunId);
        else if (state === 'final') noteGatewayTurnLifecycle('end', sessionKey, this.gatewayId, nativeRunId);
      }
    }

    // ⚠️ 审批连接**只**转发审批事件：其余多是广播事件（tick/health/presence/node.*），
    //    主连接也在收 —— 转发它们等于让渲染器把每条都处理两遍。
    if (this.approvalChannel && !APPROVAL_CHANNEL_EVENTS.has(frame.event)) return;

    // ⚠️ 扫码自动批准（2026-10-22）：手机扫电脑端配对链接 → 连接 → 待批 →
    // 桌面端收到 device.pair.requested 自动批准，全程无需手动点批准。
    // 安全依据：v1 配对链接本来就带网关 token（持码即能连），批准只是登记设备身份，
    // 与二维码本身的安全级别一致；此分支只在桌面主连接（有 operator.pairing）执行。
    if (!this.approvalChannel && frame.event === 'device.pair.requested') {
      const requestId =
        typeof frame.payload.requestId === 'string'
          ? frame.payload.requestId
          : typeof frame.payload.id === 'string'
            ? frame.payload.id
            : null;
      if (requestId) {
        void this.sendReq('device.pair.approve', { requestId }, { requestId: randomUUID() })
          .then(() => {
            console.log(`[gateway-client] 扫码设备已自动批准: ${requestId.slice(0, 12)}…`);
          })
          .catch((err: unknown) => {
            console.warn('[gateway-client] 自动批准失败:', err instanceof Error ? err.message : err);
          });
      }
    }

    sendToWindow(getMainWindow(), 'gateway-event', {
      gatewayId: this.gatewayId,
      event: frame.event,
      payload: frame.payload,
      seq: frame.seq,
      // ⭐ V2（2026-10-13 step 2）：可信 transport 元数据在**真实连接拥有者**（主进程连接
      //    实例）生成：主/审批连接同 gatewayId 也各有 channel 与独立 epoch，重连即换新。
      meta: { channel: this.approvalChannel ? 'approval' : 'main', connectionEpoch: this.connectionEpoch },
    });
  }

  private buildAuthWithDeviceToken(): GatewayAuth {
    const storedToken = loadDeviceToken(this.gatewayId);
    if (storedToken) {
      return { ...this.auth, deviceToken: storedToken };
    }
    return this.auth;
  }

  /**
   * 主连接 hello-ok 之后的**晚就绪收敛**（2026-10-04 真机缺口，见调用点注释）。
   *
   * 边界（缺一不动）：
   *   - 当前快照必须是 ready-timeout（其它错误不是"再等等就好"，见 bootstrap-status）；
   *   - 必须是我们自己的本地运行时地址（规范 loopback + 18789）且非审批连接；
   *   - 必须还是**发这次握手的那个 socket**、这条连接没被销毁 —— 探测前后各查一次，
   *     旧连接或晚回包不允许改新快照；
   *   - 认证证据 = 这次 hello-ok 本身，不额外认证、不开第二条连接。
   *
   * 只做一次**短有界**的 /startupz 复核：不 spawn 第二个网关、不发模型调用。
   * 复核失败 ⇒ 保留原错误快照（宁可继续显示"还没起来"，也不猜）。
   */
  private async convergeLateLocalRuntimeOnHello(socket: WebSocket | null): Promise<void> {
    const snapshot = getRuntimeBootstrapStatus();
    if (!snapshot || snapshot.ok || snapshot.reason !== 'ready-timeout') return;
    if (this.approvalChannel || !isLocalRuntimeUrl(this.wsUrl)) return;
    if (this.destroyed || socket === null || this.ws !== socket) return;
    const probe = await probeStartupz({ port: GATEWAY_WS_PORT, timeoutMs: 2_000 });
    if (!probe.reachable || probe.status !== 'started') return;
    if (this.destroyed || this.ws !== socket) return;
    const converged = convergeLateLocalRuntimeReady();
    if (converged) sendToWindow(getMainWindow(), 'runtime-status', converged);
  }

  private handleChallenge(nonce: string): void {
    const signatureToken =
      'token' in this.auth ? this.auth.token : 'bootstrapToken' in this.auth ? this.auth.bootstrapToken : null;
    const scopes = ['operator.admin', 'operator.write', 'operator.read', 'operator.approvals', 'operator.pairing'];

    /**
     * ⭐ 防御（§二 P0，2026-09-29）：下面两步是**同步**的，而 `sendReq(...).catch()`
     * 只管**异步**失败 —— 同步抛出的异常会直接冲出 WS 消息处理器，成为
     * **主进程未捕获异常**（真机那次表现就是一个错误弹框，而且网关握手永远走不完）。
     *
     * 最常见的触发就是设备身份不可用（钥匙文件被换、换了 Windows 账户导致 DPAPI 解不开、
     * 公钥私钥张冠李戴）。`loadOrCreateDeviceIdentity` 现在会把这些挡在加载阶段，
     * 这里是**第二道**：身份文件在运行期被换掉、或将来别的原因让签名抛出来，
     * 也必须变成"这次连接没成"，而不是崩主进程。
     */
    let device: ReturnType<typeof buildDeviceConnectPayload>;
    let auth: GatewayAuth;
    try {
      device = buildDeviceConnectPayload(this.deviceIdentity, {
        clientId: 'gateway-client',
        clientMode: 'backend',
        role: 'operator',
        scopes,
        nonce,
        token: signatureToken,
        platform: process.platform,
        deviceFamily: null,
      });
      auth = this.buildAuthWithDeviceToken();
    } catch (err) {
      const error = err as Error & { code?: string };
      this.lastError = error.message;
      this.lastErrorCode = error.code ?? null;
      getDebugLogger().error({
        domain: 'gateway',
        event: 'gateway.connect.device-identity-unusable',
        gatewayId: this.gatewayId,
        requestId: 'connect-handshake',
        error: { name: error.name, message: error.message, stack: error.stack },
        data: {
          deviceId: this.deviceIdentity.deviceId,
          hint: '设备身份在本机不可用 ⇒ 握手没发出去。这一条不该出现（加载阶段已挡），出现即上报。',
        },
      });
      // 当作"这次连接没成"⇒ 走普通断线路径（背退重连），不下"服务端拒绝"的结论。
      this.ws?.close();
      return;
    }

    const params: GatewayConnectParams = {
      minProtocol: 3,
      maxProtocol: 4,
      client: {
        id: 'gateway-client',
        // 同一份身份（见 `APPROVAL_CHANNEL_CAPS` 那两行字段对照表：排除按 connId 走，
        // 换 id 没有收益、只有配对失配的风险）。后缀只为在网关的客户端列表里分得清。
        displayName: this.approvalChannel ? 'ClawWork Desktop (approvals)' : 'ClawWork Desktop',
        version: app.getVersion(),
        platform: process.platform,
        mode: 'backend',
      },
      caps: this.approvalChannel ? [...APPROVAL_CHANNEL_CAPS] : ['tool-events'],
      auth,
      role: 'operator',
      scopes,
      device,
    };

    // ⚠️ 记下**发这次握手的那个 socket**：晚就绪收敛只允许由它触发、也只在它仍是
    //    当前连接时才生效（旧连接/晚回包不许改新快照）。
    const connectSocket = this.ws;
    this.sendReq('connect', params as unknown as Record<string, unknown>, { requestId: 'connect-handshake' })
      .then((payload) => {
        const pType = payload['type'] as string | undefined;
        if (pType === 'hello-ok') {
          getDebugLogger().info({
            domain: 'gateway',
            event: 'gateway.connect.res.ok',
            gatewayId: this.gatewayId,
            requestId: 'connect-handshake',
            // ⭐ 网关**自报的能力面**（`HelloOkSchema.features`，契约里的必需字段）。
            //    接上它之前，整个 2026-09 的协议漂移都是事后读源码才发现的 ——
            //    而这份答案每次握手都送到我们手上。只记数量 + capabilities（见该模块说明）。
            data: helloFeatureLogData(payload),
          });
          // 把方法表喂给那个"调了没广告的方法吗"的诊断器（**只记日志，不拦请求**）。
          const advertised = parseHelloFeatures(payload);
          if (advertised) this.advertisedSurface.setAdvertised(advertised.methods);
          this.authenticated = true;
          this.reconnectAttempts = 0;
          this.lastError = null;
          this.lastErrorCode = null;
          const server = payload['server'] as Record<string, unknown> | undefined;
          const rawVersion = server?.['version'];
          this.serverVersion = typeof rawVersion === 'string' ? rawVersion : undefined;
          // ⭐ 单帧上限走**协商值**（`hello-ok.policy.maxPayload`，随包运行时实读确认必发）：
          //    发送侧字节预算由它推导（经 gateway-status → ui-store → useChatSend），
          //    拿不到时回落默认 25MiB。非法值（非正数/非有限数）一律当"没谈到"。
          const policy = payload['policy'] as Record<string, unknown> | undefined;
          const rawMaxPayload = policy?.['maxPayload'];
          this.maxPayloadBytes =
            typeof rawMaxPayload === 'number' && Number.isFinite(rawMaxPayload) && rawMaxPayload > 0
              ? rawMaxPayload
              : undefined;
          // ⚠️ 审批连接到此为止。三件事**都不能做**，每一件都有具体后果：
          //    ① 存设备令牌 —— 那是**主连接的身份**，两条一起写会互相覆盖（谁后写谁算）；
          //    ② 订阅会话 —— 每条会话事件会翻倍；
          //    ③ 报 `gateway-status` —— 两条连接会在界面上互相覆盖连接状态。
          //    它只要连着、并且被网关认成"能收 exec 审批"就够了。
          if (this.approvalChannel) {
            this.startHeartbeat();
            return;
          }
          this.storeDeviceTokenFromPayload(payload);
          this.subscribeSessionEvents();
          // ⭐ B1（2026-10-11 整改）：重连成功后与**真实仍在跑的任务**核对软状态 ——
          //    断连期间丢失的"这一轮已结束"事件不会让应用永久判忙；仍在跑/未知的
          //    一律保留（判据与保守口径见 `reconcileGatewayTurnSessions`）。
          //    首次连接时该网关没有记录，天然 no-op。
          reconcileGatewayTurnSessions(this.gatewayId);
          // ⭐ B1（复审二轮）：恢复出口 —— 对"停止过但 abort 没送达/没应答"的轮次补发一次
          //    abort（现在可达了）。网关真的应答了 = 确认的生命周期证据 ⇒ 软状态落地；
          //    仍失败则保留，等下一次重连/连接终结有界收口（见 retryPendingGatewayTurnStops）。
          //    不 await：重连流程不被它拖住；函数内部逐会话吞错，不会产生未处理拒绝。
          void retryPendingGatewayTurnStops(this.gatewayId, (sessionKey) => this.abortChat(sessionKey));
          this.startHeartbeat();
          sendToWindow(getMainWindow(), 'gateway-status', {
            gatewayId: this.gatewayId,
            connected: true,
            serverVersion: this.serverVersion,
            maxPayloadBytes: this.maxPayloadBytes,
          });
          // ⭐ 晚就绪收敛（2026-10-04 真机）：bootstrap 的 180 秒等待判了 ready-timeout，
          //    但真实的认证成功在**两分钟后**才到 —— 那次失败只是那一次等待失败。
          //    这里（主连接 hello-ok 成功、认证证据就是这次握手）把晚到的本机就绪
          //    收敛进快照，否则旧失败快照会永久挡住真实入口。
          void this.convergeLateLocalRuntimeOnHello(connectSocket);
        } else {
          getDebugLogger().error({
            domain: 'gateway',
            event: 'gateway.connect.res.unexpected',
            gatewayId: this.gatewayId,
            requestId: 'connect-handshake',
            data: { payload: summarizePayload(payload) },
          });
        }
      })
      .catch((err: HandshakeFailure) => {
        this.lastError = err.message;
        this.lastErrorCode = (err.details?.code as string) ?? null;
        const rejected = isGatewayRejection(err);
        getDebugLogger().error({
          domain: 'gateway',
          event: 'gateway.connect.failed',
          gatewayId: this.gatewayId,
          requestId: 'connect-handshake',
          error: { name: err.name, message: err.message, stack: err.stack },
          data: {
            errorCode: this.lastErrorCode,
            transportCode: err.code ?? null,
            rejected,
            hint: rejected ? '网关明确拒绝 ⇒ 停止重连（会在状态里报 gaveUp）' : '这次连接没成 ⇒ 照常背退重连',
          },
        });
        if (!rejected) {
          // 超时 / 发不出去 / 连接已断 ⇒ 这是"这次连接没成"，不是"服务端拒绝"。
          // 关掉走普通断线路径（`close` 处理器会背退重连），否则一次 15 秒超时就把
          // 客户端永久钉死 —— 而网关只是还在预热（T-a8）。
          this.ws?.close();
          return;
        }
        this.ws?.close(WS_CLOSE_POLICY_VIOLATION, 'auth failed');
      });
  }

  private subscribeSessionEvents(): void {
    this.sendReq('sessions.subscribe', {}, { requestId: 'sessions-subscribe' })
      .then(() => {
        getDebugLogger().info({
          domain: 'gateway',
          event: 'gateway.sessions.subscribe.ok',
          gatewayId: this.gatewayId,
          requestId: 'sessions-subscribe',
        });
      })
      .catch((err: Error & { code?: string }) => {
        getDebugLogger().warn({
          domain: 'gateway',
          event: 'gateway.sessions.subscribe.failed',
          gatewayId: this.gatewayId,
          requestId: 'sessions-subscribe',
          error: { name: err.name, message: err.message, stack: err.stack, code: err.code },
        });
      });
  }

  private storeDeviceTokenFromPayload(payload: Record<string, unknown>): void {
    const auth = payload['auth'] as Record<string, unknown> | undefined;
    if (!auth) return;
    const token = auth['deviceToken'];
    const role = auth['role'];
    const issuedAtMs = auth['issuedAtMs'];
    if (typeof token === 'string' && token) {
      saveDeviceToken(
        this.gatewayId,
        token,
        typeof role === 'string' ? role : 'operator',
        typeof issuedAtMs === 'number' ? issuedAtMs : Date.now(),
      );
      getDebugLogger().info({
        domain: 'gateway',
        event: 'gateway.auth.device-token.saved',
        gatewayId: this.gatewayId,
        data: { role: typeof role === 'string' ? role : 'operator' },
      });
      this.onPairingSuccess?.(this.gatewayId);
    }
  }

  private handleResponse(frame: GatewayResFrame): void {
    const pending = this.pendingRequests.get(frame.id);
    if (!pending) {
      getDebugLogger().warn({
        domain: 'gateway',
        event: 'gateway.res.unmatched',
        gatewayId: this.gatewayId,
        wsFrameId: frame.id,
        data: { ok: frame.ok },
      });
      return;
    }
    this.pendingRequests.delete(frame.id);
    clearTimeout(pending.timer);
    const durationMs = Date.now() - pending.startedAt;

    if (frame.ok && frame.payload) {
      getDebugLogger().info({
        domain: 'gateway',
        event: 'gateway.res.received',
        gatewayId: this.gatewayId,
        requestId: pending.requestId,
        wsFrameId: frame.id,
        sessionKey: pending.sessionKey,
        taskId: pending.taskId,
        durationMs,
        ok: true,
        data: {
          method: pending.method,
          payload: pending.method === 'artifacts.download' ? { redacted: true } : summarizePayload(frame.payload),
        },
      });
      pending.resolve(frame.payload);
    } else {
      const errMsg = frame.error?.message ?? 'request failed';
      getDebugLogger().error({
        domain: 'gateway',
        event: 'gateway.res.error',
        gatewayId: this.gatewayId,
        requestId: pending.requestId,
        wsFrameId: frame.id,
        sessionKey: pending.sessionKey,
        taskId: pending.taskId,
        durationMs,
        ok: false,
        error: { message: errMsg, code: frame.error?.code },
        data: { method: pending.method },
      });
      const err = new Error(errMsg) as Error & { code?: string; details?: Record<string, unknown> };
      err.code = frame.error?.code;
      if (frame.error?.details) {
        err.details = frame.error.details;
      }
      pending.reject(err);
    }
  }

  sendReq(
    method: string,
    params: Record<string, unknown>,
    meta?: { requestId?: string; sessionKey?: string; taskId?: string; timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        getDebugLogger().error({
          domain: 'gateway',
          event: 'gateway.req.rejected.not-connected',
          gatewayId: this.gatewayId,
          requestId: meta?.requestId,
          sessionKey: meta?.sessionKey,
          taskId: meta?.taskId,
          data: { method },
          error: { message: 'not connected' },
        });
        const notConnErr = new Error('not connected') as Error & { code?: string };
        notConnErr.code = 'GATEWAY_NOT_CONNECTED';
        reject(notConnErr);
        return;
      }

      // ⭐ 这个方法网关**广告过**吗？没广告过就记一条（每个方法只记一次）。
      //    ⚠️ **照发不误** —— 这是诊断，不是门禁。这一整轮的教训都是同一个形状：
      //    "我们以为网关有，其实没有"，而这份答案每次握手都送到手上。
      //    见 `createAdvertisedSurface` 的三条判断（尤其"没有广告表时永远不报"）。
      if (this.advertisedSurface.takeUnadvertised(method)) {
        getDebugLogger().warn({
          domain: 'gateway',
          event: 'gateway.req.unadvertised_method',
          gatewayId: this.gatewayId,
          requestId: meta?.requestId,
          sessionKey: meta?.sessionKey,
          taskId: meta?.taskId,
          data: { method, hint: 'hello-ok.features.methods 里没有它；请求仍然发出' },
        });
      }

      const id = randomUUID();
      const requestId = meta?.requestId ?? randomUUID();
      const frame: GatewayReqFrame = { type: 'req', id, method, params };
      const startedAt = Date.now();
      const timeoutMs =
        typeof meta?.timeoutMs === 'number' && Number.isFinite(meta.timeoutMs) && meta.timeoutMs > 0
          ? Math.min(meta.timeoutMs, MAX_REQ_TIMEOUT_MS)
          : REQ_TIMEOUT_MS;

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        getDebugLogger().error({
          domain: 'gateway',
          event: 'gateway.req.timeout',
          gatewayId: this.gatewayId,
          requestId,
          wsFrameId: id,
          sessionKey: meta?.sessionKey,
          taskId: meta?.taskId,
          durationMs: Date.now() - startedAt,
          data: { method },
          error: { message: `request timeout: ${method}` },
        });
        const timeoutErr = new Error(`request timeout: ${method}`) as Error & { code?: string };
        timeoutErr.code = 'TIMEOUT';
        reject(timeoutErr);
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve,
        reject,
        timer,
        method,
        startedAt,
        requestId,
        sessionKey: meta?.sessionKey,
        taskId: meta?.taskId,
      });
      getDebugLogger().debug({
        domain: 'gateway',
        event: 'gateway.req.sent',
        gatewayId: this.gatewayId,
        requestId,
        wsFrameId: id,
        sessionKey: meta?.sessionKey,
        taskId: meta?.taskId,
        data: {
          method,
          params: summarizePayload(params),
        },
      });
      try {
        this.ws.send(JSON.stringify(frame));
      } catch (err) {
        this.pendingRequests.delete(id);
        clearTimeout(timer);
        const sendErr = new Error(
          `failed to send request: ${err instanceof Error ? err.message : 'unknown'}`,
        ) as Error & { code?: string };
        sendErr.code = 'SEND_FAILED';
        reject(sendErr);
      }
    });
  }

  private sessionMeta(sessionKey: string) {
    return {
      requestId: randomUUID(),
      sessionKey,
      taskId: parseTaskIdFromSessionKey(sessionKey) ?? undefined,
    };
  }

  async sendChatMessage(
    sessionKey: string,
    message: string,
    attachments?: ChatAttachment[],
  ): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = {
      sessionKey,
      message,
      idempotencyKey: randomUUID(),
      deliver: false,
    };
    if (attachments?.length) {
      params.attachments = attachments;
    }
    return this.sendReq('chat.send', params, this.sessionMeta(sessionKey));
  }

  async abortChat(sessionKey: string): Promise<Record<string, unknown>> {
    return this.sendReq('chat.abort', { sessionKey }, this.sessionMeta(sessionKey));
  }

  async getChatHistory(sessionKey: string, limit = 50, maxChars?: number): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = { sessionKey, limit };
    // 不传就沿用网关默认（**显示层 8,000 字符**，末尾追加 `...(truncated)...`）。
    // 结构化产物要全文时必须显式抬高 —— 合法范围 1 … 500,000，见
    // `artifact/recover-full-reply.ts` 的 `HISTORY_MAX_CHARS`（那些结论是真发请求量到的）。
    if (typeof maxChars === 'number') params.maxChars = maxChars;
    return this.sendReq('chat.history', params, this.sessionMeta(sessionKey));
  }

  async listSessions(): Promise<Record<string, unknown>> {
    return this.sendReq('sessions.list', {}, { requestId: randomUUID() });
  }

  async listSessionsBySpawner(spawnedBy: string): Promise<Record<string, unknown>> {
    if (!spawnedBy || typeof spawnedBy !== 'string' || spawnedBy.length === 0) {
      throw new Error('invalid spawnedBy parameter');
    }
    return this.sendReq('sessions.list', { spawnedBy }, { requestId: randomUUID() });
  }

  async createSession(params: { key: string; agentId: string; message?: string }): Promise<Record<string, unknown>> {
    return this.sendReq('sessions.create', params, { requestId: randomUUID() });
  }

  async listModels(agentId?: string): Promise<Record<string, unknown>> {
    return this.sendReq('models.list', agentId?.trim() ? { agentId: agentId.trim() } : {});
  }

  async listCommands(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.sendReq('commands.list', params);
  }

  async listAgents(): Promise<Record<string, unknown>> {
    return this.sendReq('agents.list', {});
  }

  /** 网关健康（含 `channels.<id>` 的真实运行状态）。连接器用它判断 ingress 是否可用。 */
  async getHealth(): Promise<Record<string, unknown>> {
    return this.sendReq('health', {});
  }

  async createAgent(
    params: {
      name: string;
      workspace: string;
      emoji?: string;
      avatar?: string;
    },
    options?: {
      current?: () => boolean;
      afterCreated: (agentId: string, tx: GatewayConfigMutationTx, current: () => boolean) => Promise<boolean>;
    },
  ): Promise<Record<string, unknown>> {
    const socket = this.ws;
    const current = () => socket !== null && this.ws === socket && this.isConnected && (options?.current?.() ?? true);
    return this.runConfigMutation(async (tx) => {
      if (options && !current()) throw new Error('Created-agent connection owner changed');
      const result = await this.sendReq('agents.create', params);
      const agentId = typeof result['agentId'] === 'string' ? result['agentId'] : '';
      if (options && !current()) return { ...result, workflowToolConfigured: false };
      if (agentId) {
        const visibility = await this.waitForAgentVisibility(agentId);
        if (!visibility.confirmed) {
          // agents.create 已经产生持久副作用，后续 watcher 检查失败不能把创建结果
          // 抹成“失败”。保留 agentId 给编排层继续配置或下一轮幂等修复。
          getDebugLogger().warn({
            domain: 'gateway',
            event: 'gateway.agent-create.visibility-pending',
            gatewayId: this.gatewayId,
            data: { agentId, error: visibility.error },
          });
          return {
            ...result,
            visibilityConfirmed: false,
            visibilityError: visibility.error,
          };
        }
      }
      if (options && agentId) {
        if (!current()) return { ...result, workflowToolConfigured: false };
        try {
          const ready = await options.afterCreated(agentId, tx, current);
          return { ...result, workflowToolConfigured: current() && ready };
        } catch (error) {
          // Creation already persisted: expose the capability failure without losing its ACK/ID.
          return {
            ...result,
            workflowToolConfigured: false,
            workflowToolError: error instanceof Error ? error.message : 'Workflow tool verification failed',
          };
        }
      }
      return result;
    });
  }

  /**
   * `agents.create` 的磁盘写完成早于 runtime config watcher；紧接着 update 会误报
   * `agent not found`。轮询与 update 同源的 `agents.list`，直到新 ID 真正进入运行态。
   */
  private async waitForAgentVisibility(agentId: string): Promise<{ confirmed: boolean; error?: string }> {
    const startedAt = Date.now();
    let lastError = '';
    for (let attempt = 0; attempt <= AGENT_VISIBILITY_BACKOFF_MS.length; attempt += 1) {
      const remainingMs = AGENT_VISIBILITY_TIMEOUT_MS - (Date.now() - startedAt);
      if (remainingMs <= 0) break;
      try {
        if (isAgentListed(await this.sendReq('agents.list', {}, { timeoutMs: remainingMs }), agentId)) {
          return { confirmed: true };
        }
        lastError = 'agent is not present in runtime catalog';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 单次 RPC 自己已有 15 秒超时；transport 失败不再叠十轮，且不能抹掉
        // 前面已经成功返回的 agents.create/agentId。
        return {
          confirmed: false,
          error: `agent "${agentId}" visibility check failed: ${message}`,
        };
      }

      const delayMs = AGENT_VISIBILITY_BACKOFF_MS[attempt];
      if (delayMs === undefined) break;
      const remainingAfterRequest = AGENT_VISIBILITY_TIMEOUT_MS - (Date.now() - startedAt);
      if (remainingAfterRequest <= 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(delayMs, remainingAfterRequest)));
    }

    return {
      confirmed: false,
      error: `agent "${agentId}" visibility timeout: ${lastError}`,
    };
  }

  async updateAgent(params: {
    agentId: string;
    name?: string;
    workspace?: string;
    model?: string;
    avatar?: string;
  }): Promise<Record<string, unknown>> {
    return this.runConfigMutation((tx) => this.updateAgentWithinConfigMutation(params, tx));
  }

  private async updateAgentWithinConfigMutation(
    params: {
      agentId: string;
      name?: string;
      workspace?: string;
      model?: string;
      avatar?: string;
    },
    tx: GatewayConfigMutationTx,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.sendReq('agents.update', params);
    } catch (error) {
      const safeName = params.name?.trim();
      const isNameOnlyUpdate =
        Boolean(safeName) &&
        params.workspace === undefined &&
        params.model === undefined &&
        params.avatar === undefined;
      if (!isNameOnlyUpdate || !safeName || !isUnsafeWorkspacePostWriteFailure(error, 'IDENTITY.md')) throw error;

      // OpenClaw 2026.9.3 的 agents.update 顺序是：写 IDENTITY.md → 更新
      // agents.entries。exFAT 可能在第一步落盘后误报 unsafe，导致第二步从未执行。
      // 先读回确认写入的确是本次名称，再用最窄 config.patch 补齐等价的两个配置字段；
      // 任一校验失败仍抛错，让上层回滚，不能把半成品助手标成已安装。
      let identityReadback: Record<string, unknown>;
      try {
        identityReadback = await this.getAgentFile(params.agentId, 'IDENTITY.md');
      } catch {
        throw error;
      }
      if (!isVerifiedAgentIdentityName(identityReadback, params.agentId, safeName)) throw error;

      for (let attempt = 1; attempt <= MAX_AGENT_NAME_CONFIG_RETRIES; attempt += 1) {
        const snapshot = await tx.getConfig();
        const baseHash = configHashOf(snapshot);
        if (!baseHash || !readAgentConfigEntry(snapshot, params.agentId)) throw error;

        try {
          await tx.patchConfig({
            baseHash,
            raw: JSON.stringify({
              agents: {
                entries: {
                  [params.agentId]: { name: safeName, identity: { name: safeName } },
                },
              },
            }),
          });
        } catch (patchError) {
          if (isConfigHashConflict(patchError) && attempt < MAX_AGENT_NAME_CONFIG_RETRIES) continue;
          throw patchError;
        }

        const verified = await tx.getConfig();
        if (isAgentNameConfigApplied(verified, params.agentId, safeName)) {
          getDebugLogger().warn({
            domain: 'gateway',
            event: 'gateway.agent-update.config-recovered-after-unsafe',
            gatewayId: this.gatewayId,
            data: { agentId: params.agentId, attempt, errorCode: error.code },
          });
          return { ok: true, agentId: params.agentId };
        }
      }

      throw error;
    }
  }

  async deleteAgent(params: { agentId: string; deleteFiles?: boolean }): Promise<Record<string, unknown>> {
    return this.runConfigMutation(() => this.sendReq('agents.delete', params));
  }

  async listAgentFiles(agentId: string): Promise<Record<string, unknown>> {
    return this.sendReq('agents.files.list', { agentId });
  }

  async getAgentFile(agentId: string, name: string): Promise<Record<string, unknown>> {
    return this.sendReq('agents.files.get', { agentId, name });
  }

  async setAgentFile(agentId: string, name: string, content: string): Promise<Record<string, unknown>> {
    try {
      return await this.sendReq('agents.files.set', { agentId, name, content });
    } catch (error) {
      // OpenClaw 在 exFAT 上可能已成功落盘，却在随后的文件身份校验中返回
      // `unsafe workspace file` 。只对“同一文件 + 同一错误码”做一次读后校验；
      // agentId、文件名、missing 和内容必须全部精确匹配，否则仍抛原错。
      if (!isUnsafeWorkspacePostWriteFailure(error, name)) throw error;

      try {
        const verified = await this.getAgentFile(agentId, name);
        if (isVerifiedAgentFileWrite(verified, agentId, name, content)) {
          getDebugLogger().warn({
            domain: 'gateway',
            event: 'gateway.agent-file.write-verified-after-unsafe',
            gatewayId: this.gatewayId,
            data: { agentId, name, errorCode: error.code },
          });
          return { ...verified, ok: true };
        }
      } catch {
        // 读回本身失败也不能改写语义：对上层保留原始写失败。
      }
      throw error;
    }
  }

  async patchSession(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.sendReq('sessions.patch', params);
  }

  async resetSession(sessionKey: string, reason: 'new' | 'reset' = 'reset'): Promise<Record<string, unknown>> {
    return this.sendReq('sessions.reset', { key: sessionKey, reason }, this.sessionMeta(sessionKey));
  }

  async deleteSession(sessionKey: string, deleteTranscript = true): Promise<Record<string, unknown>> {
    return this.sendReq('sessions.delete', { key: sessionKey, deleteTranscript }, this.sessionMeta(sessionKey));
  }

  async compactSession(sessionKey: string, maxLines?: number): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = { key: sessionKey };
    if (maxLines !== undefined) params.maxLines = maxLines;
    return this.sendReq('sessions.compact', params, this.sessionMeta(sessionKey));
  }

  async getToolsCatalog(agentId?: string): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = { includePlugins: true };
    if (agentId) params.agentId = agentId;
    return this.sendReq('tools.catalog', params);
  }

  async getEffectiveTools(sessionKey: string, agentId?: string): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = { sessionKey };
    if (agentId) params.agentId = agentId;
    return this.sendReq('tools.effective', params);
  }

  async getSkillsStatus(agentId?: string): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = {};
    if (agentId) params.agentId = agentId;
    return this.sendReq('skills.status', params);
  }

  async installSkill(
    params:
      | {
          agentId?: string;
          name: string;
          installId: string;
          dangerouslyForceUnsafeInstall?: boolean;
          timeoutMs?: number;
        }
      | { agentId?: string; source: 'clawhub'; slug: string; version?: string; force?: boolean; timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    return this.sendReq('skills.install', params);
  }

  async updateSkill(
    params:
      | { skillKey: string; enabled?: boolean; apiKey?: string; env?: Record<string, string> }
      | { source: 'clawhub'; slug?: string; all?: boolean },
  ): Promise<Record<string, unknown>> {
    // skills.update mutates the same OpenClaw config as agents/config RPCs.
    // Serializing it avoids concurrent startup upgrades queueing inside the
    // gateway until our 15-second request deadline expires.
    return this.runConfigMutation(() => this.sendReq('skills.update', params, { timeoutMs: SKILL_UPDATE_TIMEOUT_MS }));
  }

  async searchSkills(params: { query?: string; limit?: number }): Promise<Record<string, unknown>> {
    return this.sendReq('skills.search', params);
  }

  async getSkillDetail(slug: string): Promise<Record<string, unknown>> {
    return this.sendReq('skills.detail', { slug });
  }

  async getSkillBins(): Promise<Record<string, unknown>> {
    return this.sendReq('skills.bins', {});
  }

  /**
   * 生成手机端配对 setup code（网关 `device.pair.setupCode`）。
   *
   * 需要 admin 会话 —— 只有桌面壳自己具备；手机侧永远调不到这个方法。
   * 返回的 url 是桌面壳视角的地址，手机走隧道，所以调用方要用
   * `buildMobileQrPayload()` 把 url 覆写成公网域名（方案 v1.1 §6.2）。
   */
  async createMobilePairSetupCode(): Promise<Record<string, unknown>> {
    return this.sendReq('device.pair.setupCode', {}, { requestId: randomUUID() });
  }

  async getConfig(): Promise<Record<string, unknown>> {
    return this.sendReq('config.get', {});
  }

  async setConfig(params: { raw: string; baseHash?: string }): Promise<Record<string, unknown>> {
    return this.runConfigMutation((tx) => tx.setConfig(params));
  }

  async patchConfig(params: {
    raw: string;
    baseHash?: string;
    replacePaths?: string[];
    sessionKey?: string;
    note?: string;
    restartDelayMs?: number;
  }): Promise<Record<string, unknown>> {
    return this.runConfigMutation((tx) => tx.patchConfig(params));
  }

  async getConfigSchema(): Promise<Record<string, unknown>> {
    return this.sendReq('config.schema', {});
  }

  async lookupConfigSchema(path: string): Promise<Record<string, unknown>> {
    return this.sendReq('config.schema.lookup', { path });
  }

  async getUsageStatus(): Promise<Record<string, unknown>> {
    return this.sendReq('usage.status', {});
  }

  // ⚠️ 这里**曾经**有一个查"按日期区间的成本汇总"的方法 —— 2026-09-20 撤掉整条链（T-a23）：
  //    只带日期区间时它多 agent 下**恒为** INVALID_REQUEST（网关拿 `"main"` 解析归属，
  //    见随包运行时 `dist/usage-lCaKvodi.mjs`），而取回的成本数据在渲染层无人消费。
  //    ⇒ 将来要重开这条，**必须**带上 `agentScope: 'all'` 或 `agentId`（同 `getSessionUsage` 的办法；
  //    那条 09-17 就是这么修好的）。原因与证据见 `renderer/stores/usageStore.ts` 的 docblock 与能力图。

  async getSessionUsage(params: {
    key?: string;
    /**
     * 跨 agent 的"全部会话"查询**必须显式声明**（网关 `SessionsUsageParamsSchema`
     * 里的 `agentScope: "all"`）。
     *
     * ⚠️ 只发 `{}` 是不行的 —— 网关会逐个会话解析归属，碰到没有 owner 的 `main`
     * 就整条拒绝（2026-09-17 实测 38 次 `session key "main" has no explicit owner`）。
     */
    agentScope?: 'all';
    startDate?: string;
    endDate?: string;
  }): Promise<Record<string, unknown>> {
    return this.sendReq('sessions.usage', params as unknown as Record<string, unknown>);
  }

  async previewSessions(params: {
    keys: string[];
    limit?: number;
    maxChars?: number;
  }): Promise<Record<string, unknown>> {
    return this.sendReq('sessions.preview', params as unknown as Record<string, unknown>);
  }

  async listCronJobs(params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.sendReq('cron.list', params ?? {});
  }

  async getCronStatus(): Promise<Record<string, unknown>> {
    return this.sendReq('cron.status', {});
  }

  async addCronJob(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.sendReq('cron.add', params);
  }

  async updateCronJob(jobId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.sendReq('cron.update', { jobId, patch });
  }

  async removeCronJob(jobId: string): Promise<Record<string, unknown>> {
    return this.sendReq('cron.remove', { jobId });
  }

  async runCronJob(jobId: string, mode?: string): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = { jobId };
    if (mode) params.mode = mode;
    return this.sendReq('cron.run', params);
  }

  async listCronRuns(params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.sendReq('cron.runs', params ?? {});
  }

  get isConnected(): boolean {
    return this.authenticated && this.ws?.readyState === WebSocket.OPEN;
  }

  get lastConnectionError(): string | null {
    return this.lastError;
  }

  get lastConnectionErrorCode(): string | null {
    return this.lastErrorCode;
  }

  get httpBase(): string {
    const parsed = new URL(this.wsUrl);
    const protocol = parsed.protocol === 'wss:' || parsed.protocol === 'https:' ? 'https:' : 'http:';
    return `${protocol}//${parsed.host}`;
  }

  get version(): string | undefined {
    return this.serverVersion;
  }

  get maxPayload(): number | undefined {
    return this.maxPayloadBytes;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    getDebugLogger().info({
      domain: 'gateway',
      event: 'gateway.heartbeat.start',
      gatewayId: this.gatewayId,
    });
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendReq('health', {}, { requestId: `heartbeat-${Date.now()}` }).catch((err) => {
          getDebugLogger().warn({
            domain: 'gateway',
            event: 'gateway.heartbeat.failed',
            gatewayId: this.gatewayId,
            error: { message: err instanceof Error ? err.message : 'heartbeat failed' },
          });
        });
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * 开始等 `connect.challenge`（连上之后才开始算，WS 握手本身有 `handshakeTimeout`）。
   *
   * ⚠️ 超时后**绝不能**走 1008：1008 在我们的状态机里等于"服务端明确拒绝" ⇒ 那条路**刻意不重连**
   *    ⇒ 明明只是"网关卡住了"，反而变成永久停摆（正是 `2e17f291` 修的同一个死法）。
   *    这里按"**这次连接没成**"处理：如实报状态 + 关掉它 ⇒ 走普通背退重连。
   */
  private startChallengeTimer(): void {
    this.clearChallengeTimer();
    this.challengeTimer = setTimeout(() => {
      this.challengeTimer = null;
      const seconds = Math.round(CHALLENGE_WAIT_TIMEOUT_MS / 1000);
      this.lastError = `gateway sent no connect.challenge within ${seconds}s`;
      getDebugLogger().warn({
        domain: 'gateway',
        event: 'gateway.challenge.timeout',
        gatewayId: this.gatewayId,
        error: { message: this.lastError },
        data: { waitedMs: CHALLENGE_WAIT_TIMEOUT_MS, pendingRequests: this.pendingRequests.size },
      });
      // ⭐ 先把状态送出去**再**关：对端没反应时 `ws.close()` 要等 close 握手超时（默认 30 秒）
      //    才触发 `close` 事件，光靠 close 处理器报，界面还要再白等半分钟。
      sendToWindow(getMainWindow(), 'gateway-status', {
        gatewayId: this.gatewayId,
        connected: false,
        error: this.lastError,
        reconnectAttempt: this.reconnectAttempts,
        maxAttempts: MAX_RECONNECT_ATTEMPTS,
        gaveUp: false,
      });
      this.ws?.close();
    }, CHALLENGE_WAIT_TIMEOUT_MS);
  }

  private clearChallengeTimer(): void {
    if (this.challengeTimer) {
      clearTimeout(this.challengeTimer);
      this.challengeTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.noReconnect) return;
    // ⚠️ BUG-064 D（2026-10-10）：本机运行时**已被判定起不来**（bootstrap 快照 ok:false，
    //    例如随盘 Node 探测失败）时，对该本地网关的持续重连只是在打一场不会赢的仗
    //    （现场：20 次 1006 重连风暴，用户看到的却是"一直在准备"）。
    //    抑制**自动**重连，等用户「重新准备」成功（IPC runtime:bootstrap-retry 的
    //    成功分支会显式 `reconnectGateway`）把它唤醒。
    //    ⚠️ 只影响**本机运行时**这一个网关：远端/其它网关照旧重连，不做全局暂停；
    //    显式 `reconnect()`（手动重试路径）不经过这里，天然不受抑制。
    if (this.gatewayId === LOCAL_GATEWAY_ID) {
      const snapshot = getRuntimeBootstrapStatus();
      // ⚠️ BUG-064 K2（终审）：**ready-timeout 必须除外** —— 它只说明"那一轮等待超时"，
      //    晚到的主连接 hello-ok + /startupz started 会把快照收敛成功（见
      //    `convergeLateLocalRuntimeReady`）；把它的重连也停了，慢机就失去取得这份
      //    证据的唯一路径。其它失败类（端口被占/迁移被挡/Node 探测失败等）才是
      //    "再连也赢不了"，继续抑制。
      if (snapshot && snapshot.ok === false && snapshot.reason !== 'ready-timeout') {
        if (!this.runtimeDownSuppressed) {
          this.runtimeDownSuppressed = true;
          getDebugLogger().warn({
            domain: 'gateway',
            event: 'gateway.reconnect.suppressed-runtime-down',
            gatewayId: this.gatewayId,
            data: { reason: snapshot.reason },
          });
          // ⭐ B1：本机运行时被判定**起不来** = 失败终结 —— 这个网关上的轮次不可能再
          //    交付（它就死在这台运行时的进程里）。软状态必须落地，否则升级被永久判忙。
          //    只释放本网关的记录；run 自己的真实释放路径照旧（软状态释放不放行单飞门）。
          //    ⚠️ 复审二轮：只有**记录主轮次**的连接有资格释放（见 releaseOwnTurnSessions）。
          this.releaseOwnTurnSessions('runtime-down');
        }
        return;
      }
    }
    this.runtimeDownSuppressed = false;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      getDebugLogger().error({
        domain: 'gateway',
        event: 'gateway.reconnect.give-up',
        gatewayId: this.gatewayId,
        attempt: this.reconnectAttempts,
        error: { message: 'max reconnect attempts reached' },
      });
      sendToWindow(getMainWindow(), 'gateway-status', {
        gatewayId: this.gatewayId,
        connected: false,
        error: 'max reconnect attempts',
        reconnectAttempt: this.reconnectAttempts,
        maxAttempts: MAX_RECONNECT_ATTEMPTS,
        gaveUp: true,
      });
      // ⭐ B1：重连次数耗尽 = 失败终结 —— 这个网关上的轮次在本连接生命周期里不可能
      //    再拿到终态事件；软状态落地（只释放本网关的记录），否则升级被永久判忙。
      //    ⚠️ **只清软状态**：不取消 run（用户手动重连后那一轮仍可能把终态送进来；
      //    run 有自己 15 分钟 TTL 兜底），单飞门因此不会被提前放行。
      //    ⚠️ 复审二轮：只有**记录主轮次**的连接有资格释放（见 releaseOwnTurnSessions）。
      this.releaseOwnTurnSessions('reconnect-gave-up');
      return;
    }

    const attempt = this.reconnectAttempts + 1;
    const delay = calculateReconnectDelay(attempt);
    this.reconnectAttempts = attempt;
    getDebugLogger().warn({
      domain: 'gateway',
      event: 'gateway.reconnect.scheduled',
      gatewayId: this.gatewayId,
      attempt: this.reconnectAttempts,
      data: { delay },
    });

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private cleanup(): void {
    this.stopHeartbeat();
    this.clearChallengeTimer();
    this.connectNonce = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      getDebugLogger().warn({
        domain: 'gateway',
        event: 'gateway.req.cancelled.connection-closed',
        gatewayId: this.gatewayId,
        requestId: pending.requestId,
        wsFrameId: id,
        sessionKey: pending.sessionKey,
        taskId: pending.taskId,
        data: { method: pending.method },
        error: { message: 'connection closed' },
      });
      // ⭐ 1009 的断连给在途请求一句**可识别**的原因（普通断线维持原样）——
      //    发送失败的系统消息靠它经 `translateGatewayError` 翻成"这次发的内容太大"。
      const closeErr = new Error(
        this.lastCloseCode === WS_CLOSE_MESSAGE_TOO_BIG ? GATEWAY_MESSAGE_TOO_BIG_ERROR : 'connection closed',
      ) as Error & { code?: string };
      closeErr.code = 'GATEWAY_CONNECTION_CLOSED';
      pending.reject(closeErr);
      this.pendingRequests.delete(id);
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.on('error', () => {});
      try {
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close();
        }
      } catch {}
      this.ws = null;
    }
    this.authenticated = false;
  }

  reconnect(): void {
    this.reconnectAttempts = 0;
    this.connect();
  }

  /**
   * ⭐ B1（复审二轮）：**只有记录主轮次的连接**有资格释放软状态。
   *
   * 审批副连接（`approvalChannel`）与主连接**共用同一个 gatewayId**，但它从不记
   * start/end（见 handleEvent 的 `!this.approvalChannel` 门）——它的 destroy /
   * gave-up / runtime-down 只说明"审批通道断了"，主会话这一轮可能还在跑。
   * 复审实测反例：主连接 start 之后，审批副连接 destroy ⇒ busy true→false。
   * 主/副两条连接是**各自独立**的实例，所以这个门放在连接自己身上。
   */
  private releaseOwnTurnSessions(reason: string): void {
    if (this.approvalChannel) return;
    releaseGatewayTurnSessions(this.gatewayId, reason);
  }

  destroy(): void {
    this.destroyed = true;
    this.cleanup();
    // ⭐ B1（2026-10-11 整改）：连接被**永久移除**（removeGateway / 退出清理 / 被新连接
    //    替换）—— 这个网关上的轮次再也拿不到终态事件了，软状态必须释放，否则
    //    `hasLiveTurnSessions()` 永远是 true、升级被永久判忙（评审 P2 的真身）。
    //    ⚠️ 只释放**归属这个网关**的记录；短暂断连只走 `close` 处理器里的 `cleanup()`
    //    （照常重连），**不经过 destroy**，真实仍在跑的轮次不会被误放行。
    //    ⚠️ 复审二轮：审批副连接没有资格释放（见 releaseOwnTurnSessions）。
    this.releaseOwnTurnSessions('destroyed');
  }
}
