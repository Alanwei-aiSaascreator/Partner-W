import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GATEWAY_WS_PORT } from '@clawwork/shared';
import { buildFrpcToml, isValidSubdomain, short8FromDeviceId } from './frpc-config.js';
import { FrpcProcess } from './frpc-process.js';
import { RemotePageServer } from './remote-page-server.js';

/**
 * 远程访问总装（技术方案 v1.2 §5.2）。
 *
 * 把三件事串起来：读配置 → 起 18780 入口 → 生成 frpc.toml 并起 frpc。
 * 任何一步失败都落到 `degraded` + 原因，绝不让"看起来在线但手机连不上"发生。
 *
 * M1 阶段的配置来自 `<userData>/remote-access.json`（手工/内测写入）；
 * M2 起由后端下发覆盖，本类不关心来源。
 */

export type RemoteAccessState = 'disabled' | 'starting' | 'online' | 'degraded' | 'stopped';

export interface RemoteAccessConfig {
  enabled: boolean;
  serverAddr: string;
  serverPort: number;
  token: string;
  /** 8 位子域；缺省由 deviceId 派生。 */
  subdomain?: string;
  /** 域名后缀，默认 rym.rongyinghudong.com。 */
  domainSuffix?: string;
}

export interface RemoteAccessStatus {
  state: RemoteAccessState;
  reason?: string;
  subdomain?: string;
  host?: string;
  entryPort?: number;
  frpcState?: string;
  /** 网关白名单是否已写上；false = 页面能开但 API 会 403。 */
  gatewayConfigured?: boolean;
}

export interface RemoteAccessDeps {
  configPath: string;
  stateDir: string;
  pageRoot: string;
  binaryPath: string;
  deviceId: () => string;
  gatewayOrigin?: string;
  logger?: (event: string, data?: Record<string, unknown>) => void;
  createPageServer?: (options: ConstructorParameters<typeof RemotePageServer>[0]) => RemotePageServer;
  createFrpc?: (options: ConstructorParameters<typeof FrpcProcess>[0]) => FrpcProcess;
  /** 把公网 origin 写进网关白名单（`controlUi.allowedOrigins` + `publicOrigin`）。 */
  applyGatewaySettings?: (host: string) => Promise<void>;
}

const DEFAULT_DOMAIN_SUFFIX = 'rym.rongyinghudong.com';

export class RemoteAccessService {
  private readonly deps: RemoteAccessDeps;
  private pageServer: RemotePageServer | null = null;
  private frpc: FrpcProcess | null = null;
  private status: RemoteAccessStatus = { state: 'stopped' };
  private starting = false;
  /** 待写入网关白名单的 host；网关连上后再落（见 onGatewayConnected）。 */
  private pendingHost?: string;

  constructor(deps: RemoteAccessDeps) {
    this.deps = deps;
  }

  getStatus(): RemoteAccessStatus {
    if (this.frpc) {
      const frpcState = this.frpc.currentState;
      if (frpcState === 'degraded' && this.status.state === 'online') {
        return { ...this.status, state: 'degraded', frpcState, reason: 'frpc 连续失败已停止重试' };
      }
      return { ...this.status, frpcState };
    }
    return { ...this.status };
  }

  /** 读配置；文件不存在或解析失败都返回 null（不抛，启动链不该被它拖死）。 */
  loadConfig(): RemoteAccessConfig | null {
    let raw: string;
    try {
      raw = readFileSync(this.deps.configPath, 'utf8');
    } catch {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<RemoteAccessConfig>;
      if (typeof parsed !== 'object' || parsed === null) return null;
      if (typeof parsed.serverAddr !== 'string' || !parsed.serverAddr.trim()) return null;
      if (typeof parsed.serverPort !== 'number') return null;
      if (typeof parsed.token !== 'string' || !parsed.token.trim()) return null;
      return {
        enabled: parsed.enabled === true,
        serverAddr: parsed.serverAddr.trim(),
        serverPort: parsed.serverPort,
        token: parsed.token.trim(),
        subdomain: typeof parsed.subdomain === 'string' ? parsed.subdomain.trim().toLowerCase() : undefined,
        domainSuffix: typeof parsed.domainSuffix === 'string' ? parsed.domainSuffix.trim() : undefined,
      };
    } catch {
      return null;
    }
  }

  async start(): Promise<RemoteAccessStatus> {
    if (this.starting) return this.getStatus();
    if (this.pageServer || this.frpc) return this.getStatus();

    const config = this.loadConfig();
    if (!config) {
      this.status = { state: 'disabled', reason: '未配置远程访问' };
      return this.getStatus();
    }
    if (!config.enabled) {
      this.status = { state: 'disabled', reason: '远程访问已关闭' };
      return this.getStatus();
    }

    const subdomain = config.subdomain || short8FromDeviceId(this.deps.deviceId());
    if (!isValidSubdomain(subdomain)) {
      this.status = { state: 'degraded', reason: `子域不合法：${subdomain}` };
      return this.getStatus();
    }

    const suffix = config.domainSuffix || DEFAULT_DOMAIN_SUFFIX;
    this.starting = true;
    this.status = { state: 'starting', subdomain, host: `${subdomain}.${suffix}` };

    try {
      const configPath = join(this.deps.stateDir, 'frpc.toml');
      mkdirSync(this.deps.stateDir, { recursive: true });
      writeFileSync(
        configPath,
        buildFrpcToml({
          serverAddr: config.serverAddr,
          serverPort: config.serverPort,
          token: config.token,
          subdomain,
        }),
        'utf8',
      );

      const createPageServer = this.deps.createPageServer ?? ((options) => new RemotePageServer(options));
      const pageServer = createPageServer({
        pageRoot: this.deps.pageRoot,
        gatewayOrigin: this.deps.gatewayOrigin ?? `http://127.0.0.1:${GATEWAY_WS_PORT}`,
        logger: this.deps.logger,
      });
      const port = await pageServer.start();
      this.pageServer = pageServer;

      const createFrpc = this.deps.createFrpc ?? ((options) => new FrpcProcess(options));
      const frpc = createFrpc({
        binaryPath: this.deps.binaryPath,
        configPath,
        logPath: join(this.deps.stateDir, 'frpc.log'),
        logger: this.deps.logger,
      });
      frpc.start();
      this.frpc = frpc;

      const host = `${subdomain}.${suffix}`;
      this.pendingHost = host;

      // 启动早期网关往往还没 hello-ok，写白名单必然失败；这里试一次，
      // 失败的留给 onGatewayConnected() 在网关连上后重试（main 里轮询驱动）。
      const gatewayConfigured = await this.tryApplyGatewaySettings(host);

      this.status = {
        state: 'online',
        subdomain,
        host,
        entryPort: port,
        gatewayConfigured,
      };
      this.deps.logger?.('remote.access.online', { host, entryPort: port, gatewayConfigured });
      return this.getStatus();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.stop();
      this.status = { state: 'degraded', reason: message, subdomain, host: `${subdomain}.${suffix}` };
      this.deps.logger?.('remote.access.failed', { message });
      return this.getStatus();
    } finally {
      this.starting = false;
    }
  }

  /**
   * 网关 hello-ok 之后调用（幂等，可被轮询反复调用）。
   *
   * 为什么要有这一步：`allowedOrigins` 缺省会让人手机上"页面打得开、API 全 403"，
   * 而远程访问服务是在网关之前启动的 —— 启动时那次写入必然失败。
   */
  async onGatewayConnected(): Promise<void> {
    if (!this.pendingHost) return;
    if (this.status.gatewayConfigured) return;
    const configured = await this.tryApplyGatewaySettings(this.pendingHost);
    if (configured) {
      this.status = { ...this.status, gatewayConfigured: true };
    }
  }

  /** 写网关白名单；返回是否写成功。失败不改变 online 状态，但要记日志。 */
  private async tryApplyGatewaySettings(host: string): Promise<boolean> {
    if (!this.deps.applyGatewaySettings) return false;
    try {
      await this.deps.applyGatewaySettings(host);
      this.deps.logger?.('remote.access.gateway-settings-applied', { host });
      return true;
    } catch (err) {
      // 白名单没写上时页面仍然能开，只是 API 全 403 —— 不能连带把整个
      // 远程访问判成失败，但必须在状态里说清楚，否则排障会跑偏到隧道上。
      this.deps.logger?.('remote.access.gateway-settings-failed', {
        message: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async stop(): Promise<void> {
    const frpc = this.frpc;
    this.frpc = null;
    if (frpc) await frpc.stop().catch(() => {});

    const pageServer = this.pageServer;
    this.pageServer = null;
    if (pageServer) await pageServer.stop().catch(() => {});

    this.status = { state: 'stopped' };
  }
}
