import { app, safeStorage } from 'electron';
import { join } from 'path';
import { existsSync, readFileSync, renameSync } from 'fs';
import { homedir } from 'os';
import { randomUUID } from 'node:crypto';
import { CONFIG_FILE_NAME, DEFAULT_WORKSPACE_DIR } from '@clawwork/shared';
import type { GatewayAuth, LanguageCode, TeamHubRegistryConfig } from '@clawwork/shared';
import { writeJsonAtomic } from '../util/json-file.js';
import { PORTABLE_WORKSPACE_DIR_NAME } from './portable.js';

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
   * 盘上首启：工作区已**自动**就位（`<盘根>\荣盈魔方工作区\`），但引导还没走完。
   *
   * ⚠️ 作用只有一个：让首启那次仍然进 Setup（**跳过选盘那一步**、直接落在网关步骤），
   *    好把那句"工作区已自动设在…、可改"说给用户听。下一次启动它就会被清掉 ——
   *    工作区本来就在盘上，不该每次都拦一次。
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
  commercial?: CommercialConfig;
}

function configFilePath(): string {
  return join(app.getPath('userData'), CONFIG_FILE_NAME);
}

/**
 * 盘上运行的卷根（启动时由 `prepareWorkspaceAtStartup()` 灌一次）。
 *
 * ⚠️ 在这里缓存、不在 `getDefaultWorkspacePath()` 里现算：判定要枚举可移动盘
 *    （PowerShell，秒级），而 `getDefaultWorkspacePath()` 会在每次 IPC、
 *    每次 `updateConfig()` 兜底里被调到。
 */
let portableWorkspaceRoot: string | null = null;

export function setPortableWorkspaceRoot(root: string | null): void {
  portableWorkspaceRoot = root;
}

export function getPortableWorkspaceRoot(): string | null {
  return portableWorkspaceRoot;
}

/**
 * 默认工作区：盘上运行 ⇒ `<盘根>\荣盈魔方工作区\`（用户不用选盘）；
 * 否则维持 homedir 下的老默认值。
 */
export function getDefaultWorkspacePath(): string {
  if (portableWorkspaceRoot) return join(portableWorkspaceRoot, PORTABLE_WORKSPACE_DIR_NAME);
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

export function writeConfig(config: AppConfig): void {
  writeJsonAtomic(configFilePath(), encryptGatewayCredentials(config));
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
 * ⚠️ 与 `getWorkspacePath() !== null` 的差别就在 `portableSetupPending`：盘上首启时
 *    工作区已经自动就位（`getWorkspacePath()` 有值、数据库也开在那），但用户还没见过
 *    引导 —— 这时返回 false，是为了让首启**仍然过一遍 Setup**（落在"网关"那一步，
 *    选盘那一步已被跳过）。渲染进程据此分辨这个状态，无需新增 IPC。
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
