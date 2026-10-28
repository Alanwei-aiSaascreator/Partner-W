/**
 * 打包器纯函数测试。跑：node --test scripts/pack-runtime.test.mjs
 *
 * 只测不碰文件系统的那几个 —— 真去打一个 200MB 的包不该是单测的事
 * （那是 `node scripts/pack-runtime.mjs --version <v>` 自己的自检）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { selectSkillsToPrune, unmatchedKeepEntries, buildManifest, sha256File } from './pack-runtime.mjs';

test('剪枝走白名单：不在清单里的删掉，在清单里的留着', () => {
  const existing = ['1password', 'weather', 'sonoscli', 'diagnose-gateway'];
  const keep = ['weather', 'diagnose-gateway'];

  assert.deepEqual(selectSkillsToPrune(existing, keep), ['1password', 'sonoscli']);
});

test('保留清单里有、实际不存在的技能**不报错** —— 上游会改名下线，那不是错误', () => {
  const existing = ['weather'];
  const keep = ['weather', 'nonexistent-skill-上游删了'];

  assert.deepEqual(selectSkillsToPrune(existing, keep), []);
});

test('结果是排序的 —— 日志和断言都要稳定', () => {
  const existing = ['zeta', 'alpha', 'mid'];
  assert.deepEqual(selectSkillsToPrune(existing, []), ['alpha', 'mid', 'zeta']);
});

test('全部保留时什么都不删', () => {
  const existing = ['a', 'b'];
  assert.deepEqual(selectSkillsToPrune(existing, ['a', 'b']), []);
});

test('名单里匹配不上的条目会被点名 —— 写错目录不该无声无息', () => {
  // 真实踩过：add-model-provider 在 custodian-skills/ 下，不归 skills/ 管，
  // 写进保留名单是无效项，而剪枝照常"成功"。
  const existing = ['weather', 'diagram-maker'];
  const keep = ['weather', 'diagram-maker', 'add-model-provider', 'canvas'];

  assert.deepEqual(unmatchedKeepEntries(existing, keep), ['add-model-provider', 'canvas']);
});

test('全部匹配上时不出声', () => {
  assert.deepEqual(unmatchedKeepEntries(['weather'], ['weather']), []);
});

test('manifest 的字段与装载器要读的那份逐字一致（改名会静默变成 undefined）', () => {
  const m = buildManifest({
    version: '2026.9.3',
    archive: 'win32-x64/openclaw-runtime-2026.9.3.7z',
    archiveSize: 123,
    fileCount: 456,
    sha256: 'deadbeef',
    extractor: 'win32-x64/extractor/7za.exe',
  });

  assert.equal(m.formatVersion, 1);
  assert.equal(m.packageName, 'openclaw');
  assert.equal(m.version, '2026.9.3');
  assert.equal(m.runtimes.length, 1);

  const r = m.runtimes[0];
  // 逐个钉死：这些名字来自Partner-W的实际产物
  // （F:\0.0.17\resources\openclaw-runtime-manifest.json，2026-09-11 实测）。
  assert.deepEqual(Object.keys(r).sort(), [
    'arch',
    'archive',
    'archiveSize',
    'cliPath',
    'extractor',
    'fileCount',
    'packageRoot',
    'patches',
    'platform',
    'requiredPackages',
    'runtimeDeploymentKey',
    'sha256',
    'size',
    'source',
    'version',
  ]);

  assert.equal(r.platform, 'win32');
  assert.equal(r.arch, 'x64');
  assert.equal(r.runtimeDeploymentKey, r.version, '部署键必须等于版本号，装载器靠它决定要不要重解压');
  assert.equal(r.packageRoot, 'node_modules/openclaw');
  assert.equal(r.cliPath, 'node_modules/openclaw/openclaw.mjs', '装载器拉起网关用的就是这条路径');
  assert.equal(r.sha256, 'deadbeef');
});

test('sha256File 对大文件也走流式（与系统 sha256sum 结果一致）', () => {
  const f = path.join(os.tmpdir(), `pack-runtime-sha-${process.pid}.bin`);
  fs.writeFileSync(f, 'abc');
  try {
    // 'abc' 的 sha256 是公开已知值 —— 用已知值而不是"再算一遍比较"
    assert.equal(sha256File(f), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  } finally {
    fs.rmSync(f, { force: true });
  }
});

test('runtime manifest records the exact applied compatibility patches', () => {
  const patches = ['partner-w-relay-video-trial-v1'];
  const manifest = buildManifest({
    version: '2026.9.3',
    archive: 'runtime.7z',
    archiveSize: 1,
    fileCount: 2,
    sha256: 'new-archive-hash',
    extractor: '',
    patches,
  });
  assert.deepEqual(manifest.runtimes[0].patches, patches);
  patches.push('not-applied');
  assert.deepEqual(manifest.runtimes[0].patches, ['partner-w-relay-video-trial-v1']);
});
