/**
 * 手机端配对二维码（v2）payload 组装。
 *
 * 设计意图（技术方案 v1.1 §1.2 / §6.2）：
 *   - 二维码里**只**放"公网主机 + 一次性 setup code"，绝不放网关 token / 密码；
 *   - setup code 由网关 `device.pair.setupCode` 生成（单次、10 分钟、limited），
 *     但它自带的 url 是桌面壳眼里那个本机地址，手机在外网用不了 ——
 *     所以这里把 url **覆写**成隧道域名，bootstrapToken 原样保留。
 *
 * ⚠️ 覆写只改 url，不动 bootstrapToken：token 是网关签发的，我们没资格也不该重签。
 */

export interface SetupCodeFields {
  url: string;
  urls?: string[];
  bootstrapToken: string;
}

export interface MobileQrGatewayEntry {
  n: string;
  u: string;
  m: 'setupCode';
  c: string;
}

export interface MobileQrPayload {
  v: 2;
  s?: string;
  g: MobileQrGatewayEntry[];
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

function normalizeHostname(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

/**
 * 公网地址规范化：必须是 wss://、必须不是 loopback、不带 query/hash，
 * 统一收敛成 `wss://<host>/`（设备页与网关同源，路径由隧道 ingress 决定）。
 */
export function normalizePublicWssUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('publicUrl is required');

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('publicUrl must be a valid URL');
  }

  if (parsed.protocol !== 'wss:') {
    throw new Error('publicUrl must use wss://');
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (LOOPBACK_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
    throw new Error('publicUrl must not point at loopback');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('publicUrl must not carry query or fragment');
  }

  return `wss://${parsed.host}/`;
}

/** 解网关发来的 setup code（`base64(JSON {url, urls?, bootstrapToken})`）。 */
export function decodeSetupCode(code: string): SetupCodeFields {
  const trimmed = code.trim();
  if (!trimmed) throw new Error('setup code is empty');

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(trimmed, 'base64').toString('utf8'));
  } catch {
    throw new Error('setup code is not valid base64 JSON');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('setup code payload is not an object');
  }

  const obj = parsed as Record<string, unknown>;
  const url = typeof obj.url === 'string' ? obj.url.trim() : '';
  const bootstrapToken = typeof obj.bootstrapToken === 'string' ? obj.bootstrapToken.trim() : '';
  if (!url) throw new Error('setup code is missing url');
  if (!bootstrapToken) throw new Error('setup code is missing bootstrapToken');

  const urls = Array.isArray(obj.urls)
    ? obj.urls.filter((entry): entry is string => typeof entry === 'string')
    : undefined;

  return { url, urls, bootstrapToken };
}

/** 编码回 setup code（只在手机端解析，网关不消费我们重编码的结果）。 */
export function encodeSetupCode(fields: SetupCodeFields): string {
  const payload: Record<string, unknown> = { url: fields.url, bootstrapToken: fields.bootstrapToken };
  if (fields.urls?.length) payload.urls = fields.urls;
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

/**
 * 生成手机扫码用的 v2 payload。
 *
 * @param opts.setupCode  网关 `device.pair.setupCode` 返回的原始 setup code
 * @param opts.publicUrl  隧道域名（`wss://<short8>.rym...`）
 * @param opts.gatewayName 手机上显示的电脑名
 * @param opts.deviceId   桌面 deviceId（可选，手机存起来做"这是哪台电脑"的标识）
 */
export function buildMobileQrPayload(opts: {
  setupCode: string;
  publicUrl: string;
  gatewayName: string;
  deviceId?: string;
}): MobileQrPayload {
  const publicUrl = normalizePublicWssUrl(opts.publicUrl);
  const fields = decodeSetupCode(opts.setupCode);

  const name = opts.gatewayName.trim();
  if (!name) throw new Error('gatewayName is required');

  const rewritten = encodeSetupCode({ url: publicUrl, bootstrapToken: fields.bootstrapToken });

  const payload: MobileQrPayload = {
    v: 2,
    g: [{ n: name, u: publicUrl, m: 'setupCode', c: rewritten }],
  };
  if (opts.deviceId?.trim()) {
    payload.s = opts.deviceId.trim();
  }
  return payload;
}
