import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * 「同一个量、多个来源」的一致性门禁。
 *
 * 为什么需要它：这些值散在四种文件里（TS 源码 / electron-builder.yml / 发布脚本 /
 * GitHub workflow），**编译器管不到它们之间**。改了一处忘了别处，症状是
 * "构建出来的包指向旧源"或"签名基线不一致"，而两条链在日志里长得都像正常。
 * 本仓库对这类"天然会漂移的一对"既有的处理方式就是**用一条断言钉住**
 * （见 `packages/desktop/test/runtime-packaging-gate.test.ts` 里 BUNDLED_TO ↔ locate.ts 那条）。
 *
 * ⚠️ 能收敛的已经收敛：客户端只有**一处**定义（`auto-updater.ts` 的
 *    `UPDATE_FEED_BASE`），`ipc/update-handlers.ts` 是 import 它。
 *    收敛不了的是跨语言/跨工具那几份（yml、发布脚本、workflow），所以这里断言它们取值一致。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, '..', '..');

function normalize(url) {
  return String(url).trim().replace(/\/+$/, '');
}

async function read(relativePath) {
  return readFile(join(REPOSITORY_ROOT, relativePath), 'utf8');
}

function extract(source, pattern, label) {
  const match = pattern.exec(source);
  assert.ok(match, `could not find ${label}`);
  return match[1];
}

/** 唯一真源：客户端自己的常量。 */
async function clientFeedBase() {
  return normalize(
    extract(
      await read('packages/desktop/src/main/auto-updater.ts'),
      /export const UPDATE_FEED_BASE = '([^']+)'/,
      'UPDATE_FEED_BASE in auto-updater.ts',
    ),
  );
}

test('electron-builder 的发布源与客户端的 UPDATE_FEED_BASE 一致', async () => {
  const yml = await read('packages/desktop/electron-builder.yml');
  const publishUrl = extract(yml, /\n {2}url: (\S+)\n/, 'publish.url in electron-builder.yml');

  assert.equal(normalize(publishUrl), await clientFeedBase());
});

test('上传器的 PUBLIC_BASE_URL 与客户端一致', async () => {
  const source = await read('scripts/lib/feed-publish.mjs');

  assert.equal(
    normalize(extract(source, /export const PUBLIC_BASE_URL = '([^']+)'/, 'PUBLIC_BASE_URL')),
    await clientFeedBase(),
  );
});

test('release workflow 的 PARTNERW_UPDATE_BASE_URL 与客户端一致', async () => {
  const source = await read('.github/workflows/release.yml');
  const jobUrl = normalize(
    extract(source, /PARTNERW_UPDATE_BASE_URL: (\S+)/, 'PARTNERW_UPDATE_BASE_URL in release.yml'),
  );

  assert.equal(jobUrl, await clientFeedBase());
});

test('release workflow 里传给 update:portable-package 的 --base-url 最终指向客户端那个源', async () => {
  const source = await read('.github/workflows/release.yml');
  const expected = await clientFeedBase();
  const args = [...source.matchAll(/--base-url "([^"]+)"|--base-url '([^']+)'/g)].map((match) => match[1] ?? match[2]);

  assert.ok(args.length > 0, 'no --base-url found in release.yml');
  for (const value of args) {
    // 要么写死同一个字面量，要么走那个已经被上一条测试钉住取值的 job 变量。
    if (value.startsWith('$')) {
      assert.equal(value, '$PARTNERW_UPDATE_BASE_URL');
      continue;
    }
    assert.equal(normalize(value), expected);
  }
});

test('两个版本变量在 runbook 里是两个名字，第 5 步不再用 PARTNERW_LAUNCHER_VERSION', async () => {
  const runbook = await read('docs/runbooks/portable-update-release.md');
  const step5 = /### 5\.[\s\S]*?(?=\n### 6\.)/.exec(runbook)?.[0] ?? '';

  assert.ok(step5.length > 0, 'could not find step 5 in the runbook');
  assert.match(step5, /PARTNERW_MIN_LAUNCHER_VERSION/);
  // 这一条是"变量纠偏"的本体：同一个名字曾经承载两个量，签出的包装不上。
  assert.doesNotMatch(step5, /\$env:PARTNERW_LAUNCHER_VERSION\b/);
});

test('两个版本变量在 release workflow 里都出现，且门槛不取自 RELEASE_TAG', async () => {
  const source = await read('.github/workflows/release.yml');

  assert.match(source, /PARTNERW_MIN_LAUNCHER_VERSION/);
  assert.match(source, /echo "PARTNERW_MIN_LAUNCHER_VERSION=\$PARTNERW_MIN_LAUNCHER_VERSION" >> "\$GITHUB_ENV"/);
  // ⛔ 若哪天有人把门槛改回 `RELEASE_TAG#v`，上一版基础包就永远升不上来。
  assert.doesNotMatch(source, /echo "PARTNERW_MIN_LAUNCHER_VERSION=\$\{RELEASE_TAG#v\}"/);
});

test('发布脚本仍拒绝在没有门槛变量时签包（禁止默认值）', async () => {
  const source = await read('scripts/make-portable-update.mjs');

  assert.match(source, /PARTNERW_MIN_LAUNCHER_VERSION/);
  assert.doesNotMatch(source, /PARTNERW_LAUNCHER_VERSION\s*\?\?\s*'/, 'a default value appeared');
});
