/**
 * 本机运行时缓存 —— 原子部署、幂等、以及一个**确定的** current 指针。
 *
 * 布局（`<userData>/runtime/`）：
 * ```
 *   current.json                    ← 指针：现在该跑哪一份（最后才更新）
 *   deployed/<runtimeDeploymentKey>/
 *     node/node.exe                 ← ⚠️ 随部署一起进来的 Node，运行期只用它
 *     node/LICENSE
 *     node_modules/...              ← OpenClaw 运行时本体
 *     manifest.json                 ← 从盘上拷来的缓存自描述
 *     .clawwork-runtime.json        ← 部署凭据（stamp），**最后写**
 *   tmp/deploy-<key>-<pid>-<rand>/  ← 半成品，永远不直接进 deployed/
 * ```
 *
 * ⚠️ **四条不显然但必须守的行为**（都是踩过或复审出来的）：
 *
 * ① **Node 必须一起进本机缓存**。只把 OpenClaw 解压进来、Node 留在盘上的话，
 *    「拔盘后用本机缓存继续」当场失效 —— 盘一拔就没有 node.exe 可执行了。
 *    所以 node 与 archive 解到**同一个 tmp**、最后一起原子 rename。
 *
 * ② **禁止对任何路径无脑 `rm -rf`**。本仓库有过 junction 事故：
 *    OpenClaw 相关目录可能含 Windows junction，递归删会沿着它进真实目录删真身。
 *    ⇒ 本模块每次递归删除前都走 `assertInside()` 确认目标在预期的父目录之内。
 *    单测/验收也**绝不**删真实 `%APPDATA%`，一律用隔离 userData 目录。
 *
 * ③ **指针不扫目录猜**。`deployed/` 里有几个目录、谁新谁旧，都不参与决策 ——
 *    只看 `current.json` 指谁。指针指向的那份坏了就**报错**（要求插盘重部署），
 *    绝不"顺手"换一个旧版本启起来（那会让用户跑在来路不明的运行时上）。
 *
 * ④ **快路径不重算 hash**。两个大 hash（128MB 归档 + ~100MB node）只在首次部署
 *    和慢路径验证时跑；启动热路径只比 `key` + 两个 `existsSync`。
 *
 * ⚠️ 关于 sha256 的**语义边界**：manifest 与归档都在可写的 U 盘上时，
 * 一致只能证明**没损坏/没被改过**，不构成发行方真实性 —— 那是签名 manifest 的事，
 * 不在本阶段。这里不假装它是签名验证。
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { writeJsonAtomic } from '../util/json-file.js';
import { computeDeploymentKey, DEPLOYMENT_SCHEMA_VERSION, resolveArchivePath, resolveNodePath } from './manifest.js';
import type { NodeVariant, RuntimeVariant } from './manifest.js';
import { extractArchive } from './unzip.js';
import type { ExtractOptions, ExtractResult } from './unzip.js';

/** 缓存根目录名（`<userData>/runtime`）。 */
export const RUNTIME_CACHE_DIR_NAME = 'runtime';
export const DEPLOYED_DIR_NAME = 'deployed';
export const TMP_DIR_NAME = 'tmp';
export const CURRENT_POINTER_FILE = 'current.json';
/** 部署凭据。「部署完成」的**唯一**标志 —— 它不在，这份部署就是半成品。 */
export const DEPLOYMENT_STAMP_FILE = '.clawwork-runtime.json';
export const CACHED_MANIFEST_FILE = 'manifest.json';
/** 部署后的 Node 目录名（与盘上 `<runtimeRoot>/node/` 同名，便于对照）。 */
export const DEPLOYED_NODE_DIR = 'node';
/** 半成品目录前缀 —— 启动时按它清理。 */
export const STALE_TEMP_PREFIX = 'deploy-';

/**
 * 中转计量的唯一入口。**部署完整性判据之一**：它不在 = clawrouter 不在
 * = 写进 models.providers.clawrouter 的配置会变成一个不带 models 的普通 provider
 * → 模型列表为空 → 调用根本不发到 relay → **静默不计费**。
 *
 * ⚠️ 这个字符串与 `scripts/pack-runtime.mjs:29` 是**同一份契约的两端**。
 * `scripts/` 不在 tsconfig 的 include 里（main 不能 import 构建脚本），
 * 所以靠 `test/runtime-constants-drift.test.ts` 读那个文件来钉住一致性（TDD #14）。
 */
export const CLAWROUTER_ENTRY = 'node_modules/openclaw/dist/extensions/clawrouter/index.js';

/** 部署凭据。写下它 = 「这份部署已经过 node + 入口 + hash 全部验证」。 */
export interface DeploymentStamp {
  schemaVersion: number;
  runtimeDeploymentKey: string;
  archiveSha256: string;
  nodeVersion: string;
  nodeSha256: string;
  platform: string;
  arch: string;
  /** 相对 `deployedRoot` 的网关入口（OpenClaw CLI）。 */
  cliPath: string;
  /** 相对 `deployedRoot` 的 node 可执行文件。 */
  nodeRelativePath: string;
  deployedAt: string;
}

export interface CurrentPointer {
  runtimeDeploymentKey: string;
  updatedAt: string;
}

// ---------------------------------------------------------------- 路径

export function runtimeCacheDir(userDataDir: string): string {
  return path.join(userDataDir, RUNTIME_CACHE_DIR_NAME);
}

export function deployedDirRoot(userDataDir: string): string {
  return path.join(runtimeCacheDir(userDataDir), DEPLOYED_DIR_NAME);
}

export function deployedRootFor(userDataDir: string, deploymentKey: string): string {
  return path.join(deployedDirRoot(userDataDir), deploymentKey);
}

export function tempDirRoot(userDataDir: string): string {
  return path.join(runtimeCacheDir(userDataDir), TMP_DIR_NAME);
}

export function currentPointerPath(userDataDir: string): string {
  return path.join(runtimeCacheDir(userDataDir), CURRENT_POINTER_FILE);
}

/**
 * 递归删除前的守卫：`child` 必须真的在 `parent` 之内。
 *
 * ⚠️ 这不是形式主义。本仓库有过 junction 事故（递归删沿着 Windows junction
 * 进了真实目录、删掉真身）。把"我打算删的这个路径确实在我造的目录里面"
 * 变成一行会抛错的断言，是唯一能防住"路径拼错一个变量"的东西。
 */
function assertInside(parent: string, child: string, what: string): void {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${what}：拒绝操作 ${child} —— 它不在 ${parent} 之内`);
  }
}

// ---------------------------------------------------------------- 解析

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyString(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** 非法形状一律返回 null（调用方按"没有指针"处理），**不抛** —— 启动路径上不该为此崩。 */
export function parseCurrentPointer(raw: unknown): CurrentPointer | null {
  if (!isRecord(raw)) return null;
  const key = nonEmptyString(raw, 'runtimeDeploymentKey');
  if (!key) return null;
  return { runtimeDeploymentKey: key, updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '' };
}

/**
 * 缺任一必填字段 ⇒ null。
 *
 * ⚠️ 刻意**不给默认值**：一个缺 `nodeSha256` 的 stamp 必须被判为非法，
 * 否则"真正被执行的 node.exe 没有交付期校验"会以最安静的方式回来。
 */
export function parseDeploymentStamp(raw: unknown): DeploymentStamp | null {
  if (!isRecord(raw)) return null;
  const schemaVersion = raw.schemaVersion;
  if (typeof schemaVersion !== 'number' || !Number.isFinite(schemaVersion)) return null;

  const runtimeDeploymentKey = nonEmptyString(raw, 'runtimeDeploymentKey');
  const archiveSha256 = nonEmptyString(raw, 'archiveSha256');
  const nodeVersion = nonEmptyString(raw, 'nodeVersion');
  const nodeSha256 = nonEmptyString(raw, 'nodeSha256');
  const platform = nonEmptyString(raw, 'platform');
  const arch = nonEmptyString(raw, 'arch');
  const cliPath = nonEmptyString(raw, 'cliPath');
  const nodeRelativePath = nonEmptyString(raw, 'nodeRelativePath');
  if (!runtimeDeploymentKey || !archiveSha256 || !nodeVersion || !nodeSha256) return null;
  if (!platform || !arch || !cliPath || !nodeRelativePath) return null;

  return {
    schemaVersion,
    runtimeDeploymentKey,
    archiveSha256,
    nodeVersion,
    nodeSha256,
    platform,
    arch,
    cliPath,
    nodeRelativePath,
    deployedAt: typeof raw.deployedAt === 'string' ? raw.deployedAt : '',
  };
}

/** `tmp/` 下的目录名里，哪些是上次留下的半成品（纯函数，便于单测）。 */
export function staleTempDirs(names: readonly string[]): string[] {
  return names.filter((name) => name.startsWith(STALE_TEMP_PREFIX));
}

// ---------------------------------------------------------------- 快路径判据

export interface DeploymentExpectation {
  key: string;
  archiveSha256: string;
  nodeSha256: string;
}

/**
 * 这份部署能不能直接用？
 *
 * ⚠️ **不重算任何 hash** —— 只做字符串比较与 `existsSync`（`exists` 可注入，便于单测）。
 * `key` 本身已经由两个 hash 算出来（见 `computeDeploymentKey`），所以 key 匹配
 * 就蕴含了"部署时校验过的那两个 hash 没变"。
 *
 * 三条同时成立才算可用：stamp 合法且与期望一致 **+ node 在** **+ clawrouter 入口在**。
 */
export function isDeploymentCurrent(opts: {
  deployedRoot: string;
  stamp: DeploymentStamp | null;
  expected: DeploymentExpectation;
  exists?: (p: string) => boolean;
  schemaVersion?: number;
}): boolean {
  const { deployedRoot, stamp, expected, exists = existsSync, schemaVersion = DEPLOYMENT_SCHEMA_VERSION } = opts;
  if (!stamp) return false;
  if (stamp.schemaVersion !== schemaVersion) return false;
  if (stamp.runtimeDeploymentKey !== expected.key) return false;
  if (stamp.archiveSha256 !== expected.archiveSha256) return false;
  if (stamp.nodeSha256 !== expected.nodeSha256) return false;
  if (!exists(path.join(deployedRoot, stamp.nodeRelativePath))) return false;
  if (!exists(path.join(deployedRoot, CLAWROUTER_ENTRY))) return false;
  return true;
}

// ---------------------------------------------------------------- 读 stamp / 指针

function readStampSync(deployedRoot: string): DeploymentStamp | null {
  const stampPath = path.join(deployedRoot, DEPLOYMENT_STAMP_FILE);
  if (!existsSync(stampPath)) return null;
  try {
    return parseDeploymentStamp(JSON.parse(readFileSync(stampPath, 'utf-8')));
  } catch {
    // 半截 JSON（掉电）同样算"没有凭据" —— 与"文件不存在"处理方式一致
    return null;
  }
}

function readCurrentPointer(userDataDir: string): CurrentPointer | null | 'invalid' {
  const p = currentPointerPath(userDataDir);
  if (!existsSync(p)) return null;
  try {
    const parsed = parseCurrentPointer(JSON.parse(readFileSync(p, 'utf-8')));
    return parsed ?? 'invalid';
  } catch {
    return 'invalid';
  }
}

// ---------------------------------------------------------------- 写指针

/**
 * 更新 current 指针（原子）。
 *
 * ⚠️ 只在「deploy + node 验证 + 入口验证全部成功」之后调用 —— 见 `ensureRuntimeDeployed`。
 */
export function writeCurrentPointer(
  userDataDir: string,
  deploymentKey: string,
  now: () => Date = () => new Date(),
): void {
  mkdirSync(runtimeCacheDir(userDataDir), { recursive: true });
  const pointer: CurrentPointer = { runtimeDeploymentKey: deploymentKey, updatedAt: now().toISOString() };
  writeJsonAtomic(currentPointerPath(userDataDir), pointer);
}

// ---------------------------------------------------------------- 读当前部署

export type CurrentDeploymentReason =
  | 'pointer-missing'
  | 'pointer-invalid'
  | 'stamp-missing'
  | 'node-missing'
  | 'entry-missing';

export interface CurrentDeployment {
  status: 'ok' | 'missing' | 'invalid';
  deploymentKey?: string;
  deployedRoot?: string;
  nodePath?: string;
  cliPath?: string;
  reason?: CurrentDeploymentReason;
  /** 给人看的短句（进日志/界面），**不用于分支**。 */
  message?: string;
}

const NEEDS_MEDIA = 'cached runtime invalid; runtime media required';

/**
 * 拔盘 fallback：只看指针，不看目录列表。
 *
 * ⚠️ 指针指向的那份坏了 ⇒ 返回 `invalid` 并**要求重插运行时盘**。
 * 绝不枚举 `deployed/` 去挑另一个"看起来能用"的 —— 那等于用用户上一次
 * 或别人的运行时悄悄启动，出问题时无从解释。
 */
export function readCurrentDeployment(userDataDir: string): CurrentDeployment {
  const pointer = readCurrentPointer(userDataDir);

  if (pointer === 'invalid') {
    return { status: 'invalid', reason: 'pointer-invalid', message: `本机缓存的指针文件损坏（${NEEDS_MEDIA}）` };
  }
  if (pointer === null) {
    return { status: 'missing', reason: 'pointer-missing', message: '本机还没部署过运行时（缺 current.json）' };
  }

  const key = pointer.runtimeDeploymentKey;
  const deployedRoot = deployedRootFor(userDataDir, key);
  const stamp = readStampSync(deployedRoot);
  if (!stamp) {
    return {
      status: 'invalid',
      deploymentKey: key,
      deployedRoot,
      reason: 'stamp-missing',
      message: `本机缓存的运行时不可用（缺部署凭据，${NEEDS_MEDIA}）`,
    };
  }

  const nodePath = path.join(deployedRoot, stamp.nodeRelativePath);
  const cliPath = path.join(deployedRoot, stamp.cliPath);
  if (!existsSync(nodePath)) {
    return {
      status: 'invalid',
      deploymentKey: key,
      deployedRoot,
      reason: 'node-missing',
      message: `本机缓存的运行时缺少 Node（${NEEDS_MEDIA}）`,
    };
  }
  if (!existsSync(path.join(deployedRoot, CLAWROUTER_ENTRY))) {
    return {
      status: 'invalid',
      deploymentKey: key,
      deployedRoot,
      reason: 'entry-missing',
      message: `本机缓存的运行时缺少 clawrouter 入口（${NEEDS_MEDIA}）`,
    };
  }

  return { status: 'ok', deploymentKey: key, deployedRoot, nodePath, cliPath };
}

// ---------------------------------------------------------------- 部署

/**
 * 「从盘上准备运行环境」这一步失败的公开归因码。
 *
 * ⚠️ 与"网关起不来"分档：那几类的出口是关掉别的程序 / 查激活，这一类的出口在**盘上**
 *    （插好盘 / 换回随附那块 / 解除写保护 / 换一份完整的运行时）。见 `@clawwork/shared`
 *    的 `GatewayFailureReason` 闭集。
 */
export const DEPLOY_FAILED_CODE = 'runtime.deploy-failed';

export interface DeployProgress {
  phase: 'verify' | 'extract' | 'node' | 'finalize';
  done: number;
  total: number;
}

export interface DeployOptions {
  /** `<userData>`：缓存写在它下面的 `runtime/`。 */
  userDataDir: string;
  /** 部署源（U 盘运行时根）。**运行期不再引用它**。 */
  runtimeRoot: string;
  runtime: RuntimeVariant;
  node: NodeVariant;
  /** 盘上的运行时 manifest，拷一份进缓存做自描述（可选）。 */
  manifestPath?: string;
  onProgress?: (p: DeployProgress) => void;
  /** 测试注入点：默认真解压。 */
  extract?: (o: ExtractOptions) => Promise<ExtractResult>;
  now?: () => Date;
}

export interface DeployResult {
  status: 'deployed' | 'skipped';
  deploymentKey: string;
  deployedRoot: string;
  /** 绝对路径，指向**本机缓存里**的 node（不是盘上那个）。 */
  nodePath: string;
  /** 绝对路径，指向**本机缓存里**的网关入口。 */
  cliPath: string;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

async function assertSha256(filePath: string, expected: string, what: string): Promise<void> {
  const actual = await sha256File(filePath);
  if (actual !== expected) {
    throw new Error(`${what} 的 sha256 与 manifest 不符（期望 ${expected}，实际 ${actual}）—— 文件已损坏或被改过`);
  }
}

async function copyIfExists(from: string, to: string): Promise<void> {
  if (!existsSync(from)) return;
  await fs.copyFile(from, to);
}

/*
 * Windows transient rename refusal and destination-ENOENT guard adapted from
 * graceful-fs 4.2.11, polyfills.js (https://github.com/isaacs/node-graceful-fs/blob/v4.2.11/polyfills.js).
 * The ISC License
 * Copyright (c) 2011-2022 Isaac Z. Schlueter, Ben Noordhuis, and Contributors
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
 * IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
async function renameDeployment(from: string, to: string): Promise<void> {
  const startedAt = performance.now();
  const retryLimitMs = 3_000;
  const attemptLimit = 8;
  let originalError: unknown;
  for (let attempt = 0; attempt < attemptLimit; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (attempt === 0) originalError = error;
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
        throw error;
      }
      const remainingMs = retryLimitMs - (performance.now() - startedAt);
      if (attempt + 1 === attemptLimit || remainingMs <= 0) throw originalError;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25 * 2 ** attempt, 1_000, remainingMs)));
      if (performance.now() - startedAt >= retryLimitMs) throw originalError;
      try {
        // A dangling junction is still an existing destination: do not follow it.
        await fs.lstat(to);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw originalError;
        if (performance.now() - startedAt >= retryLimitMs) throw originalError;
        continue;
      }
      // Do not replace a destination another deployment created while we yielded.
      throw originalError;
    }
  }
}

/** 清掉上一次留下的半成品目录。失败只记日志，**不阻塞**本次启动。 */
async function cleanStaleTemp(userDataDir: string): Promise<void> {
  const tmpRoot = tempDirRoot(userDataDir);
  let names: string[];
  try {
    names = await fs.readdir(tmpRoot);
  } catch {
    return; // 目录还不存在 = 第一次跑
  }
  for (const name of staleTempDirs(names)) {
    const target = path.join(tmpRoot, name);
    try {
      assertInside(tmpRoot, target, '清理半成品');
      await fs.rm(target, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      console.error('[runtime] 清理半成品失败（忽略，继续部署）:', err);
    }
  }
}

/**
 * 确保本机缓存里有一份**可直接运行**的部署，返回它的路径。
 *
 * 快路径（已部署且自洽）只比 key + 两个 `existsSync`；慢路径才解压 + 验两个 hash。
 *
 * ⚠️ 慢路径的顺序是刻意的：
 *   ① 先验**源**的 node 与归档 hash —— 2 分钟的首次解压不该在最后一秒才发现文件是坏的
 *   ② 解压与 Node 拷进**同一个** tmp
 *   ③ 验**将要被真正执行的那份** node（拷贝之后再验，覆盖传输损坏）
 *   ④ 入口必须在
 *   ⑤ stamp **最后写**
 *   ⑥ 原子 rename 换入
 *   ⑦ current.json 最后更新
 */
export async function ensureRuntimeDeployed(opts: DeployOptions): Promise<DeployResult> {
  const {
    userDataDir,
    runtimeRoot,
    runtime,
    node,
    manifestPath,
    onProgress,
    extract = extractArchive,
    now = () => new Date(),
  } = opts;

  // ⚠️ **不能用 `runtime.runtimeDeploymentKey`**：那是打包器写的占位（实测等于 version），
  //    不含 Node —— 换 Node 却复用旧缓存就会跑起缓存里那个旧 node.exe。
  const deploymentKey = computeDeploymentKey({
    version: runtime.version,
    archiveSha256: runtime.sha256,
    nodeVersion: node.version,
    nodeSha256: node.sha256,
    platform: runtime.platform,
    arch: runtime.arch,
    schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
  });

  const deployedRoot = deployedRootFor(userDataDir, deploymentKey);
  const expected: DeploymentExpectation = {
    key: deploymentKey,
    archiveSha256: runtime.sha256,
    nodeSha256: node.sha256,
  };

  // ---- 快路径 ----
  const existing = readStampSync(deployedRoot);
  if (isDeploymentCurrent({ deployedRoot, stamp: existing, expected }) && existing) {
    // 指针必须指回"我们决定要跑的那一份"，否则重启会拉起另一个版本。
    // （这一步不碰任何大文件，仍然是热路径。）
    const cur = readCurrentPointer(userDataDir);
    if (cur === null || cur === 'invalid' || cur.runtimeDeploymentKey !== deploymentKey) {
      writeCurrentPointer(userDataDir, deploymentKey, now);
    }
    return {
      status: 'skipped',
      deploymentKey,
      deployedRoot,
      nodePath: path.join(deployedRoot, existing.nodeRelativePath),
      cliPath: path.join(deployedRoot, existing.cliPath),
    };
  }

  // ---- 慢路径 ----
  const sourceNodePath = resolveNodePath(runtimeRoot, node);
  if (!existsSync(sourceNodePath)) {
    throw new Error(`运行时盘上找不到 Node 可执行文件：${sourceNodePath}（manifest 声明的是 ${node.path}）`);
  }
  const sourceArchivePath = resolveArchivePath(runtimeRoot, runtime);
  if (!existsSync(sourceArchivePath)) {
    throw new Error(`运行时盘上找不到归档：${sourceArchivePath}（manifest 声明的是 ${runtime.archive}）`);
  }

  // ⚠️ **先报一声再算 hash**：两次全量 sha256（128MB 归档 + ~100MB node）在慢盘上
  //    要几十秒 —— 第一条第 ① 步之后的回调要等它们都算完才发，那之前界面上是空的。
  onProgress?.({ phase: 'verify', done: 0, total: 2 });

  // ① 先验源：坏文件不该等到解压完才被发现
  await assertSha256(sourceNodePath, node.sha256, `node 可执行文件（${sourceNodePath}）`);
  await assertSha256(sourceArchivePath, runtime.sha256, `归档（${sourceArchivePath}）`);
  onProgress?.({ phase: 'verify', done: 2, total: 2 });

  await cleanStaleTemp(userDataDir);

  const tmpRoot = path.join(
    tempDirRoot(userDataDir),
    `${STALE_TEMP_PREFIX}${deploymentKey}-${process.pid}-${randomUUID().slice(0, 8)}`,
  );
  await fs.mkdir(tmpRoot, { recursive: true });

  try {
    // ② 解压运行时
    await extract({
      archivePath: sourceArchivePath,
      destDir: tmpRoot,
      onProgress: (done, total) => onProgress?.({ phase: 'extract', done, total }),
    });

    // ② Node 进**同一个** tmp（硬缺口 ①：本机缓存必须自包含）
    const deployedNodeDir = path.join(tmpRoot, DEPLOYED_NODE_DIR);
    await fs.mkdir(deployedNodeDir, { recursive: true });
    const nodeRelativePath = path.posix.join(DEPLOYED_NODE_DIR, path.basename(node.path));
    const deployedNodePath = path.join(tmpRoot, nodeRelativePath);
    await fs.copyFile(sourceNodePath, deployedNodePath);
    const sourceNodeDir = path.dirname(sourceNodePath);
    await copyIfExists(path.join(sourceNodeDir, 'LICENSE'), path.join(deployedNodeDir, 'LICENSE'));
    await copyIfExists(path.join(sourceNodeDir, 'LICENSE.txt'), path.join(deployedNodeDir, 'LICENSE.txt'));
    onProgress?.({ phase: 'node', done: 1, total: 1 });

    // ③ 验**将要被真正执行的那份**（拷贝之后再验，顺带覆盖传输损坏）
    await assertSha256(deployedNodePath, node.sha256, `部署后的 node 可执行文件（${deployedNodePath}）`);

    // ④ 入口必须在
    if (!existsSync(path.join(tmpRoot, CLAWROUTER_ENTRY))) {
      throw new Error(`归档里没有 clawrouter 入口（${CLAWROUTER_ENTRY}）—— 这份运行时不能用于中转计量，拒绝部署`);
    }

    // 缓存自描述
    if (manifestPath) {
      await copyIfExists(manifestPath, path.join(tmpRoot, CACHED_MANIFEST_FILE));
    }

    // ⑤ stamp **最后写**
    const stamp: DeploymentStamp = {
      schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
      runtimeDeploymentKey: deploymentKey,
      archiveSha256: runtime.sha256,
      nodeVersion: node.version,
      nodeSha256: node.sha256,
      platform: runtime.platform,
      arch: runtime.arch,
      cliPath: runtime.cliPath,
      nodeRelativePath,
      deployedAt: now().toISOString(),
    };
    await fs.writeFile(path.join(tmpRoot, DEPLOYMENT_STAMP_FILE), JSON.stringify(stamp, null, 2), 'utf-8');

    // ⑥ 原子换入：同一个 `runtime/` 下的 rename，同卷 ⇒ 原子
    if (existsSync(deployedRoot)) {
      assertInside(deployedDirRoot(userDataDir), deployedRoot, '替换损坏的部署目录');
      await fs.rm(deployedRoot, { recursive: true, force: true, maxRetries: 3 });
    }
    await fs.mkdir(deployedDirRoot(userDataDir), { recursive: true });
    await renameDeployment(tmpRoot, deployedRoot);
    onProgress?.({ phase: 'finalize', done: 1, total: 1 });
  } catch (err) {
    // 半成品必须清掉，且**不能**留下 deployed/<key>（没有 stamp 就永远不是"已部署"）
    try {
      assertInside(tempDirRoot(userDataDir), tmpRoot, '清理失败的半成品');
      await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 3 });
    } catch (cleanupErr) {
      console.error('[runtime] 清理半成品失败:', cleanupErr);
    }
    throw err;
  }

  // ⑦ 全部成功之后，才更新指针
  writeCurrentPointer(userDataDir, deploymentKey, now);

  return {
    status: 'deployed',
    deploymentKey,
    deployedRoot,
    nodePath: path.join(deployedRoot, path.posix.join(DEPLOYED_NODE_DIR, path.basename(node.path))),
    cliPath: path.join(deployedRoot, runtime.cliPath),
  };
}
