/**
 * 网关侧的远程访问配置（技术方案 v1.2 §5.4）。
 *
 * 公网来的请求 Host 是 `<short8>.rym...`，网关默认只认 loopback/配置里列过的来源，
 * 于是页面能开、API 全 403 —— 这就是"设备页 200、一调接口就挂"的那种失败。
 *
 * 这里只产出**补丁对象**（纯函数，可单测）：真正的写入由网关自己完成
 * （`config.patch` → 它自己合并、自己重启），我们不碰它的文件。
 */

export interface GatewayOriginPatch {
  gateway: {
    controlUi: { allowedOrigins: string[] };
    publicOrigin: string;
  };
}

function normalizeOrigin(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('host is required');
  // 不能只认 http(s)：白名单里还有原生壳的 `capacitor://localhost`，
  // 按 http-only 判断会被改写成 `https://capacitor://localhost`（真机上连不上）。
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, '').toLowerCase();
}

function readExistingOrigins(config: Record<string, unknown> | null | undefined): string[] {
  const gateway = config?.['gateway'];
  if (typeof gateway !== 'object' || gateway === null) return [];
  const controlUi = (gateway as Record<string, unknown>)['controlUi'];
  if (typeof controlUi !== 'object' || controlUi === null) return [];
  const allowed = (controlUi as Record<string, unknown>)['allowedOrigins'];
  if (!Array.isArray(allowed)) return [];
  return allowed.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
}

/**
 * 生成"把某个公网 origin 加进白名单"的补丁。
 *
 * 只增不改：已有的 origin 一个都不删（别的客户端可能正靠它们），
 * 也不动 `dangerouslyAllowHostHeaderOriginFallback`（保持原配置）。
 */
export function buildGatewayOriginPatch(
  config: Record<string, unknown> | null | undefined,
  host: string,
): GatewayOriginPatch {
  const origin = normalizeOrigin(host);
  const existing = readExistingOrigins(config).map((entry) => {
    try {
      return normalizeOrigin(entry);
    } catch {
      return entry.trim().toLowerCase();
    }
  });

  // 原生壳（Capacitor）加载的是本地资源，Origin 不是公网域名：
  // Android 用 https://localhost，iOS 用 capacitor://localhost —— 不预先放进白名单，
  // App 一连就 1008。这两条是常量，不参与 normalize（capacitor:// 不是 http 协议）。
  const nativeAppOrigins = ['https://localhost', 'capacitor://localhost'];
  const allowedOrigins = Array.from(new Set([...existing, origin, ...nativeAppOrigins]));

  return {
    gateway: {
      controlUi: { allowedOrigins },
      publicOrigin: origin,
    },
  };
}
