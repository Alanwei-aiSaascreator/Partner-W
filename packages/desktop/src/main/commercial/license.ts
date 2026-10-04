import { hostname, arch, platform } from 'node:os';
import { createHash } from 'node:crypto';
import type { IpcResult } from '@clawwork/shared';
import { getCommercialClient } from './client.js';
import { ensureDeviceId, readConfig, updateConfig } from '../workspace/config.js';
import { getAllGatewayClients } from '../ws/index.js';
import { getDebugLogger } from '../debug/index.js';
import { applyRelayConfig, fetchFirstRelayModel, fetchRelayMediaCapabilities } from './relay-config.js';
import { COMMERCIAL_REQUEST_TIMEOUT_MS } from './request-timeout.js';
import { LOCAL_GATEWAY_ID } from '../runtime/state-config.js';
import { getActiveLocalGatewayDeploymentRoot } from '../runtime/index.js';
import { hasBundledSearchProvider } from '../runtime/bundled-search.js';
import { advanceLicenseGeneration, getLicenseGeneration } from './license-generation.js';

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

export function deviceFingerprint(): string {
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

function clearPersistedLicenseBinding(generation: number): void {
  if (!isCurrentLicenseGeneration(generation)) return;
  const current = readConfig()?.commercial;
  if (!current?.licenseKey && !current?.licenseBinding) return;
  updateConfig({ commercial: { ...current, licenseKey: undefined, licenseBinding: undefined } });
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
      clearPersistedLicenseBinding(generation);
      return { ok: true, result: { ...base, licenseKey: null } };
    }
    if (!isCurrentLicenseGeneration(generation)) {
      return { ok: true, result: { ...base, licenseKey: null } };
    }
    persistLicenseBinding(userId, license, generation);

    return {
      ok: true,
      result: {
        configured: true,
        licenseId: String(license.id ?? '') || null,
        orgId: String(license.org_id ?? '') || null,
        licenseKey: (license.license_key as string) ?? null,
        sku: (license.sku as string) ?? null,
        status: (license.status as string) ?? null,
        expiresAt: (license.expires_at as string) ?? null,
        maxActivations: Number(license.max_activations ?? 0),
        tokenQuotaMicros: Number(license.token_quota_micros ?? 0),
        tokenUsedMicros: Number(license.token_used_micros ?? 0),
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
        resolveMediaCapabilities: fetchRelayMediaCapabilities,
        log: (event, data) => getDebugLogger().info({ domain: 'commercial', event, data }),
      },
      {
        relayKey,
        deviceFingerprint: deviceFingerprint(),
        webSearch: readConfig()?.webSearch,
        bundledWebSearchAvailable:
          gatewayId === LOCAL_GATEWAY_ID && hasBundledSearchProvider(getActiveLocalGatewayDeploymentRoot()),
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

export function clearLicense(): IpcResult {
  nextLicenseGeneration();
  const current = readConfig()?.commercial;
  if (current) {
    updateConfig({ commercial: { ...current, licenseKey: undefined, licenseBinding: undefined } });
  }
  return { ok: true };
}
