import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CLAWROUTER_ENTRY } from '../../src/main/runtime/deploy.js';
import type { NodeVariant, RuntimeVariant } from '../../src/main/runtime/manifest.js';
import { computeDeploymentKey, DEPLOYMENT_SCHEMA_VERSION } from '../../src/main/runtime/manifest.js';
import type { SeedEntry } from './make-zip.js';
import { makeZip } from './make-zip.js';

/**
 * 运行时装载器各测试共用的 fixture：造一份"U 盘"（归档 + 随行 Node + manifest），
 * 并配好装载器的调用参数。
 *
 * ⚠️ 全部在调用方给的 mkdtemp 目录里活动，**绝不触碰**真实 `%APPDATA%`
 * （见 junction 事故：递归删除会沿着 Windows junction 进真实目录删真身）。
 */

/** 固定时钟，让 `deployedAt` / `updatedAt` 的断言可精确比对。 */
export const FIXTURE_NOW = new Date('2026-09-13T10:00:00.000Z');

export const DEFAULT_ENTRIES: SeedEntry[] = [
  { name: 'node_modules/' },
  { name: 'node_modules/openclaw/' },
  { name: 'node_modules/openclaw/openclaw.mjs', content: Buffer.from('export const entry = 1;\n') },
  { name: CLAWROUTER_ENTRY, content: Buffer.from('export const clawrouter = 1;\n') },
];

export function sha256File(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

export interface SourceFixture {
  root: string;
  archivePath: string;
  nodeExePath: string;
  manifestPath: string;
  runtime: RuntimeVariant;
  node: NodeVariant;
  /** 装载器**现算**的缓存目录名（≠ manifest 里那个占位，见下）。 */
  key: string;
}

export function buildSource(
  tmpRoot: string,
  opts: {
    dirName?: string;
    entries?: SeedEntry[];
    nodeContent?: Buffer;
    nodeVersion?: string;
    archiveName?: string;
  } = {},
): SourceFixture {
  const root = path.join(tmpRoot, opts.dirName ?? 'usb');
  const entries = opts.entries ?? DEFAULT_ENTRIES;
  const nodeContent = opts.nodeContent ?? Buffer.from('MZ fake node binary\n');
  const archiveName = opts.archiveName ?? 'openclaw-runtime-2026.9.3.7z';

  const archivePath = path.join(root, 'win32-x64', archiveName);
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, makeZip(entries));

  const nodeExePath = path.join(root, 'node', 'node.exe');
  fs.mkdirSync(path.dirname(nodeExePath), { recursive: true });
  fs.writeFileSync(nodeExePath, nodeContent);
  fs.writeFileSync(path.join(root, 'node', 'LICENSE'), 'MIT\n');

  const manifestPath = path.join(root, 'openclaw-runtime-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ formatVersion: 1, packageName: 'openclaw' }, null, 2));

  const runtime: RuntimeVariant = {
    platform: 'win32',
    arch: 'x64',
    version: '2026.9.3',
    // ⚠️ 打包器写的占位（实测 `pack-runtime.mjs:107` 就是 `version`）—— **不含 Node**，
    //    所以装载器不能拿它当缓存目录名，必须自己 computeDeploymentKey。
    runtimeDeploymentKey: '2026.9.3',
    archive: `win32-x64/${archiveName}`,
    archiveSize: fs.statSync(archivePath).size,
    extractor: 'win32-x64/extractor/7za.exe',
    size: 0,
    fileCount: entries.length,
    packageRoot: 'node_modules/openclaw',
    cliPath: 'node_modules/openclaw/openclaw.mjs',
    source: 'test',
    sha256: sha256File(archivePath),
  };

  const node: NodeVariant = {
    platform: 'win32',
    arch: 'x64',
    version: opts.nodeVersion ?? '26.3.1',
    path: 'node/node.exe',
    sha256: sha256File(nodeExePath),
    size: nodeContent.length,
    source: 'test',
  };

  const key = computeDeploymentKey({
    version: runtime.version,
    archiveSha256: runtime.sha256,
    nodeVersion: node.version,
    nodeSha256: node.sha256,
    platform: runtime.platform,
    arch: runtime.arch,
    schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
  });

  return { root, archivePath, nodeExePath, manifestPath, runtime, node, key };
}

/** 新建一个空的 userData 目录（模拟"新用户"，而不是去删真实 profile）。 */
export function newUserData(tmpRoot: string, name: string): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function deployOpts(fx: SourceFixture, userDataDir: string) {
  return {
    userDataDir,
    runtimeRoot: fx.root,
    runtime: fx.runtime,
    node: fx.node,
    manifestPath: fx.manifestPath,
    now: () => FIXTURE_NOW,
  };
}
