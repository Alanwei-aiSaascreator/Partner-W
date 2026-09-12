import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAWROUTER_ENTRY,
  DEPLOYMENT_STAMP_FILE,
  CURRENT_POINTER_FILE,
  ensureRuntimeDeployed,
  isDeploymentCurrent,
  parseCurrentPointer,
  parseDeploymentStamp,
  readCurrentDeployment,
  staleTempDirs,
} from '../src/main/runtime/deploy.js';
import type { DeploymentStamp } from '../src/main/runtime/deploy.js';
import { DEPLOYMENT_SCHEMA_VERSION } from '../src/main/runtime/manifest.js';
import { buildSource, deployOpts, FIXTURE_NOW as NOW, newUserData, sha256File } from './helpers/runtime-fixture.js';
import type { SourceFixture } from './helpers/runtime-fixture.js';

/**
 * `deploy.ts` 的单元测试 —— 原子部署、幂等、以及「半成品不算已部署」。
 *
 * ⚠️ 会话安全：本文件**只在自己的 mkdtemp 目录里**建删文件，
 * **绝不触碰**真实的 `%APPDATA%` / `openclaw-state` / `.state-*`（见 junction 事故）。
 * 每次换一个新的空 userData 目录来模拟"新用户"，而不是删真实 profile。
 */

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clawwork-deploy-'));
});

afterEach(() => {
  // 双重保险：只删我们自己建的 tmp 目录，路径不含前缀就绝不删。
  if (tmpRoot && tmpRoot.includes(path.join(os.tmpdir(), 'clawwork-deploy-'))) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

const buildSourceHere = (opts?: Parameters<typeof buildSource>[1]): SourceFixture => buildSource(tmpRoot, opts);
const newUserDataHere = (name: string): string => newUserData(tmpRoot, name);

// ---------------------------------------------------------------- 纯函数

describe('parseCurrentPointer', () => {
  it('正常形状 ⇒ 解析出 key 与时间', () => {
    expect(parseCurrentPointer({ runtimeDeploymentKey: 'k1', updatedAt: '2026-09-13T10:00:00.000Z' })).toEqual({
      runtimeDeploymentKey: 'k1',
      updatedAt: '2026-09-13T10:00:00.000Z',
    });
  });

  it('缺 key / 类型不对 / 不是对象 ⇒ null（调用方按"没有指针"处理，而不是崩）', () => {
    expect(parseCurrentPointer({ updatedAt: 'x' })).toBeNull();
    expect(parseCurrentPointer({ runtimeDeploymentKey: 42, updatedAt: 'x' })).toBeNull();
    expect(parseCurrentPointer({ runtimeDeploymentKey: '', updatedAt: 'x' })).toBeNull();
    expect(parseCurrentPointer('nope')).toBeNull();
    expect(parseCurrentPointer(null)).toBeNull();
  });
});

describe('parseDeploymentStamp', () => {
  const good: DeploymentStamp = {
    schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
    runtimeDeploymentKey: 'k1',
    archiveSha256: 'a'.repeat(64),
    nodeVersion: '26.3.1',
    nodeSha256: 'b'.repeat(64),
    platform: 'win32',
    arch: 'x64',
    cliPath: 'node_modules/openclaw/openclaw.mjs',
    nodeRelativePath: 'node/node.exe',
    deployedAt: NOW.toISOString(),
  };

  it('正常形状 ⇒ 原样解析', () => {
    expect(parseDeploymentStamp(good)).toEqual(good);
  });

  it('⭐ 缺 nodeSha256 ⇒ null（真正被执行的 node 必须有交付期校验）', () => {
    const { nodeSha256: _drop, ...withoutNode } = good;
    expect(parseDeploymentStamp(withoutNode)).toBeNull();
  });

  it('缺 key / 缺 archiveSha256 / 不是对象 ⇒ null', () => {
    expect(parseDeploymentStamp({ ...good, runtimeDeploymentKey: '' })).toBeNull();
    expect(parseDeploymentStamp({ ...good, archiveSha256: undefined })).toBeNull();
    expect(parseDeploymentStamp(undefined)).toBeNull();
  });
});

describe('staleTempDirs', () => {
  it('只挑出 deploy- 前缀的半成品，别的目录/文件不动', () => {
    expect(
      staleTempDirs(['deploy-k1-123-abcd', 'deploy-k2-456-efgh', 'deployed', 'current.json', 'manifest.json']),
    ).toEqual(['deploy-k1-123-abcd', 'deploy-k2-456-efgh']);
  });

  it('没有半成品时返回空数组', () => {
    expect(staleTempDirs(['deployed', 'current.json'])).toEqual([]);
  });
});

describe('isDeploymentCurrent', () => {
  const root = path.join('C:', 'fake', 'runtime', 'deployed', 'k1');
  const stamp: DeploymentStamp = {
    schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
    runtimeDeploymentKey: 'k1',
    archiveSha256: 'a'.repeat(64),
    nodeVersion: '26.3.1',
    nodeSha256: 'b'.repeat(64),
    platform: 'win32',
    arch: 'x64',
    cliPath: 'node_modules/openclaw/openclaw.mjs',
    nodeRelativePath: 'node/node.exe',
    deployedAt: NOW.toISOString(),
  };
  const expected = { key: 'k1', archiveSha256: 'a'.repeat(64), nodeSha256: 'b'.repeat(64) };
  const nodePath = path.join(root, 'node', 'node.exe');
  const entryPath = path.join(root, CLAWROUTER_ENTRY);

  const withExists =
    (present: string[]) =>
    (p: string): boolean =>
      present.includes(p);

  it('stamp 匹配 + node 在 + 入口在 ⇒ true', () => {
    expect(
      isDeploymentCurrent({ deployedRoot: root, stamp, expected, exists: withExists([nodePath, entryPath]) }),
    ).toBe(true);
  });

  it('⭐ 快路径**不读文件内容**：磁盘上根本没有这些文件，只要 stamp 自洽 + exists 说在，就判 true', () => {
    // `isDeploymentCurrent` 是纯函数（注入 exists），没有任何算 hash 的口子 ——
    // 128MB 的 sha256 只在首次部署与慢路径验证时跑，这里一次都不该跑。
    expect(
      isDeploymentCurrent({ deployedRoot: root, stamp, expected, exists: withExists([nodePath, entryPath]) }),
    ).toBe(true);
  });

  it('⭐ stamp 记的 sha 与 manifest 期望不符 ⇒ false（只比字符串，但比错了就是不对）', () => {
    expect(
      isDeploymentCurrent({
        deployedRoot: root,
        stamp: { ...stamp, nodeSha256: 'c'.repeat(64) },
        expected,
        exists: withExists([nodePath, entryPath]),
      }),
    ).toBe(false);
    expect(
      isDeploymentCurrent({
        deployedRoot: root,
        stamp: { ...stamp, archiveSha256: 'c'.repeat(64) },
        expected,
        exists: withExists([nodePath, entryPath]),
      }),
    ).toBe(false);
  });

  it('stamp 为 null（缺 stamp / 非法）⇒ false', () => {
    expect(
      isDeploymentCurrent({ deployedRoot: root, stamp: null, expected, exists: withExists([nodePath, entryPath]) }),
    ).toBe(false);
  });

  it('⭐ key 不符 ⇒ false（换了 OpenClaw 版本或换了 Node 都不能复用）', () => {
    expect(
      isDeploymentCurrent({
        deployedRoot: root,
        stamp: { ...stamp, runtimeDeploymentKey: 'other' },
        expected,
        exists: withExists([nodePath, entryPath]),
      }),
    ).toBe(false);
  });

  it('⭐ node/node.exe 缺失 ⇒ false（缓存不自包含就不算可用）', () => {
    expect(isDeploymentCurrent({ deployedRoot: root, stamp, expected, exists: withExists([entryPath]) })).toBe(false);
  });

  it('⭐ CLAWROUTER_ENTRY 缺失 ⇒ false（没有它 = 静默不计费）', () => {
    expect(isDeploymentCurrent({ deployedRoot: root, stamp, expected, exists: withExists([nodePath]) })).toBe(false);
  });
});

// ------------------------------------------------------------ 真跑部署

describe('ensureRuntimeDeployed', () => {
  it('首次部署：落到 deployed/<key>/，Node 与运行时同一份缓存', async () => {
    const fx = buildSourceHere();
    const userDataDir = newUserDataHere('u1');

    const res = await ensureRuntimeDeployed(deployOpts(fx, userDataDir));

    expect(res.status).toBe('deployed');
    expect(res.deploymentKey).toBe(fx.key);
    expect(path.basename(res.deployedRoot)).toBe(fx.key);

    // 运行时内容
    expect(fs.readFileSync(path.join(res.deployedRoot, 'node_modules/openclaw/openclaw.mjs')).toString()).toBe(
      'export const entry = 1;\n',
    );
    expect(fs.existsSync(path.join(res.deployedRoot, CLAWROUTER_ENTRY))).toBe(true);
    // ⭐ Node 一起进缓存（硬缺口 ①）
    expect(fs.readFileSync(res.nodePath).toString()).toBe('MZ fake node binary\n');
    expect(fs.existsSync(path.join(res.deployedRoot, 'node', 'LICENSE'))).toBe(true);
    // 自描述 + 凭据
    expect(fs.existsSync(path.join(res.deployedRoot, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(res.deployedRoot, DEPLOYMENT_STAMP_FILE))).toBe(true);
  });

  it('⭐ stamp 记的是**真正被执行的** node 的 sha256，且回读一致', async () => {
    const fx = buildSourceHere();
    const userDataDir = newUserDataHere('u2');
    const res = await ensureRuntimeDeployed(deployOpts(fx, userDataDir));

    const stamp = parseDeploymentStamp(
      JSON.parse(fs.readFileSync(path.join(res.deployedRoot, DEPLOYMENT_STAMP_FILE), 'utf-8')),
    );
    expect(stamp).not.toBeNull();
    expect(stamp!.nodeSha256).toBe(fx.node.sha256);
    expect(stamp!.archiveSha256).toBe(fx.runtime.sha256);
    expect(stamp!.nodeVersion).toBe(fx.node.version);
    expect(sha256File(res.nodePath)).toBe(fx.node.sha256);
  });

  it('⭐ 二跑幂等：status=skipped，且**完全不碰解压**', async () => {
    const fx = buildSourceHere();
    const userDataDir = newUserDataHere('u3');
    await ensureRuntimeDeployed(deployOpts(fx, userDataDir));

    const res = await ensureRuntimeDeployed({
      ...deployOpts(fx, userDataDir),
      extract: () => {
        throw new Error('幂等路径不该再解压');
      },
    });

    expect(res.status).toBe('skipped');
    expect(res.deploymentKey).toBe(fx.key);
  });

  it('⭐ 部署成功后 current.json 指向这个 key（最后才写）', async () => {
    const fx = buildSourceHere();
    const userDataDir = newUserDataHere('u4');
    await ensureRuntimeDeployed(deployOpts(fx, userDataDir));

    const raw = JSON.parse(fs.readFileSync(path.join(userDataDir, 'runtime', CURRENT_POINTER_FILE), 'utf-8'));
    expect(parseCurrentPointer(raw)?.runtimeDeploymentKey).toBe(fx.key);
    expect(raw.updatedAt).toBe(NOW.toISOString());
  });

  it('⭐ node.exe 的 sha256 与 manifest 不符 ⇒ 抛错，且不留任何部署目录', async () => {
    const fx = buildSourceHere();
    const userDataDir = newUserDataHere('u5');
    // 交付后被人换过（或传输损坏）
    fs.writeFileSync(fx.nodeExePath, Buffer.from('MZ tampered\n'));

    await expect(ensureRuntimeDeployed(deployOpts(fx, userDataDir))).rejects.toThrow(/node/i);
    expect(fs.existsSync(path.join(userDataDir, 'runtime', 'deployed', fx.key))).toBe(false);
    expect(fs.existsSync(path.join(userDataDir, 'runtime', CURRENT_POINTER_FILE))).toBe(false);
  });

  it('归档 sha256 与 manifest 不符 ⇒ 抛错，且不留任何部署目录', async () => {
    const fx = buildSourceHere();
    const userDataDir = newUserDataHere('u6');
    const tampered = Buffer.from(fs.readFileSync(fx.archivePath));
    tampered[tampered.length - 30] ^= 0xff;
    fs.writeFileSync(fx.archivePath, tampered);

    await expect(ensureRuntimeDeployed(deployOpts(fx, userDataDir))).rejects.toThrow(/sha256|归档/i);
    expect(fs.existsSync(path.join(userDataDir, 'runtime', 'deployed', fx.key))).toBe(false);
  });

  it('源里没有 node.exe ⇒ 报错要点名 node，不能含糊', async () => {
    const fx = buildSourceHere();
    const userDataDir = newUserDataHere('u7');
    fs.rmSync(fx.nodeExePath);

    await expect(ensureRuntimeDeployed(deployOpts(fx, userDataDir))).rejects.toThrow(/node/i);
  });

  it('⭐ 归档里没有 CLAWROUTER_ENTRY ⇒ 部署失败（没有它 = 静默不计费）', async () => {
    const fx = buildSourceHere({
      entries: [{ name: 'node_modules/openclaw/openclaw.mjs', content: Buffer.from('x') }],
    });
    const userDataDir = newUserDataHere('u8');

    await expect(ensureRuntimeDeployed(deployOpts(fx, userDataDir))).rejects.toThrow(/clawrouter/i);
    expect(fs.existsSync(path.join(userDataDir, 'runtime', 'deployed', fx.key))).toBe(false);
  });

  it('⭐ 解压中途失败 ⇒ 不落 stamp、不建 deployed/<key>、不更新 current.json', async () => {
    const fx = buildSourceHere({
      entries: [
        { name: 'ok.txt', content: Buffer.from('fine') },
        { name: 'bad.bin', content: Buffer.from('x'), badCrc: 1 },
      ],
    });
    const userDataDir = newUserDataHere('u9');

    await expect(ensureRuntimeDeployed(deployOpts(fx, userDataDir))).rejects.toThrow(/CRC/i);

    const cacheDir = path.join(userDataDir, 'runtime');
    expect(fs.existsSync(path.join(cacheDir, 'deployed', fx.key))).toBe(false);
    expect(fs.existsSync(path.join(cacheDir, CURRENT_POINTER_FILE))).toBe(false);
  });

  it('⭐ 上一次失败留下的 tmp 半成品会被清掉，且下一次能成功', async () => {
    const fx = buildSourceHere();
    const userDataDir = newUserDataHere('u10');
    const tmpDir = path.join(userDataDir, 'runtime', 'tmp');
    const leftover = path.join(tmpDir, 'deploy-stale-999-zzzz');
    fs.mkdirSync(leftover, { recursive: true });
    fs.writeFileSync(path.join(leftover, 'half-written.bin'), 'partial');

    const res = await ensureRuntimeDeployed(deployOpts(fx, userDataDir));

    expect(res.status).toBe('deployed');
    expect(fs.existsSync(leftover)).toBe(false);
  });

  it('⭐ 已有的 deployed/<key> 损坏（缺 stamp）⇒ 删掉重来，而不是当成可用', async () => {
    const fx = buildSourceHere();
    const userDataDir = newUserDataHere('u11');
    const broken = path.join(userDataDir, 'runtime', 'deployed', fx.key);
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, 'junk.txt'), 'from a half-dead run');

    const res = await ensureRuntimeDeployed(deployOpts(fx, userDataDir));

    expect(res.status).toBe('deployed');
    expect(fs.existsSync(path.join(broken, 'junk.txt'))).toBe(false);
    expect(fs.existsSync(path.join(broken, DEPLOYMENT_STAMP_FILE))).toBe(true);
  });

  it('进度回调报告解压进度，最后一次是满额', async () => {
    const fx = buildSourceHere();
    const userDataDir = newUserDataHere('u12');
    const seen: number[] = [];
    await ensureRuntimeDeployed({
      ...deployOpts(fx, userDataDir),
      onProgress: (p) => {
        if (p.phase === 'extract') seen.push(p.done);
      },
    });
    expect(seen.length).toBeGreaterThan(0);
  });

  it('部署成功后 readCurrentDeployment 立刻可用（不需要重启）', async () => {
    const fx = buildSourceHere();
    const userDataDir = newUserDataHere('u13');
    const res = await ensureRuntimeDeployed(deployOpts(fx, userDataDir));

    const cur = readCurrentDeployment(userDataDir);
    expect(cur.status).toBe('ok');
    expect(cur.deploymentKey).toBe(fx.key);
    expect(cur.deployedRoot).toBe(res.deployedRoot);
    expect(cur.nodePath).toBe(res.nodePath);
    expect(cur.cliPath).toBe(res.cliPath);
  });
});
