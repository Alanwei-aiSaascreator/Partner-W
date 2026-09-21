import type { GatewayConnectionStatus } from '@clawwork/core';
import type {
  ModelCatalogEntry,
  RelayBootstrapBlockedCode,
  RelayBootstrapPublicState,
  RelayBootstrapRetryableCode,
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
  | 'retryable';

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
    // 其余六个确定性码一起归"这张卡当前不可用"。
    if (state.errorCode === 'license_required') return { kind: 'activation-required', errorCode: state.errorCode };
    if (state.errorCode === 'license_bound_elsewhere') {
      return { kind: 'organization-mismatch', errorCode: state.errorCode };
    }
    return { kind: 'entitlement-rejected', errorCode: state.errorCode };
  }
  if (state.phase === 'retryable-error') return { kind: 'retryable', errorCode: state.errorCode };
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
    label: t('chatInput.relayUnavailable'),
    detail:
      failure.kind === 'activation-required'
        ? t('chatInput.relayActivationRequiredDetail')
        : failure.kind === 'organization-mismatch'
          ? t('chatInput.relayOrganizationMismatchDetail')
          : failure.kind === 'entitlement-rejected'
            ? t('chatInput.relayEntitlementRejectedDetail')
            : // ⚠️ 可重试这一档**不许承诺成功**：`relay_apply_failed` 也可能是确定性的
              //    清理被拒（见 `main/commercial/relay-startup.ts` 的说明），
              //    "再试一次"可以，"马上就好"不行。
              t('chatInput.relayRetryableDetail'),
    preparing: false,
  };
}

export interface StartupReadiness {
  gatewayId: string | null | undefined;
  ai: { phase: StartupAiPhase };
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
}

interface StartupReadinessInput {
  gatewayId: string | null | undefined;
  gatewayStatus: GatewayConnectionStatus | undefined;
  rawModelCatalog: ModelCatalogEntry[] | undefined;
  catalogFailed: boolean;
  assistantSnapshot: PresetAgentBootstrapSnapshot;
  /** 中转 bootstrap 的公开状态。缺省 = 还没读到（与 `idle` 同义：**不是**失败）。 */
  relayState?: RelayBootstrapPublicState | undefined;
}

export function deriveStartupReadiness({
  gatewayId,
  gatewayStatus,
  rawModelCatalog,
  catalogFailed,
  assistantSnapshot,
  relayState,
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
  const aiPhase: StartupAiPhase = relayFailure ? 'error' : inferredPhase;
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
  const composerBlocked = !relayFailure && (aiPhase === 'starting' || aiPhase === 'loading-models');

  return {
    gatewayId,
    ai: { phase: aiPhase },
    assistants,
    workspaceAvailable: true,
    conversationReady,
    composerBlocked,
    isReady,
    hasError: aiPhase === 'error' || aiPhase === 'catalog-failed' || assistantPhase === 'error',
    relayFailure,
  };
}
