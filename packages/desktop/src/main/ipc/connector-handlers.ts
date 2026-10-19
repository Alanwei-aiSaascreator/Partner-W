import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { getDebugLogger } from '../debug/index.js';
import path from 'node:path';
import { app, ipcMain } from 'electron';
import type { IpcResult } from '@clawwork/shared';
import {
  assertBootstrapInputs,
  buildFeishuBootstrapScript,
  hasFeishuPlugin,
  installBundledFeishu,
  readFeishuConfig,
  readFeishuConfigAt,
  resolveBundledPluginPath,
} from '../connectors/feishu.js';
import {
  applyFeishuCredentials,
  hardenFeishuGroupPolicy,
  readFeishuRouteBindingIds,
  readFeishuRouteBindingsAt,
  setFeishuChannelEnabled,
  setFeishuRouteBinding,
  type FeishuConfigGateway,
} from '../connectors/feishu-config.js';
import {
  beginFeishuRegistration,
  pollFeishuRegistration,
  type FeishuRegistrationBegin,
  type FeishuFetchImpl,
  type PollFeishuRegistrationResult,
} from '../connectors/feishu-registration.js';
import {
  installFeishuFromOfficialPackage,
  readFeishuInstallRecord,
  type FeishuInstallRecord,
  type FeishuInstallResult,
} from '../connectors/feishu-install.js';
import { readCurrentDeployment } from '../runtime/deploy.js';
import { stateConfigPath, stateDirFor } from '../runtime/state-config.js';

/**
 * 「连接器」这一层的 IPC（2026-10-17 起；2026-10-18 改为**应用内扫码**）。
 *
 * 三件事，按可靠性从高到低：
 *   ① 状态：只报**盘上/网关确认得了的**事实（配置里有没有 `channels.feishu`、绑到哪个助手）；
 *   ② 接入：应用内弹二维码（飞书 OAuth 设备码流程），**不再开系统终端**；
 *   ③ 失败：任何前置不成立都**明说原因**，不弹一个空窗口让用户对着白屏猜。
 *
 * ⚠️ 这里仍**不报告"已连接"**：长连接在网关进程里，桌面侧没有查询通道。
 *    把"已配置"说成"已连接"会让用户在断线时以为一切正常。
 */
export interface ConnectorStatus {
  id: 'feishu';
  /** 配置里有 appId ⇒ 至少接入成功过一次。 */
  configured: boolean;
  appId: string | null;
  enabled: boolean;
  /** 插件已在盘上（离线也能用；否则第一次接入要联网装 51MB）。 */
  pluginInstalled: boolean;
  /** 本机运行时可用（开扫码窗口/读写网关配置的前提）。 */
  runtimeReady: boolean;
}

/** 网关句柄：配置读写 +（可选）助手名单 +（可选）健康。 */
export interface ConnectorGateway extends FeishuConfigGateway {
  listAgents?: () => Promise<unknown>;
  /** `health` 响应的 payload（含 `channels.feishu`）。读不到时抛错，由调用方留 `null`。 */
  health?: () => Promise<Record<string, unknown>>;
}

export interface FeishuAgentChoice {
  id: string;
  name: string;
}

/** 飞书通道在**网关里**的真实健康（2026-10-18 BUG-171）。`null` = 读不到，不猜。 */
export interface FeishuChannelHealth {
  running: boolean;
  lifecycle: string;
  /** 内核拒绝 ingress（插件无可信安装记录）时为 true。 */
  ingressUnavailable: boolean;
  lastError: string | null;
}

/** 连接器页面的完整状态（含绑定）。 */
export interface FeishuConnectorState extends ConnectorStatus {
  /** 当前飞书路由绑定到的助手；`null` = 未绑定（会收到 `AgentSelectionRequiredError`）。 */
  boundAgentId: string | null;
  /** 可绑定的助手（网关不可用时为空数组，不猜）。 */
  agents: FeishuAgentChoice[];
  /** 网关里这条通道的真实运行状态；读不到为 `null`。 */
  channelHealth?: FeishuChannelHealth | null;
}

export type FeishuRegistrationPhase = 'idle' | 'pending' | 'success' | 'denied' | 'expired' | 'cancelled' | 'error';

/** 扫码会话的可观察状态（渲染层按 1s 轮询它，不再依赖 webContents 事件）。 */
export interface FeishuRegistrationState {
  phase: FeishuRegistrationPhase;
  qrUrl: string | null;
  userCode: string | null;
  /** epoch ms。 */
  expireAt: number | null;
  /** 成功后的应用 ID（与 `configured` 同口径）。 */
  appId: string | null;
  boundAgentId: string | null;
  error: string | null;
}

export interface ConnectorHandlerDeps {
  userDataDir: string;
  /**
   * 运行时缓存的根目录（2026-10-18 同事实机：便携盘上连接器一直报「运行时不可用」）。
   *
   * 便携形态下运行时部署在 `<userData>/portable-runtime-cache/runtime/deployed`，
   * 而 `app.getPath('userData')` 是 `<盘>/荣盈魔方-运行数据` —— 两者**不是同一个目录**。
   * 连接器此前拿 userData 去读 `current.json`，在便携盘上必然读不到 ⇒ 明明能正常聊天，
   * 连接器却禁用飞书接入。这里必须跟 `bootstrapLocalGatewayRuntime` 用同一个根。
   */
  runtimeCacheUserDataDir?: string;
  /**
   * 网关状态目录：字符串，或一个**惰性解析器**（推荐）。
   *
   * 便携分裂态的真实目录是 `<stateRoot>/state/<token 哈希>`，只有 runtime 层知道；
   * 启动早期/启动失败时 env 还没写，按 userData 推导会得到 `openclaw-state` 这个**错误目录**，
   * 把插件装进去网关永远不会加载。解析器明确返回 null 时，连接器一律按「运行时未就绪」
   * 处理，绝不往推测目录里写东西。
   */
  stateDir?: string | (() => string | null | undefined);
  /** 测试注入：真的开窗口之外的所有前置都保持同一路径。 */
  launch?: (scriptPath: string) => void;
  readStatus?: (stateDir: string, userDataDir: string) => ConnectorStatus;
  /** 随包插件 tgz；`undefined` = 按 app 形态自动定位，`null` = 强制走联网安装（测试用）。 */
  bundledPluginPath?: string | null;
  /** 测试注入：读可信安装记录（默认读 state/openclaw.sqlite）。 */
  readInstallRecord?: (stateDir: string) => FeishuInstallRecord | null;
  /** 随包 npm 负载目录（`<resources>/runtime/node`）；缺省 = 认为部署里已带 npm。 */
  runtimeNodePayloadDir?: string;
  /** 测试注入：跑官方 npm 安装（默认随包 npm + 离线缓存）。 */
  ensureInstall?: (input: {
    stateDir: string;
    nodePath: string;
    cliPath: string;
    pluginVersion: string;
    payloadDir?: string;
  }) => Promise<FeishuInstallResult>;
  /** 测试注入：网关句柄（缺省 = 本机运行时网关；未连上 ⇒ null）。 */
  gateway?: () => ConnectorGateway | null | Promise<ConnectorGateway | null>;
  /** 测试注入：网络入口（缺省 = 全局 fetch）。 */
  fetchImpl?: FeishuFetchImpl;
  /** 测试注入：时钟。 */
  now?: () => number;
  /** 测试注入：轮询等待。 */
  sleep?: (ms: number) => Promise<void>;
  /** 测试注入：整段轮询实现。 */
  pollRegistration?: typeof pollFeishuRegistration;
}

function resolveBundledPluginForApp(): string | undefined {
  try {
    return resolveBundledPluginPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    });
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 随包插件的版本（用于 npm spec）；读不到就退回已知版本，不猜别的包。 */
function readBundledPluginVersion(bundledDir: string | null | undefined): string {
  if (!bundledDir) return '2026.9.3';
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(bundledDir, 'package.json'), 'utf8'));
    if (parsed && typeof parsed === 'object') {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === 'string' && version.trim()) return version.trim();
    }
  } catch {
    // 目录/文件缺失：退回已知版本
  }
  return '2026.9.3';
}

export function resolveStateDir(userDataDir: string, fromEnv: string | undefined): string {
  const trimmed = typeof fromEnv === 'string' ? fromEnv.trim() : '';
  return trimmed ? trimmed : stateDirFor(userDataDir);
}

export function readFeishuStatus(stateDir: string, deploymentUserDataDir: string): ConnectorStatus {
  const config = readFeishuConfigAt(stateConfigPath(stateDir));
  // ⚠️ 第二个参数是**运行时部署的根**，不是 `app.getPath('userData')`：
  //    便携形态下部署在 `<userData>/portable-runtime-cache` 里（见 ConnectorHandlerDeps）。
  const deployment = readCurrentDeployment(deploymentUserDataDir);
  return {
    id: 'feishu',
    configured: config.configured,
    appId: config.appId,
    enabled: config.enabled,
    pluginInstalled: hasFeishuPlugin(stateDir),
    runtimeReady: deployment.status === 'ok',
  };
}

/** `agents.list` 载荷 → 可选助手（`id` 必须非空；名字缺了就显示 id，不编）。 */
export function feishuAgentChoices(catalog: unknown): FeishuAgentChoice[] {
  const agents = catalog && typeof catalog === 'object' ? (catalog as { agents?: unknown }).agents : null;
  if (!Array.isArray(agents)) return [];
  const choices: FeishuAgentChoice[] = [];
  for (const entry of agents) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const id = typeof row['id'] === 'string' ? row['id'].trim() : '';
    if (!id || choices.some((choice) => choice.id === id)) continue;
    const identity =
      row['identity'] && typeof row['identity'] === 'object' ? (row['identity'] as Record<string, unknown>) : null;
    const nameCandidate =
      typeof row['name'] === 'string'
        ? row['name']
        : identity && typeof identity['name'] === 'string'
          ? (identity['name'] as string)
          : '';
    choices.push({ id, name: nameCandidate.trim() || id });
  }
  return choices;
}

/** `start "" "<script>"`：`start` 的第一个带引号参数是窗口标题，必须占位。 */
export function launchInTerminal(command: string): void {
  // 直接开一个 PowerShell 窗口跑**内联命令**：
  //  · 不写 `.ps1` ⇒ 不碰 `-ExecutionPolicy`（默认策略会拒脚本文件）；
  //  · 不走 `.cmd` ⇒ 不受 GBK 代码页拆坏 UTF-8 中文的影响（实机踩过）。
  const inner = `powershell.exe -NoProfile -NoExit -Command "${command.replace(/"/g, '`"')}"`;
  spawn('cmd.exe', ['/c', `start "荣盈魔方 · 接入飞书" ${inner}`], {
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: true,
    windowsHide: false,
  }).unref();
}

/**
 * 默认网关：本地运行时那条。**动态 import** —— 测试注入 `gateway` 时不会把
 * `ws` 客户端整棵树拉进单测进程。
 */
async function defaultGateway(): Promise<ConnectorGateway | null> {
  try {
    const [{ getGatewayClient }, { LOCAL_GATEWAY_ID }] = await Promise.all([
      import('../ws/index.js'),
      import('../runtime/state-config.js'),
    ]);
    const client = getGatewayClient(LOCAL_GATEWAY_ID);
    if (!client || !client.isConnected) return null;
    return {
      getConfig: () => client.runConfigMutation((tx) => tx.getConfig()),
      patchConfig: (params) => client.runConfigMutation((tx) => tx.patchConfig(params)),
      listAgents: () => client.listAgents(),
      health: () => client.getHealth(),
    };
  } catch {
    return null;
  }
}

interface RegistrationSession {
  phase: FeishuRegistrationPhase;
  qrUrl: string | null;
  userCode: string | null;
  expireAt: number | null;
  appId: string | null;
  boundAgentId: string | null;
  error: string | null;
  cancelled: boolean;
}

function sessionView(session: RegistrationSession | null): FeishuRegistrationState {
  if (!session) {
    return {
      phase: 'idle',
      qrUrl: null,
      userCode: null,
      expireAt: null,
      appId: null,
      boundAgentId: null,
      error: null,
    };
  }
  return {
    phase: session.phase,
    qrUrl: session.qrUrl,
    userCode: session.userCode,
    expireAt: session.expireAt,
    appId: session.appId,
    boundAgentId: session.boundAgentId,
    error: session.error,
  };
}

export function registerConnectorHandlers(deps: ConnectorHandlerDeps): void {
  /**
   * `null` = 运行时还没给出真实状态目录（启动早期/启动失败）。
   * 调用方必须当"未就绪"处理，**不许**退回 `stateDirFor(userDataDir)` ——
   * 便携盘上那是 `openclaw-state`，与真正的 `state/<哈希>` 不是同一个目录。
   */
  const stateDirOf = (): string | null => {
    if (typeof deps.stateDir === 'function') {
      const value = deps.stateDir();
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    }
    return resolveStateDir(deps.userDataDir, deps.stateDir ?? process.env.OPENCLAW_STATE_DIR);
  };
  const runtimeMissingStatus = (): ConnectorStatus => ({
    id: 'feishu',
    configured: false,
    appId: null,
    enabled: false,
    pluginInstalled: false,
    runtimeReady: false,
  });
  /** 运行时部署的真实根：便携形态下与 userData 不同（见 deps.runtimeCacheUserDataDir）。 */
  const deploymentDirOf = () => deps.runtimeCacheUserDataDir ?? deps.userDataDir;
  const statusOf = (stateDir: string) => (deps.readStatus ?? readFeishuStatus)(stateDir, deploymentDirOf());
  const gatewayOf = async (): Promise<ConnectorGateway | null> => {
    try {
      return deps.gateway ? await deps.gateway() : await defaultGateway();
    } catch {
      return null;
    }
  };
  const fetchImpl: FeishuFetchImpl = deps.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const now = deps.now ?? Date.now;

  let session: RegistrationSession | null = null;
  /** 安装后的网关重启单飞：并发两次扫码不要连着重启两次。 */
  let installRestartInFlight: Promise<void> | null = null;

  const runRegistration = deps.pollRegistration ?? pollFeishuRegistration;

  /**
   * 扫码成功后：写 `channels.feishu`（保留既有绑定，否则绑主罗盘）。
   * ⚠️ 这里是**后台任务**：状态通过 `connectors:feishu-registration-status` 观察，
   *    失败原因（网关不可用 / 写被拒 / 回读不符）都落进 session.error。
   */
  const completeRegistration = async (target: RegistrationSession, begin: FeishuRegistrationBegin): Promise<void> => {
    try {
      const result: PollFeishuRegistrationResult = await runRegistration({
        fetchImpl,
        deviceCode: begin.deviceCode,
        intervalMs: begin.intervalMs,
        expireAt: begin.expireAt,
        domain: begin.domain,
        now,
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        isCancelled: () => target.cancelled,
      });
      if (target.cancelled) {
        target.phase = 'cancelled';
        return;
      }
      if (result.status !== 'success') {
        target.phase = result.status;
        if (result.status === 'error') target.error = result.message;
        return;
      }

      const gateway = await gatewayOf();
      if (!gateway) {
        target.phase = 'error';
        target.error = 'gateway-unavailable';
        return;
      }
      // 取网关也要时间：这一小段里用户可能已经取消、或又开了新一轮扫码。
      // 写盘前再验一次，避免把上一轮的旧凭证落进去（新一轮会覆盖成它的）。
      if (target.cancelled || session !== target) {
        target.phase = 'cancelled';
        return;
      }
      const applied = await applyFeishuCredentials(gateway, {
        appId: result.credentials.appId,
        appSecret: result.credentials.appSecret,
        openId: result.credentials.openId,
      });
      // 写入过程中被取消/换代：配置可能已经落盘（不谎报成功），但这条会话按取消收口。
      if (target.cancelled || session !== target) {
        target.phase = 'cancelled';
        return;
      }
      if (!applied.ok) {
        target.phase = 'error';
        target.error = `write-failed:${applied.reason}`;
        return;
      }
      target.phase = 'success';
      target.appId = applied.appId ?? result.credentials.appId;
      target.boundAgentId = applied.boundAgentId ?? null;
    } catch (error) {
      target.phase = 'error';
      target.error = error instanceof Error ? error.message : String(error);
    }
  };

  ipcMain.handle('connectors:status', (): IpcResult<{ connectors: ConnectorStatus[] }> => {
    try {
      const stateDir = stateDirOf();
      return { ok: true, result: { connectors: [stateDir ? statusOf(stateDir) : runtimeMissingStatus()] } };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  /**
   * 页面完整状态：盘上事实（配置/插件/运行时）+ **网关上的当前绑定与助手名单**。
   * 网关读不到 ⇒ 绑定退回盘上 `openclaw.json`，助手名单留空（不猜）。
   */
  ipcMain.handle('connectors:feishu-state', async (): Promise<IpcResult<{ state: FeishuConnectorState }>> => {
    try {
      const stateDir = stateDirOf();
      if (!stateDir) {
        return { ok: true, result: { state: { ...runtimeMissingStatus(), boundAgentId: null, agents: [] } } };
      }
      const base = statusOf(stateDir);
      let boundAgentId: string | null = null;
      let agents: FeishuAgentChoice[] = [];
      let snapshotConfig: Record<string, unknown> | null = null;
      let snapshotAppId: string | null = null;
      let snapshotEnabled = base.enabled;
      let channelHealth: FeishuChannelHealth | null = null;

      const gateway = await gatewayOf();
      if (gateway) {
        try {
          const snapshot = await gateway.getConfig();
          const config = (snapshot as { config?: Record<string, unknown> } | null)?.config ?? null;
          if (config) {
            snapshotConfig = config;
            const feishu = readFeishuConfig(config);
            snapshotAppId = feishu.appId;
            snapshotEnabled = feishu.enabled;
            boundAgentId = readFeishuRouteBindingIds(config)[0] ?? null;
          }
        } catch {
          // 网关可能在重启窗口：绑定信息退回盘上读，助手名单留空。
        }
        if (gateway.listAgents) {
          try {
            agents = feishuAgentChoices(await gateway.listAgents());
          } catch {
            agents = [];
          }
        }
        if (gateway.health) {
          try {
            const health = await gateway.health();
            const feishu = asRecord(asRecord(health['channels'])?.['feishu']);
            if (feishu) {
              const lastError = typeof feishu['lastError'] === 'string' ? feishu['lastError'].trim() : '';
              channelHealth = {
                running: feishu['running'] === true,
                lifecycle: typeof feishu['lifecycle'] === 'string' ? feishu['lifecycle'] : 'unknown',
                ingressUnavailable: feishu['ingressUnavailable'] === true,
                lastError: lastError || null,
              };
            }
          } catch {
            channelHealth = null;
          }
        }
      }

      if (!snapshotConfig) {
        boundAgentId = readFeishuRouteBindingsAt(stateConfigPath(stateDir))[0] ?? null;
      }

      const state: FeishuConnectorState = {
        ...base,
        // 网关快照可读时它才是权威：文件可能是上一次启动的存量。
        configured: snapshotConfig ? snapshotAppId !== null : base.configured,
        appId: snapshotAppId ?? base.appId,
        enabled: snapshotAppId ? snapshotEnabled : base.enabled,
        boundAgentId,
        agents,
        channelHealth,
      };
      return { ok: true, result: { state } };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('connectors:feishu-registration-begin', async (): Promise<IpcResult<FeishuRegistrationState>> => {
    if (session && session.phase === 'pending') session.cancelled = true;

    // 扫码之前先把插件装成**内核认可的可信安装**（BUG-171，2026-10-18）：
    //   ① 以前只看"目录在不在" ⇒ 目录复制的插件没有安装记录，内核拒绝 channel ingress
    //     （发得出、收不到，`reason=record-missing`）；
    //   ② 现在先读安装记录；缺失时用随包 npm + 离线缓存跑官方 npm 安装，生成真实记录；
    //   ③ 官方安装不可用（旧运行时/无 npm）时才退回目录复制，保证至少能出站。
    const stateDir = stateDirOf();
    if (!stateDir) return { ok: false, error: 'runtime-missing' };
    const bundledPluginDir =
      deps.bundledPluginPath !== undefined ? deps.bundledPluginPath : (resolveBundledPluginForApp() ?? null);
    const readRecord = deps.readInstallRecord ?? readFeishuInstallRecord;
    const deployment = readCurrentDeployment(deploymentDirOf());
    // 历史配置迁移：老盘上的 `groupPolicy: "open"` 收紧到 allowlist（幂等）。
    // 失败不阻塞扫码：新写入的配置本来就是 allowlist。
    try {
      const gateway = await gatewayOf();
      if (gateway) await hardenFeishuGroupPolicy(gateway);
    } catch {
      // 迁移失败留给下一次；不改变"扫码可用"这件事。
    }
    let trustedInstall = readRecord(stateDir) !== null;
    let installResult: FeishuInstallResult | null = null;
    if (!trustedInstall && deployment.status === 'ok' && deployment.nodePath && deployment.cliPath) {
      // 先停网关再安装：CLI 会写同一份 `openclaw.sqlite`，运行中的网关可能持锁；
      // 而安装完成后本来也必须重启才能加载新插件 —— 一次"停/装/起"同时解决两件事。
      try {
        const { stopLocalGatewayForMaintenance } = await import('../runtime/index.js');
        await stopLocalGatewayForMaintenance();
      } catch {
        // 停不下来也照常尝试安装；失败会落到下面的目录复制兜底。
      }
      try {
        const ensure = deps.ensureInstall ?? installFeishuFromOfficialPackage;
        installResult = await ensure({
          stateDir,
          nodePath: deployment.nodePath,
          cliPath: deployment.cliPath,
          pluginVersion: readBundledPluginVersion(bundledPluginDir),
          ...(deps.runtimeNodePayloadDir ? { payloadDir: deps.runtimeNodePayloadDir } : {}),
        });
        trustedInstall = installResult.ok;
        // 2026-10-19 现场：安装失败此前只落进 UI 的一句"通道未就绪"，日志里查不到原因。
        // 成败与失败原因（截断）都进主进程日志，下一次可以直接定位。
        getDebugLogger().info({
          domain: 'connector',
          event: 'connectors.feishu-install.result',
          data: installResult.ok
            ? { ok: true, installed: installResult.installed }
            : { ok: false, reason: installResult.reason, detail: installResult.detail.slice(0, 800) },
        });
      } finally {
        // 无论安装成败都把网关拉回来（用户还要扫码/聊天），单飞去重。
        if (!installRestartInFlight) {
          installRestartInFlight = (async () => {
            try {
              const { restartLocalGatewayRuntime } = await import('../runtime/index.js');
              await restartLocalGatewayRuntime();
              const { reconnectGateway } = await import('../ws/index.js');
              reconnectGateway('local-runtime');
            } catch {
              // 重启失败不影响扫码；健康提示会说明通道未就绪。
            }
          })().finally(() => {
            installRestartInFlight = null;
          });
        }
        await installRestartInFlight;
      }
    }
    if (!trustedInstall && !hasFeishuPlugin(stateDir)) {
      if (bundledPluginDir && deployment.status === 'ok' && deployment.cliPath) {
        const installed = await installBundledFeishu({
          bundledDir: bundledPluginDir,
          stateDir,
          openclawPackageDir: path.dirname(deployment.cliPath),
        });
        if (!installed.ok) return { ok: false, error: `plugin-install-failed:${installed.reason}` };
      }
    }
    const begin = await beginFeishuRegistration({
      fetchImpl,
      now,
    });
    if (!begin.ok) {
      const error = begin.message ? `${begin.reason}: ${begin.message}` : begin.reason;
      return { ok: false, error };
    }
    const created: RegistrationSession = {
      phase: 'pending',
      qrUrl: begin.begin.qrUrl,
      userCode: begin.begin.userCode,
      expireAt: begin.begin.expireAt,
      appId: null,
      boundAgentId: null,
      error: null,
      cancelled: false,
    };
    session = created;
    void completeRegistration(created, begin.begin);
    return { ok: true, result: sessionView(created) };
  });

  ipcMain.handle(
    'connectors:feishu-registration-status',
    (): IpcResult<FeishuRegistrationState> => ({ ok: true, result: sessionView(session) }),
  );

  ipcMain.handle('connectors:feishu-registration-cancel', (): IpcResult<{ cancelled: true }> => {
    if (session) {
      session.cancelled = true;
      if (session.phase === 'pending') session.phase = 'cancelled';
    }
    return { ok: true, result: { cancelled: true } };
  });

  ipcMain.handle(
    'connectors:feishu-bind',
    async (_event, payload: { agentId?: unknown }): Promise<IpcResult<{ boundAgentId: string | null }>> => {
      const raw = payload && typeof payload === 'object' ? payload.agentId : undefined;
      const agentId = typeof raw === 'string' ? raw.trim() : null;
      if (agentId !== null && !agentId) return { ok: false, error: 'invalid-agent' };
      const gateway = await gatewayOf();
      if (!gateway) return { ok: false, error: 'gateway-unavailable' };
      try {
        const result = await setFeishuRouteBinding(gateway, agentId);
        if (!result.ok) return { ok: false, error: result.reason };
        return { ok: true, result: { boundAgentId: result.boundAgentId ?? null } };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  ipcMain.handle(
    'connectors:feishu-enabled',
    async (_event, payload: { enabled?: unknown }): Promise<IpcResult<{ enabled: boolean }>> => {
      const enabled = Boolean(payload && typeof payload === 'object' && payload.enabled);
      const gateway = await gatewayOf();
      if (!gateway) return { ok: false, error: 'gateway-unavailable' };
      try {
        const result = await setFeishuChannelEnabled(gateway, enabled);
        if (!result.ok) return { ok: false, error: result.reason };
        return { ok: true, result: { enabled } };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  ipcMain.handle('connectors:feishu-login', async (): Promise<IpcResult<{ launched: true }>> => {
    const stateDir = stateDirOf();
    if (!stateDir) return { ok: false, error: 'runtime-missing' };
    const deployment = readCurrentDeployment(deploymentDirOf());
    if (deployment.status !== 'ok' || !deployment.nodePath || !deployment.cliPath) {
      // 没有运行时就没有 CLI：说清楚，别开一个必然报错的窗口。
      return { ok: false, error: 'runtime-missing' };
    }
    const inputs = {
      nodePath: deployment.nodePath,
      cliPath: deployment.cliPath,
      stateDir,
    };
    const ready = assertBootstrapInputs(inputs);
    if (!ready.ok) return { ok: false, error: ready.reason };

    try {
      const bundledPluginDir =
        deps.bundledPluginPath !== undefined ? deps.bundledPluginPath : (resolveBundledPluginForApp() ?? null);
      /*
        2026-10-17 用户反馈：「要解压，然后结果是失败」。
        安装**不归用户看**：先在这里静默装好（51MB 目录复制），终端窗口只出二维码。
        装不上就如实报（UI 里是中文「接入失败」），不把用户丢进一个必然失败的窗口。
      */
      let pluginInstalled = hasFeishuPlugin(stateDir);
      if (!pluginInstalled && bundledPluginDir) {
        const installed = await installBundledFeishu({
          bundledDir: bundledPluginDir,
          stateDir,
          // 与脚本里的 `Split-Path $cli -Parent` 同口径：cliPath 就在 openclaw 包根下。
          openclawPackageDir: path.dirname(deployment.cliPath),
        });
        if (!installed.ok) return { ok: false, error: installed.reason };
        pluginInstalled = true;
      }
      const command = buildFeishuBootstrapScript({
        ...inputs,
        bundledPluginDir: pluginInstalled ? null : bundledPluginDir,
        pluginAlreadyInstalled: pluginInstalled,
      });
      (deps.launch ?? launchInTerminal)(command);
      return { ok: true, result: { launched: true } };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
