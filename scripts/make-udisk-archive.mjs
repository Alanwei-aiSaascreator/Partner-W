#!/usr/bin/env node
/**
 * U 盘交付包 → 压缩包（分发给"好多 U 盘"那一步）。
 *
 * 用法：
 *   node scripts/make-udisk-archive.mjs <交付包目录> [--out <压缩包>] [--format zip|7z] [--dry-run]
 *
 * 例：node scripts/make-udisk-archive.mjs "D:\\Desktop\\荣盈魔方U盘交付-0.0.25"
 *     → D:\Desktop\荣盈魔方U盘版-0.0.25.zip
 *
 * 三道闸门（都是在**封包之前**拦，发出去了就收不回来）：
 * ① 复用人话体检（`udisk-delivery.mjs` 的 audit）：**有 error 直接拒绝打包**
 *    —— 不许绕过机检把"去掉 .bat 却没带上新行为"的包封出去；
 * ② **不许把跑过的夹子封包**：`荣盈魔方-运行数据\` / `荣盈魔方工作区\` / `openclaw-state\` /
 *    日志 / 凭据文件 —— 里面是设备私钥、operator token、网关 token、对话日志。
 *    拿"预热过的母盘"直接打包 = 把一份凭据发给每一个客户（`udisk-archive.mjs` 的
 *    `findSensitiveEntries` 挡这个）；
 * ③ **封完自己解一遍对账**：条目集合与每个文件的大小都要与源夹一致 ——
 *    否则压缩包看着"创建成功"，客户解出来却少东西。
 *
 * ⚠️ 这个脚本**不产出产品**（不跑 electron-builder、不碰 dist），只对**已经打好的交付夹**
 *    做压缩与对账。
 * ⚠️ 真实工具名与路径都是 Windows 上的常识位置（7-Zip / Windows 自带 bsdtar）；
 *    找不到工具就明说怎么办，不静默换一种压法。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  archiveArgv,
  diffEntries,
  extractArgv,
  findSensitiveEntries,
  maxPathLength,
  PATH_LENGTH_BUDGET,
  pickTool,
} from './lib/udisk-archive.mjs';
import { auditDelivery, LAUNCHER_BAT_NAME, versionFromFolderName } from './lib/udisk-delivery.mjs';

const WIN_TAR = 'C:\\Windows\\System32\\tar.exe';
const WIN_7Z = 'C:\\Program Files\\7-Zip\\7z.exe';
const WIN_7Z_X86 = 'C:\\Program Files (x86)\\7-Zip\\7z.exe';

const USAGE = [
  '用法：node scripts/make-udisk-archive.mjs <交付包目录> [--out <压缩包>] [--format zip|7z] [--dry-run]',
  '  <交付包目录>  形如 D:\\Desktop\\荣盈魔方U盘交付-0.0.25（已通过 udisk-delivery 机检的那个夹子）',
  '  --format      默认 zip（谁都能解）；7z 更小但要求客户装 7-Zip',
  '  --dry-run     只体检、只打印，不生成文件',
].join('\n');

const io = {
  exists: (p) => fs.existsSync(p),
  listNames: (dir) => fs.readdirSync(dir),
  readFile: (p) => {
    try {
      return fs.readFileSync(p);
    } catch {
      return null;
    }
  },
};

function detectTools() {
  const find = (...cands) => cands.find((c) => fs.existsSync(c)) ?? null;
  return { bsdtar: find(WIN_TAR), sevenZip: find(WIN_7Z, WIN_7Z_X86) };
}

/** 走一遍目录：返回 `{ relPath: size }`（目录记为 size 0）。 */
function walkTree(root) {
  const out = new Map();
  const walk = (dir, rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.set(r, 0);
        walk(path.join(dir, e.name), r);
      } else {
        let size = -1;
        try {
          size = fs.statSync(path.join(dir, e.name)).size;
        } catch {
          /* 读不到大小就当 -1：对账会报出来 */
        }
        out.set(r, size);
      }
    }
  };
  walk(root, '');
  return out;
}

function human(bytes) {
  const mb = bytes / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

/**
 * 对账没过的压缩包**改名**（不删）：留着给人查，但名字要让人不可能误发。
 * 删掉它更省事，可"这里本来有个包、现在没了"会让下一个人以为是工具没跑成。
 */
function quarantine(out) {
  const bad = `${out}.未通过对账-别发`;
  try {
    fs.renameSync(out, bad);
    console.log(`   已改名（不删）：${path.basename(bad)}`);
  } catch (err) {
    console.log(`   （改名失败，请自行删掉这个包：${err instanceof Error ? err.message : String(err)}）`);
  }
}

function main(argv) {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const dir = positional[0];
  const flag = (name, fallback = null) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const format = flag('--format', 'zip');
  const dryRun = argv.includes('--dry-run');

  if (!dir) {
    console.log(USAGE);
    return 2;
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.log(`不是个目录：${dir}`);
    console.log(USAGE);
    return 2;
  }

  const version = versionFromFolderName(path.basename(dir));
  const out = flag('--out', path.join(path.dirname(dir), `荣盈魔方U盘版-${version ?? '未标注'}.${format}`));
  const tools = detectTools();
  const tool = pickTool({ sevenZip: Boolean(tools.sevenZip), bsdtar: Boolean(tools.bsdtar) }, format);

  console.log(`交付夹：${dir}${version ? `（版本 ${version}）` : ''}`);
  console.log(`压缩包：${out}（格式 ${format}）\n`);

  // ① 人话体检
  const findings = auditDelivery(io, dir);
  const errors = findings.filter((f) => f.level === 'error');
  const warns = findings.filter((f) => f.level === 'warn');
  for (const f of errors) console.log(`❌ ${f.title}\n   ${f.detail.split('\n').join('\n   ')}\n`);
  if (errors.length > 0) {
    console.log('体检有错 —— 先跑 node scripts/udisk-delivery.mjs 把包整理干净再封包（拒绝打包）。');
    return 1;
  }
  // ⚠️ warn 要打出来：warn 的口径是"能发，但**你得知道**你在发什么"。
  //    压缩脚本要是把 warn 吞了，用户就会带着安装包/教 .bat 的说明发出去而毫不知情。
  for (const f of warns) console.log(`⚠️  ${f.title}\n   ${f.detail.split('\n').join('\n   ')}\n`);
  if (warns.length > 0)
    console.log(`（${warns.length} 条提醒：不影响打包 —— 但它们说的是"发出去之前你该知道的事"。）\n`);

  // ② 跑过的夹子 / 凭据
  const tree = walkTree(dir);
  const relPaths = [...tree.keys()];
  const sensitive = findSensitiveEntries(relPaths);
  if (sensitive.length > 0) {
    console.log('❌ 这个夹子里有"跑过的运行数据/凭据" —— 封出去等于把它们发给每一个客户：');
    for (const p of sensitive.slice(0, 20)) console.log(`   · ${p}`);
    if (sensitive.length > 20) console.log(`   … 还有 ${sensitive.length - 20} 条`);
    console.log(
      '\n怎么办：拿**没跑过**的纯净交付夹来封（U 盘版第一次运行会在盘里建 荣盈魔方-运行数据\\，' +
        '里面有设备私钥、operator token、网关 token、对话日志）。预热母盘**不能**直接打包。',
    );
    return 1;
  }

  const files = relPaths.filter((p) => (tree.get(p) ?? 0) > 0);
  const bytes = [...tree.values()].reduce((a, b) => a + Math.max(0, b), 0);
  const maxLen = maxPathLength(relPaths);
  console.log(`内容：${files.length} 个文件、${relPaths.length - files.length} 个目录、共 ${human(bytes)}`);
  console.log(`最长相对路径：${maxLen} 字符（预算 ${PATH_LENGTH_BUDGET}）`);
  if (maxLen > PATH_LENGTH_BUDGET) {
    console.log('⚠️  超过预算 ⇒ 让用户**用 7-Zip 解压**（Windows 自带解压有 260 字符限制，会中途失败）。');
  }
  if (!tool) {
    console.log(
      `❌ 没找到可用的打包工具。装 7-Zip（找 ${WIN_7Z}）或确认系统自带 ${WIN_TAR} 存在；` +
        `要 7z 格式则只能装 7-Zip。`,
    );
    return 1;
  }

  const contents = fs.readdirSync(dir);
  const plan = archiveArgv({ tool, format, out, dir, contents });
  // ⚠️ 只认 `bin`，别再拿 `tool` 去比：`tool` 是 `'7z'`/`'bsdtar'`，argv 里是
  //    `'sevenZip'`/`'bsdtar'` —— 名字认错就会把 bsdtar 的参数喂给 7z（真实栽过）。
  const binFor = (b) => (b === 'sevenZip' ? tools.sevenZip : tools.bsdtar);
  const bin = binFor(plan.bin);
  console.log(`工具：${tool}（${bin}）`);
  console.log(`命令：${bin} ${plan.args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}\n`);

  if (dryRun) {
    console.log('--dry-run：没有生成任何文件。');
    return 0;
  }

  try {
    execFileSync(bin, plan.args, { cwd: dir, stdio: 'pipe' });
  } catch (err) {
    console.log(`❌ 打包失败：${err instanceof Error ? err.message : String(err)}`);
    if (err && err.stderr) console.log(String(err.stderr).slice(0, 2000));
    return 1;
  }
  if (!fs.existsSync(out)) {
    console.log('❌ 命令跑完了却没有产出压缩包 —— 不猜原因，请人工看一眼上面的命令。');
    return 1;
  }
  console.log(`✅ 已生成：${out}（${human(fs.statSync(out).size)}）`);

  // ③ 解出来对账（唯一能证明"客户解得出东西"的办法）
  const verifyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'udisk-verify-'));
  try {
    const un = extractArgv({ tool, out, dir: verifyDir });
    try {
      execFileSync(binFor(un.bin), un.args, { stdio: 'pipe' });
    } catch (err) {
      console.log(`❌ 解压对账这一步跑不起来：${err instanceof Error ? err.message : String(err)}`);
      if (err && err.stderr) console.log(String(err.stderr).slice(0, 2000));
      console.log('（这个压缩包**没有**通过"客户解得出东西"这一关 —— 别发。）');
      quarantine(out);
      return 1;
    }

    const extracted = walkTree(verifyDir);
    const diff = diffEntries([...tree.keys()], [...extracted.keys()]);
    const sizeMismatch = [...tree.entries()]
      .filter(([p, size]) => size > 0 && extracted.has(p) && extracted.get(p) !== size)
      .map(([p]) => p);

    if (diff.missing.length || diff.extra.length || sizeMismatch.length) {
      console.log('❌ 对账不通过 —— 这个压缩包别发：');
      if (diff.missing.length)
        console.log(`   少了 ${diff.missing.length} 项，例如：${diff.missing.slice(0, 5).join(', ')}`);
      if (diff.extra.length) console.log(`   多了 ${diff.extra.length} 项，例如：${diff.extra.slice(0, 5).join(', ')}`);
      if (sizeMismatch.length)
        console.log(`   大小不一致 ${sizeMismatch.length} 项，例如：${sizeMismatch.slice(0, 5).join(', ')}`);
      quarantine(out);
      return 1;
    }
    console.log(`✅ 对账通过：解出来 ${extracted.size} 项，与源夹逐项一致（含大小）。`);
  } finally {
    // ⚠️ 只删自己刚建的那个临时目录（内容来自 zip，不可能含 junction）。
    fs.rmSync(verifyDir, { recursive: true, force: true });
  }

  console.log('\n怎么用它铺 U 盘：');
  console.log(` 1) 把 ${path.basename(out)} 发给客户 / 拷到盘里；`);
  console.log(' 2) 客户在 **U 盘根目录** 解压（右键 → 7-Zip → 解压到当前文件夹）');
  console.log('    → 得到 E:\\荣盈魔方\\ 与 E:\\使用说明.txt（与老交付包同一形态）；');
  if (contents.includes(LAUNCHER_BAT_NAME)) {
    // ⚠️ 别在这里无脑写"双击 exe"：老构建抢不到单实例锁时是**静默退出**，
    //    那样教用户等于教他去撞"双击了没反应"。带 .bat 的包就让用户点 .bat。
    console.log(` 3) 这一版**还带 ${LAUNCHER_BAT_NAME}**（构建还不自解释，上面已提醒）`);
    console.log('    ⇒ 告诉客户**双击 ①双击这里启动.bat**；等下一版带上新启动行为、把 .bat 去掉之后，');
    console.log('      才是双击 E:\\荣盈魔方\\荣盈魔方.exe。');
  } else {
    console.log(' 3) 双击 E:\\荣盈魔方\\荣盈魔方.exe 就能用（这个包不带 .bat 了）。');
  }
  console.log('\n好多个 U 盘（自己铺盘时）：在资源管理器里整目录复制，或用');
  console.log('   robocopy "<母盘盘符>:\\" "<目标盘符>:\\" /E /XJ /MT:32');
  console.log('   ⚠️ /XJ 别省（跳过 junction）；⚠️ 别把 荣盈魔方-运行数据\\ 一起复制 —— 那是"这台机器跑过"的数据。');
  return 0;
}

process.exit(main(process.argv.slice(2)));
