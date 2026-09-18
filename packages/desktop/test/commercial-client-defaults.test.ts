import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONFIG_FILE_NAME,
  DEFAULT_COMMERCIAL_SUPABASE_ANON_KEY,
  DEFAULT_COMMERCIAL_SUPABASE_URL,
} from '@clawwork/shared';

/**
 * 🔴 P0 回归（2026-09-18）：干净机器上 `getCommercialClient()` 必须还能建出客户端。
 *
 * 这是同一条链的**后半截**：`commercial:get-config` 决定渲染层进不进登录页，
 * 而登录本身（验证码 / 密码 / 读会话 / 激活 / 用量上报）全都要走这个客户端。
 * 只修前半截的话，用户会看到一个"能显示、但一登录就报未配置"的登录页。
 *
 * ⚠️ 这里刻意**不 mock** `client.js`：要钉的就是它真建得出客户端。
 *    只 mock electron（userData 指到临时目录），配置从真实文件读。
 */

const mocks = vi.hoisted(() => ({ userDataDir: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => '',
  },
}));

const { getCommercialClient, resetCommercialClient } = await import('../src/main/commercial/client.js');

/**
 * supabase-js 把 `supabaseUrl` / `supabaseKey` 标成 `protected`（运行时是公开字段）。
 * 窄化读取是为了钉住"**解析后的凭据真的传进了 createClient**"——只断言非 null
 * 的话，把默认值硬编码进 client.ts、无视用户配置也能蒙混过关。
 */
function clientTarget(client: unknown): { supabaseUrl: string; supabaseKey: string } {
  return client as { supabaseUrl: string; supabaseKey: string };
}

let dir: string;

beforeEach(() => {
  resetCommercialClient();
  dir = mkdtempSync(join(tmpdir(), 'clawwork-commercial-client-'));
  mocks.userDataDir = dir;
});

afterEach(() => {
  resetCommercialClient();
  rmSync(dir, { recursive: true, force: true });
});

describe('getCommercialClient 的读取期兜底', () => {
  it('⭐ 干净机器（没有配置文件）⇒ 不再返回 null，用的是随包下发的生产凭据', () => {
    const client = getCommercialClient();

    expect(client, 'null ⇒ 登录/激活/用量上报全都会静默失败').not.toBeNull();
    expect(clientTarget(client).supabaseUrl).toBe(DEFAULT_COMMERCIAL_SUPABASE_URL);
    expect(clientTarget(client).supabaseKey).toBe(DEFAULT_COMMERCIAL_SUPABASE_ANON_KEY);
    // 建出来的得是真客户端，而不是个占位对象
    expect(typeof client?.auth.signInWithOtp).toBe('function');
  });

  it('配置里有值 ⇒ 用配置里的（默认值只是兜底，不覆盖已配置的部署）', () => {
    writeFileSync(
      join(dir, CONFIG_FILE_NAME),
      JSON.stringify({
        workspacePath: 'C:\\ws',
        gateways: [],
        commercial: { supabaseUrl: 'https://my-project.supabase.co', supabaseAnonKey: 'my-key' },
      }),
      'utf8',
    );

    const client = getCommercialClient();

    expect(client).not.toBeNull();
    expect(clientTarget(client).supabaseUrl).toBe('https://my-project.supabase.co');
    expect(clientTarget(client).supabaseKey).toBe('my-key');
  });
});
