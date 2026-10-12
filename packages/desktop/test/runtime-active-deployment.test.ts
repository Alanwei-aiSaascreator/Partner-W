import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasInstalledSearchProvider } from '../src/main/runtime/bundled-search.js';
import { ensureRelaySearchPlugin } from '../src/main/runtime/relay-search-plugin.js';
import type { GatewayChildProcess } from '../src/main/runtime/gateway-process.js';
import type { RuntimeBootstrapDeps } from '../src/main/runtime/index.js';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => 'unused-profile'), getVersion: vi.fn(() => '0.0.0') },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false), encryptString: vi.fn(), decryptString: vi.fn() },
}));

const roots: string[] = [];

function deployment(withSearch = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-active-deployment-'));
  roots.push(root);
  if (withSearch) {
    // 可用性探针的样本写在**状态目录**里（= dependencies().alignClientConfig 返回的那个
    // `path.join(root, 'state')`）：2026-10-12 起搜索可用面是随盘落盘的 relay 搜索插件，
    // 探针入参随之从 deployedRoot 换成 stateDir。
    ensureRelaySearchPlugin(path.join(root, 'state'));
  }
  return root;
}

function dependencies(
  root: string,
  ownership: 'spawned' | 'reused',
  child?: GatewayChildProcess,
): RuntimeBootstrapDeps {
  return {
    alignClientConfig: async () => ({ token: 'fixture-token', stateDir: path.join(root, 'state') }),
    readCached: () => ({
      status: 'ok',
      deploymentKey: path.basename(root),
      deployedRoot: root,
      cliPath: path.join(root, 'node_modules/openclaw/openclaw.mjs'),
      nodePath: path.join(root, 'node/node.exe'),
    }),
    deployFromMedia: async () => {
      throw new Error('Unexpected media deployment');
    },
    selfCheckLinks: () => ({
      checked: 0,
      broken: 0,
      repaired: 0,
      failures: [],
      stillBroken: [],
      notes: [],
      summary: 'ok',
    }),
    resolveNode: async () => ({
      ok: true,
      node: { exe: path.join(root, 'node/node.exe'), version: '26.3.1', origin: 'deployed' },
      attempts: [],
    }),
    startGateway: async () => ({
      ownership,
      child,
      decision: { verdict: ownership === 'spawned' ? 'spawn' : 'reuse', reason: 'fixture' },
    }),
    setStateDirEnv: vi.fn(),
    log: vi.fn(),
    now: () => 1000,
  };
}

function ownedChild() {
  const listeners: Array<() => void> = [];
  const child: GatewayChildProcess = {
    pid: undefined,
    onExit: (listener) => listeners.push(listener),
    kill: vi.fn(),
  };
  return { child, exit: () => listeners.forEach((listener) => listener()) };
}

beforeEach(() => vi.resetModules());

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('active local gateway deployment evidence', () => {
  it('captures the exact owned process generation and rejects a replacement at the same deployed path', async () => {
    const root = deployment();
    const first = ownedChild(),
      second = ownedChild();
    const { bootstrapLocalGatewayRuntime, captureOwnedLocalGatewayRuntime } =
      await import('../src/main/runtime/index.js');
    expect(captureOwnedLocalGatewayRuntime()).toBeNull();
    await bootstrapLocalGatewayRuntime({ userDataDir: root, deps: dependencies(root, 'reused') });
    expect(captureOwnedLocalGatewayRuntime()).toBeNull();
    await bootstrapLocalGatewayRuntime({ userDataDir: root, deps: dependencies(root, 'spawned', first.child) });
    const owner = captureOwnedLocalGatewayRuntime()!;
    expect(owner.deployedRoot).toBe(root);
    expect(owner.current()).toBe(true);
    await bootstrapLocalGatewayRuntime({ userDataDir: root, deps: dependencies(root, 'spawned', second.child) });
    expect(owner.current()).toBe(false);
    const replacement = captureOwnedLocalGatewayRuntime()!;
    first.exit();
    expect(replacement.current()).toBe(true);
    second.exit();
    expect(replacement.current()).toBe(false);
  });
  it('does not advertise a candidate plugin for an initially reused gateway', async () => {
    const root = deployment();
    const { bootstrapLocalGatewayRuntime, getActiveLocalGatewayDeploymentRoot, getActiveLocalGatewayStateDir } =
      await import('../src/main/runtime/index.js');
    const result = await bootstrapLocalGatewayRuntime({ userDataDir: root, deps: dependencies(root, 'reused') });

    expect(result).toMatchObject({ ok: true, ownership: 'reused' });
    expect(getActiveLocalGatewayDeploymentRoot()).toBeNull();
    expect(hasInstalledSearchProvider(getActiveLocalGatewayStateDir())).toBe(false);
  });

  it('invalidates the owned deployment after its child exits without stopping any gateway', async () => {
    const root = deployment();
    const owned = ownedChild();
    const { bootstrapLocalGatewayRuntime, getActiveLocalGatewayDeploymentRoot, getActiveLocalGatewayStateDir } =
      await import('../src/main/runtime/index.js');
    await bootstrapLocalGatewayRuntime({ userDataDir: root, deps: dependencies(root, 'spawned', owned.child) });
    expect(getActiveLocalGatewayDeploymentRoot()).toBe(root);

    owned.exit();

    expect(getActiveLocalGatewayDeploymentRoot()).toBeNull();
    expect(hasInstalledSearchProvider(getActiveLocalGatewayStateDir())).toBe(false);
    expect(owned.child.kill).not.toHaveBeenCalled();
  });

  it('advertises the official plugin in a deployment whose child was spawned here', async () => {
    const root = deployment();
    const owned = ownedChild();
    const { bootstrapLocalGatewayRuntime, getActiveLocalGatewayDeploymentRoot, getActiveLocalGatewayStateDir } =
      await import('../src/main/runtime/index.js');
    await bootstrapLocalGatewayRuntime({ userDataDir: root, deps: dependencies(root, 'spawned', owned.child) });

    expect(getActiveLocalGatewayDeploymentRoot()).toBe(root);
    expect(hasInstalledSearchProvider(getActiveLocalGatewayStateDir())).toBe(true);
    expect(owned.child.kill).not.toHaveBeenCalled();
  });

  it('does not advertise a spawned result without a child process handle', async () => {
    const root = deployment();
    const { bootstrapLocalGatewayRuntime, getActiveLocalGatewayDeploymentRoot, getActiveLocalGatewayStateDir } =
      await import('../src/main/runtime/index.js');
    await bootstrapLocalGatewayRuntime({ userDataDir: root, deps: dependencies(root, 'spawned') });

    expect(getActiveLocalGatewayDeploymentRoot()).toBeNull();
    expect(hasInstalledSearchProvider(getActiveLocalGatewayStateDir())).toBe(false);
  });

  it.each([false, true])(
    'keeps the owned root when reuse selects a different candidate (owned search: %s)',
    async (withSearch) => {
      const ownedRoot = deployment(withSearch);
      const candidateRoot = deployment(!withSearch);
      const owned = ownedChild();
      const { bootstrapLocalGatewayRuntime, getActiveLocalGatewayDeploymentRoot, getActiveLocalGatewayStateDir } =
        await import('../src/main/runtime/index.js');
      await bootstrapLocalGatewayRuntime({
        userDataDir: ownedRoot,
        deps: dependencies(ownedRoot, 'spawned', owned.child),
      });
      const reused = await bootstrapLocalGatewayRuntime({
        userDataDir: candidateRoot,
        deps: dependencies(candidateRoot, 'reused'),
      });

      expect(reused).toMatchObject({ ok: true, ownership: 'reused' });
      expect(getActiveLocalGatewayDeploymentRoot()).toBe(ownedRoot);
      expect(hasInstalledSearchProvider(getActiveLocalGatewayStateDir())).toBe(withSearch);
      expect(owned.child.kill).not.toHaveBeenCalled();
    },
  );

  it('does not restore candidate evidence when an exited child is followed by reuse', async () => {
    const ownedRoot = deployment();
    const candidateRoot = deployment();
    const owned = ownedChild();
    const { bootstrapLocalGatewayRuntime, getActiveLocalGatewayDeploymentRoot, getActiveLocalGatewayStateDir } =
      await import('../src/main/runtime/index.js');
    await bootstrapLocalGatewayRuntime({
      userDataDir: ownedRoot,
      deps: dependencies(ownedRoot, 'spawned', owned.child),
    });
    owned.exit();
    await bootstrapLocalGatewayRuntime({ userDataDir: candidateRoot, deps: dependencies(candidateRoot, 'reused') });

    expect(getActiveLocalGatewayDeploymentRoot()).toBeNull();
    expect(hasInstalledSearchProvider(getActiveLocalGatewayStateDir())).toBe(false);
    expect(owned.child.kill).not.toHaveBeenCalled();
  });

  it('does not let a late exit from the previous child clear the new owned root', async () => {
    const previousRoot = deployment(false);
    const currentRoot = deployment();
    const previous = ownedChild();
    const current = ownedChild();
    const { bootstrapLocalGatewayRuntime, getActiveLocalGatewayDeploymentRoot, getActiveLocalGatewayStateDir } =
      await import('../src/main/runtime/index.js');
    await bootstrapLocalGatewayRuntime({
      userDataDir: previousRoot,
      deps: dependencies(previousRoot, 'spawned', previous.child),
    });
    await bootstrapLocalGatewayRuntime({
      userDataDir: currentRoot,
      deps: dependencies(currentRoot, 'spawned', current.child),
    });
    previous.exit();

    expect(getActiveLocalGatewayDeploymentRoot()).toBe(currentRoot);
    expect(hasInstalledSearchProvider(getActiveLocalGatewayStateDir())).toBe(true);
    expect(previous.child.kill).not.toHaveBeenCalled();
    expect(current.child.kill).not.toHaveBeenCalled();
  });

  it('establishes deployment evidence when a later bootstrap actually spawns a child', async () => {
    const candidateRoot = deployment(false);
    const ownedRoot = deployment();
    const owned = ownedChild();
    const { bootstrapLocalGatewayRuntime, getActiveLocalGatewayDeploymentRoot, getActiveLocalGatewayStateDir } =
      await import('../src/main/runtime/index.js');
    await bootstrapLocalGatewayRuntime({ userDataDir: candidateRoot, deps: dependencies(candidateRoot, 'reused') });
    await bootstrapLocalGatewayRuntime({
      userDataDir: ownedRoot,
      deps: dependencies(ownedRoot, 'spawned', owned.child),
    });

    expect(getActiveLocalGatewayDeploymentRoot()).toBe(ownedRoot);
    expect(hasInstalledSearchProvider(getActiveLocalGatewayStateDir())).toBe(true);
    expect(owned.child.kill).not.toHaveBeenCalled();
  });

  it('fails closed when the child has already exited before the exit listener is attached', async () => {
    const root = deployment();
    const owned = ownedChild();
    owned.child.onExit = (listener) => listener();
    const { bootstrapLocalGatewayRuntime, getActiveLocalGatewayDeploymentRoot, getActiveLocalGatewayStateDir } =
      await import('../src/main/runtime/index.js');
    await bootstrapLocalGatewayRuntime({ userDataDir: root, deps: dependencies(root, 'spawned', owned.child) });

    expect(getActiveLocalGatewayDeploymentRoot()).toBeNull();
    expect(hasInstalledSearchProvider(getActiveLocalGatewayStateDir())).toBe(false);
    expect(owned.child.kill).not.toHaveBeenCalled();
  });

  it('does not treat a failed bootstrap candidate as an active deployment', async () => {
    const root = deployment();
    const deps = dependencies(root, 'spawned');
    deps.startGateway = async () => {
      throw new Error('fixture startup failure');
    };
    const { bootstrapLocalGatewayRuntime, getActiveLocalGatewayDeploymentRoot, getActiveLocalGatewayStateDir } =
      await import('../src/main/runtime/index.js');
    const result = await bootstrapLocalGatewayRuntime({ userDataDir: root, deps });

    expect(result.ok).toBe(false);
    expect(getActiveLocalGatewayDeploymentRoot()).toBeNull();
    expect(hasInstalledSearchProvider(getActiveLocalGatewayStateDir())).toBe(false);
  });
});
