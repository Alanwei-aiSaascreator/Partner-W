import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_FILE_NAME } from '@clawwork/shared';

/**
 * 私有化 / 开源版（2026-10）：干净机器上 `getCommercialClient()` 返回 null。
 *
 * 开源版默认凭据清空 ⇒ 商业客户端不建立 ⇒ 登录 / 激活 / 用量上报整条链
 * 都不发网络（本地模式）。用户显式在 `commercial` 段填了 url/key 才建客户端。
 *
 * ⚠️ 这里刻意**不 mock** `client.js`：要钉的就是"凭据为空 ⇒ 返回 null"这个契约。
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

describe('getCommercialClient 的本地模式行为', () => {
  it('⭐ 干净机器（没有配置文件）⇒ 返回 null（本地模式，不发网络）', () => {
    const client = getCommercialClient();

    expect(client, '私有化版凭据为空 ⇒ 商业客户端不建立').toBeNull();
  });

  it('配置里有值 ⇒ 用配置里的（用户显式接回商业后端时仍可用）', () => {
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
