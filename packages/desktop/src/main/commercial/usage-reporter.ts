import { getCommercialClient } from './client.js';
import { getAllGatewayClients } from '../ws/index.js';
import { getDebugLogger } from '../debug/index.js';
import { externalProviderIds, relayConfigGeneration, relayOwnedProviderIds } from './relay-config.js';
import { getLicenseGeneration } from './license-generation.js';
import { getActiveRelayKey } from './relay-key.js';
import {
  createFileAttributionStore,
  createMemoryAttributionStore,
  emptyAttributionState,
  planUsageReports,
  settleExternalReport,
  settleUsageReport,
  type CallTimeEvidence,
  type UsageAttributionState,
  type UsageAttributionStore,
  type UsageObservation,
  type UsageReport,
} from './usage-attribution.js';

/**
 * Usage reporting（BUG-087 / 2026-10-16 用量终审 U1/U2/U3）。
 *
 * 业务层是服务端权威的：这里只把**累计量**交给 `report_usage`，由它对着上次见过的值
 * 做差分。重复发同一个累计量不写账，所以丢/多一个 tick 都不会双扣 —— 前提是
 * **"这堆 token 是谁付的钱"这个判断本身是对的**。
 *
 * ## 走中转服务的调用要跳过
 *
 * 中转服务在**服务端**直接测量 token 并落账。同一次调用如果再从这里上报一次，
 * 就是两条互不相干的账 —— session key 前缀不同（服务端那条是 `relay:<user>:<id>`）、
 * provider 也不同（`bailian` vs 客户端的 provider 名），服务端的差分去重挡不住。
 * 结果是**用户被扣两次**。所以认它们的方式是**看配置**（baseUrl 是否打到中转服务），
 * 不是看名字 —— 理由见 `relay-config.ts`。
 *
 * ## 归属判据（本轮的三处修正）
 *
 * 1. **判断收敛到 `usage-attribution`**：绑定账号/许可证/工作区/配置代次；
 *    relay 粘滞落在**观测键**上而不是 provider 名上（U1：同名 provider 被复用后，
 *    新 session 的合法外部用量不得被永久吞掉）；未知归属一律**隔离**（U2）。
 * 2. **落盘失败不再"下一轮重读旧记录"**（U2）：本轮改过的归属状态留在内存里，
 *    优先于磁盘读回的值；同时本轮按 fail-closed 处理（不再产生新的外部上报）。
 * 3. **协议适配**：随包运行时把用量挂在 `session.usage.modelUsage` 下（U3），
 *    这里按**嵌套形状**解码；旧的扁平 `session.modelUsage` 只作为**显式标注的兼容分支**。
 *
 * ## 默认不发：影子对账 + 受控补报（U3 的接续建议）
 *
 * 修好解码之后，"上报"从"实际什么都没发"变成"真的开始上报"，那是**计费行为变化**。
 * 审计原话：先做可信身份、切换水位与影子对账，再受控开启增量补报。所以：
 *
 *   · **默认 `shadow`**：算出"本应上报什么"、登记影子对账与水位的差值，**一个包都不发**；
 *   · `live` 才真的调 `report_usage`，且**仍然不发 `catch-up`**（历史补报）
 *     —— 除非显式打开 `backfill`。历史账**不追扣**。
 *
 * 两个开关都是显式 + 有文档的，默认关闭（见 `UsageReportingMode` 与
 * `setUsageBackfillEnabled`）。**本轮不打开任何一个。**
 */

const REPORT_INTERVAL_MS = 5 * 60 * 1000;
const RPC_TIMEOUT_MS = 20_000;

/**
 * 上报模式。
 *
 * - `shadow`（**默认**）：只算、只登记影子对账，不发送。
 * - `live`：真的调 `report_usage`（`catch-up` 仍受 `backfill` 开关约束）。
 *
 * 环境变量 `RY_USAGE_REPORT_MODE=live` 可切换；受控启用请用
 * `setUsageReportingMode()`，别在业务代码里散读环境变量。
 */
export type UsageReportingMode = 'shadow' | 'live';

let reportingMode: UsageReportingMode = process.env.RY_USAGE_REPORT_MODE === 'live' ? 'live' : 'shadow';
/**
 * 历史补报（`catch-up`）开关。**默认关**。
 *
 * 打开它才会把"归属从外部转成中转之前观测到的那笔累计量"补报给服务端。
 * 关着的时候那笔只登记在影子对账里 —— **不追扣历史账**。
 */
let backfillEnabled = process.env.RY_USAGE_BACKFILL === '1';

export function setUsageReportingMode(mode: UsageReportingMode): void {
  reportingMode = mode;
}

export function getUsageReportingMode(): UsageReportingMode {
  return reportingMode;
}

export function setUsageBackfillEnabled(enabled: boolean): void {
  backfillEnabled = enabled;
}

export function isUsageBackfillEnabled(): boolean {
  return backfillEnabled;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

type ModelUsageTotals = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

type ModelUsageLine = {
  provider?: string;
  model?: string;
  totals?: ModelUsageTotals;
};

type SessionUsageLine = {
  key?: string;
  /** 随包运行时的**权威**形状：summary 挂在 `usage` 下。 */
  usage?: { modelUsage?: unknown };
  /** 历史夹具形状（扁平）：只作为兼容分支保留。 */
  modelUsage?: unknown;
};

function readSessions(payload: unknown): SessionUsageLine[] {
  if (!payload || typeof payload !== 'object') return [];
  const sessions = (payload as { sessions?: unknown }).sessions;
  return Array.isArray(sessions) ? (sessions as SessionUsageLine[]) : [];
}

/**
 * 一个会话的用量行。
 *
 * ## 权威形状 = 嵌套
 *
 * 随包运行时（openclaw 2026.9.3）`sessions.usage` 的真实返回是：
 *
 * ```
 * { updatedAt, startDate, endDate, totals, aggregates, cacheStatus,
 *   sessions: [ { key, sessionId, agentId, channel, updatedAt, model, usage, … } ] }
 * ```
 *
 * 用量挂在 **`session.usage.modelUsage`** 下 —— handler 把 summary 放进 `usage` 键
 * （`dist/usage-lCaKvodi.mjs` 的 `"sessions.usage"`，逐会话 `sessions.push({..., usage})`），
 * 而 summary 由 `dist/session-cost-usage-*.mjs:1099` 的 `modelUsage: sortedModelUsage(models)`
 * 生成；每条目是 `{ provider, model, count, totals: { input, output, cacheRead, cacheWrite, … } }`。
 *
 * ## 兼容分支 = 扁平（**显式标注，不是权威**）
 *
 * 旧的 `session.modelUsage` 来自 `docs/superpowers/plans/2026-09-10-MVP商业化闭环.md`
 * 的示例代码，**没有真机载荷证据**。留它只为不打断既有夹具；
 * 一旦嵌套形状存在就以嵌套为准（两者同时出现时不看扁平的那份）。
 *
 * 两个形状都读不到 = 本轮没有观测（不误报、不弃报）。
 */
function modelUsageLinesOf(session: SessionUsageLine): ModelUsageLine[] {
  const nested = session.usage?.modelUsage;
  if (Array.isArray(nested)) return nested as ModelUsageLine[];
  if (Array.isArray(session.modelUsage)) return session.modelUsage as ModelUsageLine[];
  return [];
}

/**
 * 网关载荷 → 归属模块的观测列表。
 *
 * ⚠️ 必须带 `agentScope: 'all'`（见 `runUsageReport`）：只发 `{}` 时网关逐个会话
 *    解析归属，碰到没有 owner 的 `main` 会整条拒绝，于是**整个网关被跳过**。
 */
function readObservations(payload: unknown): UsageObservation[] {
  const observations: UsageObservation[] = [];
  for (const session of readSessions(payload)) {
    const sessionKey = session.key;
    if (!sessionKey) continue;

    for (const line of modelUsageLinesOf(session)) {
      if (!line.provider || !line.model) continue;
      const totals = line.totals ?? {};
      observations.push({
        sessionKey,
        provider: line.provider,
        model: line.model,
        // cacheWrite is billed at 125% and cacheRead at 10%; the pricing table
        // carries a single cached rate, and writes are rare, so they share a column.
        totals: {
          input: nonNegative(totals.input),
          output: nonNegative(totals.output),
          cached: nonNegative(totals.cacheRead) + nonNegative(totals.cacheWrite),
        },
      });
    }
  }
  return observations;
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export interface UsageReportOptions {
  /**
   * 注入归属账本（测试用）。缺省 = 生产路径：Electron 下写 userData，其它环境退化成内存
   * （见 `resolveAttributionStore`）—— 单测/开发不该在磁盘上留下计费状态。
   */
  store?: UsageAttributionStore;
}

/**
 * 调用时证据的**身份**部分。
 *
 * 账号从商业会话取（`auth.getUser()`），许可证代次从本地单调计数器取，
 * 工作区从当前配置的工作区路径取。**拿不到就是 `null`，不猜。**
 *
 * ⚠️ 许可证 **id**（`licenses.id`）需要一次后端读取（`readLicenseStatus()`），
 *    代价与频率都不适合放在 5 分钟的 tick 里，所以这里默认 `null`；
 *    需要它的调用方用 `setUsageAttributionIdentityProvider` 注入
 *    （激活/启动期缓存一次即可）。**这是待接线项，不是"已绑定"。**
 */
export interface UsageAttributionIdentity {
  accountId: string | null;
  licenseId: string | null;
  licenseEpoch: number;
  workspaceId: string | null;
}

export type UsageAttributionIdentityProvider = () => Promise<Partial<UsageAttributionIdentity>>;

let identityProvider: UsageAttributionIdentityProvider | null = null;

/** 注入身份来源（激活/启动期接一次即可）。传 `null` 恢复内置默认。 */
export function setUsageAttributionIdentityProvider(provider: UsageAttributionIdentityProvider | null): void {
  identityProvider = provider;
}

async function accountIdFromSession(): Promise<string | null> {
  try {
    const auth = getCommercialClient()?.auth;
    if (!auth) return null;
    const { data } = await auth.getUser();
    const id = (data as { user?: { id?: unknown } } | null)?.user?.id;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

/**
 * **本地持久化配置**里的两个身份字段：工作区路径 + 当前绑定的许可证 id。
 *
 * ## 为什么 `licenseId` 也在这里读（T07 生产接线，2026-10-16）
 *
 * `EvidenceBinding.licenseId` 参与身份比较（`identityChanged`：同账号同代次
 * **只换卡**也必须算身份变化），但生产路径此前从来没填过它 ——
 * `resolveIdentity()` 的注入分支只有测试在用，默认分支恒定 `null`。
 * 后果："换卡"在两台都读不到 licenseId 的机器上**看起来像没换卡**，
 * 旧卡的累计量会被记到新卡头上。
 *
 * 取值来源与 `license.ts` 的 `persistLicenseBinding()` **同一处**
 * （`commercial.licenseBinding`，激活时写、`clearLicense` 时抹）——
 * 便宜的同步读，不需要让 5 分钟一次的 tick 去打一次后端。
 * ⚠️ 这里只映射**形状**，判据归 `license.ts`；两边任何一处改形状都要同步
 *   （`license.ts` 的 `readStoredLicense()` 是它的家）。
 */
async function localIdentityFromConfig(): Promise<{ workspaceId: string | null; licenseId: string | null }> {
  try {
    // 动态 import：单测/纯 Node 环境不该因为这条链被整个拉起来。
    const config = (await import('../workspace/config.js')) as {
      getWorkspacePath?: () => string | null;
      isWorkspaceConfigured?: () => boolean;
      readConfig?: () => { commercial?: { licenseBinding?: { licenseId?: unknown } | undefined } | undefined } | null;
    };
    const boundLicenseId = config.readConfig?.()?.commercial?.licenseBinding?.licenseId;
    const licenseId = typeof boundLicenseId === 'string' && boundLicenseId ? boundLicenseId : null;

    const configured =
      typeof config.isWorkspaceConfigured === 'function' && config.isWorkspaceConfigured()
        ? config.getWorkspacePath?.()
        : null;
    const workspaceId = typeof configured === 'string' && configured ? configured : null;
    return { workspaceId, licenseId };
  } catch {
    return { workspaceId: null, licenseId: null };
  }
}

async function resolveIdentity(): Promise<UsageAttributionIdentity> {
  const base: UsageAttributionIdentity = {
    accountId: null,
    licenseId: null,
    licenseEpoch: getLicenseGeneration(),
    workspaceId: null,
  };
  if (identityProvider) {
    try {
      const injected = await identityProvider();
      return {
        accountId: injected.accountId ?? null,
        licenseId: injected.licenseId ?? null,
        licenseEpoch: typeof injected.licenseEpoch === 'number' ? injected.licenseEpoch : base.licenseEpoch,
        workspaceId: injected.workspaceId ?? null,
      };
    } catch {
      return base;
    }
  }
  // 默认路径补上**配置代次之外的**三个身份字段：账号（会话）、工作区与卡 id（本地配置）。
  const local = await localIdentityFromConfig();
  base.accountId = await accountIdFromSession();
  base.workspaceId = local.workspaceId;
  base.licenseId = local.licenseId;
  return base;
}

/**
 * 在途切换探针：**不需要网关往返**的本地信号。
 *
 * 配置读取发生在本轮开始、用量读取是一次 await；两者之间中转配置被写入/清除
 * （注销、换卡、清理、重新激活）时，本轮读到的累计量就**跨过了切换点** ——
 * 无法判定其中哪一段属于谁 ⇒ 整轮按未知隔离。
 *
 * 只在**内存**里比两个本地量：许可证代次（激活/清卡即 +1）与中转 key 的在位状态。
 * ⚠️ 绝不把 key 本身记进快照 / 日志，这里只取布尔。
 */
function attributionEpochProbe(): string {
  return `${getLicenseGeneration()}\u0000${getActiveRelayKey() ? 'relay-on' : 'relay-off'}`;
}

export async function runUsageReport(options?: UsageReportOptions): Promise<number> {
  if (running) return 0;
  running = true;

  try {
    const supabase = getCommercialClient();
    if (!supabase) return 0;

    const clients = getAllGatewayClients();
    const connected = Array.from(clients.values()).filter((gw) => gw.isConnected);
    if (connected.length === 0) return 0;

    // 归属账本：**一轮读一次、一轮写一次**。半轮状态不落盘。
    const store = await resolveAttributionStore(options?.store);
    const state = readState(store);
    if (!state) return 0;

    const identity = await resolveIdentity();
    const rpc = supabase.rpc.bind(supabase);
    let sent = 0;
    let touched = false;

    for (const gw of connected) {
      // 先认「哪些 provider 走中转」。读不到配置就**整条网关跳过** ——
      // 宁可漏记一个 tick，不可双记：上报是累计量、服务端做差分，
      // 漏一个 tick 只是延迟（下一个 tick 会带完整累计值），
      // 而多报一次是立刻多扣用户的钱。两个方向的代价不对称。
      let snapshot: unknown;
      try {
        snapshot = await gw.getConfig();
      } catch (error) {
        getDebugLogger().warn({
          domain: 'commercial',
          event: 'commercial.usage.gateway-config-failed',
          data: { gatewayId: gw.id, message: error instanceof Error ? error.message : String(error) },
        });
        continue;
      }

      // ⚠️ 必须用**跨已知官方端点**的那一份（`relayOwnedProviderIds`）：换端点后
      //    配置里可能还留着上一个官方端点的 provider，它同样由 relay 服务端计量过。
      //    用只认当前端点的 `relayProviderIds` 会让它落进 `report_usage` ⇒ 双扣。
      const relayProviders = relayOwnedProviderIds(snapshot);
      // 同上，但**反方向**：正面证实为外部端点的 provider（配置里存在且端点不是我们的）。
      // 没有反证的观测由归属模块判成未知并隔离（U2）—— 缺证据 ≠ 是用户的调用。
      const attestedExternal = externalProviderIds(snapshot);
      const generation = relayConfigGeneration(snapshot);

      const epochBefore = attributionEpochProbe();
      let payload: unknown;
      try {
        // ⚠️ 必须带 `agentScope: 'all'`：只发 `{}` 时网关逐个会话解析归属，
        //    碰到没有 owner 的 `main` 会整条拒绝（实机 38 次），于是**整个网关被跳过**、
        //    非中转用量一分都记不上。见 SessionsUsageParamsSchema 的字段注释。
        payload = await gw.getSessionUsage({ agentScope: 'all' });
      } catch (error) {
        getDebugLogger().warn({
          domain: 'commercial',
          event: 'commercial.usage.session-usage-failed',
          data: { gatewayId: gw.id, message: error instanceof Error ? error.message : String(error) },
        });
        continue;
      }
      // 在途切换：用量读取期间配置/身份动过 ⇒ 这一轮的累计量跨了切换点，整轮隔离。
      const inFlightIdentityChanged = attributionEpochProbe() !== epochBefore;

      const observations = readObservations(payload);
      const evidence: CallTimeEvidence = {
        ...identity,
        generation,
        attestedExternalProviderIds: attestedExternal,
      };
      // 归属判据在 `usage-attribution`：绑定调用时证据 + 键级粘滞 + 未知隔离。
      const plan = planUsageReports({
        state,
        gatewayId: gw.id,
        relayOwnedProviderIds: relayProviders,
        evidence,
        inFlightIdentityChanged,
        persistenceDegraded: persistenceDegraded,
        observations,
      });
      touched = true;

      // ── 影子对账：算出"本应上报什么"，**登记**水位差值，不发送 ──────────────
      for (const entry of plan.shadow) {
        getDebugLogger().info({
          domain: 'commercial',
          event: 'commercial.usage.shadow-reconcile',
          data: {
            gatewayId: gw.id,
            sessionKey: entry.sessionKey,
            provider: entry.provider,
            model: entry.model,
            reason: entry.reason,
            ownership: entry.ownership,
            mode: reportingMode,
            deltaInput: entry.delta.input,
            deltaOutput: entry.delta.output,
            deltaCached: entry.delta.cached,
            watermarkInput: entry.watermark.input,
            watermarkOutput: entry.watermark.output,
            watermarkCached: entry.watermark.cached,
            generation,
          },
        });
      }

      for (const report of plan.reports) {
        // 影子模式：一个包都不发（`reports` 已经登记进影子对账）。
        if (reportingMode === 'shadow') continue;
        // 历史补报默认关闭 —— **不追扣历史账**。
        if (report.reason === 'catch-up' && !backfillEnabled) {
          getDebugLogger().info({
            domain: 'commercial',
            event: 'commercial.usage.backfill-skipped',
            data: { gatewayId: gw.id, provider: report.provider, model: report.model },
          });
          continue;
        }

        const { error } = await withTimeout(
          rpc('report_usage', {
            p_session_key: report.sessionKey,
            p_provider: report.provider,
            p_model: report.model,
            p_cum_input: report.totals.input,
            p_cum_output: report.totals.output,
            p_cum_cached: report.totals.cached,
          }),
          RPC_TIMEOUT_MS,
        );

        if (error) {
          // 补报失败不丢：观测值留在账本里，下一轮继续补（服务端差分幂等）。
          getDebugLogger().warn({
            domain: 'commercial',
            event: 'commercial.usage.report-failed',
            data: {
              sessionKey: report.sessionKey,
              provider: report.provider,
              model: report.model,
              reason: report.reason,
              message: error.message,
            },
          });
          continue;
        }

        sent += 1;
        settleReport(state, gw.id, report);
        if (report.reason === 'catch-up') {
          getDebugLogger().info({
            domain: 'commercial',
            event: 'commercial.usage.catch-up-reported',
            data: {
              gatewayId: gw.id,
              provider: report.provider,
              model: report.model,
              input: report.totals.input,
            },
          });
        }
      }

      // 只用于下面那条「过滤没命中」的告警：如果配置里明明有指向中转的 provider，
      // 却没有一条用量行被判成它，说明 provider 字段的取值和我们以为的不一样。
      // 那种情况下过滤会**静默失效**，等于没做 —— 所以要喊出来。
      const observedProviders = new Set(observations.map((line) => line.provider));
      const relayClassified = plan.relayClassified;

      if (relayProviders.size > 0 && relayClassified === 0 && observedProviders.size > 0) {
        getDebugLogger().warn({
          domain: 'commercial',
          event: 'commercial.usage.relay-filter-missed',
          data: {
            gatewayId: gw.id,
            relayProviders: [...relayProviders],
            observed: [...observedProviders],
          },
        });
      }
      // 归属未知被隔离：**不是错误**，但必须看得见 —— 否则"什么都没发"会被当成"没有用量"。
      if (plan.unknown > 0) {
        getDebugLogger().info({
          domain: 'commercial',
          event: 'commercial.usage.ownership-unknown',
          data: {
            gatewayId: gw.id,
            isolated: plan.unknown,
            generation,
            establishesOnEvidence: true,
          },
        });
      }
    }

    // 一轮只落盘一次：本轮的归属推进（新记的 relay 粘滞、水位推进、补报结算）
    // 一起写下去。**写失败不再"下一轮重读旧记录"**（U2）——
    // 本轮状态留在内存里优先于磁盘，并且下一轮收费方向 fail-closed。
    if (touched) {
      try {
        store.write(state);
        cachedState = state;
        persistenceDegraded = false;
      } catch (error) {
        persistenceDegraded = true;
        getDebugLogger().warn({
          domain: 'commercial',
          event: 'commercial.usage.attribution-write-failed',
          data: {
            message: error instanceof Error ? error.message : String(error),
            degraded: true,
          },
        });
      }
    }

    return sent;
  } finally {
    running = false;
  }
}

function settleReport(state: UsageAttributionState, gatewayId: string, report: UsageReport): void {
  if (report.reason === 'catch-up') settleUsageReport({ state, gatewayId, report });
  else settleExternalReport({ state, gatewayId, report });
}

/**
 * 本轮状态的内存真源。
 *
 * ⚠️ 一轮读一次、**记一次**：落盘失败之后**不再回读磁盘**（那正是 U2 的缺陷 ——
 *    回读了旧记录就等于把本轮的 relay 粘滞丢掉，下一轮按旧记录分类 ⇒ 双扣）。
 *    内存里这份始终是本轮之后的权威状态；磁盘只在**进程启动**（还没有内存态）时读。
 */
let cachedState: UsageAttributionState | null = null;
/** 落盘失败的降级标记：为真时本轮不再产生新的可扣费上报（fail-closed）。 */
let persistenceDegraded = false;

function readState(store: UsageAttributionStore): UsageAttributionState | null {
  if (cachedState) return cachedState;
  const fromDisk = store.read() ?? emptyAttributionState();
  cachedState = fromDisk;
  return cachedState;
}

/**
 * 归属账本的落点。
 *
 * - 显式注入（测试）优先；
 * - 生产（Electron 主进程）：`<userData>/usage-attribution.json`；
 * - 其它环境（单测、纯 Node）：**内存**，不落盘 —— 没有 userData 语义的地方不该
 *   在磁盘上留计费状态，更不该因为读不到 electron 就抛。
 *
 * ⚠️ userData 在便携模式下就是 `<卷根>\荣盈魔方-运行数据`（见 `main/index.ts`），
 *    所以这份账本**跟着盘走** —— 正是 BUG-087 需要的行为（清账后重启仍认得旧归属）。
 */
let injectedStore: UsageAttributionStore | null = null;
let resolvedDefaultStore: Promise<UsageAttributionStore> | null = null;

/** 显式固定归属账本（测试/受控场景）；传 `null` 恢复默认解析。 */
export function setUsageAttributionStore(store: UsageAttributionStore | null): void {
  injectedStore = store;
  resolvedDefaultStore = null;
  cachedState = null;
  persistenceDegraded = false;
}

type ElectronUserDataHost = { getPath?: (name: string) => string };

function userDataDirectoryFrom(electron: unknown): string | null {
  const host = electron as { app?: ElectronUserDataHost; default?: { app?: ElectronUserDataHost } } | null;
  const app = host?.app ?? host?.default?.app;
  const dir = typeof app?.getPath === 'function' ? app.getPath('userData') : undefined;
  return typeof dir === 'string' && dir.length > 0 ? dir : null;
}

async function defaultAttributionStore(): Promise<UsageAttributionStore> {
  // 非 Electron（含全部单测）直接内存：不 import、不落盘。
  if (!process.versions.electron) return createMemoryAttributionStore();
  try {
    const dir = userDataDirectoryFrom(await import('electron'));
    return dir ? createFileAttributionStore(dir) : createMemoryAttributionStore();
  } catch (error) {
    getDebugLogger().warn({
      domain: 'commercial',
      event: 'commercial.usage.attribution-store-unavailable',
      data: { message: error instanceof Error ? error.message : String(error) },
    });
    return createMemoryAttributionStore();
  }
}

async function resolveAttributionStore(explicit?: UsageAttributionStore): Promise<UsageAttributionStore> {
  if (explicit) return explicit;
  if (injectedStore) return injectedStore;
  resolvedDefaultStore ??= defaultAttributionStore();
  return resolvedDefaultStore;
}

type RpcOutcome = { error: { message: string } | null };

async function withTimeout<T extends RpcOutcome>(work: PromiseLike<T>, ms: number): Promise<T | RpcOutcome> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RpcOutcome>((resolve) => {
    handle = setTimeout(() => resolve({ error: { message: 'timeout' } }), ms);
  });
  try {
    return await Promise.race([Promise.resolve(work), timeout]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

export function initUsageReporter(): void {
  if (timer) return;
  void runUsageReport().catch(() => {});
  timer = setInterval(() => {
    void runUsageReport().catch(() => {});
  }, REPORT_INTERVAL_MS);
}

export function destroyUsageReporter(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
