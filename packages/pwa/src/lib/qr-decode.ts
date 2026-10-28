/**
 * 配对二维码解析。
 *
 * v2（当前唯一生产格式）：一枚二维码只带"主机 + setup code"，
 *   不含任何长期凭据 —— 见技术方案 v1.1 §6.2。
 *   ```json
 *   { "v": 2, "s": "<桌面 deviceId>",
 *     "g": [{ "n": "办公室-联想", "u": "wss://<host>/", "m": "setupCode", "c": "<setup code>" }] }
 *   ```
 *
 * v1（历史格式，仅调试可用）：把网关 token / 密码明文编进二维码。
 *   生产构建下**必须拒绝**：一张截图等于交出电脑。
 */

export type QrAuthMode = 'token' | 'password' | 'pairingCode' | 'setupCode';

export interface QrGatewayEntry {
  u: string;
  n: string;
  m?: QrAuthMode;
  /** v1 only：长期 token（生产禁用）。 */
  t?: string;
  /** v1 only：网关密码（生产禁用）。 */
  p?: string;
  /** v1: pairing code；v2: setup code。 */
  c?: string;
}

export interface ParsedQrPayload {
  v: 1 | 2;
  s?: string;
  g: QrGatewayEntry[];
}

export interface ParseQrOptions {
  /**
   * 是否接受 v1（明文凭据）二维码。
   * 默认只在该构建是开发态时开启；生产/测试代码应显式传值。
   */
  allowLegacyCredentials?: boolean;
}

const LEGACY_MODES: ReadonlyArray<QrAuthMode> = ['token', 'password', 'pairingCode'];
const ALL_MODES: ReadonlyArray<QrAuthMode> = [...LEGACY_MODES, 'setupCode'];

function defaultAllowLegacy(): boolean {
  try {
    return Boolean(import.meta.env?.DEV);
  } catch {
    return false;
  }
}

function assertWss(url: string, label: string): void {
  if (!url.startsWith('wss://')) {
    throw new Error(`Invalid QR code: ${label} must use wss://`);
  }
}

export function parseQrPayload(raw: string, options?: ParseQrOptions): ParsedQrPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid QR code: not valid JSON');
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error('Invalid QR code: expected object');
  }

  const version = obj.v;
  if (version !== 1 && version !== 2) {
    throw new Error(`Unsupported QR version: ${String(version)}`);
  }

  const scopeId = typeof obj.s === 'string' ? obj.s : undefined;

  const gateways = obj.g;
  if (!Array.isArray(gateways) || gateways.length === 0) {
    throw new Error('Invalid QR code: no gateways');
  }

  const allowLegacy = options?.allowLegacyCredentials ?? defaultAllowLegacy();
  if (version === 1 && !allowLegacy) {
    throw new Error('Unsupported QR version: 1 (plaintext credentials are not allowed)');
  }

  for (const gw of gateways as Record<string, unknown>[]) {
    if (typeof gw.u !== 'string' || typeof gw.n !== 'string') {
      throw new Error('Invalid QR code: malformed gateway entry');
    }
    if (!gw.u.startsWith('ws://') && !gw.u.startsWith('wss://')) {
      throw new Error('Invalid QR code: gateway URL must use ws:// or wss://');
    }
    if (gw.m !== undefined && !ALL_MODES.includes(gw.m as QrAuthMode)) {
      throw new Error('Invalid QR code: unsupported gateway auth mode');
    }
    if (gw.t !== undefined && typeof gw.t !== 'string') {
      throw new Error('Invalid QR code: malformed gateway token');
    }
    if (gw.p !== undefined && typeof gw.p !== 'string') {
      throw new Error('Invalid QR code: malformed gateway password');
    }
    if (gw.c !== undefined && typeof gw.c !== 'string') {
      throw new Error('Invalid QR code: malformed setup/pairing code');
    }

    if (version === 2) {
      // v2 只允许 setupCode；出现明文凭据一律拒绝（防降级/拼接攻击）。
      if (gw.m !== 'setupCode') {
        throw new Error('Invalid QR code: v2 requires setupCode auth mode');
      }
      if (!gw.c) {
        throw new Error('Invalid QR code: missing setup code');
      }
      assertWss(gw.u, 'gateway URL');
      if (gw.t !== undefined || gw.p !== undefined) {
        throw new Error('Invalid QR code: v2 must not carry plaintext credentials');
      }
      continue;
    }

    const mode = (gw.m ?? 'token') as QrAuthMode;
    if (mode === 'setupCode') {
      throw new Error('Invalid QR code: setupCode requires v2 payload');
    }
    if (mode === 'token' && !gw.t) {
      throw new Error('Invalid QR code: missing gateway token');
    }
    if (mode === 'password' && !gw.p) {
      throw new Error('Invalid QR code: missing gateway password');
    }
    if (mode === 'pairingCode' && !gw.c) {
      throw new Error('Invalid QR code: missing gateway pairing code');
    }
  }

  return {
    v: version,
    s: scopeId,
    g: gateways as QrGatewayEntry[],
  };
}

/**
 * 扫码解析入口：先试 JSON payload，失败时再试 **URL 形态**。
 *
 * ⚠️ 电脑端「移动端」面板生成的二维码是 URL（`https://<host>/m/?legacyPair=1&host=…&token=…`，
 * 系统相机/微信扫 URL 会出现「打开」动作，扫 JSON 只显示文本）——而 App 内扫码拿到的
 * raw 是 URL 字符串，直接 JSON.parse 必然「not valid JSON」（2026-10-22 真机）。
 * 这里把 legacyPair URL 还原成 v1 payload，扫码与粘贴两条路径就对齐了。
 */
export function parseQrPayloadOrUrl(raw: string, options?: ParseQrOptions): ParsedQrPayload {
  try {
    return parseQrPayload(raw, options);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('not valid JSON')) throw err;
  }
  try {
    const url = new URL(raw);
    const params = url.searchParams;
    const host = params.get('host')?.trim();
    const token = params.get('token')?.trim();
    const name = params.get('name')?.trim() || 'Partner-W';
    if (params.get('legacyPair') === '1' && host && token) {
      const normalized = host.replace(/^wss?:\/\//, '');
      return {
        v: 1,
        g: [{ n: name, u: `wss://${normalized}`, m: 'token', t: token }],
      };
    }
  } catch {
    /* 不是 URL：交给原错误 */
  }
  throw new Error('Invalid QR code: not valid JSON');
}
