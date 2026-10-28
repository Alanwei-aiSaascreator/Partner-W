/**
 * Owner C / T16 —— 商业会话**解不开时先保留**（RED→GREEN）。
 *
 * 合同依据：本轮 T16 硬红线「旧密文与身份**先保留**；**解不开不得无备份地删除**凭据」。
 *
 * ## 缺陷（修前）
 *
 * `commercial/client.ts` 的 `readSecure()` 在会话文件是 `enc:` 密文而当前作用域
 * **解不开**（换 Windows 用户 / 换机器 ⇒ DPAPI 作用域变了）时返回 `null`。
 * 之后只要发生一次会话写入（重新登录成功）或 `removeItem()`（登出 / 失败清理），
 * 旧密文就被**原地覆盖 / unlink** —— **无备份消失**。
 *
 * 后果：用户切到别的 Windows 账户再切回来时，本来解得开的那份会话已经没了，
 * 只能重新登录；而且没有任何现场可查。
 *
 * ## 修法
 *
 * 会话文件是 `enc:` 且当前解不开 ⇒ 写入/删除之前先**改名留档**
 * （`commercial-session.json.superseded-<ts>`，原始字节不丢）。
 * 解得开的正常会话不产生留档（登出是用户意图，不留噪音）。
 *
 * ## 这里驱动的是什么
 *
 * `createCommercialSessionStorage()` 就是交给 supabase-js `auth.storage` 的**同一个**
 * 适配器对象（`getCommercialClient()` 里 `auth.storage` 用的就是它）—— 直接调它，
 * 不 mock supabase-js。
 *
 * ⚠️ **不**走 `client.auth.setSession()`：2.116 的 `_setSession` 要么刷新 token、
 *    要么调 `_getUser(access_token)`，**都需要网络**；而本机打包默认 supabaseUrl
 *    指向**生产** —— 这一轮绝不出网。适配器本身是纯本地落盘，这才是要验的那段。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
    // ⚠️ 假解密必须**严格**（与真实 DPAPI 同形）：只认自己写的 `ENC(...)` 包装，
    //    别的密文一律抛 —— 否则"解不开"的夹具会假通过（第一版就栽在这）。
    decryptString: (b: Buffer) => {
      const match = /^ENC\(([\s\S]*)\)$/u.exec(b.toString('utf8'));
      if (!match) throw new Error('BAD_DECRYPT');
      return match[1];
    },
  },
}));

const { createCommercialSessionStorage, resetCommercialClient, hasLocalSession } =
  await import('../src/main/commercial/client.js');

const SESSION_FILE = 'commercial-session.json';
const UNDECRYPTABLE = 'enc:bm90LWRlY3J5cHRhYmxlLXNlc3Npb24=';

let dir: string;

function sessionPath(): string {
  return join(dir, SESSION_FILE);
}

function read(name: string): string {
  return readFileSync(join(dir, name), 'utf8');
}

function backups(): string[] {
  return readdirSync(dir).filter((name) => name.startsWith(`${SESSION_FILE}.`));
}

beforeEach(() => {
  resetCommercialClient();
  dir = mkdtempSync(join(tmpdir(), 'owner-c-session-'));
  mocks.userDataDir = dir;
  mocks.encryptionAvailable = true;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('T16 · 商业会话解不开 ⇒ 先保留旧密文', () => {
  it('⭐ 前置：解不开的会话确实"读不出"（否则测的是另一条分支）', () => {
    writeFileSync(sessionPath(), UNDECRYPTABLE, 'utf8');

    expect(hasLocalSession()).toBe(false);
  });

  it('⭐ 重新登录写会话之前：旧密文先留档，不许原地覆盖', () => {
    writeFileSync(sessionPath(), UNDECRYPTABLE, 'utf8');

    createCommercialSessionStorage().setItem('sb-auth-token', JSON.stringify({ access_token: 'new' }));

    expect(read(SESSION_FILE), '活文件应已是新会话').not.toBe(UNDECRYPTABLE);
    const kept = backups().some((name) => read(name) === UNDECRYPTABLE);
    expect(kept, '旧密文必须留一份原样备份（红线：解不开不得无备份删除）').toBe(true);
  });

  it('⭐ 清会话（登出/失败清理）之前：解不开的旧密文同样先留档', () => {
    writeFileSync(sessionPath(), UNDECRYPTABLE, 'utf8');

    createCommercialSessionStorage().removeItem('sb-auth-token');

    expect(existsSync(sessionPath()), '活会话应已清掉（登出语义不变）').toBe(false);
    const kept = backups().some((name) => read(name) === UNDECRYPTABLE);
    expect(kept, '清会话也不能把解不开的密文无备份删掉').toBe(true);
  });

  it('对照（不产生噪音）：解得开的会话被正常覆盖时不留档', () => {
    const storage = createCommercialSessionStorage();
    storage.setItem('k', JSON.stringify({ access_token: 'a1' }));
    storage.setItem('k', JSON.stringify({ access_token: 'a2' }));

    expect(backups(), '可解开的会话是用户自己的东西，登出/刷新不该塞一堆备份').toHaveLength(0);
  });

  it('对照：加密不可用而文件是明文 ⇒ 不当成"解不开"（既有降级行为不变）', () => {
    mocks.encryptionAvailable = false;
    writeFileSync(sessionPath(), JSON.stringify({ access_token: 'plain' }), 'utf8');

    expect(hasLocalSession()).toBe(true);
    expect(existsSync(sessionPath())).toBe(true);
  });
});
