/**
 * Node 固化脚本的测试。跑：node --test scripts/fetch-node-runtime.test.mjs
 *
 * ⚠️ **不联网**：下载/解压那两步由脚本自己的 `--verify-only` 与真产物验收覆盖，
 * 单测只钉**判定逻辑**（解析、hash 语义、自洽校验）。
 *
 * ⚠️ 会话安全：只在 mkdtemp 里建删文件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertZipMatches,
  buildNodeManifest,
  parseShasums,
  innerDirName,
  sha256File,
  verifyNodeRuntime,
  zipNameFor,
} from './fetch-node-runtime.mjs';

// ---------------------------------------------------------------- 造实物

let counter = 0;

/** 一份"指向某个 node.exe"的 manifest —— 用来测**实物缺失/不符**的那几种情况。 */
const DETACHED_MANIFEST = buildNodeManifest({
  version: '26.3.1',
  platform: 'win32',
  arch: 'x64',
  nodeExeSha256: 'e'.repeat(64),
  nodeExeSize: 1,
  source: 'test',
});

/**
 * @param exeContent `null` = 不写 node.exe
 * @param license    `null` = 不写 LICENSE
 * @param manifest   `undefined` = 按实际 node.exe 生成**自洽**的一份；
 *                   对象 = 原样写；`null` = 不写
 */
function makeNodeDir({ exeContent = 'MZ fake node', license = 'MIT\n', manifest } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fetch-node-${process.pid}-${counter++}-`));
  if (exeContent !== null) fs.writeFileSync(path.join(dir, 'node.exe'), exeContent);
  if (license !== null) fs.writeFileSync(path.join(dir, 'LICENSE'), license);

  const manifestPath = path.join(dir, 'node-manifest.json');
  if (manifest === null) return dir; // 明确不写
  if (manifest !== undefined) {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    return dir;
  }

  const exe = path.join(dir, 'node.exe');
  if (!fs.existsSync(exe)) {
    throw new Error('makeNodeDir：要生成自洽 manifest 就得有 node.exe（或显式传 manifest）');
  }
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      buildNodeManifest({
        version: '26.3.1',
        platform: 'win32',
        arch: 'x64',
        nodeExeSha256: sha256File(exe),
        nodeExeSize: fs.statSync(exe).size,
        source: 'test',
      }),
    ),
  );
  return dir;
}

function cleanup(dir) {
  if (dir && dir.includes(path.join(os.tmpdir(), 'fetch-node-'))) fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- SHASUMS

test('SHASUMS256 解析：取出文件名与 hash，跳过空行与注释', () => {
  const text = [
    'a'.repeat(64) + '  node-v26.3.1-win-x64.zip',
    'B'.repeat(64) + ' *node-v26.3.1-linux-x64.tar.gz',
    '',
    'not a valid line',
    '  ',
  ].join('\n');

  const map = parseShasums(text);

  assert.equal(map.get('node-v26.3.1-win-x64.zip'), 'a'.repeat(64));
  // `*` 是二进制标记，要剥掉；大小写归一
  assert.equal(map.get('node-v26.3.1-linux-x64.tar.gz'), 'b'.repeat(64));
  assert.equal(map.size, 2);
});

test('⭐ 官方发布包的文件名用**下载命名** win-x64，不是 process.platform 的 win32', () => {
  // 实测踩过：`node-v26.3.1-win32-x64.zip` 直接 404，真名是 `...-win-x64.zip`
  assert.equal(zipNameFor('26.3.1', 'win32', 'x64'), 'node-v26.3.1-win-x64.zip');
  // 解压后 zip 内部那层目录同样是下载命名
  assert.equal(innerDirName('26.3.1', 'win32', 'x64'), 'node-v26.3.1-win-x64');
  // 非 Windows 两边一致
  assert.equal(zipNameFor('26.3.1', 'linux', 'x64'), 'node-v26.3.1-linux-x64.zip');
});

test('ZIP hash 不符 ⇒ 抛错（且说清是"下载已损坏"）', () => {
  const shasums = new Map([['node-v26.3.1-win32-x64.zip', 'a'.repeat(64)]]);
  assert.throws(() => assertZipMatches(shasums, 'node-v26.3.1-win32-x64.zip', 'b'.repeat(64)), /不符|损坏/);
});

test('清单里没有这个文件名 ⇒ 抛错（版本号写错或还没发布）', () => {
  assert.throws(() => assertZipMatches(new Map(), 'node-v9.9.9-win32-x64.zip', 'a'.repeat(64)), /没有/);
});

test('ZIP hash 相符 ⇒ 通过', () => {
  const shasums = new Map([['node-v26.3.1-win32-x64.zip', 'a'.repeat(64)]]);
  assert.equal(assertZipMatches(shasums, 'node-v26.3.1-win32-x64.zip', 'a'.repeat(64)), 'a'.repeat(64));
});

// ---------------------------------------------------------------- manifest

test('⭐ manifest 记的是 **node.exe 自己的** hash，不是 ZIP 的', () => {
  const m = buildNodeManifest({
    version: '26.3.1',
    platform: 'win32',
    arch: 'x64',
    nodeExeSha256: 'c'.repeat(64), // ← 现算的 node.exe hash
    nodeExeSize: 12345,
    source: 'https://nodejs.org/dist/v26.3.1/node-v26.3.1-win32-x64.zip',
  });

  assert.equal(m.formatVersion, 1);
  assert.equal(m.packageName, 'node');
  assert.equal(m.nodes.length, 1);
  assert.equal(m.nodes[0].sha256, 'c'.repeat(64));
  assert.equal(m.nodes[0].size, 12345);
  // source 记的是**下载来源**（ZIP），它和 sha256 语义不同 —— 不许混
  assert.match(m.nodes[0].source, /\.zip$/);
});

test('manifest 的 platform / arch / version / path 正确', () => {
  const m = buildNodeManifest({
    version: '24.16.0',
    platform: 'win32',
    arch: 'x64',
    nodeExeSha256: 'd'.repeat(64),
    nodeExeSize: 1,
    source: 'x',
  });
  const n = m.nodes[0];

  assert.equal(n.platform, 'win32');
  assert.equal(n.arch, 'x64');
  assert.equal(n.version, '24.16.0');
  assert.equal(n.path, 'node/node.exe', '装载器 resolveNodePath() 按这条拼，必须相对运行时根');
});

// ---------------------------------------------------------------- 自洽校验

test('自洽的 node/ ⇒ 通过，并回读身份', () => {
  const dir = makeNodeDir();
  try {
    const res = verifyNodeRuntime(dir);
    assert.equal(res.ok, true, res.problems.join('; '));
    assert.equal(res.node.version, '26.3.1');
    assert.equal(res.node.size, fs.statSync(path.join(dir, 'node.exe')).size);
    assert.equal(res.node.sha256, sha256File(path.join(dir, 'node.exe')));
  } finally {
    cleanup(dir);
  }
});

test('⭐ 缺 node.exe ⇒ FAIL', () => {
  const dir = makeNodeDir({ exeContent: null, manifest: DETACHED_MANIFEST });
  try {
    const res = verifyNodeRuntime(dir);
    assert.equal(res.ok, false);
    assert.ok(res.problems.some((p) => p.includes('node.exe')));
  } finally {
    cleanup(dir);
  }
});

test('⭐ 缺 LICENSE ⇒ FAIL（分发 Node 必须带许可）', () => {
  const dir = makeNodeDir({ license: null });
  try {
    const res = verifyNodeRuntime(dir);
    assert.equal(res.ok, false);
    assert.ok(res.problems.some((p) => p.includes('LICENSE')));
  } finally {
    cleanup(dir);
  }
});

test('⭐ node.exe 的 sha256 与 manifest 不符 ⇒ FAIL', () => {
  const dir = makeNodeDir();
  try {
    // 交付后被人换过 / 传坏了
    fs.writeFileSync(path.join(dir, 'node.exe'), 'MZ tampered node');
    const res = verifyNodeRuntime(dir);
    assert.equal(res.ok, false);
    assert.ok(res.problems.some((p) => /sha256/.test(p)));
  } finally {
    cleanup(dir);
  }
});

test('⭐ node.exe 的 size 与 manifest 不符 ⇒ FAIL', () => {
  const dir = makeNodeDir();
  try {
    const manifestPath = path.join(dir, 'node-manifest.json');
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    m.nodes[0].size = 999999; // 只改 size，hash 仍对不上 —— 但 size 这条也要报
    fs.writeFileSync(manifestPath, JSON.stringify(m));

    const res = verifyNodeRuntime(dir);
    assert.equal(res.ok, false);
    assert.ok(res.problems.some((p) => /体积|size/.test(p)));
  } finally {
    cleanup(dir);
  }
});

test('⭐ 缺 node-manifest.json ⇒ FAIL（没有身份就不是可用的部署源）', () => {
  const dir = makeNodeDir({ exeContent: null, manifest: null });
  fs.writeFileSync(path.join(dir, 'node.exe'), 'x');
  try {
    const res = verifyNodeRuntime(dir);
    assert.equal(res.ok, false);
    assert.ok(res.problems.some((p) => p.includes('node-manifest.json')));
  } finally {
    cleanup(dir);
  }
});

test('manifest 是半截 JSON ⇒ FAIL（不是崩）', () => {
  const dir = makeNodeDir({ exeContent: null, manifest: null });
  fs.writeFileSync(path.join(dir, 'node-manifest.json'), '{ "nodes": [');
  try {
    const res = verifyNodeRuntime(dir);
    assert.equal(res.ok, false);
    assert.ok(res.problems.some((p) => p.includes('JSON')));
  } finally {
    cleanup(dir);
  }
});

test('path 不对 ⇒ FAIL（装载器按它拼路径，写错等于找不到 node）', () => {
  const dir = makeNodeDir();
  try {
    const manifestPath = path.join(dir, 'node-manifest.json');
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    m.nodes[0].path = 'node.exe'; // 少了 node/ 前缀
    fs.writeFileSync(manifestPath, JSON.stringify(m));

    const res = verifyNodeRuntime(dir);
    assert.equal(res.ok, false);
    assert.ok(res.problems.some((p) => p.includes('path')));
  } finally {
    cleanup(dir);
  }
});

test('一次把多个毛病都列出来，而不是只报第一个', () => {
  const dir = makeNodeDir({ exeContent: null, license: null, manifest: DETACHED_MANIFEST });
  try {
    const res = verifyNodeRuntime(dir);
    assert.equal(res.ok, false);
    assert.ok(res.problems.length >= 2, `期望至少两条问题，实际：${JSON.stringify(res.problems)}`);
  } finally {
    cleanup(dir);
  }
});
