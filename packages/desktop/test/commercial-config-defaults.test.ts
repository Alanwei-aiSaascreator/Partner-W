import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_FILE_NAME } from '@clawwork/shared';

/**
 * 私有化 / 开源版（2026-10）：干净机器上 `commercial:get-config` 必须报"未配置"。
 *
 * 渲染层进不进登录页**只看这一个 IPC 的返回**（`App.tsx`）：
 *
 *   configured = config.ok && config.result.supabaseUrl && config.result.hasAnonKey
 *   configured === false ⇒ 直接进本地模式（无登录页）—— 开源客户端的默认态
 *
 * 开源版默认凭据清空，`resolveCommercialCredentials` 无配置时返回空；
 * 用户显式在 `commercial` 段填了 url/key 才走商业登录。
 *
 * ⚠️ 用真实临时目录、真写 `clawwork-config.json`：`readConfig()` 读的是磁盘。
 */

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  userDataDir: '',
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, fn);
    },
  },
  app: { getPath: () => mocks.userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => '',
  },
}));

// 与 commercial-handlers.test.ts 同一套 mock：这里只关心 get-config，
// 别的 handler 依赖的子模块不接真身（接真身会去连 Supabase）。
vi.mock('../src/main/commercial/auth.js', () => ({
  sendLoginOtp: vi.fn(),
  verifyLoginOtp: vi.fn(),
  signInWithPassword: vi.fn(),
  signOutCommercial: vi.fn(),
  readSessionState: vi.fn(),
  readAccountOverview: vi.fn(),
}));
vi.mock('../src/main/commercial/client.js', () => ({
  clearCommercialSession: vi.fn(),
  resetCommercialClient: vi.fn(),
  // payment.ts 会 import 它；这里用不到，但少一个导出的话，
  // 将来在这个文件里调任何支付 handler 都会炸在"mock 没定义"上。
  getCommercialClient: vi.fn(),
}));
vi.mock('../src/main/commercial/relay-cleanup.js', () => ({
  buildCommercialAccessCleanupDeps: () => ({}),
  requestCommercialAccessCleanup: vi.fn(),
}));
vi.mock('../src/main/commercial/relay-startup.js', () => ({
  notifyCommercialSignedIn: vi.fn(),
  notifyCommercialActivated: vi.fn(),
}));
vi.mock('../src/main/commercial/license.js', () => ({
  activateLicense: vi.fn(),
  clearLicense: vi.fn(),
  deviceFingerprint: () => 'fp-test',
  readLicenseStatus: vi.fn(),
}));

const { registerCommercialHandlers } = await import('../src/main/ipc/commercial-handlers.js');

interface GetConfigResult {
  supabaseUrl: string;
  hasAnonKey: boolean;
  licenseKey: string;
}

function writeConfigFile(commercial: Record<string, unknown> | undefined): void {
  writeFileSync(
    join(mocks.userDataDir, CONFIG_FILE_NAME),
    JSON.stringify({ workspacePath: 'C:\\ws', gateways: [], ...(commercial ? { commercial } : {}) }),
    'utf8',
  );
}

async function getConfig(): Promise<GetConfigResult> {
  const handler = mocks.handlers.get('commercial:get-config');
  if (!handler) throw new Error('commercial:get-config 没注册');
  const res = (await handler({})) as { ok: boolean; result: GetConfigResult };
  expect(res.ok).toBe(true);
  return res.result;
}

/** 渲染层那句 `Boolean(supabaseUrl && hasAnonKey)` 的镜像 —— 它决定有没有登录页。 */
function looksConfiguredToRenderer(result: GetConfigResult): boolean {
  return Boolean(result.supabaseUrl && result.hasAnonKey);
}

let dir: string;

beforeEach(() => {
  mocks.handlers.clear();
  dir = mkdtempSync(join(tmpdir(), 'clawwork-commercial-config-'));
  mocks.userDataDir = dir;
  registerCommercialHandlers();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('commercial:get-config 的本地模式判定', () => {
  it('⭐ 干净机器（连配置文件都还没有）⇒ 渲染层判定"未配置"、进本地模式', async () => {
    const result = await getConfig();

    expect(result.supabaseUrl).toBe('');
    expect(result.hasAnonKey).toBe(false);
    expect(looksConfiguredToRenderer(result), '开源版默认无登录页').toBe(false);
  });

  it('⭐ 配置文件在、但商业段是空串（老 profile / 被清过）⇒ 同样未配置（本地模式）', async () => {
    writeConfigFile({ supabaseUrl: '', supabaseAnonKey: '' });

    const result = await getConfig();

    expect(result.supabaseUrl).toBe('');
    expect(result.hasAnonKey).toBe(false);
    expect(looksConfiguredToRenderer(result)).toBe(false);
  });

  it('用户/测试自己填了值 ⇒ 用户的值优先（默认值只是兜底，不覆盖配置）', async () => {
    writeConfigFile({
      supabaseUrl: 'https://my-project.supabase.co',
      supabaseAnonKey: 'my-key',
      licenseKey: 'RY-AAAA-BBBB',
    });

    const result = await getConfig();

    expect(result.supabaseUrl).toBe('https://my-project.supabase.co');
    expect(result.hasAnonKey).toBe(true);
    expect(result.licenseKey).toBe('RY-AAAA-BBBB');
  });
});

/**
 * `commercial:set-config` 的空值语义：**空串 = 不改动**。
 *
 * 这条 IPC 是"半配置"唯一的可能来源（产品里没有调用方，但它是唯一会**写**这两个
 * 字段的入口）：一旦空串能把 url 清掉、却又清不掉 key（原实现 url 用 `??`、
 * key 用 `||`），就会落进"用户 URL + 生产 key"这种必坏、且报错读不出原因的
 * 组合里 —— 与刚修的 P0 是同一类症状。
 */
describe('commercial:set-config 的空值语义', () => {
  async function setConfig(payload: { supabaseUrl?: string; supabaseAnonKey?: string }): Promise<void> {
    const handler = mocks.handlers.get('commercial:set-config');
    if (!handler) throw new Error('commercial:set-config 没注册');
    const res = (await handler({}, payload)) as { ok: boolean };
    expect(res.ok).toBe(true);
  }

  it('⭐ 传空串 ⇒ 一个字都不改（不许把已配置的 url 清成空串）', async () => {
    writeConfigFile({ supabaseUrl: 'https://my-project.supabase.co', supabaseAnonKey: 'my-key' });

    await setConfig({ supabaseUrl: '', supabaseAnonKey: '' });

    const result = await getConfig();
    expect(result.supabaseUrl).toBe('https://my-project.supabase.co');
    expect(result.hasAnonKey).toBe(true);
  });

  it('非空值照常写入（也能拿它指到别的项目）', async () => {
    writeConfigFile({ supabaseUrl: 'https://old-project.supabase.co', supabaseAnonKey: 'old-key' });

    await setConfig({ supabaseUrl: 'https://new-project.supabase.co', supabaseAnonKey: 'new-key' });

    const result = await getConfig();
    expect(result.supabaseUrl).toBe('https://new-project.supabase.co');
    expect(result.hasAnonKey).toBe(true);
  });
});
