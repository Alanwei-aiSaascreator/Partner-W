/**
 * Setup Code 解析。
 *
 * 网关的 setup code 是 `base64(JSON { url, urls?, bootstrapToken })`：
 * 单次、10 分钟过期、配对后被网关标记为已用（见引擎 `docs/channels/pairing.md`）。
 *
 * 手机端**只**从 setup code 取一次性 bootstrapToken，绝不接收网关长期 token ——
 * 这是技术方案 v1.1 §1.2 / §6.2 的硬约束：二维码里一旦出现长期凭据，
 * 一张截图就等于交出电脑控制权。
 */

export interface SetupCodePayload {
  /** 必须是 wss:// —— 远程配对只走加密通道。 */
  url: string;
  urls?: string[];
  bootstrapToken: string;
}

const BASE64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

function decodeBase64(raw: string): string {
  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);

  if (typeof atob !== 'function') {
    throw new Error('Invalid setup code: no base64 decoder available');
  }
  return atob(padded);
}

export function parseSetupCode(raw: string): SetupCodePayload {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Invalid setup code: empty');
  }

  // 有些实现会把 setup code 直接写成 `data:application/json;base64,...`
  const payloadText = trimmed.startsWith('data:') ? trimmed.slice(trimmed.indexOf(',') + 1) : trimmed;

  if (!BASE64_RE.test(payloadText)) {
    throw new Error('Invalid setup code: not base64');
  }

  let decoded: string;
  try {
    decoded = decodeBase64(payloadText);
  } catch {
    throw new Error('Invalid setup code: not base64');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error('Invalid setup code: payload is not JSON');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid setup code: payload is not an object');
  }

  const obj = parsed as Record<string, unknown>;
  const url = typeof obj.url === 'string' ? obj.url.trim() : '';
  const bootstrapToken = typeof obj.bootstrapToken === 'string' ? obj.bootstrapToken.trim() : '';

  if (!url) {
    throw new Error('Invalid setup code: missing url');
  }
  if (!url.startsWith('wss://')) {
    throw new Error('Invalid setup code: url must use wss://');
  }
  if (!bootstrapToken) {
    throw new Error('Invalid setup code: missing bootstrapToken');
  }

  const urls = Array.isArray(obj.urls)
    ? obj.urls.filter((entry): entry is string => typeof entry === 'string')
    : undefined;

  return { url, urls, bootstrapToken };
}

/** 只比主机名+端口：普通码允许把 URL 换成同一主机的等价值，不允许换主机。 */
export function isSameGatewayHost(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    const normalize = (url: URL) =>
      `${url.hostname.toLowerCase()}:${url.port || (url.protocol === 'wss:' ? '443' : '80')}`;
    return normalize(left) === normalize(right);
  } catch {
    return false;
  }
}
