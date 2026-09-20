#!/usr/bin/env node
/**
 * U 盘诊断（只读，给客户/同事跑的那种）。
 *
 * 用法（一般不用带参数）：
 *   node scripts/udisk-diagnose.mjs                    # 诊断"这个脚本所在的盘 + 这台机器"
 *   node scripts/udisk-diagnose.mjs --json             # 只打机器可读的事实（给测试/自己用）
 *   node scripts/udisk-diagnose.mjs --no-write-test    # 连那个几字节的探针文件都不建
 *   node scripts/udisk-diagnose.mjs --emit-tool <目录>  # 产出"交给同事的那个夹子"（.bat + 脚本 + 一句话说明）
 *
 * 给人用的那个夹子长这样（`--emit-tool` 生成）：
 *   <目录>\诊断.bat          ← 同事双击这个（纯 ASCII，自己去找 node.exe）
 *   <目录>\diagnose.mjs      ← 本文件
 *   <目录>\lib\udisk-diagnose.mjs
 *   <目录>\先看这里.txt       ← 一句话说明 + 回传哪个文件
 * 结果写在 `<目录>\荣盈魔方-诊断结果.txt`（UTF-8 带 BOM，记事本直接打开）。
 *
 * ⚠️ **只读**：唯一会写盘的一下是"在盘根建一个几字节的探针文件再立刻删掉"（测可写性），
 *    `--no-write-test` 可以关掉；报告里会照实写"没测"，不当成"没问题"。
 * ⚠️ 只在**报告**里出现的东西才可能含隐私；token 一类字段会被打码（见 lib 的 `redactSecrets`）。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  batSource,
  bucketOf,
  CLAWROUTER_ENTRY,
  classifyLink,
  CONFIG_FILE_NAME,
  CURRENT_POINTER_FILE,
  decidePortable,
  deliveryLayoutOf,
  DEPLOYMENT_STAMP_FILE,
  digestLine,
  MAX_DELIVERY_DEPTH,
  isBrokenLink,
  judgeDeployment,
  looksLikeBundledNode,
  looksWrong,
  peerLinkNeeded,
  POINTER_KEY_FIELD,
  readPointerKey,
  PORTABLE_WORKSPACE_DIR_NAME,
  redactSecrets,
  renderReport,
  REPORT_NAME,
  RUNTIME_MANIFEST_FILE,
  STATE_DIR_NAME,
  TOOL_BAT_NAME,
  TOOL_SCRIPT_NAME,
  userDataCandidates,
  WORKSPACE_MARKER_FILE,
} from './lib/udisk-diagnose.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT);
const LIB = path.join(SCRIPT_DIR, 'lib', 'udisk-diagnose.mjs');

const USAGE = [
  '用法：node scripts/udisk-diagnose.mjs [--here <目录>] [--volume-root <盘根>] [--appdata <目录>]',
  '                                  [--out <文件>] [--json] [--no-write-test] [--emit-tool <目录>]',
  '  （不带参数就是：诊断本脚本所在的盘 + 这台机器；只有 --json / --emit-tool 会改变行为）',
].join('\n');

// ───────────────────────────────── 小工具 ─────────────────────────────────

const exists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

function run(cmd, args, opts = {}) {
  try {
    return {
      ok: true,
      out: execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 15000, ...opts }).trim(),
    };
  } catch (err) {
    return { ok: false, out: '', err: err instanceof Error ? err.message : String(err) };
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** 读文件末尾若干字节再切行（日志可能上百 MB，不能整份读）。 */
function tailLines(file, bytes = 2 * 1024 * 1024) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - bytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8').split(/\r?\n/);
  } finally {
    fs.closeSync(fd);
  }
}

// ⚠️ 日志筛选的判据在 lib 里（`looksWrong`）：**看结构化字段**，不看文字里有没有 "error"
//    —— 本机实测：子串匹配会把 `tools.catalog` 那一大坨噪声占满 60 行配额，
//    真正的错误一条都露不出来。

// ───────────────────────────────── 事实采集 ─────────────────────────────────

function volumesOn() {
  // ⚠️ 开头那句是必须的：Windows PowerShell 5.1 的 stdout 默认按 OEM 码页（中文机 = GBK）吐，
  //    被 node 当 UTF-8 读 ⇒ 中文卷标变 `�¼Ӿ�`（本机实测）。先把它钉成 UTF-8。
  const q =
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
    'Get-CimInstance Win32_LogicalDisk | ForEach-Object { ' +
    '"$($_.DeviceID)|$($_.DriveType)|$($_.FileSystem)|$($_.Size)|$($_.FreeSpace)|$($_.VolumeName)" }';
  const res = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', q]);
  if (!res.ok) return { list: [], error: res.err ?? '枚举失败' };
  const list = [];
  for (const line of res.out.split(/\r?\n/)) {
    const [letter, driveType, fileSystem, size, free, label] = line.trim().split('|');
    if (!/^[A-Za-z]:$/.test(letter ?? '')) continue;
    const num = (v) => (/^\d+$/.test(v ?? '') ? Number(v) : null);
    list.push({
      letter,
      driveType: num(driveType),
      fileSystem: fileSystem || null,
      totalBytes: num(size),
      freeBytes: num(free),
      label: label || null,
    });
  }
  return { list, error: null };
}

/**
 * 交付夹的**候选目录**：盘根 + 它下面 ≤`MAX_DELIVERY_DEPTH` 层（浅的先试）。
 *
 * ⚠️ 必须有这一层深度：交付包解压到盘根之后是
 *    `<盘根>\荣盈魔方U盘交付-0.0.24\荣盈魔方\resources\runtime\…` —— 夹子在盘根下**两层**。
 *    只扫一层的话，工具会对着**判据本来要救的那种盘**说"没找到随包程序目录"
 *    （本机 e2e 测试 ⑩b 当场抓到的就是这个：判据说"认"，扫描说"没找到"）。
 */
function deliveryCandidateDirs(volumeRoot) {
  const out = [volumeRoot];
  let level = [volumeRoot];
  for (let depth = 1; depth <= MAX_DELIVERY_DEPTH; depth += 1) {
    const next = [];
    for (const dir of level) {
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory()) next.push(path.join(dir, e.name));
        }
      } catch {
        /* 读不了就跳过这一支 */
      }
    }
    out.push(...next);
    level = next;
  }
  return out;
}

/**
 * 交付夹形状的现场事实（判据本体在 lib 的 `deliveryLayoutOf`）。
 *
 * ⚠️ 与 `findDelivery` 分开、**不要求 node.exe 在**：同事那句「安装失败」很可能就是
 *    运行时没解压全 —— 那时 `findDelivery` 找不到夹子，判据却仍该认出"exe 在我们自己的
 *    交付夹里"（判据只看那份 manifest）。两件事混成一件，报告就会在**最该有用的那次**说"没找到"。
 */
function deliveryLayoutFacts(volumeRoot) {
  const candidates = deliveryCandidateDirs(volumeRoot);

  let rejected = null;
  for (const dir of candidates) {
    const hasBundledRuntime = exists(path.join(dir, 'resources', 'runtime', RUNTIME_MANIFEST_FILE));
    const facts = deliveryLayoutOf({ volumeRoot, appDir: dir, hasBundledRuntime });
    if (facts.isLayout) return facts;
    // 留一条"最像但被挡下"的现场（有随包运行时才算"像"）：报告要能说清为什么没认
    if (hasBundledRuntime && !rejected) rejected = facts;
  }
  return rejected ?? { isLayout: false, appDir: null, depth: null, blockedSegment: null, hasBundledRuntime: false };
}

/** 盘里那个"随包程序目录"：盘根下 ≤MAX_DELIVERY_DEPTH 层里，含 resources\runtime\node\node.exe 的那个。 */
function findDelivery(volumeRoot) {
  const looks = (dir) => path.join(dir, 'resources', 'runtime');
  for (const dir of deliveryCandidateDirs(volumeRoot)) {
    const nodeExe = path.join(dir, 'resources', 'runtime', 'node', 'node.exe');
    if (!exists(nodeExe)) continue;
    const manifest = path.join(looks(dir), 'openclaw-runtime-manifest.json');
    const parsed = exists(manifest) ? readJson(manifest) : null;
    return {
      found: true,
      root: dir,
      nodeExe,
      runtimeManifest: parsed
        ? { version: parsed.version ?? null, cliPath: parsed.cliPath ?? null, archive: parsed.archive ?? null }
        : null,
    };
  }
  return { found: false, root: null, nodeExe: null, runtimeManifest: null };
}

/** 网关联接（`plugin-skills\*` 与 managed npm 里的 `node_modules\openclaw`）。 */
function linksUnder(stateDir, expectedRoot) {
  const out = [];
  const probe = (p, needed) => {
    const facts = { lstat: { exists: false }, readlink: null, stat: { ok: false, code: 'ENOENT' } };
    try {
      const st = fs.lstatSync(p);
      facts.lstat = { exists: true, symlink: st.isSymbolicLink(), dir: st.isDirectory(), file: st.isFile() };
    } catch {
      return classifyLink({ lstat: { exists: false }, stat: { ok: false, code: 'ENOENT' }, needed });
    }
    if (facts.lstat.symlink) {
      try {
        facts.readlink = fs.readlinkSync(p);
      } catch {
        facts.readlink = null;
      }
    }
    try {
      const st = fs.statSync(p);
      facts.stat = { ok: true, dir: st.isDirectory() };
    } catch (err) {
      facts.stat = { ok: false, code: err?.code ?? 'UNKNOWN' };
    }
    return classifyLink({ ...facts, expectedRoot, needed });
  };

  const skillsDir = path.join(stateDir, 'plugin-skills');
  if (exists(skillsDir)) {
    let entries = [];
    try {
      entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const e of entries) {
      const p = path.join(skillsDir, e.name);
      // 技能链是网关自己建的（扩展技能），少了就是"还没建"，不当坏链 —— 传 needed: true 走这一档
      out.push({ ...probe(p, true), path: p });
    }
  }

  const npmProjects = path.join(stateDir, 'npm', 'projects');
  if (exists(npmProjects)) {
    let projects = [];
    try {
      projects = fs.readdirSync(npmProjects, { withFileTypes: true });
    } catch {
      projects = [];
    }
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const link = path.join(npmProjects, p.name, 'node_modules', 'openclaw');
      // ⭐ 先问"这个项目到底该不该有这条链"（判据照抄网关：`peerDependencies.openclaw`
      //    或 `dependencies.openclaw`）。不问就会把"本来就不需要"报成"坏链"。
      const manifestFile = path.join(npmProjects, p.name, 'package.json');
      const needed = exists(manifestFile) ? peerLinkNeeded(readJson(manifestFile)).needed : null;
      out.push({ ...probe(link, needed), path: link });
    }
  }
  return out;
}

/**
 * 体检一份"本机缓存运行时"：指针 → 部署目录 → 凭据 / node / 入口，最后给出
 * **客户端会怎么判**（判据在 lib 的 `judgeDeployment`，照抄 `readCurrentDeployment`）。
 *
 * ⚠️ 只读。这里面**不修任何东西**（没有指针就不写指针）。
 */
function deploymentCheck(userDataDir) {
  const runtimeDir = path.join(userDataDir, 'runtime');
  const pointerFile = path.join(runtimeDir, CURRENT_POINTER_FILE);
  const deployedBase = path.join(runtimeDir, 'deployed');
  const pointerExists = exists(pointerFile);
  let pointerRaw = null;
  try {
    if (pointerExists) pointerRaw = fs.readFileSync(pointerFile, 'utf8');
  } catch {
    pointerRaw = null;
  }
  const pointer = readPointerKey(pointerRaw);
  const deployedRoot = pointer ? path.join(deployedBase, pointer) : deployedBase;
  const stampFile = path.join(deployedRoot, DEPLOYMENT_STAMP_FILE);
  const stamp = exists(stampFile) ? readJson(stampFile) : null;
  const nodeRel = typeof stamp?.nodeRelativePath === 'string' ? stamp.nodeRelativePath : null;
  const nodeExists = nodeRel ? exists(path.join(deployedRoot, nodeRel)) : false;
  const entryExists = exists(path.join(deployedRoot, CLAWROUTER_ENTRY));
  const judged = judgeDeployment({
    pointerExists,
    pointerKey: pointer,
    stampExists: Boolean(stamp),
    nodeExists,
    entryExists,
  });
  return {
    userDataDir,
    pointerFile,
    pointer,
    // 指针文件在、字段却读不出来 ⇒ 把**原文**带上（打码后），这是真坏了而不是"没部署过"
    pointerRawExcerpt: pointerExists && !pointer ? String(pointerRaw ?? '').slice(0, 300) : null,
    deployedRoot,
    deployedRootExists: exists(deployedRoot),
    // 没部署目录时别硬报"缺凭据"（那是两件事），所以判据里带上"目录在不在"这句注
    stamp: stamp
      ? {
          key: stamp[POINTER_KEY_FIELD] ?? null,
          nodeVersion: stamp.nodeVersion ?? null,
          platform: stamp.platform ?? null,
          arch: stamp.arch ?? null,
          deployedAt: stamp.deployedAt ?? null,
        }
      : null,
    check: { nodeExists, entryExists, nodeRelativePath: nodeRel, entry: CLAWROUTER_ENTRY },
    judged,
  };
}

function logDigest(logsDir) {
  if (!exists(logsDir)) return null;
  let files = [];
  try {
    files = fs
      .readdirSync(logsDir)
      .filter((n) => /^debug-.*\.ndjson$/i.test(n))
      .map((n) => ({ n, p: path.join(logsDir, n), m: fs.statSync(path.join(logsDir, n)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  const newest = files[0];
  let lines = [];
  try {
    lines = tailLines(newest.p);
  } catch (err) {
    return { path: newest.p, lines: [`（这个文件读不出来：${err?.code ?? '未知'}）`], total: null };
  }
  const hits = lines.filter((l) => looksWrong(l)).map((l) => digestLine(l));
  return { path: newest.p, total: lines.length, matched: hits.length, lines: hits.slice(-60) };
}

function installedPcVersion(localAppData) {
  const cands = [];
  if (localAppData) {
    cands.push(path.join(localAppData, 'Programs', '荣盈魔方'));
    cands.push(path.join(localAppData, 'Programs', '@clawwork', 'desktop'));
  }
  cands.push('C:\\Program Files\\荣盈魔方');
  cands.push('C:\\Program Files (x86)\\荣盈魔方');
  return cands.filter((p) => exists(p));
}

function probeWritable(volumeRoot) {
  const probe = path.join(volumeRoot, `.clawwork-write-test-${process.pid}.tmp`);
  try {
    fs.writeFileSync(probe, 'test');
    return { tested: true, ok: true, message: '已建探针文件并删除' };
  } catch (err) {
    return { tested: true, ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      fs.unlinkSync(probe);
    } catch {
      /* 没建成就没得删；建成了删不掉会留在上面，报告里那一行仍然是真的 */
    }
  }
}

function gather(opts) {
  const warnings = [];
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const generatedAt =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const here = opts.here;
  const volumeRoot = opts.volumeRoot ?? path.win32.parse(here).root;
  const systemDrive = process.env.SystemDrive ?? 'C:';
  const appDataDir = opts.appdata ?? process.env.APPDATA ?? null;
  const localAppDataDir = opts.localappdata ?? process.env.LOCALAPPDATA ?? null;

  const { list: volumes, error: volErr } = volumesOn();
  if (volErr) warnings.push(`枚举盘符失败（PowerShell）：${volErr} —— 下面"盘类型"那几行会缺`);

  const letter = volumeRoot.replace(/[\\/]+$/, '').toLowerCase();
  const selfVolume = volumes.find((v) => v.letter.toLowerCase() === letter) ?? null;
  if (!selfVolume)
    warnings.push(`盘列表里没找到 ${volumeRoot} 对应的那一块（DriveType 未知 ⇒ "便携判定"这一条仅供参考）`);

  const hasRuntimeMarker = exists(path.join(volumeRoot, RUNTIME_MANIFEST_FILE));
  const hasWorkspaceMarker = exists(path.join(volumeRoot, PORTABLE_WORKSPACE_DIR_NAME, WORKSPACE_MARKER_FILE));

  const deliveryLayout = deliveryLayoutFacts(volumeRoot);
  const delivery = findDelivery(volumeRoot);
  // ⭐ 本工具自己正跑在随包运行时上吗？不写这一句，报告就会自相矛盾：
  //    上面说"没在盘里找到随包程序目录"，下面那行 node 又明明是从里面跑起来的
  //    （`.bat` 会往深一层找，而这里只扫盘根和它下一层 —— 端到端实测撞到过）。
  delivery.runningFromBundledNode = looksLikeBundledNode(process.execPath) ? process.execPath : null;
  const nodePath = delivery.nodeExe ?? process.execPath;
  const nodeVersion = (() => {
    const r = run(nodePath, ['-v']);
    return r.ok ? r.out : null;
  })();

  const userDatas = userDataCandidates({ volumeRoot, appDataDir, localAppDataDir }).map((c) => {
    const configPath = path.join(c.path, CONFIG_FILE_NAME);
    const stateDir = path.join(c.path, STATE_DIR_NAME);
    return { ...c, exists: exists(c.path), hasConfig: exists(configPath), hasState: exists(stateDir) };
  });

  const configs = [];
  for (const u of userDatas) {
    if (!u.hasConfig) continue;
    const file = path.join(u.path, CONFIG_FILE_NAME);
    const parsed = readJson(file);
    if (!parsed) {
      warnings.push(`${file} 读不出来（不是 JSON 或被加密）—— 那三个字段这次没取到`);
      continue;
    }
    const ws =
      typeof parsed.workspacePath === 'string' && parsed.workspacePath.length > 0 ? parsed.workspacePath : null;
    configs.push({
      path: file,
      fields: {
        workspacePath: ws,
        workspaceRelPath: parsed.workspaceRelPath ?? null,
        volumeMarker: parsed.volumeMarker ?? null,
      },
      workspaceExists: ws ? exists(ws) : false,
    });
  }

  const stateDirs = [];
  const deployments = [];
  const logs = [];
  for (const u of userDatas) {
    if (!u.hasState) continue;
    const stateDir = path.join(u.path, STATE_DIR_NAME);
    const dep = deploymentCheck(u.path);
    deployments.push(dep);
    stateDirs.push({ path: stateDir, links: linksUnder(stateDir, dep.deployedRoot) });
    const digest = logDigest(path.join(u.path, 'logs'));
    if (digest) logs.push(digest);
  }

  const writable = opts.writeTest
    ? probeWritable(volumeRoot)
    : { tested: false, ok: false, message: '--no-write-test：没测（别当成"能写"）' };
  if (!opts.writeTest) warnings.push('可写性没测（--no-write-test）—— "装不上/写不进去"这一类原因这次没有排除');

  const facts = {
    generatedAt,
    host: { platform: process.platform, release: os.release(), arch: process.arch, systemDrive },
    self: { scriptDir: here, volumeRoot, volume: selfVolume },
    volumes,
    markers: { runtime: hasRuntimeMarker, workspace: hasWorkspaceMarker },
    delivery,
    deliveryLayout,
    node: { path: nodePath, version: nodeVersion },
    portable: decidePortable({
      volumeRoot,
      systemDrive,
      driveType: selfVolume?.driveType ?? null,
      hasRuntimeMarker,
      hasWorkspaceMarker,
      // 同事那份交付包（盘根没 marker + DriveType=3）只有这条判据能认出来
      deliveryLayout,
    }),
    userDatas,
    configs,
    stateDirs,
    deployments,
    logs,
    writable,
    installedPcVersion: installedPcVersion(localAppDataDir),
    warnings,
  };
  return facts;
}

// ───────────────────────────────── 产出"交给同事的夹子" ─────────────────────────────────

function emitTool(outDir) {
  fs.mkdirSync(path.join(outDir, 'lib'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(outDir, TOOL_SCRIPT_NAME));
  fs.copyFileSync(LIB, path.join(outDir, 'lib', 'udisk-diagnose.mjs'));

  // `.bat` 纯 ASCII + CRLF（见 lib 里 batSource 的注释：编码坑）
  fs.writeFileSync(path.join(outDir, TOOL_BAT_NAME), batSource(), 'latin1');

  const readme = [
    '这份东西是干什么的：',
    '',
    `1. 双击「${TOOL_BAT_NAME}」（它只会读，不会改任何设置）；`,
    `2. 跑完会在同一个夹子里出现「${REPORT_NAME}」；`,
    '3. 把那个 txt 整个发回给我们（微信/邮件都行）。',
    '',
    '放哪里：跟「荣盈魔方」那个程序夹子放在**同一块 U 盘**上（放哪一层都行，脚本自己找）。',
    '跑不动的时候：它会自己找 U 盘里自带的 node；实在找不到，夹子里那句英文提示说的是',
    '「没找到 node.exe」，把这句话截图发我们。',
    '',
    '隐私：报告里可能含路径与日志片段，token 一类字段已自动打码；不想发的行可以删掉，',
    '但请保留「## 摘要」那一段 —— 那一段是判断问题用的。',
  ].join('\r\n');
  fs.writeFileSync(path.join(outDir, '先看这里.txt'), `\uFEFF${readme}`, 'utf8');

  console.log(`已产出：${outDir}`);
  console.log(`   ${TOOL_BAT_NAME}（同事双击这个）`);
  console.log(`   ${TOOL_SCRIPT_NAME} + lib\\udisk-diagnose.mjs（脚本本体，别改名）`);
  console.log(`   先看这里.txt（一句话说明）`);
  console.log(`把这个夹子放到 U 盘上（与「荣盈魔方」同一个盘），双击 ${TOOL_BAT_NAME} 即可。`);
  return 0;
}

// ───────────────────────────────── main ─────────────────────────────────

async function main(argv) {
  const flag = (name, fallback = null) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
  };

  const emitDir = flag('--emit-tool');
  if (emitDir) return emitTool(emitDir);

  const here = path.resolve(flag('--here', SCRIPT_DIR));
  const opts = {
    here,
    volumeRoot: flag('--volume-root', null),
    appdata: flag('--appdata', null),
    localappdata: flag('--localappdata', null),
    writeTest: !argv.includes('--no-write-test'),
  };

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  const facts = gather(opts);

  if (argv.includes('--json')) {
    // ⚠️ 只打 JSON 一行不带别的：测试与"给自己看"都靠这条
    console.log(redactSecrets(JSON.stringify(facts)));
    return 0;
  }

  const out = path.resolve(flag('--out', path.join(here, REPORT_NAME)));
  const report = renderReport(facts);
  fs.writeFileSync(out, `\uFEFF${report}`, 'utf8');

  // ⚠️ 判据必须与报告同一套（`isBrokenLink`）：原来这里写的是 `kind !== 'ok'`，
  //    于是 `not-needed`（本来就不需要这条链）也被算成"坏链" —— 屏幕上就变成一句假警报。
  const allLinks = facts.stateDirs.flatMap((s) => s.links);
  const broken = allLinks.filter((l) => isBrokenLink(l.kind));
  const absent = allLinks.filter((l) => bucketOf(l.kind) === 'absent');
  console.log(
    `盘：${facts.self.volumeRoot}（${facts.self.volume ? `DriveType=${facts.self.volume.driveType}` : 'DriveType 未知'}）`,
  );
  console.log(
    `判定：${facts.portable.portable ? '盘上形态（便携）' : '本机形态（非便携）'} —— ${facts.portable.reason}`,
  );
  console.log(
    `数据目录：${
      facts.userDatas
        .filter((u) => u.exists)
        .map((u) => u.path)
        .join('；') || '（都不存在）'
    }`,
  );
  console.log(`坏链：${broken.length} 条${absent.length ? `；另有 ${absent.length} 处"链接还没建"（多半正常）` : ''}`);
  if (facts.warnings.length) console.log(`这个工具自己没做成的：${facts.warnings.length} 条（报告里有）`);
  console.log(`\n报告已写好：${out}`);
  console.log('把它整个发回来即可。');
  return 0;
}

process.exit(await main(process.argv.slice(2)));
