/**
 * P-C（便携首启硬合同 · 换 Windows 用户 / 换Partner-W账号）—— **真实入口**商业链用例。
 *
 * 合同（`reviews/2026-10-15-portable-first-start-contract.md` §2 / §3 P-C / §7）：
 *
 *   safeStorage 解密失败（跨 Windows 用户）→ 正常登录 → 清旧账号商业状态
 *   → 恢复当前授权 → 等网关 → 商业配置成功，**必须在同一次应用进程启动内完成**；
 *   账号切换中旧请求的迟到回执不得恢复旧授权 / 旧 relay；清理失败不得把新账号的
 *   状态留在旧代次。D1 = 各账号各用自己的卡（不改授权模型）；D2 = 同盘工作区/任务/
 *   文件共用（切换不清共享数据）。
 *
 * ## 为什么是这个文件（而不是又一组 mock 单测）
 *
 * 这里驱动的是**真实入口**：`ipc/commercial-handlers.ts` 注册出来的真 handler、
 * `commercial/relay-startup.ts` 的真单飞调度器、真 `license.ts`（含
 * `license-generation` 代次）、真 `relay-cleanup.ts` / `relay-config.ts`
 * （含 BUG-080 的分段收缩），只在**进程边界**上放夹具：
 *
 *   · electron（ipcMain / app.getPath / safeStorage —— 按 Windows 用户模拟 DPAPI 作用域）
 *   · @supabase/supabase-js 的 createClient（零网络；但**会话存储接真 storage**，
 *     所以"safeStorage 解不开 ⇒ 无会话"这件事走的是 client.ts 的真实读取）
 *   · ws 网关客户端（真 get→patch→verify 语义 + 乐观锁 + size-drop 守卫）
 *   · workspace/config（内存版，undefined 字段删除语义与写盘一致）
 *
 * ⚠️ 全程**不重置模块图**：`relay-key.ts` 的活体 key、公开状态 store、许可代次都
 *    是模块级单例 —— 重置会把"代码写的那一份"和"断言读的那一份"分开，测出来的是
 *    夹具而不是产品。用例之间用 beforeEach 显式回到起点。
 *
 * 零付费：不出网、不打真模型 / 短信 / 生产；relay 目录与媒体探针在边界上被替换。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 生产 relay 基址（`relay-config.ts` 的 `RELAY_BASE_URL`）—— 写入与识别共用这一个串。 */
const RELAY_BASE = 'https://api.rongyinghudong.com/relay';

const h = vi.hoisted(() => {
  const sentEvents: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  const logs: Array<{ level: 'info' | 'warn'; event: string; data: Record<string, unknown> }> = [];
  return {
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    userDataDir: '',
    /** 当前 Windows 用户（safeStorage 的 DPAPI 作用域）。 */
    windowsUser: 'W1',
    encryptionAvailable: true,
    config: null as Record<string, unknown> | null,
    storage: null as null | {
      getItem: () => string | null;
      setItem: (key: string, value: string) => void;
      removeItem: () => void;
    },
    phoneToUser: {} as Record<string, string>,
    memberships: [] as Array<Record<string, unknown>>,
    licenses: [] as Array<Record<string, unknown>>,
    activeLicenses: [] as Array<Record<string, unknown>>,
    relayKeys: {} as Record<string, string>,
    /** 让下一个 `licenses` 查询停在半空（模拟"旧账号的在途请求"）。 */
    stallLicenseLookups: 0,
    stalledLookups: [] as Array<() => void>,
    gateway: {
      connected: true,
      /** 网关的 `size-drop` 写守卫（BUG-080：新配置 < 旧配置一半 ⇒ 整条拒写）。 */
      guardSizeDrop: false,
      /** 非 size-drop 的确定性拒绝（schema 层）：设置后**删除 provider** 的补丁一律被拒。 */
      rejectRemovalWith: null as string | null,
      /** 接下来 N 次 `config.get` 直接失败（模拟网关在途抖动 ⇒ 清理落 pending）。 */
      failGetConfigTimes: 0,
      /** 让下一次网关写（config.patch）停在半空（模拟"在途的准备请求"卡在写网关那一步）。 */
      stallNextPatch: false,
      releaseStalledPatch: null as null | (() => void),
      hashSeq: 0,
      hash: 'h0',
      doc: {} as Record<string, unknown>,
      patchCalls: [] as Array<{ raw: string; replacePaths: string[] }>,
      queue: Promise.resolve() as Promise<unknown>,
    },
    sentEvents,
    logs,
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn);
    },
  },
  app: { getPath: () => h.userDataDir },
  /**
   * safeStorage 的**跨 Windows 用户**真相：DPAPI 密文只在加密它的那个用户下解得开。
   * 这里把"当前用户"编进密文前缀 —— 换用户之后 decryptString 必然抛（与真实现同形）。
   */
  safeStorage: {
    isEncryptionAvailable: () => h.encryptionAvailable,
    encryptString: (value: string) => Buffer.from(`dpapi:${h.windowsUser}|${value}`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const raw = buffer.toString('utf8');
      const prefix = `dpapi:${h.windowsUser}|`;
      if (!h.encryptionAvailable || !raw.startsWith(prefix)) {
        throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      }
      return raw.slice(prefix.length);
    },
  },
}));

/**
 * Supabase 客户端替身。**会话存储接的是真 storage**（由 `client.ts` 传进来）：
 * getItem 解不开 ⇒ 无会话 —— "跨 Windows 用户"那条从会话到登录页的路径因此是真的。
 */
vi.mock('@supabase/supabase-js', () => {
  const sessionUserId = (): string | null => {
    const raw = h.storage?.getItem() ?? null;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { user?: { id?: string } };
      return parsed?.user?.id ?? null;
    } catch {
      return null;
    }
  };
  const ownedOrgIds = (): string[] =>
    h.memberships
      .filter((row) => row.user_id === sessionUserId() && row.role === 'owner')
      .map((row) => String(row.org_id));

  const makeQuery = (table: string) => {
    const equals = new Map<string, unknown>();
    const inSets = new Map<string, readonly unknown[]>();
    const source = () =>
      table === 'org_members' ? h.memberships : table === 'licenses' ? h.licenses : h.activeLicenses;
    const rows = () =>
      source().filter((row) => {
        for (const [column, value] of equals) if (row[column] !== value) return false;
        for (const [column, values] of inSets) if (!values.includes(row[column])) return false;
        return true;
      });
    const node: Record<string, unknown> = {};
    node.select = () => node;
    node.eq = (column: string, value: unknown) => {
      equals.set(column, value);
      return node;
    };
    node.is = (column: string, value: unknown) => {
      equals.set(column, value);
      return node;
    };
    node.in = (column: string, values: readonly unknown[]) => {
      inSets.set(column, values);
      return node;
    };
    node.order = () => node;
    node.limit = () => node;
    node.maybeSingle = async () => {
      if (table === 'licenses' && h.stallLicenseLookups > 0) {
        h.stallLicenseLookups -= 1;
        await new Promise<void>((resolve) => h.stalledLookups.push(resolve));
      }
      return { data: rows()[0] ?? null, error: null };
    };
    node.then = (onFulfilled: (value: unknown) => unknown) =>
      Promise.resolve({ data: rows(), error: null }).then(onFulfilled);
    return node;
  };

  return {
    createClient: (_url: string, _key: string, options: { auth: { storage: NonNullable<typeof h.storage> } }) => {
      h.storage = options.auth.storage;
      return {
        auth: {
          getUser: async () => {
            const userId = sessionUserId();
            return { data: { user: userId ? { id: userId } : null }, error: null };
          },
          signInWithOtp: async () => ({ data: {}, error: null }),
          verifyOtp: async ({ phone }: { phone?: string }) => {
            const userId = h.phoneToUser[String(phone ?? '')] ?? null;
            if (!userId) return { data: { user: null }, error: { message: 'unknown target' } };
            h.storage?.setItem(
              'supabase.auth.token',
              JSON.stringify({ access_token: `token-${userId}`, user: { id: userId } }),
            );
            return { data: { user: { id: userId } }, error: null };
          },
          signOut: async () => {
            h.storage?.removeItem();
            return { error: null };
          },
        },
        from: makeQuery,
        rpc: async (name: string, params: Record<string, unknown>) => {
          if (name !== 'activate_license') {
            return { data: null, error: { code: 'PGRST202', message: `unknown rpc ${name}` } };
          }
          const key = String(params.p_license_key ?? '');
          const license = h.licenses.find((row) => row.license_key === key);
          if (!license) return { data: null, error: { code: 'P0002', message: 'license not found' }, status: 400 };
          if (!ownedOrgIds().includes(String(license.org_id))) {
            // 迁移 56 的真实形状：卡绑在别的组织（T15 的具名拒绝走这条）。
            return {
              data: null,
              error: {
                code: 'P0001',
                message: `activate_license: license ${key} is already bound to another organization`,
              },
              status: 400,
            };
          }
          return { data: { relayKey: h.relayKeys[key] ?? null }, error: null };
        },
      };
    },
  };
});

vi.mock('../src/main/workspace/config.js', () => ({
  ensureDeviceId: () => 'stable-device-id',
  readConfig: () => h.config,
  // 与真实现同语义：浅合并后写盘 —— `undefined` 字段在 JSON 序列化里被删掉（= 清除）。
  updateConfig: (partial: Record<string, unknown>) => {
    h.config = JSON.parse(JSON.stringify({ ...(h.config ?? {}), ...partial })) as Record<string, unknown>;
    return h.config;
  },
}));

vi.mock('../src/main/debug/index.js', () => ({
  initDebugLogger: vi.fn(),
  getDebugLogger: () => ({
    info: (entry: { event?: string; data?: Record<string, unknown> }) => {
      h.logs.push({ level: 'info', event: String(entry?.event ?? ''), data: entry?.data ?? {} });
    },
    warn: (entry: { event?: string; data?: Record<string, unknown> }) => {
      h.logs.push({ level: 'warn', event: String(entry?.event ?? ''), data: entry?.data ?? {} });
    },
    error: vi.fn(),
    flush: vi.fn(),
  }),
}));

vi.mock('../src/main/window-manager.js', () => ({
  getMainWindow: () => ({
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => {
        h.sentEvents.push({ channel, payload: payload as Record<string, unknown> });
      },
    },
  }),
  setMainWindow: vi.fn(),
}));

vi.mock('../src/main/runtime/state-config.js', () => ({ LOCAL_GATEWAY_ID: 'local-runtime' }));
vi.mock('../src/main/runtime/index.js', () => ({
  getActiveLocalGatewayStateDir: () => join(h.userDataDir, 'state'),
}));
vi.mock('../src/main/runtime/bundled-search.js', () => ({ hasInstalledSearchProvider: () => false }));

/**
 * 中转目录 / 媒体能力探针：**不出网**（零付费纪律）。其余 `relay-config` 函数
 * （apply/remove/relayProviderIds…）全部是真身 —— "写没写进网关"必须是真的。
 */
vi.mock('../src/main/commercial/relay-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/commercial/relay-config.js')>()),
  fetchFirstRelayModel: vi.fn(async () => null),
  fetchRelayCatalogModelEntries: vi.fn(async () => null),
  fetchRelayMediaCapabilities: vi.fn(async () => ({ image: false, video: false })),
}));

/**
 * 网关客户端（夹具）：语义与 `ws/gateway-client.ts` 的三条硬合同对齐 ——
 * ① `config.get` 对 apiKey **脱敏**（回读永远拿不到真 key，见 relay-key.ts 的教训）；
 * ② `patchConfig` 带乐观锁（baseHash 不匹配就说 "config changed since last load"）；
 * ③ `runConfigMutation` 串行排队（同一客户端的配置写永不并发）；
 * ④ 可选 `size-drop` 守卫（BUG-080：新配置 < 旧配置一半且旧配置 ≥512B ⇒ 整条拒写）。
 */
vi.mock('../src/main/ws/index.js', () => {
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const redact = (doc: Record<string, unknown>): Record<string, unknown> => {
    const copy = clone(doc);
    const providers = (copy.models as { providers?: Record<string, Record<string, unknown>> } | undefined)?.providers;
    for (const entry of Object.values(providers ?? {})) {
      if (entry && typeof entry === 'object' && 'apiKey' in entry) entry.apiKey = '__OPENCLAW_REDACTED__';
    }
    return copy;
  };
  const mergeInto = (
    base: Record<string, unknown>,
    patch: Record<string, unknown>,
    path: string,
    replacePaths: readonly string[],
  ): Record<string, unknown> => {
    for (const [key, value] of Object.entries(patch)) {
      const childPath = path ? `${path}.${key}` : key;
      if (value === null) {
        delete base[key];
        continue;
      }
      if (Array.isArray(value)) {
        const keyedById = value.every(
          (item) => item !== null && typeof item === 'object' && 'id' in (item as Record<string, unknown>),
        );
        if (replacePaths.includes(childPath) || !keyedById) {
          base[key] = value;
          continue;
        }
        const existing = Array.isArray(base[key]) ? (base[key] as Array<Record<string, unknown>>) : [];
        const merged = existing.map((item) => ({ ...item }));
        for (const item of value as Array<Record<string, unknown>>) {
          const index = merged.findIndex((candidate) => candidate.id === item.id);
          if (index >= 0) merged[index] = { ...merged[index], ...item };
          else merged.push(item);
        }
        base[key] = merged;
        continue;
      }
      if (typeof value === 'object') {
        const existing =
          base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])
            ? (base[key] as Record<string, unknown>)
            : {};
        base[key] = mergeInto({ ...existing }, value as Record<string, unknown>, childPath, replacePaths);
        continue;
      }
      base[key] = value;
    }
    return base;
  };

  const makeClient = () => {
    const getConfig = async () => {
      if (h.gateway.failGetConfigTimes > 0) {
        h.gateway.failGetConfigTimes -= 1;
        const error = new Error('not connected') as Error & { code?: string };
        error.code = 'GATEWAY_NOT_CONNECTED';
        throw error;
      }
      return { hash: h.gateway.hash, config: redact(h.gateway.doc) };
    };
    const patchConfig = async ({
      baseHash,
      raw,
      replacePaths = [],
    }: {
      baseHash: string;
      raw: string;
      replacePaths?: string[];
    }) => {
      if (h.gateway.stallNextPatch) {
        h.gateway.stallNextPatch = false;
        await new Promise<void>((resolve) => {
          h.gateway.releaseStalledPatch = resolve;
        });
      }
      if (baseHash !== h.gateway.hash) {
        throw new Error('config changed since last load; re-run config.get and retry');
      }
      if (h.gateway.rejectRemovalWith && /"clawrouter":\s*null/.test(raw)) {
        throw new Error(h.gateway.rejectRemovalWith);
      }
      const patch = JSON.parse(raw) as Record<string, unknown>;
      const next = mergeInto(clone(h.gateway.doc), patch, '', replacePaths);
      const before = Buffer.byteLength(JSON.stringify(h.gateway.doc), 'utf8');
      const after = Buffer.byteLength(JSON.stringify(next), 'utf8');
      if (h.gateway.guardSizeDrop && before >= 512 && after < before / 2) {
        throw new Error(
          `Config write rejected: ${replacePaths[0] ?? 'config'} (size-drop:${before}->${after}). ` +
            'The new config is much smaller than the previous one; refusing the write.',
        );
      }
      h.gateway.doc = next;
      h.gateway.hashSeq += 1;
      h.gateway.hash = `h${h.gateway.hashSeq}`;
      h.gateway.patchCalls.push({ raw, replacePaths: [...replacePaths] });
      return { ok: true, hash: h.gateway.hash };
    };
    return {
      isConnected: true,
      getConfig,
      patchConfig,
      runConfigMutation: <T>(work: (tx: unknown) => Promise<T>): Promise<T> => {
        const tx = { getConfig, setConfig: patchConfig, patchConfig };
        const operation = h.gateway.queue.then(() => work(tx));
        h.gateway.queue = operation.then(
          () => undefined,
          () => undefined,
        );
        return operation;
      },
    };
  };

  return {
    getAllGatewayClients: () => {
      const clients = new Map<string, unknown>();
      if (h.gateway.connected) clients.set('local-runtime', makeClient());
      return clients;
    },
    // BUG-133：登录 / 登出 / 激活 handler 会走 `memory/account-switch` 重投影 `MEMORY.md`。
    // 本用例只关心中转配置 ⇒ 把记忆那一路钉成"没有网关"，重投影静默跳过。
    getGatewayClient: () => null,
  };
});

// ---------------------------------------------------------------------------
// 模块（**单一代次**：不 resetModules —— 断言读的必须是代码写的那一份单例）
// ---------------------------------------------------------------------------

let handlers: typeof import('../src/main/ipc/commercial-handlers.js');
let startup: typeof import('../src/main/commercial/relay-startup.js');
let shared: typeof import('@clawwork/shared');
let clientModule: typeof import('../src/main/commercial/client.js');
let relayKeyModule: typeof import('../src/main/commercial/relay-key.js');

beforeAll(async () => {
  handlers = await import('../src/main/ipc/commercial-handlers.js');
  startup = await import('../src/main/commercial/relay-startup.js');
  shared = await import('@clawwork/shared');
  clientModule = await import('../src/main/commercial/client.js');
  relayKeyModule = await import('../src/main/commercial/relay-key.js');
});

// ---------------------------------------------------------------------------
// 夹具与工具
// ---------------------------------------------------------------------------

const licenseRow = (suffix: 'A' | 'B') => ({
  id: `license-${suffix}`,
  org_id: `org-${suffix}`,
  license_key: `RY-${suffix}-0001`,
  sku: 'USB-标准版',
  status: 'active',
  expires_at: null,
  issued_at: '2026-01-01T00:00:00Z',
  max_activations: 3,
  token_quota_micros: 5_000_000_000,
  token_used_micros: 0,
});

function installAccounts(): void {
  h.phoneToUser = { '+8613800000001': 'user-A', '+8613800000002': 'user-B' };
  h.memberships = [
    { user_id: 'user-A', org_id: 'org-A', role: 'owner', joined_at: '2026-01-01T00:00:00Z' },
    { user_id: 'user-B', org_id: 'org-B', role: 'owner', joined_at: '2026-01-02T00:00:00Z' },
  ];
  h.licenses = [licenseRow('A'), licenseRow('B')];
  h.activeLicenses = [licenseRow('A'), licenseRow('B')];
  h.relayKeys = { 'RY-A-0001': 'rly_A_key', 'RY-B-0001': 'rly_B_key' };
}

/** 旧 Windows 用户留下的网关配置：有 A 的中转 provider，也有**用户自己**的东西。 */
function previousUserGatewayDoc(): Record<string, unknown> {
  return {
    agents: { defaults: { model: { primary: 'clawrouter/deepseek-v4' }, greeting: 'keep-me' } },
    models: {
      providers: {
        clawrouter: { baseUrl: RELAY_BASE, apiKey: 'rly_A_key', headers: {} },
        'user-local': { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'user-key' },
      },
    },
    plugins: { allow: ['clawrouter', 'keep-this-plugin'] },
    channels: { keepThisChannel: { enabled: true } },
  };
}

/** 用指定 Windows 用户的"DPAPI"写会话文件（`client.ts` 的 enc: 前缀 + base64）。 */
function writeEncryptedSession(windowsUser: string, userId: string): void {
  const payload = `dpapi:${windowsUser}|${JSON.stringify({ access_token: `token-${userId}`, user: { id: userId } })}`;
  writeFileSync(
    join(h.userDataDir, 'commercial-session.json'),
    `enc:${Buffer.from(payload, 'utf8').toString('base64')}`,
    'utf8',
  );
}

function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`没注册 ${channel}`);
  return Promise.resolve(fn({}, ...args) as T | Promise<T>) as Promise<T>;
}

function submitOtp(phone: string): Promise<{ ok: boolean; errorCode?: string }> {
  return invoke('commercial:verify-otp', phone, '123456');
}

function provider(doc: Record<string, unknown>, id: string): Record<string, unknown> | undefined {
  const providers = (doc.models as { providers?: Record<string, Record<string, unknown>> } | undefined)?.providers;
  return providers?.[id];
}

function commercialConfig(): Record<string, unknown> {
  return (h.config?.commercial ?? {}) as Record<string, unknown>;
}

/** 命中"分段收缩"日志的轮次（BUG-080 的入口级证据）。 */
function shrinkRounds(): number[] {
  return h.logs
    .filter((entry) => entry.event === 'relay.config-remove-shrunk')
    .map((entry) => Number(entry.data.round ?? 0));
}

async function waitReady(timeout = 20_000): Promise<void> {
  await vi.waitFor(() => expect(shared.relayBootstrapPublicStateStore.get().phase).toBe('ready'), { timeout });
}

let workspaceDir = '';

beforeEach(() => {
  delete process.env.ROYIN_NATIVE_TEST_CONFIG;
  h.handlers.clear();
  h.userDataDir = mkdtempSync(join(tmpdir(), 'pc-userdata-'));
  workspaceDir = mkdtempSync(join(tmpdir(), 'pc-workspace-'));
  h.windowsUser = 'W1';
  h.encryptionAvailable = true;
  h.config = { commercial: { supabaseUrl: '', supabaseAnonKey: '' } };
  h.phoneToUser = {};
  h.memberships = [];
  h.licenses = [];
  h.activeLicenses = [];
  h.relayKeys = {};
  h.stallLicenseLookups = 0;
  h.stalledLookups = [];
  h.sentEvents = [];
  h.logs = [];
  h.gateway = {
    connected: true,
    guardSizeDrop: false,
    rejectRemovalWith: null,
    failGetConfigTimes: 0,
    stallNextPatch: false,
    releaseStalledPatch: null,
    hashSeq: 0,
    hash: 'h0',
    doc: {},
    patchCalls: [],
    queue: Promise.resolve(),
  };
  shared.resetRelayBootstrapPublicState();
  relayKeyModule.setActiveRelayKey(null);
  handlers.registerCommercialHandlers();
});

afterEach(() => {
  try {
    rmSync(h.userDataDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    /* 临时目录清不掉不影响断言 */
  }
});

// ---------------------------------------------------------------------------
// (a) 跨 Windows 用户首启：解不开的会话 → 正常登录 → 同一次进程内闭环
// ---------------------------------------------------------------------------

describe('(a) 跨 Windows 用户：safeStorage 解不开 → 登录 → 同进程完成商业准备', () => {
  it('⭐ 全链闭环：清旧账号 → 恢复当前授权 → 等网关 → 配置成功（不需要第二次登录/重启）', async () => {
    installAccounts();
    // 旧 Windows 用户（W1，Partner-W账号 A）留在盘上的现场
    h.config = {
      commercial: {
        supabaseUrl: '',
        supabaseAnonKey: '',
        licenseKey: 'RY-A-0001',
        licenseBinding: { userId: 'user-A', orgId: 'org-A', licenseId: 'license-A' },
      },
    };
    h.gateway.doc = previousUserGatewayDoc();
    writeEncryptedSession('W1', 'user-A');
    // 换 Windows 用户（W2）：同一块盘、同一份 userData，但 DPAPI 换了作用域
    h.windowsUser = 'W2';

    // 1) 本地快速态 / 会话读：如实报"未登录"，**不崩**（跨用户密文解不开）
    expect(clientModule.hasLocalSession()).toBe(false);
    await expect(invoke('commercial:local-session')).resolves.toEqual({ ok: true, result: false });
    const session = await invoke<{ ok: boolean; result: { signedIn: boolean } }>('commercial:session');
    expect(session.ok).toBe(true);
    expect(session.result.signedIn).toBe(false);

    // 2) 启动那一轮 bootstrap（渲染层还没挂上）：明确没登录 ⇒ idle，不是错误
    await startup.bootstrapCommercialRelay({ waitForGatewayMs: 15_000 });
    expect(shared.relayBootstrapPublicStateStore.get().phase).toBe('idle');

    // 3) 用户正常登录（B 的账号 + 验证码）
    await invoke('commercial:send-otp', '+8613800000002');
    await expect(submitOtp('+8613800000002')).resolves.toMatchObject({ ok: true });

    // 4) **同一次进程内**继续：清旧账号 → 恢复当前授权 → 等网关 → 配置成功
    await waitReady();

    // 清旧账号：A 的中转 provider 没了，换来当前账号 B 的
    expect(provider(h.gateway.doc, 'clawrouter')?.apiKey).toBe('rly_B_key');
    // 当前授权恢复：绑定 = B 的卡（D1：各账号各用自己的卡）
    expect(commercialConfig()).toMatchObject({
      licenseKey: 'RY-B-0001',
      licenseBinding: { userId: 'user-B', orgId: 'org-B', licenseId: 'license-B' },
      relayCleanupPending: false,
    });
    // 用户自己的配置（非 relay）一个字节都没动
    expect(provider(h.gateway.doc, 'user-local')?.apiKey).toBe('user-key');
    expect((h.gateway.doc.agents as { defaults: { greeting: string } }).defaults.greeting).toBe('keep-me');
    expect((h.gateway.doc.channels as { keepThisChannel: unknown }).keepThisChannel).toEqual({ enabled: true });
    // 渲染层看到的是真实相位转变（事件桥）
    expect(h.sentEvents.map((entry) => entry.payload.phase)).toEqual(expect.arrayContaining(['running', 'ready']));
  });

  it('⭐ 网关还没连上：登录后自己等（有界轮询），连上即完成 —— 不需要用户再点任何东西', async () => {
    installAccounts();
    h.gateway.doc = previousUserGatewayDoc();
    writeEncryptedSession('W1', 'user-A');
    h.windowsUser = 'W2';

    // 启动那一轮先把单飞调度器建起来（生产：main/index.ts 的 bootstrapCommercialRelay()）
    await startup.bootstrapCommercialRelay({ waitForGatewayMs: 15_000 });
    // 网关此刻不可用（换机/首启部署窗口）
    h.gateway.connected = false;

    await expect(submitOtp('+8613800000002')).resolves.toMatchObject({ ok: true });

    // 网关未就绪时：相位是"在跑/可重试"那一档（在窗口里自己等），**绝不是终局 blocked**
    await vi.waitFor(
      () =>
        expect(['running', 'retryable-error']).toContain(shared.relayBootstrapPublicStateStore.get().phase as string),
      { timeout: 8_000 },
    );
    expect(shared.relayBootstrapPublicStateStore.get().phase).not.toBe('blocked');

    // 网关起来了 ⇒ 同一次进程内自动完成（不需要"重新准备"/重启）
    h.gateway.connected = true;
    await waitReady();
    expect(provider(h.gateway.doc, 'clawrouter')?.apiKey).toBe('rly_B_key');
    expect(commercialConfig().relayCleanupPending).toBe(false);
    expect(commercialConfig().licenseBinding).toMatchObject({ userId: 'user-B' });
  });

  it('⭐ 清理**暂时**失败（网关在途抖动）：同一次进程内自己接着做完，不问用户', async () => {
    installAccounts();
    h.config = {
      commercial: {
        supabaseUrl: '',
        supabaseAnonKey: '',
        licenseKey: 'RY-A-0001',
        licenseBinding: { userId: 'user-A', orgId: 'org-A', licenseId: 'license-A' },
      },
    };
    h.gateway.doc = previousUserGatewayDoc();
    writeEncryptedSession('W1', 'user-A');
    h.windowsUser = 'W2';
    await startup.bootstrapCommercialRelay({ waitForGatewayMs: 15_000 });

    // 登录那一刻网关正好抖了一下（清理的 config.get 报 "not connected"）
    h.gateway.failGetConfigTimes = 1;
    await expect(submitOtp('+8613800000002')).resolves.toMatchObject({ ok: true });

    await waitReady();
    // 清理在链内被**接着**做完（不是留给用户重开）：pending 落过、随后 complete
    expect(h.logs.map((entry) => entry.event)).toEqual(
      expect.arrayContaining(['relay.cleanup-pending', 'relay.cleanup-complete']),
    );
    expect(commercialConfig()).toMatchObject({
      licenseKey: 'RY-B-0001',
      licenseBinding: { userId: 'user-B', orgId: 'org-B' },
      relayCleanupPending: false,
    });
    expect(provider(h.gateway.doc, 'clawrouter')?.apiKey).toBe('rly_B_key');
  });

  it('⭐ 清理被网关**确定性**拒绝（非 size-drop）：明确收场，且不把 B 的状态叠在旧代次上', async () => {
    installAccounts();
    h.gateway.doc = previousUserGatewayDoc();
    writeEncryptedSession('W1', 'user-A');
    h.windowsUser = 'W2';
    // 网关拒绝任何"删除 provider"的补丁（schema 层拒绝 = 重试一万次也一样）
    h.gateway.rejectRemovalWith =
      'Config write rejected: models.providers.clawrouter (schema invalid): provider entry must be an object';

    await expect(submitOtp('+8613800000002')).resolves.toMatchObject({ ok: true });
    await vi.waitFor(() => expect(shared.relayBootstrapPublicStateStore.get().phase).toBe('retryable-error'), {
      timeout: 15_000,
    });

    // ① 旧账号的中转**还在**（我们没能删掉它）—— 但新账号的授权/relay 一个都没落上去
    expect(provider(h.gateway.doc, 'clawrouter')?.apiKey).toBe('rly_A_key');
    expect(JSON.stringify(h.gateway.doc)).not.toContain('rly_B_key');
    expect(commercialConfig().licenseKey).toBeUndefined();
    expect(commercialConfig().licenseBinding).toBeUndefined();
    // ② 清理仍是 pending：下一轮（重试 / 下次启动）会继续 drain，不是"假装成功"
    expect(commercialConfig().relayCleanupPending).toBe(true);
    // ③ 活体 key 已经在账户边界作废（不许拿旧账号的凭证顶班）
    expect(relayKeyModule.getActiveRelayKey()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (b) 账号 A→B 切换：迟到的旧回执 / 旧 relay 不得覆盖新账号
// ---------------------------------------------------------------------------

describe('(b) A→B 切换：旧请求迟到返回不得恢复旧授权 / 旧 relay', () => {
  /** A 已登录并完成准备（上一个账号的完整链在**同一进程**里跑过）。 */
  async function signInA(): Promise<void> {
    installAccounts();
    h.gateway.doc = previousUserGatewayDoc();
    writeEncryptedSession('W1', 'user-A');
    await startup.bootstrapCommercialRelay({ waitForGatewayMs: 15_000 });
    await waitReady();
    expect(provider(h.gateway.doc, 'clawrouter')?.apiKey).toBe('rly_A_key');
    expect(commercialConfig()).toMatchObject({
      licenseKey: 'RY-A-0001',
      licenseBinding: { userId: 'user-A', orgId: 'org-A' },
    });
  }

  it('⭐ A 的在途授权读取迟到返回：不得把 A 的绑定写回，也不得把相位翻回去', async () => {
    await signInA();
    expect(relayKeyModule.getActiveRelayKey()).toBe('rly_A_key');

    // A 的一条读取请求**在途**（渲染层刚问过 / 旧链还没回来）
    h.stallLicenseLookups = 1;
    const staleRead = invoke<{ ok: boolean; result?: { licenseKey: string | null } }>('commercial:license-status');
    await vi.waitFor(() => expect(h.stalledLookups.length).toBe(1));

    // 换账号 B：登录（账户边界）
    await expect(submitOtp('+8613800000002')).resolves.toMatchObject({ ok: true });

    // 迟到的 A 回执现在才回来
    h.stalledLookups.splice(0).forEach((release) => release());
    const stale = await staleRead;
    await waitReady();

    // ① 不得把 A 的授权写回当前账号
    expect(commercialConfig()).toMatchObject({
      licenseKey: 'RY-B-0001',
      licenseBinding: { userId: 'user-B', orgId: 'org-B', licenseId: 'license-B' },
    });
    // ② 旧回执读不出当前账号的卡（代次已作废 ⇒ 如实报"未配置"，而不是把 B 的卡说成 A 的）
    expect(stale.ok).toBe(true);
    expect(stale.result?.licenseKey ?? null).toBeNull();
    // ③ 网关上仍然是 B 的中转，相位没有被旧回执翻回
    expect(provider(h.gateway.doc, 'clawrouter')?.apiKey).toBe('rly_B_key');
    expect(shared.relayBootstrapPublicStateStore.get().phase).toBe('ready');
    // ④ 旧账号之后没有再来一次"补偿性"重写（最后一次写网关的是 B 的 key）
    const lastPatch = h.gateway.patchCalls.at(-1)?.raw ?? '';
    expect(lastPatch).toContain('rly_B_key');
  });

  it('⭐ 账户边界立即作废旧 relay 凭证：清理还没跑完也不许再用上个账号的 key', async () => {
    await signInA();
    expect(relayKeyModule.getActiveRelayKey()).toBe('rly_A_key');

    // 网关此时不可用（换机/重部署窗口）：清理只能落 pending，链路要等
    h.gateway.connected = false;
    await expect(submitOtp('+8613800000002')).resolves.toMatchObject({ ok: true });

    // 登录成功这一刻 = 账户边界：内存里的活体 relay key 必须已经作废
    // （新账号还没配上的窗口里拿旧账号的凭证出站 = 沿用上个账号授权）
    expect(relayKeyModule.getActiveRelayKey()).toBeNull();

    h.gateway.connected = true;
    await waitReady();
    expect(relayKeyModule.getActiveRelayKey()).toBe('rly_B_key');
    expect(provider(h.gateway.doc, 'clawrouter')?.apiKey).toBe('rly_B_key');
  });

  it('⭐ A 的在途**准备请求**迟到完成：不许把 A 的 relay 留在终态（B 的 key 必须是最后一次写入）', async () => {
    installAccounts();
    h.config = {
      commercial: {
        supabaseUrl: '',
        supabaseAnonKey: '',
        licenseKey: 'RY-A-0001',
        licenseBinding: { userId: 'user-A', orgId: 'org-A', licenseId: 'license-A' },
      },
    };
    writeEncryptedSession('W1', 'user-A');
    // A 的启动链卡在"把 relay 写进网关"那一步：这就是那个**在途的准备请求**
    // （key 已经在手，写还没落盘 —— 真机上就是网关写队列慢/重连窗口）
    h.gateway.stallNextPatch = true;
    const pendingChain = startup.bootstrapCommercialRelay({ waitForGatewayMs: 15_000 });
    await vi.waitFor(() => expect(h.gateway.releaseStalledPatch).not.toBeNull(), { timeout: 8_000 });

    // 还在途时换账号 B（登录的账户清理排在同一网关写队列后面，会等这次写入落盘）
    const login = submitOtp('+8613800000002');
    const release = h.gateway.releaseStalledPatch as unknown as () => void;
    h.gateway.releaseStalledPatch = null;
    release();
    await expect(login).resolves.toMatchObject({ ok: true });
    await pendingChain;

    // 单飞 + 补跑：终态必须是**当前账号**的中转，A 的迟到写入不得留在那里
    await waitReady();
    expect(provider(h.gateway.doc, 'clawrouter')?.apiKey).toBe('rly_B_key');
    const writes = h.gateway.patchCalls.map((call) => call.raw);
    expect(
      writes.some((raw) => raw.includes('rly_A_key')),
      'A 的迟到写入确实发生过（夹具自证）',
    ).toBe(true);
    expect(writes.at(-1)).toContain('rly_B_key');
    expect(commercialConfig().licenseBinding).toMatchObject({ userId: 'user-B' });
  });

  it('⭐ 登出同样作废活体 key（不许把 A 的凭证留在内存里等下一个账号）', async () => {
    await signInA();
    expect(relayKeyModule.getActiveRelayKey()).toBe('rly_A_key');

    await invoke('commercial:sign-out');
    expect(relayKeyModule.getActiveRelayKey()).toBeNull();
    expect(provider(h.gateway.doc, 'clawrouter')).toBeUndefined();
    // 连 `plugins.allow` 里的中转名单也一起收走（清账是"整条凭证"的清除）
    expect((h.gateway.doc.plugins as { allow: string[] }).allow).toEqual(['keep-this-plugin']);
  });
});

// ---------------------------------------------------------------------------
// (c) BUG-080 原条件（size-drop）在**切换/首启登入**链内走分段收缩
// ---------------------------------------------------------------------------

describe('(c) BUG-080 原 size-drop 条件：切换链内的清理走分段收缩', () => {
  /** clawrouter 区块（含模型目录静态快照）> 全配置一半 —— 复现 2026-10-14 实机比例。 */
  function bigRelayGatewayDoc(): Record<string, unknown> {
    const models = Array.from({ length: 24 }, (_, index) => ({
      id: `model-${String(index).padStart(2, '0')}`,
      name: `Catalog model ${index}`,
      contextWindow: 200_000,
      maxTokens: 32_768,
    }));
    return {
      agents: { defaults: { model: { primary: 'clawrouter/model-00' } } },
      models: { providers: { clawrouter: { baseUrl: RELAY_BASE, apiKey: 'rly_A_key', headers: {}, models } } },
      channels: { keepThisChannel: { enabled: true } },
    };
  }

  it('⭐⭐ 换账号登入：清理被 size-drop 拦下 ⇒ 分段收缩救回 ⇒ 同次完成（不卡在准备页）', async () => {
    installAccounts();
    h.gateway.doc = bigRelayGatewayDoc();
    h.gateway.guardSizeDrop = true;
    // 旧 Windows 用户（A）留在盘上的密文解不开 ⇒ 正常登录 B
    writeEncryptedSession('W1', 'user-A');
    h.windowsUser = 'W2';

    // 夹具自证：clawrouter 区块 > 全配置一半（不然这条用例测不到东西）
    const total = Buffer.byteLength(JSON.stringify(h.gateway.doc), 'utf8');
    const block = Buffer.byteLength(JSON.stringify(provider(h.gateway.doc, 'clawrouter')), 'utf8');
    expect(block).toBeGreaterThan(total / 2);

    await expect(submitOtp('+8613800000002')).resolves.toMatchObject({ ok: true });
    await waitReady();

    // 分段收缩路径**真的被用到**（不是恰好没触发守卫）
    expect(shrinkRounds().length).toBeGreaterThan(0);
    const shrinkPatch = h.gateway.patchCalls.find((call) =>
      call.replacePaths.includes('models.providers.clawrouter.models'),
    );
    expect(shrinkPatch, '收缩补丁必须声明 replacePaths（数组整段替换），否则收缩是假的').toBeDefined();
    // 收缩之后仍然把整棵 provider 清掉，并且当前账号的配置落了下去
    expect(provider(h.gateway.doc, 'clawrouter')?.apiKey).toBe('rly_B_key');
    expect(commercialConfig()).toMatchObject({
      licenseKey: 'RY-B-0001',
      licenseBinding: { userId: 'user-B', orgId: 'org-B' },
      relayCleanupPending: false,
    });
    expect((h.gateway.doc.channels as { keepThisChannel: unknown }).keepThisChannel).toEqual({ enabled: true });
  });

  it('⭐ 退出 → 重新登录（同一账号）：退出那一步的清理同样走分段收缩，重登后同次就绪', async () => {
    installAccounts();
    h.gateway.doc = bigRelayGatewayDoc();
    h.gateway.guardSizeDrop = true;
    writeEncryptedSession('W1', 'user-A');

    await startup.bootstrapCommercialRelay({ waitForGatewayMs: 15_000 });
    await waitReady();
    expect(provider(h.gateway.doc, 'clawrouter')).toBeDefined();

    h.logs.length = 0; // 只看退出→重登这两步
    await invoke('commercial:sign-out');
    // 退出这一步就要把（被守卫拦下的）大区块用分段收缩清掉
    await vi.waitFor(() => expect(shrinkRounds().length).toBeGreaterThan(0), { timeout: 8_000 });
    expect(provider(h.gateway.doc, 'clawrouter')).toBeUndefined();
    expect(commercialConfig().relayCleanupPending).toBe(false);

    await expect(submitOtp('+8613800000001')).resolves.toMatchObject({ ok: true });
    await waitReady();
    expect(provider(h.gateway.doc, 'clawrouter')?.apiKey).toBe('rly_A_key');
    expect(commercialConfig().licenseBinding).toMatchObject({ userId: 'user-A' });
  });
});

// ---------------------------------------------------------------------------
// (d) 切回 A：授权恢复 + 共享数据（D2）不被清理
// ---------------------------------------------------------------------------

describe('(d) A→B→A：授权各自恢复，共享工作区数据不被清理（D2）', () => {
  it('⭐ 三段切换：授权/卡/relay 正确，共享文件与用户配置原样保留', async () => {
    installAccounts();
    h.gateway.doc = previousUserGatewayDoc();
    writeEncryptedSession('W1', 'user-A');
    await startup.bootstrapCommercialRelay({ waitForGatewayMs: 15_000 });
    await waitReady();
    expect(provider(h.gateway.doc, 'clawrouter')?.apiKey).toBe('rly_A_key');

    // A 时期就存在的共享数据（同盘工作区）
    const sharedTask = join(workspaceDir, 'task-from-A.json');
    const sharedTaskContent = JSON.stringify({ title: 'A 建的任务' });
    writeFileSync(sharedTask, sharedTaskContent, 'utf8');

    // → B（A 先退出登录：设置里的换账号）
    await invoke('commercial:sign-out');
    await expect(submitOtp('+8613800000002')).resolves.toMatchObject({ ok: true });
    await waitReady();
    expect(provider(h.gateway.doc, 'clawrouter')?.apiKey).toBe('rly_B_key');
    expect(commercialConfig()).toMatchObject({
      licenseKey: 'RY-B-0001',
      licenseBinding: { userId: 'user-B', orgId: 'org-B' },
    });

    // B 新增的共享数据（D2：切回 A 之后仍须保留可见）
    const fromB = join(workspaceDir, 'task-from-B.json');
    const fromBContent = JSON.stringify({ title: 'B 建的任务' });
    writeFileSync(fromB, fromBContent, 'utf8');

    // → 切回 A（用 A 自己的有效卡，D1）
    await invoke('commercial:sign-out');
    await expect(submitOtp('+8613800000001')).resolves.toMatchObject({ ok: true });
    await waitReady();

    // A 的授权恢复（卡、组织、relay key 都是 A 的；B 的凭证不留痕）
    expect(commercialConfig()).toMatchObject({
      licenseKey: 'RY-A-0001',
      licenseBinding: { userId: 'user-A', orgId: 'org-A', licenseId: 'license-A' },
      relayCleanupPending: false,
    });
    expect(provider(h.gateway.doc, 'clawrouter')?.apiKey).toBe('rly_A_key');
    expect(clientModule.hasLocalSession()).toBe(true);

    // D2：共享数据（A 的 + B 的）一个字节都没动 —— 账号切换不清理共享任务/文件
    expect(existsSync(sharedTask)).toBe(true);
    expect(readFileSync(sharedTask, 'utf8')).toBe(sharedTaskContent);
    expect(existsSync(fromB)).toBe(true);
    expect(readFileSync(fromB, 'utf8')).toBe(fromBContent);
    // 用户自己的网关配置（非 relay）也没被任何一次切换动过
    expect(provider(h.gateway.doc, 'user-local')?.apiKey).toBe('user-key');
    expect((h.gateway.doc.channels as { keepThisChannel: unknown }).keepThisChannel).toEqual({ enabled: true });
    // 当前账号的中转在 allow 里（apply 会补名），用户自己的插件名一个不少
    expect((h.gateway.doc.plugins as { allow: string[] }).allow).toEqual(['keep-this-plugin', 'clawrouter']);
  });
});
