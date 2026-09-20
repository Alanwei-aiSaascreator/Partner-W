/**
 * U 盘交付包机检的测试。跑：node --test scripts/lib/udisk-delivery.test.mjs
 *
 * 用**真实临时目录**（不是假 fs）造一个交付包 —— 判据是文件与文件名，
 * 拿假 fs 测等于把判据本身也一起假掉了。
 *
 * ⚠️ 最后那组"漂移用例"是这组测试里最值钱的：三个常量分别抄自 TS 源码，
 *    源码改了而这里没改 ⇒ 机检会用**过期的判据**给出"可以交付"（假绿）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APP_DIR_NAME,
  ASAR_REL,
  auditDelivery,
  bufferHasString,
  BUNDLED_RUNTIME_MANIFEST_REL,
  EXE_REL,
  INSTANCE_BUSY_TITLE,
  INSTALLER_DIR_PREFIX,
  LAUNCHER_BAT_NAME,
  planFixes,
  readmeProblems,
  REMOVED_DIR_PREFIX,
  README_NAME,
  RUN_DATA_DIR_NAME,
  RUNTIME_MANIFEST_NAME,
  versionFromFolderName,
} from './udisk-delivery.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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

/** 造一个交付包；`over` 里可以点名"要坏成什么样"。 */
function makeDelivery(over = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'udisk-delivery-'));
  const write = (rel, data) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  };

  write(EXE_REL, 'stub exe');
  write(ASAR_REL, Buffer.from(`...const t = "${INSTANCE_BUSY_TITLE}";...`, 'utf8'));
  write(BUNDLED_RUNTIME_MANIFEST_REL, '{}');
  write(README_NAME, `怎么打开：双击 ${APP_DIR_NAME}\\荣盈魔方.exe\r\n数据在盘上的 ${RUN_DATA_DIR_NAME}\\ 里\r\n`);

  if (over.bat) write(LAUNCHER_BAT_NAME, '@echo off\r\n');
  if (over.installer) write(`${INSTALLER_DIR_PREFIX}-装了就不能用便携版/荣盈魔方-0.0.24-win-x64.exe`, 'stub');
  if (over.staleBuild) write(ASAR_REL, Buffer.from('...app.quit();...', 'utf8'));
  if (over.escapedBuild) {
    const escaped = [...INSTANCE_BUSY_TITLE]
      .map((c) => (c.charCodeAt(0) > 127 ? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}` : c))
      .join('');
    write(ASAR_REL, Buffer.from(`const t = "${escaped}";`, 'utf8'));
  }
  if (over.readme) write(README_NAME, over.readme);
  if (over.noReadme) fs.rmSync(path.join(root, README_NAME));
  if (over.noRuntime) fs.rmSync(path.join(root, BUNDLED_RUNTIME_MANIFEST_REL));
  if (over.noExe) fs.rmSync(path.join(root, EXE_REL));

  return root;
}

const ids = (findings) => findings.map((f) => f.id);
const errors = (findings) => findings.filter((f) => f.level === 'error');

test('① 新构建 + 去掉 .bat + 说明已更新 ⇒ 一条 findings 都没有（干净包就该闭嘴）', () => {
  const root = makeDelivery();
  const findings = auditDelivery(io, root);

  assert.deepEqual(errors(findings), [], `不该有错误，实到：${JSON.stringify(ids(findings))}`);
  // ⚠️ 连 warn 一起断言：只断言 errors 的话，"所有判据都退化成 warn"这种坏法测不出来。
  assert.deepEqual(findings, [], `干净包不该有任何 findings，实到：${JSON.stringify(ids(findings))}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('② 新构建但还留着 .bat ⇒ error，且给出"搬出去"的动作', () => {
  const root = makeDelivery({ bat: true });
  const findings = auditDelivery(io, root);

  assert.ok(ids(findings).includes('launcher-bat'));
  const fix = findings.find((f) => f.id === 'launcher-bat').fix;
  assert.equal(fix.kind, 'move-out');
  fs.rmSync(root, { recursive: true, force: true });
});

test('③ 老构建（asar 里没有指纹）⇒ error「不能去掉 .bat」，且不许报 .bat 该删', () => {
  const root = makeDelivery({ staleBuild: true, bat: true });
  const findings = auditDelivery(io, root);

  assert.ok(ids(findings).includes('stale-build'));
  assert.ok(!ids(findings).includes('launcher-bat'), '.bat 是老构建的救命稻草，不该建议删掉');
  fs.rmSync(root, { recursive: true, force: true });
});

test('④ 老构建 + 没有 .bat ⇒ 额外点名"双击第二份会毫无反应"', () => {
  const root = makeDelivery({ staleBuild: true });
  const findings = auditDelivery(io, root);

  assert.ok(ids(findings).includes('no-explainer'));
  const f = findings.find((x) => x.id === 'no-explainer');
  assert.match(f.detail, /什么都不会发生/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('⑤ 包里的运行时被删掉 ⇒ error（0.0.19"装完完全用不了"那个形状）', () => {
  const root = makeDelivery({ noRuntime: true });
  const findings = auditDelivery(io, root);

  assert.ok(ids(findings).includes('missing-bundled-runtime'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('⑥ 说明还在教用户双击 .bat ⇒ warn，并逐条列出该改什么', () => {
  const root = makeDelivery({ readme: `怎么打开：双击「${LAUNCHER_BAT_NAME}」\r\n` });
  const findings = auditDelivery(io, root);

  const stale = findings.find((f) => f.id === 'readme-stale');
  assert.ok(stale, '应报 readme-stale');
  assert.equal(stale.level, 'warn');
  assert.match(stale.detail, /还在教用户双击/);
  assert.match(stale.detail, /荣盈魔方\.exe/);
  assert.match(stale.detail, /荣盈魔方-运行数据/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('⑦ 同包裹里带着安装包 ⇒ warn（会把用户引向"装到电脑"）', () => {
  const root = makeDelivery({ installer: true });
  const findings = auditDelivery(io, root);

  assert.equal(findings.find((f) => f.id === 'installer-folder').level, 'warn');
  fs.rmSync(root, { recursive: true, force: true });
});

test('⑧ 缺 exe / 缺 app.asar ⇒ 两条 error（先认清"这是不是交付包"）', () => {
  const noExe = makeDelivery({ noExe: true });
  assert.ok(ids(auditDelivery(io, noExe)).includes('missing-exe'));
  fs.rmSync(noExe, { recursive: true, force: true });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'udisk-empty-'));
  fs.mkdirSync(path.join(dir, APP_DIR_NAME), { recursive: true });
  const findings = auditDelivery(io, dir);
  assert.ok(ids(findings).includes('missing-asar'));
  assert.ok(!ids(findings).includes('stale-build'), '读不到 asar 时不许下"构建太老"的结论');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('⑨ 指纹被转义成 \\uXXXX（换了打包器）也认', () => {
  const root = makeDelivery({ escapedBuild: true });
  assert.ok(!ids(auditDelivery(io, root)).includes('stale-build'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('⑩ bufferHasString：两个方向都试过（原文 / 转义、大写 / 小写）', () => {
  assert.equal(bufferHasString(Buffer.from('前缀荣盈魔方已经在运行后缀'), INSTANCE_BUSY_TITLE), true);
  assert.equal(bufferHasString(Buffer.from('const a = "\\u8363\\u76c8\\u9b54\\u65b9";'), '荣盈魔方'), true);
  assert.equal(bufferHasString(Buffer.from('const a = "\\u8363\\u76C8\\u9B54\\u65B9";'), '荣盈魔方'), true);
  assert.equal(bufferHasString(Buffer.from('什么都没写'), INSTANCE_BUSY_TITLE), false);
  assert.equal(bufferHasString(null, INSTANCE_BUSY_TITLE), false);
});

test('⑪ planFixes 只动"标记了 fix 的那条"，且搬到交付包**外面**（不会被复制进 U 盘）', () => {
  const root = makeDelivery({ bat: true, installer: true });
  const findings = auditDelivery(io, root);
  const actions = planFixes(findings, root, '20260920-1300');

  assert.equal(actions.length, 1);
  assert.equal(actions[0].from, path.join(root, LAUNCHER_BAT_NAME));
  assert.equal(actions[0].to, path.join(root, '..', `${REMOVED_DIR_PREFIX}-20260920-1300`, LAUNCHER_BAT_NAME));
  assert.ok(!ids(findings).includes('installer-folder') || actions.every((a) => !a.from.includes('装到电脑')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('⑫ 说明体检本身：写全了就不报，缺哪条报哪条', () => {
  assert.deepEqual(readmeProblems(`双击 ${APP_DIR_NAME}\\荣盈魔方.exe，数据在 ${RUN_DATA_DIR_NAME}\\`), []);
  assert.equal(readmeProblems('双击这里启动.bat').length, 3);
});

test('⑬ 版本号从交付夹名字里取（取不到就说取不到，不许编）', () => {
  assert.equal(versionFromFolderName('荣盈魔方U盘交付-0.0.24'), '0.0.24');
  assert.equal(versionFromFolderName('荣盈魔方U盘交付'), null);
});

// ───────────────────────── 漂移守卫（本文件最值钱的四条） ─────────────────────────

function readRepoFile(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('⑭ 数据目录名与 portable-app-data.ts 一致（否则说明与机检都在念错的路径）', () => {
  const src = readRepoFile('packages/desktop/src/main/runtime/portable-app-data.ts');
  assert.match(src, new RegExp(`PORTABLE_APP_DATA_DIR_NAME\\s*=\\s*'${RUN_DATA_DIR_NAME}'`));
});

test('⑮ 认盘 marker 名与 locate.ts 一致', () => {
  const src = readRepoFile('packages/desktop/src/main/runtime/locate.ts');
  assert.match(src, new RegExp(`RUNTIME_MANIFEST_FILE\\s*=\\s*'${RUNTIME_MANIFEST_NAME}'`));
});

test('⑯ "自解释"指纹在 instance-guard.ts 里真的存在（否则闸门会冤枉所有新构建）', () => {
  const src = readRepoFile('packages/desktop/src/main/runtime/instance-guard.ts');
  assert.ok(src.includes(`'${INSTANCE_BUSY_TITLE}'`), `instance-guard.ts 里找不到 '${INSTANCE_BUSY_TITLE}'`);
});

test('⑰ .bat 名字与交付包里那个一致（改名了要连说明一起改）', () => {
  assert.equal(LAUNCHER_BAT_NAME, '①双击这里启动.bat');
});
