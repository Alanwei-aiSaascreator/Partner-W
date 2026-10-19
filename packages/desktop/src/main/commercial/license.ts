import { hostname, arch, platform } from 'node:os';
import { createHash } from 'node:crypto';
import type { IpcResult } from '@clawwork/shared';
import { getCommercialClient } from './client.js';
import { ensureDeviceId, readConfig, updateConfig } from '../workspace/config.js';
import { getAllGatewayClients } from '../ws/index.js';
import { getDebugLogger } from '../debug/index.js';
import {
  activeRelayBaseUrl,
  applyRelayConfig,
  fetchFirstRelayModel,
  fetchRelayCatalogModelEntries,
  fetchRelayMediaCapabilities,
  normalizeBaseUrl,
} from './relay-config.js';
import { COMMERCIAL_REQUEST_TIMEOUT_MS } from './request-timeout.js';
import { LOCAL_GATEWAY_ID } from '../runtime/state-config.js';
import { getActiveLocalGatewayStateDir } from '../runtime/index.js';
import { hasInstalledSearchProvider } from '../runtime/bundled-search.js';
import { advanceLicenseGeneration, getLicenseGeneration } from './license-generation.js';
import { getActiveRelayKey, setActiveRelayKey } from './relay-key.js';
import { resyncMemoryOnAccountBoundary } from '../memory/account-switch.js';

export interface LicenseStatus {
  configured: boolean;
  licenseId: string | null;
  orgId: string | null;
  licenseKey: string | null;
  sku: string | null;
  status: string | null;
  expiresAt: string | null;
  maxActivations: number;
  tokenQuotaMicros: number;
  tokenUsedMicros: number;
  /**
   * 在途预占（媒体冻结）微积分（BUG-082 续，2026-10-16）。
   *
   * 来源是 relay 的 `/v1/usage`（见 `readRelayHeldMicros`）—— 它是**唯一**算得出
   * 预占的地方（三张媒体表预留之和）。**只有真读到读数才有这个字段**；读不到
   * （没有活体 key / relay 不可达 / 形状坏 / 老后端不返回）时**不写**它，并由
   * `heldComplete: false` 表示"不可判定" —— 不能把"读不到"当成"预占为 0"。
   */
  tokenHeldMicros?: number;
  /**
   * 预占口径是否可判定（BUG-082 续，2026-10-16；r14 返工收窄语义）。
   *
   * `false` ⇒ **可用额度不可判定**：后端明确说"读不全 hold 源"，或这次**根本没读到**
   * （relay 不可达 / 形状坏 / 没有活体 key）。UI 必须显示"暂不可用"而不是照常显示
   * `quota − used` 的余额 —— 那个数字可能偏高。
   * `true` ⇒ 上面的 `tokenHeldMicros` 是可信的确定值（可以是 0）。
   * `undefined` ⇒ 这条读取通道没跑（例如仅供展示的构造结果）。
   */
  heldComplete?: boolean;
  activated: boolean;
  deviceFingerprint: string;
  /**
   * 中转配置是否**真的写进了网关**（写入后回读校验过）。
   *
   * 只在激活流程里算得出来 —— 算它要读一次网关配置。`readLicenseStatus()`
   * 不查网关，所以它返回的 status 里这个字段是 `undefined`（= 未知），
   * 而不是 `false`（= 确定没配上）。两者含义不同，别混。
   */
  relayConfigured?: boolean;
}

let licenseOperationTail: Promise<void> = Promise.resolve();
const LICENSE_BACKEND_TIMEOUT_MS = 8_000;
const ACTIVATION_RESPONSE_TIMEOUT_MS = COMMERCIAL_REQUEST_TIMEOUT_MS + 1_000;

class LicenseBackendTimeoutError extends Error {
  constructor(label: string) {
    super(`${label} timed out`);
    this.name = 'LicenseBackendTimeoutError';
  }
}

/**
 * Supabase does not impose a request deadline of its own.  Every backend wait
 * inside the serialized license lane must therefore be bounded; otherwise one
 * lost response keeps `licenseOperationTail` pending forever and blocks every
 * later read or activation until the app restarts.
 *
 * Read-only calls use the short deadline. Activation uses a separate 16-second
 * deadline, just beyond the fetch layer's 15-second abort, and then verifies
 * the exact key + owner + device using reads. This bounds the serial lane
 * without pretending that aborting HTTP rolled back a transaction.
 */
function withLicenseBackendTimeout<T>(
  work: PromiseLike<T>,
  label: string,
  timeoutMs = LICENSE_BACKEND_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new LicenseBackendTimeoutError(label)), timeoutMs);
    Promise.resolve(work).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function runLicenseOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = licenseOperationTail.then(operation, operation);
  licenseOperationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function nextLicenseGeneration(): number {
  return advanceLicenseGeneration();
}

function isCurrentLicenseGeneration(generation: number): boolean {
  return generation === getLicenseGeneration();
}

type CommercialClient = NonNullable<ReturnType<typeof getCommercialClient>>;

function fail<T = unknown>(error: unknown, errorCode: string): IpcResult<T> {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: message, errorCode };
}

/**
 * 设备指纹 **v2**（2026-10-17）：**一块 U 盘 = 一个设备**。
 *
 * 旧算法把 `hostname() | platform() | arch()` 掺进哈希 ⇒ 同一块盘换台电脑就被算成
 * 一台新设备，名额（曾经只有 3）烧完后用户"卡里还有积分却进不去"。
 *
 * v2 只认 `ensureDeviceId()` —— 它存在**随盘**的运行数据里（便携版落在
 * `<卷根>\荣盈魔方-运行数据`），所以换电脑、换盘符、换 Windows 用户都不会变。
 */
export function deviceFingerprint(): string {
  const stableId = ensureDeviceId();
  return createHash('sha256').update(`${stableId}|v2`).digest('hex');
}

/**
 * **旧算法**指纹（v1）—— 只为过渡期存在。
 *
 * 激活时随 v2 一起上报（`p_legacy_fingerprint`）：服务端若发现 v2 还没登记、而 v1
 * 已经登记过，就把那条登记**原地改名**成 v2 —— **不新增设备、不消耗名额**。
 * 老用户因此不需要重新买名额，也不会被当成"新设备"再占一格。
 *
 * ⚠️ 不要拿它做任何长期判断（比如"是不是同一台机器"）：它按电脑算，正是要淘汰的口径。
 */
export function legacyDeviceFingerprint(): string {
  const stableId = ensureDeviceId();
  const material = [stableId, hostname(), platform(), arch()].join('|');
  return createHash('sha256').update(material).digest('hex');
}

function readStoredLicense(): {
  licenseKey: string | null;
  licenseBinding: { userId: string; orgId: string; licenseId: string } | undefined;
} {
  const commercial = readConfig()?.commercial;
  return { licenseKey: commercial?.licenseKey || null, licenseBinding: commercial?.licenseBinding };
}

// Both sources expose exactly these: the `licenses` table directly, and the
// `org_active_license` view (migration 20260911000008 added max_activations to it).
const LICENSE_FIELDS =
  'id, org_id, license_key, sku, status, expires_at, issued_at, max_activations, token_quota_micros, token_used_micros';

interface LicenseRow {
  id: unknown;
  org_id: unknown;
  license_key: unknown;
  sku: unknown;
  status: unknown;
  expires_at: unknown;
  issued_at?: unknown;
  max_activations: unknown;
  token_quota_micros: unknown;
  token_used_micros: unknown;
}

/** Every organization this exact user owns, in the server's deterministic order. */
async function ownerOrgIds(supabase: CommercialClient, userId: string): Promise<string[]> {
  const { data, error } = await withLicenseBackendTimeout(
    supabase
      .from('org_members')
      .select('org_id, joined_at')
      .eq('user_id', userId)
      .eq('role', 'owner')
      .order('joined_at', { ascending: true })
      .order('org_id', { ascending: true }),
    'org_members.select',
  );
  if (error) throw error;
  return (data ?? []).map((row) => String(row.org_id ?? '')).filter(Boolean);
}

function persistLicenseBinding(userId: string, license: LicenseRow, generation: number): void {
  if (!isCurrentLicenseGeneration(generation)) return;
  const licenseKey = String(license.license_key ?? '');
  const licenseId = String(license.id ?? '');
  const orgId = String(license.org_id ?? '');
  if (!licenseKey || !licenseId || !orgId) return;

  const current = readConfig()?.commercial ?? { supabaseUrl: '', supabaseAnonKey: '' };
  const binding = current.licenseBinding;
  if (
    current.licenseKey === licenseKey &&
    binding?.userId === userId &&
    binding.orgId === orgId &&
    binding.licenseId === licenseId
  ) {
    return;
  }
  updateConfig({ commercial: { ...current, licenseKey, licenseBinding: { userId, orgId, licenseId } } });
}

/**
 * 抹掉本地落盘的许可归属。返回**是否真的清掉了一份既有绑定**（没有可清的 ⇒ `false`）。
 *
 * ⚠️ 返回值有两个用途：① 让调用方只在**真实转变**（有绑定 → 匿名）时动作；
 * ② `!license` 分支据此触发一次记忆重投影 —— 见 `readLicenseStatusUnlocked`。
 */
function clearPersistedLicenseBinding(generation: number): boolean {
  if (!isCurrentLicenseGeneration(generation)) return false;
  const current = readConfig()?.commercial;
  if (!current?.licenseKey && !current?.licenseBinding) return false;
  updateConfig({ commercial: { ...current, licenseKey: undefined, licenseBinding: undefined } });
  return true;
}

/**
 * relay `/v1/usage` 的在途预占读取（BUG-082 全链路的后端一段，2026-10-16）。
 *
 * ## 为什么只能问后端
 *
 * 预占 = 三张媒体表（voice / seedance / imagegen）里 `pending/accepted/unknown`
 * 状态的 `reserved_micros` 之和（`services/relay/src/held.ts` 的 `HOLD_SOURCES`）。
 * 客户端**看不到那些行**，也绝不许按模型价目表本地推算 —— 推算出来的"预计扣费"
 * 是在编造账目。所以这里只是把后端已经算好的三个字段搬过来，不做任何本地估算。
 *
 * ## 契约（只增字段）
 *
 * `/v1/usage` 的响应体新增：
 *   · `heldMicros: number`   —— 三源预留之和（微积分）；
 *   · `availableMicros: number` —— quota − used − held（本函数不消费，客户端自算）；
 *   · `heldComplete: boolean` —— false ⇒ 冻结口径**不可判定**。
 * 老客户端忽略未知字段；老后端不返回 ⇒ 这里的 `undefined`（= "后端没说"）。
 *
 * ## 三态（**不许合并**，r14 返工）
 *
 *   ① **确实读到**（`heldMicros` 是有限非负数 + `heldComplete` 是布尔）
 *        ⇒ `tokenHeldMicros` 有值，`heldComplete` 原样带出。`heldComplete: true`
 *          才允许 UI 说"可用 = 额度 − 已用 − 预占"。
 *   ② **后端明确说不可判定**（`heldComplete === false`）⇒ 原样带出，读数**不可信**。
 *   ③ **根本没读到**（没有活体 key / 非 2xx / 形状坏 / 超时 / 网络失败）
 *        ⇒ `tokenHeldMicros` **不写**，但 `heldComplete` **写 false**。
 *
 * ⚠️ 第 ③ 态**必须**落成 `heldComplete: false`，不能再像旧版那样"字段缺省、UI 沿用
 *    `quota − used` 旧口径" —— 那等于把"读不到"伪装成"确定没有预占"。实测反例
 *    （r14 独审）：relay 返 503 时旧实现让界面显示确定的 1,000.40。**读不到 ≠ 没有**。
 *    老后端的形状（不返回这两个字段）与"读取失败"在客户端**无法区分**，因此同样归入
 *    第 ③ 态 —— 宁可显示"暂不可用"，也不显示一个可能偏高的余额。
 *
 * 授权结果本身不受影响：预占是附加信息，问不到不该把"能不能用这张卡"也一起判死。
 */
const RELAY_HELD_TIMEOUT_MS = 2_000;

/**
 * 活体 relay key → 它的 `/v1/usage` 读数**属于哪张卡**（`licenses.id`）。
 *
 * 为什么需要它（r14 返工 / BUG-082 二阶）：`/v1/usage` 是拿**一把 relay key** 去问的，
 * 回答只描述那把 key 对应的那张卡。key 是全局单例（`relay-key.ts`，同一时刻只有一把），
 * 而"展示中的卡"是每次读取现算出来的 —— 两者可能不是同一张卡（切卡 / 切账号 / 激活新卡
 * 的那段窗口）。旧实现把两个来源**直接合并**，于是 A 卡的在途预占会被算到 B 卡头上。
 *
 * 纪律：
 *   · 一把 key **先认一次主**（第一次成功读到读数的那张卡），之后**只认**那张卡；
 *     拿同一把 key 去问另一张卡 ⇒ 一律当"读不到"（未知），绝不合并。
 *   · 认主只发生在**真读到读数**时；失败不认领，免得把一次抖动钉成"这张卡的"。
 *   · relay key 对一张卡是**生成一次固定不变**的（见 `relay-startup.ts`），所以
 *     key 变了就是卡变了 —— 新 key 会被重新认主。
 *   · 账户边界（`clearLicense`）清空 —— 登出后不留上一张卡的归属。
 */
const relayKeyHeldOwner = new Map<string, string>();

interface HeldRead {
  /** 真读到读数才有值；`null` = 根本没读到（第 ③ 态）。 */
  heldMicros: number | null;
  /** `false` ⇒ 预占口径不可判定（后端明说，或这次压根没读到）。 */
  heldComplete: boolean;
}

/** 第 ③ 态：读不到 ⇒ 没有读数，且口径不可判定。 */
const HELD_UNREAD: HeldRead = { heldMicros: null, heldComplete: false };

async function readRelayHeldMicros(target: { licenseId: string }): Promise<HeldRead> {
  // 没有活体 relay key ⇒ 连不上中转（未激活 / 未 bootstrap）⇒ 如实返回"问不到"。
  const key = getActiveRelayKey();
  if (!key) return HELD_UNREAD;

  // 卡身份核对：这把 key 已经认过主，且认的不是展示中的这张卡 ⇒ 它的读数**不属于**这张卡。
  const owner = relayKeyHeldOwner.get(key);
  if (owner !== undefined && owner !== target.licenseId) return HELD_UNREAD;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELAY_HELD_TIMEOUT_MS);
  try {
    const res = await fetch(`${normalizeBaseUrl(activeRelayBaseUrl())}/v1/usage`, {
      headers: { authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!res.ok) return HELD_UNREAD;
    const body = (await res.json()) as { heldMicros?: unknown; heldComplete?: unknown };
    const held = body.heldMicros;
    const complete = body.heldComplete;
    // 坏形状（缺字段 / 非数 / 负数 / 非布尔）一律当"没读到"，不当 0。
    if (typeof held !== 'number' || !Number.isFinite(held) || held < 0) return HELD_UNREAD;
    if (typeof complete !== 'boolean') return HELD_UNREAD;
    // 真读到读数 ⇒ 把归属记下来（幂等：只认第一次）。
    if (!relayKeyHeldOwner.has(key)) relayKeyHeldOwner.set(key, target.licenseId);
    return { heldMicros: held, heldComplete: complete };
  } catch {
    // 网络失败 / 超时 / JSON 坏 —— 预占读不到不是授权失败，但要如实说"不可判定"。
    return HELD_UNREAD;
  } finally {
    clearTimeout(timer);
  }
}

async function readLicenseStatusUnlocked(generation: number): Promise<IpcResult<LicenseStatus>> {
  const fingerprint = deviceFingerprint();
  const { licenseKey: storedKey, licenseBinding: storedBinding } = readStoredLicense();
  const base: LicenseStatus = {
    configured: false,
    licenseId: null,
    orgId: null,
    licenseKey: storedKey,
    sku: null,
    status: null,
    expiresAt: null,
    maxActivations: 0,
    tokenQuotaMicros: 0,
    tokenUsedMicros: 0,
    activated: false,
    deviceFingerprint: fingerprint,
  };

  const supabase = getCommercialClient();
  if (!supabase) return { ok: true, result: base };

  try {
    const auth = await withLicenseBackendTimeout(supabase.auth.getUser(), 'auth.getUser');
    const userId = auth.data.user?.id ?? null;
    if (auth.error || !userId) return { ok: true, result: base };

    const ownedOrgIds = await ownerOrgIds(supabase, userId);
    const ownedOrgSet = new Set(ownedOrgIds);

    // Look the licence up by this machine's stored key first, then by account.
    //
    // The account lookup is what makes a new machine work. A fresh install has
    // no stored key, but the card belongs to the account — and *that*, not a
    // row in license_activations, is what "I own this" means. Gating on the
    // device row is what used to lock people out after a reinstall while
    // protecting nothing (see migration 20260911000008).
    // `license_select` intentionally exposes a row to every member of its org,
    // but activate_license authorizes owners only.  Therefore RLS visibility is
    // not sufficient: the row's org must be in this exact user's owner rows.
    let license: LicenseRow | null = null;
    if (storedKey) {
      const stored = await withLicenseBackendTimeout(
        supabase.from('licenses').select(LICENSE_FIELDS).eq('license_key', storedKey).maybeSingle(),
        'licenses.select',
      );
      if (stored.error) throw stored.error;
      const candidate = stored.data as LicenseRow | null;
      const candidateOrgId = String(candidate?.org_id ?? '');
      const candidateLicenseId = String(candidate?.id ?? '');
      const exactStoredBinding =
        !storedBinding ||
        (storedBinding.userId === userId &&
          storedBinding.orgId === candidateOrgId &&
          storedBinding.licenseId === candidateLicenseId);
      if (candidate && ownedOrgSet.has(candidateOrgId) && exactStoredBinding) license = candidate;
    }

    if (!license && ownedOrgIds.length > 0) {
      const active = await withLicenseBackendTimeout(
        supabase.from('org_active_license').select(LICENSE_FIELDS).in('org_id', ownedOrgIds),
        'org_active_license.select',
      );
      if (active.error) throw active.error;
      const rank = new Map(ownedOrgIds.map((orgId, index) => [orgId, index]));
      license =
        ((active.data ?? []) as LicenseRow[])
          .filter((row) => ownedOrgSet.has(String(row.org_id ?? '')))
          .sort(
            (left, right) =>
              (rank.get(String(left.org_id ?? '')) ?? Number.MAX_SAFE_INTEGER) -
              (rank.get(String(right.org_id ?? '')) ?? Number.MAX_SAFE_INTEGER),
          )[0] ?? null;
    }

    if (!license) {
      // The signed-in account cannot legally activate the cached key. Keeping it
      // would let relay bootstrap call activate_license with a previous/member
      // account's card even though the entitlement check rejected it.
      // ⭐ 2026-10-17 统一审核 §T33①：这条清绑定**不在**那 6 处账户边界上（例如"消费中
      //    每几秒一次"的 `readQuotaSnapshot` 轮询也会走到这里）—— 归属刚被抹成匿名，
      //    必须顺手把 `MEMORY.md` 重投影一次，否则上一个账号的已确认记忆会随共享文件
      //    留到下一轮提示词，直到下次启动 / 边界才清。**只在真正清掉绑定时**触发
      //    （`clearPersistedLicenseBinding` 返回 true），不是每次读取都投。
      //    fire-and-forget：账户边界绝不能因为记忆没投影上而失败（同 `account-switch` 纪律）。
      if (clearPersistedLicenseBinding(generation)) void resyncMemoryOnAccountBoundary();
      return { ok: true, result: { ...base, licenseKey: null } };
    }
    if (!isCurrentLicenseGeneration(generation)) {
      return { ok: true, result: { ...base, licenseKey: null } };
    }
    persistLicenseBinding(userId, license, generation);

    // 在途预占（BUG-082）：只增的附加信息，**读不到不算"没有预占"**（见 readRelayHeldMicros
    // 的三态说明）。读数只属于**这把 relay key 的那张卡** —— 用展示中的这张卡的 id 认领。
    const selectedLicenseId = String(license.id ?? '');
    const held = await readRelayHeldMicros({ licenseId: selectedLicenseId });

    // ⚠️ 读数在途期间授权代次可能已经变了（切卡 / 切账号 / 登出）：这时这份 held 连同
    //    整条授权结论都已经过期，必须丢弃 —— 否则旧卡的在途冻结会落到新身份的界面里。
    if (!isCurrentLicenseGeneration(generation)) {
      return { ok: true, result: { ...base, licenseKey: null } };
    }

    return {
      ok: true,
      result: {
        configured: true,
        licenseId: selectedLicenseId || null,
        orgId: String(license.org_id ?? '') || null,
        licenseKey: (license.license_key as string) ?? null,
        sku: (license.sku as string) ?? null,
        status: (license.status as string) ?? null,
        expiresAt: (license.expires_at as string) ?? null,
        maxActivations: Number(license.max_activations ?? 0),
        tokenQuotaMicros: Number(license.token_quota_micros ?? 0),
        tokenUsedMicros: Number(license.token_used_micros ?? 0),
        // 只有**真读到**读数才写 tokenHeldMicros；heldComplete 一律写（false = 不可判定）。
        ...(held.heldMicros !== null ? { tokenHeldMicros: held.heldMicros } : {}),
        heldComplete: held.heldComplete,
        // Ownership, not device registration. See the comment above.
        activated: true,
        deviceFingerprint: fingerprint,
      },
    };
  } catch (error) {
    return fail(error, 'license_read_failed');
  }
}

export function readLicenseStatus(): Promise<IpcResult<LicenseStatus>> {
  const generation = getLicenseGeneration();
  return runLicenseOperation(() => readLicenseStatusUnlocked(generation));
}

/**
 * 激活 / 取中转凭证失败原因的**闭集**（安全码：可以进日志、可以进结构化结果、
 * 界面按它选文案）。
 *
 * ⚠️ 这一份码表**有两个调用方**：手动激活（`activateLicense` → IPC → 界面）与
 * relay 启动时的取 key 边界（`relay-startup.ts` → `RelayBootstrapResult`）。
 * 两边都必须走下面这**同一个** `mapActivationError()` —— 各写一份 message 匹配，
 * 两边迟早会漂；而漂了之后"同一个错误，界面说的和日志说的不一样"极难查。
 */
export type ActivationErrorCode =
  | 'license_bound_elsewhere'
  | 'license_not_found'
  | 'license_inactive'
  | 'license_expired'
  | 'activation_limit_reached'
  | 'activation_failed';

/**
 * Translates what activate_license() raised into a code the UI can localise.
 *
 * check_activation_limit() runs as a BEFORE INSERT trigger and raises
 * check_violation, so the activation limit is the one branch carrying a
 * SQLSTATE of its own (23514). Everything else shares P0001, which says nothing
 * about which check failed, so those still have to be told apart by the message
 * text the function emits.
 *
 * ⚠️ 返回的是**闭集**里的码，不是自由字符串。
 *
 * ## 原始 message 的口径（别读成全局承诺）
 *
 * - **结构化中继路径**（`relay-startup.ts` 取中转 key）**只**用这个码：原文既不进
 *   日志、也不进 `RelayBootstrapResult`。`activate_license` 的入参就是卡密，
 *   服务端文案很可能回显它。
 * - **手动激活**那条 IPC 路径**刻意**仍把 `String(error.message)` 一起返回给界面
 *   （`activateLicense` 的 `IpcResult.error`）—— 那是 `90c9853` 特意加的出口：
 *   用户要看到"为什么"，界面上按 `errorCode` 选文案、不解析这段文本。
 */
export function mapActivationError(error: { code?: string; message?: string }): ActivationErrorCode {
  const sqlState = typeof error.code === 'string' ? error.code : '';
  const message = String(error.message ?? '');

  // The Chinese wording stays as a fallback: it is the only signal present when
  // an error reaches us without a code.
  if (sqlState === '23514' || message.includes('激活数已达上限')) return 'activation_limit_reached';

  if (sqlState === 'P0002') {
    // P0002 also covers "no organization for user", which is a broken account
    // rather than a bad key — don't tell the user their card number is wrong.
    return message.includes('organization') ? 'activation_failed' : 'license_not_found';
  }

  if (message.includes('not found')) return 'license_not_found';
  if (message.includes('expired')) return 'license_expired';
  if (message.includes('another organization')) return 'license_bound_elsewhere';
  // Suspended / revoked cards come back as "license is <status>".
  if (message.includes('license is ')) return 'license_inactive';
  return 'activation_failed';
}

function isUnknownActivationOutcome(error: unknown): boolean {
  if (error instanceof LicenseBackendTimeoutError) return true;
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function unknownActivationResult(): IpcResult<LicenseStatus> {
  return {
    ok: false,
    error: 'License activation response was not received; the server outcome is unknown',
    errorCode: 'activation_outcome_unknown',
  };
}

/**
 * A lost HTTP response is not proof that Postgres rolled the transaction back.
 * Confirm only the exact card, exact owner and exact live device activation.
 * Ownership alone is insufficient: `readLicenseStatusUnlocked()` deliberately
 * treats an account-owned card as usable on a new installation.
 */
async function reconcileUnknownActivation(
  supabase: CommercialClient,
  licenseKey: string,
  fingerprint: string,
  generation: number,
): Promise<IpcResult<LicenseStatus> | null> {
  try {
    const auth = await withLicenseBackendTimeout(supabase.auth.getUser(), 'auth.getUser');
    const userId = auth.data.user?.id ?? null;
    if (auth.error || !userId) return null;

    const ownedOrgIds = await ownerOrgIds(supabase, userId);
    const exact = await withLicenseBackendTimeout(
      supabase.from('licenses').select(LICENSE_FIELDS).eq('license_key', licenseKey).maybeSingle(),
      'licenses.select',
    );
    if (exact.error || !exact.data) return null;
    const license = exact.data as LicenseRow;
    const licenseId = String(license.id ?? '');
    const orgId = String(license.org_id ?? '');
    if (!licenseId || !ownedOrgIds.includes(orgId)) return null;

    const activation = await withLicenseBackendTimeout(
      supabase
        .from('license_activations')
        .select('id')
        .eq('license_id', licenseId)
        .eq('device_fingerprint', fingerprint)
        .is('revoked_at', null)
        .maybeSingle(),
      'license_activations.select',
    );
    if (activation.error || !activation.data || !isCurrentLicenseGeneration(generation)) return null;

    persistLicenseBinding(userId, license, generation);
    const status = await readLicenseStatusUnlocked(generation);
    if (
      !isCurrentLicenseGeneration(generation) ||
      !status.ok ||
      !status.result?.activated ||
      status.result.licenseKey !== licenseKey ||
      status.result.licenseId !== licenseId ||
      status.result.orgId !== orgId ||
      status.result.deviceFingerprint !== fingerprint
    )
      return null;
    return { ...status, result: { ...status.result, relayConfigured: false } };
  } catch {
    return null;
  }
}

async function activateLicenseUnlocked(licenseKey: string, generation: number): Promise<IpcResult<LicenseStatus>> {
  if (!isCurrentLicenseGeneration(generation)) {
    return { ok: false, error: 'License activation was superseded', errorCode: 'activation_failed' };
  }
  const supabase = getCommercialClient();
  if (!supabase) {
    return { ok: false, error: 'Commercial backend is not configured', errorCode: 'not_configured' };
  }

  const trimmed = licenseKey.trim();
  if (!trimmed) {
    return { ok: false, error: 'License key is empty', errorCode: 'empty_key' };
  }

  const fingerprint = deviceFingerprint();
  try {
    // Direct table access cannot work here: a freshly minted licence has a null
    // org_id, and the RLS policy is `org_id in (auth_org_ids())` — null matches
    // nothing, so the row is invisible to every user. The definer function does
    // the claim, the limit check and the activation row in one transaction.
    const {
      data,
      error,
      status: httpStatus,
    } = await withLicenseBackendTimeout(
      supabase.rpc('activate_license', {
        p_license_key: trimmed,
        p_device_fingerprint: fingerprint,
        // 过渡期：让服务端把这台机器**旧的**（按电脑算的）登记原地升级成 v2，不占新名额。
        p_legacy_fingerprint: legacyDeviceFingerprint(),
      }),
      'activate_license',
      ACTIVATION_RESPONSE_TIMEOUT_MS,
    );

    if (error) {
      const mapped = mapActivationError(error);
      if (httpStatus === 0 || (!String(error.code ?? '') && mapped === 'activation_failed')) {
        return (
          (await reconcileUnknownActivation(supabase, trimmed, fingerprint, generation)) ?? unknownActivationResult()
        );
      }
      return { ok: false, error: String(error.message ?? ''), errorCode: mapped };
    }

    if (!isCurrentLicenseGeneration(generation)) {
      return { ok: false, error: 'License activation was superseded', errorCode: 'activation_failed' };
    }

    // The key has just crossed the server authorization boundary. Drop any
    // previous card's triple so the live row below can establish and persist
    // the newly activated owner/org/license identity.
    updateConfig({
      commercial: { ...readConfig()?.commercial, licenseKey: trimmed, licenseBinding: undefined } as never,
    });

    // 把中转配置写进网关。**写失败不让激活整体失败** —— 授权已经绑定成功了，
    // 重试配置写入比让用户重新激活代价小。失败只在状态里带一个 relayConfigured: false。
    const relayConfigured = await configureRelay((data as { relayKey?: string | null } | null)?.relayKey ?? null);

    if (!isCurrentLicenseGeneration(generation)) {
      return { ok: false, error: 'License activation was superseded', errorCode: 'activation_failed' };
    }

    const status = await readLicenseStatusUnlocked(generation);
    return status.ok && status.result ? { ...status, result: { ...status.result, relayConfigured } } : status;
  } catch (error) {
    if (isUnknownActivationOutcome(error)) {
      return (
        (await reconcileUnknownActivation(supabase, trimmed, fingerprint, generation)) ?? unknownActivationResult()
      );
    }
    return fail(error, 'activation_failed');
  }
}

export function recoverLicenseActivation(licenseKey: string): Promise<IpcResult<LicenseStatus>> {
  const generation = getLicenseGeneration();
  return runLicenseOperation(async () => {
    const supabase = getCommercialClient();
    if (!supabase) return { ok: false, errorCode: 'not_configured' };
    const trimmed = licenseKey.trim();
    if (!trimmed) return { ok: false, errorCode: 'empty_key' };
    if (!isCurrentLicenseGeneration(generation)) return unknownActivationResult();
    return (
      (await reconcileUnknownActivation(supabase, trimmed, deviceFingerprint(), generation)) ??
      unknownActivationResult()
    );
  });
}

export function activateLicense(licenseKey: string): Promise<IpcResult<LicenseStatus>> {
  const generation = nextLicenseGeneration();
  return runLicenseOperation(() => activateLicenseUnlocked(licenseKey, generation));
}

/**
 * 激活成功后把中转服务配置写进本地网关。
 *
 * 为什么走网关的 `config.patch` 而不是写盘上的 `openclaw.json`：
 * 客户端本来就不直接改那个文件（见 `team-installer.ts` 的既有用法），
 * 跟着既有模式走才能继承既有的并发保护。
 *
 * ⚠️ 配置写入**不是**激活成功的必要条件 —— 调用方只把它当附加信息。
 */
async function configureRelay(relayKey: string | null): Promise<boolean> {
  if (!relayKey) {
    // 服务端没下发 key（迁移 11 之前的旧卡，或 RPC 返回形状变了）。
    // 不静默：这是「中转没配上」的一个具体原因，排查时要知道是哪一个。
    getDebugLogger().warn({ domain: 'commercial', event: 'relay.config-no-key', data: {} });
    return false;
  }

  // 挑一个连上的网关写。多网关时写第一个 —— 与用量上报挑网关的口径一致。
  const selected = Array.from(getAllGatewayClients().entries()).find(([, gw]) => gw.isConnected);
  if (!selected) {
    getDebugLogger().warn({ domain: 'commercial', event: 'relay.config-no-gateway', data: {} });
    return false;
  }
  const [gatewayId, gateway] = selected;

  const result = await gateway.runConfigMutation((tx) =>
    applyRelayConfig(
      {
        getConfig: tx.getConfig,
        patchConfig: tx.patchConfig,
        resolveDefaultModel: fetchFirstRelayModel,
        resolveCatalogModels: fetchRelayCatalogModelEntries,
        resolveMediaCapabilities: fetchRelayMediaCapabilities,
        log: (event, data) => getDebugLogger().info({ domain: 'commercial', event, data }),
      },
      {
        relayKey,
        deviceFingerprint: deviceFingerprint(),
        webSearch: readConfig()?.webSearch,
        bundledWebSearchAvailable:
          gatewayId === LOCAL_GATEWAY_ID && hasInstalledSearchProvider(getActiveLocalGatewayStateDir()),
      },
    ),
  );

  if (!result.configured) {
    getDebugLogger().warn({
      domain: 'commercial',
      event: 'relay.config-not-applied',
      data: { errorCode: result.errorCode, error: result.error, warnings: result.warnings },
    });
  }
  return result.configured;
}

/**
 * 作废本地全部商业凭证（**账户边界**：登录成功 / 登出 / 手动清卡）。
 *
 * 三件事，顺序即纪律：
 *   ① 代次 +1 —— 在途的 license 读取/激活/恢复立刻作废（见 `license-generation.ts`）；
 *   ② **先清内存里那把活体 relay key** —— 它不依赖任何 I/O，必须在任何可能抛错
 *      的写盘之前落定（只读盘上也能作废）；
 *   ③ 再清盘上的 `licenseKey` / `licenseBinding`。
 *
 * ⚠️ 为什么必须带上 ②（2026-10-15 便携硬合同 P-C 的实测缺口）：
 *    `relay-key.ts` 的那把 key 是**上个账号**的凭证（`applyRelayConfig` 写进网关的
 *    那把就是它，视频那条直呼 relay 的通道只用它）。账户边界之后到"新账号的配置
 *    真正落进网关"之前有一段窗口（清理 pending、等网关、等授权恢复）——
 *    少了 ②，这段窗口里主进程会拿**旧账号的 key** 出站，正是合同点名禁止的
 *    「沿用上个账号授权发起新请求」；登出之后更不该留着它等下一个账号。
 *    新账号就绪时 `applyRelayConfig` 会重新写回它的 key（同一个漏斗）。
 */
export function clearLicense(): IpcResult {
  nextLicenseGeneration();
  setActiveRelayKey(null);
  // 账户边界：上一张卡的 relay key 归属也一并作废（key 本身已经清了，留着归属没有意义，
  // 且会让"新账号的 key 恰好等于旧 key"这种不可能的分支带着旧卡身份跑）。
  relayKeyHeldOwner.clear();
  const current = readConfig()?.commercial;
  if (current) {
    updateConfig({ commercial: { ...current, licenseKey: undefined, licenseBinding: undefined } });
  }
  return { ok: true };
}
