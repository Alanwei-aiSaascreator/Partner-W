import { app, safeStorage } from 'electron';
import { join } from 'path';
import { existsSync, readFileSync, renameSync } from 'fs';
import { homedir } from 'os';
import { randomUUID } from 'node:crypto';
import { CONFIG_FILE_NAME, DEFAULT_WORKSPACE_DIR } from '@clawwork/shared';
import type { GatewayAuth, LanguageCode, TeamHubRegistryConfig } from '@clawwork/shared';
import { writeJsonAtomic } from '../util/json-file.js';
import { getPortableRoots, setPortableVolumeRoot } from '../runtime/portable-root.js';

export interface GatewayServerConfig {
  id: string;
  name: string;
  url: string;
  token?: string;
  password?: string;
  pairingCode?: string;
  authMode?: 'token' | 'password' | 'pairingCode';
  tlsVerify?: boolean;
  isDefault?: boolean;
  color?: string;
}

export interface VoiceInputConfig {
  introSeen?: boolean;
}

export interface QuickLaunchConfig {
  enabled: boolean;
  shortcut: string;
}

export interface NotificationConfig {
  taskComplete?: boolean;
  approvalRequest?: boolean;
  gatewayDisconnect?: boolean;
}

export interface CommercialConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  licenseKey?: string;
  /**
   * Server-verified identity of `licenseKey`.
   *
   * A license row can be visible through RLS to every member of an organization,
   * while `activate_license` deliberately authorizes only an exact owner.  Keeping
   * the account/org/license triple prevents a cached key from silently crossing an
   * account boundary after sign-out, profile recovery, or a Windows-user change.
   */
  licenseBinding?: {
    userId: string;
    orgId: string;
    licenseId: string;
  };
  /** A previous account's relay config still needs verified removal from the gateway. */
  relayCleanupPending?: boolean;
  /** Origin of the Alipay payment service; defaults to the production domain. */
  paymentBaseUrl?: string;
}

export interface AppConfig {
  workspacePath: string;
  /**
   * 工作区**相对盘根**的路径（盘上形态的迁移线索，`E:` → `F:` 时靠它找回来）。
   * 只有可移动盘上的工作区才记 —— 见 `portable.ts` 的 `describeWorkspaceLocation`。
   */
  workspaceRelPath?: string;
  /** 记下这个工作区时，盘根认到的 marker 文件名。 */
  volumeMarker?: string;
  /**
   * 工作区归属（B1 修复）：`app-volume`=随盘移动的自动工作区（按当前运行卷解析）；
   * `explicit-path`=用户显式选择的外部目录（遵从用户）。只在记了 `workspaceRelPath`
   * 时有意义；缺省（老记录）按"有盘上线索 ⇒ app-volume，否则 explicit"保守判定。
   */
  workspaceBinding?: 'app-volume' | 'explicit-path';
  /**
   * 工作区**身份**（P-A v2，2026-10-15）：工作区标记 `.clawwork-workspace.json` 里的
   * `workspaceId`。恢复端用"记录身份 == 候选标记身份"证明同一份工作区 ——
   * 通用目录标记只能证明"这个目录是我们的"，证明不了"它是记录的那一份"。
   * 老记录首次 `configured` 启动时自动补铸并写回（`startup.ts`）。
   */
  workspaceId?: string;
  /**
   * 兼容 0.0.25 写下的盘上首启标记。新版发现它后会清掉，避免把内置本地网关
   * 暴露成需要用户填写地址和令牌的远程网关表单。
   */
  portableSetupPending?: boolean;
  theme?: 'dark' | 'light' | 'auto';
  density?: 'compact' | 'comfortable' | 'spacious';
  language?: LanguageCode;
  gateways: GatewayServerConfig[];
  defaultGatewayId?: string;
  sendShortcut?: 'enter' | 'cmdEnter';
  gatewayUrl?: string;
  bootstrapToken?: string;
  password?: string;
  tlsFingerprint?: string;
  voiceInput?: VoiceInputConfig;
  quickLaunch?: QuickLaunchConfig;
  trayEnabled?: boolean;
  notifications?: NotificationConfig;
  leftNavShortcut?: 'Comma' | 'BracketLeft';
  rightPanelShortcut?: 'Period' | 'BracketRight';
  deviceId?: string;
  zoomLevel?: number;
  devMode?: boolean;
  teamHubRegistries?: TeamHubRegistryConfig[];
  updateChannel?: 'stable' | 'beta';
  /**
   * 「电脑操控权限」两档（spec `2026-09-26-computer-access-two-tiers-design.md`）。
   *
   * ⚠️ **缺省 = `'safe'`**（助手只在自己工作区里读写、跑命令要问）。这是产品的安全底线，
   *    缺省绝不许是 `'full'`。读取侧还有一道 fail-closed（`normalizeComputerAccessTier`：
   *    认不出的一律安全档），两道合起来保证"配置坏了"不会变成"放开整台电脑"。
   *
   * ⚠️ 这里存的只是**用户意愿**；真正决定助手能碰什么的是**网关侧的会话权限模式**，
   *    且切 `'full'` 在网关那边要 `operator.admin`（`method-scopes-*.mjs`）。
   *    所以这个字段被手改成 `'full'` 也**不会**凭空获得权限。
   */
  computerAccess?: 'safe' | 'full';
  /**
   * 随包技能的**来源记账**：`managedDir → slug → 记录值`。
   *
   * 干什么用：把"**我们自己把它放旧了**"与"**别人改过它**"分开 —— 升级只能在**已证明来源**
   * 的基线上做差分，碰用户的东西就停下。开机自装靠它判断该不该升级。
   *
   * ⚠️ **值必须保持字符串**：记录值的口径（H1 起为 `pkg2:` 开头的 JSON = 随包版本 + 逐文件
   *    装后 sha；老盘上可能还是裸 sha / `pkg1:`）与读写逻辑都在 `main/skills/bundled.ts`；
   *    盘符/stateDir 迁移（`runtime/state-config.ts`）会把记录**连值一起**搬到新 key。
   *
   * ⚠️ 记在**我们自己的配置**里，不往网关的技能目录塞文件 —— 那棵树里多出来的东西
   *    会不会被当成技能，是我们控制不了的事。
   */
  bundledSkillRecords?: Record<string, Record<string, string>>;
  /**
   * 联网搜索开关（设置里那一行）。
   *
   * ⚠️ **缺省 = 开**（见 `relay-config.ts` 的 `webSearchEnabled`）：这个能力本来就存在，
   *    把缺省改成关等于"升一次级静默拿走一个功能"。用户要关随时能关。
   */
  webSearch?: boolean;
  commercial?: CommercialConfig;
}

function configFilePath(): string {
  return join(app.getPath('userData'), CONFIG_FILE_NAME);
}

/**
 * 盘上运行 — ⚠️ **正名**：这里存/取的是**盘根**（`E:\`），不是工作区。
 *
 * 真正的"盘上根路径族"（dataRoot/stateRoot/workspaceRoot/tempRoot…）只有一个来源：
 * `runtime/portable-root.ts` 的 `getPortableRoots()`（判定仍由 `workspace/portable.ts`
 * 的 `detectPortableRun` 做，进程内缓存一次）。这两个函数是**兼容壳**：
 * 老调用点仍叫 `…WorkspaceRoot`，行为与以前逐字一致（返回盘根），只是不再各存一份。
 */
export function setPortableWorkspaceRoot(root: string | null): void {
  setPortableVolumeRoot(root);
}

/** ⚠️ 名字有误导：返回的是**盘根**（`E:\`）。工作区是 `getPortableRoots()?.workspaceRoot`。 */
export function getPortableWorkspaceRoot(): string | null {
  return getPortableRoots()?.volumeRoot ?? null;
}

/**
 * 默认工作区：盘上运行 ⇒ `<盘根>\荣盈魔方工作区\`（用户不用选盘）；
 * 否则维持 homedir 下的老默认值。
 */
export function getDefaultWorkspacePath(): string {
  const roots = getPortableRoots();
  if (roots) return roots.workspaceRoot;
  return getHomedirWorkspacePath();
}

/** homedir 下的那份默认位置（盘上形态的"退路"也用它）。 */
export function getHomedirWorkspacePath(): string {
  return join(homedir(), DEFAULT_WORKSPACE_DIR);
}

const ENCRYPTED_PREFIX = 'enc:';

function encryptField(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value.startsWith(ENCRYPTED_PREFIX)) return value;
  if (!safeStorage.isEncryptionAvailable()) return value;
  try {
    return ENCRYPTED_PREFIX + safeStorage.encryptString(value).toString('base64');
  } catch (e) {
    console.error('safeStorage: encrypt failed, storing plaintext', e);
    return value;
  }
}

function decryptField(value: string | undefined): string | undefined {
  if (!value) return value;
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value;
  if (!safeStorage.isEncryptionAvailable()) {
    console.error('safeStorage: decryption not available, credential lost');
    return undefined;
  }
  try {
    const buf = Buffer.from(value.slice(ENCRYPTED_PREFIX.length), 'base64');
    return safeStorage.decryptString(buf);
  } catch (e) {
    console.error('safeStorage: decrypt failed, credential lost', e);
    return undefined;
  }
}

function encryptGatewayCredentials(config: AppConfig): AppConfig {
  const clone = structuredClone(config);
  for (const gw of clone.gateways) {
    gw.token = encryptField(gw.token);
    gw.password = encryptField(gw.password);
    gw.pairingCode = encryptField(gw.pairingCode);
  }
  clone.bootstrapToken = encryptField(clone.bootstrapToken);
  clone.password = encryptField(clone.password);
  return clone;
}

function decryptGatewayCredentials(config: AppConfig): AppConfig {
  const clone = structuredClone(config);
  for (const gw of clone.gateways) {
    gw.token = decryptField(gw.token);
    gw.password = decryptField(gw.password);
    gw.pairingCode = decryptField(gw.pairingCode);
  }
  clone.bootstrapToken = decryptField(clone.bootstrapToken);
  clone.password = decryptField(clone.password);
  return clone;
}

function migrateConfigIfNeeded(config: AppConfig): AppConfig {
  if (config.gatewayUrl && (!config.gateways || config.gateways.length === 0)) {
    const id = randomUUID();
    const token = process.env.OPENCLAW_GATEWAY_TOKEN;
    const pairingCode = config.bootstrapToken;
    const migrated: AppConfig = {
      workspacePath: config.workspacePath,
      theme: config.theme,
      language: config.language,
      voiceInput: config.voiceInput,
      gateways: [
        {
          id,
          name: 'Default Gateway',
          url: config.gatewayUrl,
          token,
          pairingCode,
          password: config.password,
          authMode: token ? 'token' : config.password ? 'password' : pairingCode ? 'pairingCode' : 'token',
          isDefault: true,
        },
      ],
      defaultGatewayId: id,
    };
    writeConfig(migrated);
    return migrated;
  }
  if (!config.gateways) {
    config.gateways = [];
  }
  return config;
}

export function readConfig(): AppConfig | null {
  const cfgPath = configFilePath();
  if (!existsSync(cfgPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(cfgPath, 'utf-8');
  } catch (err) {
    console.error('[config] failed to read:', err);
    return null;
  }
  let config: AppConfig;
  try {
    config = JSON.parse(raw) as AppConfig;
  } catch (err) {
    console.error('[config] failed to read:', err);
    const corruptedPath = `${cfgPath}.corrupted-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      renameSync(cfgPath, corruptedPath);
    } catch (backupErr) {
      console.error('[config] failed to back up corrupted config:', backupErr);
    }
    return null;
  }
  try {
    const migrated = migrateConfigIfNeeded(config);
    return decryptGatewayCredentials(migrated);
  } catch (err) {
    console.error('[config] failed to process:', err);
    return null;
  }
}

/**
 * 读盘上**原始** JSON（不解密、不迁移）；不存在/坏 JSON ⇒ `null`。
 *
 * 只给"保留解不开的密文"用 —— 它是唯一能看到 `enc:` 原文的入口
 * （`readConfig()` 已经把解不开的字段变成 `undefined` 了）。
 */
function readRawConfigFile(): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(configFilePath(), 'utf-8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 「调用方没给值」+「盘上那份是密文且**当前解不开**」⇒ 原样带回旧密文。
 *
 * 为什么（Owner C / T16 硬红线「解不开不得无备份地删除凭据」）：DPAPI 按 Windows
 * 用户加密 —— 换 Windows 用户 / 换机器后当前用户解不开，但用户切回原账户时
 * 那份密文**本来解得开**。旧实现把它读成 `undefined`，下一次 `writeConfig`
 * （启动路径上 `updateConfig` 随时会调）就把它从盘上抹掉。保留 = 给"切回去"留机会。
 *
 * ⚠️ **显式值优先**：`''` 或新值一律照写 —— 只有"我们读不出来"才保留，
 *    用户清空 / 换 token 的意图不被吞。
 */
function carryForwardIfUnreadable(incoming: string | undefined, rawValue: unknown): string | undefined {
  if (incoming !== undefined) return incoming;
  if (typeof rawValue !== 'string' || !rawValue.startsWith(ENCRYPTED_PREFIX)) return incoming;
  if (decryptField(rawValue) !== undefined) return incoming; // 解得开 ⇒ 调用方不给值就是用户意图
  return rawValue;
}

/**
 * 把盘上**解不开**的凭据密文补回待写入的 config（按网关 id 对齐）。
 *
 * `encryptGatewayCredentials` 的 `encryptField` 对已带前缀的值原样返回，
 * 所以带回来的密文会**逐字节**落盘。
 */
function preserveUnreadableSecrets(config: AppConfig): AppConfig {
  const raw = readRawConfigFile();
  if (!raw) return config;
  const rawGateways = Array.isArray(raw.gateways) ? (raw.gateways as unknown[]) : [];
  const rawById = new Map<string, Record<string, unknown>>();
  for (const entry of rawGateways) {
    if (entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string') {
      rawById.set((entry as { id: string }).id, entry as Record<string, unknown>);
    }
  }

  const clone = structuredClone(config);
  for (const gw of clone.gateways) {
    const rawEntry = rawById.get(gw.id);
    gw.token = carryForwardIfUnreadable(gw.token, rawEntry?.token);
    gw.password = carryForwardIfUnreadable(gw.password, rawEntry?.password);
    gw.pairingCode = carryForwardIfUnreadable(gw.pairingCode, rawEntry?.pairingCode);
  }
  clone.bootstrapToken = carryForwardIfUnreadable(clone.bootstrapToken, raw.bootstrapToken);
  clone.password = carryForwardIfUnreadable(clone.password, raw.password);
  return clone;
}

export function writeConfig(config: AppConfig): void {
  writeJsonAtomic(configFilePath(), encryptGatewayCredentials(preserveUnreadableSecrets(config)));
}

export function updateConfig(partial: Partial<AppConfig>): AppConfig {
  const current = readConfig() ?? { workspacePath: getDefaultWorkspacePath(), gateways: [] };
  const merged = { ...current, ...partial };
  writeConfig(merged);
  return merged;
}

export function getWorkspacePath(): string | null {
  return readConfig()?.workspacePath ?? null;
}

/**
 * 引导是否**走完了**（App 用它决定进 Setup 还是进主界面）。
 *
 * `portableSetupPending` 只为兼容 0.0.25 的旧配置；启动编排会先把它清掉。
 */
export function isWorkspaceConfigured(): boolean {
  const config = readConfig();
  if (!config?.workspacePath) return false;
  return config.portableSetupPending !== true;
}

/** Build GatewayAuth from a persisted GatewayServerConfig */
export function buildGatewayAuth(gw: GatewayServerConfig): GatewayAuth {
  if (gw.authMode === 'token') return { token: gw.token ?? '' };
  if (gw.authMode === 'password') return { password: gw.password ?? '' };
  if (gw.authMode === 'pairingCode') return { bootstrapToken: gw.pairingCode ?? '' };
  if (gw.token) return { token: gw.token };
  if (gw.password) return { password: gw.password };
  if (gw.pairingCode) return { bootstrapToken: gw.pairingCode };
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (envToken) return { token: envToken };
  return { token: '' };
}

export function ensureDeviceId(): string {
  const existing = readConfig()?.deviceId;
  if (existing) return existing;
  const deviceId = randomUUID();
  updateConfig({ deviceId });
  return deviceId;
}

export function clearGatewayPairingCode(gatewayId: string): void {
  const config = readConfig();
  if (!config) return;
  const gateway = config.gateways.find((item) => item.id === gatewayId);
  if (!gateway?.pairingCode) return;
  gateway.pairingCode = undefined;
  writeConfig(config);
}
