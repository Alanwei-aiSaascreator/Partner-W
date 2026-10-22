import { ensureDeviceId } from '../workspace/config.js';
import { getDebugLogger } from '../debug/index.js';
import { getGatewayClient } from '../ws/index.js';
import { LOCAL_GATEWAY_ID } from '../runtime/state-config.js';
import { buildGatewayOriginPatch } from './gateway-settings.js';
import {
  resolveFrpcBinary,
  resolveRemoteAccessConfigPath,
  resolveRemoteAccessStateDir,
  resolveRemotePageRoot,
} from './locate.js';
import { RemoteAccessService, type RemoteAccessStatus } from './service.js';

/**
 * 远程访问的单例入口。
 *
 * 启动链只调 `startRemoteAccess()`，且**永不抛**：远程访问是增强能力，
 * 它坏了不许拖垮桌面端启动（最坏情况是设置里显示"已降级 + 原因"）。
 */

let instance: RemoteAccessService | null = null;

/**
 * 把公网 origin 写进网关白名单。
 *
 * 走 `config.patch` 而不是改文件：网关自己合并、自己重启，我们不碰它的磁盘状态。
 * 只增不改 —— 别的客户端可能正靠已有的 origin。
 */
async function applyGatewaySettings(host: string): Promise<void> {
  const gateway = getGatewayClient(LOCAL_GATEWAY_ID);
  if (!gateway?.isConnected) {
    throw new Error('gateway not connected');
  }

  const current = await gateway.getConfig();
  const rawConfig = current['config'];
  const config = (typeof rawConfig === 'object' && rawConfig !== null ? rawConfig : current) as Record<
    string,
    unknown
  >;

  // ⚠️ `config.patch` 对 `gateway.controlUi.allowedOrigins` 要求 baseHash（CAS）：
  //    不带就被网关拒（实测报错 "config base hash required …"）。hash 就在 config.get 里。
  const baseHash = typeof current['hash'] === 'string' ? current['hash'] : undefined;

  await gateway.patchConfig({
    raw: JSON.stringify(buildGatewayOriginPatch(config, host)),
    ...(baseHash ? { baseHash } : {}),
    note: 'remote-access: allow tunnel origin',
    restartDelayMs: 1500,
  });
}

export function getRemoteAccessService(): RemoteAccessService {
  if (!instance) {
    instance = new RemoteAccessService({
      configPath: resolveRemoteAccessConfigPath(),
      stateDir: resolveRemoteAccessStateDir(),
      pageRoot: resolveRemotePageRoot(),
      binaryPath: resolveFrpcBinary(),
      deviceId: () => ensureDeviceId(),
      applyGatewaySettings,
      logger: (event, data) => getDebugLogger().info({ domain: 'app', event, data }),
    });
  }
  return instance;
}

export async function startRemoteAccess(): Promise<RemoteAccessStatus> {
  try {
    const status = await getRemoteAccessService().start();
    getDebugLogger().info({
      domain: 'app',
      event: 'app.remote_access.start',
      data: { state: status.state, host: status.host, reason: status.reason },
    });
    return status;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    getDebugLogger().warn({
      domain: 'app',
      event: 'app.remote_access.start_failed',
      data: { reason },
    });
    return { state: 'degraded', reason };
  }
}

/**
 * 网关连上之后的通知入口（main 里轮询驱动）。
 *
 * 存在的理由：`allowedOrigins` 只能在网关 hello-ok 之后写进去，而远程访问
 * 服务是更早启动的。少这一步，冷启动后手机第一次连接必然被 1008 拒绝。
 */
export async function notifyGatewayConnected(): Promise<void> {
  if (!instance) return;
  await instance.onGatewayConnected().catch((err: unknown) => {
    getDebugLogger().warn({
      domain: 'app',
      event: 'app.remote_access.gateway_notify_failed',
      data: { reason: err instanceof Error ? err.message : String(err) },
    });
  });
}

export async function stopRemoteAccess(): Promise<void> {
  if (!instance) return;
  await instance.stop().catch((err: unknown) => {
    getDebugLogger().warn({
      domain: 'app',
      event: 'app.remote_access.stop_failed',
      data: { reason: err instanceof Error ? err.message : String(err) },
    });
  });
}
