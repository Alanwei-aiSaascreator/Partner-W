/**
 * 「网关为什么没起来」的**公开**原因。
 *
 * 为什么要有这个类型：界面上必须说清楚"是哪一类失败"，而**原始错误不能上界面** ——
 * 它可能带着 Token、地址、堆栈、甚至别人的手机号（这些都会进 IPC、日志与截图）。
 * 所以对外只有一个**闭集**：界面上要说的每一句话，都对应这里的一个值；
 * 说不清的那一类**必须**落 `unknown`，宁可说"不知道"也不许猜。
 *
 * ⚠️ 这是 B 线定的契约，C 线只消费它 —— 加值之前先想清楚"界面上说什么"。
 */
export type GatewayFailureReason =
  /** 18789 被**别的**网关占着（不是我们的），我们不会去关它。 */
  | 'port-occupied'
  /** 认证不匹配：Token/凭据对不上，再等也不会好。 */
  | 'auth-rejected'
  /** 我们自己的网关**子进程很快就退出了**（快 ⇒ 值得短退避重试）。 */
  | 'process-exited'
  /** 等就绪**等满了超时**（慢 ⇒ 终态，绝不重试三次）。 */
  | 'ready-timeout'
  /** 说不清就是说不清 —— **不猜**。 */
  | 'unknown';

/**
 * 「本机运行时（我们**自己**那个网关）起没起来」——**能过 IPC 的那一部分**。
 *
 * ⚠️ 与"网关状态"（连上了没有）是两层事：端口被**别的**程序占着时，往往连 WS 都
 *    没建起来 —— 从连接层一个字都读不到，界面只能一直显示"正在准备模型"。
 * ⚠️ 定义在 shared 是**故意的**：这个形状要跨三道边界（主进程 → IPC → 渲染层），
 *    每一层各写一遍就会漂移。
 */
export type RuntimeBootstrapStatus = { ok: true } | { ok: false; reason: GatewayFailureReason };

/** 闭集本体（测试按它断言"多一个值都要先想清楚界面上说什么"）。 */
export const GATEWAY_FAILURE_REASONS = [
  'port-occupied',
  'auth-rejected',
  'process-exited',
  'ready-timeout',
  'unknown',
] as const satisfies readonly GatewayFailureReason[];

/** 中转（runtime bootstrap）那两个码到公开原因的映射。 */
const FROM_BOOTSTRAP_CODE: Readonly<Record<string, GatewayFailureReason>> = {
  'runtime.gateway-port-occupied': 'port-occupied',
  'runtime.gateway-process-exited': 'process-exited',
  'runtime.gateway-ready-timeout': 'ready-timeout',
};

const AUTH_REJECTED_WS_ERROR_CODE = 'AUTH_TOKEN_MISMATCH';
/** 1008 = 服务端明确拒绝（WebSocket policy violation）。 */
const POLICY_VIOLATION_CLOSE_CODE = 1008;

export interface GatewayFailureSignals {
  /** 中转 bootstrap 的失败码（`runtime.*`）。不认识 ⇒ 不猜。 */
  bootstrapCode?: string | undefined;
  /** WS 层看到的错误码（如 `AUTH_TOKEN_MISMATCH`）。 */
  wsErrorCode?: string | null | undefined;
  /** WS 关闭码（1008 = 明确拒绝）。 */
  closeCode?: number | undefined;
}

/**
 * 信号 → 公开原因。判定优先级：**更具体的那条赢**
 * （中转码 > WS 错误码 > 关闭码），其余一律 `unknown`。
 *
 * ⚠️ 白名单，不是黑名单：将来多一个中转码，这里**不会**自动把它说成某一类 ——
 * 它只会落 `unknown`，直到有人明确写清那一类在界面上该说什么。
 */
export function gatewayFailureReasonFrom(input: GatewayFailureSignals): GatewayFailureReason {
  if (input.bootstrapCode !== undefined) {
    const mapped = FROM_BOOTSTRAP_CODE[input.bootstrapCode];
    if (mapped !== undefined) return mapped;
  }
  if (input.wsErrorCode === AUTH_REJECTED_WS_ERROR_CODE) return 'auth-rejected';
  if (input.closeCode === POLICY_VIOLATION_CLOSE_CODE) return 'auth-rejected';
  return 'unknown';
}
