/**
 * 「U 盘交付包 → 压缩包」的判据测试。跑：node --test scripts/lib/udisk-archive.test.mjs
 *
 * ⚠️ 最后一组是**真跑**：造一棵含中文名的树 → 用本机找得到的归档工具压一次 →
 *    解到临时目录 → 比对条目集合与字节。找不到工具时**明确打印"跳过＝未验证"**
 *    （跳过不等于通过 —— 这条纪律在这个仓库栽过）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  archiveArgv,
  diffEntries,
  extractArgv,
  findSensitiveEntries,
  maxPathLength,
  PATH_LENGTH_BUDGET,
  pickTool,
} from './udisk-archive.mjs';
import { LAUNCHER_EXE_NAME, RUNTIME_MANIFEST_NAME } from './udisk-delivery.mjs';

const WIN_TAR = 'C:\\Windows\\System32\\tar.exe';
const WIN_7Z = 'C:\\Program Files\\7-Zip\\7z.exe';

function detectTools() {
  return {
    bsdtar: fs.existsSync(WIN_TAR),
    sevenZip: fs.existsSync(WIN_7Z),
  };
}

test('① 跑过的交付夹：运行数据目录（任意层级）一律命中', () => {
  const hits = findSensitiveEntries([
    '荣盈魔方/荣盈魔方.exe',
    '使用说明.txt',
    '荣盈魔方-运行数据/runtime/deployed/x/y.js',
    '荣盈魔方工作区/note.md',
    '.荣盈魔方更新/update-state.json',
    '荣盈魔方/resources/logs/debug-1.ndjson',
  ]);

  assert.equal(hits.length, 4);
  assert.ok(hits.some((h) => h.startsWith('荣盈魔方-运行数据/')));
  assert.ok(hits.some((h) => h.startsWith('荣盈魔方工作区/')));
  assert.ok(hits.some((h) => h.startsWith('.荣盈魔方更新/')));
  assert.ok(hits.some((h) => h.includes('/logs/')));
});

test('② 凭据文件（任意层级、含根层）都命中 —— 这一条挡的是"把凭据发给所有客户"', () => {
  const hits = findSensitiveEntries([
    'device-identity.json',
    '荣盈魔方/resources/runtime/local-gateway-auth.json',
    '荣盈魔方-运行数据/clawwork-config.json'.replace('荣盈魔方-运行数据', 'whatever'),
  ]);

  assert.equal(hits.length, 3);
});

test('③ 纯净交付包的形状 ⇒ 一个都不命中（不误伤）', () => {
  assert.deepEqual(
    findSensitiveEntries([
      '荣盈魔方启动器.exe',
      '荣盈魔方/荣盈魔方.exe',
      '荣盈魔方/resources/app.asar',
      '荣盈魔方/resources/runtime/openclaw-runtime-manifest.json',
      '荣盈魔方/resources/kb-model/bge-small-zh-v1.5/onnx/model.onnx',
      '使用说明.txt',
    ]),
    [],
  );
});

test('④ 路径长度预算：实测这个交付包最长 109 ⇒ 安全；超过预算要能用 7-Zip', () => {
  const long = 'a/'.repeat(130) + 'x.js';
  assert.equal(maxPathLength(['荣盈魔方/荣盈魔方.exe', long]), long.length);
  assert.ok(109 < PATH_LENGTH_BUDGET);
  assert.ok(long.length > PATH_LENGTH_BUDGET);
});

test('⑤ 归档条目 vs 目录清单：缺的、多的都要点名（大小写与 ./ 前缀不算差异）', () => {
  const diff = diffEntries(
    ['荣盈魔方/荣盈魔方.exe', '使用说明.txt'],
    ['./荣盈魔方/荣盈魔方.exe', '使用说明.TXT', '多出来的.tmp'],
  );

  assert.deepEqual(diff.missing, []);
  assert.deepEqual(diff.extra, ['多出来的.tmp']);
});

test('⑥ 选工具：要 7z 格式只有 7z 能给；要 zip 时 7z 优先、bsdtar 兜底', () => {
  assert.equal(pickTool({ sevenZip: true, bsdtar: true }, '7z'), '7z');
  assert.equal(pickTool({ sevenZip: true, bsdtar: true }, 'zip'), '7z');
  assert.equal(pickTool({ sevenZip: false, bsdtar: true }, 'zip'), 'bsdtar');
  assert.equal(pickTool({ sevenZip: false, bsdtar: true }, '7z'), null);
  assert.equal(pickTool({ sevenZip: false, bsdtar: false }, 'zip'), null);
});

test('⑦ 命令行：7z 必须带 -mcu（中文名 UTF-8），bsdtar 用 -C 保证"压的是夹里的内容"', () => {
  const seven = archiveArgv({
    tool: '7z',
    format: 'zip',
    out: 'D:\\out.zip',
    dir: 'D:\\d',
    contents: ['荣盈魔方', '使用说明.txt'],
  });
  assert.equal(seven.bin, 'sevenZip');
  assert.ok(seven.args.includes('-mcu=on'));
  assert.ok(seven.args.includes('-tzip'));
  assert.ok(seven.args.includes('D:\\d\\荣盈魔方'));
  // `--` 之后是文件名：名字里带 `-` 或 `①` 也不会被当成开关
  assert.ok(seven.args.indexOf('--') < seven.args.indexOf('D:\\out.zip'));

  const bsd = archiveArgv({ tool: 'bsdtar', format: 'zip', out: 'D:\\out.zip', dir: 'D:\\d', contents: ['.'] });
  assert.equal(bsd.bin, 'bsdtar');
  assert.deepEqual(bsd.args, ['-a', '-c', '-f', 'D:\\out.zip', '-C', 'D:\\d', '.']);
});

test('⑧ 真跑一次（压缩 → 解压 → 对条目与字节）；找不到工具就明说"跳过＝未验证"', (t) => {
  const tools = detectTools();
  const tool = pickTool(tools, 'zip');
  if (!tool) {
    t.skip(`本机没有归档工具（bsdtar=${tools.bsdtar}, 7z=${tools.sevenZip}）⇒ 跳过＝未验证`);
    return;
  }

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'udisk-arch-'));
  const dir = path.join(base, '交付夹');
  fs.mkdirSync(path.join(dir, '荣盈魔方', 'resources'), { recursive: true });
  fs.writeFileSync(path.join(dir, LAUNCHER_EXE_NAME), 'launcher-bytes');
  fs.writeFileSync(path.join(dir, '荣盈魔方', '荣盈魔方.exe'), 'exe-bytes');
  fs.writeFileSync(path.join(dir, '荣盈魔方', 'resources', 'app.asar'), 'asar-bytes');
  fs.writeFileSync(path.join(dir, '使用说明.txt'), '双击 荣盈魔方\\荣盈魔方.exe');

  const out = path.join(base, 'out.zip');
  const argv = archiveArgv({ tool, format: 'zip', out, dir, contents: ['.'] });
  const bin = argv.bin === 'sevenZip' ? WIN_7Z : WIN_TAR;
  execFileSync(bin, argv.args, { cwd: dir, stdio: 'pipe' });

  assert.ok(fs.existsSync(out), '压缩包应该被创建出来');

  const extract = path.join(base, '解出来的');
  fs.mkdirSync(extract, { recursive: true });
  // ⚠️ 解压也走 `extractArgv`（一份实现）：这里原先手写 `if (tool === 'sevenZip')` ——
  //    而 `pickTool` 返回的是 `'7z'`，于是这个分支**永远走不到**，7z 的解压路径从没被测过
  //    （同一个"工具名有两个写法"的坑，CLI 那边就栽了：`7z -x -f …` ⇒ Too short switch）。
  const un = extractArgv({ tool, out, dir: extract });
  execFileSync(un.bin === 'sevenZip' ? WIN_7Z : WIN_TAR, un.args, { stdio: 'pipe' });

  const list = (root) => {
    const out = [];
    const walk = (d, rel) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), r);
        else out.push(r);
      }
    };
    walk(root, '');
    return out;
  };

  const diff = diffEntries(list(dir), list(extract));
  assert.deepEqual(diff.missing, []);
  assert.deepEqual(diff.extra, []);
  // 中文名的字节级往返：名字对了、内容也得对
  assert.equal(fs.readFileSync(path.join(extract, '荣盈魔方', 'resources', 'app.asar'), 'utf8'), 'asar-bytes');
  assert.ok(list(extract).some((p) => p === '使用说明.txt'));

  fs.rmSync(base, { recursive: true, force: true });
});

test('⑨ 解压命令：两种工具各自一套（**工具名不能认错**）', () => {
  const seven = extractArgv({ tool: '7z', out: 'C:\\o.zip', dir: 'C:\\t' });
  assert.equal(seven.bin, 'sevenZip');
  assert.deepEqual(seven.args, ['x', '-y', '-oC:\\t', 'C:\\o.zip']);

  const bsd = extractArgv({ tool: 'bsdtar', out: 'C:\\o.zip', dir: 'C:\\t' });
  assert.equal(bsd.bin, 'bsdtar');
  assert.deepEqual(bsd.args, ['-x', '-f', 'C:\\o.zip', '-C', 'C:\\t']);
});

test('⑩ 整条命令行走一遍（体检 → 打包 → 解出来对账）；找不到工具就明说"跳过＝未验证"', (t) => {
  const tools = detectTools();
  if (!pickTool(tools, 'zip')) {
    t.skip(`本机没有归档工具（bsdtar=${tools.bsdtar}, 7z=${tools.sevenZip}）⇒ 跳过＝未验证`);
    return;
  }

  // 造一个**能过体检**的交付夹：少了任何一条都会被 audit 拦下 ⇒ 也就测不到后面的解压对账。
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'udisk-cli-'));
  const dir = path.join(base, '荣盈魔方U盘交付-0.0.25');
  const write = (rel, data) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), data);
  };
  write(LAUNCHER_EXE_NAME, 'launcher');
  write(path.join('荣盈魔方', '荣盈魔方.exe'), 'exe');
  write(path.join('荣盈魔方', 'resources', 'app.asar'), 'asar');
  write(path.join('荣盈魔方', 'resources', 'runtime', RUNTIME_MANIFEST_NAME), '{}');
  write(
    '使用说明.txt',
    `双击 ${LAUNCHER_EXE_NAME}；数据落在盘上的 荣盈魔方-运行数据\\ 里；` +
      '请一直插在同一个 USB 口上（盘符变了就找不到数据）\r\n',
  );

  const out = path.join(base, '出包.zip');
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'make-udisk-archive.mjs');
  const stdout = execFileSync(process.execPath, [cli, dir, '--out', out], { encoding: 'utf8' });

  assert.ok(fs.existsSync(out), '压缩包应该被创建出来');
  assert.match(stdout, /对账通过/, `解压对账这一步必须真的跑过，实到输出：\n${stdout}`);
  assert.match(stdout, /荣盈魔方U盘版-0\.0\.25|出包\.zip/);

  fs.rmSync(base, { recursive: true, force: true });
});
