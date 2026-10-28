import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FeishuFetchImpl,
  FeishuHttpResponse,
  PollFeishuRegistrationResult,
} from '../src/main/connectors/feishu-registration.js';
import { DEPLOYMENT_SCHEMA_VERSION } from '../src/main/runtime/manifest.js';

/**
 * 飞书连接器 IPC 面（2026-10-18）：
 *   开始扫码 / 查询扫码状态 / 取消 / 完整状态（含绑定与助手名单）/ 改绑定 / 解绑 / 开关通道。
 * 网关与网络全部注入 —— 不启动 Electron、不联网、不碰真的 openclaw.json。
 */

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, fn);
    },
  },
}));

const { registerConnectorHandlers, feishuAgentChoices } = await import('../src/main/ipc/connector-handlers.js');

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(target: Json, patch: Json): Json {
  const next: Json = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (isRecord(value)) {
      const base = isRecord(next[key]) ? (next[key] as Json) : {};
      next[key] = deepMerge(base, value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

function createFakeGateway(
  initial: Json,
  agents: unknown = {
    agents: [
      { id: 'main', name: '主罗盘' },
      { id: 'writer', name: '创作师' },
    ],
  },
) {
  let config = structuredClone(initial);
  let hash = 'hash-1';
  let version = 1;
  const gateway = {
    async getConfig(): Promise<unknown> {
      return { hash, config: structuredClone(config) };
    },
    async patchConfig(params: { baseHash: string; raw: string }): Promise<unknown> {
      if (params.baseHash !== hash) throw new Error('config changed since last load');
      config = deepMerge(config, JSON.parse(params.raw) as Json);
      version += 1;
      hash = `hash-${version}`;
      return { ok: true };
    },
    async listAgents(): Promise<unknown> {
      return agents;
    },
  };
  return {
    gateway,
    get config(): Json {
      return structuredClone(config);
    },
  };
}

function reply(body: unknown): FeishuHttpResponse {
  return { ok: true, status: 200, json: async () => body };
}

function beginScript(): FeishuFetchImpl {
  const script = [
    { supported_auth_methods: ['client_secret'] },
    {
      device_code: 'dev-1',
      verification_uri_complete: 'https://accounts.feishu.cn/qr?code=x',
      user_code: 'CODE-1',
      interval: 5,
      expire_in: 600,
    },
  ];
  let index = 0;
  return async () => reply(script[Math.min(index++, script.length - 1)]);
}

const STATUS_FEISHU = {
  id: 'feishu' as const,
  configured: true,
  appId: 'cli_x',
  enabled: true,
  pluginInstalled: true,
  runtimeReady: true,
};

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clawwork-connectors-ipc-'));
  mocks.handlers.clear();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function call<T = Json>(channel: string, payload?: unknown): Promise<T> {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error(`missing handler: ${channel}`);
  // 真实 IPC 签名是 `(event, payload)`；单测里 event 用 undefined 占位。
  return (await handler(undefined, payload)) as T;
}

async function waitForPhase(phase: string): Promise<{ phase: string; [key: string]: unknown }> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await call<{ ok: boolean; result: { phase: string } }>('connectors:feishu-registration-status');
    if (result.ok && result.result.phase === phase) return result.result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`registration never reached phase: ${phase}`);
}

describe('feishuAgentChoices', () => {
  it('id 必须非空；名字缺失显示 id；重复 id 去重；identity.name 兜底', () => {
    expect(
      feishuAgentChoices({
        agents: [
          { id: 'main', name: '主罗盘' },
          { id: 'main', name: 'dup' },
          { id: 'writer', identity: { name: '创作师' } },
          { id: 'x' },
          { id: '' },
          null,
        ],
      }),
    ).toEqual([
      { id: 'main', name: '主罗盘' },
      { id: 'writer', name: '创作师' },
      { id: 'x', name: 'x' },
    ]);
    expect(feishuAgentChoices(null)).toEqual([]);
  });
});

describe('connectors:feishu-state', () => {
  it('⭐ 网关可读 ⇒ 报当前绑定与助手名单', async () => {
    const fake = createFakeGateway({
      channels: { feishu: { enabled: false, appId: 'cli_x' } },
      bindings: [{ type: 'route', agentId: 'writer', match: { channel: 'feishu' } }],
    });
    registerConnectorHandlers({
      userDataDir: root,
      stateDir: join(root, 'state'),
      readStatus: () => ({ ...STATUS_FEISHU, enabled: true }),
      gateway: () => fake.gateway,
    });

    const result = await call<{ ok: boolean; result: { state: Json } }>('connectors:feishu-state');
    expect(result.ok).toBe(true);
    expect(result.result.state).toMatchObject({
      configured: true,
      appId: 'cli_x',
      enabled: false,
      boundAgentId: 'writer',
      agents: [
        { id: 'main', name: '主罗盘' },
        { id: 'writer', name: '创作师' },
      ],
    });
  });

  it('网关不可用 ⇒ 绑定退回盘上 openclaw.json，助手名单留空（不猜）', async () => {
    const stateDir = join(root, 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'openclaw.json'),
      JSON.stringify({ bindings: [{ type: 'route', agentId: 'main', match: { channel: 'feishu' } }] }),
      'utf8',
    );
    registerConnectorHandlers({
      userDataDir: root,
      stateDir,
      readStatus: () => STATUS_FEISHU,
      gateway: () => null,
    });

    const result = await call<{ ok: boolean; result: { state: Json } }>('connectors:feishu-state');
    expect(result.ok).toBe(true);
    expect(result.result.state['boundAgentId']).toBe('main');
    expect(result.result.state['agents']).toEqual([]);
  });
});

describe('扫码会话', () => {
  it('⭐ begin 返回二维码；轮询成功后写配置 + 自动绑 main，状态变 success', async () => {
    const fake = createFakeGateway({ gateway: { auth: { mode: 'token', token: 't' } } });
    const pollRegistration = async (): Promise<PollFeishuRegistrationResult> => ({
      status: 'success',
      credentials: { appId: 'cli_new', appSecret: 'sec_new', domain: 'feishu', openId: 'ou_1' },
      domain: 'feishu',
    });
    registerConnectorHandlers({
      userDataDir: root,
      stateDir: join(root, 'state'),
      readStatus: () => STATUS_FEISHU,
      gateway: () => fake.gateway,
      fetchImpl: beginScript(),
      pollRegistration,
    });

    const begin = await call<{ ok: boolean; result: Json }>('connectors:feishu-registration-begin');
    expect(begin.ok).toBe(true);
    expect(begin.result['phase']).toBe('pending');
    expect(String(begin.result['qrUrl'])).toContain('from=oc_onboard');
    expect(begin.result['userCode']).toBe('CODE-1');

    const state = await waitForPhase('success');
    expect(state['appId']).toBe('cli_new');
    expect(state['boundAgentId']).toBe('main');

    const feishu = (fake.config['channels'] as Json)['feishu'] as Json;
    expect(feishu).toMatchObject({
      enabled: true,
      dmPolicy: 'allowlist',
      appId: 'cli_new',
      appSecret: 'sec_new',
      allowFrom: ['ou_1'],
      groupPolicy: 'allowlist',
      requireMention: true,
    });
    expect(fake.config['bindings']).toEqual([{ type: 'route', agentId: 'main', match: { channel: 'feishu' } }]);
  });

  it('取消 ⇒ 会话变 cancelled（后台轮询按取消标志收口）', async () => {
    const fake = createFakeGateway({});
    const pollRegistration = async (input: { isCancelled?: () => boolean }): Promise<PollFeishuRegistrationResult> => {
      while (!input.isCancelled?.()) await new Promise((resolve) => setTimeout(resolve, 5));
      return { status: 'cancelled' };
    };
    registerConnectorHandlers({
      userDataDir: root,
      stateDir: join(root, 'state'),
      readStatus: () => STATUS_FEISHU,
      gateway: () => fake.gateway,
      fetchImpl: beginScript(),
      pollRegistration,
    });

    await call('connectors:feishu-registration-begin');
    expect(await call('connectors:feishu-registration-cancel')).toEqual({ ok: true, result: { cancelled: true } });
    const state = await waitForPhase('cancelled');
    expect(state['qrUrl']).toBeTruthy();
    // 取消后不写任何配置。
    expect(fake.config['channels']).toBeUndefined();
  });

  it('begin 网络失败 ⇒ 具名错误 network（不进入 pending）', async () => {
    registerConnectorHandlers({
      userDataDir: root,
      stateDir: join(root, 'state'),
      readStatus: () => STATUS_FEISHU,
      gateway: () => null,
      fetchImpl: async () => {
        throw new Error('ECONNRESET');
      },
    });
    expect(await call('connectors:feishu-registration-begin')).toEqual({ ok: false, error: 'network' });
  });
});

describe('绑定与通道开关 IPC', () => {
  it('⭐ 改绑定 / 解绑 / 关闭通道 都真的落到网关配置里', async () => {
    const fake = createFakeGateway({
      channels: { feishu: { enabled: true, appId: 'cli_x', appSecret: 's' } },
      bindings: [{ type: 'route', agentId: 'main', match: { channel: 'feishu' } }],
    });
    registerConnectorHandlers({
      userDataDir: root,
      stateDir: join(root, 'state'),
      readStatus: () => STATUS_FEISHU,
      gateway: () => fake.gateway,
    });

    expect(await call('connectors:feishu-bind', { agentId: 'writer' })).toEqual({
      ok: true,
      result: { boundAgentId: 'writer' },
    });
    expect(fake.config['bindings']).toEqual([{ type: 'route', agentId: 'writer', match: { channel: 'feishu' } }]);

    expect(await call('connectors:feishu-bind', { agentId: null })).toEqual({
      ok: true,
      result: { boundAgentId: null },
    });
    expect(fake.config['bindings']).toEqual([]);

    expect(await call('connectors:feishu-enabled', { enabled: false })).toEqual({
      ok: true,
      result: { enabled: false },
    });
    expect(((fake.config['channels'] as Json)['feishu'] as Json)['enabled']).toBe(false);
    expect(((fake.config['channels'] as Json)['feishu'] as Json)['appId']).toBe('cli_x');
  });

  it('网关不可用 ⇒ 绑定/开关都明确报 gateway-unavailable', async () => {
    registerConnectorHandlers({
      userDataDir: root,
      stateDir: join(root, 'state'),
      readStatus: () => STATUS_FEISHU,
      gateway: () => null,
    });
    expect(await call('connectors:feishu-bind', { agentId: 'main' })).toEqual({
      ok: false,
      error: 'gateway-unavailable',
    });
    expect(await call('connectors:feishu-enabled', { enabled: true })).toEqual({
      ok: false,
      error: 'gateway-unavailable',
    });
  });

  it('agentId 传空字符串 ⇒ invalid-agent（不把空绑定写进去）', async () => {
    const fake = createFakeGateway({});
    registerConnectorHandlers({
      userDataDir: root,
      stateDir: join(root, 'state'),
      readStatus: () => STATUS_FEISHU,
      gateway: () => fake.gateway,
    });
    expect(await call('connectors:feishu-bind', { agentId: '  ' })).toEqual({ ok: false, error: 'invalid-agent' });
  });
});

/**
 * 便携形态（2026-10-18 同事实机）：运行时部署在
 * `<userData>/portable-runtime-cache/runtime/deployed`，**不是** `<userData>/runtime`。
 *
 * 连接器此前拿 `app.getPath('userData')` 去读 `current.json` ⇒ 盘上明明能正常聊天，
 * 连接器却一直显示「本机运行时还没准备好」并禁用飞书接入。
 */
describe('连接器状态：便携运行时缓存根', () => {
  const KEY = 'runtime-key-1';

  function seedDeployment(cacheRoot: string): void {
    const deployedRoot = join(cacheRoot, 'runtime', 'deployed', KEY);
    mkdirSync(join(deployedRoot, 'node'), { recursive: true });
    mkdirSync(join(deployedRoot, 'node_modules', 'openclaw', 'dist', 'extensions', 'clawrouter'), { recursive: true });
    writeFileSync(join(deployedRoot, 'node', 'node.exe'), '');
    writeFileSync(
      join(deployedRoot, 'node_modules', 'openclaw', 'dist', 'extensions', 'clawrouter', 'index.js'),
      'export {};',
    );
    writeFileSync(
      join(deployedRoot, '.clawwork-runtime.json'),
      JSON.stringify({
        schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
        runtimeDeploymentKey: KEY,
        archiveSha256: 'a'.repeat(64),
        nodeVersion: '26.3.1',
        nodeSha256: 'b'.repeat(64),
        platform: 'win32',
        arch: 'x64',
        cliPath: 'node_modules/openclaw/openclaw.mjs',
        nodeRelativePath: 'node/node.exe',
        deployedAt: '2026-10-18T00:00:00.000Z',
      }),
    );
    writeFileSync(
      join(cacheRoot, 'runtime', 'current.json'),
      JSON.stringify({ runtimeDeploymentKey: KEY, updatedAt: '2026-10-18T00:00:00.000Z' }),
    );
  }

  it('⭐ 传 runtimeCacheUserDataDir ⇒ runtimeReady=true（部署在缓存根下）', async () => {
    const cacheRoot = join(root, 'portable-runtime-cache');
    seedDeployment(cacheRoot);
    registerConnectorHandlers({
      userDataDir: root,
      runtimeCacheUserDataDir: cacheRoot,
      stateDir: join(root, 'state'),
    });
    const res = await call<{ ok: true; result: { connectors: Array<{ runtimeReady: boolean }> } }>(
      'connectors:status',
    );
    expect(res.ok).toBe(true);
    expect(res.result.connectors[0]?.runtimeReady).toBe(true);
  });

  it('负对照：不传 ⇒ 读 userData/runtime（没有部署）⇒ false', async () => {
    const cacheRoot = join(root, 'portable-runtime-cache');
    seedDeployment(cacheRoot);
    registerConnectorHandlers({
      userDataDir: root,
      stateDir: join(root, 'state'),
    });
    const res = await call<{ ok: true; result: { connectors: Array<{ runtimeReady: boolean }> } }>(
      'connectors:status',
    );
    expect(res.ok).toBe(true);
    expect(res.result.connectors[0]?.runtimeReady).toBe(false);
  });
});

describe('便携分裂态：状态目录解析不出时（启动早期/启动失败）', () => {
  it('⭐ 解析器返回 null ⇒ 状态按"运行时未就绪"报，接入直接拒绝（不往推测目录写）', async () => {
    registerConnectorHandlers({
      userDataDir: root,
      // 便携真实目录只有 runtime 层知道；此时还没解析出来。
      stateDir: () => null,
      readStatus: () => STATUS_FEISHU,
      gateway: () => null,
    });

    const status = await call<{ ok: true; result: { connectors: Array<{ runtimeReady: boolean; configured: boolean }> } }>(
      'connectors:status',
    );
    expect(status.ok).toBe(true);
    expect(status.result.connectors[0]).toMatchObject({ runtimeReady: false, configured: false });

    const state = await call<{ ok: true; result: { state: { runtimeReady: boolean } } }>('connectors:feishu-state');
    expect(state.ok).toBe(true);
    expect(state.result.state.runtimeReady).toBe(false);

    const begin = await call<{ ok: boolean; error?: string }>('connectors:feishu-registration-begin');
    expect(begin).toEqual({ ok: false, error: 'runtime-missing' });
  });
});

describe('BUG-171：可信安装记录 + 通道健康', () => {
  function seedDeploymentFor(cacheRoot: string): void {
    const key = '2026.9.3-win32-x64-test';
    const deployedRoot = join(cacheRoot, 'runtime', 'deployed', key);
    mkdirSync(join(deployedRoot, 'node'), { recursive: true });
    mkdirSync(join(deployedRoot, 'node_modules', 'openclaw', 'dist', 'extensions', 'clawrouter'), {
      recursive: true,
    });
    writeFileSync(join(deployedRoot, 'node', 'node.exe'), '');
    writeFileSync(join(deployedRoot, 'node_modules', 'openclaw', 'openclaw.mjs'), '');
    writeFileSync(
      join(deployedRoot, 'node_modules', 'openclaw', 'dist', 'extensions', 'clawrouter', 'index.js'),
      'export {};',
    );
    writeFileSync(
      join(deployedRoot, '.clawwork-runtime.json'),
      JSON.stringify({
        schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
        runtimeDeploymentKey: key,
        archiveSha256: 'a'.repeat(64),
        nodeVersion: '26.3.1',
        nodeSha256: 'b'.repeat(64),
        platform: 'win32',
        arch: 'x64',
        cliPath: 'node_modules/openclaw/openclaw.mjs',
        nodeRelativePath: 'node/node.exe',
        deployedAt: '2026-10-18T00:00:00.000Z',
      }),
    );
    writeFileSync(
      join(cacheRoot, 'runtime', 'current.json'),
      JSON.stringify({ runtimeDeploymentKey: key, updatedAt: '2026-10-18T00:00:00.000Z' }),
    );
  }

  it('⭐ 没有安装记录 ⇒ 扫码前先跑官方安装；payload 目录一并传入', async () => {
    const cacheRoot = join(root, 'portable-runtime-cache');
    seedDeploymentFor(cacheRoot);
    const ensureInstall = vi.fn(async () => ({
      ok: true as const,
      installed: true,
      record: { source: 'npm', installPath: join(root, 'plugin') },
    }));
    registerConnectorHandlers({
      userDataDir: root,
      runtimeCacheUserDataDir: cacheRoot,
      runtimeNodePayloadDir: join(root, 'payload', 'node'),
      stateDir: join(root, 'state'),
      readInstallRecord: () => null,
      ensureInstall,
      gateway: () => null,
      fetchImpl: beginScript(),
      pollRegistration: async () => ({ status: 'cancelled' }),
    });

    await call('connectors:feishu-registration-begin');
    expect(ensureInstall).toHaveBeenCalledTimes(1);
    const input = (ensureInstall.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(input).toMatchObject({
      stateDir: join(root, 'state'),
      pluginVersion: '2026.9.3',
      payloadDir: join(root, 'payload', 'node'),
    });
    expect(String(input['nodePath'])).toContain('node.exe');
    expect(String(input['cliPath'])).toContain('openclaw.mjs');
  });

  it('已有可信记录 ⇒ 不再重复安装', async () => {
    const cacheRoot = join(root, 'portable-runtime-cache');
    seedDeploymentFor(cacheRoot);
    const ensureInstall = vi.fn();
    registerConnectorHandlers({
      userDataDir: root,
      runtimeCacheUserDataDir: cacheRoot,
      stateDir: join(root, 'state'),
      readInstallRecord: () => ({ source: 'npm', installPath: join(root, 'plugin') }),
      ensureInstall: ensureInstall as never,
      gateway: () => null,
      fetchImpl: beginScript(),
      pollRegistration: async () => ({ status: 'cancelled' }),
    });

    await call('connectors:feishu-registration-begin');
    expect(ensureInstall).not.toHaveBeenCalled();
  });

  it('⭐ feishu-state 带上网关里的通道健康（ingressUnavailable 不上屏"已连接"）', async () => {
    const fake = createFakeGateway({ channels: { feishu: { enabled: true, appId: 'cli_x' } } });
    (fake.gateway as Record<string, unknown>)['health'] = async () => ({
      channels: {
        feishu: {
          running: false,
          lifecycle: 'recovering',
          ingressUnavailable: true,
          lastError: 'reason=record-missing',
        },
      },
    });
    registerConnectorHandlers({
      userDataDir: root,
      stateDir: join(root, 'state'),
      readStatus: () => STATUS_FEISHU,
      gateway: () => fake.gateway,
    });

    const res = await call<{
      ok: true;
      result: { state: { channelHealth?: { running: boolean; ingressUnavailable: boolean; lastError: string | null } } };
    }>('connectors:feishu-state');
    expect(res.ok).toBe(true);
    expect(res.result.state.channelHealth).toEqual({
      running: false,
      lifecycle: 'recovering',
      ingressUnavailable: true,
      lastError: 'reason=record-missing',
    });
  });
});
