/**
 * Owner C / T16 —— 凭据**解不开时先保留**（RED→GREEN）。
 *
 * 合同依据：`2026-10-15-portable-first-start-contract.md` §2「换 Windows 用户」
 * 与本轮 T16 的硬红线：
 *
 *   > 旧密文与身份**先保留**，正常重新认证后自动重连。
 *   > **解不开不得无备份地删除**凭据。
 *
 * ## 缺陷（修前）
 *
 * `ws/device-identity.ts` 的 `loadOrCreateDeviceIdentity` 在身份**解不开**
 * （换机器 / 换 Windows 用户 ⇒ DPAPI 作用域变了；或密文坏掉）时：
 *
 *   ① 直接 `generateIdentity()` + `writeIdentityFile()` —— 把旧密文**原地覆盖**掉；
 *   ② 分支入口先 `clearDeviceTokens()` —— 把 `device-tokens.json` 写成空 store，
 *      旧 token 密文同样**无备份消失**。
 *
 * 后果：W1 → W2 时把 W1 的身份与配对全部毁掉；等用户切回 **W1**（T05 场景），
 * W1 本来解得开的那份密文已经不在了 ⇒ 只能重新配对，历史配对白丢。这与
 * "先保留"直接冲突。
 *
 * ## 修法
 *
 * 解不开 ⇒ 把旧文件**改名保留**（`<file>.undecryptable-<ts>`，原始字节不丢，
 * 与 `quarantineUnusableLocks` / 工作区标记损坏同一条纪律），再落新身份 / 清空
 * 在线 store。**活路径语义不变**（新身份 + 旧配对不参与本次握手）。
 *
 * ⚠️ 只在 mkdtemp 里建删文件，绝不触碰真实 `%APPDATA%`。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'owner-c-credential-'));
  mocks.userDataDir = dir;
  mocks.encryptionAvailable = true;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function read(name: string): string {
  return readFileSync(join(dir, name), 'utf8');
}

function preservedBackups(prefix: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith(prefix));
}

/** 把身份文件写成"密文解不开"的形状（真机上换机器 / 换 Windows 用户就是这个）。 */
function writeUndecryptableIdentity(): string {
  const raw = `${JSON.stringify(
    {
      version: 1,
      deviceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      publicKeyPem: '-----BEGIN PUBLIC KEY-----\nwhatever\n-----END PUBLIC KEY-----\n',
      privateKeyPem: 'enc:bm90LWEtcmVhbC1jaXBoZXJ0ZXh0',
      createdAtMs: 1_700_000_000_000,
    },
    null,
    2,
  )}\n`;
  writeFileSync(join(dir, IDENTITY_FILE), raw, 'utf8');
  return raw;
}

describe('T16 · 设备身份解不开 ⇒ 先保留旧密文', () => {
  it('⭐ 环境变化（密文解不开）：轮换后旧身份文件必须留一份原样备份', () => {
    const original = writeUndecryptableIdentity();

    loadOrCreateDeviceIdentity();

    const backups = preservedBackups(`${IDENTITY_FILE}.undecryptable-`).concat(
      preservedBackups(`${IDENTITY_FILE}.`).filter((n) => n !== IDENTITY_FILE),
    );
    expect(backups.length, '旧身份密文不许无备份消失').toBeGreaterThan(0);
    const kept = readdirSync(dir).some((name) => name.startsWith(`${IDENTITY_FILE}.`) && read(name) === original);
    expect(kept, '备份必须是解不开前那份原始字节').toBe(true);
  });

  it('⭐ 加密不可用（换 Windows 用户）：同样保留旧身份密文', () => {
    const original = writeUndecryptableIdentity();
    mocks.encryptionAvailable = false;

    loadOrCreateDeviceIdentity();

    const kept = readdirSync(dir).some((name) => name.startsWith(`${IDENTITY_FILE}.`) && read(name) === original);
    expect(kept, '环境变化也是"解不开"，红线同样适用').toBe(true);
  });

  it('⭐ 身份轮换时旧**配对 token** 也要留备份，不是凭空清掉', () => {
    loadOrCreateDeviceIdentity();
    saveDeviceToken('gw-1', 'stale-token', 'operator', 1);
    const tokensBefore = read(TOKENS_FILE);
    expect(tokensBefore).toContain('enc:');

    // 把身份弄成解不开 ⇒ 下一次加载必然轮换
    writeUndecryptableIdentity();
    loadOrCreateDeviceIdentity();

    const kept = readdirSync(dir).some(
      (name) => name.startsWith(`${TOKENS_FILE}.`) && read(name) === tokensBefore,
    );
    expect(kept, '旧配对密文必须留备份（红线：解不开不得无备份删除）').toBe(true);
  });

  it('对照（活路径语义不变）：轮换后新身份可用，旧配对不参与本次握手', () => {
    loadOrCreateDeviceIdentity();
    saveDeviceToken('gw-1', 'stale-token', 'operator', 1);

    writeUndecryptableIdentity();
    const rotated = loadOrCreateDeviceIdentity();

    expect(rotated.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(loadDeviceToken('gw-1'), '活 store 里旧配对必须已清（新身份不能带旧配对握手）').toBeNull();
  });

  it('对照（无损坏不产生备份噪音）：正常读回不写任何 .undecryptable 备份', () => {
    loadOrCreateDeviceIdentity();
    loadOrCreateDeviceIdentity();
    loadOrCreateDeviceIdentity();

    expect(preservedBackups(`${IDENTITY_FILE}.`)).toHaveLength(0);
    expect(preservedBackups(`${TOKENS_FILE}.`)).toHaveLength(0);
  });
});
