#!/usr/bin/env node
/**
 * 下载并固化一份**随运行时包分发**的 Node。
 *
 *   node scripts/fetch-node-runtime.mjs                      # 默认版本
 *   node scripts/fetch-node-runtime.mjs --version 26.3.1
 *   node scripts/fetch-node-runtime.mjs --verify-only        # 不下载，只验现有实物
 *
 * 为什么要单独一个脚本：Electron 内嵌的 Node 是 20.19.1，而 openclaw 要求
 * `>=24.16 <25 || >=26.1`（且用了 `node:sqlite`）—— 见 `runtime/node-runtime.ts`。
 * 客户端**必须**解析出一个外部 Node，而那个 Node 要跟着运行时一起进本机缓存。
 *
 * 产出布局（装载器已按这个形状锁契约）：
 *
 *   <out>/node/
 *     node.exe
 *     LICENSE
 *     node-manifest.json        ← 装载器靠它拿到 node 的身份
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ ⚠️ **官方 SHASUMS256.txt 校验的是下载 ZIP，不是解压后的 node.exe。** │
 * │   正确链路：                                                      │
 * │     ZIP → 验 SHASUMS256（证明**下载**没坏）                        │
 * │     → 解出 node.exe → **重新算 node.exe 自己的 sha256 + size**     │
 * │     → node-manifest.json 记的是 **node.exe 的** hash              │
 * │     → 装载器首次部署时再验一次（真正被执行的才是它）                │
 * │   **禁止**把 ZIP 的 hash 写进 `nodes[].sha256` —— 那样等于没验     │
 * │   真正被执行的东西，而校验还"看起来通过了"。                        │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ 本脚本不改 package-lock、不跑 npm、**不依赖运行它的机器上有没有 Node 运行时**
 *   （只用执行脚本的这个 Node 进程本身）。
 *
 * ⚠️ 失败时**绝不留下看着有效的 node/ 目录**：全程在 tmp 里做，只有
 *   「ZIP 校验通过 + node.exe 算过 hash + LICENSE 在 + manifest 自洽」全过，
 *   才原子换入 `<out>/node/`。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const DEFAULT_OUT = path.join(REPO_ROOT, 'runtime-out');

/** 默认版本。**必须落在 openclaw 公布的区间里** —— 有 openclaw 包时会自动断言。 */
const DEFAULT_VERSION = '26.3.1';
const DIST_BASE = 'https://nodejs.org/dist';

/** manifest 里的 path 是**相对运行时根**的。装载器 `resolveNodePath()` 就按它拼。 */
const NODE_RELATIVE_PATH = 'node/node.exe';

// ---------------------------------------------------------------- 纯函数

/**
 * 解析 `SHASUMS256.txt`。
 *
 * 格式是 `<64位hex>  <文件名>`（有的行是 ` *文件名`，二进制标记）。
 */
export function parseShasums(text) {
  const map = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line);
    if (m) map.set(m[2].trim(), m[1].toLowerCase());
  }
  return map;
}

/**
 * Node **下载包**里的平台标记。
 *
 * ⚠️ 和 `process.platform` **不是一回事**：Windows 上 process.platform 是 `win32`，
 * 但官方文件名是 `win-x64`。实测 `node-v26.3.1-win32-x64.zip` 直接 **404**，
 * 真名是 `node-v26.3.1-win-x64.zip`（2026-09-13 拉 dist 目录确认）。
 * 下载名与 manifest 里的 `platform`（要跟 process.platform 一致，装载器按它选变体）
 * 分属两套命名 —— 混用就会得到 404。
 */
export const DOWNLOAD_PLATFORM = { win32: 'win', darwin: 'darwin', linux: 'linux' };

/** 官方发布包的文件名（用**下载命名**）。 */
export function zipNameFor(version, platform, arch) {
  return `node-v${version}-${platformToken(platform)}-${arch}.zip`;
}

/** 解压后 zip 内部的那层目录名（同样用下载命名）。 */
export function innerDirName(version, platform, arch) {
  return `node-v${version}-${platformToken(platform)}-${arch}`;
}

function platformToken(platform) {
  return DOWNLOAD_PLATFORM[platform] ?? platform;
}

/**
 * 把「下载到的 ZIP 的 sha256」与官方清单比对，不符**抛错**。
 *
 * 这一步证明的是**下载没坏 / 没被中间人改**；它**不能**代替 node.exe 自己的 hash。
 */
export function assertZipMatches(shasums, zipName, actualSha256) {
  const expected = shasums.get(zipName);
  if (!expected) {
    throw new Error(`SHASUMS256.txt 里没有 ${zipName} —— 版本号写错了，或官方还没发布这个平台`);
  }
  if (expected !== actualSha256) {
    throw new Error(`ZIP 的 sha256 与官方清单不符（期望 ${expected}，实际 ${actualSha256}）—— 下载已损坏，拒绝使用`);
  }
  return expected;
}

/**
 * 构造 node-manifest.json。
 *
 * ⚠️ `sha256` 是**解压后 node.exe 自己的** hash，由调用方现算传入。
 * 这里刻意**不接受** ZIP 的 hash 作为参数 —— 不给"顺手传错"留口子。
 */
export function buildNodeManifest({ version, platform, arch, nodeExeSha256, nodeExeSize, source }) {
  return {
    formatVersion: 1,
    packageName: 'node',
    nodes: [
      {
        platform,
        arch,
        version,
        path: NODE_RELATIVE_PATH,
        sha256: nodeExeSha256,
        size: nodeExeSize,
        source,
      },
    ],
  };
}

/**
 * 校验一个**已存在的** `node/` 目录是否自洽（`--verify-only` 与换入前的最后一道关）。
 *
 * 纯读、不写 —— 返回问题清单而不是抛，方便一次把毛病都列出来。
 */
export function verifyNodeRuntime(nodeDir) {
  const problems = [];
  const manifestPath = path.join(nodeDir, 'node-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, problems: [`缺 node-manifest.json：${manifestPath}`], manifest: null, node: null };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    return { ok: false, problems: [`node-manifest.json 不是合法 JSON：${err.message}`], manifest: null, node: null };
  }

  const node = manifest?.nodes?.[0];
  if (!node) return { ok: false, problems: ['node-manifest.json 里没有 nodes[0]'], manifest, node: null };

  if (manifest.formatVersion !== 1) problems.push(`formatVersion 必须是 1，实际 ${manifest.formatVersion}`);
  if (node.path !== NODE_RELATIVE_PATH) problems.push(`nodes[0].path 必须是 ${NODE_RELATIVE_PATH}，实际 ${node.path}`);

  const exePath = path.join(nodeDir, 'node.exe');
  const licensePath = path.join(nodeDir, 'LICENSE');

  if (!fs.existsSync(exePath)) problems.push(`缺 node.exe：${exePath}`);
  if (!fs.existsSync(licensePath)) problems.push(`缺 LICENSE：${licensePath}（分发 Node 必须带许可）`);

  if (fs.existsSync(exePath)) {
    const actualSize = fs.statSync(exePath).size;
    const actualSha = sha256File(exePath);
    if (actualSha !== node.sha256) {
      problems.push(`node.exe 的 sha256 与 manifest 不符（实际 ${actualSha}，manifest ${node.sha256}）`);
    }
    if (actualSize !== node.size) {
      problems.push(`node.exe 的体积与 manifest 不符（实际 ${actualSize}，manifest ${node.size}）`);
    }
  }

  return { ok: problems.length === 0, problems, manifest, node };
}

// ---------------------------------------------------------------- 有副作用

export function sha256File(file) {
  const h = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function sevenZip() {
  const candidates = ['C:/Program Files/7-Zip/7z.exe', 'C:/Program Files (x86)/7-Zip/7z.exe'];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('找不到 7z.exe（装 7-Zip，或改 sevenZip() 里的候选路径）');
  return found;
}

const quote = (s) => (/\s/.test(s) ? `"${s}"` : s);
function sh(cmd, args, opts = {}) {
  return execFileSync(quote(cmd), args.map(quote), { stdio: 'inherit', shell: true, ...opts });
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败 ${res.status} ${res.statusText}：${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

/**
 * 有 openclaw 包就顺手断言版本落在它公布的区间里。
 *
 * ⚠️ 区间**不硬编码**（上游会改），从 openclaw 自己的 `node-version.mjs` 读。
 * 找不到就**警告而不失败** —— 这个脚本要能在还没有 openclaw 产物的机器上跑。
 */
async function assertVersionSupportedByOpenclaw(version, explicitPkgRoot) {
  const candidates = [explicitPkgRoot, path.join(DEFAULT_OUT, 'openclaw-runtime', 'node_modules', 'openclaw')].filter(
    Boolean,
  );

  const pkgRoot = candidates.find((p) => fs.existsSync(path.join(p, 'node-version.mjs')));
  if (!pkgRoot) {
    console.warn(`⚠️  没找到 openclaw 的 node-version.mjs，跳过区间断言（无法确认 ${version} 可用）`);
    return;
  }

  const mod = await import(pathToFileURL(path.join(pkgRoot, 'node-version.mjs')).href);
  if (mod.isSupportedOpenClawNodeVersion(version) !== true) {
    throw new Error(
      `Node ${version} **不在** openclaw 支持的区间里：${mod.SUPPORTED_NODE_VERSIONS}\n` +
        '   换一个 --version，否则客户端拿到的是一个起不了网关的 Node。',
    );
  }
  console.log(`④ 版本断言：Node ${version} 在 openclaw 区间内（${mod.SUPPORTED_NODE_VERSIONS}）`);
}

function parseArgs(argv) {
  const args = { version: DEFAULT_VERSION, out: DEFAULT_OUT, verifyOnly: false, openclawPkg: null, keepTmp: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version') args.version = argv[++i];
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--verify-only') args.verifyOnly = true;
    else if (a === '--openclaw-pkg') args.openclawPkg = path.resolve(argv[++i]);
    else if (a === '--keep-tmp') args.keepTmp = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        '用法：node scripts/fetch-node-runtime.mjs [--version <v>] [--out <dir>] [--verify-only] [--openclaw-pkg <dir>]',
      );
      process.exit(0);
    } else {
      throw new Error(`不认识的参数：${a}`);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const platform = 'win32';
  const arch = 'x64';
  const nodeDir = path.join(args.out, 'node');

  // ---- --verify-only：不下载，只验现有实物 ----
  if (args.verifyOnly) {
    const res = verifyNodeRuntime(nodeDir);
    if (!res.ok) {
      console.error(`❌ ${nodeDir} 未通过校验：`);
      for (const p of res.problems) console.error(`   - ${p}`);
      process.exit(1);
    }
    console.log(`✅ ${nodeDir} 自洽`);
    console.log(`   Node    ${res.node.version} (${res.node.platform}/${res.node.arch})`);
    console.log(`   sha256  ${res.node.sha256}`);
    console.log(`   size    ${res.node.size}`);
    return;
  }

  const zipName = zipNameFor(args.version, platform, arch);
  const base = `${DIST_BASE}/v${args.version}`;
  const tmpDir = path.join(args.out, `.node-tmp-${process.pid}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    console.log(`① 下载 Node ${args.version}（${platform}/${arch}）…`);
    const zipPath = path.join(tmpDir, zipName);
    const shasumsPath = path.join(tmpDir, 'SHASUMS256.txt');
    await download(`${base}/${zipName}`, zipPath);
    await download(`${base}/SHASUMS256.txt`, shasumsPath);

    console.log('② 校验 ZIP 的 sha256（证明**下载**没坏 —— 不是 node.exe 的 hash）…');
    const shasums = parseShasums(fs.readFileSync(shasumsPath, 'utf-8'));
    const zipSha = sha256File(zipPath);
    assertZipMatches(shasums, zipName, zipSha);
    console.log(`   ZIP ok  ${zipSha}`);

    console.log('③ 解出 node.exe / LICENSE …');
    const sz = sevenZip();
    const inner = innerDirName(args.version, platform, arch);
    sh(sz, ['e', zipPath, `-o${tmpDir}`, '-y', `${inner}/node.exe`, `${inner}/LICENSE`]);

    const stagedDir = path.join(tmpDir, 'node');
    fs.mkdirSync(stagedDir, { recursive: true });
    for (const name of ['node.exe', 'LICENSE']) {
      const from = path.join(tmpDir, name);
      if (!fs.existsSync(from)) throw new Error(`解压后没有 ${name}（官方包结构变了？）`);
      fs.renameSync(from, path.join(stagedDir, name));
    }

    await assertVersionSupportedByOpenclaw(args.version, args.openclawPkg);

    // ⭐ 关键一步：算的是**解压后 node.exe 自己的** hash，不是 ZIP 的
    console.log('⑤ 计算 node.exe 自己的 sha256 / size …');
    const exePath = path.join(stagedDir, 'node.exe');
    const nodeExeSha256 = sha256File(exePath);
    const nodeExeSize = fs.statSync(exePath).size;
    if (nodeExeSha256 === zipSha) {
      throw new Error('node.exe 的 hash 与 ZIP 的 hash 相同 —— 这不可能，说明算错了对象');
    }

    const manifest = buildNodeManifest({
      version: args.version,
      platform,
      arch,
      nodeExeSha256,
      nodeExeSize,
      source: `${base}/${zipName}`,
    });
    fs.writeFileSync(path.join(stagedDir, 'node-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    console.log('⑥ 换入前再验一遍（这次是验**将要被装载器读到的**那份）…');
    const staged = verifyNodeRuntime(stagedDir);
    if (!staged.ok) throw new Error(`staged 目录没通过自检：\n   - ${staged.problems.join('\n   - ')}`);

    console.log('⑦ 原子换入 …');
    const oldDir = path.join(args.out, `.node-old-${process.pid}`);
    fs.rmSync(oldDir, { recursive: true, force: true });
    if (fs.existsSync(nodeDir)) fs.renameSync(nodeDir, oldDir);
    fs.renameSync(stagedDir, nodeDir);
    fs.rmSync(oldDir, { recursive: true, force: true });

    fs.rmSync(shasumsPath, { force: true });
    zipPath && fs.rmSync(zipPath, { force: true });

    console.log(
      `\n✅ 完成\n   目录   ${nodeDir}\n   版本   ${args.version} (${platform}/${arch})\n` +
        `   size   ${nodeExeSize}\n   sha256 ${nodeExeSha256}   ← node.exe 自己的（不是 ZIP 的 ${zipSha.slice(0, 16)}…）`,
    );
  } finally {
    // ⚠️ 任何失败都不能留下"看着有效"的实物：临时目录一律清掉
    if (!args.keepTmp) fs.rmSync(tmpDir, { recursive: true, force: true });
    else console.log(`（保留临时目录：${tmpDir}）`);
  }
}

// 只在被直接执行时跑 main，被 import 时（测试）不跑。
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`\n❌ ${err.message}`);
    process.exit(1);
  });
}
