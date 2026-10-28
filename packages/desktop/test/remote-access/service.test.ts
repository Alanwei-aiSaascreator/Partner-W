import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrpcProcess } from '../../src/main/remote-access/frpc-process.js';
import type { RemotePageServer } from '../../src/main/remote-access/remote-page-server.js';
import { RemoteAccessService, type RemoteAccessConfig } from '../../src/main/remote-access/service.js';

/**
 * 远程访问总装：配置 → 18780 → frpc.toml → frpc。
 * 这里不打桩网络，只替换"起进程"和"起服务"两件有副作用的事，
 * 要钉住的是**失败怎么收敛**（degraded + 原因，且不启动不该启动的东西）。
 */

let dir: string;
let configPath: string;
let stateDir: string;

interface Fakes {
  pageStop: ReturnType<typeof vi.fn>;
  pageStart: ReturnType<typeof vi.fn>;
  frpcStart: ReturnType<typeof vi.fn>;
  frpcStop: ReturnType<typeof vi.fn>;
}

function makeService(
  config: RemoteAccessConfig | null,
  overrides: {
    deviceId?: string;
    pageStartImpl?: () => Promise<number>;
    frpcState?: ReturnType<() => FrpcProcess['currentState']>;
    applyGatewaySettings?: (host: string) => Promise<void>;
  } = {},
): { service: RemoteAccessService; fakes: Fakes } {
  if (config) {
    writeFileSync(configPath, JSON.stringify(config), 'utf8');
  } else {
    rmSync(configPath, { force: true });
  }

  const fakes: Fakes = {
    pageStart: vi.fn(overrides.pageStartImpl ?? (async () => 18780)),
    pageStop: vi.fn(async () => {}),
    frpcStart: vi.fn(),
    frpcStop: vi.fn(async () => {}),
  };

  const service = new RemoteAccessService({
    configPath,
    stateDir,
    pageRoot: join(dir, 'app-remote'),
    binaryPath: join(dir, 'frpc.exe'),
    deviceId: () => overrides.deviceId ?? '550e8400-e29b-41d4-a716-446655440000',
    applyGatewaySettings: overrides.applyGatewaySettings,
    createPageServer: () => ({ start: fakes.pageStart, stop: fakes.pageStop }) as unknown as RemotePageServer,
    createFrpc: () =>
      ({
        start: fakes.frpcStart,
        stop: fakes.frpcStop,
        currentState: overrides.frpcState ?? 'running',
      }) as unknown as FrpcProcess,
  });

  return { service, fakes };
}

const VALID: RemoteAccessConfig = {
  enabled: true,
  serverAddr: '47.119.120.28',
  serverPort: 7000,
  token: 'tok_test_123',
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'remote-access-'));
  configPath = join(dir, 'remote-access.json');
  stateDir = join(dir, 'runtime');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('RemoteAccessService · 未启用', () => {
  it('没有配置文件时是 disabled，且不起任何东西', async () => {
    const { service, fakes } = makeService(null);
    const status = await service.start();

    expect(status.state).toBe('disabled');
    expect(fakes.pageStart).not.toHaveBeenCalled();
    expect(fakes.frpcStart).not.toHaveBeenCalled();
  });

  it('enabled=false 时同样不起', async () => {
    const { service } = makeService({ ...VALID, enabled: false });
    expect((await service.start()).state).toBe('disabled');
  });

  it('配置缺字段时按未配置处理', async () => {
    const { service, fakes } = makeService(null);
    writeFileSync(configPath, JSON.stringify({ enabled: true, serverAddr: '' }), 'utf8');
    const status = await service.start();

    expect(status.state).toBe('disabled');
    expect(fakes.pageStart).not.toHaveBeenCalled();
  });
});

describe('RemoteAccessService · 正常启动', () => {
  it('起 18780 + 写 frpc.toml + 起 frpc', async () => {
    const { service, fakes } = makeService(VALID);
    const status = await service.start();

    expect(status.state).toBe('online');
    expect(status.entryPort).toBe(18780);
    expect(status.subdomain).toBe('550e8400');
    expect(status.host).toBe('550e8400.rym.rongyinghudong.com');
    expect(fakes.pageStart).toHaveBeenCalledTimes(1);
    expect(fakes.frpcStart).toHaveBeenCalledTimes(1);

    const toml = readFileSync(join(stateDir, 'frpc.toml'), 'utf8');
    expect(toml).toContain('serverAddr = "47.119.120.28"');
    expect(toml).toContain('subdomain = "550e8400"');
    expect(toml).toContain('localPort = 18780');
    expect(toml).toContain('auth.token = "tok_test_123"');
  });

  it('配置里点名 subdomain 时优先用它', async () => {
    const { service } = makeService({ ...VALID, subdomain: 'ABCD1234' });
    const status = await service.start();

    expect(status.subdomain).toBe('abcd1234');
    expect(readFileSync(join(stateDir, 'frpc.toml'), 'utf8')).toContain('subdomain = "abcd1234"');
  });

  it('自定义域名后缀时 host 跟着变', async () => {
    const { service } = makeService({ ...VALID, domainSuffix: 'rym.example.com' });
    expect((await service.start()).host).toBe('550e8400.rym.example.com');
  });
});

describe('RemoteAccessService · 失败收敛', () => {
  it('子域非法直接 degraded，不写配置也不起进程', async () => {
    const { service, fakes } = makeService({ ...VALID, subdomain: 'bad_sub' });
    const status = await service.start();

    expect(status.state).toBe('degraded');
    expect(status.reason).toContain('子域不合法');
    expect(fakes.pageStart).not.toHaveBeenCalled();
  });

  it('入口端口起不来时 degraded，且不启动 frpc', async () => {
    const { service, fakes } = makeService(VALID, {
      pageStartImpl: async () => {
        throw new Error('EADDRINUSE: 18780');
      },
    });
    const status = await service.start();

    expect(status.state).toBe('degraded');
    expect(status.reason).toContain('EADDRINUSE');
    expect(fakes.frpcStart).not.toHaveBeenCalled();
  });

  it('网关白名单写成功后 gatewayConfigured=true', async () => {
    const apply = vi.fn(async () => {});
    const { service } = makeService(VALID, { applyGatewaySettings: apply });

    const status = await service.start();

    expect(status.state).toBe('online');
    expect(status.gatewayConfigured).toBe(true);
    expect(apply).toHaveBeenCalledWith('550e8400.rym.rongyinghudong.com');
  });

  it('白名单写失败时仍是 online，但标出 gatewayConfigured=false（403 的线索）', async () => {
    const { service } = makeService(VALID, {
      applyGatewaySettings: async () => {
        throw new Error('gateway not connected');
      },
    });

    const status = await service.start();

    expect(status.state).toBe('online');
    expect(status.gatewayConfigured).toBe(false);
  });

  it('frpc 掉进 degraded 时状态跟着变，不再谎报 online', async () => {
    const { service } = makeService(VALID, { frpcState: 'degraded' });
    await service.start();

    const status = service.getStatus();
    expect(status.state).toBe('degraded');
    expect(status.frpcState).toBe('degraded');
  });
});

describe('RemoteAccessService · 停止', () => {
  it('stop 后 frpc 与入口都被停掉，状态回 stopped', async () => {
    const { service, fakes } = makeService(VALID);
    await service.start();
    await service.stop();

    expect(fakes.frpcStop).toHaveBeenCalledTimes(1);
    expect(fakes.pageStop).toHaveBeenCalledTimes(1);
    expect(service.getStatus().state).toBe('stopped');
  });

  it('重复 stop 不炸', async () => {
    const { service, fakes } = makeService(VALID);
    await service.start();
    await service.stop();
    await service.stop();

    expect(fakes.frpcStop).toHaveBeenCalledTimes(1);
  });
});
