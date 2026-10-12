import type { GatewayConnectionStatus } from '@clawwork/core';
import type {
  GatewayFailureReason,
  ModelCatalogEntry,
  RelayBootstrapBlockedCode,
  RelayBootstrapPublicState,
  RelayBootstrapRetryableCode,
  RelayMediaReadiness,
  WorkspaceFsIdentity,
} from '@clawwork/shared';
import { deriveModelAvailability } from '@/components/ChatInput/model-availability';
import type { ModelStatusCopy } from '@/components/ChatInput/model-availability';
import { relayModelsFrom } from '@/components/ChatInput/model-families';
import type { PresetAgentBootstrapPhase, PresetAgentBootstrapSnapshot } from '@/lib/preset-agent-bootstrap';

export type StartupAiPhase = 'starting' | 'loading-models' | 'catalog-failed' | 'ready' | 'error';
export type StartupAssistantPhase = 'waiting' | Exclude<PresetAgentBootstrapPhase, 'idle'>;
export type StartupRetry = () => Promise<void>;

/**
 * 中转失败的**出口**分类 —— 界面按它决定"给哪个按钮、说哪句话"。
 *
 * ⚠️ 判据是**安全码与相位的配对**（闭集，来自 `@clawwork/shared`），绝不是"有没有出错"：
 *    确定性拒绝（激活 / 卡绑在别的组织 / 卡失效）与暂时失败（网络、会话、网关还没起来）
 *    的**出口完全相反** —— 前者要用户去做点什么，后者"再试一次"才有意义。
 *    把暂时失败说成终局 = 冤枉用户；把终局说成"再试试" = 请用户做无用功。
 */
export type StartupRelayFailureKind =
  | 'activation-required'
  | 'organization-mismatch'
  | 'entitlement-rejected'
  | 'activation-limit-reached'
  | 'retryable';

/**
 * 助手失败时**已知的**硬障碍（`null` = 没有结论）。
 *
 * 为什么单独一档：真机上（FAT32 的盘）六个预置助手全报 `unsafe workspace file`，
 * 而界面上只有一句「助手失败」+ 助手名 —— 用户**无从知道要换一块盘**。
 * 这两种障碍**重试一万次也不会变**，出口是"换个工作区/换块盘"，与"再试一次"相反。
 *
 * ⚠️ 判据是**两个独立信号都对上**：助手确实失败了 **且** 文件系统探测量到了问题。
 *    只有前者 ⇒ 说不出所以然（照旧走通用那句）；只有后者 ⇒ 探测可能是错的，不许冤枉好盘。
 */
export type StartupAssistantBlocker = 'workspace-filesystem-unsupported' | 'workspace-unwritable';

/** 已知障碍该说的那句话（面板与欢迎屏共用同一份）。 */
export function startupBlockerText(blocker: StartupAssistantBlocker | null, t: (key: string) => string): string | null {
  if (blocker === 'workspace-filesystem-unsupported') return t('startupReadiness.workspaceFilesystemUnsupported');
  if (blocker === 'workspace-unwritable') return t('startupReadiness.workspaceUnwritable');
  return null;
}

export interface StartupRelayFailure {
  kind: StartupRelayFailureKind;
  /** 公开 DTO 的安全码**原样保留**：它是闭集，不是服务端原文（原文只在主进程调试日志里）。 */
  errorCode: RelayBootstrapBlockedCode | RelayBootstrapRetryableCode;
}

/**
 * 公开状态 → 界面出口。`null` = **没有失败结论**。
 *
 * ⚠️ `idle` / `running` / `ready` 一律 `null`：`idle` 同时覆盖"从没跑过"与"显式登出"
 *    （见 `@clawwork/shared` 的相位说明），把它当失败就会在登录页旁边挂一条假错误；
 *    `ready` 只说明中转配置在网关上 —— 目录到没到是另一回事，照旧由目录推断。
 */
export function relayFailureFrom(state: RelayBootstrapPublicState): StartupRelayFailure | null {
  if (state.phase === 'blocked') {
    // `license_required` 是**本地状态**（这台机器上没有可用的卡），出口是去激活；
    // `license_bound_elsewhere` 是服务端的确定性拒绝，出口是激活/换账号；
    // `activation_limit_reached` 是**这张卡的名额满了** —— 换卡/找客服，与"卡失效"不同档；
    // 其余五个确定性码一起归"这张卡已经不能用了"。
    if (state.errorCode === 'license_required') return { kind: 'activation-required', errorCode: state.errorCode };
    if (state.errorCode === 'license_bound_elsewhere') {
      return { kind: 'organization-mismatch', errorCode: state.errorCode };
    }
    if (state.errorCode === 'activation_limit_reached') {
      return { kind: 'activation-limit-reached', errorCode: state.errorCode };
    }
    return { kind: 'entitlement-rejected', errorCode: state.errorCode };
  }
  if (state.phase === 'retryable-error') return { kind: 'retryable', errorCode: state.errorCode };
  return null;
}

/**
 * 已知的中转失败该说哪一句（面板与欢迎屏工作台**共用这一份**）。
 *
 * ⚠️ 判据是**出口**（`kind`），不是"有没有出错"：四档要用户去激活/换卡/找客服
 * （再等、再试都一样），只有一档才值得说"再试一次"。混成一句的结果不是说得不准，
 * 而是**把用户送去等一件永远不会发生的事**（第二台机器那次实机的形状）。
 * ⚠️ 同屏两处（面板 + 欢迎屏工作台）必须说**同一句话**：两处不一样，用户只会更糊涂。
 */
export function relayFailureText(failure: StartupRelayFailure, t: (key: string) => string): string {
  if (failure.kind === 'activation-required') return t('startupReadiness.relayActivationRequired');
  if (failure.kind === 'organization-mismatch') return t('startupReadiness.relayOrganizationMismatch');
  if (failure.kind === 'entitlement-rejected') return t('startupReadiness.relayEntitlementRejected');
  if (failure.kind === 'activation-limit-reached') return t('startupReadiness.relayActivationLimitReached');
  return t('startupReadiness.relayRetryable');
}

/**
 * **网关起不来**时那句**具体**的话（`null` = 没有具体结论，交给通用那句）。
 *
 * ⭐ C2：原来四类失败共用一句「暂时没有可用模型」，可它们该做的事完全不同 ——
 * 端口被别的程序占着（去关掉它）、凭据被拒（去查激活/网关）、我们自己子进程早退
 * （重新准备多半有用）、等就绪等满超时（这台机器上它起不来）。
 *
 * ⚠️ `unknown` **一律返回 `null`**：它就是"说不清"，返回一句具体的话等于替它编。
 *    调用方接着落到 `startupReadiness.aiError`（笼统但**不假**）。
 * ⚠️ 被拒那句**不许出现任何凭据类字样**：这句要过 IPC、上界面、进截图。
 */
export function gatewayFailureText(readiness: StartupReadiness, t: (key: string) => string): string | null {
  const reason = readiness.ai.failureReason ?? null;
  if (reason === 'port-occupied') return t('startupReadiness.gatewayPortOccupied');
  if (reason === 'state-migration-blocked') return t('startupReadiness.gatewayStateMigrationBlocked');
  if (reason === 'auth-rejected') return t('startupReadiness.gatewayAuthRejected');
  if (reason === 'process-exited') return t('startupReadiness.gatewayProcessExited');
  if (reason === 'ready-timeout') return t('startupReadiness.gatewayReadyTimeout');
  // ⭐ 2026-10-07：从盘上准备运行环境失败单独一档 —— 它的出口在**盘上**
  // （插好盘 / 换回随附那块 / 解除写保护 / 换一份完整的），与上面四类"去关别的程序 /
  // 去查激活"完全不同。原来这一类落 `unknown`，界面上只剩一句笼统的"准备遇到了问题"，
  // 而**最有用的那句话只在日志里**。
  if (reason === 'deploy-failed') return t('startupReadiness.gatewayDeployFailed');
  // ⭐ BUG-064（2026-10-10，换电脑卡 17% 现场）：随盘运行环境（Node）起不来的五档 ——
  //    每档一句**具体**的话 + 各自可执行的下一步（补盘 / 加白名单 / 稍候重试 / 换盘）。
  //    「重新准备」按钮由面板既有规则提供（hasError ⇒ retry），这里只管把话说清楚。
  if (reason === 'node-missing') return t('startupReadiness.gatewayNodeMissing');
  if (reason === 'node-permission-denied') return t('startupReadiness.gatewayNodePermissionDenied');
  if (reason === 'node-probe-timeout') return t('startupReadiness.gatewayNodeProbeTimeout');
  if (reason === 'node-exec-failed') return t('startupReadiness.gatewayNodeExecFailed');
  if (reason === 'node-version-unsupported') return t('startupReadiness.gatewayNodeVersionUnsupported');
  return null;
}

/**
 * 就绪度里**已知失败**的那句话（`null` = 没有已知失败）。
 *
 * 欢迎屏工作台那一格用它：原来 `!ready` 一律转圈 + 说"正在启动 AI 服务"，
 * 于是一条真话（面板里那句）与正下方一个转圈**同屏** —— 那正是本任务要消灭的画面。
 * ⚠️ 判据全部取自**已经算好的**就绪度（`relayFailure` 与 AI 相位），不在这里重新推断目录。
 */
export function startupFailureText(readiness: StartupReadiness, t: (key: string) => string): string | null {
  // 中转的失败最具体，也唯一带出口：有它就说它。
  if (readiness.relayFailure) return relayFailureText(readiness.relayFailure, t);
  // 目录那两档也是有结论的失败，同样不该被说成"还在准备"。
  if (readiness.ai.phase === 'catalog-failed') return t('startupReadiness.aiCatalogFailed');
  // ⭐ 网关**说得出是哪一类**时，那句比通用的具体得多（C2）。
  const gatewayFailure = gatewayFailureText(readiness, t);
  if (gatewayFailure) return gatewayFailure;
  if (readiness.ai.phase === 'error') return t('startupReadiness.aiError');
  // ⭐ 助手的失败里，**文件系统**那一档是有结论的（重试不会变），必须说出来 ——
  //    否则用户按面板上那句"重新准备"再点一百次，也还是六个助手全失败。
  const blocker = startupBlockerText(readiness.assistantBlocker ?? null, t);
  if (blocker) return blocker;
  // 助手那一档（AI 已就绪、只是助手没装完）不是"模型不可用"，这一格没有话要说。
  return null;
}

/**
 * **已知的中转失败**时输入框上模型那一格说什么。
 *
 * ⚠️ 为什么必须覆盖：目录那条推断在"还没取到"时给的是 `chatInput.modelsLoadingDetail`
 * （「准备完成后会自动显示，无需重复操作」）—— 那是一句**承诺**。而中转已经给了确定性
 * 结论（卡绑在别的组织 / 卡失效）时，那句承诺永远不会兑现：用户照着它等下去只会等到"卡住"。
 * 这里换成**非准备态**的文案，并把出口指到激活页。
 * （`preparing` 必须是 `false`：它同时决定转不转圈，见 ChatInput 的渲染。）
 *
 * 放在这里而不是 `ChatInput/model-availability.ts`：判据是**中转失败**，而失败这件事的定义
 * （`StartupRelayFailure` / `relayFailureFrom`）就在本模块 —— 让消费者的分档逻辑住回判据旁边，
 * 免得 `model-availability.ts` 反过来 import 一个"由它推导出来的东西该长什么样"的类型。
 */
export function relayModelStatusCopy(failure: StartupRelayFailure, t: (key: string) => string): ModelStatusCopy {
  return {
    label: t('chatInput.modelsUnusable'),
    detail:
      failure.kind === 'activation-required'
        ? t('chatInput.relayActivationRequiredDetail')
        : failure.kind === 'organization-mismatch'
          ? t('chatInput.relayOrganizationMismatchDetail')
          : failure.kind === 'entitlement-rejected'
            ? t('chatInput.relayEntitlementRejectedDetail')
            : failure.kind === 'activation-limit-reached'
              ? t('chatInput.relayActivationLimitReachedDetail')
              : // ⚠️ 可重试这一档**不许承诺成功**：`relay_apply_failed` 也可能是确定性的
                //    清理被拒（见 `main/commercial/relay-startup.ts` 的说明），
                //    "再试一次"可以，"马上就好"不行。
                t('chatInput.relayRetryableDetail'),
    preparing: false,
  };
}

export interface StartupReadiness {
  gatewayId: string | null | undefined;
  relayPhase?: RelayBootstrapPublicState['phase'];
  media?: RelayMediaReadiness;
  ai: {
    phase: StartupAiPhase;
    /**
     * 本机运行时**起不来**时的公开原因（`null` = 没有这个结论）。
     *
     * ⚠️ 与 `relayFailure` 是**两件事**，别互相冒充：那是"中转/账号配置"的结论，
     *    这是"18789 那个网关根本没起来"的结论。两者可以同时有值。
     * ⚠️ 与 `relayFailure` 一样，可选是给**手写的就绪度样例**（各处的测试夹具）留的：
     *    缺席与 `null` 同义，消费方一律按真值判断；唯一的产出路径**永远**会赋值。
     */
    failureReason?: GatewayFailureReason | null;
  };
  assistants: Omit<PresetAgentBootstrapSnapshot, 'phase'> & { phase: StartupAssistantPhase };
  workspaceAvailable: boolean;
  conversationReady: boolean;
  /**
   * 输入框该不该拦。**只有"还在准备"才拦**（服务没起来 / 目录还在取）；
   * 一旦有结论（取到了 / 确实没有模型 / 取不到 / 中转失败）就不该再锁着用户。
   */
  composerBlocked: boolean;
  isReady: boolean;
  hasError: boolean;
  /**
   * 已知的中转失败（`null` / 缺省 = **没有结论**）。**它是"猜出来的加载中"的覆盖来源** ——
   * 有它时 `ai.phase` 一定是 `error`（见 `deriveStartupReadiness`）。
   *
   * ⚠️ 可选是给**手写的就绪度样例**（各处的测试夹具）留的：缺席与 `null` 同义，
   *    消费方一律按真值判断即可；`deriveStartupReadiness` 这条唯一的产出路径**永远**会赋值。
   */
  relayFailure?: StartupRelayFailure | null;
  /**
   * 助手失败时的**已知硬障碍**（`null` / 缺省 = 没有结论）。
   * 见 `StartupAssistantBlocker`：两个独立信号都对上才敢说。
   */
  assistantBlocker?: StartupAssistantBlocker | null;
}

interface StartupReadinessInput {
  gatewayId: string | null | undefined;
  gatewayStatus: GatewayConnectionStatus | undefined;
  rawModelCatalog: ModelCatalogEntry[] | undefined;
  catalogFailed: boolean;
  assistantSnapshot: PresetAgentBootstrapSnapshot;
  /** 中转 bootstrap 的公开状态。缺省 = 还没读到（与 `idle` 同义：**不是**失败）。 */
  relayState?: RelayBootstrapPublicState | undefined;
  /** 工作区所在文件系统的探测结果。缺省 / `null` = 还没探测（**不是**"没问题"）。 */
  workspaceFsIdentity?: WorkspaceFsIdentity | null | undefined;
  /**
   * 连接层对**这个网关**的重连信息（`ui-store.gatewayReconnectInfo[gatewayId]`）。
   * 缺省 / `null` = 还没连过（**不是**失败）。
   *
   * ⚠️ 为什么推导必须看它：没有它时，判据只有"连上了没有" ⇒ 连接层**已经放弃**
   *    （`gaveUp`，网关回了 `res.error` 之后以 1008 关闭）也照样是"正在准备模型"，
   *    而那个状态**永远不会自己好**（2026-09-25 真日志：1.8 秒判定端口被占、
   *    2.8 秒连接被拒，界面到 6 分钟后还在转圈）。
   */
  gatewayReconnect?:
    | { attempt: number; max: number; gaveUp: boolean; reason?: GatewayFailureReason }
    | null
    | undefined;
  /**
   * 主进程报来的"本机运行时起不来"的公开原因（`ui-store.runtimeBootstrapFailure`）。
   * 缺省 / `null` = **没有这个结论**（不是"没问题"）。
   *
   * ⚠️ 与 `gatewayReconnect` 分开是因为它们是**两个层**的结论：那是"连了但被拒/放弃了"，
   *    这是"我们自己的网关压根没起来"（端口被别人占着 / 等就绪超时 / 子进程早退）——
   *    后者发生时往往**连 WS 都没建起来**，从连接层一个字都读不到。
   */
  runtimeBootstrapFailure?: GatewayFailureReason | null | undefined;
}

export function deriveStartupReadiness({
  gatewayId,
  gatewayStatus,
  rawModelCatalog,
  catalogFailed,
  assistantSnapshot,
  relayState,
  workspaceFsIdentity,
  gatewayReconnect,
  runtimeBootstrapFailure,
}: StartupReadinessInput): StartupReadiness {
  const modelAvailability = deriveModelAvailability({
    gatewayId,
    gatewayStatus,
    rawCatalog: rawModelCatalog,
    catalogFailed,
    modelCount: relayModelsFrom(rawModelCatalog ?? []).length,
  });
  const inferredPhase: StartupAiPhase =
    modelAvailability === 'service-starting'
      ? 'starting'
      : modelAvailability === 'models-loading'
        ? 'loading-models'
        : modelAvailability === 'catalog-failed'
          ? 'catalog-failed'
          : modelAvailability === 'empty'
            ? 'error'
            : 'ready';
  // ⭐ 2026-09-21（第二台机器的实机形状）：**知道的**压过**猜的**。
  //    目录那条推断在"还没取到"时只会说"正在准备模型" —— 而主进程可能**早就知道**
  //    这张卡绑在别的组织（公开状态里有安全码）。继续显示"正在准备"就是让用户等一件
  //    永远不会发生的事；公开状态是渲染层唯一能看到的那份结论，这里把它接进推导。
  //    ⚠️ 只有 `blocked` / `retryable-error` 会进来（见 `relayFailureFrom`）：
  //    `idle`（从没跑过 / 已登出）、`running`（这一轮在跑）、`ready`（配置已落）
  //    **都不改变**目录推断 —— 否则"还没有结论"会被说成"已经出错了"。
  const relayFailure = relayState ? relayFailureFrom(relayState) : null;
  // ⭐ 连接层**已经放弃**（`gaveUp`）也是一条结论：再转圈就是让用户等一件**不会发生**的事。
  //    真日志（2026-09-25）：1.8 秒就判定端口被占、2.8 秒连接被明确拒绝并给出 `gaveUp`，
  //    而界面到六分钟后还在「正在准备模型」。同一条纪律：**知道的**压过**猜的**。
  const gatewayGaveUp = gatewayReconnect?.gaveUp === true;
  // ⭐ 本机运行时**起不来**（端口被别人占着 / 等就绪超时 / 子进程早退）也是一条结论 ——
  //    而且是最该给出口的那一类：这条路上连 WS 都没建起来，连接层一个字都读不到，
  //    于是界面只会显示"正在准备模型"，一直到用户放弃（2026-09-25 真日志：六分钟）。
  // ⚠️ 但**连上了就不算**：用户可能自己把网关起起来了，或者这一份连的是别的网关 ——
  //    那时候继续挂着"18789 被占用"就是**反向的假话**（明明好了还说坏着）。
  //    所以清理判据是"当前连上了"，不是"曾经失败过"。
  //    第二条来源是**连接层**：网关回了 `res.error` ⇒ 客户端以 1008 关闭并报了
  //    `gaveUp` + 一个公开原因（"是网关不认我们"）。那条路上我们自己的网关是**起来了**的，
  //    所以它完全不经过 `runtimeBootstrapFailure`。
  //    优先级：本机运行时没起来 > 连上了但被拒 —— 前者更接近根因。
  const bootstrapFailure: GatewayFailureReason | null =
    gatewayStatus === 'connected'
      ? null
      : (runtimeBootstrapFailure ?? (gatewayGaveUp ? (gatewayReconnect?.reason ?? null) : null));
  const aiPhase: StartupAiPhase = relayFailure || gatewayGaveUp || bootstrapFailure !== null ? 'error' : inferredPhase;
  const assistantPhase: StartupAssistantPhase =
    !gatewayId || gatewayStatus !== 'connected'
      ? 'waiting'
      : assistantSnapshot.phase === 'idle'
        ? 'verifying'
        : assistantSnapshot.phase;
  const assistants = { ...assistantSnapshot, phase: assistantPhase };
  const isReady = aiPhase === 'ready' && assistantPhase === 'ready';
  const conversationReady = aiPhase === 'ready';
  // ⚠️ 拦输入框的判据**只有一条**：还在准备（服务没起来 / 目录还在取）。
  //    以前是 `!conversationReady`，于是"目录取不到"（相位永远停在 loading）会把用户
  //    **永远**锁在输入框外 —— 打不了字、也看不到任何出错信号（2026-09-20 用户报障）。
  //    一旦有了结论（取到了 / 确实没有模型 / 取不到 / 中转失败），等待就没有意义了，必须给出口。
  //    ⚠️ 已知的中转失败**也是结论**（而且是最该给出口的那一种）：把它算成"还在准备"
  //    就是同一形状的复发 —— 用户又被锁在输入框外，这次连"出错了"都看不到。
  // ⚠️ 这里**不**再单独判 `gaveUp`：上面那一档已经把相位变成 `error`，本式自然为假。
  //    我原先加过一个 `!gatewayGaveUp`，变异电池判定它是**等价变异**（删掉也全绿）⇒ 删掉：
  //    不可被测试证伪的守卫只是噪音（同 [[stale-green-tests]] 那条教训）。
  const composerBlocked = !relayFailure && (aiPhase === 'starting' || aiPhase === 'loading-models');

  // ⭐ 工作区探测的**硬结论**（两次复测都量到）自身就是 blocker —— U1（2026-10 基线审查）：
  //    探测失败时文件系统闸会挡掉助手 bootstrap（`startup-workspace-gate.ts` 硬失败直接
  //    返回），助手**根本跑不起来** —— 旧逻辑"必须等助手也失败"于是永远等不到：准备页
  //    停在 4/6，无 alert、无出口（实跑反例）。`unknown`/未探测保持 null（没量到就**不
  //    下结论**，防冤枉语义保留在探测层：`unsupported-identity` 只在两次复测都为零时成立）。
  const assistantBlocker: StartupAssistantBlocker | null =
    workspaceFsIdentity?.state === 'unsupported-identity'
      ? 'workspace-filesystem-unsupported'
      : workspaceFsIdentity?.state === 'unwritable'
        ? 'workspace-unwritable'
        : null;

  return {
    gatewayId,
    relayPhase: relayState?.phase,
    ...(gatewayId === 'local-runtime' && aiPhase === 'ready' && relayState?.phase === 'ready' && relayState.media
      ? { media: relayState.media }
      : {}),
    ai: { phase: aiPhase, failureReason: bootstrapFailure },
    assistants,
    workspaceAvailable: workspaceFsIdentity?.state === 'ok',
    conversationReady,
    composerBlocked,
    isReady,
    hasError: aiPhase === 'error' || aiPhase === 'catalog-failed' || assistantPhase === 'error',
    relayFailure,
    assistantBlocker,
  };
}
