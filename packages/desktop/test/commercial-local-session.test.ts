import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 本地快速态（B7）：**本地存着一个会话吗**。
 *
 * 它存在的唯一理由是**不发网络** —— 会话检查（`getUser()`）要发网络、主进程给它 8 秒，
 * 而界面那边 5 秒的兜底比它短，于是慢网时已登录的用户会被扔进登录页。
 *
 * ⇒ 所以这一组用例盯的**不是**"能不能读出 token"，而是"它**是不是**一条纯本地路径"：
 *   同步签名（同步函数不可能 await 过一次网络）、不依赖商业客户端、每次都真读文件。
 *
 * ⚠️ 形状是**实测**来的，不是猜的：我们没设 `userStorage`，supabase-js 的
 *    `_saveSession` 就把 session 对象**原样**存进来（`access_token` 是顶层键）。
 */

const mocks = vi.hoisted(() => ({
  userDataDir: '',
  encryptionAvailable: false,
}));

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => mocks.encryptionAvailable,
    // 真加密在单测里不可用 ⇒ 用一段可逆的假变换，只要能证明"走的是解密那条路"
    encryptString: (s: string) => Buffer.from(`ENC(${s})`, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^ENC\(|\)$/g, ''),
  },
}));

const { hasLocalSession, resetCommercialClient } = await import('../src/main/commercial/client.js');

const SESSION_FILE = 'commercial-session.json';
/** 真实形状的**最小**样本：跟 `_saveSession` 存下去的是同一个对象。 */
const REAL_SHAPE = JSON.stringify({
  access_token: 'eyJhbGciOi…',
  refresh_token: 'v1.abc',
  expires_at: 1_800_000_000,
  token_type: 'bearer',
  user: { id: 'u-1', email: 'a@b.c' },
});

let dir: string;

function sessionPath(): string {
  return join(dir, SESSION_FILE);
}

function writeSession(payload: string): void {
  writeFileSync(sessionPath(), payload, 'utf8');
}

beforeEach(() => {
  resetCommercialClient();
  dir = mkdtempSync(join(tmpdir(), 'clawwork-local-session-'));
  mocks.userDataDir = dir;
  mocks.encryptionAvailable = false;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('hasLocalSession —— 本地快速态', () => {
  it('本地存着一个会话 ⇒ true', () => {
    writeSession(REAL_SHAPE);
    expect(hasLocalSession()).toBe(true);
  });

  it('没有会话文件 ⇒ false', () => {
    expect(hasLocalSession()).toBe(false);
  });

  it('文件在但内容不是合法 JSON ⇒ false（不抛）', () => {
    writeSession('{ 这不是 json');
    expect(hasLocalSession()).toBe(false);
  });

  it('JSON 合法但没有 token ⇒ false（空的 `{}` 不算"存着会话"）', () => {
    writeSession('{}');
    expect(hasLocalSession()).toBe(false);
  });

  it('`access_token` 是空串 ⇒ false（登出后残留的空壳不算数）', () => {
    writeSession(JSON.stringify({ access_token: '', refresh_token: 'v1.abc' }));
    expect(hasLocalSession()).toBe(false);
  });

  it('⭐ 它是**同步**的 —— 同步函数不可能 await 过一次网络，这就是"不发网络"的保证', () => {
    writeSession(REAL_SHAPE);
    const value: boolean = hasLocalSession();
    expect(typeof value).toBe('boolean');
    // 直接断言"不是 thenable"：哪天有人把它改成 async，这条会红
    expect((value as unknown as { then?: unknown }).then).toBeUndefined();
  });

  it('⭐ **不依赖商业客户端**：凭据缺失（建不出客户端）时照样读得出', async () => {
    // 把配置与默认凭据一起做掉：`getCommercialClient()` 会返回 null，
    // 若这个函数偷偷走了客户端，这里就会是 false。
    const { readConfig } = await import('../src/main/workspace/config.js');
    expect(readConfig()).toBeNull();

    writeSession(REAL_SHAPE);
    expect(hasLocalSession()).toBe(true);
  });

  it('每次都**重读文件**（登出删文件后立刻变 false，没有缓存）', () => {
    writeSession(REAL_SHAPE);
    expect(hasLocalSession()).toBe(true);

    unlinkSync(sessionPath());
    expect(hasLocalSession()).toBe(false);
  });

  it('加密存储可用时走**解密**那条路（不是"看不懂就当没有"）', () => {
    mocks.encryptionAvailable = true;
    writeSession('enc:' + Buffer.from(`ENC(${REAL_SHAPE})`, 'utf8').toString('base64'));

    expect(hasLocalSession()).toBe(true);
  });

  it('⚠️ 加密存储**不可用**时读不出密文 ⇒ 按缺席处理（宁可回到今天的行为）', () => {
    mocks.encryptionAvailable = true;
    writeSession('enc:' + Buffer.from(`ENC(${REAL_SHAPE})`, 'utf8').toString('base64'));

    mocks.encryptionAvailable = false;
    // 换进程/换用户后解不开密文 —— 不能凭"读不到"去拖延登录页
    expect(hasLocalSession()).toBe(false);
  });
});
