import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  repairFeishuInstallOnStartup,
  resetFeishuInstallRepairForTests,
} from '../src/main/connectors/feishu-install-repair.js';

/**
 * 2026-10-19 现场盘：飞书插件目录在、可信安装记录没了（换盘符后 `installPath` 失效，
 * 或 1.0.9 的目录复制从来就没有记录）⇒ 内核判 record-missing，通道进 ingressUnavailable。
 * 用户不该每次换机都手动点一次「重新扫码」——启动后台跑一次官方安装把它修回来。
 */

const dirs: string[] = [];

function makeStateDir(withPlugin: boolean): string {
  const stateDir = mkdtempSync(join(tmpdir(), 'mofang-feishu-repair-'));
  dirs.push(stateDir);
  if (withPlugin) mkdirSync(join(stateDir, 'extensions', 'feishu'), { recursive: true });
  return stateDir;
}

function deploymentOk() {
  return { status: 'ok', nodePath: 'node.exe', cliPath: 'openclaw.mjs' } as never;
}

beforeEach(() => {
  resetFeishuInstallRepairForTests();
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('repairFeishuInstallOnStartup：state 目录还没解析出来', () => {
  /**
   * 2026-10-19 现场复现：启动 10s 的第一次触发可能早于网关 spawn 完成
   * （`getActiveLocalGatewayStateDir()` 只在 ownership=spawned 时返回值）。
   * 此前这种情况返回 `skipped` ⇒ 调用方不再重试 ⇒ **本次进程永久放弃自愈**，
   * 用户看到的就是"插件缺少可信安装记录"一直修不好。
   */
  it('⭐ stateDir 为空 ⇒ deferred（不消耗门闩，后续还能修）', async () => {
    const ensureInstall = vi.fn();
    const first = await repairFeishuInstallOnStartup({
      stateDir: null,
      deploymentDir: '/deploy',
      readDeployment: deploymentOk,
      ensureInstall: ensureInstall as never,
      stopGateway: async () => {},
      restartGateway: async () => {},
    });
    expect(first).toBe('deferred');
    expect(ensureInstall).not.toHaveBeenCalled();

    // 下一次（stateDir 已解析）必须照常动手 —— 证明门闩没被第一次消耗掉。
    const stateDir = makeStateDir(true);
    const second = await repairFeishuInstallOnStartup({
      stateDir,
      deploymentDir: '/deploy',
      readRecord: () => null,
      readDeployment: deploymentOk,
      ensureInstall: (async () => ({ ok: true })) as never,
      stopGateway: async () => {},
      restartGateway: async () => {},
    });
    expect(second).toBe('repaired');
  });
});

describe('repairFeishuInstallOnStartup', () => {
  it('记录有效 ⇒ 什么都不做（不装、不停网关）', async () => {
    const stateDir = makeStateDir(true);
    const stopGateway = vi.fn(async () => {});
    const ensureInstall = vi.fn();

    const result = await repairFeishuInstallOnStartup({
      stateDir,
      deploymentDir: '/deploy',
      readRecord: () => ({ source: 'npm', installPath: join(stateDir, 'extensions', 'feishu') }),
      readDeployment: deploymentOk,
      ensureInstall: ensureInstall as never,
      stopGateway,
      restartGateway: async () => {},
    });

    expect(result).toBe('skipped');
    expect(stopGateway).not.toHaveBeenCalled();
    expect(ensureInstall).not.toHaveBeenCalled();
  });

  it('插件在但记录缺失 ⇒ 停网关、装一次、再拉起来', async () => {
    const stateDir = makeStateDir(true);
    const stopGateway = vi.fn(async () => {});
    const restartGateway = vi.fn(async () => {});
    const ensureInstall = vi.fn(async () => ({ ok: true }));

    const result = await repairFeishuInstallOnStartup({
      stateDir,
      deploymentDir: '/deploy',
      readRecord: () => null,
      readDeployment: deploymentOk,
      ensureInstall: ensureInstall as never,
      stopGateway,
      restartGateway,
    });

    expect(result).toBe('repaired');
    expect(stopGateway).toHaveBeenCalledTimes(1);
    expect(restartGateway).toHaveBeenCalledTimes(1);
    expect(ensureInstall).toHaveBeenCalledTimes(1);
  });

  it('插件从没装过 ⇒ 不替用户装（跳过）', async () => {
    const stateDir = makeStateDir(false);
    const ensureInstall = vi.fn();

    const result = await repairFeishuInstallOnStartup({
      stateDir,
      deploymentDir: '/deploy',
      readRecord: () => null,
      readDeployment: deploymentOk,
      ensureInstall: ensureInstall as never,
      stopGateway: async () => {},
      restartGateway: async () => {},
    });

    expect(result).toBe('skipped');
    expect(ensureInstall).not.toHaveBeenCalled();
  });

  // 2026-10-19 自审：全新盘/清缓存盘首次启动时运行时还在部署（实测 149s），
  // 而自愈此前固定 10s 触发 ⇒ 读到"未就绪"就永久放弃本次会话，用户必须重启一次。
  // 现在"未就绪"返回 deferred 且**不**消耗每进程一次的门闩，调用方可以继续重试。
  it('运行时还没部署好 ⇒ deferred，部署好之后仍能修', async () => {
    const stateDir = makeStateDir(true);
    const stopGateway = vi.fn(async () => {});
    const ensureInstall = vi.fn(async () => ({ ok: true }));

    const deferred = await repairFeishuInstallOnStartup({
      stateDir,
      deploymentDir: '/deploy',
      readRecord: () => null,
      readDeployment: (() => ({ status: 'not-deployed' })) as never,
      ensureInstall: ensureInstall as never,
      stopGateway,
      restartGateway: async () => {},
    });
    expect(deferred).toBe('deferred');
    expect(stopGateway).not.toHaveBeenCalled();
    expect(ensureInstall).not.toHaveBeenCalled();

    const repaired = await repairFeishuInstallOnStartup({
      stateDir,
      deploymentDir: '/deploy',
      readRecord: () => null,
      readDeployment: deploymentOk,
      ensureInstall: ensureInstall as never,
      stopGateway,
      restartGateway: async () => {},
    });
    expect(repaired).toBe('repaired');
    expect(stopGateway).toHaveBeenCalledTimes(1);
    expect(ensureInstall).toHaveBeenCalledTimes(1);
  });

  it('随包 npm 缺失（1.0.9 旧包）⇒ failed，且本进程不再重试', async () => {
    const stateDir = makeStateDir(true);
    const emptyPayload = mkdtempSync(join(tmpdir(), 'mofang-feishu-payload-'));
    dirs.push(emptyPayload);
    const ensureInstall = vi.fn();

    const first = await repairFeishuInstallOnStartup({
      stateDir,
      deploymentDir: '/deploy',
      runtimeNodePayloadDir: emptyPayload,
      readRecord: () => null,
      readDeployment: deploymentOk,
      ensureInstall: ensureInstall as never,
      stopGateway: async () => {},
      restartGateway: async () => {},
    });
    const second = await repairFeishuInstallOnStartup({
      stateDir,
      deploymentDir: '/deploy',
      runtimeNodePayloadDir: emptyPayload,
      readRecord: () => null,
      readDeployment: deploymentOk,
      ensureInstall: ensureInstall as never,
      stopGateway: async () => {},
      restartGateway: async () => {},
    });

    expect(first).toBe('failed');
    expect(second).toBe('skipped');
    expect(ensureInstall).not.toHaveBeenCalled();
  });

  it('每进程只试一次（失败也不会反复停网关）', async () => {
    const stateDir = makeStateDir(true);
    const stopGateway = vi.fn(async () => {});
    const ensureInstall = vi.fn(async () => ({ ok: false, reason: 'install-failed' }));

    const first = await repairFeishuInstallOnStartup({
      stateDir,
      deploymentDir: '/deploy',
      readRecord: () => null,
      readDeployment: deploymentOk,
      ensureInstall: ensureInstall as never,
      stopGateway,
      restartGateway: async () => {},
    });
    const second = await repairFeishuInstallOnStartup({
      stateDir,
      deploymentDir: '/deploy',
      readRecord: () => null,
      readDeployment: deploymentOk,
      ensureInstall: ensureInstall as never,
      stopGateway,
      restartGateway: async () => {},
    });

    expect(first).toBe('failed');
    expect(second).toBe('skipped');
    expect(stopGateway).toHaveBeenCalledTimes(1);
    expect(ensureInstall).toHaveBeenCalledTimes(1);
  });

  it('state 目录解析不到 ⇒ deferred（不是"跳过"，否则本进程永久放弃——见上面的现场用例）', async () => {
    const result = await repairFeishuInstallOnStartup({
      stateDir: null,
      deploymentDir: '/deploy',
      readRecord: () => null,
      readDeployment: deploymentOk,
      ensureInstall: (async () => ({ ok: true })) as never,
    });
    expect(result).toBe('deferred');
  });
});
