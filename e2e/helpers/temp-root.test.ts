/**
 * E2E 临时根 / junction-safe 删除的回归测试。
 *
 * 跑法： `node --test e2e/helpers/temp-root.test.ts`
 *
 * ⚠️ **会话安全**：本文件只在 `mkdtemp` 出来的 scratch root 里建删东西，
 * 绝不碰 `%APPDATA%` / `%LOCALAPPDATA%` / 真实 OpenClaw state / 真实 runtime cache。
 *
 * ⚠️ 最重要的一条是 **junction negative control**（`sentinel` 那组）：
 * 有过真实事故 —— Git Bash 的 `rm -rf` 跟进目录 junction，把链接指向的
 * **真实 node_modules/openclaw** 删掉了。所以这里必须证明：
 * 清理 profile 之后，profile **外面**的 target 逐字节不变。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  dirSizeBytes,
  findReparsePoints,
  freshProfile,
  isProfileName,
  isReparsePoint,
  listProfiles,
  purgeProfiles,
  readLinkTarget,
  resetE2ETempRootCache,
  resolveE2ETempRoot,
  safeRemoveTree,
  sweepStaleProfiles,
} from './temp-root.ts';

let scratch: string;

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'clawwork-temp-root-test-'));
});

after(() => {
  if (scratch) safeRemoveTree(scratch);
});

/** 建一个目录 junction（Windows 上不需要管理员）。 */
function makeJunction(linkPath: string, target: string): boolean {
  try {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, target], { stdio: 'ignore', windowsHide: true });
    return fs.existsSync(linkPath);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- A. 普通目录

test('A. 普通目录：删干净', () => {
  const dir = path.join(scratch, 'plain');
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a', 'b', 'f.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'top.txt'), 'y');

  assert.ok(fs.existsSync(dir));
  safeRemoveTree(dir);
  assert.equal(fs.existsSync(dir), false, '普通目录应当被完全删除');
});

test('A2. 不存在的路径：静默返回，不抛', () => {
  assert.doesNotThrow(() => safeRemoveTree(path.join(scratch, 'nope-nope')));
});

// ---------------------------------------------------------------- B. junction（negative control）

test('B. ⭐ junction negative control：删掉 profile，外部 sentinel 逐字节不变', (t) => {
  const sentinelDir = path.join(scratch, 'sentinelDir');
  const sentinelFile = path.join(sentinelDir, 'sentinel.txt');
  const sentinelBody = 'DO-NOT-DELETE\r\n';
  fs.mkdirSync(sentinelDir, { recursive: true });
  fs.writeFileSync(sentinelFile, sentinelBody);
  fs.writeFileSync(path.join(sentinelDir, 'other.bin'), 'payload');

  const profile = path.join(scratch, 'profile-with-junction');
  fs.mkdirSync(path.join(profile, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'runtime', 'normal.txt'), 'normal');

  const link = path.join(profile, 'runtime', 'node_modules', 'openclaw');
  const created = makeJunction(link, sentinelDir);
  if (!created) {
    // 建不出 junction 的环境（权限/非 Windows）不能把这条保护静默跳过
    t.diagnostic('⚠️ 无法创建 junction —— 这条 negative control 没有真正执行');
    assert.fail('无法创建 junction：不允许静默跳过这条最关键的回归测试');
  }

  // 前置事实：Node 必须认得它
  assert.equal(isReparsePoint(link), true, 'junction 必须被 isReparsePoint 认出来');
  assert.equal(readLinkTarget(link)?.toLowerCase(), sentinelDir.toLowerCase());

  safeRemoveTree(profile);

  assert.equal(fs.existsSync(profile), false, 'profile 应当被删除');
  assert.ok(fs.existsSync(sentinelDir), '⛔ sentinel 目录被删了 —— 删除跟随了 junction！');
  assert.equal(fs.readFileSync(sentinelFile, 'utf8'), sentinelBody, '⛔ sentinel 内容变了！');
  assert.ok(fs.existsSync(path.join(sentinelDir, 'other.bin')), '⛔ sentinel 里的其它文件没了！');
});

test('B2. 只有 junction 的 profile：同样安全', (t) => {
  const sentinelDir = path.join(scratch, 'sentinelDir2');
  fs.mkdirSync(sentinelDir, { recursive: true });
  fs.writeFileSync(path.join(sentinelDir, 'keep.txt'), 'keep');

  const profile = path.join(scratch, 'only-junction');
  fs.mkdirSync(profile, { recursive: true });
  const link = path.join(profile, 'link');
  if (!makeJunction(link, sentinelDir)) {
    t.diagnostic('⚠️ 无法创建 junction');
    assert.fail('无法创建 junction');
  }

  safeRemoveTree(profile);

  assert.equal(fs.existsSync(profile), false);
  assert.ok(fs.existsSync(path.join(sentinelDir, 'keep.txt')), 'sentinel 必须活着');
});

// ---------------------------------------------------------------- C. 只读扫描

test('C. dirSizeBytes 不把 junction 的 target 算进来', (t) => {
  const sentinelDir = path.join(scratch, 'bigSentinel');
  fs.mkdirSync(sentinelDir, { recursive: true });
  fs.writeFileSync(path.join(sentinelDir, 'big.bin'), Buffer.alloc(200_000, 1));

  const profile = path.join(scratch, 'size-profile');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'small.txt'), 'abc');
  const link = path.join(profile, 'link');
  if (!makeJunction(link, sentinelDir)) {
    t.diagnostic('⚠️ 无法创建 junction');
    assert.fail('无法创建 junction');
  }

  const size = dirSizeBytes(profile);
  assert.ok(size < 10_000, `junction 的 target 被算进来了：${size} 字节（应当只有 small.txt）`);
});

test('C2. findReparsePoints 找得到 junction，且不进入 target', (t) => {
  const sentinelDir = path.join(scratch, 'findSentinel');
  fs.mkdirSync(sentinelDir, { recursive: true });
  fs.writeFileSync(path.join(sentinelDir, 'x.txt'), 'x');

  const profile = path.join(scratch, 'find-profile');
  fs.mkdirSync(profile, { recursive: true });
  const link = path.join(profile, 'link');
  if (!makeJunction(link, sentinelDir)) {
    t.diagnostic('⚠️ 无法创建 junction');
    assert.fail('无法创建 junction');
  }

  const found = findReparsePoints(profile);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.path, link);
  assert.equal(found[0]!.target?.toLowerCase(), sentinelDir.toLowerCase());
});

// ---------------------------------------------------------------- D. 名字守卫

test('D. isProfileName 只认自己的前缀（防误删）', () => {
  assert.equal(isProfileName('clawwork-2a-active-abc'), true);
  assert.equal(isProfileName('clawwork-packaged-'), true);
  assert.equal(isProfileName('clawwork-'), false);
  assert.equal(isProfileName('..clawwork-x'), false);
  assert.equal(isProfileName('clawwork-..-evil'), false);
  assert.equal(isProfileName('some-other-dir'), false);
  assert.equal(isProfileName('AppData'), false);
});

// ---------------------------------------------------------------- E. 保留策略

test('E. sweepStaleProfiles 保留最新的、删掉又老又没人用的', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawwork-sweep-test-'));
  try {
    const old = path.join(root, 'clawwork-old-1');
    const mid = path.join(root, 'clawwork-mid-2');
    const fresh = path.join(root, 'clawwork-fresh-3');
    fs.mkdirSync(old);
    fs.mkdirSync(mid);
    fs.mkdirSync(fresh);
    fs.writeFileSync(path.join(old, 'f.bin'), 'old');
    fs.writeFileSync(path.join(mid, 'f.bin'), 'mid');

    // 把 old 与 mid 改成"48 小时前"，fresh 保持现在
    const oldTime = new Date(Date.now() - 48 * 3_600_000);
    fs.utimesSync(old, oldTime, oldTime);
    fs.utimesSync(mid, oldTime, oldTime);

    // 非 profile 目录必须被无视
    const stranger = path.join(root, 'not-a-profile');
    fs.mkdirSync(stranger);

    const res = sweepStaleProfiles({ root, keepNewest: 1, staleHours: 24, maxRetainBytes: 10 ** 12, log: () => {} });

    assert.ok(res.removed.includes(old), '老的应当被删');
    assert.ok(res.removed.includes(mid), 'mid 也该被删（超过 keepNewest=1 且已 stale）');
    assert.equal(fs.existsSync(fresh), true, '最新的必须保留');
    assert.equal(fs.existsSync(stranger), true, '⛔ 非 profile 目录被删了');
    assert.ok(res.freedBytes > 0);
  } finally {
    safeRemoveTree(root);
  }
});

test('E2. keepNewest 保护最近的几个（哪怕它们很老）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawwork-sweep-keep-'));
  try {
    const names = ['clawwork-a-1', 'clawwork-b-2', 'clawwork-c-3'];
    for (const n of names) {
      fs.mkdirSync(path.join(root, n));
      const t = new Date(Date.now() - 96 * 3_600_000);
      fs.utimesSync(path.join(root, n), t, t);
    }
    const res = sweepStaleProfiles({ root, keepNewest: 2, staleHours: 1, maxRetainBytes: 10 ** 12, log: () => {} });
    assert.equal(res.removed.length, 1, '只该删掉最旧的那一个');
    assert.equal(fs.readdirSync(root).filter(isProfileName).length, 2);
  } finally {
    safeRemoveTree(root);
  }
});

test('E3. purgeProfiles 只留最新 N 个（**不看年龄**，与 sweep 的差别就在这里）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawwork-purge-test-'));
  try {
    const names = ['clawwork-a-1', 'clawwork-b-2', 'clawwork-c-3', 'clawwork-d-4'];
    names.forEach((n, i) => {
      const dir = path.join(root, n);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'f.bin'), 'x'.repeat(100 + i));
      // 全部都是"刚刚写的" ⇒ sweep 会一个都不删，purge 必须删掉多余的
      const t = new Date(Date.now() - i * 60_000);
      fs.utimesSync(dir, t, t);
    });
    const stranger = path.join(root, 'not-a-profile');
    fs.mkdirSync(stranger);

    const res = purgeProfiles({ root, keepNewest: 2, log: () => {} });

    assert.equal(res.removed.length, 2, '应当只删掉多出来的 2 个');
    assert.equal(fs.readdirSync(root).filter(isProfileName).length, 2);
    assert.equal(fs.existsSync(stranger), true, '⛔ 非 profile 目录被删了');
    assert.ok(res.freedBytes > 0);
    assert.ok(
      res.kept.every((p) => fs.existsSync(p)),
      '保留的必须还在',
    );
  } finally {
    safeRemoveTree(root);
  }
});

test('E4. purgeProfiles 也走 junction-safe（negative control）', (t) => {
  const sentinelDir = path.join(scratch, 'purgeSentinel');
  fs.mkdirSync(sentinelDir, { recursive: true });
  fs.writeFileSync(path.join(sentinelDir, 'keep.txt'), 'keep-me');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawwork-purge-junction-'));
  try {
    const victim = path.join(root, 'clawwork-victim-1');
    const fresh = path.join(root, 'clawwork-fresh-2');
    fs.mkdirSync(path.join(victim, 'runtime', 'node_modules'), { recursive: true });
    fs.mkdirSync(fresh);
    const link = path.join(victim, 'runtime', 'node_modules', 'openclaw');
    if (!makeJunction(link, sentinelDir)) {
      t.diagnostic('⚠️ 无法创建 junction');
      assert.fail('无法创建 junction');
    }
    // victim 更旧 ⇒ 会被 purge 掉
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(victim, old, old);

    const res = purgeProfiles({ root, keepNewest: 1, log: () => {} });

    assert.ok(res.removed.includes(victim), '旧的应当被删');
    assert.equal(fs.existsSync(victim), false);
    assert.equal(fs.readFileSync(path.join(sentinelDir, 'keep.txt'), 'utf8'), 'keep-me', '⛔ sentinel 被动了');
  } finally {
    safeRemoveTree(root);
  }
});

// ---------------------------------------------------------------- F. 根目录解析

test('F. CLAWWORK_E2E_TEMP_ROOT 优先于默认值', () => {
  const custom = fs.mkdtempSync(path.join(os.tmpdir(), 'clawwork-root-env-'));
  const prev = process.env.CLAWWORK_E2E_TEMP_ROOT;
  try {
    process.env.CLAWWORK_E2E_TEMP_ROOT = custom;
    resetE2ETempRootCache();
    assert.equal(resolveE2ETempRoot(), path.resolve(custom));

    const p = freshProfile('probe');
    assert.equal(path.dirname(p), path.resolve(custom), 'freshProfile 必须落在统一根下');
    assert.ok(path.basename(p).startsWith('clawwork-probe-'));
    assert.ok(fs.existsSync(p));
    safeRemoveTree(p);
    assert.equal(fs.existsSync(p), false);
  } finally {
    if (prev === undefined) delete process.env.CLAWWORK_E2E_TEMP_ROOT;
    else process.env.CLAWWORK_E2E_TEMP_ROOT = prev;
    resetE2ETempRootCache();
    safeRemoveTree(custom);
  }
});

test('F2. 没有环境变量时，根目录不是裸 tmpdir', () => {
  const prev = process.env.CLAWWORK_E2E_TEMP_ROOT;
  try {
    delete process.env.CLAWWORK_E2E_TEMP_ROOT;
    resetE2ETempRootCache();
    const root = resolveE2ETempRoot();
    assert.notEqual(path.resolve(root), path.resolve(os.tmpdir()), '不能直接把文件堆在裸 tmpdir 根上');
    assert.ok(fs.existsSync(root));
  } finally {
    if (prev !== undefined) process.env.CLAWWORK_E2E_TEMP_ROOT = prev;
    resetE2ETempRootCache();
  }
});

// ---------------------------------------------------------------- G. 盘点

test('G. listProfiles 只列 profile 且按最近写入倒序', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawwork-list-test-'));
  try {
    fs.mkdirSync(path.join(root, 'clawwork-x-1'));
    fs.mkdirSync(path.join(root, 'clawwork-y-2'));
    fs.mkdirSync(path.join(root, 'stranger'));
    const older = new Date(Date.now() - 3_600_000);
    fs.utimesSync(path.join(root, 'clawwork-x-1'), older, older);

    const list = listProfiles(root);
    assert.equal(list.length, 2);
    assert.ok(list[0]!.path.endsWith('clawwork-y-2'), '最近的排最前');
  } finally {
    safeRemoveTree(root);
  }
});
