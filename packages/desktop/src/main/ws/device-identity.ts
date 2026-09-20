import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { decryptSecret, encryptSecret } from '../util/secure-field.js';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * 落盘形状。
 *
 * ⚠️ `privateKeyPem` / `publicKeyPem` 这两个**字段名**是从加固前沿用下来的：
 *    私钥现在存的是密文（`enc:` 前缀），公钥仍是明文（公钥本来就是公开的，
 *    留着明文还能让人一眼看出"这是哪台设备"）。改名会让老文件读不出来，
 *    所以不改名、只换内容。
 */
interface StoredIdentity {
  version: 1;
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAtMs: number;
}

export interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function fingerprintPublicKey(publicKeyPem: string): string {
  const raw = derivePublicKeyRaw(publicKeyPem);
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function generateIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return {
    deviceId: fingerprintPublicKey(publicKeyPem),
    publicKeyPem,
    privateKeyPem,
  };
}

function resolveDefaultIdentityPath(): string {
  return path.join(app.getPath('userData'), 'device-identity.json');
}

/** 落盘（私钥在这里加密；传进来的是**已存形式**，所以 re-derive 时不会二次加密）。 */
function writeIdentityFile(resolved: string, stored: StoredIdentity): void {
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
}

export function loadOrCreateDeviceIdentity(filePath?: string): DeviceIdentity {
  const resolved = filePath ?? resolveDefaultIdentityPath();
  try {
    if (fs.existsSync(resolved)) {
      const raw = fs.readFileSync(resolved, 'utf8');
      const parsed = JSON.parse(raw) as StoredIdentity;
      if (
        parsed?.version === 1 &&
        typeof parsed.deviceId === 'string' &&
        typeof parsed.publicKeyPem === 'string' &&
        typeof parsed.privateKeyPem === 'string'
      ) {
        // 明文（加固前落的）与密文都从这里出来；**解不开**才返回 null
        const privateKeyPem = decryptSecret(parsed.privateKeyPem);
        if (privateKeyPem) {
          const derivedId = fingerprintPublicKey(parsed.publicKeyPem);
          if (derivedId && derivedId !== parsed.deviceId) {
            const updated: StoredIdentity = { ...parsed, deviceId: derivedId };
            writeIdentityFile(resolved, updated);
            return { deviceId: derivedId, publicKeyPem: parsed.publicKeyPem, privateKeyPem };
          }
          return { deviceId: parsed.deviceId, publicKeyPem: parsed.publicKeyPem, privateKeyPem };
        }
        // 密文解不开（换了机器 / 换了 Windows 账户）⇒ 落到下面**重新生成**：
        // 设备身份丢了要重新配对，但绝不能因此让应用起不来。
      }
    }
  } catch {}
  const identity = generateIdentity();
  writeIdentityFile(resolved, {
    version: 1,
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: encryptSecret(identity.privateKeyPem),
    createdAtMs: Date.now(),
  });
  return identity;
}

function publicKeyRawBase64Url(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  return base64UrlEncode(Buffer.from(crypto.sign(null, Buffer.from(payload, 'utf8'), key)));
}

interface DeviceAuthPayloadV3Params {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string | null;
  nonce: string;
  platform: string | null;
  deviceFamily: string | null;
}

function normalizeMetadataForAuth(value: string | null | undefined): string {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

function buildDeviceAuthPayloadV3(params: DeviceAuthPayloadV3Params): string {
  const scopes = params.scopes.join(',');
  const token = params.token ?? '';
  const platform = normalizeMetadataForAuth(params.platform);
  const deviceFamily = normalizeMetadataForAuth(params.deviceFamily);
  return [
    'v3',
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
    platform,
    deviceFamily,
  ].join('|');
}

interface DeviceConnectPayload {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce: string;
}

export function buildDeviceConnectPayload(
  identity: DeviceIdentity,
  params: {
    clientId: string;
    clientMode: string;
    role: string;
    scopes: string[];
    nonce: string;
    token: string | null;
    platform: string | null;
    deviceFamily: string | null;
  },
): DeviceConnectPayload {
  const signedAtMs = Date.now();
  const payload = buildDeviceAuthPayloadV3({
    deviceId: identity.deviceId,
    clientId: params.clientId,
    clientMode: params.clientMode,
    role: params.role,
    scopes: params.scopes,
    signedAtMs,
    token: params.token,
    nonce: params.nonce,
    platform: params.platform,
    deviceFamily: params.deviceFamily,
  });
  const signature = signDevicePayload(identity.privateKeyPem, payload);
  return {
    id: identity.deviceId,
    publicKey: publicKeyRawBase64Url(identity.publicKeyPem),
    signature,
    signedAt: signedAtMs,
    nonce: params.nonce,
  };
}

interface DeviceTokenStore {
  version: 1;
  tokens: Record<string, { token: string; role: string; issuedAtMs: number }>;
}

function resolveDeviceTokenStorePath(): string {
  return path.join(app.getPath('userData'), 'device-tokens.json');
}

function readTokenStore(): DeviceTokenStore {
  const storePath = resolveDeviceTokenStorePath();
  try {
    if (fs.existsSync(storePath)) {
      const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8')) as DeviceTokenStore;
      if (parsed?.version === 1 && parsed.tokens && typeof parsed.tokens === 'object') {
        const tokens: DeviceTokenStore['tokens'] = {};
        for (const [gatewayId, entry] of Object.entries(parsed.tokens)) {
          // 明文（加固前落的）照读；密文解不开就**丢掉这一条**（当成没配对过，
          // 走重新配对）——比拿着半个 token 去连网关最后被判 foreign 清楚。
          const token = typeof entry?.token === 'string' ? decryptSecret(entry.token) : null;
          if (token) tokens[gatewayId] = { ...entry, token };
        }
        return { version: 1, tokens };
      }
    }
  } catch {}
  return { version: 1, tokens: {} };
}

function writeTokenStore(store: DeviceTokenStore): void {
  const storePath = resolveDeviceTokenStorePath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const encrypted: DeviceTokenStore = {
    version: 1,
    tokens: Object.fromEntries(
      Object.entries(store.tokens).map(([gatewayId, entry]) => [
        gatewayId,
        { ...entry, token: encryptSecret(entry.token) },
      ]),
    ),
  };
  fs.writeFileSync(storePath, `${JSON.stringify(encrypted, null, 2)}\n`, { mode: 0o600 });
}

export function saveDeviceToken(gatewayId: string, token: string, role: string, issuedAtMs: number): void {
  const store = readTokenStore();
  store.tokens[gatewayId] = { token, role, issuedAtMs };
  writeTokenStore(store);
}

export function loadDeviceToken(gatewayId: string): string | null {
  const store = readTokenStore();
  return store.tokens[gatewayId]?.token ?? null;
}
