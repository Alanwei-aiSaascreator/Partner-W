# OpenClaw Gateway Protocol Whitepaper

> Source of truth: reverse-engineered from `~/git/openclaw`
> Baseline: `0153d84c` (2026-09-09) — previous baseline `2026.4.2` (2026-04-02)
> ⚠️ **与随包运行时 2026.9.3 的对齐未确认**：本机没有 2026.9.3 的源码 checkout，
> 无法判定 `0153d84c` 与随包运行时是不是同一条线（见「0. Re-sync 记录」）。
> Maintenance note: this whitepaper was originally organized from the 2026.3.12-era Gateway implementation and should be refreshed periodically as OpenClaw evolves.

---

## 0. Re-sync 记录（2026.4.2 → `0153d84c` / 2026-09-09）

> 本节是**本次 re-sync 的账**：改了什么、凭什么改、**哪些没覆盖**。
> 逐条都能在 `~/git/openclaw` 里复核（路径 + 行号见正文的 `> Source:` 标注）。

### 0.1 结构变更：源码**搬了家**，不是协议变了

白皮书原来引用的 28 条源码路径里，**19 条已经不存在**。查清了去向：

| 原来                                            | 现在                                                                      | 性质                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/gateway/protocol/schema/*.ts`（17 个文件） | **`packages/gateway-protocol/src/schema/*.ts`**                           | **1:1 搬家**，文件名全部保留                                                                               |
| `src/gateway/protocol/client-info.ts`           | `packages/gateway-protocol/src/client-info.ts`                            | 1:1 搬家                                                                                                   |
| `src/gateway/server.impl.ts`                    | **拆成 `src/gateway/server/` 下的一大批模块**                             | 结构重构（`client-registry.ts` / `close-reason.ts` / `health-state.ts` / `http-listen.ts` / `hooks.ts` …） |
| `src/gateway/server-methods/sessions.ts`        | **拆成 `src/gateway/server-methods/sessions-*.ts` + 若干 `session-*.ts`** | 结构重构                                                                                                   |

⇒ 正文里 41 处路径标注已按上表改写；**这是路径修正，不是协议结论变化**。

### 0.2 协议漂移（**本节按口径单独列，不混进正文**）

1. 🔴 **方法目录从"字符串清单"变成"描述符 + 版本门禁"**。
   原来 `BASE_METHODS` 是一组名字；现在是 `GatewayMethodDescriptor` 元组数组
   `["<方法>", "<area>", "<scope>", "<since>", {startup}?]`（`src/gateway/methods/core-descriptors.ts`），
   字段有 `since` / `scope` / `profileAccess` / `startup` / `controlPlaneWrite` / `advertise`。
   ⇒ **方法有了"从哪个版本开始存在"的语义**，客户端可以据此做能力探测。
2. 🔴 **方法数量从 111 → 424**（同一文件里数出来的元组行数）。`since` 标注 `<=2026.7` 之外的有 **158 个**，
   即成批新增。新子系统包括 `question.*`、`users.authConnect.*`、`environments.*`、`worktrees.*`、
   `skills.library.*`、`audit.*`、`exec.approval.grants.*`、`board.*`、`canvas.*`、`portals.*`、
   `artifacts.*`、`migrations.*`、`gateway.suspend.*`、`openclaw.*`。
3. 🔴 **出现了协议版本号**（`packages/gateway-protocol/src/version.ts`）：
   `PROTOCOL_VERSION = 4`、`MIN_CLIENT_PROTOCOL_VERSION = 4`、
   `MIN_NODE_PROTOCOL_VERSION = 3`、`MIN_PROBE_PROTOCOL_VERSION = 3`。白皮书此前**没有**这一节。
4. 🔴 **事件从 24 → 60**（`GATEWAY_EVENTS`：56 个字面量 + 4 个常量）。
   新增的包括 `question.*`、`terminal.*`、`session.approval`、`session.observer`、
   `session.operation`、`session.sharing*`、`session.suggestion`、`session.typing`、
   `task*`、`update.run.changed`、`device.pair.changed`、`node.runnerInventory.changed`、
   `progressCard.changed`、`mentions.changed`、`portal.changed`、`gateway.suspension` …
5. ⚠️ **确认删除的 4 个方法**（全库宽松搜索都找不到）：
   `sessions.unsubscribe`、`node.pair.request`、`node.pair.verify`、`node.canvas.capability.refresh`。
   （`sessions.subscribe` **还在**；`node.pair.requested`/`resolved` 是**事件**不是方法，别混。）
6. ✅ **§2.4 的几个常量取值没变**（逐个核过）：`MAX_PAYLOAD_BYTES` 25MB、
   `MAX_BUFFERED_BYTES` 50MB、`MAX_PREAUTH_PAYLOAD_BYTES` 64KB、`TICK_INTERVAL_MS` 30s、
   `HEALTH_REFRESH_INTERVAL_MS` 60s、`DEDUPE_TTL_MS` 5min、`DEDUPE_MAX` 1000。
   ⚠️ 但 `HANDSHAKE_TIMEOUT_MS` **不在 `server-constants.ts` 里了**（见 §2.4）。

### 0.3 ⚠️ 本轮**没有**覆盖的范围（如实）

这次做的是**结构 + 可机械核对的那一层**（路径、方法目录、事件目录、常量取值、确认删除项）。
**没有**逐节重验语义：

- §5.2–5.17 的**逐方法参数/返回值**没有重验 —— 方法从 111 涨到 424，逐方法重验不是一次能做完的；
- §7 鉴权内部（`auth-rate-limit.ts` / `method-scopes.ts` 仍在原路径，但**内容没逐行对本**）；
- §6 HTTP 端点、§9 消息格式、§10 集成指引未重验；
- **没有**任何真实运行验证（没有起过网关、没有发过帧）——本节所有结论都来自**读源码**。

⇒ 把这份白皮书当"2026.4.2 时代的协议画像 + 2026-09-09 的结构与目录现状"用，
**别**当"2026-09-09 的完整协议规范"用。

### 0.4 取值词表：**每条都标来源**（2026-09-19 补）

§0.2 管的是**结构**漂移（方法/事件目录、常量）。这一节管**取值**：
某个字段到底有哪些值、**凭什么说齐了**。

**为什么单开一节**：这份文档吃过三次同一句话的亏 ——
「扫过一遍」被写成了「只有这些」，而那句声明**不可测**，于是它成了盖子：
`tool.phase` 漏了 `input_delta`、`lifecycle` 漏了 `finishing`、`item.status` 漏了两个。
⇒ 从今天起的规矩：**凡写一份取值清单，必须同时写清来源**，并写明**是否可能不全**。

| 词表                                            | **来源**（能不能当全集用）                                                                                     | 全部取值                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat` 的 `state`                               | ✅ **类型定义**：`ChatEventSchema` = 5 个 schema 的联合（`logs-chat.ts`）                                      | `status` `delta` `final` `aborted` `error`                                                                                                                                                                                                                                                                                                                                                                  |
| `chat` 的 `errorKind`                           | ✅ **类型定义**：`ChatEventErrorKindSchema`                                                                    | `refusal` `timeout` `rate_limit` `context_length` `unknown`                                                                                                                                                                                                                                                                                                                                                 |
| `chat` 的 `phase`（`state:"status"` 时）        | ✅ **类型定义**：`ChatRunStartupPhaseSchema`                                                                   | 7 个启动相位（与 agent 流的 `run_status` **逐字相同**）                                                                                                                                                                                                                                                                                                                                                     |
| `agent.item` 的 `phase` / `status`              | ✅ **类型定义**：`AgentItemEventPhase` / `AgentItemEventStatus`（`src/infra/agent-activity-events.ts`）        | phase 3 个：`start` `update` `end`；status 4 个：`running` `completed` `failed` `blocked`                                                                                                                                                                                                                                                                                                                   |
| `agent.item` 的 `kind`                          | ✅ **类型定义**，但**开放**（`… \| (string & {})`）                                                            | `tool` `command` `patch` `search` `analysis`（后两个无发射点）                                                                                                                                                                                                                                                                                                                                              |
| `agent.approval` 的 `phase` / `status` / `kind` | ✅ **类型定义**：`AgentApprovalEventPhase` / `…Status` / `…Kind`（`src/infra/agent-events.ts`）                | phase：`requested` `resolved`；status：`pending` `unavailable` `approved` `denied` `failed`；kind：`exec` `plugin` `unknown`                                                                                                                                                                                                                                                                                |
| `ExecToolDetails.status`                        | ✅ **类型定义**：`bash-tools.exec-types.ts`（闭合联合）                                                        | `running` / `completed\|failed` / `approval-pending` / `approval-unavailable`                                                                                                                                                                                                                                                                                                                               |
| `agent.tool` 的 `phase`                         | ⚠️ **数出来的**（生产代码 25 个发射点）—— **不保证全集**                                                       | `start` `result` `update` `review` `input_delta`                                                                                                                                                                                                                                                                                                                                                            |
| `agent.lifecycle` 的 `phase`                    | ⚠️ **数出来的 + 抄运行时代码注释** —— **不保证全集**（⚠️ 其中 `finishing` 是**变量**发的，**扫字面量扫不到**） | `start` `end` `error` `fallback` `fallback_step` `fallback_cleared` `finishing`                                                                                                                                                                                                                                                                                                                             |
| `agent.run_status` 的 `phase`                   | ⚠️ **数出来的**（权威的是那份 7 个的 schema，`retrying` 是发射点数的）                                         | 7 个启动相位 + `retrying`                                                                                                                                                                                                                                                                                                                                                                                   |
| **`sessions.changed` 的 `reason`**              | 🔴 **无权威来源** —— 运行时类型就是 `reason: string`（`SessionChangedPayload`），**没有联合**                  | 数出来 **26 个以上**（`abort` `archive` `board` `checkpoint-branch` `cleanup` `compact` `create` `cron-binding` `cron-bindings-loaded` `cron-continuation` `delete` `dispatch` `fork` `goal` `groups` `move` `owner` `patch` `placement` `plugin-patch` `profile-identity` `project` `reclaim` `runner-availability` `send` `sharing` …）；⚠️ 模板 `checkpoint-${action}` 还会产出 **`checkpoint-restore`** |

**读这张表的规矩：**

1. **"类型定义"那一行**可以当全集用（除非运行时改了类型）；
2. **"数出来的"那几行是样本** —— 用之前先问"我的扫描边界是不是恰好等于全部"；
3. **没有来源的那一行（`reason`）默认是开放集**，别当闭集用；
4. ⇒ 对应的客户端做法：**认不出就留痕**（`unknown_*`），让清单**能长**。
   我们的实现里这类护栏已有 6 处，见内层仓库的 `gateway-dispatcher.ts`。

---

## 1. Architecture Overview

> Source: `src/gateway/server/`（`server.impl.ts` 在 2026-09-09 已拆成一批模块）,
> `src/gateway/server-broadcast.ts`, `src/gateway/server-http.ts`

Gateway is a WebSocket-first server (default port `:18789`) sitting between clients and the OpenClaw Agent Engine. All client communication goes through a **single persistent WebSocket connection**.

```
┌─────────────────────┐          ┌────────────────────────────┐
│ ClawWork Desktop    │  WS :18789  │ OpenClaw Gateway Server    │
│                     │◄──────────►│                            │
│ React 19 + Electron │           │ ┌────────────────────────┐ │
│                     │           │ │ Protocol Validator     │ │
│                     │           │ │ (AJV/TypeBox schemas)  │ │
│                     │           │ ├────────────────────────┤ │
│                     │           │ │ RPC Dispatcher         │ │
│                     │           │ │ (110+ methods)          │ │
│                     │           │ ├────────────────────────┤ │
│                     │           │ │ Broadcast Engine       │ │
│                     │           │ │ (24 event types)       │ │
│                     │           │ ├────────────────────────┤ │
│                     │           │ │ Agent Engine           │ │
│                     │           │ │ Session Store          │ │
│                     │           │ │ Cron Service           │ │
│                     │           │ └────────────────────────┘ │
│                     │           │                            │
│                     │           │ HTTP: /health, /v1/chat/*  │
└─────────────────────┘          └────────────────────────────┘
```

Key design decisions:

- **Single WS connection** per client (no REST API for core operations)
- **Request/Response + Event** three-frame model
- **Broadcast without session filtering** — clients must filter by `sessionKey`
- **JSON Schema validation** (TypeBox + AJV) on all frames
- **Scope-based access control** on events and methods

---

## 2. Frame Protocol

> Source: `packages/gateway-protocol/src/schema/frames.ts` (RequestFrame, ResponseFrame, EventFrame, GatewayFrame discriminated union)

All communication uses JSON frames over WebSocket. Three frame types form a discriminated union on the `type` field.

### 2.1 Request Frame (Client → Server)

```typescript
{
  type: "req",
  id: string,        // unique request ID, client-generated
  method: string,    // RPC method name (e.g. "chat.send")
  params?: unknown   // method-specific parameters
}
```

### 2.2 Response Frame (Server → Client)

```typescript
{
  type: "res",
  id: string,        // matches request.id
  ok: boolean,       // success or failure
  payload?: unknown, // method-specific response data (when ok=true)
  error?: {          // ErrorShape (when ok=false)
    code: string,
    message: string,
    details?: unknown,
    retryable?: boolean,
    retryAfterMs?: number
  }
}
```

**Error Codes:** (source: `packages/gateway-protocol/src/schema/error-codes.ts`)

| Code                 | Meaning                              |
| -------------------- | ------------------------------------ |
| `NOT_LINKED`         | Channel/account not linked           |
| `NOT_PAIRED`         | Device not paired                    |
| `AGENT_TIMEOUT`      | Agent execution timed out            |
| `INVALID_REQUEST`    | Bad parameters or validation failure |
| `APPROVAL_NOT_FOUND` | Approval ID not found                |
| `UNAVAILABLE`        | Service temporarily unavailable      |

### 2.3 Event Frame (Server → Client, broadcast)

```typescript
{
  type: "event",
  event: string,            // event type name
  payload?: unknown,        // event-specific data
  seq?: number,             // global monotonic sequence (broadcast only)
  stateVersion?: {
    presence?: number,
    health?: number
  }
}
```

### 2.4 Constants

> Source: `src/gateway/server-constants.ts`（仍在原路径）;
> 握手超时**搬到了** `packages/gateway-client/src/timeouts.ts`（由 `src/gateway/handshake-timeouts.ts` 再导出）

| Constant                               | Value                                       |
| -------------------------------------- | ------------------------------------------- |
| `MAX_PAYLOAD_BYTES`                    | 25 MB ✅ 未变                               |
| `MAX_BUFFERED_BYTES`                   | 50 MB (per connection) ✅ 未变              |
| `MAX_PREAUTH_PAYLOAD_BYTES`            | 64 KB ✅ 未变                               |
| `TICK_INTERVAL_MS`                     | 30,000 ms ✅ 未变                           |
| `HEALTH_REFRESH_INTERVAL_MS`           | 60,000 ms ✅ 未变                           |
| `DEDUPE_TTL_MS`                        | 5 minutes ✅ 未变                           |
| `DEDUPE_MAX`                           | 1,000 entries ✅ 未变                       |
| ~~`HANDSHAKE_TIMEOUT_MS`~~             | ⚠️ **这个名字没有了**（2026-09-09 实测）    |
| `DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS` | **15,000 ms**（原来记的 10,000 **是错的**） |
| `DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS`   | 30,000 ms（新增记录）                       |
| `MIN_CONNECT_CHALLENGE_TIMEOUT_MS`     | 250 ms（新增记录）                          |
| `MAX_CONNECT_CHALLENGE_TIMEOUT_MS`     | = 上面的 preauth 值                         |
| `MAX_SAFE_TIMEOUT_DELAY_MS`            | 2,147,483,647                               |
| `WS_COMPRESSION_THRESHOLD_BYTES`       | 4 KB（新增记录）                            |
| `WEBSOCKET_CLOSE_GRACE_MS`             | 1,000 ms（新增记录）                        |

⚠️ 握手超时可用环境变量覆盖：`OPENCLAW_HANDSHAKE_TIMEOUT_MS`（`src/gateway/call.ts`）。

---

## 3. Connection Lifecycle

### 3.1 Handshake Flow

```
Client                          Gateway
  │                               │
  │── TCP WebSocket upgrade ─────►│
  │                               │
  │◄── event: connect.challenge ──│  { nonce: UUID, ts: milliseconds }
  │                               │
  │── req: connect ──────────────►│  (see ConnectParams below)
  │                               │
  │◄── res: hello-ok ────────────│  (see HelloOk below)
  │                               │
  │   (connection established)    │
  │                               │
  │── req: chat.send ────────────►│
  │◄── event: chat (delta) ──────│  (streaming)
  │◄── event: agent ─────────────│  (tool calls)
  │◄── event: chat (final) ──────│
  │                               │
  │◄── event: tick ──────────────│  (every 30s)
  │                               │
```

### 3.2 ConnectParams

> Source: `packages/gateway-protocol/src/schema/frames.ts` → `ConnectParamsSchema`

```typescript
{
  minProtocol: 3,
  maxProtocol: 3,
  client: {
    id: GatewayClientId,           // see §3.3
    displayName?: string,
    version: string,               // app version
    platform: string,              // "darwin", "win32", "linux"
    deviceFamily?: string,         // "MacBookPro18,1"
    modelIdentifier?: string,      // hardware model
    mode: GatewayClientMode,       // see §3.3
    instanceId?: string            // unique instance UUID
  },
  caps?: string[],                 // capability flags, see §3.4
  commands?: string[],             // slash commands this client supports
  permissions?: Record<string, boolean>,
  pathEnv?: string,
  role?: string,                   // "operator" (default), "node", etc.
  scopes?: string[],               // e.g. ["operator.admin"]
  device?: {                       // device-based auth
    id: string,
    publicKey: string,
    signature: string,
    signedAt: number,              // timestamp ms
    nonce: string
  },
  auth?: {                         // auth credentials
    token?: string,                // shared secret token
    bootstrapToken?: string,       // first-time setup token
    deviceToken?: string,          // device-issued JWT
    password?: string              // password auth
  },
  locale?: string,
  userAgent?: string
}
```

### 3.3 Client Identity

> Source: `packages/gateway-protocol/src/client-info.ts` → `GATEWAY_CLIENT_IDS`, `GATEWAY_CLIENT_MODES`, `GATEWAY_CLIENT_CAPS`

**Client IDs** (for ClawWork, use `openclaw-macos`):

| ID                    | Purpose               |
| --------------------- | --------------------- |
| `webchat-ui`          | Browser WebChat UI    |
| `webchat`             | WebChat client        |
| `openclaw-control-ui` | Admin Control UI      |
| `openclaw-tui`        | Terminal UI client    |
| `openclaw-macos`      | macOS desktop app     |
| `openclaw-ios`        | iOS app               |
| `openclaw-android`    | Android app           |
| `cli`                 | Command-line client   |
| `gateway-client`      | Generic SDK client    |
| `node-host`           | Remote compute node   |
| `test`                | Automated testing     |
| `fingerprint`         | Device fingerprinting |
| `openclaw-probe`      | Health probing        |

**Client Modes:**

| Mode      | Purpose                                   |
| --------- | ----------------------------------------- |
| `webchat` | WebChat UI interface                      |
| `cli`     | Command-line interface                    |
| `ui`      | Desktop/Mobile UI (use this for ClawWork) |
| `backend` | Backend service                           |
| `node`    | Remote compute node                       |
| `probe`   | Health check probing                      |
| `test`    | Automated testing                         |

### 3.4 Capability Negotiation

Capabilities are requested in `ConnectParams.caps` and gate access to specific event streams.

| Capability    | Effect                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| `tool-events` | Enables receiving `agent` events with tool-call details. Without this cap, tool events are not sent to the client. |

### 3.5 HelloOk Response

> Source: `packages/gateway-protocol/src/schema/frames.ts` → `HelloOkSchema`, `packages/gateway-protocol/src/schema/snapshot.ts` → `SnapshotSchema`

```typescript
{
  type: "hello-ok",
  protocol: 3,
  server: {
    version: string,     // e.g. "2026.4.2"
    connId: string       // UUID for this connection
  },
  features: {
    methods: string[],   // all available RPC methods
    events: string[]     // all possible event types
  },
  snapshot: {
    presence: PresenceEntry[],    // who is connected
    health: HealthSnapshot,       // system health
    stateVersion: {
      presence: number,
      health: number
    },
    uptimeMs: number,
    configPath?: string,
    stateDir?: string,
    sessionDefaults?: {
      defaultAgentId: string,     // default agent ID
      mainKey: string,            // main session key template
      mainSessionKey: string,     // resolved main session key
      scope?: string
    },
    authMode?: "none" | "token" | "password" | "trusted-proxy",
    updateAvailable?: {
      currentVersion: string,
      latestVersion: string,
      channel: string
    }
  },
  canvasHostUrl?: string,
  auth?: {
    deviceToken: string,    // issued device token (store for reconnection)
    role: string,
    scopes: string[],
    issuedAtMs?: number
  },
  policy: {
    maxPayload: number,        // bytes per frame (25MB)
    maxBufferedBytes: number,  // per-connection buffer limit (50MB)
    tickIntervalMs: number     // heartbeat interval (30s)
  }
}
```

---

## 4. Events (Server → Client)

Gateway broadcasts 24 event types. All events use the Event Frame format.

### 4.1 Event Types

> Source: `src/gateway/server-methods-list.ts` → `GATEWAY_EVENTS`, `src/gateway/server-broadcast.ts` → `EVENT_SCOPE_GUARDS`

| Event                       | Payload                                      | `dropIfSlow`          | Scope Guard          | Purpose                    |
| --------------------------- | -------------------------------------------- | --------------------- | -------------------- | -------------------------- |
| `connect.challenge`         | `{ nonce, ts }`                              | No                    | —                    | Auth handshake             |
| `chat`                      | ChatEvent                                    | delta: Yes, final: No | —                    | Message streaming          |
| `agent`                     | AgentEvent                                   | Tool: Yes             | —                    | Agent execution events     |
| `session.message`           | varies                                       | No                    | `operator.read`      | Per-session message events |
| `session.tool`              | varies                                       | No                    | `operator.read`      | Per-session tool events    |
| `sessions.changed`          | varies                                       | No                    | `operator.read`      | Session list changed       |
| `presence`                  | PresenceEntry[]                              | No                    | —                    | Client connect/disconnect  |
| `tick`                      | `{ ts }`                                     | Yes                   | —                    | Heartbeat (30s)            |
| `health`                    | HealthSnapshot                               | Yes                   | —                    | System health (60s)        |
| `heartbeat`                 | varies                                       | Yes                   | —                    | Agent heartbeat ACK        |
| `shutdown`                  | `{ reason, restartExpectedMs? }`             | No                    | —                    | Graceful shutdown          |
| `talk.mode`                 | varies                                       | No                    | —                    | Voice mode change          |
| `cron`                      | CronEvent                                    | No                    | —                    | Cron job events            |
| `node.pair.requested`       | varies                                       | No                    | `operator.pairing`   | Node pairing request       |
| `node.pair.resolved`        | varies                                       | No                    | `operator.pairing`   | Node pairing result        |
| `node.invoke.request`       | varies                                       | No                    | —                    | Node task dispatch         |
| `device.pair.requested`     | varies                                       | No                    | `operator.pairing`   | Device pairing request     |
| `device.pair.resolved`      | varies                                       | No                    | `operator.pairing`   | Device pairing result      |
| `voicewake.changed`         | varies                                       | No                    | —                    | Voice wake config          |
| `exec.approval.requested`   | varies                                       | No                    | `operator.approvals` | Execution approval         |
| `exec.approval.resolved`    | varies                                       | No                    | `operator.approvals` | Approval resolution        |
| `plugin.approval.requested` | varies                                       | No                    | `operator.approvals` | Plugin install approval    |
| `plugin.approval.resolved`  | varies                                       | No                    | `operator.approvals` | Plugin approval resolution |
| `update.available`          | `{ currentVersion, latestVersion, channel }` | No                    | —                    | Software update            |

**2026-09-09 更新：源里存在、上表没有的事件（36 个）**

> ⚠️ 只列**名字**（`GATEWAY_EVENTS` 里数出来的）。**payload / dropIfSlow / scope 没有验**，
> 所以不填 —— 填了就是猜。上表那 24 行的 payload 列同理**未重验**。

`chat.metadata.changed` · `ui.command` · `session.approval` · `session.observer` ·
`session.operation` · `session.sharing` · `session.sharing.evidence` · `session.suggestion` ·
`session.typing` · `controlUi.sessionPullRequests.changed` · `plugins.controlUi.changed` ·
`talk.event` · `gateway.suspension` · `task` · `task.suggestion` · `node.presence` ·
`node.hostStats` · `node.invoke.cancel` · `node.invoke.input` · `node.runnerInventory.changed` ·
`device.pair.changed` · `device.pair.setup.completed` · `device.pair.setup.deliveryUncertain` ·
`users.prefs.changed` · `skills.changed` · `voicewake.routing.changed` · `question.requested` ·
`question.resolved` · `openclaw.approval.requested` · `openclaw.approval.resolved` ·
`terminal.data` · `terminal.exit` · `portal.changed` · `progressCard.changed` ·
`mentions.changed` · `update.run.changed`

（`update.available` 上表已有；它是 `GATEWAY_EVENT_UPDATE_AVAILABLE` 常量的值，**在源里不是字面量**，
所以按常量解析后比对。）

**Scope Guards:**

- `operator.admin` — has access to all scoped events
- `operator.read` — session message/tool/changed events
- `operator.write` — write methods (implied by `operator.read` check)
- `operator.approvals` — exec and plugin approval events
- `operator.pairing` — device/node pairing events

### 4.2 Chat Event (event: `chat`)

> Source: `packages/gateway-protocol/src/schema/logs-chat.ts` → `ChatEventSchema`

The primary event for receiving AI responses. Streams incrementally.

```typescript
{
  runId: string,          // unique run identifier
  sessionKey: string,     // session this message belongs to
  seq: number,            // monotonic sequence within the run
  state: "status" | "delta" | "final" | "aborted" | "error",
  message?: {
    role: "assistant",
    content: [{ type: "text", text: string }],
    timestamp: number
  },
  errorMessage?: string,  // when state="error"
  usage?: unknown,        // token usage info
  stopReason?: string     // when state="final", e.g. "end_turn"
}
```

**State machine:**

```
         ┌─────────┐
         │  delta   │──► (repeated, throttled at 150ms)
         └────┬────┘
              │
    ┌─────────┼─────────┐
    ▼         ▼         ▼
 ┌──────┐ ┌───────┐ ┌───────┐
 │final │ │aborted│ │ error │
 └──────┘ └───────┘ └───────┘

  (status — 旁路，见下)
```

- **delta**: Streamed text fragment. Throttled at 150ms intervals. `message.content[0].text` contains the **full accumulated text** up to this point (not just the delta).
  ⚠️ **协议 v4 起还有两个增量字段**：`deltaText`（**本次增量**）与 `replace`（`true` ⇒ `deltaText` 是**全文重写**）。
  取错会把全文当增量拼起来 —— 实测膨胀 **5–57 倍**。详见 §0.4。
- **final**: Complete response. Contains final text (or `undefined` message if suppressed). May include `stopReason`.
- **aborted**: User-initiated abort via `chat.abort`.
- **error**: Execution failure. `errorMessage` contains details. `errorKind` 是**结构化类别**
  （`refusal` / `timeout` / `rate_limit` / `context_length` / `unknown`，`ChatEventErrorKindSchema`）。
  ⚠️ `errorCode` / `error` **在协议 schema 里不存在** —— 想按错误码分流是走不通的，用它。
- **status**（2026-09-19 补）：`ChatStatusEventSchema` —— **准备阶段的 chat 投影**，
  带 `phase`（7 个启动相位之一）与可选的 `retry:{attempt,maxAttempts,reason}`。
  ⚠️ 它此前**没被列在这里**，而正文那个 `state` 类型字面量也不含它 ⇒ 照着写的消费者会把它当"未知"。
  它和 agent 流的 `run_status` **讲同一件事**（相位清单逐字相同），消费一个即可。

> **`state` 的权威来源**：`ChatEventSchema = Type.Union([Status, Delta, Final, Aborted, Error])`
> —— **五个 schema 的联合**（`logs-chat.ts`）。任何"只有四个"的写法都是**样本**，不是契约。

### 4.3 Agent Event (event: `agent`)

> Source: `packages/gateway-protocol/src/schema/agent.ts` → `AgentEventSchema`

Requires `caps: ["tool-events"]` capability. Provides granular agent execution visibility.

```typescript
{
  runId: string,                    // same as chat event runId
  seq: number,                      // monotonic within the run
  stream: string,                   // event stream type
  ts: number,                       // timestamp in milliseconds
  sessionKey?: string,              // added by server for routing
  data: Record<string, unknown>     // stream-specific data
}
```

**Stream types**（⚠️ **数出来的**：扫运行时代码里的 `stream:` 字面量 —— **不保证全集**。
表里标 ✅ 的是我们**已接**的，🔇 的是**刻意不接**的，⛔ 是**声明了但一个发射点都没有**的）：

| stream              | data fields                                                                                                | description                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `assistant` ✅      | `{ text, delta }`                                                                                          | Text generation fragment               |
| `tool` ✅           | `{ phase, name, toolCallId, args?, result?, partialResult?, meta?, isError?, commandBearing? }`            | Tool invocation                        |
| `item` ✅           | `{ itemId, kind, phase, toolCallId?, name?, title?, progressText?, status?, meta?, startedAt?, endedAt? }` | Human-readable "what is it doing" feed |
| `lifecycle` ✅      | `{ phase, error?, stopReason? }`                                                                           | Run lifecycle                          |
| `error` ✅          | `{ reason, expected?, received? }`                                                                         | Sequence errors                        |
| `thinking` ✅       | `{ text?（**累计快照**）, delta?（本次增量）, progressTokens? }`                                           | 推理过程（取错会重复）                 |
| `run_status` ✅     | `{ phase, … }` — 8 个相位（7 启动 + `retrying`，带 `{attempt,maxAttempts}`）                               | 「走到哪一步了」                       |
| `compaction` ✅     | `{ phase:"start"\|"end", itemId, willRetry?, completed? }`                                                 | 上下文压缩                             |
| `approval` ✅       | `{ phase:"requested"\|"resolved", kind, status, toolCallId?, command?, reason?, message? }`                | 审批（**命令没跑成的真相只在这里**）   |
| `usage` 🔇          | —                                                                                                          | 刻意不接                               |
| `patch` 🔇          | —                                                                                                          | 只对 `apply_patch` 发                  |
| `command_output` 🔇 | —                                                                                                          | exec 实时输出                          |
| `stdout` 🔇         | —                                                                                                          | 同上                                   |
| `stderr` 🔇         | —                                                                                                          | 同上                                   |
| `acp` 🔇            | —                                                                                                          | ACP 桥                                 |
| `plan` 🔇           | `{ phase, title, steps, explanation }`                                                                     | 由内建工具 `progress_card` 产生        |

> ⚠️ 本文此前只列了 5 个 stream。**"只列了 5 个"不等于"只有 5 个"** —— 这正是这份文档
> 反复吃亏的地方：一个不求全的清单被当成契约读。
> ✅ **可机械核对的替代**：连上之后看 `hello-ok.features.events / methods` —— 那是网关
> **自己**声明的能力面（§3.5），比本文的清单可靠。

> ⚠️ **Corrected 2026-09-19 against the runtime we actually ship (`2026.9.3`).**
> This section previously documented the tool phases as `start` / `end` and did not list
> `item` at all. That content was reverse-engineered from OpenClaw **2026.4.2**
> (see the header note) — in 2026.9.3 **`end` is never emitted for `stream: "tool"`**.
> Method: every `emitAgentEvent` / `emitTrackedItemEvent` call site in
> `runtime/deployed/2026.9.3-*/node_modules/openclaw/dist/*.mjs` was scanned for the
> `stream:` / `phase:` / `status:` literals. Values below are **observed**, not inferred.

**Tool event phases** (**数出来的** —— 生产代码 25 个 `stream:"tool"` 发射点逐个取；
没有集中的类型定义 ⇒ **不保证全集**):

- `phase: "start"` — invocation begins: `name`, `toolCallId`, `args`
- `phase: "update"` — progress: `partialResult` only (**no** `args`, **no** `result`)
- `phase: "result"` — invocation finished: `result`, `isError`, `meta`.
  **Failures are `isError: true`, not a separate phase** (there is no `phase: "error"` on this stream)
- `phase: "review"` — approval review: `approvalReviewOutcome`, `hideFromChannelProgress: true`
- **`phase: "input_delta"`**（2026-09-19 补）— live edit diff
  （`handlers.messages.update.ts`）。此前这份名单写的是"四个"，**漏了它**。

⚠️ Because `update` carries neither `args` nor `result`, a consumer that lets later frames
overwrite earlier ones will **lose the arguments and the output**, and can flip a finished
call back to "running". Merge by `toolCallId`; never overwrite with `undefined`.

⚠️ **`ExecToolDetails.status` 是个闭合联合**（`bash-tools.exec-types.ts`），四个分支：
`running` / `completed|failed` / **`approval-pending`** / **`approval-unavailable`**。
**后两个都不代表"跑完了"**，而工具流那一帧上**两个都带 `isError: false`**（原因不同：
前者不在 `isToolResultError` 的失败清单里且没有 `exitCode`；后者在清单里但被
`approvalUnavailable` 压掉）⇒ **照 `isError` 落地会把"没跑的命令"显示成"已完成"**。
详见 §0.4。

**Item stream kinds**（**权威来源是类型定义**，`src/infra/agent-activity-events.ts`）:

```ts
type AgentItemEventKind = 'tool' | 'command' | 'patch' | 'search' | 'analysis' | (string & {});
```

- `tool` — echoes a tool invocation, adding a gateway-composed `title` ("tool name + args summary")
- `command` — shell/exec items; carries live output, and may be `status: "blocked"`
- `patch` — `apply_patch` only
- `preamble` — model-authored progress text in `progressText`
- ⚠️ `search` / `analysis` 在**类型里声明了，但一个发射点都没有**（实测）。
- ⚠️ **`kind` 是这份名单里唯一"开放"的字段**（`(string & {})`）。

**Item phases / statuses**（**权威来源同上，是类型定义 —— 不是"自由字段"**）:

```ts
type AgentItemEventPhase = 'start' | 'update' | 'end';
type AgentItemEventStatus = 'running' | 'completed' | 'failed' | 'blocked';
```

- ⚠️ 本文此前写的是「observed `item.status`: `running`, `blocked`（treat the set as open
  — it is a free-form field, not a schema-validated enum）」—— **两处都不对**：
  漏了 `completed`/`failed`，而"自由字段"的说法**是错的**（它是个字面量联合）。
  ⇒ 按"开放集"读会把 `completed` 当成认不出的值；按"只有两个"读会让
  `phase:"end"` 落进"已结束" —— 而 **`blocked` 意味着命令压根没执行**。
- `blocked` = **没执行**（被拦下），**不是**"执行了但失败"（那是 `failed`）。

**Lifecycle event phases**（**数出来的 + 抄运行时代码里的注释** —— 没有集中的类型定义，
**不保证全集**）：

- `phase: "start"` — agent run begins
- `phase: "end"` — agent run completes normally, may include `stopReason`
- `phase: "error"` — agent run failed, includes `error`
- `phase: "fallback"` — provider/model fallback: `selectedProvider`, `selectedModel`, `activeProvider`, `activeModel`
- **`phase: "fallback_step"`** / **`phase: "fallback_cleared"`** — 逐个候选尝试的过程 / 切回来
- **`phase: "finishing"`** — ⚠️ **不是结束**：还有后续尝试时发的"本 attempt 收尾"
  （运行时注释：_"Finishing is an attempt fence, not the outer execution's final publication"_；
  `terminalLifecyclePhase: attempt.deferTerminalLifecycle ? "finishing" : "end"` —— **它替代 `end`**）。
  ⇒ **按 `end` 处理会在 agent 还在干活时把活动条收掉。**
  ⚠️ 补一句方法上的教训：它是**变量**发的，**扫字面量扫不到** —— 本文前述"observed"名单
  正是这么漏掉它的。

**Tool Event Delivery:**
Tool events use **targeted delivery**, not broadcast. Only connections that:

1. Have `caps: ["tool-events"]`
2. Are registered for the specific `runId`

receive tool events. Registration happens automatically when a client sends `chat.send`. TTL is 10 minutes (refreshed on activity), with a 30-second grace period after run finalization.

### 4.4 Broadcast Behavior

> Source: `src/gateway/server-broadcast.ts` → `createGatewayBroadcaster`

- Events broadcast to **all connected clients** (except targeted tool events)
- **No server-side session filtering** — client must route by `sessionKey`
- Slow consumers (bufferedAmount > 50MB) are disconnected with code `1008`
- Events marked `dropIfSlow: true` are silently dropped for slow consumers instead of disconnecting
- Global `seq` counter for ordering broadcast events

---

## 5. RPC Methods Reference

### 5.1 Complete Method List

> Source: `src/gateway/methods/core-descriptors.ts`（元组数组）→ `src/gateway/server-methods-list.ts` → `listGatewayMethods()`
>
> ⚠️ **2026-09-09 更新（口径变了，不只是数字变了）**：
>
> 1. 方法目录**不再是一串名字**，而是 `GatewayMethodDescriptor` 元组：
>    `["<方法>", "<area>", "<scope>", "<since>", { startup }?]`，字段有
>    `since` / `scope` / `profileAccess` / `startup` / `controlPlaneWrite` / `advertise`。
>    ⇒ **方法有了"从哪个版本开始存在"的语义**，客户端可以据此做能力探测。
> 2. **数量：111 → 424**（同一文件里的元组行数）。`since` 标 `<=2026.7` 之外的有 **158 个**。
> 3. **scope 分布**：`operator.read` 145、`operator.admin` 122、`operator.write` 86、
>    `operator.approvals` 16、`operator.talk` 14、`operator.pairing` 14、`dynamic` 11、
>    `node` 11、`operator.questions` 5。
> 4. **新增子系统**（成批出现）：`question.*`、`users.authConnect.*`、`environments.*`、
>    `worktrees.*`、`skills.library.*`、`audit.*`、`exec.approval.grants.*`、`board.*`、
>    `canvas.*`、`portals.*`、`artifacts.*`、`migrations.*`、`gateway.suspend.*`、`openclaw.*`。
> 5. ⚠️ **确认删除的 4 个**（全库宽松搜索都找不到）：`sessions.unsubscribe`、
>    `node.pair.request`、`node.pair.verify`、`node.canvas.capability.refresh`。
>    （`sessions.subscribe` 还在；`node.pair.requested`/`resolved` 是**事件**不是方法。）
>
> ⚠️ 下面这份清单是 **2026.4.2 时代的快照**，**不再完整**（缺 ~313 个）。
> 权威清单看源码；**逐方法的参数/返回值本轮没有重验**（见 §0.3）。

```
health                    doctor.memory.status      logs.tail
channels.status           channels.logout
status                    usage.status              usage.cost
tts.status                tts.providers             tts.enable
tts.disable               tts.convert               tts.setProvider
config.get                config.set                config.apply
config.patch              config.schema             config.schema.lookup
exec.approvals.get        exec.approvals.set        exec.approvals.node.get
exec.approvals.node.set   exec.approval.request     exec.approval.waitDecision
exec.approval.resolve
plugin.approval.request   plugin.approval.waitDecision
plugin.approval.resolve
wizard.start              wizard.next               wizard.cancel
wizard.status
talk.config               talk.speak                talk.mode
models.list               tools.catalog             tools.effective
agents.list               agents.create             agents.update
agents.delete             agents.files.list         agents.files.get
agents.files.set
skills.status             skills.bins               skills.install
skills.update
update.run
voicewake.get             voicewake.set
secrets.reload            secrets.resolve
sessions.list             sessions.create           sessions.send
sessions.subscribe        sessions.unsubscribe
sessions.messages.subscribe                          sessions.messages.unsubscribe
sessions.abort            sessions.preview          sessions.patch
sessions.reset            sessions.delete           sessions.compact
sessions.usage
last-heartbeat            set-heartbeats            wake
node.pair.request         node.pair.list            node.pair.approve
node.pair.reject          node.pair.verify
device.pair.list          device.pair.approve       device.pair.reject
device.pair.remove        device.token.rotate       device.token.revoke
node.rename               node.list                 node.describe
node.pending.drain        node.pending.enqueue      node.pending.pull
node.pending.ack          node.invoke               node.invoke.result
node.event                node.canvas.capability.refresh
cron.list                 cron.status               cron.add
cron.update               cron.remove               cron.run
cron.runs
gateway.identity.get      system-presence           system-event
send                      poll                      push.test
agent                     agent.identity.get        agent.wait
chat.history              chat.abort                chat.send
```

Channel plugins may register additional methods.

### 5.2 Chat Methods (Core for ClawWork)

> Source: schema `packages/gateway-protocol/src/schema/logs-chat.ts`, impl `src/gateway/server-methods/chat.ts`

#### `chat.send`

Send a user message to a session. Triggers agent execution and streaming response.

```typescript
// Request
{
  sessionKey: string,               // e.g. "agent:main:clawwork:task:<taskId>" (max 512 chars)
  message: string,                  // user message text
  thinking?: string,                // thinking/reasoning prompt level
  deliver?: boolean,                // false = no external channel delivery (use false)
  originatingChannel?: string,      // source channel (for cross-channel routing)
  originatingTo?: string,           // originating recipient
  originatingAccountId?: string,    // originating account
  originatingThreadId?: string,     // originating thread
  attachments?: unknown[],          // file attachments
  timeoutMs?: number,               // request timeout
  systemInputProvenance?: {         // input source tracking
    kind: string,                   // provenance kind
    originSessionId?: string,
    sourceSessionKey?: string,
    sourceChannel?: string,
    sourceTool?: string
  },
  systemProvenanceReceipt?: string,
  idempotencyKey: string            // UUID for deduplication (REQUIRED)
}

// Response
{
  ok: true,
  payload: {
    runId: string,                  // use this to correlate chat/agent events
    sessionId: string
  }
}
```

After `chat.send` returns, the response streams via `event:"chat"` and `event:"agent"` broadcasts.

#### `chat.history`

Fetch session message history.

```typescript
// Request
{
  sessionKey: string,
  limit?: number,                   // 1-1000, default 200
  maxChars?: number                 // 1-500,000 — cap total character count in response
}

// Response
{
  ok: true,
  payload: {
    messages: Array<{
      role: "user" | "assistant" | "system",
      content: Array<{ type: string, text?: string, ... }>,
      timestamp?: number
    }>
  }
}
```

Max response size: 6 MB.

#### `chat.abort`

Abort an ongoing agent run.

```typescript
// Request
{
  sessionKey: string,
  runId?: string                    // specific run to abort; if omitted, aborts current
}
```

After abort, a `chat` event with `state: "aborted"` is broadcast.

#### `chat.inject`

Inject a system message into a session (admin/testing).

```typescript
// Request
{
  sessionKey: string,
  message: string,
  label?: string                    // max 100 chars
}
```

### 5.3 Session Methods

> Source: schema `packages/gateway-protocol/src/schema/sessions.ts`, impl `src/gateway/server-methods/sessions.ts`

#### `sessions.create`

Create a new session explicitly.

```typescript
// Request
{
  key?: string,                     // explicit session key (auto-generated if omitted)
  agentId?: string,                 // bind to specific agent
  label?: string,                   // session label (max 64 chars)
  model?: string,                   // override model
  parentSessionKey?: string,        // parent session (for sub-agents)
  task?: string,                    // task description
  message?: string                  // initial message
}
```

#### `sessions.send`

Send a message to a session (higher-level than `chat.send`).

```typescript
// Request
{
  key: string,
  message: string,
  thinking?: string,
  attachments?: unknown[],
  timeoutMs?: number,
  idempotencyKey?: string
}
```

#### `sessions.abort`

Abort a running session.

```typescript
// Request
{
  key: string,
  runId?: string                    // specific run to abort
}
```

#### `sessions.subscribe` / `sessions.unsubscribe`

Subscribe to or unsubscribe from session list change events (`sessions.changed`).

#### `sessions.messages.subscribe` / `sessions.messages.unsubscribe`

Subscribe to or unsubscribe from per-session message events (`session.message`, `session.tool`).

```typescript
// Request
{
  key: string; // session key to subscribe/unsubscribe
}
```

#### `sessions.usage`

Analyze token usage with date filtering and context weight breakdown.

```typescript
// Request
{
  key?: string,                     // specific session (omit for all)
  startDate?: string,               // "YYYY-MM-DD"
  endDate?: string,                 // "YYYY-MM-DD"
  mode?: "utc" | "gateway" | "specific",
  utcOffset?: string,               // e.g. "UTC-4" or "UTC+5:30"
  limit?: number,                   // max sessions to return (default 50)
  includeContextWeight?: boolean    // include systemPromptReport
}
```

#### `sessions.list`

```typescript
// Request
{
  limit?: number,
  activeMinutes?: number,           // filter: only sessions active within N minutes
  includeGlobal?: boolean,
  includeUnknown?: boolean,
  includeDerivedTitles?: boolean,   // reads first 8KB per session (expensive)
  includeLastMessage?: boolean,     // reads last 16KB per session (expensive)
  label?: string,                   // filter by label
  spawnedBy?: string,               // filter by parent session
  agentId?: string,                 // filter by agent
  search?: string                   // text search
}
```

#### `sessions.preview`

Get preview snippets for multiple sessions.

```typescript
// Request
{
  keys: string[],                   // session keys (min 1)
  limit?: number,
  maxChars?: number                 // min 20
}

// Response per session
{
  key: string,
  status: "missing" | "empty" | "ok" | "error",
  items: object[]
}
```

#### `sessions.patch`

Modify session metadata.

```typescript
// Request
{
  key: string,
  label?: string | null,
  thinkingLevel?: string | null,
  fastMode?: boolean | null,
  verboseLevel?: string | null,
  reasoningLevel?: string | null,
  responseUsage?: "off" | "tokens" | "full" | "on" | null,
  elevatedLevel?: string | null,
  execHost?: string | null,
  execSecurity?: string | null,
  execAsk?: string | null,
  execNode?: string | null,
  model?: string | null,            // override LLM model for this session
  spawnedBy?: string | null,
  spawnedWorkspaceDir?: string | null,
  spawnDepth?: number | null,
  subagentRole?: "orchestrator" | "leaf" | null,
  subagentControlScope?: "children" | "none" | null,
  sendPolicy?: "allow" | "deny" | null,
  groupActivation?: "mention" | "always" | null
}
```

#### `sessions.reset`

```typescript
{
  key: string,
  reason?: "new" | "reset"          // "new" = fresh session, "reset" = restart context
}
```

#### `sessions.delete`

```typescript
{
  key: string,
  deleteTranscript?: boolean,       // also remove transcript files
  emitLifecycleHooks?: boolean      // emit lifecycle hooks (default true)
}
```

#### `sessions.compact`

Compress session transcript.

```typescript
{
  key: string,
  maxLines?: number                 // min 1
}
```

### 5.4 Agent Methods

> Source: `packages/gateway-protocol/src/schema/agent.ts` → `AgentParamsSchema`, `AgentIdentityParamsSchema`, `AgentWaitParamsSchema`

#### `agent`

Full-featured agent invocation (superset of `chat.send`).

```typescript
{
  message: string,                  // REQUIRED
  agentId?: string,                 // specific agent
  provider?: string,                // override provider
  model?: string,                   // override model
  to?: string,                      // delivery target
  replyTo?: string,                 // reply to message
  sessionId?: string,
  sessionKey?: string,
  thinking?: string,
  deliver?: boolean,
  attachments?: unknown[],
  channel?: string,
  replyChannel?: string,
  accountId?: string,
  replyAccountId?: string,
  threadId?: string,
  groupId?: string,
  groupChannel?: string,
  groupSpace?: string,
  timeout?: number,                 // ms
  bestEffortDeliver?: boolean,
  lane?: string,                    // concurrency lane
  extraSystemPrompt?: string,       // additional system instructions
  internalEvents?: AgentInternalEvent[],
  inputProvenance?: InputProvenance,
  idempotencyKey: string,           // REQUIRED
  label?: string                    // session label
}
```

#### `agent.identity.get`

```typescript
// Request
{ agentId?: string, sessionKey?: string }

// Response
{
  agentId: string,
  name?: string,
  avatar?: string,                  // avatar file path
  emoji?: string                    // emoji identifier
}
```

#### `agent.wait`

Wait for an agent run to complete.

```typescript
// Request
{ runId: string, timeoutMs?: number }
```

### 5.5 Agent & Model Management

> Source: `packages/gateway-protocol/src/schema/agents-models-skills.ts`

#### `agents.list`

```typescript
// Response
{
  defaultId: string,
  mainKey: string,
  scope: "per-sender" | "global",
  agents: Array<{
    id: string,
    name?: string,
    identity?: {
      name?: string,
      theme?: string,
      emoji?: string,
      avatar?: string,
      avatarUrl?: string
    }
  }>
}
```

#### `agents.create`

```typescript
// Request
{ name: string, workspace: string, emoji?: string, avatar?: string }

// Response
{ ok: true, agentId: string, name: string, workspace: string }
```

#### `agents.update`

```typescript
{ agentId: string, name?: string, workspace?: string, model?: string, avatar?: string }
```

#### `agents.delete`

```typescript
{ agentId: string, deleteFiles?: boolean }
// Response: { ok: true, agentId: string, removedBindings: number }
```

#### `agents.files.list` / `agents.files.get` / `agents.files.set`

Manage agent configuration files (system prompt, etc).

```typescript
// files.list
{ agentId: string }
// Response: { agentId, workspace, files: AgentFileEntry[] }

// files.get
{ agentId: string, name: string }
// Response: { agentId, workspace, file: AgentFileEntry }

// files.set
{ agentId: string, name: string, content: string }
// Response: { ok: true, agentId, workspace, file: AgentFileEntry }

// AgentFileEntry
{
  name: string,
  path: string,
  missing: boolean,
  size?: number,
  updatedAtMs?: number,
  content?: string
}
```

#### `models.list`

```typescript
// Response
{
  models: Array<{
    id: string;
    name: string;
    provider: string;
    contextWindow?: number;
    reasoning?: boolean;
  }>;
}
```

#### `tools.catalog`

```typescript
// Request
{ agentId?: string, includePlugins?: boolean }

// Response
{
  agentId: string,
  profiles: Array<{
    id: "minimal" | "coding" | "messaging" | "full",
    label: string
  }>,
  groups: Array<{
    id: string,
    label: string,
    source: "core" | "plugin",
    pluginId?: string,
    tools: Array<{
      id: string,
      label: string,
      description: string,
      source: "core" | "plugin",
      pluginId?: string,
      optional?: boolean,
      defaultProfiles: ("minimal" | "coding" | "messaging" | "full")[]
    }>
  }>
}
```

### 5.6 External Messaging

> Source: `packages/gateway-protocol/src/schema/agent.ts` → `SendParamsSchema`, `PollParamsSchema`

#### `send`

Send a message to an external channel (Telegram, Discord, etc).

```typescript
{
  to: string,                       // recipient identifier
  message?: string,
  mediaUrl?: string,                // single media URL
  mediaUrls?: string[],             // multiple media URLs
  gifPlayback?: boolean,
  channel?: string,                 // target channel plugin
  accountId?: string,
  agentId?: string,                 // for media root resolution
  threadId?: string,                // channel-specific thread
  sessionKey?: string,              // mirror output to transcript
  idempotencyKey: string
}
```

#### `poll`

Create a poll in an external channel.

```typescript
{
  to: string,
  question: string,
  options: string[],                // 2-12 options
  maxSelections?: number,           // 1-12
  durationSeconds?: number,         // 1-604,800 (7 days)
  durationHours?: number,
  silent?: boolean,                 // no notification
  isAnonymous?: boolean,
  threadId?: string,
  channel?: string,
  accountId?: string,
  idempotencyKey: string
}
```

### 5.7 Configuration Methods

> Source: `packages/gateway-protocol/src/schema/config.ts`

#### `config.get` / `config.set` / `config.patch` / `config.apply`

Read and modify server configuration at runtime.

#### `config.schema` / `config.schema.lookup`

Get JSON Schema for configuration validation.

### 5.8 Cron Methods

> Source: `packages/gateway-protocol/src/schema/cron.ts`

Scheduled task management.

#### `cron.add`

```typescript
{
  name: string,
  agentId?: string | null,
  sessionKey?: string | null,
  description?: string,
  enabled?: boolean,
  deleteAfterRun?: boolean,
  schedule: CronSchedule,
  sessionTarget: "main" | "isolated" | "current" | "session:...",
  wakeMode: "next-heartbeat" | "now",
  payload: CronPayload,
  delivery?: CronDelivery,
  failureAlert?: false | CronFailureAlert
}
```

**Schedule types:**

```typescript
// One-time
{ kind: "at", at: string }                    // ISO datetime

// Interval
{ kind: "every", everyMs: number, anchorMs?: number }

// Cron expression
{ kind: "cron", expr: string, tz?: string, staggerMs?: number }
```

**Payload types:**

```typescript
// System event
{ kind: "systemEvent", text: string }

// Agent turn
{
  kind: "agentTurn",
  message: string,
  model?: string,
  fallbacks?: string[],
  thinking?: string,
  timeoutSeconds?: number,
  deliver?: boolean,
  channel?: string,
  to?: string,
  bestEffortDeliver?: boolean
}
```

#### `cron.list`

```typescript
{
  includeDisabled?: boolean,
  limit?: number,                   // 1-200
  offset?: number,
  query?: string,
  enabled?: "all" | "enabled" | "disabled",
  sortBy?: "nextRunAtMs" | "updatedAtMs" | "name",
  sortDir?: "asc" | "desc"
}
```

#### `cron.run`

```typescript
{ id: string, mode?: "due" | "force" }
// or
{ jobId: string, mode?: "due" | "force" }
```

#### `cron.runs`

Get execution history.

```typescript
{
  scope?: "job" | "all",
  id?: string,
  jobId?: string,
  limit?: number,                   // 1-200
  offset?: number,
  statuses?: ("ok" | "error" | "skipped")[],
  deliveryStatuses?: ("delivered" | "not-delivered" | "unknown" | "not-requested")[],
  query?: string,
  sortDir?: "asc" | "desc"
}
```

#### `tools.effective`

> Source: `packages/gateway-protocol/src/schema/agents-models-skills.ts` → `ToolsEffectiveParamsSchema`, `ToolsEffectiveResultSchema`

Get session-effective tool inventory (what tools are actually available for a session at runtime).

```typescript
// Request
{ agentId?: string, sessionKey?: string }

// Response
{
  groups: Array<{
    id: string,
    label: string,
    tools: Array<{
      id: string,
      label: string,
      description: string,
      enabled: boolean,
      source: "core" | "plugin",
      pluginId?: string
    }>
  }>
}
```

### 5.9 Skills Methods

> Source: `packages/gateway-protocol/src/schema/agents-models-skills.ts` → `SkillsStatusParamsSchema`, `SkillsInstallParamsSchema`, `SkillsUpdateParamsSchema`

#### `skills.status`

```typescript
{ agentId?: string }
```

#### `skills.install`

```typescript
{ name: string, installId: string, timeoutMs?: number }  // min 1000ms
```

#### `skills.update`

```typescript
{ skillKey: string, enabled?: boolean, apiKey?: string, env?: Record<string, string> }
```

### 5.10 Node Methods

> Source: `packages/gateway-protocol/src/schema/nodes.ts`

Remote compute node management.

| Method                 | Purpose                  |
| ---------------------- | ------------------------ |
| `node.list`            | List connected nodes     |
| `node.describe`        | Get node capabilities    |
| `node.rename`          | Rename a node            |
| `node.invoke`          | Execute command on node  |
| `node.invoke.result`   | Return invocation result |
| `node.event`           | Report node event        |
| `node.pending.enqueue` | Queue work for a node    |
| `node.pending.drain`   | Drain pending queue      |
| `node.pending.pull`    | Pull next pending item   |
| `node.pending.ack`     | Acknowledge completion   |
| `node.pair.request`    | Initiate pairing         |
| `node.pair.list`       | List pairing requests    |
| `node.pair.approve`    | Approve pairing          |
| `node.pair.reject`     | Reject pairing           |
| `node.pair.verify`     | Verify paired node       |

### 5.11 Device Methods

> Source: `packages/gateway-protocol/src/schema/devices.ts`

Device authentication lifecycle.

| Method                | Purpose                      |
| --------------------- | ---------------------------- |
| `device.pair.list`    | List pending device pairings |
| `device.pair.approve` | Approve device               |
| `device.pair.reject`  | Reject device                |
| `device.pair.remove`  | Remove paired device         |
| `device.token.rotate` | Rotate device token          |
| `device.token.revoke` | Revoke device token          |

### 5.12 Execution Approval

> Source: `packages/gateway-protocol/src/schema/exec-approvals.ts`

Interactive approval workflow for agent actions.

| Method                       | Purpose                        |
| ---------------------------- | ------------------------------ |
| `exec.approval.request`      | Request approval for an action |
| `exec.approval.waitDecision` | Wait for approval decision     |
| `exec.approval.resolve`      | Approve or reject              |
| `exec.approvals.get`         | Get approval settings          |
| `exec.approvals.set`         | Set approval settings          |
| `exec.approvals.node.get`    | Get node approval settings     |
| `exec.approvals.node.set`    | Set node approval settings     |

### 5.13 Plugin Approval

> Source: `packages/gateway-protocol/src/schema/plugin-approvals.ts`

Interactive approval workflow for plugin installations.

| Method                         | Purpose                       |
| ------------------------------ | ----------------------------- |
| `plugin.approval.request`      | Request approval for a plugin |
| `plugin.approval.waitDecision` | Wait for approval decision    |
| `plugin.approval.resolve`      | Approve or reject             |

### 5.14 Talk (Voice/TTS) Methods

> Source: `packages/gateway-protocol/src/schema/channels.ts` → `TalkSpeakParamsSchema`, `TalkSpeakResultSchema`, `TalkModeParamsSchema`, `TalkConfigResultSchema`

#### `talk.speak`

Text-to-speech synthesis.

```typescript
// Request
{
  text: string,                     // REQUIRED
  voiceId?: string,
  modelId?: string,
  outputFormat?: string,
  speed?: number,
  stability?: number,
  similarity?: number,
  style?: number,
  speakerBoost?: boolean,
  seed?: number,
  normalize?: string,
  language?: string
}

// Response
{
  audioBase64: string,              // base64-encoded audio
  provider: string,
  outputFormat?: string,
  voiceCompatible?: boolean,
  mimeType?: string,
  fileExtension?: string
}
```

### 5.15 Push Notification Testing

> Source: `packages/gateway-protocol/src/schema/push.ts` → `PushTestParamsSchema`, `PushTestResultSchema`

#### `push.test`

Test push notification delivery.

### 5.16 Web Login

> Source: `packages/gateway-protocol/src/schema/channels.ts` → `WebLoginStartParamsSchema`, `WebLoginWaitParamsSchema`

#### `web.login.start` / `web.login.wait`

Web-based login flow (e.g. WhatsApp QR scan).

```typescript
// web.login.start
{
  force?: boolean,
  timeoutMs?: number,
  verbose?: boolean,
  accountId?: string
}

// web.login.wait
{
  timeoutMs?: number,
  accountId?: string
}
```

### 5.17 Other Methods

| Method                            | Purpose                                             |
| --------------------------------- | --------------------------------------------------- |
| `health`                          | Gateway health status                               |
| `status`                          | System status                                       |
| `usage.status`                    | Token/cost usage stats                              |
| `usage.cost`                      | Cost breakdown                                      |
| `logs.tail`                       | Stream gateway log lines                            |
| `gateway.identity.get`            | Gateway instance identity                           |
| `system-presence`                 | Current presence snapshot                           |
| `system-event`                    | Emit system event                                   |
| `wake`                            | `{ mode: "now" \| "next-heartbeat", text: string }` |
| `wizard.start/next/cancel/status` | Onboarding wizard                                   |
| `channels.status`                 | Channel connection status (with optional probe)     |
| `channels.logout`                 | Disconnect channel                                  |
| `update.run`                      | Trigger software update                             |
| `doctor.memory.status`            | Memory diagnostics                                  |

---

## 6. HTTP Endpoints

> Source: `src/gateway/server-http.ts`, `src/gateway/openai-http.ts`

In addition to WebSocket, Gateway exposes HTTP endpoints:

| Path                   | Method  | Purpose                      |
| ---------------------- | ------- | ---------------------------- |
| `/health`, `/healthz`  | GET     | Liveness probe               |
| `/ready`, `/readyz`    | GET     | Readiness probe              |
| `/v1/chat/completions` | POST    | OpenAI-compatible chat API   |
| `/v1/responses`        | POST    | OpenResponses API            |
| Agent avatar URLs      | GET     | Serve agent avatar images    |
| Canvas WS path         | WS      | Canvas collaboration         |
| Plugin routes          | Various | Channel plugin HTTP handlers |

The `/v1/chat/completions` endpoint allows OpenAI-compatible integration, but for ClawWork the WebSocket protocol is the primary interface.

---

## 7. Authentication

### 7.1 Auth Modes

> Source: `packages/gateway-protocol/src/schema/snapshot.ts` → `SnapshotSchema.authMode`

Gateway supports four authentication modes (configured server-side):

| Mode            | ConnectParams field | Description                 |
| --------------- | ------------------- | --------------------------- |
| `none`          | —                   | No auth required            |
| `token`         | `auth.token`        | Shared secret token         |
| `password`      | `auth.password`     | Password authentication     |
| `trusted-proxy` | —                   | Trust reverse proxy headers |

Device-based auth (`auth.deviceToken` or `device.*` fields) is an additional layer.

### 7.2 Rate Limiting

> Source: `src/gateway/auth-rate-limit.ts` → `RateLimitConfig`, defaults: `DEFAULT_MAX_ATTEMPTS=10`, `DEFAULT_WINDOW_MS=60_000`, `DEFAULT_LOCKOUT_MS=300_000`

| Scope           | Max Attempts | Window | Lockout |
| --------------- | ------------ | ------ | ------- |
| `shared-secret` | 10           | 60s    | 300s    |
| `device-token`  | 10           | 60s    | 300s    |
| `hook-auth`     | 20           | 60s    | 300s    |
| `default`       | 10           | 60s    | 300s    |

Loopback addresses (`127.0.0.1`, `::1`) are exempt by default.

### 7.3 Roles & Scopes

> Source: `src/gateway/method-scopes.ts` → `ADMIN_SCOPE`, `READ_SCOPE`, `WRITE_SCOPE`, `APPROVALS_SCOPE`, `PAIRING_SCOPE`, `METHOD_SCOPE_GROUPS`, `NODE_ROLE_METHODS`

Roles control method and event access:

- `operator` — default role for human users
- `node` — compute node role

Scopes (carried in `ConnectParams.scopes`):

- `operator.admin` — full access; supersedes all other scopes
- `operator.read` — read-only access (status, list, history, usage, config.get)
- `operator.write` — write access (send, chat.send, agent, sessions.create, talk, node.invoke, etc.); implies read
- `operator.approvals` — exec and plugin approval events and methods
- `operator.pairing` — device/node pairing events and methods

---

## 8. Session Key Format

> Source: `packages/gateway-protocol/src/schema/primitives.ts` → `ChatSendSessionKeyString` (regex: max 512 chars), `packages/gateway-protocol/src/schema/sessions.ts` → `SessionsCreateParamsSchema`

Session keys uniquely identify conversation contexts:

```
agent:<agentKey>:<scope>:<label>
```

For ClawWork:

```
agent:main:clawwork:task:<taskId>
```

- Sessions are created implicitly on first `chat.send`
- Each session maintains an independent conversation transcript
- Sessions persist across reconnections
- Sessions auto-reset at 4 AM (configurable server-side)

---

## 9. Message Format

> Source: `packages/gateway-protocol/src/schema/logs-chat.ts` → `ChatEventSchema.message`, `packages/gateway-protocol/src/schema/agent.ts` → content block types

Messages in `chat` events and `chat.history` responses follow this structure:

```typescript
{
  role: "user" | "assistant" | "system",
  content: ContentBlock[],
  timestamp?: number
}

// ContentBlock types
{ type: "text", text: string }
// (other types: image, file, tool_use, tool_result, etc.)
```

---

## 10. ClawWork Integration Guide

> Source: composite — see inline references in §2–§9; connection flow from `packages/gateway-protocol/src/schema/frames.ts` → `ConnectParamsSchema`, `HelloOkSchema`

### 10.1 Connection Setup

1. Open WebSocket to `ws://localhost:18789`
2. Wait for `connect.challenge` event
3. Send `connect` request with:
   - `client.id`: `"openclaw-macos"`
   - `client.mode`: `"ui"`
   - `caps`: `["tool-events"]`
   - `auth`: appropriate credentials
4. Receive `hello-ok` with server snapshot
5. Store `auth.deviceToken` for reconnection

### 10.2 Sending a Message

```typescript
// 1. Send chat.send
ws.send(
  JSON.stringify({
    type: 'req',
    id: uuid(),
    method: 'chat.send',
    params: {
      sessionKey: `agent:main:clawwork:task:${taskId}`,
      message: 'Hello',
      deliver: false,
      idempotencyKey: uuid(),
    },
  }),
);

// 2. Listen for response
// { type: "res", id: "...", ok: true, payload: { runId: "...", sessionId: "..." } }

// 3. Listen for streaming events
// event: "chat" with state: "delta" (repeated)
// event: "agent" with stream: "tool" (if tool-events cap)
// event: "chat" with state: "final" (once)
```

### 10.3 Capabilities ClawWork Can Leverage

| Capability            | Gateway Support                                | ClawWork Feature             |
| --------------------- | ---------------------------------------------- | ---------------------------- |
| Multi-session         | `sessions.list`, `sessions.create`             | Parallel task execution      |
| Streaming responses   | `chat` events with delta/final                 | Real-time response rendering |
| Tool visibility       | `agent` events with tool-events cap            | Tool-call progress UI        |
| Session management    | `sessions.patch`, `sessions.reset`             | Task configuration           |
| Session subscriptions | `sessions.subscribe`, `sessions.messages.*`    | Real-time session updates    |
| Model selection       | `models.list`, `sessions.patch(model)`         | Per-task model override      |
| Agent management      | `agents.*` methods                             | Multi-agent workflows        |
| Cron scheduling       | `cron.*` methods                               | Automated recurring tasks    |
| Message history       | `chat.history`                                 | Session restoration          |
| Abort                 | `chat.abort`, `sessions.abort`                 | Cancel running tasks         |
| Usage tracking        | `usage.status`, `usage.cost`, `sessions.usage` | Token/cost dashboard         |
| Skills                | `skills.*` methods                             | Skill management UI          |
| Exec approval         | `exec.approval.*` events/methods               | Interactive approval gates   |
| Plugin approval       | `plugin.approval.*` events/methods             | Plugin install gates         |
| Health monitoring     | `health` events                                | Server status indicator      |
| Thinking/reasoning    | `sessions.patch(thinkingLevel)`                | Thinking mode toggle         |
| TTS                   | `talk.speak`                                   | Text-to-speech playback      |
| Tools inventory       | `tools.catalog`, `tools.effective`             | Tool management UI           |

### 10.4 What ClawWork Should NOT Do

- Do NOT use `deliver: true` in `chat.send` (this sends to external channels)
- Do NOT use `send` method (this is for external channel delivery)
- Do NOT create custom channel plugins
- Do NOT bypass Gateway with direct agent engine access
- Do NOT rely on server-side session filtering (filter by sessionKey client-side)

---

## 11. Quick Source Index

All sources are annotated inline at each section. This condensed index maps domain → primary schema file for fast lookup.

> ⚠️ **2026-09-09 更新**：schema 整棵树从 `src/gateway/protocol/schema/` **搬到了**
> `packages/gateway-protocol/src/schema/`（17 个文件 1:1，文件名全保留）。本表已按新路径改写。
> ⚠️ 但**这张表已不再完整**：新 schema 文件成批出现（`artifacts` / `audit` / `board` / `canvas` /
> `channel-pairing` / `commands` / `desktop` / `environments` / `fs` / `hooks` /
> `human-mentions` / `migrations` / `portals` …），权威清单请看
> `packages/gateway-protocol/src/schema/` 目录本身。

| Domain           | Schema File                                                    | Implementation                                                          |
| ---------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Frames           | `packages/gateway-protocol/src/schema/frames.ts`               | `src/gateway/server/`（`server.impl.ts` **已拆成一批模块**）            |
| Chat             | `packages/gateway-protocol/src/schema/logs-chat.ts`            | `src/gateway/server-methods/chat.ts`                                    |
| Sessions         | `packages/gateway-protocol/src/schema/sessions.ts`             | `src/gateway/server-methods/sessions-*.ts`（原 `sessions.ts` **已拆**） |
| Agent            | `packages/gateway-protocol/src/schema/agent.ts`                | —                                                                       |
| Agents/Models    | `packages/gateway-protocol/src/schema/agents-models-skills.ts` | —                                                                       |
| Cron             | `packages/gateway-protocol/src/schema/cron.ts`                 | —                                                                       |
| Nodes            | `packages/gateway-protocol/src/schema/nodes.ts`                | —                                                                       |
| Devices          | `packages/gateway-protocol/src/schema/devices.ts`              | —                                                                       |
| Config           | `packages/gateway-protocol/src/schema/config.ts`               | —                                                                       |
| Exec Approvals   | `packages/gateway-protocol/src/schema/exec-approvals.ts`       | —                                                                       |
| Plugin Approvals | `packages/gateway-protocol/src/schema/plugin-approvals.ts`     | —                                                                       |
| Methods list     | `src/gateway/server-methods-list.ts`                           | —                                                                       |
| Method scopes    | `src/gateway/method-scopes.ts`                                 | —                                                                       |
| Broadcast        | `src/gateway/server-broadcast.ts`                              | —                                                                       |
| Constants        | `src/gateway/server-constants.ts`                              | —                                                                       |
| Rate limit       | `src/gateway/auth-rate-limit.ts`                               | —                                                                       |
| Error codes      | `packages/gateway-protocol/src/schema/error-codes.ts`          | —                                                                       |
| Client IDs       | `packages/gateway-protocol/src/client-info.ts`                 | —                                                                       |
| Primitives       | `packages/gateway-protocol/src/schema/primitives.ts`           | —                                                                       |
