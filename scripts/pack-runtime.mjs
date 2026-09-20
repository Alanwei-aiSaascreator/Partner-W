#!/usr/bin/env node
/**
 * 出厂运行时打包器。
 *
 * 产出与荣盈同形的运行时包（形状取自 `F:\0.0.17\resources\openclaw-runtime-manifest.json`，
 * 2026-09-11 实测），客户端那一侧的装载器（见交付路线图阶段 1）按 manifest 找它。
 *
 *   node scripts/pack-runtime.mjs --version 2026.9.3
 *
 * 为什么是参数化的：目标版本会变（决定见 docs/superpowers/plans/2026-09-11-交付路线图.md），
 * 版本一发布就该是「改一个参数重跑」，而不是「重新摸一遍流程」。
 *
 * 自检（`--verify-only` 可单独跑）：解开产物断言
 * `node_modules/openclaw/dist/extensions/clawrouter/` 存在 —— clawrouter 是 relay
 * 计量的唯一入口，没有它 = 静默不计费。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

/** 中转计量的唯一入口。缺了它，写进 models.providers.clawrouter 的配置会变成
 *  一个不带 models 的普通 provider → 模型列表为空 → 调用根本不发到 relay。 */
export const CLAWROUTER_ENTRY = 'node_modules/openclaw/dist/extensions/clawrouter/index.js';

/**
 * 默认保留的技能（剪枝是白名单制：不在名单里的删掉）。
 * ⚠️ 这是**产品决定**，不是技术决定 —— 改这个清单不用改代码。
 *
 * ⛔ **只写 `skills/` 目录下的名字。** 另有三个地方也提供技能，本剪枝碰不到它们，
 *    写进来是无效项（脚本会警告）：
 *      - `custodian-skills/`（add-model-provider / configure-channel /
 *        diagnose-gateway / cloud-image-bake）—— 与 `skills/` 平级，始终随包发
 *      - 状态目录的 `plugin-skills/`（browser-automation / canvas）
 *      - 用户在运行时自己装的
 *    （2026-09-11 踩过：第一版名单里 5 个名字指向上面这些，静默无效。）
 *
 * 取向：Windows 上能跑 + 通用/办公向。上游另外 40 来个是 macOS 专属
 * 或第三方消费级 CLI（1Password / Bear / Sonos / Spotify…），与我们的场景无关。
 */
export const DEFAULT_KEEP_SKILLS = [
  'control-ui', // 排障
  'diagram-maker', // 画图，通用
  'healthcheck', // 主机安全体检
  'node-connect', // 连不上时排障
  'node-inspect-debugger', // Node 调试
  'python-debugpy', // Python 调试
  'skill-creator', // ⭐ 写我们自己的技能要用它
  'spike', // 可行性验证
  'taskflow', // 审批流
  'taskflow-inbox-triage',
  'video-frames', // ffmpeg 抽帧
  'weather', // 通用
];

/**
 * 依据保留清单，算出该删哪些技能目录。
 *
 * 纯函数：只做集合运算，不碰文件系统 —— 这样「剪枝逻辑」可以被单测钉住，
 * 而不必真的去删一个 200MB 的目录来验证。
 *
 * 三条刻意的行为：
 *  - 未在清单里的删掉（白名单制，上游新增技能默认不进产品）
 *  - 清单里有但实际不存在的**不报错**（上游会改名/下线，那不是错误）
 *  - 返回排序后的结果，让日志和测试都稳定
 */
export function selectSkillsToPrune(existingDirs, keepList) {
  const keep = new Set(keepList);
  return existingDirs.filter((dir) => !keep.has(dir)).sort();
}

/**
 * 找出保留清单里**一个都没匹配上**的条目。
 *
 * 为什么不报错而是警告：上游会改名/下线技能，那是常态；
 * 但"名单写错了目录"长得和它一模一样 —— 2026-09-11 我就在名单里写了 5 个
 * 根本不在 `skills/` 下的名字（它们在 `custodian-skills/` 或状态目录），
 * 剪枝照常"成功"，错得毫无声响。
 *
 * 所以：**不影响构建，但必须出声**。列出没匹配上的条目，让人自己判断
 * 是"上游删了"还是"我写错地方了"。
 */
export function unmatchedKeepEntries(existingDirs, keepList) {
  const existing = new Set(existingDirs);
  return keepList.filter((name) => !existing.has(name)).sort();
}

/**
 * 构造 manifest。字段与荣盈那份**逐字对齐** —— 装载器要按同一份 schema 读，
 * 少一个字段那边就是 undefined。
 */
export function buildManifest({ version, archive, archiveSize, fileCount, sha256, extractor }) {
  return {
    formatVersion: 1,
    packageName: 'openclaw',
    version,
    runtimes: [
      {
        platform: 'win32',
        arch: 'x64',
        version,
        runtimeDeploymentKey: version,
        archive,
        archiveSize,
        extractor,
        size: 0,
        fileCount,
        packageRoot: 'node_modules/openclaw',
        cliPath: 'node_modules/openclaw/openclaw.mjs',
        source: 'mofang-pack-runtime',
        patches: [],
        requiredPackages: [],
        sha256,
      },
    ],
  };
}

// ---------- 以下是有副作用的部分 ----------

/** ⚠️ Windows 上 npm 是 `npm.cmd`。两个坑叠在一起：
 *   ① 不带 shell 时 `execFileSync('npm')` 不补后缀 → `ENOENT`（看着像没装 npm）；
 *   ② Node 20+ 出于安全**拒绝**不带 shell 直接 spawn `.cmd/.bat` → `EINVAL`。
 *  所以统一走 shell。走 shell 就得自己给带空格的路径加引号（本仓库路径里就有空格）。 */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const quote = (s) => (/\s/.test(s) ? `"${s}"` : s);

// ⚠️ 命令自己也要过 quote —— `C:/Program Files/7-Zip/7z.exe` 里就有空格，
// 不引起来 cmd 会把 `C:/Program` 当成可执行文件名。
function sh(cmd, args, opts = {}) {
  return execFileSync(quote(cmd), args.map(quote), { stdio: 'inherit', shell: true, ...opts });
}

function shOut(cmd, args) {
  return execFileSync(quote(cmd), args.map(quote), { encoding: 'utf8', shell: true }).trim();
}

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

function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else n += 1;
    }
  };
  walk(dir);
  return n;
}

function sevenZip() {
  const candidates = ['C:/Program Files/7-Zip/7z.exe', 'C:/Program Files (x86)/7-Zip/7z.exe'];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('找不到 7z.exe（装 7-Zip，或改 sevenZip() 里的候选路径）');
  return found;
}

function parseArgs(argv) {
  const out = { out: path.join(REPO_ROOT, 'runtime-out'), prune: true, verifyOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--version') out.version = argv[++i];
    else if (a === '--out') out.out = path.resolve(argv[++i]);
    else if (a === '--no-prune') out.prune = false;
    else if (a === '--verify-only') out.verifyOnly = true;
    else if (a === '--keep-file') out.keepFile = path.resolve(argv[++i]);
  }
  return out;
}

/**
 * 自检：从产物里**真把 clawrouter 那个文件抽出来**，断言它存在。
 *
 * 为什么不 `7z l` 看清单：这个包有近万个文件，清单能到几 MB，
 * 会把 Node 的 maxBuffer（1MB）撑爆 —— 报的是 `spawnSync ENOBUFS`，
 * 跟"包里没有 clawrouter"完全是两回事，容易查错方向。
 * 抽一个文件既省内存，又是更硬的证据（证明这个包真能解开）。
 *
 * 这是本脚本存在的意义：宁可打包失败，不可静默交付一个不计费的运行时。
 */
export function verifyArchive(sevenZipPath, archivePath) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-runtime-verify-'));
  try {
    execFileSync(sevenZipPath, ['e', archivePath, `-o${tmp}`, '-y', CLAWROUTER_ENTRY], {
      stdio: 'ignore',
    });
    const extracted = path.join(tmp, path.basename(CLAWROUTER_ENTRY));
    if (!fs.existsSync(extracted) || fs.statSync(extracted).size === 0) {
      throw new Error(
        `自检失败：产物里没有 ${CLAWROUTER_ENTRY}。\n` +
          '没有 clawrouter，relay 会静默不计费（模型列表为空、调用根本不发到中转）。',
      );
    }
    return true;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sz = sevenZip();

  if (args.verifyOnly) {
    const archives = fs.readdirSync(args.out, { recursive: true }).filter((f) => String(f).endsWith('.7z'));
    if (!archives.length) throw new Error(`${args.out} 下没有 .7z 产物`);
    for (const a of archives) {
      verifyArchive(sz, path.join(args.out, a));
      console.log('✅ 自检通过:', a);
    }
    return;
  }

  if (!args.version) throw new Error('缺 --version，例如 --version 2026.9.3');

  const keepList = args.keepFile
    ? fs
        .readFileSync(args.keepFile, 'utf8')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('#'))
    : DEFAULT_KEEP_SKILLS;

  const work = path.join(args.out, '.work');
  const stage = path.join(work, 'stage'); // 里面会长出 node_modules/
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, 'package.json'), '{ "private": true }\n');

  // ① 装：**必须带整棵依赖树**。
  //    ⚠️ 不要用 `npm pack` + 解包 —— 那只给 openclaw 包本身，兄弟依赖全没有，
  //    起网关时报 `Cannot find package '@openclaw/fs-safe'`。
  //    荣盈那个包的 31,111 个文件里，大部分就是这些兄弟依赖（我第一版只有 9,945）。
  console.log(`① 安装 openclaw@${args.version}（含依赖树）…`);
  sh(NPM, [
    'install',
    `openclaw@${args.version}`,
    '--prefix',
    stage,
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    '--silent',
  ]);
  const pkgDir = path.join(stage, 'node_modules', 'openclaw');
  if (!fs.existsSync(pkgDir)) throw new Error(`装完了但 ${pkgDir} 不存在`);

  // ③ 剪技能
  const skillsDir = path.join(pkgDir, 'skills');
  if (args.prune && fs.existsSync(skillsDir)) {
    const existing = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    const drop = selectSkillsToPrune(existing, keepList);
    for (const name of drop) fs.rmSync(path.join(skillsDir, name), { recursive: true, force: true });
    console.log(`③ 剪技能：留 ${existing.length - drop.length} / 删 ${drop.length}`);

    const unmatched = unmatchedKeepEntries(existing, keepList);
    if (unmatched.length) {
      console.warn(
        `⚠️  保留清单里有 ${unmatched.length} 个名字在 skills/ 下不存在：${unmatched.join(', ')}\n` +
          '    多半是写错了目录（custodian-skills/ 或状态目录的 plugin-skills/ 不归这里管），' +
          '也可能只是上游改名了。不影响构建，但请确认一遍。',
      );
    }
  } else {
    console.log('③ 剪技能：跳过');
  }

  // ④ 打包。命名用 .7z 但实际是 zip —— 与荣盈产物一致（它那个也是 zip，
  //    7z 打开时会警告 "Cannot open the file as [7z] archive / Type = zip"）。
  const winDir = path.join(args.out, 'win32-x64');
  fs.mkdirSync(winDir, { recursive: true });
  const archiveName = `openclaw-runtime-${args.version}.7z`;
  const archivePath = path.join(winDir, archiveName);
  fs.rmSync(archivePath, { force: true });
  console.log('④ 压缩 …');
  sh(sz, ['a', '-tzip', '-mx=5', archivePath, 'node_modules'], { cwd: stage });

  // ⑤ 算指纹
  console.log('⑤ 算 sha256 / 文件数 …');
  const archiveSize = fs.statSync(archivePath).size;
  const sha256 = sha256File(archivePath);
  const fileCount = countFiles(path.join(stage, 'node_modules'));

  // ⑥ 写 manifest（两份：产物根目录一份，运行时目录里一份 —— 荣盈就是两份）
  const manifest = buildManifest({
    version: args.version,
    archive: `win32-x64/${archiveName}`,
    archiveSize,
    fileCount,
    sha256,
    extractor: 'win32-x64/extractor/7za.exe',
  });
  const runtimeDir = path.join(args.out, 'openclaw-runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(path.join(args.out, 'openclaw-runtime-manifest.json'), json);
  fs.writeFileSync(path.join(runtimeDir, 'manifest.json'), json);

  // ⑦ 自检
  console.log('⑦ 自检 …');
  verifyArchive(sz, archivePath);

  fs.rmSync(work, { recursive: true, force: true });
  console.log(
    `\n✅ 完成\n   版本   ${args.version}\n   产物   ${archivePath}\n   大小   ${(archiveSize / 1024 / 1024).toFixed(1)} MB\n   文件数 ${fileCount}\n   sha256 ${sha256}`,
  );
}

// 只在被直接执行时跑 main，被 import 时（测试）不跑。
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error('\n❌', e.message);
    process.exit(1);
  });
}
