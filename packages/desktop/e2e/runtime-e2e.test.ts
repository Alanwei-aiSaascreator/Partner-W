import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { GATEWAY_WS_PORT } from '@clawwork/shared';
import { fileURLToPath } from 'node:url';

/**
 * 阶段 1 主验收 —— **四次启动** + 半部署恢复 + Node 缺失 + 指针。
 *
 * 这里的每一步都是**真的**：真归档、真 node.exe、真解压、真 spawn 网关、
 * 真 /startupz、真占端口。不是 mock。
 *
 * ⚠️ 启动 1–4 一律走 `bootstrapLocalGatewayRuntime`（**真实的编排**），
 * 而不是单独调某个模块 —— 因为"能不能起来"取决于整条链的顺序：
 * token 写进 state → 部署 → 解析 node → 探活认证 → spawn。少一步就会得到
 * 一个看起来像"网关不认识我们"的假故障（第一版 E2E 就是这么翻车的：
 * 绕开 state 写入直接 spawn，于是自家网关被认证探测判成了 foreign）。
 *
 * ⚠️ 会话安全：全部在 `os.tmpdir()` 的一次性 userData 里活动，
 * **绝不触碰**真实 `%APPDATA%` / `openclaw-state` / `.state-*`（junction 事故）。
 * 「拔盘」用 process.chdir + 让所有来源都指不到 —— 不删任何东西。
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), getVersion: vi.fn(() => '0.0.0-e2e'), isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((v: string) => Buffer.from(v)),
    decryptString: vi.fn((b: Buffer) => b.toString('utf8')),
  },
}));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const RUNTIME_OUT = path.join(REPO_ROOT, 'runtime-out');
const SOURCE_MANIFEST = path.join(RUNTIME_OUT, 'openclaw-runtime-manifest.json');
const ARCHIVE = path.join(RUNTIME_OUT, 'win32-x64', 'openclaw-runtime-2026.9.3.7z');

const results: Record<string, unknown> = {};

function log(step: string, data: Record<string, unknown> = {}): void {
  results[step] = data;
  console.log(`\n[E2E] ${step} ${JSON.stringify(data)}`);
}

function freshDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `clawwork-e2e-${name}-`));
}

function readStamp(deployedRoot: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(deployedRoot, '.clawwork-runtime.json'), 'utf-8'));
}

function sha256File(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** 一个假的"别人的网关"：占住端口，`/startupz` 有响应但不是我们的。 */
function startForeignGateway(status: string): Promise<{ server: http.Server; hits: string[] }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(GATEWAY_WS_PORT, '127.0.0.1', () => resolve({ server, hits }));
  });
}

afterAll(async () => {
  console.log('\n[E2E] 汇总\n' + JSON.stringify(results, null, 2));
});

describe('阶段 1 主验收', () => {
  let userDataDir = '';
  let deploymentKey = '';
  let deployedRoot = '';
  let deployedNodePath = '';

  it('启动 1：纯净隔离 profile + 插盘 + 端口空 ⇒ 部署 OpenClaw + Node，网关 started', async () => {
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');
    const { readCurrentDeployment } = await import('../src/main/runtime/deploy.js');

    userDataDir = freshDir('launch1');
    process.env.CLAWWORK_RUNTIME_DIR = RUNTIME_OUT; // 模拟"插着盘"

    const events: string[] = [];
    const t0 = Date.now();
    const res = await bootstrapLocalGatewayRuntime({
      userDataDir,
      deps: { log: (e) => events.push(e) },
    });
    const totalMs = Date.now() - t0;

    expect(res.ok, `bootstrap 失败：${res.reason}`).toBe(true);
    expect(res.ownership).toBe('spawned');
    expect(res.deployStatus).toBe('deployed');
    expect(res.nodeVersion).toBe('26.3.1');

    deploymentKey = res.deploymentKey!;
    deployedRoot = path.join(userDataDir, 'runtime', 'deployed', deploymentKey);
    deployedNodePath = path.join(deployedRoot, 'node', 'node.exe');

    // ---- 布局：完全自包含 ----
    expect(fs.existsSync(deployedNodePath)).toBe(true);
    expect(fs.existsSync(path.join(deployedRoot, 'node', 'LICENSE'))).toBe(true);
    expect(fs.existsSync(path.join(deployedRoot, 'node_modules/openclaw/openclaw.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(deployedRoot, 'node_modules/openclaw/dist/extensions/clawrouter/index.js'))).toBe(
      true,
    );

    const stamp = readStamp(deployedRoot);
    expect(sha256File(deployedNodePath)).toBe(stamp.nodeSha256);
    expect(stamp.archiveSha256).toBe(sha256File(ARCHIVE));

    // 真的用的是**本机缓存里**那个 node（不是盘上的、不是 PATH 的）
    expect(res.nodeExe).toBe(deployedNodePath);

    const probe = await fetch(`http://127.0.0.1:${GATEWAY_WS_PORT}/startupz`);
    expect(probe.ok).toBe(true);
    expect((await probe.json()).status).toBe('started');

    const cur = readCurrentDeployment(userDataDir);
    expect(cur.status).toBe('ok');
    expect(cur.deploymentKey).toBe(deploymentKey);

    // state 里确实写了 token —— 这正是启动 2 能认证通过的前提
    const stateCfg = JSON.parse(fs.readFileSync(path.join(userDataDir, 'openclaw-state', 'openclaw.json'), 'utf-8'));
    expect(stateCfg.gateway.auth.mode).toBe('token');
    expect(stateCfg.gateway.auth.token.length).toBeGreaterThan(20);

    log('启动1', {
      totalMs,
      bootstrapElapsedMs: res.elapsedMs,
      key: deploymentKey,
      nodeExe: deployedNodePath,
      nodeVersion: res.nodeVersion,
      ownership: res.ownership,
      deployStatus: res.deployStatus,
      startupz: 'started',
      events,
    });
  }, 900_000);

  it('启动 2：仍插盘、网关仍在 ⇒ deploy.skipped + **复用**（真认证探测）', async () => {
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');

    const events: string[] = [];
    const t0 = Date.now();
    const res = await bootstrapLocalGatewayRuntime({ userDataDir, deps: { log: (e) => events.push(e) } });
    const totalMs = Date.now() - t0;

    expect(res.ok, `bootstrap 失败：${res.reason}`).toBe(true);
    expect(res.deploymentKey).toBe(deploymentKey);
    expect(res.deployStatus).toBe('skipped');
    // ⭐ 网关还活着、**认证通过** ⇒ 复用，没有起第二个
    expect(res.ownership).toBe('reused');
    expect(events).toContain('runtime.deploy.skipped');

    const probe = await fetch(`http://127.0.0.1:${GATEWAY_WS_PORT}/startupz`);
    expect((await probe.json()).status).toBe('started');

    log('启动2', { totalMs, deployStatus: res.deployStatus, ownership: res.ownership, events });
  }, 900_000);

  it('启动 3：⭐ 拔盘后重启 —— 源完全不可达，仍用本机 cache 起网关', async () => {
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');
    const { readCurrentDeployment } = await import('../src/main/runtime/deploy.js');
    const locate = await import('../src/main/runtime/locate.js');

    // 「拔盘」= 让**所有**发现路径都指不到源：换 cwd（向上的 dev 查找找不到）、
    // 环境变量指到不存在的目录、可移动盘为空。不删任何东西。
    const away = freshDir('unplugged-cwd');
    const prevCwd = process.cwd();
    const prevEnv = process.env.CLAWWORK_RUNTIME_DIR;
    process.chdir(away);
    process.env.CLAWWORK_RUNTIME_DIR = path.join(away, 'definitely-not-here');

    try {
      // 先证明"确实找不到源"（而不是碰巧没去找）
      const candidates = locate.candidateRuntimeRoots({
        envDir: process.env.CLAWWORK_RUNTIME_DIR,
        devRoots: locate.findDevRuntimeRoots(process.cwd()),
        drives: [],
      });
      expect(locate.findRuntimeRoot(candidates)).toBeNull();
      console.log('  已确认：所有来源都不可达');

      const cur = readCurrentDeployment(userDataDir);
      expect(cur.status).toBe('ok');
      expect(cur.deploymentKey).toBe(deploymentKey);
      expect(cur.nodePath).toBe(deployedNodePath);
      expect(sha256File(cur.nodePath!)).toBe(readStamp(deployedRoot).nodeSha256);

      const events: string[] = [];
      const res = await bootstrapLocalGatewayRuntime({ userDataDir, deps: { log: (e) => events.push(e) } });

      expect(res.ok, `bootstrap 失败：${res.reason}`).toBe(true);
      expect(res.deploymentKey).toBe(deploymentKey);
      expect(res.deployStatus).toBe('skipped');
      expect(res.nodeExe).toBe(deployedNodePath); // 用的是本机那个 node
      expect(res.ownership).toBe('reused');

      const probe = await fetch(`http://127.0.0.1:${GATEWAY_WS_PORT}/startupz`);
      expect((await probe.json()).status).toBe('started');

      log('启动3.拔盘', {
        sourceReachable: false,
        deployStatus: res.deployStatus,
        usedNode: res.nodeExe,
        ownership: res.ownership,
        startupz: 'started',
      });
    } finally {
      process.chdir(prevCwd);
      if (prevEnv === undefined) delete process.env.CLAWWORK_RUNTIME_DIR;
      else process.env.CLAWWORK_RUNTIME_DIR = prevEnv;
    }
  }, 900_000);

  it('启动 4：⭐ foreign gateway 占端口 ⇒ 不 spawn / 不 force / 不 kill，报端口被占', async () => {
    const { bootstrapLocalGatewayRuntime, shutdownLocalGatewayRuntime } = await import('../src/main/runtime/index.js');
    const { GATEWAY_PORT_OCCUPIED } = await import('../src/main/runtime/gateway-process.js');

    // 先把自己那个停掉（ownership=spawned ⇒ 允许停），把端口让出来
    await shutdownLocalGatewayRuntime();
    await new Promise((r) => setTimeout(r, 2500));

    const foreign = await startForeignGateway('started');
    try {
      const res = await bootstrapLocalGatewayRuntime({ userDataDir });

      expect(res.ok).toBe(false);
      expect(res.code).toBe(GATEWAY_PORT_OCCUPIED);
      expect(res.reason).toMatch(/18789/);

      // 对方**还在**（没被 kill、没被 force）
      expect(foreign.hits.length).toBeGreaterThan(0);
      const still = await fetch(`http://127.0.0.1:${GATEWAY_WS_PORT}/startupz`);
      expect((await still.json()).status).toBe('started');

      log('启动4.foreign', { ok: res.ok, code: res.code, foreignStillAlive: true, reason: res.reason });
    } finally {
      await new Promise<void>((r) => foreign.server.close(() => r()));
    }
  }, 900_000);

  it('⭐ foreign（端口活着但 status 不是 started）也不 spawn', async () => {
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');
    const { GATEWAY_PORT_OCCUPIED } = await import('../src/main/runtime/gateway-process.js');

    const foreign = await startForeignGateway('booting');
    try {
      const res = await bootstrapLocalGatewayRuntime({ userDataDir });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(GATEWAY_PORT_OCCUPIED);
      log('foreign.not-started', { ok: res.ok, code: res.code });
    } finally {
      await new Promise<void>((r) => foreign.server.close(() => r()));
    }
  }, 900_000);

  it('⭐ 半部署/断电恢复：tmp 残留 + 无 stamp 的 deployed ⇒ 清理并重新部署成功', async () => {
    const { ensureRuntimeDeployed } = await import('../src/main/runtime/deploy.js');
    const plan = await import('../src/main/runtime/manifest.js');

    const ud = freshDir('halfdeploy');
    const runtimeDir = path.join(ud, 'runtime');

    // 制造"上次解压到一半被强杀"的现场
    const leftover = path.join(runtimeDir, 'tmp', 'deploy-deadbeef-999-zzzz');
    fs.mkdirSync(leftover, { recursive: true });
    fs.writeFileSync(path.join(leftover, 'half.bin'), 'partial');

    const manifest = plan.parseManifest(JSON.parse(fs.readFileSync(SOURCE_MANIFEST, 'utf-8')));
    const runtime = plan.selectRuntimeVariant(manifest, process.platform, process.arch);
    const node = plan.selectNodeVariant(
      plan.parseNodeManifest(
        JSON.parse(fs.readFileSync(path.join(RUNTIME_OUT, 'node', 'node-manifest.json'), 'utf-8')),
      ),
      process.platform,
      process.arch,
    );

    // 再制造一个"目录在、凭据不在"的假部署
    const key = plan.computeDeploymentKey({
      version: runtime.version,
      archiveSha256: runtime.sha256,
      nodeVersion: node.version,
      nodeSha256: node.sha256,
      platform: runtime.platform,
      arch: runtime.arch,
      schemaVersion: plan.DEPLOYMENT_SCHEMA_VERSION,
    });
    const fake = path.join(runtimeDir, 'deployed', key);
    fs.mkdirSync(fake, { recursive: true });
    fs.writeFileSync(path.join(fake, 'junk.txt'), 'from a half-dead run');

    const deploy = await ensureRuntimeDeployed({
      userDataDir: ud,
      runtimeRoot: RUNTIME_OUT,
      runtime,
      node,
      manifestPath: SOURCE_MANIFEST,
    });

    expect(deploy.status).toBe('deployed');
    expect(fs.existsSync(leftover)).toBe(false);
    expect(fs.existsSync(path.join(fake, 'junk.txt'))).toBe(false);
    expect(fs.existsSync(path.join(fake, '.clawwork-runtime.json'))).toBe(true);
    expect(fs.existsSync(path.join(fake, 'node', 'node.exe'))).toBe(true);

    log('半部署恢复', { leftoverCleaned: true, redeployed: true, key });
  }, 900_000);

  it('⭐ Node 缺失 + 源不可达 ⇒ 判损坏并明确失败，**不偷偷**换别的 Node', async () => {
    const { readCurrentDeployment, ensureRuntimeDeployed } = await import('../src/main/runtime/deploy.js');
    const { bootstrapLocalGatewayRuntime } = await import('../src/main/runtime/index.js');
    const plan = await import('../src/main/runtime/manifest.js');

    const ud = freshDir('nodemissing');
    const manifest = plan.parseManifest(JSON.parse(fs.readFileSync(SOURCE_MANIFEST, 'utf-8')));
    const runtime = plan.selectRuntimeVariant(manifest, process.platform, process.arch);
    const node = plan.selectNodeVariant(
      plan.parseNodeManifest(
        JSON.parse(fs.readFileSync(path.join(RUNTIME_OUT, 'node', 'node-manifest.json'), 'utf-8')),
      ),
      process.platform,
      process.arch,
    );
    const deploy = await ensureRuntimeDeployed({
      userDataDir: ud,
      runtimeRoot: RUNTIME_OUT,
      runtime,
      node,
      manifestPath: SOURCE_MANIFEST,
    });

    // 把部署里的 node 弄丢
    fs.rmSync(path.join(deploy.deployedRoot, 'node', 'node.exe'));

    const cur = readCurrentDeployment(ud);
    expect(cur.status).toBe('invalid');
    expect(cur.reason).toBe('node-missing');
    expect(cur.nodePath).toBeUndefined();

    // 源不可达 + 缓存损坏 ⇒ 明确失败，且**没有**起网关（也就不会偷偷用别的 node）
    const away = freshDir('nodemissing-cwd');
    const prevCwd = process.cwd();
    const prevEnv = process.env.CLAWWORK_RUNTIME_DIR;
    process.chdir(away);
    process.env.CLAWWORK_RUNTIME_DIR = path.join(away, 'nope');
    let started = false;
    try {
      const res = await bootstrapLocalGatewayRuntime({
        userDataDir: ud,
        deps: {
          startGateway: async () => {
            started = true;
            throw new Error('不该走到起网关这步');
          },
        },
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBeTruthy();
      expect(started).toBe(false);
      log('Node缺失', { cacheReason: cur.reason, bootstrapOk: res.ok, reason: res.reason });
    } finally {
      process.chdir(prevCwd);
      if (prevEnv === undefined) delete process.env.CLAWWORK_RUNTIME_DIR;
      else process.env.CLAWWORK_RUNTIME_DIR = prevEnv;
    }
  }, 900_000);

  it('⭐ current 指针：两个部署同时存在，只认指针指的那个；它坏了不偷偷换另一个', async () => {
    const { ensureRuntimeDeployed, readCurrentDeployment, writeCurrentPointer, deployedRootFor } =
      await import('../src/main/runtime/deploy.js');
    const plan = await import('../src/main/runtime/manifest.js');

    const ud = freshDir('pointer');
    const manifest = plan.parseManifest(JSON.parse(fs.readFileSync(SOURCE_MANIFEST, 'utf-8')));
    const runtime = plan.selectRuntimeVariant(manifest, process.platform, process.arch);
    const nodeA = plan.selectNodeVariant(
      plan.parseNodeManifest(
        JSON.parse(fs.readFileSync(path.join(RUNTIME_OUT, 'node', 'node-manifest.json'), 'utf-8')),
      ),
      process.platform,
      process.arch,
    );

    // A：正常部署
    const a = await ensureRuntimeDeployed({
      userDataDir: ud,
      runtimeRoot: RUNTIME_OUT,
      runtime,
      node: nodeA,
      manifestPath: SOURCE_MANIFEST,
    });

    // B：伪造"另一个 Node"（只改 sha ⇒ 不同 key），造目录而不是再解压一遍
    const nodeB = { ...nodeA, version: '26.9.9', sha256: 'b'.repeat(64) };
    const keyB = plan.computeDeploymentKey({
      version: runtime.version,
      archiveSha256: runtime.sha256,
      nodeVersion: nodeB.version,
      nodeSha256: nodeB.sha256,
      platform: runtime.platform,
      arch: runtime.arch,
      schemaVersion: plan.DEPLOYMENT_SCHEMA_VERSION,
    });
    const rootB = deployedRootFor(ud, keyB);
    fs.cpSync(a.deployedRoot, rootB, { recursive: true });
    const stampB = JSON.parse(fs.readFileSync(path.join(rootB, '.clawwork-runtime.json'), 'utf-8'));
    stampB.runtimeDeploymentKey = keyB;
    stampB.nodeVersion = nodeB.version;
    stampB.nodeSha256 = nodeB.sha256;
    fs.writeFileSync(path.join(rootB, '.clawwork-runtime.json'), JSON.stringify(stampB));

    expect(keyB).not.toBe(a.deploymentKey);
    expect(fs.existsSync(path.join(rootB, 'node', 'node.exe'))).toBe(true);

    // 指针指 A ⇒ 必须选 A（即使 B "更新"）
    writeCurrentPointer(ud, a.deploymentKey);
    const pickedA = readCurrentDeployment(ud);
    expect(pickedA.status).toBe('ok');
    expect(pickedA.deploymentKey).toBe(a.deploymentKey);
    expect(pickedA.nodePath!.startsWith(a.deployedRoot)).toBe(true);

    // 把 A 弄坏 ⇒ 必须 FAIL，**不能**偷偷选 B
    fs.rmSync(path.join(a.deployedRoot, 'node', 'node.exe'));
    const broken = readCurrentDeployment(ud);
    expect(broken.status).toBe('invalid');
    expect(broken.reason).toBe('node-missing');
    expect(broken.nodePath).toBeUndefined();
    expect(broken.deployedRoot).toBe(a.deployedRoot);

    log('current指针', { pickedA: true, brokenFails: true, didNotSilentlyPickB: true });
  }, 900_000);
});
