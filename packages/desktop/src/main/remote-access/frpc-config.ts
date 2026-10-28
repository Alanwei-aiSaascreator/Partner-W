/**
 * frpc 配置生成（技术方案 v1.2 §5.5）。
 *
 * 客户机用一枚 8 位子域 `<short8>.rym.rongyinghudong.com` 对外，frpc 把本机
 * 18780（设备页 + 网关的统一入口）挂到这个子域上。
 *
 * 这几个函数是纯的（不碰文件、不起进程），因为"子域错了会连到别人电脑上"
 * 这件事值得单独钉住。
 */

/** 统一入口端口：静态页 + 网关反代都在这里，见 remote-page-server.ts。 */
export const FRPC_LOCAL_PORT = 18780;

/** 与 nginx 的 `server_name ~^(?<dev>[a-z0-9]{8})\.rym\.rongyinghudong\.com$` 对齐。 */
const SUBDOMAIN_RE = /^[a-z0-9]{8}$/;

export interface FrpcConfigInput {
  serverAddr: string;
  serverPort: number;
  token: string;
  /** 8 位小写字母数字，来自 deviceId。 */
  subdomain: string;
  localIp?: string;
  localPort?: number;
}

export function isValidSubdomain(value: string): boolean {
  return SUBDOMAIN_RE.test(value);
}

/**
 * deviceId（UUID）→ 8 位子域。
 *
 * 只保留字母数字：UUID 的连字符去掉后前 8 位仍是 hex，天然满足 `[a-z0-9]{8}`，
 * 也不依赖 base32 编码表（少一层可能出错的转换）。
 */
export function short8FromDeviceId(deviceId: string): string {
  const compact = deviceId.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (compact.length < 8) {
    throw new Error(`deviceId too short for a subdomain: ${deviceId}`);
  }
  return compact.slice(0, 8);
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildFrpcToml(input: FrpcConfigInput): string {
  const subdomain = input.subdomain.trim().toLowerCase();
  if (!isValidSubdomain(subdomain)) {
    throw new Error(`invalid subdomain: ${input.subdomain} (expect 8 chars of [a-z0-9])`);
  }

  const serverAddr = input.serverAddr.trim();
  if (!serverAddr) throw new Error('serverAddr is required');
  if (!Number.isInteger(input.serverPort) || input.serverPort <= 0 || input.serverPort > 65535) {
    throw new Error(`invalid serverPort: ${input.serverPort}`);
  }

  const token = input.token.trim();
  if (!token) throw new Error('token is required');

  const localIp = input.localIp ?? '127.0.0.1';
  const localPort = input.localPort ?? FRPC_LOCAL_PORT;

  return [
    '# 由Partner-W自动生成，请勿手改（改请在电脑端的「移动端」设置里改）',
    `serverAddr = ${tomlString(serverAddr)}`,
    `serverPort = ${input.serverPort}`,
    '',
    '# 由桌面壳的退避逻辑负责重试，双层重连会互相打架',
    'loginFailExit = false',
    '',
    'transport.tls.enable = true',
    '',
    'auth.method = "token"',
    `auth.token = ${tomlString(token)}`,
    '',
    '[[proxies]]',
    `name = ${tomlString(`rym-${subdomain}`)}`,
    'type = "http"',
    `localIP = ${tomlString(localIp)}`,
    `localPort = ${localPort}`,
    `subdomain = ${tomlString(subdomain)}`,
    '',
  ].join('\n');
}
