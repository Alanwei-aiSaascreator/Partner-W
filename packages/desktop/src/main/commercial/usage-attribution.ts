import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../util/json-file.js';

/**
 * **历史用量的归属账本**（BUG-087 / P01 独审 F2 → 2026-10-16 用量终审 U1/U2/U3）。
 *
 * ## 问题
 *
 * 网关 `sessions.usage` 发的是**每个会话的累计量**，服务端 `report_usage` 用
 * `greatest(cum − prev, 0)` 对账（`20260912000025_cache_hit_no_double_charge.sql:189`，
 * 键 = `(org_id, session_key, provider, model)`）。累计量落在哪个键上**不随配置变化**，
 * 而"这堆 token 是谁付的钱"却会变。第一版把判据做成"当前配置快照"，
 * 于是有两个方向都错的行为：
 *
 *   · **双扣方向**：配置被判成"不是我们的"（清账 / 删配置 / 账本损坏）时，
 *     同一批**已由 relay 计量过**的累计量会被报给服务端 ⇒ 服务端从没见过的键
 *     ⇒ 差额 = 全量 ⇒ 再扣一次。
 *   · **永久漏报方向**：把"曾由 relay 计量"记成 **provider 名级**的永久粘滞 ⇒
 *     同名 provider 被删/改址/复用之后，**全新 session** 的合法外部用量也永远被吞掉。
 *
 * ## 三条判据（本模块的合同）
 *
 * ① **归属绑定调用时证据**：账号、许可证（含代次）、工作区、以及**配置代次**
 *    （由这一轮实际使用的 provider→端点映射推导）。身份变了 ⇒ 旧历史隔离、
 *    新身份按自己的证据重新分类，**绝不把新身份记到旧账上**。
 * ② **粘滞落在"观测键"上，不落在 provider 名上**：`(sessionKey, provider, model)`
 *    这个键一旦被判定由中转计量就永久隔离（它的累计量里混着 relay 计过的 token，
 *    整批报上去就是双扣）；但**别的键**（尤其新 session）不受牵连 —— 这正是 U1。
 * ③ **未知 ≠ 外部**：账本为空/损坏/读不回来、配置被删、没有正面证据、
 *    落盘失败、在途切换 —— 一律判 **unknown（隔离，不报）**，并留下可恢复诊断。
 *    只有**正面证据**（配置里存在且 baseUrl 不指向任何已知中转端点）或
 *    **该观测键自身**拿到过正面外部证据（`externalAttested`，删掉自建 provider 之后
 *    历史累计量仍要能继续报），才按外部处理。
 *
 *    ⚠️ 「这个网关见过任何用量」**不是**归属证明（2026-10-16 r14 复审 A-1）：
 *    网关级建立标记会把**无正面证据的新键**一起放行 —— 先见到一个已知 relay 观测，
 *    随后配置已删的旧 provider 也会被计划成 external。信任必须逐键判定。
 *
 * ④ **身份只认「该键的原始归属身份」**：一个观测键的累计量是**跨身份累积**的
 *    （共享盘上换账号/换卡，老累计量还挂在这个键上）。身份变更只隔离**当前这一轮**，
 *    **不改写**该键记录的 `binding`（2026-10-16 r14 复审 A-2）——改写它就等于
 *    下一轮把旧身份的历史记到新身份的账上。`licenseId` 与账号/代次/工作区同为身份维度。
 *    且该键**从此被标记为污染**：A→B 之后再回到 A，当前累计量里夹着 B 的那一段，
 *    回头的 A 同样不许直报（r14 集成复核 A-3）。见 `TrackedKeyRecord.contaminated`。
 *
 * ## 影子 / 水位（U3 的接续建议）
 *
 * 每一步都算出"**本应上报什么**"（`UsageShadowEntry`：相对已记录水位 `reported`
 * 的差值 `delta` + 交付水位 `watermark`）。**默认不发送**：真正的直发与增量补报
 * 由 `usage-reporter` 的显式开关控制（默认 `shadow` + 不补报），见那个文件。
 *
 * ## 方向（写死在这里，防止后人放宽）
 *
 * **宁可少报，不可双扣。** 不确定一律隔离。
 *
 * ## 版本
 *
 * `formatVersion` 从 1 升到 2。**旧版（v1）账本按"未知归属"处理**（解析成空账本）：
 * v1 记的是 provider 名级的永久粘滞 + `external` 键值，把它沿用过来等于
 * 把 U1 那个缺陷（同名 provider 永久吞掉新用量）带进新版本；
 * 而丢弃它只会让接下来的观测**先进隔离**，直到配置正面证实为外部 —— 正是安全方向。
 */

export const USAGE_ATTRIBUTION_FORMAT_VERSION = 2;
/** 落盘文件名（放在 userData 根下，与 `analytics-queue.json` 同一层）。 */
export const USAGE_ATTRIBUTION_FILE = 'usage-attribution.json';

/**
 * 保留的观测键条数上限。满了按最近触碰时间淘汰。
 *
 * 淘汰只会让一次上报发生不了（**漏报**）或让一个键失去 relay 隔离（**危险方向**），
 * 所以上限取得远大于任何现实会话数，并且淘汰顺序按"最久没被触碰"。
 */
export const MAX_TRACKED_KEYS = 8192;

/** 归属结论。`unknown` = 隔离（不报），见模块顶部的判据 ③。 */
export type UsageOwnership = 'relay' | 'external' | 'unknown';

/** 一次上报用的累计量（与 `report_usage` 的三个累计参数一一对应）。 */
export interface UsageTotalSnapshot {
  input: number;
  output: number;
  /** `cacheRead + cacheWrite`（服务端只认一列，见 usage-reporter 的说明）。 */
  cached: number;
}

/**
 * 调用时证据里的**身份**部分：账号 / 许可证 / 许可证代次 / 工作区 / 配置代次。
 *
 * 这些字段随每条观测一起落盘，用来回答"这一批累计量是在**谁的**身份下产生的"。
 */
export interface EvidenceBinding {
  /** 商业账号 id（JWT `sub`）。 */
  accountId: string | null;
  /** 许可证（卡）id。拿不到时 `null`（不猜）。 */
  licenseId: string | null;
  /** 许可证代次：本地单调计数器，激活/清卡即 +1（`license-generation.js`）。 */
  licenseEpoch: number;
  /** 工作区标识（当前工作区路径）。 */
  workspaceId: string | null;
  /** 配置代次：这一轮实际使用的 provider→端点映射的稳定摘要。 */
  generation: string;
}

/** 调用时证据：身份 + 本轮**被正面证实**为外部端点的 provider 名。 */
export interface CallTimeEvidence extends EvidenceBinding {
  /** 配置里存在、且 `baseUrl` 不指向任何已知官方中转端点的 provider 名。 */
  attestedExternalProviderIds: ReadonlySet<string>;
}

/** 一个观测键（会话 × provider × 模型）的归属记录。 */
export interface TrackedKeyRecord {
  /** 粘滞：一旦该键被判定由中转计量，永久隔离。 */
  relayMetered: boolean;
  /**
   * 粘滞：**该观测键自身**拿到过正面外部证据（配置里存在且端点不是我们的）。
   *
   * 与 `relayMetered` 对称的键级粘滞：只由正面证据置位，**不因一次隔离而清除**
   * （身份变更/落盘降级/在途切换都只是"这一轮不报"，不是"这个键的历史归属变了"）。
   * 它替代了旧的网关级 `established` 放行 —— "网关见过任何用量"不是某个键的归属证明。
   */
  externalAttested: boolean;
  /**
   * 粘滞：这个观测键**被两个身份观测过**（共享盘换账号 / 换卡后同一会话继续）。
   *
   * 累计量是**跨身份累积**的：A 报过 30，B 把它涨到 50，再切回 A 时**当前累计 70**
   * 里夹着 B 的 20 —— 服务端只认 `(org, key, provider, model)` 的差分，A 一报 70
   * 就被扣掉 B 的那 20（2026-10-16 r14 集成复核 A-3）。
   *
   * 所以**一旦污染，任何身份都不再按"当前累计量"直报**（键级永久隔离）。
   * ⚠️ 只隔离"外来身份"、放行"原本身份"是不够的 —— 回头的原身份同样会认领
   *    夹在中间的那段。要恢复计费必须实现**按身份分段的基线**（每个身份各自的
   *    offset / 水位，只上报该身份自己区间内的增量），那属于新基础设施，本轮不做。
   *
   * 方向仍是**宁可少报，不可双扣**：代价是这个键**有界漏报**（这一条会话在这个键上
   * 不再计费），换来的是绝不串账号扣费。
   */
  contaminated: boolean;
  /** 最近一轮的归属结论（诊断 / 影子对账用）。 */
  ownership: UsageOwnership;
  /** 最近一次观测到的**网关累计量**（原始水位）。 */
  watermark: UsageTotalSnapshot;
  /** 已经交付（或影子模式下**本应**交付）给服务端的累计水位。 */
  reported: UsageTotalSnapshot;
  /** 判 relay 之后仍欠服务端的那笔"转换前观测值"（补报用；默认不发送）。 */
  pendingCatchUp: UsageTotalSnapshot | null;
  /** 最近一次观测时的调用时证据。 */
  binding: EvidenceBinding | null;
  /** 最近一次触碰（淘汰用）。 */
  touchedAt: number;
}

export interface GatewayUsageAttribution {
  /**
   * **诊断标记**：这个网关本轮至少出现过一条被正面分类的观测（relay 或外部）。
   *
   * ⚠️ **不是放行依据**（2026-10-16 r14 复审 A-1）。旧实现拿它当"账本已建立"的
   *    全局信任位，于是任何已知 relay 观测一到场，**无正面证据的新键**也会被计划成
   *    external（配置已删的旧 provider 照样放行）。归属信任现在只落在**观测键自身**
   *    的 `externalAttested` 上。字段保留只为诊断与落盘兼容。
   */
  established: boolean;
  /** `attributionKey()` → 归属记录。 */
  keys: Record<string, TrackedKeyRecord>;
}

export interface UsageAttributionState {
  formatVersion: number;
  gateways: Record<string, GatewayUsageAttribution>;
}

/** 落盘端口。测试注入内存实现；生产注入 userData 下的文件实现。 */
export interface UsageAttributionStore {
  read(): UsageAttributionState | null;
  write(state: UsageAttributionState): void;
}

/** 观测键：会话 × provider × 模型（与 `report_usage` 的对账键同一维度）。 */
export function attributionKey(sessionKey: string, provider: string, model: string): string {
  return `${sessionKey}\u0000${provider}\u0000${model}`;
}

export function emptyAttributionState(): UsageAttributionState {
  return { formatVersion: USAGE_ATTRIBUTION_FORMAT_VERSION, gateways: {} };
}

function emptyGateway(): GatewayUsageAttribution {
  return { established: false, keys: {} };
}

function zeroTotals(): UsageTotalSnapshot {
  return { input: 0, output: 0, cached: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseTotals(value: unknown): UsageTotalSnapshot | null {
  if (!isRecord(value)) return null;
  const { input, output, cached } = value;
  if (!finiteNonNegative(input) || !finiteNonNegative(output) || !finiteNonNegative(cached)) return null;
  return { input, output, cached };
}

function parseBinding(value: unknown): EvidenceBinding | null {
  if (!isRecord(value)) return null;
  const { accountId, licenseId, licenseEpoch, workspaceId, generation } = value;
  if (typeof generation !== 'string') return null;
  if (!finiteNonNegative(licenseEpoch)) return null;
  return {
    accountId: typeof accountId === 'string' ? accountId : null,
    licenseId: typeof licenseId === 'string' ? licenseId : null,
    licenseEpoch,
    workspaceId: typeof workspaceId === 'string' ? workspaceId : null,
    generation,
  };
}

function parseKeyRecord(value: unknown): TrackedKeyRecord | null {
  if (!isRecord(value)) return null;
  const watermark = parseTotals(value.watermark);
  const reported = parseTotals(value.reported);
  if (!watermark || !reported) return null;
  const ownership = value.ownership;
  const pendingCatchUp = value.pendingCatchUp === null ? null : parseTotals(value.pendingCatchUp);
  return {
    relayMetered: value.relayMetered === true,
    // 缺字段 ⇒ false ⇒ 该键退回"未知隔离"。**保守方向**：旧记录（没有这个字段的
    // v2 账本）里的外部键会先隔离一轮，等下一次正面证据再恢复，绝不反过来放行。
    externalAttested: value.externalAttested === true,
    // 同上：缺字段 ⇒ false ⇒ 这个键按**未污染**处理（历史 v2 账本里还没被两个身份
    // 观测过；真正被污染过的键由下面的比较当场重新标记）。
    contaminated: value.contaminated === true,
    ownership: ownership === 'relay' || ownership === 'external' ? ownership : 'unknown',
    watermark,
    reported,
    pendingCatchUp,
    binding: value.binding === null ? null : parseBinding(value.binding),
    touchedAt: finiteNonNegative(value.touchedAt) ? value.touchedAt : 0,
  };
}

function parseGateway(value: unknown): GatewayUsageAttribution | null {
  if (!isRecord(value)) return null;
  const keysValue = value.keys;
  if (!isRecord(keysValue)) return null;

  const keys: Record<string, TrackedKeyRecord> = {};
  for (const [key, record] of Object.entries(keysValue)) {
    const parsed = parseKeyRecord(record);
    if (parsed) keys[key] = parsed;
  }
  return { established: value.established === true, keys };
}

/**
 * 宽容解析落盘内容：**任何**结构不符都退化成空记录（不抛）。
 *
 * ⚠️ 退回空记录等于"所有历史归属未知" ⇒ 按本模块的判据 ③ 全部**隔离**
 *    （不是按外部上报）—— 退化方向是安全的，这正是 U2 的修法。
 *    落盘走原子写（`writeJsonAtomic`），所以损坏只可能来自外部改写/磁盘故障。
 *
 * ⚠️ **只认当前格式版本**。v1（provider 名级粘滞）一律解析成空账本：
 *    沿用 v1 的 marker 就等于把 U1 那个"同名 provider 永久吞新用量"带进 v2。
 */
export function parseAttributionState(value: unknown): UsageAttributionState {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return emptyAttributionState();
    }
  }
  if (!isRecord(parsed)) return emptyAttributionState();
  if (parsed.formatVersion !== USAGE_ATTRIBUTION_FORMAT_VERSION) return emptyAttributionState();
  const gatewaysValue = parsed.gateways;
  if (!isRecord(gatewaysValue)) return emptyAttributionState();

  const gateways: Record<string, GatewayUsageAttribution> = {};
  for (const [gatewayId, gateway] of Object.entries(gatewaysValue)) {
    const parsedGateway = parseGateway(gateway);
    if (parsedGateway) gateways[gatewayId] = parsedGateway;
  }
  return { formatVersion: USAGE_ATTRIBUTION_FORMAT_VERSION, gateways };
}

function cloneState(state: UsageAttributionState): UsageAttributionState {
  const gateways: Record<string, GatewayUsageAttribution> = {};
  for (const [gatewayId, gateway] of Object.entries(state.gateways)) {
    const keys: Record<string, TrackedKeyRecord> = {};
    for (const [key, record] of Object.entries(gateway.keys)) {
      keys[key] = {
        ...record,
        watermark: { ...record.watermark },
        reported: { ...record.reported },
        pendingCatchUp: record.pendingCatchUp ? { ...record.pendingCatchUp } : null,
        binding: record.binding ? { ...record.binding } : null,
      };
    }
    gateways[gatewayId] = { established: gateway.established, keys };
  }
  return { formatVersion: state.formatVersion, gateways };
}

/** 内存实现：**每个实例独立**（测试与"不落盘"降级都用它）。 */
export function createMemoryAttributionStore(initial?: UsageAttributionState): UsageAttributionStore {
  let state: UsageAttributionState | null = initial ? cloneState(initial) : null;
  return {
    read: () => (state ? cloneState(state) : null),
    write: (next) => {
      state = cloneState(next);
    },
  };
}

/**
 * 文件实现：`<directory>/usage-attribution.json`，原子写。
 *
 * 读不回来（不存在/半截/结构不符）一律 `null` —— 与内存实现的"还没有"同义。
 */
export function createFileAttributionStore(directory: string): UsageAttributionStore {
  const filePath = join(directory, USAGE_ATTRIBUTION_FILE);
  return {
    read: () => {
      try {
        return parseAttributionState(readFileSync(filePath, 'utf-8'));
      } catch {
        return null;
      }
    },
    write: (state) => {
      mkdirSync(directory, { recursive: true });
      writeJsonAtomic(filePath, state);
    },
  };
}

/** 一条用量观测（由 usage-reporter 从网关载荷里读出来）。 */
export interface UsageObservation {
  sessionKey: string;
  provider: string;
  model: string;
  totals: UsageTotalSnapshot;
}

/**
 * 上报原因：
 *   · `external` —— 这一轮判它不由中转计量，按当前累计量正常上报；
 *   · `catch-up` —— 归属刚从"外部"转成"中转"，补报**转换前观测到的**那个值。
 *     ⚠️ 这是**历史补报**，默认**不发送**（见 `usage-reporter` 的开关）。
 */
export type UsageReportReason = 'external' | 'catch-up';

export interface UsageReport extends UsageObservation {
  reason: UsageReportReason;
}

/** 影子对账条目：算出"本应上报什么"，但不实际发送。 */
export interface UsageShadowEntry extends UsageReport {
  /**
   * 相对**本轮开始前已记录的水位**（`reported`）的增量 —— 这一轮本应计的量。
   *
   * ⚠️ 只对 `reason: 'external'` 有"服务端会扣多少"的含义。
   *    `catch-up` 那条服务端的对账水位**本来就比我们低**（那正是它要补的原因），
   *    所以要看的是 `totals` 本身（被重新交付的那个值），不是 `delta`。
   */
  delta: UsageTotalSnapshot;
  /** 交付给服务端的累计水位（本应交付的值）。 */
  watermark: UsageTotalSnapshot;
  /** 这一轮算这一段时用的归属结论。 */
  ownership: UsageOwnership;
}

export interface UsagePlan {
  /** 计划执行后应落盘的状态（调用方持有）。 */
  state: UsageAttributionState;
  /** 本应上报的条目（影子模式下**不发送**，只登记）。 */
  reports: UsageReport[];
  /** 影子对账：与 `reports` 一一对应，另带相对水位的差值。 */
  shadow: UsageShadowEntry[];
  /** 本轮被判"由中转计量"而**没有**产生上报的观测条数。 */
  skipped: number;
  /** 本轮因**归属未知**被隔离（不报）的观测条数。 */
  unknown: number;
  /** 本轮被判"由中转计量"的观测条数（含正在补报的那几条）—— 只用于告警。 */
  relayClassified: number;
}

export interface PlanUsageReportsInput {
  state: UsageAttributionState;
  gatewayId: string;
  /** **本轮开始时**读到的配置里，实际打到中转服务的 provider 名（不允许中途重读）。 */
  relayOwnedProviderIds: ReadonlySet<string>;
  observations: readonly UsageObservation[];
  /**
   * **调用时证据**（账号/许可证/工作区/配置代次 + 正面证实的外部 provider）。
   *
   * 缺省 = 没有证据：此时只有**账本已建立的网关**上的非 relay 观测才按外部处理，
   * 其余一律未知隔离（这是"不猜"的默认）。
   */
  evidence?: CallTimeEvidence | null;
  /**
   * 本轮观测**跨过了配置/身份切换点**（在途 tick）：无法判定这段累计量属于谁
   * ⇒ 整轮按未知隔离（仍然保留 relay 的粘滞记录）。
   */
  inFlightIdentityChanged?: boolean;
  /**
   * 归属账本**落盘失败**（写不进去）。收费方向 fail-closed：不产生新的外部上报
   * —— 下一轮重新读到的可能是旧记录，凭旧记录分类就会双扣。
   */
  persistenceDegraded?: boolean;
  now?: number;
}

function bindingOf(evidence: CallTimeEvidence): EvidenceBinding {
  return {
    accountId: evidence.accountId,
    licenseId: evidence.licenseId,
    licenseEpoch: evidence.licenseEpoch,
    workspaceId: evidence.workspaceId,
    generation: evidence.generation,
  };
}

/**
 * 身份（账号 / 许可证 id / 许可证代次 / 工作区）是否变了 —— 配置代次变化不算身份变化。
 *
 * `licenseId` 必须参与比较（2026-10-16 r14 复审 A-2）：同账号、同许可证代次下**只换卡**
 * 也会让"这批累计量是谁付的钱"改变，不比较它就等于把旧卡的用量记到新卡上。
 */
function identityChanged(record: TrackedKeyRecord, evidence: CallTimeEvidence): boolean {
  const binding = record.binding;
  if (!binding) return false;
  return (
    (binding.accountId ?? null) !== (evidence.accountId ?? null) ||
    (binding.licenseId ?? null) !== (evidence.licenseId ?? null) ||
    binding.licenseEpoch !== evidence.licenseEpoch ||
    (binding.workspaceId ?? null) !== (evidence.workspaceId ?? null)
  );
}

/**
 * 观测键的归属身份**一旦确立就不再改写**（首次写入胜出）。
 *
 * ⚠️ 一个键的累计量是**跨身份累积**的：共享盘上换账号 / 换卡之后，旧身份的累计量
 *    还挂在这个键上。身份变更那一轮拒报之后如果把 `binding` 改写成新身份，
 *    下一轮 `identityChanged` 就变成 false ⇒ 旧累计量被当成新身份的用量上报 ——
 *    这正是 2026-10-16 r14 复审 A-2 的"换账号只隔离一轮"。
 *
 * 身份不同的观测**只隔离**：旧身份的分段与基线原样留在记录里（它自己的身份回来时
 * 继续用）。方向仍是**宁可少报，不可双扣**。
 */
function bindIfUnclaimed(record: TrackedKeyRecord, evidence: CallTimeEvidence): void {
  if (record.binding === null) record.binding = bindingOf(evidence);
}

function subtractFloor(left: UsageTotalSnapshot, right: UsageTotalSnapshot): UsageTotalSnapshot {
  return {
    input: Math.max(0, Math.floor(left.input - right.input)),
    output: Math.max(0, Math.floor(left.output - right.output)),
    cached: Math.max(0, Math.floor(left.cached - right.cached)),
  };
}

function trimKeys(keys: Record<string, TrackedKeyRecord>): void {
  const ids = Object.keys(keys);
  if (ids.length <= MAX_TRACKED_KEYS) return;
  const ranked = ids
    .map((key) => ({ key, touchedAt: keys[key]?.touchedAt ?? 0 }))
    .sort((left, right) => left.touchedAt - right.touchedAt || left.key.localeCompare(right.key));
  for (const entry of ranked.slice(0, ids.length - MAX_TRACKED_KEYS)) delete keys[entry.key];
}

/**
 * 按**调用时证据**给本轮的用量行分类，并给出"本应上报什么"。
 *
 * ⚠️ **原地更新 `input.state`**：调用方持有同一个对象，最后统一落盘一次
 *    （避免"半轮状态"落盘）。
 */
export function planUsageReports(input: PlanUsageReportsInput): UsagePlan {
  const now = input.now ?? Date.now();
  const evidence = input.evidence ?? null;
  const isolateNewReports = input.persistenceDegraded === true || input.inFlightIdentityChanged === true;

  const gateway = input.state.gateways[input.gatewayId] ?? emptyGateway();
  input.state.gateways[input.gatewayId] = gateway;

  const reports: UsageReport[] = [];
  const shadow: UsageShadowEntry[] = [];
  let skipped = 0;
  let unknown = 0;
  let relayClassified = 0;

  /** 把一条报告同时登记进影子对账（差值相对**这一轮开始前**的水位）。 */
  const emit = (
    observation: UsageObservation,
    report: UsageReport,
    ownership: UsageOwnership,
    previousReported: UsageTotalSnapshot,
  ): void => {
    reports.push(report);
    shadow.push({
      ...report,
      delta: subtractFloor(observation.totals, previousReported),
      watermark: { ...observation.totals },
      ownership,
    });
  };

  for (const observation of input.observations) {
    const key = attributionKey(observation.sessionKey, observation.provider, observation.model);
    const record: TrackedKeyRecord = gateway.keys[key] ?? {
      relayMetered: false,
      externalAttested: false,
      contaminated: false,
      ownership: 'unknown',
      watermark: zeroTotals(),
      reported: zeroTotals(),
      pendingCatchUp: null,
      binding: null,
      touchedAt: now,
    };
    // 影子差值要相对**本轮开始之前**记录的水位算，所以在推进之前先取出来。
    const previousReported = { ...record.reported };

    const relayOwned = input.relayOwnedProviderIds.has(observation.provider);
    const attested = evidence !== null && evidence.attestedExternalProviderIds.has(observation.provider);
    const identityShifted = evidence !== null && identityChanged(record, evidence);
    // 这个键被第二个身份看过了 ⇒ 它的累计量**从此混着两个身份的 token**，永久标记。
    // 标记落在**键**上（不是"这一轮"）：回头来的原本身份同样不能再按当前累计量直报，
    // 否则它会认领夹在中间那段属于另一个账号的用量（r14 集成复核 A-3）。
    if (identityShifted) record.contaminated = true;

    // ───────────────────────────────────────────────────────────────────
    // ① 粘滞：这个**观测键**已被判定由中转计量 ⇒ 永久隔离（不再按任何配置重新分类）。
    //    它欠着的那笔"转换前观测值"照旧算出来（影子/受控补报用）。
    // ───────────────────────────────────────────────────────────────────
    if (record.relayMetered) {
      relayClassified += 1;
      if (record.pendingCatchUp) {
        emit(
          observation,
          { ...observation, totals: record.pendingCatchUp, reason: 'catch-up' },
          'relay',
          previousReported,
        );
      } else {
        skipped += 1;
      }
      record.watermark = { ...observation.totals };
      record.touchedAt = now;
      if (evidence) bindIfUnclaimed(record, evidence);
      gateway.keys[key] = record;
      continue;
    }

    // ───────────────────────────────────────────────────────────────────
    // ② 本轮配置正面判它由中转计量 ⇒ 记粘滞；把"转换前观测值"挂成待补。
    //    转换前那个值是在**非中转归属**下读到的，不含 relay 计量的 token，
    //    所以补它不会双扣；当前值不能补（它已经掺进了 relay 计量的部分）。
    // ───────────────────────────────────────────────────────────────────
    if (relayOwned) {
      relayClassified += 1;
      gateway.established = true;
      const carry =
        !isolateNewReports &&
        record.ownership === 'external' &&
        record.reported.input + record.reported.output + record.reported.cached > 0
          ? { ...record.reported }
          : null;
      record.relayMetered = true;
      record.ownership = 'relay';
      record.pendingCatchUp = carry;
      if (carry) {
        emit(observation, { ...observation, totals: carry, reason: 'catch-up' }, 'relay', previousReported);
      } else {
        skipped += 1;
      }
      record.watermark = { ...observation.totals };
      record.touchedAt = now;
      if (evidence) bindIfUnclaimed(record, evidence);
      gateway.keys[key] = record;
      continue;
    }

    // ───────────────────────────────────────────────────────────────────
    // ③ 非 relay：只有拿到**正面归属证据**才敢按外部上报。
    //    · 配置正面证实（provider 存在且端点不是我们的）—— 权威；
    //    · 或**这个观测键自己**拿到过正面证据（`externalAttested`：配置里被删掉的
    //      自建 provider，历史累计量仍属外部）。
    //    其余（账本空/损坏、配置被删且这个键没有正面历史、落盘失败、在途切换、
    //    身份变更）一律**未知 ⇒ 隔离**。
    //
    //    ⚠️ 这里**不再**看网关级 `gateway.established`（2026-10-16 r14 复审 A-1）：
    //       那是"这个网关见过任何用量"，不是"这个键归谁"—— 拿它放行会让配置已删的
    //       未知 provider 只要和一条已知 relay 观测同轮出现就被计划成 external。
    //
    //    ⚠️ 污染键（被两个身份观测过）**任何身份**都不放行（r14 集成复核 A-3）：
    //       只挡外来身份、放行原本身份的话，原本身份回头就会认领夹在中间的他人累计。
    // ───────────────────────────────────────────────────────────────────
    const trustedExternal =
      !isolateNewReports && !identityShifted && !record.contaminated && (attested || record.externalAttested);

    if (trustedExternal) {
      gateway.established = true;
      record.externalAttested = true;
      const report: UsageReport = { ...observation, reason: 'external' };
      emit(observation, report, 'external', previousReported);
      record.ownership = 'external';
      record.reported = { ...observation.totals };
    } else {
      unknown += 1;
      record.ownership = 'unknown';
      // 隔离**不等于**已交付：不推进 `reported`。这样影子对账里的 `delta` 始终是
      // "服务端按它自己的上一条记录会扣多少"，而不是被隔离动作悄悄抹平。
    }

    record.watermark = { ...observation.totals };
    record.touchedAt = now;
    if (evidence) bindIfUnclaimed(record, evidence);
    gateway.keys[key] = record;
  }

  trimKeys(gateway.keys);
  return { state: input.state, reports, shadow, skipped, unknown, relayClassified };
}

/**
 * 一条 `catch-up` 上报**成功**之后收尾：这个观测值已经交给服务端，不必再补。
 *
 * ⚠️ 只在成功时调用。上报失败时保留观测值，下一轮继续补 —— 补报发的是同一个
 *    旧观测值，服务端差额为 0，重复发送不会多扣。
 */
export function settleUsageReport(input: {
  state: UsageAttributionState;
  gatewayId: string;
  report: UsageReport;
}): void {
  if (input.report.reason !== 'catch-up') return;
  const gateway = input.state.gateways[input.gatewayId];
  if (!gateway) return;
  const record = gateway.keys[attributionKey(input.report.sessionKey, input.report.provider, input.report.model)];
  if (record) record.pendingCatchUp = null;
}

/**
 * 一条 `external` 上报**成功**之后收尾：把交付水位推进到刚发出去的那个值。
 *
 * ⚠️ 只在成功（或影子模式**登记**）时调用。失败时水位保持不动，下一轮重发同一个
 *    累计量，服务端差额为 0，重复发送不会多扣。
 */
export function settleExternalReport(input: {
  state: UsageAttributionState;
  gatewayId: string;
  report: UsageReport;
}): void {
  if (input.report.reason !== 'external') return;
  const gateway = input.state.gateways[input.gatewayId];
  if (!gateway) return;
  const record = gateway.keys[attributionKey(input.report.sessionKey, input.report.provider, input.report.model)];
  if (record) record.reported = { ...input.report.totals };
}
