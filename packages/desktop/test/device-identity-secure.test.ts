import { createPrivateKey } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 设备身份与设备令牌**不许明文落盘**（外部审计 P3）。
 *
 * 实测过的事实（不是推测）：`%APPDATA%/@clawwork/desktop/device-identity.json`
 * 里 `privateKeyPem` 是一段**可读的 PEM 私钥**；`device-tokens.json` 里
 * `tokens.<gw>.token` 是**原样的 operator token**（`role: "operator"`）。
 * 两者都够用来冒充这台设备连本机网关。
 *
 * ⇒ 这一组用例盯的三件事，缺一不可：
 *   1. **新写的**是密文（`enc:` 前缀），文件里搜不到私钥/token 原文；
 *   2. **旧明文文件照样能读**（不能因为加固就把已配对用户的身份弄丢）；
 *   3. **加密不可用时仍然能用**（老系统/受限环境退回明文，功能优先）。
 *
 * ⚠️ 只在 mkdtemp 里建删文件，绝不触碰真实 `%APPDATA%`。
 * ⚠️ 这里用一段可逆的**假**加密（`ENC(...)`）：证明"走的是解密那条路"，
 *    真实强度由 `safeStorage`（DPAPI）提供，单测环境给不了。
 */

const mocks = vi.hoisted(() => ({
  userDataDir: '',
  encryptionAvailable: true,
}));

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => mocks.encryptionAvailable,
    encryptString: (s: string) => Buffer.from(`ENC(${s})`, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^ENC\(|\)$/g, ''),
  },
}));

const { loadOrCreateDeviceIdentity, saveDeviceToken, loadDeviceToken } =
  await import('../src/main/ws/device-identity.js');

const IDENTITY_FILE = 'device-identity.json';
const TOKENS_FILE = 'device-tokens.json';

let dir: string;

function read(name: string): string {
  return readFileSync(join(dir, name), 'utf8');
}

/**
 * 加固前**真实**落盘的形状（照抄本机那份的字段）。
 *
 * ⚠️ 夹具必须用**真钥匙**：`loadOrCreateDeviceIdentity` 会拿 `publicKeyPem` 去算指纹，
 *    塞一段假 PEM 会让 `crypto.createPublicKey` 抛 ⇒ 走"重新生成"分支
 *    ⇒ 用例红得跟加固无关（第一版就栽在这，见 [[verify-your-own-verifier]]）。
 *    ⇒ 所以先用模块自己生成一份真身份，再按旧格式**明文**写回去。
 */
function legacyIdentityJson(identity: { deviceId: string; publicKeyPem: string; privateKeyPem: string }): string {
  return `${JSON.stringify(
    {
      version: 1,
      deviceId: identity.deviceId,
      publicKeyPem: identity.publicKeyPem,
      privateKeyPem: identity.privateKeyPem,
      createdAtMs: 1_700_000_000_000,
    },
    null,
    2,
  )}\n`;
}

/** 造一份"旧版本写的明文身份文件"，返回它里面的身份。 */
function writeLegacyIdentityFile(): { deviceId: string; publicKeyPem: string; privateKeyPem: string } {
  const created = loadOrCreateDeviceIdentity();
  writeFileSync(join(dir, IDENTITY_FILE), legacyIdentityJson(created), 'utf8');
  expect(read(IDENTITY_FILE), '前置条件：这份文件必须是明文的').not.toContain('enc:');
  return created;
}

function legacyTokensJson(): string {
  return `${JSON.stringify(
    {
      version: 1,
      tokens: { 'gw-legacy': { token: 'legacy-op-token', role: 'operator', issuedAtMs: 1 } },
    },
    null,
    2,
  )}\n`;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clawwork-device-identity-'));
  mocks.userDataDir = dir;
  mocks.encryptionAvailable = true;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('device-identity.json —— 私钥不落明文', () => {
  it('⭐ 第一次创建：文件里搜不到私钥原文，但读出还是同一把钥匙', () => {
    const identity = loadOrCreateDeviceIdentity();

    const raw = read(IDENTITY_FILE);
    expect(raw, '私钥 PEM 原文不许出现在文件里').not.toContain('PRIVATE KEY');
    expect(raw, '落盘的是密文').toContain('enc:');

    // 但读回来的必须是**能用的**私钥（签名要用）
    expect(identity.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(identity.publicKeyPem).toContain('BEGIN PUBLIC KEY');
  });

  it('⭐ 第二次读：解出**同一个** deviceId，不是重新生成', () => {
    const legacy = writeLegacyIdentityFile();

    const first = loadOrCreateDeviceIdentity();
    const second = loadOrCreateDeviceIdentity();

    expect(first.deviceId).toBe(legacy.deviceId);
    expect(second.deviceId).toBe(legacy.deviceId);
    expect(second.privateKeyPem).toBe(legacy.privateKeyPem);
  });

  it('⭐ 已加密的文件：读得回来（加密→解密闭环）', () => {
    const created = loadOrCreateDeviceIdentity();
    const raw = read(IDENTITY_FILE);
    expect(raw).toContain('enc:');

    const reloaded = loadOrCreateDeviceIdentity();

    expect(reloaded.deviceId).toBe(created.deviceId);
    expect(reloaded.privateKeyPem).toBe(created.privateKeyPem);
  });

  it('⭐ 旧明文文件（加固前落的那份）照样能读 —— 不能把已配对的设备弄丢', () => {
    const legacy = writeLegacyIdentityFile();

    const identity = loadOrCreateDeviceIdentity();

    expect(identity.deviceId).toBe(legacy.deviceId);
    expect(identity.privateKeyPem).toBe(legacy.privateKeyPem);
  });

  it('加密不可用（受限环境）⇒ 退回明文，但**功能不坏**', () => {
    mocks.encryptionAvailable = false;

    const identity = loadOrCreateDeviceIdentity();

    expect(identity.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(loadOrCreateDeviceIdentity().deviceId).toBe(identity.deviceId);
  });

  it('加密不可用时**读得懂**别人加密过的文件吗：读不懂就重新生成，不许抛', () => {
    loadOrCreateDeviceIdentity();
    const encrypted = read(IDENTITY_FILE);
    expect(encrypted).toContain('enc:');

    mocks.encryptionAvailable = false;

    expect(() => loadOrCreateDeviceIdentity()).not.toThrow();
  });
});

/**
 * 🔴 2026-09-28 真机：**密文解得开、解出来的却不是钥匙** ⇒ 主进程未捕获异常弹框。
 *
 * 真机形状（换机器 / 换 Windows 账户 ⇒ DPAPI 结出来的不是原来那把钥匙）：
 * `decryptSecret` 返回一个**非 null 的字符串**，`loadOrCreateDeviceIdentity` 只判
 * "非空"就把它当身份交出去；等到连网关 `handleChallenge` 才用
 * `crypto.createPrivateKey` 去解析它 ⇒ `BAD_DECRYPT` ⇒ **整个主进程弹框、握手走不完**。
 *
 * 那段代码的注释写着"设备身份丢了要重新配对，但**绝不能因此让应用起不来**"——
 * 这一组用例就是让那句话成立：**交出去的私钥必须是能解析的，否则宁可重新生成。**
 */
describe('device-identity.json —— 解出来的东西必须是能用的私钥', () => {
  /** 造一份"解密成功、但内容不是私钥"的文件（真机上换机器后就是这形状）。 */
  function writeGarbageKeyFile(): void {
    const created = loadOrCreateDeviceIdentity();
    const garbage = `enc:${Buffer.from('ENC(not-a-private-key)').toString('base64')}`;
    writeFileSync(
      join(dir, IDENTITY_FILE),
      `${JSON.stringify(
        {
          version: 1,
          deviceId: created.deviceId,
          publicKeyPem: created.publicKeyPem,
          privateKeyPem: garbage,
          createdAtMs: 1_700_000_000_000,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    // 前置条件：这份文件**解得开**（否则测的是另一条分支，红得跟这件事无关）
    expect(read(IDENTITY_FILE), '夹具必须是"能解密"的那一种').toContain('enc:');
  }

  it('⭐ 交出来的私钥必须能解析 —— 不是"解出来非空"就算数', () => {
    writeGarbageKeyFile();

    const identity = loadOrCreateDeviceIdentity();

    expect(identity.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(
      () => createPrivateKey(identity.privateKeyPem),
      '把不可用的私钥交出去 ⇒ 连网关时 createPrivateKey 抛 BAD_DECRYPT ⇒ 主进程弹框',
    ).not.toThrow();
  });

  it('⭐ 坏值不许留在盘上（否则下次启动再崩一次）', () => {
    writeGarbageKeyFile();

    loadOrCreateDeviceIdentity();

    const reloaded = loadOrCreateDeviceIdentity();
    expect(() => createPrivateKey(reloaded.privateKeyPem), '第二次读也必须能用').not.toThrow();
  });

  it('⭐ 坏的那份不能继续冒充这台设备（要换一把新钥匙）', () => {
    writeGarbageKeyFile();
    const before = read(IDENTITY_FILE);

    const identity = loadOrCreateDeviceIdentity();

    expect(read(IDENTITY_FILE), '盘上那份必须被换掉').not.toBe(before);
    expect(() => createPrivateKey(identity.privateKeyPem)).not.toThrow();
  });
});

describe('device-tokens.json —— operator token 不落明文', () => {
  it('⭐ 写下去的文件里搜不到 token 原文，读回来还是它', () => {
    saveDeviceToken('gw-1', 'SUPER-SECRET-OP-TOKEN', 'operator', 1_700_000_000_000);

    const raw = read(TOKENS_FILE);
    expect(raw, 'token 原文不许出现在文件里').not.toContain('SUPER-SECRET-OP-TOKEN');
    expect(raw, '落盘的是密文').toContain('enc:');

    expect(loadDeviceToken('gw-1')).toBe('SUPER-SECRET-OP-TOKEN');
  });

  it('⭐ 旧明文 store 照样能读（老用户不用重新配对）', () => {
    writeFileSync(join(dir, TOKENS_FILE), legacyTokensJson(), 'utf8');

    expect(loadDeviceToken('gw-legacy')).toBe('legacy-op-token');
  });

  it('⭐ 第二个网关的 token 落盘：前一个不受影响', () => {
    saveDeviceToken('gw-1', 'tok-1', 'operator', 1);
    saveDeviceToken('gw-2', 'tok-2', 'operator', 2);

    const raw = read(TOKENS_FILE);
    expect(raw).not.toContain('tok-1');
    expect(raw).not.toContain('tok-2');
    expect(loadDeviceToken('gw-1')).toBe('tok-1');
    expect(loadDeviceToken('gw-2')).toBe('tok-2');
  });

  it('没存过的网关 ⇒ null（不是抛）', () => {
    expect(loadDeviceToken('nope')).toBeNull();
  });

  it('加密不可用 ⇒ 退回明文，功能不坏', () => {
    mocks.encryptionAvailable = false;

    saveDeviceToken('gw-1', 'plain-token', 'operator', 1);

    expect(loadDeviceToken('gw-1')).toBe('plain-token');
  });
});
