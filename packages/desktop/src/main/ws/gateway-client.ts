import WebSocket, { type ClientOptions } from 'ws';
import { app } from 'electron';
import { randomUUID } from 'crypto';
import {
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
import { ensureGatewayWindowsSystemTrust } from './tls-trust.js';

const WS_CLOSE_POLICY_VIOLATION = 1008;
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
      const error =
        this.lastError ?? (code === WS_CLOSE_POLICY_VIOLATION ? reasonStr || 'policy violation' : undefined);
      getDebugLogger().warn({
        domain: 'gateway',
        event: 'gateway.ws.close',
        gatewayId: this.gatewayId,
        data: {
          code,
          reason: reasonStr,
          pendingRequests: this.pendingRequests.size,
        },
      });
      this.authenticated = false;
      this.serverVersion = undefined;
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

    // ⚠️ 审批连接**只**转发审批事件：其余多是广播事件（tick/health/presence/node.*），
    //    主连接也在收 —— 转发它们等于让渲染器把每条都处理两遍。
    if (this.approvalChannel && !APPROVAL_CHANNEL_EVENTS.has(frame.event)) return;

    sendToWindow(getMainWindow(), 'gateway-event', {
      gatewayId: this.gatewayId,
      event: frame.event,
      payload: frame.payload,
      seq: frame.seq,
    });
  }

  private buildAuthWithDeviceToken(): GatewayAuth {
    const storedToken = loadDeviceToken(this.gatewayId);
    if (storedToken) {
      return { ...this.auth, deviceToken: storedToken };
    }
    return this.auth;
  }

  private handleChallenge(nonce: string): void {
    const signatureToken =
      'token' in this.auth ? this.auth.token : 'bootstrapToken' in this.auth ? this.auth.bootstrapToken : null;
    const scopes = ['operator.admin', 'operator.write', 'operator.read', 'operator.approvals', 'operator.pairing'];

    const device = buildDeviceConnectPayload(this.deviceIdentity, {
      clientId: 'gateway-client',
      clientMode: 'backend',
      role: 'operator',
      scopes,
      nonce,
      token: signatureToken,
      platform: process.platform,
      deviceFamily: null,
    });

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
      auth: this.buildAuthWithDeviceToken(),
      role: 'operator',
      scopes,
      device,
    };

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
          this.startHeartbeat();
          sendToWindow(getMainWindow(), 'gateway-status', {
            gatewayId: this.gatewayId,
            connected: true,
            serverVersion: this.serverVersion,
          });
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
          payload: summarizePayload(frame.payload),
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
          ? Math.min(meta.timeoutMs, REQ_TIMEOUT_MS)
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

  async listModels(): Promise<Record<string, unknown>> {
    return this.sendReq('models.list', {});
  }

  async listCommands(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.sendReq('commands.list', params);
  }

  async listAgents(): Promise<Record<string, unknown>> {
    return this.sendReq('agents.list', {});
  }

  async createAgent(params: {
    name: string;
    workspace: string;
    emoji?: string;
    avatar?: string;
  }): Promise<Record<string, unknown>> {
    return this.runConfigMutation(async () => {
      const result = await this.sendReq('agents.create', params);
      const agentId = typeof result['agentId'] === 'string' ? result['agentId'] : '';
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

  async getSkillsStatus(agentId?: string): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = {};
    if (agentId) params.agentId = agentId;
    return this.sendReq('skills.status', params);
  }

  async installSkill(
    params:
      | { name: string; installId: string; dangerouslyForceUnsafeInstall?: boolean; timeoutMs?: number }
      | { source: 'clawhub'; slug: string; version?: string; force?: boolean; timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    return this.sendReq('skills.install', params);
  }

  async updateSkill(
    params:
      | { skillKey: string; enabled?: boolean; apiKey?: string; env?: Record<string, string> }
      | { source: 'clawhub'; slug?: string; all?: boolean },
  ): Promise<Record<string, unknown>> {
    return this.sendReq('skills.update', params);
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
      const closeErr = new Error('connection closed') as Error & { code?: string };
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

  destroy(): void {
    this.destroyed = true;
    this.cleanup();
  }
}
