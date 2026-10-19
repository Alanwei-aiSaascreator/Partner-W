/**
 * BUG-133：**换账号不重投影记忆** ⇒ `MEMORY.md` 跨账号残留。
 *
 * ## 复现（红）
 *
 * `MEMORY.md` 是**随盘共享文件、运行时每轮全文注入**。重投影只在「启动 / 运行时重试 /
 * 设置页改动 / 每轮（>20 条时）」发生 —— **sign-in / sign-out 不触发重投影**。
 * 于是 A 账号投过影之后，应用内登出/换到 B、且 B 的已确认条目 ≤20（常态）时，
 * 助手下一轮**仍读到 A 的已确认记忆**。
 *
 * ## 这条用例的落点
 *
 * 走**真的 handler + 真的记忆链（真 SQLite → 假网关）**，只钉一件事：
 * **账户边界（登出 / 换账号激活）走过之后，下一轮读到的受管区块里不得含上一账号的条目。**
 *
 * 与 `memory-sync-account.test.ts` 的分工（互补，不是重复）：
 *   · 那里证明「**调用 sync 时**机制正确」（只 confirmed 进文件、按 owner 过滤…）；
 *   · 这里证明「**该调用的时刻真的调了**」—— 那个缺口正是 BUG-133。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryBlockEntryLines } from '@clawwork/core';
import {
  createAnalyticsReporter,
  initAnalyticsReporterForTest,
  stopAnalyticsReporter,
} from '../src/main/analytics/reporter.js';

vi.mock('better-sqlite3', async () => ({
  default: (await import('./helpers/node-sqlite-shim.js')).NodeSqliteShim,
}));

/** IPC handler 捕获 + 可控的"当前账号" + 假网关（内存文件表）。 */
const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const owner = { id: '' };
  const files: Record<string, string> = {};
  const gateway = { value: null as null | Record<string, unknown> };
  return {
    handlers,
    owner,
    files,
    gateway,
    verifyLoginOtp: vi.fn(),
    signInWithPassword: vi.fn(),
    signOutCommercial: vi.fn(),
    clearLicense: vi.fn(),
    activateLicense: vi.fn(),
    recoverLicenseActivation: vi.fn(),
    requestCommercialAccessCleanup: vi.fn(),
    clearCommercialSession: vi.fn(),
    notifyCommercialSignedIn: vi.fn(),
    notifyCommercialActivated: vi.fn(),
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, fn);
    },
  },
  app: { getPath: () => 'C:\\clawwork-test-no-such-dir' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => '',
  },
}));

vi.mock('../src/main/commercial/auth.js', () => ({
  verifyLoginOtp: (...a: unknown[]) => mocks.verifyLoginOtp(...a),
  signInWithPassword: (...a: unknown[]) => mocks.signInWithPassword(...a),
  sendLoginOtp: vi.fn(),
  signOutCommercial: (...a: unknown[]) => mocks.signOutCommercial(...a),
  readSessionState: vi.fn(),
  readAccountOverview: vi.fn(),
}));

vi.mock('../src/main/commercial/client.js', () => ({
  clearCommercialSession: () => mocks.clearCommercialSession(),
  resetCommercialClient: vi.fn(),
  hasLocalSession: vi.fn(),
}));

vi.mock('../src/main/commercial/license.js', () => ({
  activateLicense: (...a: unknown[]) => mocks.activateLicense(...a),
  recoverLicenseActivation: (...a: unknown[]) => mocks.recoverLicenseActivation(...a),
  clearLicense: () => mocks.clearLicense(),
  deviceFingerprint: () => 'fp-test',
  readLicenseStatus: vi.fn(),
}));

vi.mock('../src/main/commercial/relay-cleanup.js', () => ({
  buildCommercialAccessCleanupDeps: () => ({}),
  requestCommercialAccessCleanup: () => mocks.requestCommercialAccessCleanup(),
  drainPendingCommercialAccessCleanup: vi.fn(),
}));

vi.mock('../src/main/commercial/relay-startup.js', () => ({
  notifyCommercialSignedIn: () => mocks.notifyCommercialSignedIn(),
  notifyCommercialActivated: () => mocks.notifyCommercialActivated(),
  retryCommercialRelayBootstrap: vi.fn(),
}));

// 「当前账号」可控 —— 记忆归属读的就是它（`memory/owner.ts`）。这里的测试只关心
// 「归属变了之后，投影有没有跟着走」，所以直接控这个出口，不重建一套 config。
vi.mock('../src/main/memory/owner.js', () => ({
  currentMemoryOwnerId: () => mocks.owner.id,
}));

// 假网关：`account-switch` 通过 `getGatewayClient(LOCAL_GATEWAY_ID)` 拿它。
vi.mock('../src/main/ws/index.js', () => ({
  getGatewayClient: () => mocks.gateway.value,
  getAllGatewayClients: () => new Map(),
}));

const { registerCommercialHandlers } = await import('../src/main/ipc/commercial-handlers.js');
const { closeDatabase, getSqlite, initDatabase } = await import('../src/main/db/index.js');
const { createMemoryStore } = await import('../src/main/memory/store.js');
const { syncMemoryToAgents } = await import('../src/main/memory/sync.js');

const OWNER_A = 'user-a';
const OWNER_B = 'user-b';
const AGENTS = ['main'];

/** 假网关：`MemorySyncGateway` 形状（listAgents / getAgentFile / setAgentFile）。 */
function installFakeGateway(): void {
  mocks.gateway.value = {
    isConnected: true,
    async listAgents() {
      return { agents: AGENTS.map((id) => ({ id })) };
    },
    async getAgentFile(agentId: string) {
      return {
        file: { name: 'MEMORY.md', content: mocks.files[agentId] ?? '', missing: mocks.files[agentId] === undefined },
      };
    },
    async setAgentFile(agentId: string, _name: string, content: string) {
      mocks.files[agentId] = content;
      return { ok: true };
    },
  };
}

function handlerFor(channel: string): (...args: unknown[]) => unknown {
  const fn = mocks.handlers.get(channel);
  if (!fn) throw new Error(`没注册 ${channel}；已注册：${[...mocks.handlers.keys()].join(', ')}`);
  return fn;
}

function store() {
  const sqlite = getSqlite();
  if (!sqlite) throw new Error('库没打开');
  return createMemoryStore(sqlite);
}

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memory-account-boundary-'));
  initDatabase(dir);
  initAnalyticsReporterForTest(
    createAnalyticsReporter({
      storage: { read: () => null, write: () => {} },
      send: vi.fn(async () => ({ ok: true, inserted: 0 })),
    }),
  );

  mocks.handlers.clear();
  for (const key of Object.keys(mocks.files)) delete mocks.files[key];
  mocks.owner.id = '';
  mocks.verifyLoginOtp.mockReset();
  mocks.signInWithPassword.mockReset();
  mocks.signOutCommercial.mockReset();
  mocks.clearLicense.mockReset();
  mocks.activateLicense.mockReset();
  mocks.recoverLicenseActivation.mockReset();
  mocks.requestCommercialAccessCleanup.mockReset();
  mocks.clearCommercialSession.mockReset();
  mocks.notifyCommercialSignedIn.mockReset();
  mocks.notifyCommercialActivated.mockReset();

  mocks.requestCommercialAccessCleanup.mockResolvedValue({ cleaned: true, pending: false });
  mocks.signOutCommercial.mockResolvedValue({ ok: true });
  mocks.activateLicense.mockResolvedValue({ ok: true, result: { activated: true } });
  mocks.recoverLicenseActivation.mockResolvedValue({ ok: true, result: { activated: true } });

  installFakeGateway();
  registerCommercialHandlers();
});

afterEach(() => {
  stopAnalyticsReporter();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

describe('BUG-133：账户边界后 MEMORY.md 必须跟着重投影', () => {
  it('⭐⭐ 换账号：登出后受管区块不得再含上一账号的条目；换到 B 后只剩 B 那批', async () => {
    const db = store();
    db.create({ ownerUserId: OWNER_A, text: 'A 的偏好：结论先行。', source: 'user' });
    db.create({ ownerUserId: OWNER_B, text: 'B 的偏好：先看数据。', source: 'user' });

    // A 已登录并已投影（会话进行中的既有投影）。
    mocks.owner.id = OWNER_A;
    await syncMemoryToAgents({ gateway: mocks.gateway.value as never });
    expect(memoryBlockEntryLines(mocks.files['main'])).toEqual(['A 的偏好：结论先行。']);

    // 应用内登出：handler 里 clearLicense ⇒ 归属变匿名。
    mocks.owner.id = '';
    await handlerFor('commercial:sign-out')({});

    // ⭐ 下一轮助手读到的受管区块里不得含 A 的条目。
    expect(memoryBlockEntryLines(mocks.files['main'])).toEqual([]);
    expect(mocks.files['main']).not.toContain('A 的偏好');

    // B 登录并激活自己的卡 ⇒ 投影 B 自己的那批。
    mocks.owner.id = OWNER_B;
    await handlerFor('commercial:license-activate')({}, 'CARD-B');

    expect(memoryBlockEntryLines(mocks.files['main'])).toEqual(['B 的偏好：先看数据。']);
    expect(mocks.files['main']).not.toContain('A 的偏好');
  });

  it('⭐ 直接换账号登录（不先登出）：登录那一刻也把上一账号的条目清掉', async () => {
    const db = store();
    db.create({ ownerUserId: OWNER_A, text: 'A 的一条记忆', source: 'user' });

    mocks.owner.id = OWNER_A;
    await syncMemoryToAgents({ gateway: mocks.gateway.value as never });
    expect(mocks.files['main']).toContain('A 的一条记忆');

    // 登录成功那一刻 owner 已被 clearLicense 抹成匿名（见 commercial-handlers 的登录分支）。
    mocks.owner.id = '';
    mocks.verifyLoginOtp.mockResolvedValue({ ok: true, result: { userId: 'u-b' } });
    await handlerFor('commercial:verify-otp')({}, '+8613800000000', '123456');

    expect(mocks.files['main']).not.toContain('A 的一条记忆');
  });

  it('★ 边界重投影是幂等的：归属没变、内容一致 ⇒ 一次网关闭写都不发', async () => {
    const db = store();
    db.create({ ownerUserId: OWNER_A, text: '稳定的一条', source: 'user' });
    mocks.owner.id = OWNER_A;
    await syncMemoryToAgents({ gateway: mocks.gateway.value as never });

    let writes = 0;
    const gw = mocks.gateway.value as { setAgentFile: (...a: unknown[]) => Promise<unknown> };
    const original = gw.setAgentFile;
    gw.setAgentFile = async (...a: unknown[]) => {
      writes += 1;
      return original(...a);
    };

    // 走一次账户边界，但归属仍是 A（本用例刻意不让 owner 变）—— 重投影必须幂等：
    // 受管区块内容已经一致 ⇒ 不该产生任何多余写入（网关往返浪费）。
    await handlerFor('commercial:sign-out')({});
    expect(writes).toBe(0);
  });
});
