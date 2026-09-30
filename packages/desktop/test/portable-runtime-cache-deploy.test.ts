import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { runtimeCacheScopeDir } from '../src/main/runtime/cache-scope';
import { ensureRuntimeDeployed, readCurrentDeployment } from '../src/main/runtime/deploy';
import { buildSource, deployOpts } from './helpers/runtime-fixture';

it('deploys and relocates a portable runtime without writing host application data', async () => {
  const evidenceRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'artifacts');
  mkdirSync(evidenceRoot, { recursive: true });
  const fixtureRoot = mkdtempSync(join(evidenceRoot, 'portable-cache-deploy-'));
  try {
    const source = buildSource(fixtureRoot);
    const hostData = join(fixtureRoot, 'host', 'application-data');
    const portableData = join(fixtureRoot, 'device', 'application-data');
    const cacheRoot = runtimeCacheScopeDir({
      localUserDataDir: hostData,
      effectiveUserDataDir: portableData,
      portable: true,
    });
    const first = await ensureRuntimeDeployed(deployOpts(source, cacheRoot));
    expect(first.status).toBe('deployed');
    expect(relative(portableData, first.deployedRoot).startsWith('portable-runtime-cache')).toBe(true);
    expect(readFileSync(first.nodePath).toString()).toBe('MZ fake node binary\n');
    expect(readCurrentDeployment(cacheRoot).status).toBe('ok');
    expect(existsSync(hostData)).toBe(false);

    const movedData = join(fixtureRoot, 'moved-device', 'application-data');
    mkdirSync(dirname(movedData), { recursive: true });
    cpSync(portableData, movedData, { recursive: true, errorOnExist: true, force: false });
    const movedCacheRoot = runtimeCacheScopeDir({
      localUserDataDir: hostData,
      effectiveUserDataDir: movedData,
      portable: true,
    });
    const moved = await ensureRuntimeDeployed(deployOpts(source, movedCacheRoot));
    expect(moved.status).toBe('skipped');
    expect(moved.deploymentKey).toBe(first.deploymentKey);
    expect(readCurrentDeployment(movedCacheRoot)).toMatchObject({
      status: 'ok',
      deployedRoot: moved.deployedRoot,
      nodePath: moved.nodePath,
    });
    expect(moved.deployedRoot).not.toContain(portableData);
    expect(existsSync(hostData)).toBe(false);
  } finally {
    const fixtureRelative = relative(evidenceRoot, fixtureRoot);
    if (fixtureRelative.startsWith('portable-cache-deploy-') && !fixtureRelative.includes('..')) {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }
});
