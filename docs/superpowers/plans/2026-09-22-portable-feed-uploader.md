# 整目录 feed 人工上传器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让整目录更新 feed 的发布成为一件**可恢复、可审计、可并发控制**的操作：本地先验证再上传、版本目录不可变、manifest **经 SFTP 真正上传**后原子翻转、任何不确定结果都保留锁并交人工处理。

**Architecture:** 纯逻辑模块 `scripts/lib/feed-publish.mjs` 负责全部判定与流程编排；远端动作由 `scripts/lib/feed-publish-transport.mjs` 提供，**全部是 async**，并把 `execFile` / `fetch` 作为注入依赖，因此测试用假实现、绝不联网。CLI `scripts/feed-publish.mjs` 用**顶层 `await`** 调 `main`，四种模式（`--dry-run` / `--preflight` / `--commit` / `--break-lock`）**全部接上真实 transport，没有占位分支**。

**Tech Stack:** Node 20（ESM、`node:test`、`node:assert/strict`、全局 `fetch`）、系统 `ssh` / `sftp` 二进制（仓库无任何 SSH 依赖）、pnpm 10。

**规格来源：** `docs/superpowers/specs/2026-09-22-portable-release-infrastructure-correction-design.md` §6.1–§6.16。

---

## 文件地图

| 文件                                          | 动作 | 职责                                                                                                        |
| --------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------- |
| `scripts/lib/feed-publish.mjs`                | 新建 | 常量、输入校验、本地预验证、锁生命周期、远端目录探针、13 步流程编排、CAS、不确定结果三分、逐阶段审计        |
| `scripts/lib/feed-publish.test.mjs`           | 新建 | 上述逻辑的单测（**async** 假 transport）                                                                    |
| `scripts/lib/feed-publish-transport.mjs`      | 新建 | 真实 SSH / SFTP / https 适配器（argv 数组、BatchMode、StrictHostKeyChecking、固定 known_hosts、batch 引用） |
| `scripts/lib/feed-publish-transport.test.mjs` | 新建 | 注入假 `execFile` / `fetchPublic` 的 transport 单测（**不联网**）                                           |
| `scripts/feed-publish.mjs`                    | 新建 | CLI：四种模式，顶层 `await main`，`process.exitCode`                                                        |
| `scripts/lib/feed-publish-cli.test.mjs`       | 新建 | CLI 参数守卫测试                                                                                            |
| `docs/runbooks/portable-update-release.md`    | 修改 | 第 7/9/10 步改为调用上传器；受限账号、nginx、发布前检查单                                                   |
| `package.json`                                | 修改 | 新增 `check:portable-feed-publish` 并接入 `check`                                                           |

**禁止事项（贯穿全计划）：** 不连接、不修改任何服务器；不生成生产密钥；不写入任何真实口令、token 或 host-key 指纹；不把审计日志写进仓库。

**测试纪律：** 任何测试**不得**真的调用 `ssh` / `sftp` / 网络。真实 transport 通过**注入的 async `execFile` / `fetchPublic`** 被替换成假实现——**实现网络适配器**与**在测试里连接服务器**是两件事，前者是交付物，后者被禁止。**所有假 transport 必须返回 Promise**；同步 fake 会掩盖"忘了 await"这类生产错误。

---

## 13 步主流程追踪表（**实现与自审共用**）

每一行都必须能在 `runCommit` 里找到对应代码；**任何 helper 只定义未接入主链 = 缺陷**。

| #   | 阶段              | 输入                                                   | 本地/远端动作                                                                                       | await                | 检查退出码               | 审计阶段名              | 失败结果                                           | 锁状态                                                                          |
| --- | ----------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | -------------------- | ------------------------ | ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | `pre-verify`      | 三个本地产物路径、`expectedChannel`、`expectedVersion` | 本地：读三产物、验签、比对 channel/version/URL/hash/size                                            | 是（await verifier） | —                        | `pre-verify`            | `fail`                                             | `not-acquired`                                                                  |
| 2   | `stage`           | `planHash`、staging 路径                               | 远端：`mkdir -p <staging>` → SFTP `reput` 两个 `.part-<runid>` → 远端 `mv -f` 成最终名              | 是                   | **是**（每个写操作都查） | `stage`                 | `fail`                                             | `not-acquired`                                                                  |
| 3   | `remote-verify`   | staging 目录                                           | 远端：`find -printf` + `sha256sum`                                                                  | 是                   | **是**                   | `remote-verify`         | `fail`                                             | `not-acquired`                                                                  |
| 4   | `lock`            | `channel`、`runid`、`planHash`                         | 远端：`mkdir <lock>`，成功后写 `owner.json`                                                         | 是                   | **是**（两条都查）       | `lock`                  | 已存在 ⇒ `blocked`；不确定 ⇒ `incident`            | `not-acquired` / `ownership-unknown`                                            |
| 5   | `re-verify`       | 锁内                                                   | 本地：重读 `owner.json`；远端：读 manifest baseline、重探 staging                                   | 是                   | **是**                   | `re-verify`             | `incident`                                         | `retained-by-this-run`                                                          |
| 6   | `commit-version`  | staging 与最终目录                                     | 远端：`stat -c %d` 比设备号；不存在则**单次目录 `mv`**；存在则整体比对                              | 是                   | **是**                   | `commit-version`        | `fail`                                             | `released`                                                                      |
| 7   | `backup-manifest` | 旧 manifest                                            | 远端：`cp` 到备份路径                                                                               | 是                   | **是**                   | `backup-manifest`       | `incident`                                         | `retained-by-this-run`                                                          |
| 8   | `cas`             | baseline                                               | 远端：重读 manifest SHA                                                                             | 是                   | **是**                   | `cas`                   | 不匹配 ⇒ `incident`                                | `retained-by-this-run`                                                          |
| 9   | `temp-manifest`   | 本地 `manifest.json`                                   | **SFTP 上传**到正式 manifest **同目录**的 `<runid>.tmp`；远端重算 SHA 必须等于本地 `manifestSha256` | 是                   | **是**                   | `temp-manifest`         | `incident`                                         | `retained-by-this-run`                                                          |
| 10  | `flip`            | 临时 manifest                                          | 远端：单次 `mv -f`                                                                                  | 是                   | **是**                   | `flip`                  | `incident`                                         | `retained-by-this-run`                                                          |
| 11  | `public-verify`   | 公网                                                   | 公网：取回 manifest + 两个产物，验签、比 SHA/size/URL；三分                                         | 是                   | **是**                   | `public-verify`         | 新 SHA ⇒ 继续；旧 SHA ⇒ `retry`；其它 ⇒ `incident` | `retained-by-this-run`                                                          |
| 12  | 收口              | —                                                      | 本地：写结果条目 `done` / `retry` / `fail` / `blocked` / `incident`                                 | 否（同步追加）       | —                        | 以结果本身为 `stage` 名 | —                                                  | 该条目里**不含**锁状态；锁状态由紧随其后的 `unlock` 或 `lock-retained` 条目承载 |
| 13  | `unlock`          | `owner.json`                                           | 远端：重读 owner → `rm owner.json` → `rmdir lock`                                                   | 是                   | **是**                   | `unlock`                | 任一失败 ⇒ **不得报告 `released`**                 | `released` / `retained-by-this-run`                                             |

**锁状态取值（四态，取代布尔）：** `not-acquired` / `released` / `retained-by-this-run` / `ownership-unknown`。

- `mkdir` 明确"已存在" ⇒ `not-acquired`，**绝不解锁**。
- 本次持有且正常收尾 ⇒ `released`。
- 本次持有但出事故 ⇒ `retained-by-this-run`。
- 网络/超时/回执不确定 ⇒ `ownership-unknown`。
- owner 的 `runid` / `planHash` 不匹配 ⇒ `ownership-unknown`，**不触碰该锁**并记 `incident`。

---

## 依赖与执行顺序

1. Task 1（输入与本地预验证）→ 其余全部依赖它。
2. Task 2（dry-run / preflight）→ Task 4 之前。
3. Task 3（锁生命周期）→ Task 4 之前。
4. Task 4（主流程）→ 依赖 Task 1–3。
5. Task 5（`internal → stable` 重签）与 Task 4 无强依赖。
6. Task 6（真实 transport）→ **Task 7 依赖它**。
7. Task 7（CLI，四种模式全接）→ Task 8 之前。
8. Task 8（手册 + 检查单）最后。

**每刀的通用纪律：** 命名 RED → 按测试名失败 → 最小 GREEN → 行为级变异验证（删关键护栏 ⇒ 指定测试按名变红 ⇒ 逐字节恢复，`git diff` 为空）→ 判据含 `passed > 0` 与 `fail 0` → “跳过”记“未验证” → 完整门禁 `pnpm check` → 显式 pathspec 独立提交，禁止 `git add -A`。

**测试运行方式：**

```bash
node --test scripts/lib/feed-publish.test.mjs
node --test scripts/lib/feed-publish-transport.test.mjs
node --test scripts/lib/feed-publish-cli.test.mjs
```

---

### Task 1: 输入纪律与本地预验证

**Files:**

- Create: `scripts/lib/feed-publish.mjs`
- Test: `scripts/lib/feed-publish.test.mjs`
- Modify: `package.json`

固定常量（规格 §6.2）：发布根 `/opt/rongying/updates`、状态根 `/opt/rongying/updates-state`、频道白名单 `internal` / `stable`、公网基址 `https://api.rongyinghudong.com/updates`。两个根是常量；主机与 known_hosts 由命令行传入（仓库**不得**内置服务器地址）。**`--host` / `--known-hosts` 只在需要联网的模式下必填**——`--dry-run` 完全离线，因此不要求它们。

- [ ] **Step 1: 写失败的测试**

创建 `scripts/lib/feed-publish.test.mjs`：

```js
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import {
  CHANNELS,
  FeedPublishError,
  PUBLIC_BASE_URL,
  STATE_ROOT,
  UPDATE_ROOT,
  assertKnownHostsPath,
  parsePublishInput,
  verifyLocalArtifacts,
} from './feed-publish.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'mofang-feed-'));
  roots.push(root);
  return root;
}

const keyPair = generateKeyPairSync('ed25519');
const PUBLIC_KEY_BASE64 = keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

const PACKAGE_BYTES = Buffer.from('portable-zip-bytes', 'utf8');
const PACKAGE_SHA256 = createHash('sha256').update(PACKAGE_BYTES).digest('hex');

const FILE_MANIFEST = {
  schemaVersion: 1,
  version: '1.2.3',
  files: [{ path: 'a.txt', size: 1, sha256: 'a'.repeat(64) }],
};
const FILE_MANIFEST_BYTES = Buffer.from(JSON.stringify(FILE_MANIFEST), 'utf8');
const FILE_MANIFEST_SHA256 = createHash('sha256').update(FILE_MANIFEST_BYTES).digest('hex');

function signedManifest(overrides = {}) {
  const payload = {
    schemaVersion: 1,
    channel: 'internal',
    version: '1.2.3',
    minLauncherVersion: '1.0.0',
    packageUrl: `${PUBLIC_BASE_URL}/internal/1.2.3/portable.zip`,
    packageSize: PACKAGE_BYTES.length,
    packageSha256: PACKAGE_SHA256,
    fileManifestSha256: FILE_MANIFEST_SHA256,
    publishedAt: '2026-09-22T00:00:00.000Z',
    mandatory: false,
    ...overrides,
  };
  const canonical = JSON.stringify(payload);
  const signature = sign(null, Buffer.from(canonical, 'utf8'), keyPair.privateKey).toString('base64');
  return Buffer.from(JSON.stringify({ ...payload, signature }), 'utf8');
}

function writeArtifacts(overrides = {}) {
  const root = makeRoot();
  const paths = {
    packagePath: join(root, 'portable.zip'),
    fileManifestPath: join(root, 'portable-files.json'),
    manifestPath: join(root, 'manifest.json'),
  };
  writeFileSync(paths.packagePath, overrides.packageBytes ?? PACKAGE_BYTES);
  writeFileSync(paths.fileManifestPath, overrides.fileManifestBytes ?? FILE_MANIFEST_BYTES);
  writeFileSync(paths.manifestPath, overrides.manifestBytes ?? signedManifest(overrides.manifestOverrides));
  return paths;
}

test('the roots and the channel whitelist are fixed constants', () => {
  assert.equal(UPDATE_ROOT, '/opt/rongying/updates');
  assert.equal(STATE_ROOT, '/opt/rongying/updates-state');
  assert.deepEqual([...CHANNELS], ['internal', 'stable']);
  assert.equal(PUBLIC_BASE_URL, 'https://api.rongyinghudong.com/updates');
});

test('the input rejects any channel outside the whitelist', () => {
  assert.throws(
    () => parsePublishInput({ channel: 'beta', version: '1.2.3', host: 'h', knownHostsPath: 'k' }),
    FeedPublishError,
  );
});

test('the input rejects an unstrict version', () => {
  for (const version of ['1.2', 'v1.2.3', '01.2.3', 'dev']) {
    assert.throws(
      () => parsePublishInput({ channel: 'internal', version, host: 'h', knownHostsPath: 'k' }),
      FeedPublishError,
    );
  }
});

test('the input rejects a missing host or known hosts path when the mode needs the network', () => {
  assert.throws(
    () =>
      parsePublishInput({ channel: 'internal', version: '1.2.3', host: '', knownHostsPath: 'k', needsNetwork: true }),
    FeedPublishError,
  );
  assert.throws(
    () =>
      parsePublishInput({ channel: 'internal', version: '1.2.3', host: 'h', knownHostsPath: '', needsNetwork: true }),
    FeedPublishError,
  );
});

test('the offline input does not require a host or known hosts path', () => {
  const input = parsePublishInput({
    channel: 'internal',
    version: '1.2.3',
    host: '',
    knownHostsPath: '',
    needsNetwork: false,
  });
  assert.equal(input.channel, 'internal');
  assert.equal(input.host, null);
  assert.equal(input.knownHostsPath, null);
});

test('the known hosts file must live outside the repository', () => {
  assert.throws(() => assertKnownHostsPath(join(process.cwd(), 'known_hosts'), process.cwd()), FeedPublishError);
  assert.equal(assertKnownHostsPath(join(tmpdir(), 'known_hosts'), process.cwd()), join(tmpdir(), 'known_hosts'));
});

test('the local verification returns every digest and size the flow needs', async () => {
  const paths = writeArtifacts();
  const result = await verifyLocalArtifacts({
    ...paths,
    expectedChannel: 'internal',
    expectedVersion: '1.2.3',
    publicKeyBase64: PUBLIC_KEY_BASE64,
  });
  assert.equal(result.packageSha256, PACKAGE_SHA256);
  assert.equal(result.packageSize, PACKAGE_BYTES.length);
  assert.equal(result.fileManifestSha256, FILE_MANIFEST_SHA256);
  assert.equal(result.fileManifestSize, FILE_MANIFEST_BYTES.length);
  assert.equal(result.manifestSha256, createHash('sha256').update(result.manifestBytes).digest('hex'));
  assert.equal(result.packageUrl, `${PUBLIC_BASE_URL}/internal/1.2.3/portable.zip`);
});

test('the local verification requires the channel and the version explicitly', async () => {
  const withoutChannel = writeArtifacts();
  await assert.rejects(
    verifyLocalArtifacts({ ...withoutChannel, expectedVersion: '1.2.3', publicKeyBase64: PUBLIC_KEY_BASE64 }),
    /expectedChannel/u,
  );
  const withoutVersion = writeArtifacts();
  await assert.rejects(
    verifyLocalArtifacts({ ...withoutVersion, expectedChannel: 'internal', publicKeyBase64: PUBLIC_KEY_BASE64 }),
    /expectedVersion/u,
  );
});

test('the local verification rejects a package whose bytes do not match the manifest', async () => {
  const paths = writeArtifacts({ packageBytes: Buffer.from('tampered', 'utf8') });
  await assert.rejects(
    verifyLocalArtifacts({
      ...paths,
      expectedChannel: 'internal',
      expectedVersion: '1.2.3',
      publicKeyBase64: PUBLIC_KEY_BASE64,
    }),
    /package integrity/u,
  );
});

test('the local verification rejects a file manifest whose bytes do not match the manifest', async () => {
  const paths = writeArtifacts({ fileManifestBytes: Buffer.from('[]', 'utf8') });
  await assert.rejects(
    verifyLocalArtifacts({
      ...paths,
      expectedChannel: 'internal',
      expectedVersion: '1.2.3',
      publicKeyBase64: PUBLIC_KEY_BASE64,
    }),
    /file manifest/u,
  );
});

test('the local verification rejects a manifest for another channel or version', async () => {
  const otherChannel = writeArtifacts({
    manifestOverrides: {
      channel: 'stable',
      packageUrl: `${PUBLIC_BASE_URL}/stable/1.2.3/portable.zip`,
    },
  });
  await assert.rejects(
    verifyLocalArtifacts({
      ...otherChannel,
      expectedChannel: 'internal',
      expectedVersion: '1.2.3',
      publicKeyBase64: PUBLIC_KEY_BASE64,
    }),
    /channel/u,
  );
  const otherVersion = writeArtifacts({
    manifestOverrides: {
      version: '1.2.4',
      packageUrl: `${PUBLIC_BASE_URL}/internal/1.2.4/portable.zip`,
    },
  });
  await assert.rejects(
    verifyLocalArtifacts({
      ...otherVersion,
      expectedChannel: 'internal',
      expectedVersion: '1.2.3',
      publicKeyBase64: PUBLIC_KEY_BASE64,
    }),
    /version/u,
  );
});

test('the local verification rejects a package url that leaves the fixed public origin', async () => {
  for (const url of [
    'https://evil.example.invalid/updates/internal/1.2.3/portable.zip',
    'https://user:pass@api.rongyinghudong.com/updates/internal/1.2.3/portable.zip',
    'https://api.rongyinghudong.com/updates/internal/1.2.3/portable.zip?x=1',
    'https://api.rongyinghudong.com/updates/internal/1.2.3/portable.zip#frag',
    'http://api.rongyinghudong.com/updates/internal/1.2.3/portable.zip',
  ]) {
    const paths = writeArtifacts({ manifestOverrides: { packageUrl: url } });
    await assert.rejects(
      verifyLocalArtifacts({
        ...paths,
        expectedChannel: 'internal',
        expectedVersion: '1.2.3',
        publicKeyBase64: PUBLIC_KEY_BASE64,
      }),
      /package url/u,
      `expected ${url} to be rejected`,
    );
  }
});

test('a throwing signature verifier fails the local verification instead of returning', async () => {
  const paths = writeArtifacts();
  await assert.rejects(
    verifyLocalArtifacts({
      ...paths,
      expectedChannel: 'internal',
      expectedVersion: '1.2.3',
      publicKeyBase64: PUBLIC_KEY_BASE64,
      verifySignature: () => {
        throw new Error('release manifest signature is invalid');
      },
    }),
    /signature is invalid/u,
  );
});

test('a missing public key is a hard failure rather than a skipped signature check', async () => {
  const paths = writeArtifacts();
  await assert.rejects(
    verifyLocalArtifacts({ ...paths, expectedChannel: 'internal', expectedVersion: '1.2.3', publicKeyBase64: '' }),
    /public key/u,
  );
});

test('the local verification propagates an async verifier rejection', async () => {
  const paths = writeArtifacts();
  await assert.rejects(
    verifyLocalArtifacts({
      ...paths,
      expectedChannel: 'internal',
      expectedVersion: '1.2.3',
      publicKeyBase64: PUBLIC_KEY_BASE64,
      verifySignature: async () => {
        throw new Error('signature rejected by the async verifier');
      },
    }),
    /signature rejected by the async verifier/u,
  );
});
```

`a throwing signature verifier fails the local verification instead of returning` 与 `a missing public key is a hard failure rather than a skipped signature check` 这两条是刻意的：前者要求**签名校验器抛错必须往外抛**（不能"抛了还期待函数返回"），后者要求**缺公钥必须硬失败**（不能跳过验签）。

- [ ] **Step 2: 运行测试并确认按测试名失败**

```bash
node --test scripts/lib/feed-publish.test.mjs
```

预期：无法解析 `./feed-publish.mjs`。

- [ ] **Step 3: 写最小实现**

创建 `scripts/lib/feed-publish.mjs`：

```js
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export const UPDATE_ROOT = '/opt/rongying/updates';
export const STATE_ROOT = '/opt/rongying/updates-state';
export const CHANNELS = Object.freeze(['internal', 'stable']);
export const PUBLIC_BASE_URL = 'https://api.rongyinghudong.com/updates';

export const PORTABLE_PACKAGE_NAME = 'portable.zip';
export const PORTABLE_FILE_MANIFEST_NAME = 'portable-files.json';
export const PORTABLE_MANIFEST_NAME = 'manifest.json';

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export class FeedPublishError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FeedPublishError';
  }
}

export function parsePublishInput(raw) {
  if (!CHANNELS.includes(raw.channel)) {
    throw new FeedPublishError(`channel must be one of ${CHANNELS.join(', ')}`);
  }
  if (typeof raw.version !== 'string' || !SEMVER_PATTERN.test(raw.version)) {
    throw new FeedPublishError(`version must be a strict semantic version, received ${raw.version}`);
  }
  const needsNetwork = raw.needsNetwork === true;
  if (needsNetwork) {
    if (typeof raw.host !== 'string' || raw.host.length === 0) {
      throw new FeedPublishError('the ssh host is required');
    }
    if (raw.host.startsWith('-') || /\s/u.test(raw.host)) {
      throw new FeedPublishError('the ssh host must not start with a dash or contain whitespace');
    }
    if (typeof raw.knownHostsPath !== 'string' || raw.knownHostsPath.length === 0) {
      throw new FeedPublishError('the pinned known hosts file is required');
    }
  }
  return {
    channel: raw.channel,
    version: raw.version,
    host: needsNetwork ? raw.host : null,
    knownHostsPath: needsNetwork ? resolve(raw.knownHostsPath) : null,
  };
}

export function assertKnownHostsPath(target, repositoryRoot) {
  const resolved = resolve(target);
  const root = resolve(repositoryRoot);
  const rel = relative(root, resolved);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new FeedPublishError('the pinned known hosts file must live outside the repository');
  }
  return resolved;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function verifyLocalArtifacts(input) {
  if (typeof input.expectedChannel !== 'string' || input.expectedChannel.length === 0) {
    throw new FeedPublishError('an explicit expectedChannel is required');
  }
  if (typeof input.expectedVersion !== 'string' || input.expectedVersion.length === 0) {
    throw new FeedPublishError('an explicit expectedVersion is required');
  }
  if (typeof input.publicKeyBase64 !== 'string' || input.publicKeyBase64.length === 0) {
    throw new FeedPublishError('the update public key is required to verify the release manifest');
  }

  const packageBytes = readFileSync(input.packagePath);
  const fileManifestBytes = readFileSync(input.fileManifestPath);
  const manifestBytes = readFileSync(input.manifestPath);

  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new FeedPublishError('the release manifest is not valid JSON');
  }

  if (manifest.channel !== input.expectedChannel) {
    throw new FeedPublishError(`the manifest channel ${manifest.channel} does not match the requested channel`);
  }
  if (manifest.version !== input.expectedVersion) {
    throw new FeedPublishError(`the manifest version ${manifest.version} does not match the requested version`);
  }

  const packageSha256 = sha256(packageBytes);
  if (packageSha256 !== manifest.packageSha256 || packageBytes.length !== manifest.packageSize) {
    throw new FeedPublishError('the package integrity check failed');
  }
  const fileManifestSha256 = sha256(fileManifestBytes);
  if (fileManifestSha256 !== manifest.fileManifestSha256) {
    throw new FeedPublishError('the file manifest integrity check failed');
  }

  let packageUrl;
  let expectedUrl;
  try {
    packageUrl = new URL(manifest.packageUrl);
    expectedUrl = new URL(`${PUBLIC_BASE_URL}/${manifest.channel}/${manifest.version}/${PORTABLE_PACKAGE_NAME}`);
  } catch {
    throw new FeedPublishError('the package url is not a valid url');
  }
  if (
    packageUrl.protocol !== 'https:' ||
    packageUrl.origin !== expectedUrl.origin ||
    packageUrl.pathname !== expectedUrl.pathname ||
    packageUrl.search !== '' ||
    packageUrl.hash !== '' ||
    packageUrl.username !== '' ||
    packageUrl.password !== ''
  ) {
    throw new FeedPublishError('the package url does not point at this channel and version on the fixed public origin');
  }

  const verifier = input.verifySignature ?? (() => {});
  await verifier({
    manifestBytes,
    fileManifestBytes,
    packagePath: input.packagePath,
    publicKeyBase64: input.publicKeyBase64,
  });

  return {
    manifest,
    manifestBytes,
    manifestSha256: sha256(manifestBytes),
    packageSha256,
    packageSize: packageBytes.length,
    fileManifestSha256,
    fileManifestSize: fileManifestBytes.length,
    packageUrl: manifest.packageUrl,
  };
}
```

**URL 检查是 origin 级**：`protocol` + `origin` + `pathname` + 无 query / fragment / userinfo。只比 `pathname` 会放过别的域名与 `user:pass@`。**验签是 async 的**：`verifyLocalArtifacts` 因此是 `async`，调用方必须 `await`；漏掉 `await` 会让拒绝变成未处理的 Promise 拒绝，而函数照常返回成功 —— 那等于这道闸门不存在。

- [ ] **Step 4: 运行测试并确认通过**

```bash
node --test scripts/lib/feed-publish.test.mjs
```

预期：`fail 0`、`pass` 计数 > 0。

- [ ] **Step 5: 行为级变异验证**

1. 把 `packageUrl.origin !== expectedUrl.origin` 判断删掉（只留 pathname） ⇒ 预期 `the local verification rejects a package url that leaves the fixed public origin` **按测试名变红**。
2. 把 `expectedChannel` 的必填检查删掉 ⇒ 预期 `the local verification requires the channel and the version explicitly` **按测试名变红**。
3. 把 `expectedVersion` 的必填检查删掉 ⇒ 预期同一条 **按测试名变红**。
   （2 与 3 必须**分别**做，一次只删一个守卫：该测试的两个用例各自钉住一个守卫 ⇒ 单独删任一个都必须红。一次删两个虽然也会红，但**证明不了任何一个守卫是必要的** —— 那正是这轮复核抓到的假绿形状。每条删完都要逐字节恢复。）
4. 把 `publicKeyBase64` 的必填检查删掉 ⇒ 预期 `a missing public key is a hard failure rather than a skipped signature check` **按测试名变红**。
5. 把 `verifier(...)` 调用包进 `try { } catch { }` ⇒ 预期 `a throwing signature verifier fails the local verification instead of returning` **按测试名变红**。
6. 把 `needsNetwork` 判断删掉、无条件要求 host ⇒ 预期 `the offline input does not require a host or known hosts path` **按测试名变红**。
7. 把 `await verifier(...)` 的 `await` 删掉 ⇒ 预期 `the local verification propagates an async verifier rejection` **按测试名变红**。

恢复后 `git diff` 为空且全绿。

- [ ] **Step 6: 提交**

```bash
git add scripts/lib/feed-publish.mjs scripts/lib/feed-publish.test.mjs
git commit -m "feat(feed): verify the release triple before any network write"
```

- [ ] **Step 7: 把这条测试接进 `pnpm check`**

在根 `package.json` 的 `scripts` 里新增一条，并把它插入 `check` 链（放在 `check:portable-update-release` 之后）：

```json
"check:portable-feed-publish": "node --test scripts/lib/feed-publish.test.mjs"
```

此时**只有这一个测试文件存在**，所以命令只列这一个。Task 7 Step 6 会**改写这个键的值**（追加另外两个测试文件），**不会**再新增同名的键、也**不会**改动这里的插入位置。

理由：不接线的话，从 Task 1 到 Task 8 之间**没有任何门禁执行这个测试文件**，“`pnpm check` 绿”对这个模块说明不了任何事。

```bash
git add package.json scripts/lib/feed-publish.mjs scripts/lib/feed-publish.test.mjs
git commit -m "feat(feed): verify the release triple before any network write"
```

---

### Task 2: `--dry-run`（离线）与 `--preflight`（只读）

**Files:**

- Modify: `scripts/lib/feed-publish.mjs`
- Modify: `scripts/lib/feed-publish.test.mjs`

- [ ] **Step 1: 写失败的测试**

追加到 `scripts/lib/feed-publish.test.mjs`（**假 transport 一律 async**）：

```js
import { PUBLISH_STAGES, planCommit, runPreflight } from './feed-publish.mjs';

function fakeReadOnlyTransport(overrides = {}) {
  const calls = [];
  return {
    calls,
    readOnly: {
      sshRun: async (request) => {
        calls.push(['sshRun', request.script]);
        return overrides.sshRun ? overrides.sshRun(request) : { status: 0, stdout: '', stderr: '' };
      },
    },
    write: {
      sshRun: async () => ({ status: 0, stdout: '', stderr: '' }),
      sftpUpload: async () => ({ status: 0, bytesSent: 1 }),
    },
    fetchPublic: async (url) => {
      calls.push(['fetchPublic', url]);
      return { status: 200, bodyBytes: new Uint8Array() };
    },
  };
}

test('the commit plan lists the thirteen stages in the fixed order', () => {
  assert.deepEqual(PUBLISH_STAGES, [
    'pre-verify',
    'stage',
    'remote-verify',
    'lock',
    're-verify',
    'commit-version',
    'backup-manifest',
    'cas',
    'temp-manifest',
    'flip',
    'public-verify',
    'reveal',
    'unlock',
  ]);
});

test('the dry run validates the triple and prints the plan without any transport', async () => {
  const paths = writeArtifacts();
  const plan = await planCommit({
    channel: 'internal',
    version: '1.2.3',
    ...paths,
    publicKeyBase64: PUBLIC_KEY_BASE64,
  });
  assert.deepEqual(
    plan.map((entry) => entry.stage),
    [...PUBLISH_STAGES],
  );
  assert.equal(plan[0].status, 'pending');
});

test('the dry run propagates a local verification failure instead of printing a plan', async () => {
  const paths = writeArtifacts({ packageBytes: Buffer.from('tampered', 'utf8') });
  await assert.rejects(
    planCommit({ channel: 'internal', version: '1.2.3', ...paths, publicKeyBase64: PUBLIC_KEY_BASE64 }),
    /package integrity/u,
  );
});

test('the preflight only performs read only actions and never claims writability', async () => {
  const transport = fakeReadOnlyTransport({
    sshRun: (request) =>
      request.script.includes('stat -c')
        ? { status: 0, stdout: '100\n100\n', stderr: '' }
        : { status: 0, stdout: '', stderr: '' },
  });
  const result = await runPreflight({
    channel: 'internal',
    version: '1.2.3',
    transport,
    host: 'h',
    knownHostsPath: 'k',
  });
  const names = transport.calls.map((call) => call[0]);
  assert.deepEqual([...new Set(names)], ['sshRun']);
  assert.equal(result.writabilityIndicators.verifiedWrite, false);
  assert.match(result.writabilityIndicators.note, /indicator/u);
});

test('the preflight reports different file systems instead of assuming one', async () => {
  const transport = fakeReadOnlyTransport({ sshRun: () => ({ status: 0, stdout: '100\n200\n', stderr: '' }) });
  const result = await runPreflight({
    channel: 'internal',
    version: '1.2.3',
    transport,
    host: 'h',
    knownHostsPath: 'k',
  });
  assert.equal(result.sameFileSystem, false);
  assert.match(result.notes.join(' '), /file system/u);
});
```

- [ ] **Step 2: 运行测试并确认按测试名失败**

```bash
node --test scripts/lib/feed-publish.test.mjs
```

预期：`PUBLISH_STAGES` / `planCommit` / `runPreflight` 未定义。

- [ ] **Step 3: 写最小实现**

追加到 `scripts/lib/feed-publish.mjs`：

```js
export const PUBLISH_STAGES = Object.freeze([
  'pre-verify',
  'stage',
  'remote-verify',
  'lock',
  're-verify',
  'commit-version',
  'backup-manifest',
  'cas',
  'temp-manifest',
  'flip',
  'public-verify',
  'reveal',
  'unlock',
]);

export async function planCommit(input) {
  await verifyLocalArtifacts({
    packagePath: input.packagePath,
    fileManifestPath: input.fileManifestPath,
    manifestPath: input.manifestPath,
    expectedChannel: input.channel,
    expectedVersion: input.version,
    publicKeyBase64: input.publicKeyBase64,
    verifySignature: input.verifySignature,
  });
  return PUBLISH_STAGES.map((stage) => ({ stage, status: 'pending' }));
}

export async function runPreflight(input) {
  const notes = [];
  const probe = await input.transport.readOnly.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `stat -c '%d' ${STATE_ROOT} ${UPDATE_ROOT}`,
  });
  const devices = String(probe.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const sameFileSystem = devices.length === 2 && devices[0] === devices[1];
  if (!sameFileSystem) notes.push('the state root and the update root do not report the same file system');
  if (probe.status !== 0) notes.push('the read only probe did not succeed');

  return {
    sameFileSystem,
    notes,
    writabilityIndicators: {
      verifiedWrite: false,
      note: 'writability is an indicator read from remote metadata, not verified: nothing was written yet',
    },
  };
}
```

- [ ] **Step 4: 运行测试并确认通过**

```bash
node --test scripts/lib/feed-publish.test.mjs
```

预期：`fail 0`。

- [ ] **Step 5: 行为级变异验证**

1. 把 `PUBLISH_STAGES` 里 `'lock'` 与 `'stage'` 互换 ⇒ 预期 `the commit plan lists the thirteen stages in the fixed order` **按测试名变红**。
2. 把 `planCommit` 里的 `verifyLocalArtifacts` 调用删掉 ⇒ 预期 `the dry run propagates a local verification failure instead of printing a plan` **按测试名变红**。
3. 把 `runPreflight` 的只读探测改成 `await input.transport.write.sftpUpload(...)` ⇒ 预期 `the preflight only performs read only actions and never claims writability` **按测试名变红**。
4. 把 `writabilityIndicators.verifiedWrite` 改成 `true` ⇒ 预期同一条 **按测试名变红**。
5. 把 `sameFileSystem` 改成恒 `true` ⇒ 预期 `the preflight reports different file systems instead of assuming one` **按测试名变红**。
6. 把 `runPreflight` 的 `await` 删掉（拿 Promise 当结果比较） ⇒ 预期同一条 **按测试名变红**——这是"漏 await"的正面检查。

恢复后全绿且 `git diff` 为空。

- [ ] **Step 6: 提交**

```bash
git add scripts/lib/feed-publish.mjs scripts/lib/feed-publish.test.mjs
git commit -m "feat(feed): separate an offline dry run from a read only preflight"
```

---

### Task 3: 锁生命周期（获取三态、owner 写入检查、释放两步检查）

**Files:**

- Modify: `scripts/lib/feed-publish.mjs`
- Modify: `scripts/lib/feed-publish.test.mjs`

- [ ] **Step 1: 写失败的测试**

追加到 `scripts/lib/feed-publish.test.mjs`：

```js
import {
  LOCK_STATES,
  acquireChannelLock,
  breakChannelLock,
  planHashOf,
  releaseChannelLock,
  resolveLockDisposition,
} from './feed-publish.mjs';

const PLAN_INPUT = {
  channel: 'internal',
  version: '1.2.3',
  packageSha256: 'a'.repeat(64),
  fileManifestSha256: 'b'.repeat(64),
  manifestSha256: 'c'.repeat(64),
};

function fakeWriteTransport(handlers = {}) {
  const calls = [];
  return {
    calls,
    readOnly: {
      sshRun: async (request) => {
        calls.push(['readSsh', request.script]);
        return handlers.readSsh ? handlers.readSsh(request) : { status: 0, stdout: '', stderr: '' };
      },
    },
    write: {
      sshRun: async (request) => {
        calls.push(['writeSsh', request.script]);
        return handlers.writeSsh ? handlers.writeSsh(request) : { status: 0, stdout: '', stderr: '' };
      },
      sftpUpload: async () => ({ status: 0, bytesSent: 1 }),
    },
    fetchPublic: async () => ({ status: 200, bodyBytes: new Uint8Array() }),
  };
}

test('the lock states are exactly the four documented ones', () => {
  assert.deepEqual([...LOCK_STATES], ['not-acquired', 'released', 'retained-by-this-run', 'ownership-unknown']);
});

test('the plan hash binds channel, version and all three artifact digests', () => {
  const base = planHashOf(PLAN_INPUT);
  assert.equal(base, planHashOf({ ...PLAN_INPUT }));
  for (const key of ['version', 'channel', 'packageSha256', 'fileManifestSha256', 'manifestSha256']) {
    assert.notEqual(base, planHashOf({ ...PLAN_INPUT, [key]: 'changed' }), `planHash ignored ${key}`);
  }
});

test('an existing lock is a determinate not-acquired and never stolen', async () => {
  const transport = fakeWriteTransport({
    writeSsh: (request) =>
      request.script.startsWith('mkdir ')
        ? { status: 1, stdout: '', stderr: "mkdir: cannot create directory '/x': File exists" }
        : { status: 0, stdout: '', stderr: '' },
  });
  const result = await acquireChannelLock({
    channel: 'internal',
    transport,
    owner: { runid: 'r1', planHash: 'p1' },
    host: 'h',
    knownHostsPath: 'k',
  });
  assert.equal(result.state, 'not-acquired');
  assert.equal(result.requiresExplicitRecovery, true);
  assert.equal(transport.calls.filter((call) => /rm |rmdir/u.test(String(call[1] ?? ''))).length, 0);
});

test('an ssh failure while taking the lock is ownership unknown, not not-acquired', async () => {
  const transport = fakeWriteTransport({
    writeSsh: (request) =>
      request.script.startsWith('mkdir ')
        ? { status: -1, stdout: '', stderr: 'connection timed out' }
        : { status: 0, stdout: '', stderr: '' },
  });
  const result = await acquireChannelLock({
    channel: 'internal',
    transport,
    owner: { runid: 'r1', planHash: 'p1' },
    host: 'h',
    knownHostsPath: 'k',
  });
  assert.equal(result.state, 'ownership-unknown');
  assert.match(result.reason, /cannot confirm/u);
});

test('a failed owner write is an incident that keeps the lock', async () => {
  const transport = fakeWriteTransport({
    writeSsh: (request) =>
      request.script.includes('owner.json')
        ? { status: 1, stdout: '', stderr: 'read only file system' }
        : { status: 0, stdout: '', stderr: '' },
  });
  const result = await acquireChannelLock({
    channel: 'internal',
    transport,
    owner: { runid: 'r1', planHash: 'p1' },
    host: 'h',
    knownHostsPath: 'k',
  });
  assert.equal(result.state, 'retained-by-this-run');
  assert.equal(result.incident, true);
});

test('release verifies the owner, then removes the owner file, then the lock directory', async () => {
  const owner = { runid: 'r1', planHash: 'p1' };
  const order = [];
  const transport = fakeWriteTransport({
    readSsh: () => ({ status: 0, stdout: JSON.stringify(owner), stderr: '' }),
    writeSsh: (request) => {
      if (request.script.startsWith('rm ')) order.push('rm-owner');
      if (request.script.startsWith('rmdir ')) order.push('rmdir-lock');
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  const verdict = await releaseChannelLock({
    channel: 'internal',
    transport,
    owner,
    runid: 'r1',
    planHash: 'p1',
    host: 'h',
    knownHostsPath: 'k',
  });
  assert.equal(verdict.state, 'released');
  assert.deepEqual(order, ['rm-owner', 'rmdir-lock']);
});

test('a failed owner removal is never reported as released', async () => {
  const owner = { runid: 'r1', planHash: 'p1' };
  const transport = fakeWriteTransport({
    readSsh: () => ({ status: 0, stdout: JSON.stringify(owner), stderr: '' }),
    writeSsh: (request) =>
      request.script.startsWith('rm ')
        ? { status: 1, stdout: '', stderr: 'permission denied' }
        : { status: 0, stdout: '', stderr: '' },
  });
  const verdict = await releaseChannelLock({
    channel: 'internal',
    transport,
    owner,
    runid: 'r1',
    planHash: 'p1',
    host: 'h',
    knownHostsPath: 'k',
  });
  assert.equal(verdict.state, 'retained-by-this-run');
  assert.equal(verdict.incident, true);
});

test('release re-reads the owner and refuses when it belongs to another run', async () => {
  const transport = fakeWriteTransport({
    readSsh: () => ({ status: 0, stdout: JSON.stringify({ runid: 'other', planHash: 'p1' }), stderr: '' }),
  });
  const verdict = await releaseChannelLock({
    channel: 'internal',
    transport,
    owner: null,
    runid: 'r1',
    planHash: 'p1',
    host: 'h',
    knownHostsPath: 'k',
  });
  assert.equal(verdict.state, 'ownership-unknown');
  assert.equal(transport.calls.filter((call) => /rm |rmdir/u.test(String(call[1] ?? ''))).length, 0);
});

test('a run that holds the lock but cannot close safely keeps it', () => {
  const owner = { runid: 'r1', planHash: 'p1' };
  const verdict = resolveLockDisposition({
    acquisitionConfirmed: true,
    owner,
    runid: 'r1',
    planHash: 'p1',
    safeToExit: false,
  });
  assert.equal(verdict.state, 'retained-by-this-run');
  assert.equal(verdict.release, false);
});

test('an unconfirmed acquisition is ownership unknown and never touches the lock', () => {
  const verdict = resolveLockDisposition({
    acquisitionConfirmed: false,
    owner: null,
    runid: 'r1',
    planHash: 'p1',
    safeToExit: true,
  });
  assert.equal(verdict.state, 'ownership-unknown');
  assert.equal(verdict.release, false);
});

test('breaking a lock needs a reason, an audit log and a matching runid', async () => {
  const owner = { runid: 'r0', planHash: 'p0' };
  const transport = fakeWriteTransport({ readSsh: () => ({ status: 0, stdout: JSON.stringify(owner), stderr: '' }) });
  const base = {
    channel: 'internal',
    transport,
    host: 'h',
    knownHostsPath: 'k',
    confirmRunid: 'r0',
    auditOut: '/outside/audit.jsonl',
    operator: 'ops',
  };
  await assert.rejects(breakChannelLock({ ...base, reason: '' }), FeedPublishError);
  await assert.rejects(breakChannelLock({ ...base, reason: 'stopped', auditOut: null }), FeedPublishError);
  await assert.rejects(
    breakChannelLock({ ...base, reason: 'stopped', confirmRunid: 'wrong' }),
    /does not match the owner/u,
  );
});

test('breaking a lock records the real previous owner and the operator', async () => {
  const owner = { runid: 'r0', planHash: 'p0' };
  const transport = fakeWriteTransport({ readSsh: () => ({ status: 0, stdout: JSON.stringify(owner), stderr: '' }) });
  const record = await breakChannelLock({
    channel: 'internal',
    transport,
    host: 'h',
    knownHostsPath: 'k',
    reason: 'operator confirmed the previous run stopped',
    confirmRunid: 'r0',
    auditOut: '/outside/audit.jsonl',
    operator: 'ops',
  });
  assert.equal(record.outcome, 'lock-broken');
  assert.deepEqual(record.previousOwner, owner);
  assert.equal(record.operator, 'ops');
});

test('a failed remote deletion is not recorded as lock-broken', async () => {
  const owner = { runid: 'r0', planHash: 'p0' };
  const transport = fakeWriteTransport({
    readSsh: () => ({ status: 0, stdout: JSON.stringify(owner), stderr: '' }),
    writeSsh: (request) =>
      request.script.startsWith('rm ')
        ? { status: 1, stdout: '', stderr: 'permission denied' }
        : { status: 0, stdout: '', stderr: '' },
  });
  await assert.rejects(
    breakChannelLock({
      channel: 'internal',
      transport,
      host: 'h',
      knownHostsPath: 'k',
      reason: 'stopped',
      confirmRunid: 'r0',
      auditOut: '/outside/audit.jsonl',
      operator: 'ops',
    }),
    /could not be removed/u,
  );
});
```

- [ ] **Step 2: 运行测试并确认按测试名失败**

```bash
node --test scripts/lib/feed-publish.test.mjs
```

预期：新符号未定义。

- [ ] **Step 3: 写最小实现**

追加到 `scripts/lib/feed-publish.mjs`：

```js
export const LOCK_STATES = Object.freeze(['not-acquired', 'released', 'retained-by-this-run', 'ownership-unknown']);

function lockPath(channel) {
  return `${STATE_ROOT}/lock/${channel}`;
}

function ownerPath(channel) {
  return `${lockPath(channel)}/owner.json`;
}

export function planHashOf(input) {
  return createHash('sha256')
    .update(
      [input.channel, input.version, input.packageSha256, input.fileManifestSha256, input.manifestSha256].join('\n'),
      'utf8',
    )
    .digest('hex');
}

function isFileExistsFailure(result) {
  return /File exists|cannot create directory/iu.test(`${result.stderr ?? ''} ${result.stdout ?? ''}`);
}

export async function readOwnerRecord(input) {
  const read = await input.transport.readOnly.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `cat ${ownerPath(input.channel)}`,
  });
  if (read.status !== 0) return null;
  try {
    return JSON.parse(String(read.stdout ?? '').trim());
  } catch {
    return null;
  }
}

export async function acquireChannelLock(input) {
  const created = await input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `mkdir ${lockPath(input.channel)}`,
  });

  if (created.status !== 0) {
    if (created.status === -1 || !isFileExistsFailure(created)) {
      return {
        state: 'ownership-unknown',
        acquired: false,
        incident: true,
        requiresExplicitRecovery: true,
        reason: 'this run cannot confirm whether it holds the lock',
        owner: null,
      };
    }
    const owner = await readOwnerRecord(input);
    return {
      state: 'not-acquired',
      acquired: false,
      incident: false,
      requiresExplicitRecovery: true,
      reason: 'the channel is already locked',
      owner,
    };
  }

  const written = await input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `printf '%s' '${JSON.stringify(input.owner)}' > ${ownerPath(input.channel)}`,
  });
  if (written.status !== 0) {
    return {
      state: 'retained-by-this-run',
      acquired: true,
      incident: true,
      requiresExplicitRecovery: true,
      reason: 'the lock was created but its owner record could not be written',
      owner: null,
    };
  }
  return {
    state: 'retained-by-this-run',
    acquired: true,
    incident: false,
    requiresExplicitRecovery: false,
    reason: 'this run holds the lock',
    owner: input.owner,
  };
}

export function resolveLockDisposition(input) {
  if (input.acquisitionConfirmed !== true) {
    return {
      release: false,
      state: 'ownership-unknown',
      incident: true,
      reason: 'this run cannot confirm whether it ever held the lock, so it must not touch one',
    };
  }
  if (input.owner === null || typeof input.owner !== 'object') {
    return { release: false, state: 'ownership-unknown', incident: true, reason: 'the owner record is unreadable' };
  }
  if (input.owner.runid !== input.runid) {
    return {
      release: false,
      state: 'ownership-unknown',
      incident: true,
      reason: `the lock belongs to runid ${input.owner.runid}`,
    };
  }
  if (input.owner.planHash !== input.planHash) {
    return {
      release: false,
      state: 'ownership-unknown',
      incident: true,
      reason: 'the lock planHash does not match this run',
    };
  }
  if (input.safeToExit !== true) {
    return {
      release: false,
      state: 'retained-by-this-run',
      incident: false,
      reason: 'this run holds the lock but the outcome is not safe to close',
    };
  }
  return { release: true, state: 'released', incident: false, reason: 'this run owns the lock and may release it' };
}

export async function releaseChannelLock(input) {
  const owner = input.owner ?? (await readOwnerRecord(input));
  const verdict = resolveLockDisposition({
    acquisitionConfirmed: true,
    owner,
    runid: input.runid,
    planHash: input.planHash,
    safeToExit: true,
  });
  if (verdict.release !== true) return verdict;

  const removedOwner = await input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `rm ${ownerPath(input.channel)}`,
  });
  if (removedOwner.status !== 0) {
    return {
      release: false,
      state: 'retained-by-this-run',
      incident: true,
      reason: 'the owner record could not be removed, so the lock is left in place',
    };
  }

  const removedLock = await input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `rmdir ${lockPath(input.channel)}`,
  });
  if (removedLock.status !== 0) {
    return {
      release: false,
      state: 'retained-by-this-run',
      incident: true,
      reason: 'the lock directory could not be removed',
    };
  }
  return verdict;
}

export async function breakChannelLock(input) {
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
    throw new FeedPublishError('breaking a lock requires a written reason');
  }
  if (typeof input.auditOut !== 'string' || input.auditOut.length === 0) {
    throw new FeedPublishError('breaking a lock requires --audit-out');
  }
  const owner = await readOwnerRecord(input);
  if (owner === null) {
    throw new FeedPublishError('the lock has no readable owner record, so it must be inspected by hand');
  }
  if (input.confirmRunid !== owner.runid) {
    throw new FeedPublishError(`--confirm-runid does not match the owner runid ${owner.runid}`);
  }
  const removedOwner = await input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `rm ${ownerPath(input.channel)}`,
  });
  const removedLock = await input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `rmdir ${lockPath(input.channel)}`,
  });
  if (removedOwner.status !== 0 || removedLock.status !== 0) {
    throw new FeedPublishError('the remote lock could not be removed');
  }
  return {
    outcome: 'lock-broken',
    previousOwner: owner,
    reason: input.reason,
    operator: input.operator ?? 'unknown',
  };
}
```

- [ ] **Step 4: 运行测试并确认通过**

```bash
node --test scripts/lib/feed-publish.test.mjs
```

预期：`fail 0`。

- [ ] **Step 5: 行为级变异验证**

1. 把 `isFileExistsFailure` 的分支删掉（`status !== 0` 一律 `not-acquired`） ⇒ 预期 `an ssh failure while taking the lock is ownership unknown, not not-acquired` **按测试名变红**。
2. 把 owner 写入的 `written.status !== 0` 检查删掉 ⇒ 预期 `a failed owner write is an incident that keeps the lock` **按测试名变红**。
3. 把 `releaseChannelLock` 里 `rm owner.json` 与 `rmdir lock` 的顺序对调 ⇒ 预期 `release verifies the owner, then removes the owner file, then the lock directory` **按测试名变红**。
4. 把 `removedOwner.status !== 0` 检查删掉 ⇒ 预期 `a failed owner removal is never reported as released` **按测试名变红**。
5. 把 `releaseChannelLock` 里的 `owner ?? readOwnerRecord(input)` 改成直接用传入的 `owner` ⇒ 预期 `release re-reads the owner and refuses when it belongs to another run` **按测试名变红**。
6. 把 `confirmRunid !== owner.runid` 检查删掉 ⇒ 预期 `breaking a lock needs a reason, an audit log and a matching runid` **按测试名变红**。
7. 把 `removedOwner.status !== 0 || removedLock.status !== 0` 的拒绝改成照常返回 ⇒ 预期 `a failed remote deletion is not recorded as lock-broken` **按测试名变红**。
8. 把 `planHashOf` 里的 `manifestSha256` 去掉 ⇒ 预期 `the plan hash binds channel, version and all three artifact digests` **按测试名变红**。

恢复后全绿且 `git diff` 为空。

- [ ] **Step 6: 提交**

```bash
git add scripts/lib/feed-publish.mjs scripts/lib/feed-publish.test.mjs
git commit -m "feat(feed): own the channel lock honestly, including its failure modes"
```

---

### Task 4: 主流程（13 步追踪表的逐行实现）

**Files:**

- Modify: `scripts/lib/feed-publish.mjs`
- Modify: `scripts/lib/feed-publish.test.mjs`

**每写一个 helper，立刻在 `runCommit` 里接上**；不允许出现"定义了但没接"的 helper。

- [ ] **Step 1: 写失败的测试（async 假 transport）**

追加到 `scripts/lib/feed-publish.test.mjs`：

```js
import { appendAuditStage, runCommit, verifyPublicArtifacts } from './feed-publish.mjs';

const BASELINE_BODY = '{"baseline":true}\n';
const THIRD_BODY = '{"third":true}\n';
const digestOf = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const BASELINE_SHA = digestOf(BASELINE_BODY);
const THIRD_SHA = digestOf(THIRD_BODY);

function commitTransport(options = {}) {
  const calls = [];
  let manifestReads = 0;
  let ownerJson = null;
  const listing = `f ${PORTABLE_PACKAGE_NAME} ${PACKAGE_BYTES.length}\nf ${PORTABLE_FILE_MANIFEST_NAME} ${FILE_MANIFEST_BYTES.length}\n`;
  const digests = (directory, zipDigest) =>
    `${zipDigest}  ${directory}/${PORTABLE_PACKAGE_NAME}\n${FILE_MANIFEST_SHA256}  ${directory}/${PORTABLE_FILE_MANIFEST_NAME}\n`;

  return {
    calls,
    readOnly: {
      sshRun: async (request) => {
        calls.push(['readSsh', request.script]);
        if (request.script.includes('owner.json')) {
          return ownerJson === null
            ? { status: 1, stdout: '', stderr: 'no such file' }
            : { status: 0, stdout: ownerJson, stderr: '' };
        }
        if (request.script.includes('-mindepth 1 -maxdepth 1 -printf')) {
          if (request.script.includes('/staging/')) return { status: 0, stdout: listing, stderr: '' };
          const state = options.versionDirState ?? 'absent';
          if (state === 'absent' || state === 'empty') return { status: 0, stdout: '', stderr: '' };
          if (state === 'extra') return { status: 0, stdout: `${listing}f extra.bin 3\n`, stderr: '' };
          if (state === 'size') {
            return {
              status: 0,
              stdout: `f ${PORTABLE_PACKAGE_NAME} ${PACKAGE_BYTES.length + 1}\nf ${PORTABLE_FILE_MANIFEST_NAME} ${FILE_MANIFEST_BYTES.length}\n`,
              stderr: '',
            };
          }
          return { status: 0, stdout: listing, stderr: '' };
        }
        if (request.script.startsWith('if [ -d ')) {
          const state = options.versionDirState ?? 'absent';
          const present = state !== 'absent';
          const insideStaging = request.script.includes('/staging/');
          if (!present && !insideStaging) return { status: 0, stdout: '', stderr: '' };
          return { status: 0, stdout: 'present\n', stderr: '' };
        }
        if (request.script.includes('sha256sum') && request.script.includes('portable-files.json')) {
          const inStaging = request.script.includes('/staging/');
          if (!inStaging && (options.versionDirState ?? 'absent') === 'absent')
            return { status: 0, stdout: '', stderr: '' };
          const zipDigest = options.versionDirState === 'digest' ? THIRD_SHA : PACKAGE_SHA256;
          return { status: 0, stdout: digests(inStaging ? 'staging' : 'version', zipDigest), stderr: '' };
        }
        if (request.script.includes("stat -c '%d'")) {
          return { status: 0, stdout: options.sameFileSystem === false ? '100\n200\n' : '100\n100\n', stderr: '' };
        }
        if (request.script.includes('manifest.json') && request.script.includes('.tmp')) {
          return {
            status: 0,
            stdout: `${options.tempManifestSha ?? 'MISSING'}  ${request.script.split(/\s+/u)[1]}\n`,
            stderr: '',
          };
        }
        if (request.script.includes('manifest.json')) {
          manifestReads += 1;
          const digest = options.casDrift === true && manifestReads > 1 ? THIRD_SHA : BASELINE_SHA;
          return { status: 0, stdout: `${digest}  ${UPDATE_ROOT}/internal/manifest.json\n`, stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    },
    write: {
      sshRun: async (request) => {
        calls.push(['writeSsh', request.script]);
        if (request.script.startsWith('mkdir ') && request.script.includes('/lock/')) {
          return options.lockState === 'exists'
            ? { status: 1, stdout: '', stderr: 'mkdir: cannot create directory: File exists' }
            : { status: 0, stdout: '', stderr: '' };
        }
        const ownerMatch = /printf '%s' '(\{.*\})' >/u.exec(request.script);
        if (ownerMatch !== null) ownerJson = ownerMatch[1];
        if (
          /^mv \/opt\/rongying\/updates-state\/staging\//u.test(request.script) &&
          options.commitStatus !== undefined
        ) {
          return { status: options.commitStatus, stdout: '', stderr: 'commit refused' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
      sftpUpload: async (request) => {
        calls.push(['sftpUpload', request.localPath, request.remotePath]);
        if (options.uploadStatus !== undefined && !request.localPath.includes('manifest.json')) {
          return { status: options.uploadStatus, bytesSent: 0, stderr: 'connection lost' };
        }
        if (options.manifestUploadStatus !== undefined && request.localPath.includes('manifest.json')) {
          return { status: options.manifestUploadStatus, bytesSent: 0, stderr: 'connection lost' };
        }
        return { status: 0, bytesSent: 1 };
      },
    },
    fetchPublic: async (url) => {
      calls.push(['fetchPublic', url]);
      if (options.publicStatus !== undefined && options.publicStatus !== 200) {
        return { status: options.publicStatus, bodyBytes: new Uint8Array() };
      }
      const body =
        options.publicManifestBody ??
        (url.endsWith('manifest.json')
          ? BASELINE_BODY
          : url.endsWith('portable.zip')
            ? PACKAGE_BYTES.toString('binary')
            : FILE_MANIFEST_BYTES.toString('binary'));
      return { status: 200, bodyBytes: Uint8Array.from(Buffer.from(body, 'binary')) };
    },
  };
}

function commitInput(transport, overrides = {}) {
  const auditRoot = makeRoot();
  const paths = writeArtifacts();
  return {
    channel: 'internal',
    version: '1.2.3',
    host: 'example.invalid',
    knownHostsPath: join(tmpdir(), 'known_hosts'),
    runid: 'r1',
    publicKeyBase64: PUBLIC_KEY_BASE64,
    auditOut: join(auditRoot, 'audit.jsonl'),
    repositoryRoot: makeRoot(),
    temporaryRoot: makeRoot(),
    verifier: () => {},
    ...paths,
    ...overrides,
  };
}

function manifestShaOf(paths) {
  return createHash('sha256').update(paths.manifestBytes).digest('hex');
}

function happyTransport(paths, extra = {}) {
  return commitTransport({
    publicManifestBody: paths.manifestBytes.toString('binary'),
    tempManifestSha: manifestShaOf(paths),
    ...extra,
  });
}

test('the local pre-verification happens before any network write', async () => {
  const transport = commitTransport();
  const input = commitInput(transport);
  const result = await runCommit({ ...input, packagePath: join(makeRoot(), 'missing.zip') });
  assert.equal(result.outcome, 'fail');
  assert.deepEqual(
    transport.calls.filter((call) => call[0] !== 'readSsh'),
    [],
  );
});

test('a clean publish walks every stage and releases its own lock', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const result = await runCommit(commitInput(transport, { ...paths }));
  assert.equal(result.outcome, 'done', result.reason);
  assert.equal(result.lockState, 'released');
  assert.deepEqual(
    result.stages.map((entry) => entry.status),
    PUBLISH_STAGES.map(() => 'done'),
  );
});

test('the version directory is committed with a single directory rename', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const result = await runCommit(commitInput(transport, { ...paths }));
  assert.equal(result.outcome, 'done', result.reason);
  const renames = transport.calls.filter(
    (call) => call[0] === 'writeSsh' && String(call[1]).startsWith('mv /opt/rongying/updates-state/staging/'),
  );
  assert.equal(renames.length, 1);
  const strayPartMoves = transport.calls.filter(
    (call) => call[0] === 'writeSsh' && String(call[1]).includes('.part-') && !String(call[1]).includes('/staging/'),
  );
  assert.deepEqual(strayPartMoves, []);
});

test('the manifest is uploaded to the final directory and its remote digest is checked', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const result = await runCommit(commitInput(transport, { ...paths }));
  assert.equal(result.outcome, 'done', result.reason);
  const uploads = transport.calls.filter(
    (call) => call[0] === 'sftpUpload' && String(call[1]).includes('manifest.json'),
  );
  assert.equal(uploads.length, 1);
  assert.match(String(uploads[0][2]), /\/internal\/manifest\.json\.r1\.tmp$/u);
});

test('a mismatched remote manifest digest stops before the flip', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { tempManifestSha: 'F'.repeat(64) });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.equal(result.stages.find((entry) => entry.stage === 'flip').status, 'pending');
});

test('a manifest upload failure is an incident that keeps the lock', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { manifestUploadStatus: 1 });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.equal(result.stages.find((entry) => entry.stage === 'flip').status, 'pending');
});

test('a cas mismatch is an incident that keeps the lock and never rolls anything back', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { casDrift: true });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.equal(result.stages.find((entry) => entry.stage === 'cas').status, 'incident');
  assert.equal(result.stages.find((entry) => entry.stage === 'flip').status, 'pending');
  const destructive = transport.calls.filter((call) => /rm -rf|mv -f.*manifest/u.test(String(call[1] ?? '')));
  assert.deepEqual(destructive, []);
});

test('an indeterminate outcome with the old public sha allows a retry and keeps the lock', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { publicManifestBody: BASELINE_BODY });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assert.equal(result.outcome, 'retry');
  assert.equal(result.lockState, 'retained-by-this-run');
});

test('an indeterminate outcome with a third public sha stops and keeps the lock', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { publicManifestBody: THIRD_BODY });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.match(result.reason, /third/u);
});

test('a staging failure is a plain failure and reports that no lock was acquired', async () => {
  const paths = writeArtifacts();
  const transport = commitTransport({ uploadStatus: 1 });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assert.equal(result.outcome, 'fail');
  assert.equal(result.lockState, 'not-acquired');
  assert.equal(result.stages.find((entry) => entry.stage === 'lock').status, 'pending');
});

test('a failure after the lock but before the flip releases the lock this run owns', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { commitStatus: 1 });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assert.equal(result.outcome, 'fail');
  assert.equal(result.lockState, 'released');
  assert.equal(result.stages.find((entry) => entry.stage === 'unlock').status, 'done');
});

test('the commit never runs when the lock already exists', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { lockState: 'exists' });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.lockState, 'not-acquired');
  assert.equal(result.stages.find((entry) => entry.stage === 'commit-version').status, 'pending');
});

test('a staging directory and a final directory on different file systems stops the commit', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { sameFileSystem: false });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assert.equal(result.outcome, 'fail');
  assert.match(result.reason, /file system/u);
  assert.equal(result.lockState, 'released');
});

test('an existing version directory that is empty is incomplete and refused', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { versionDirState: 'empty' });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assert.equal(result.outcome, 'fail');
  assert.match(result.reason, /incomplete/u);
});

test('an existing version directory with an extra entry is refused', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { versionDirState: 'extra' });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assert.equal(result.outcome, 'fail');
  assert.match(result.reason, /unexpected entry/u);
});

test('an existing version directory with a different size is refused', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { versionDirState: 'size' });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assert.equal(result.outcome, 'fail');
  assert.match(result.reason, /size/u);
});

test('an existing version directory with a different digest is refused', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { versionDirState: 'digest' });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assert.equal(result.outcome, 'fail');
  assert.match(result.reason, /digest/u);
});

test('an existing version directory that matches every byte is reused', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { versionDirState: 'present' });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assert.equal(result.outcome, 'done', result.reason);
  assert.equal(result.stages.find((entry) => entry.stage === 'commit-version').status, 'done');
});

test('every stage is appended to the audit log as it happens', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assert.equal(result.outcome, 'done', result.reason);
  const stages = readFileSync(input.auditOut, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).stage);
  assert.equal(stages[0], 'open');
  assert.equal(stages[1], 'pre-verify');
  assert.ok(stages.includes('cas'));
  assert.ok(stages.includes('flip'));
  assert.ok(stages.includes('public-verify'));
  assert.ok(stages.includes('done'));
  assert.ok(stages.indexOf('done') < stages.indexOf('unlock'), 'the outcome entry is written before the unlock entry');
  assert.equal(stages.at(-1), 'unlock');
});

test('the audit log refuses to be written inside the repository', () => {
  const repositoryRoot = makeRoot();
  assert.throws(
    () => appendAuditStage({ auditOut: join(repositoryRoot, 'audit.jsonl'), entry: { stage: 'open' }, repositoryRoot }),
    FeedPublishError,
  );
});

test('a failed audit write stops the run instead of publishing silently', async () => {
  const paths = writeArtifacts();
  const transport = commitTransport();
  const result = await runCommit(
    commitInput(transport, { ...paths, auditOut: join(makeRoot(), 'no-such-dir', 'audit.jsonl') }),
  );
  assert.equal(result.outcome, 'fail');
  assert.match(result.reason, /audit/u);
});

test('the public verification checks the manifest, the signature and both artifacts', async () => {
  const paths = writeArtifacts();
  const calls = [];
  const result = await verifyPublicArtifacts({
    channel: 'internal',
    version: '1.2.3',
    publicKeyBase64: PUBLIC_KEY_BASE64,
    verifier: () => {},
    expectedManifestBytes: paths.manifestBytes,
    expectedPackageSha256: PACKAGE_SHA256,
    expectedPackageSize: PACKAGE_BYTES.length,
    expectedFileManifestSha256: FILE_MANIFEST_SHA256,
    expectedFileManifestSize: FILE_MANIFEST_BYTES.length,
    temporaryRoot: makeRoot(),
    transport: {
      fetchPublic: async (url) => {
        calls.push(url);
        if (url.endsWith('manifest.json')) return { status: 200, bodyBytes: Uint8Array.from(paths.manifestBytes) };
        if (url.endsWith('portable.zip')) return { status: 200, bodyBytes: Uint8Array.from(PACKAGE_BYTES) };
        return { status: 200, bodyBytes: Uint8Array.from(FILE_MANIFEST_BYTES) };
      },
    },
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(calls.length, 3);
});

test('the public verification fails when the served package differs', async () => {
  const paths = writeArtifacts();
  const result = await verifyPublicArtifacts({
    channel: 'internal',
    version: '1.2.3',
    publicKeyBase64: PUBLIC_KEY_BASE64,
    verifier: () => {},
    expectedManifestBytes: paths.manifestBytes,
    expectedPackageSha256: PACKAGE_SHA256,
    expectedPackageSize: PACKAGE_BYTES.length,
    expectedFileManifestSha256: FILE_MANIFEST_SHA256,
    expectedFileManifestSize: FILE_MANIFEST_BYTES.length,
    temporaryRoot: makeRoot(),
    transport: {
      fetchPublic: async (url) => {
        if (url.endsWith('manifest.json')) return { status: 200, bodyBytes: Uint8Array.from(paths.manifestBytes) };
        if (url.endsWith('portable.zip')) return { status: 200, bodyBytes: Uint8Array.from(Buffer.from('other')) };
        return { status: 200, bodyBytes: Uint8Array.from(FILE_MANIFEST_BYTES) };
      },
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /package/u);
});
```

- [ ] **Step 2: 运行测试并确认按测试名失败**

```bash
node --test scripts/lib/feed-publish.test.mjs
```

预期：`runCommit` / `verifyPublicArtifacts` / `appendAuditStage` 未定义。

- [ ] **Step 3: 写最小实现**

追加到 `scripts/lib/feed-publish.mjs`（`node:fs` 补 `appendFileSync`、`writeFileSync`；`node:path` 补 `join`，补齐后该 import 行恰好是 `import { isAbsolute, join, relative, resolve } from 'node:path';`，**本刀不引入 `sep`** —— "是否在仓库内"的判据与 Task 1 的 `assertKnownHostsPath` 一样用 `relative` + `isAbsolute`）：

```js
export function appendAuditStage(input) {
  if (typeof input.repositoryRoot === 'string' && input.repositoryRoot.length > 0) {
    assertOutsideRepository(input.auditOut, input.repositoryRoot);
  }
  try {
    appendFileSync(input.auditOut, `${JSON.stringify(input.entry)}\n`, 'utf8');
  } catch (error) {
    throw new FeedPublishError(`the audit log could not be written: ${error?.message ?? error}`);
  }
  return input.auditOut;
}

function assertOutsideRepository(target, repositoryRoot) {
  const resolved = resolve(target);
  const root = resolve(repositoryRoot);
  const rel = relative(root, resolved);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new FeedPublishError('the audit log must live outside the repository');
  }
  return resolved;
}

function versionRootOf(channel, version) {
  return `${UPDATE_ROOT}/${channel}/${version}`;
}

function stagingRootOf(channel, version, planHash) {
  return `${STATE_ROOT}/staging/${channel}/${version}/${planHash}`;
}

async function readRemoteDirectory(input, directory) {
  const listing = await input.transport.readOnly.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `if [ -d ${directory} ]; then find ${directory} -mindepth 1 -maxdepth 1 -printf '%y %f %s\\n' | sort; fi`,
  });
  if (listing.status !== 0) return [];
  const entries = [];
  for (const line of String(listing.stdout ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const [type, name, size] = trimmed.split(/\s+/u);
    entries.push({ type, name, size: Number(size) });
  }
  return entries;
}

async function remoteDirectoryExists(input, directory) {
  const probe = await input.transport.readOnly.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `if [ -d ${directory} ]; then printf 'present\\n'; fi`,
  });
  return probe.status === 0 && String(probe.stdout ?? '').trim() === 'present';
}

async function readRemoteHashes(input, directory, names) {
  const result = await input.transport.readOnly.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `sha256sum ${names.map((name) => `${directory}/${name}`).join(' ')}`,
  });
  if (result.status !== 0) return null;
  const hashes = new Map();
  for (const line of String(result.stdout ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const [digest, target] = trimmed.split(/\s+/u);
    hashes.set(target.split('/').pop(), digest);
  }
  return hashes;
}

function compareDirectoryEntries(entries, expected) {
  const problems = [];
  if (entries.length !== expected.length) {
    problems.push(`the directory holds ${entries.length} entries, expected ${expected.length}`);
  }
  for (const entry of entries) {
    if (entry.type !== 'f') problems.push(`${entry.name} is not a regular file (type ${entry.type})`);
  }
  for (const item of expected) {
    const match = entries.find((entry) => entry.name === item.name);
    if (match === undefined) {
      problems.push(`${item.name} is missing`);
      continue;
    }
    if (match.size !== item.size) problems.push(`${item.name} has size ${match.size}, expected ${item.size}`);
  }
  for (const entry of entries) {
    if (!expected.some((item) => item.name === entry.name)) problems.push(`${entry.name} is an unexpected entry`);
  }
  return problems;
}

function compareDirectoryHashes(hashes, expected) {
  if (hashes === null) return ['the remote digests could not be read'];
  const problems = [];
  for (const item of expected) {
    if (hashes.get(item.name) !== item.sha256) problems.push(`${item.name} does not carry the expected digest`);
  }
  return problems;
}

async function inspectRemoteDirectory(input, directory, expectedEntries) {
  const exists = await remoteDirectoryExists(input, directory);
  if (!exists) return { present: false, empty: false, problems: [] };
  const entries = await readRemoteDirectory(input, directory);
  if (entries.length === 0) return { present: true, empty: true, problems: [] };
  const problems = compareDirectoryEntries(entries, expectedEntries);
  if (problems.length === 0) {
    problems.push(
      ...compareDirectoryHashes(
        await readRemoteHashes(
          input,
          directory,
          expectedEntries.map((item) => item.name),
        ),
        expectedEntries,
      ),
    );
  }
  return { present: true, empty: false, problems };
}

async function readRemoteFileSha(input, target) {
  const result = await input.transport.readOnly.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `sha256sum ${target} || true`,
  });
  return String(result.stdout ?? '').split(/\s+/u)[0] || 'absent';
}

export async function verifyPublicArtifacts(input) {
  const base = `${PUBLIC_BASE_URL}/${input.channel}/${input.version}`;
  const manifestResponse = await input.transport.fetchPublic(`${base}/${PORTABLE_MANIFEST_NAME}`);
  if (manifestResponse.status !== 200) return { ok: false, reason: 'the public manifest is not reachable' };

  const manifestBytes = Buffer.from(manifestResponse.bodyBytes);
  if (!manifestBytes.equals(input.expectedManifestBytes)) {
    return { ok: false, reason: 'the public manifest is not the manifest this run signed' };
  }

  const packageResponse = await input.transport.fetchPublic(`${base}/${PORTABLE_PACKAGE_NAME}`);
  if (packageResponse.status !== 200) return { ok: false, reason: 'the public package is not reachable' };
  const packageBytes = Buffer.from(packageResponse.bodyBytes);
  if (createHash('sha256').update(packageBytes).digest('hex') !== input.expectedPackageSha256) {
    return { ok: false, reason: 'the public package integrity check failed' };
  }
  if (packageBytes.length !== input.expectedPackageSize) {
    return { ok: false, reason: 'the public package size does not match' };
  }

  const fileManifestResponse = await input.transport.fetchPublic(`${base}/${PORTABLE_FILE_MANIFEST_NAME}`);
  if (fileManifestResponse.status !== 200) return { ok: false, reason: 'the public file manifest is not reachable' };
  const fileManifestBytes = Buffer.from(fileManifestResponse.bodyBytes);
  if (createHash('sha256').update(fileManifestBytes).digest('hex') !== input.expectedFileManifestSha256) {
    return { ok: false, reason: 'the public file manifest integrity check failed' };
  }
  if (fileManifestBytes.length !== input.expectedFileManifestSize) {
    return { ok: false, reason: 'the public file manifest size does not match' };
  }

  const packagePath = join(input.temporaryRoot, PORTABLE_PACKAGE_NAME);
  const fileManifestPath = join(input.temporaryRoot, PORTABLE_FILE_MANIFEST_NAME);
  writeFileSync(packagePath, packageBytes);
  writeFileSync(fileManifestPath, fileManifestBytes);
  await input.verifier({ manifestBytes, fileManifestBytes, packagePath, publicKeyBase64: input.publicKeyBase64 });

  return { ok: true, manifestSha256: createHash('sha256').update(manifestBytes).digest('hex') };
}

export async function runCommit(input) {
  const stages = PUBLISH_STAGES.map((stage) => ({ stage, status: 'pending' }));
  const runid = input.runid;
  let acquisitionConfirmed = false;
  let planHash = 'uncomputed';
  let owner = null;

  const audit = (stage, status, detail) => {
    stages.find((entry) => entry.stage === stage).status = status;
    appendAuditStage({
      auditOut: input.auditOut,
      repositoryRoot: input.repositoryRoot,
      entry: { stage, status, runid, ...(detail === undefined ? {} : { detail }) },
    });
  };

  const finish = (outcome, reason, lockState) => ({ outcome, reason, lockState, stages, runid, planHash });

  const recordOutcome = (outcome, reason) => {
    appendAuditStage({
      auditOut: input.auditOut,
      repositoryRoot: input.repositoryRoot,
      entry: { stage: outcome, reason, runid, planHash },
    });
  };

  // 硬规则：**每一次 `return finish(...)` 之前都必须先 `recordOutcome(outcome, reason)`**。
  // `retainAndFinish` 与 `releaseAndFinish` 已经在内部调用它；四条提前失败路径
  // （pre-verify / stage / remote-verify / lock）必须各自显式调用一次，
  // 否则审计日志会缺掉"这次运行到底以什么结果收场"。

  const retainAndFinish = (outcome, reason) => {
    const disposition = resolveLockDisposition({ acquisitionConfirmed, owner, runid, planHash, safeToExit: false });
    stages.find((entry) => entry.stage === 'unlock').status = 'retained';
    recordOutcome(outcome, reason);
    appendAuditStage({
      auditOut: input.auditOut,
      repositoryRoot: input.repositoryRoot,
      entry: { stage: 'lock-retained', status: 'retained', runid, reason: disposition.reason },
    });
    return finish(outcome, reason, disposition.state);
  };

  const releaseAndFinish = async (failedStage, outcome, reason) => {
    stages.find((entry) => entry.stage === failedStage).status = 'fail';
    recordOutcome(outcome, reason);
    const disposition = await releaseChannelLock({
      channel: input.channel,
      transport: input.transport,
      owner,
      runid,
      planHash,
      host: input.host,
      knownHostsPath: input.knownHostsPath,
    });
    const unlockStatus = disposition.release ? 'done' : 'retained';
    stages.find((entry) => entry.stage === 'unlock').status = unlockStatus;
    appendAuditStage({
      auditOut: input.auditOut,
      repositoryRoot: input.repositoryRoot,
      entry: { stage: 'unlock', status: unlockStatus, runid, reason: disposition.reason },
    });
    return finish(outcome, reason, disposition.state);
  };

  appendAuditStage({ auditOut: input.auditOut, repositoryRoot: input.repositoryRoot, entry: { stage: 'open', runid } });

  let local;
  try {
    local = await verifyLocalArtifacts({
      packagePath: input.packagePath,
      fileManifestPath: input.fileManifestPath,
      manifestPath: input.manifestPath,
      expectedChannel: input.channel,
      expectedVersion: input.version,
      publicKeyBase64: input.publicKeyBase64,
      verifySignature: input.verifySignature,
    });
  } catch (error) {
    audit('pre-verify', 'fail', error.message);
    return finish('fail', error.message, 'not-acquired');
  }
  planHash = planHashOf({
    channel: input.channel,
    version: input.version,
    packageSha256: local.packageSha256,
    fileManifestSha256: local.fileManifestSha256,
    manifestSha256: local.manifestSha256,
  });
  audit('pre-verify', 'done');

  const versionRoot = versionRootOf(input.channel, input.version);
  const stagingRoot = stagingRootOf(input.channel, input.version, planHash);
  const expectedEntries = [
    { name: PORTABLE_PACKAGE_NAME, size: local.packageSize, sha256: local.packageSha256 },
    { name: PORTABLE_FILE_MANIFEST_NAME, size: local.fileManifestSize, sha256: local.fileManifestSha256 },
  ];

  const stagingCreated = await input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `mkdir -p ${stagingRoot}`,
  });
  if (stagingCreated.status !== 0) {
    audit('stage', 'fail', 'the staging directory could not be created');
    return finish('fail', 'the staging directory could not be created', 'not-acquired');
  }

  for (const item of [
    { localPath: input.packagePath, remotePath: `${stagingRoot}/${PORTABLE_PACKAGE_NAME}.part-${runid}` },
    { localPath: input.fileManifestPath, remotePath: `${stagingRoot}/${PORTABLE_FILE_MANIFEST_NAME}.part-${runid}` },
  ]) {
    const uploaded = await input.transport.write.sftpUpload({ ...item, resume: true });
    if (uploaded.status !== 0) {
      audit('stage', 'fail', uploaded.stderr ?? 'upload failed');
      return finish('fail', 'the staging upload failed', 'not-acquired');
    }
  }

  const finalised = await input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: [
      `mv -f ${stagingRoot}/${PORTABLE_PACKAGE_NAME}.part-${runid} ${stagingRoot}/${PORTABLE_PACKAGE_NAME}`,
      `mv -f ${stagingRoot}/${PORTABLE_FILE_MANIFEST_NAME}.part-${runid} ${stagingRoot}/${PORTABLE_FILE_MANIFEST_NAME}`,
    ].join(' && '),
  });
  if (finalised.status !== 0) {
    audit('stage', 'fail', 'the staging directory could not be finalised');
    return finish('fail', 'the staging directory could not be finalised', 'not-acquired');
  }
  audit('stage', 'done');

  const staging = await inspectRemoteDirectory(input, stagingRoot, expectedEntries);
  if (!staging.present || staging.empty || staging.problems.length > 0) {
    const detail = staging.empty ? 'the staging directory is empty' : staging.problems.join('; ');
    audit('remote-verify', 'fail', detail);
    return finish('fail', `the staging directory is not the exact final file set: ${detail}`, 'not-acquired');
  }
  audit('remote-verify', 'done');

  const lock = await acquireChannelLock({
    channel: input.channel,
    transport: input.transport,
    owner: { runid, planHash },
    host: input.host,
    knownHostsPath: input.knownHostsPath,
  });
  if (lock.acquired !== true) {
    audit('lock', lock.state === 'not-acquired' ? 'blocked' : 'incident', lock.reason);
    return finish(lock.state === 'not-acquired' ? 'blocked' : 'incident', lock.reason, lock.state);
  }
  acquisitionConfirmed = true;
  owner = lock.owner;
  audit('lock', 'done');

  owner = (await readOwnerRecord(input)) ?? owner;
  const baselineSha = await readRemoteFileSha(input, `${UPDATE_ROOT}/${input.channel}/${PORTABLE_MANIFEST_NAME}`);
  const stagingAfterLock = await inspectRemoteDirectory(input, stagingRoot, expectedEntries);
  if (!stagingAfterLock.present || stagingAfterLock.empty || stagingAfterLock.problems.length > 0) {
    audit('re-verify', 'incident', 'the staging bytes changed while the lock was being taken');
    return retainAndFinish('incident', 'the staging bytes changed while the lock was being taken');
  }
  audit('re-verify', 'done');

  const devices = await input.transport.readOnly.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `stat -c '%d' ${STATE_ROOT} ${UPDATE_ROOT}`,
  });
  const deviceList = String(devices.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (devices.status !== 0 || deviceList.length !== 2 || deviceList[0] !== deviceList[1]) {
    return releaseAndFinish(
      'commit-version',
      'fail',
      'the staging root and the update root are not on the same file system',
    );
  }

  const existing = await inspectRemoteDirectory(input, versionRoot, expectedEntries);
  if (existing.present && existing.empty) {
    return releaseAndFinish(
      'commit-version',
      'fail',
      'the immutable version directory already exists but is incomplete',
    );
  }
  if (existing.present && existing.problems.length > 0) {
    return releaseAndFinish(
      'commit-version',
      'fail',
      `the immutable version directory already exists and does not match: ${existing.problems.join('; ')}`,
    );
  }
  if (existing.present) {
    audit('commit-version', 'done', 'the immutable version directory already matched every byte');
  } else {
    const committed = await input.transport.write.sshRun({
      host: input.host,
      knownHostsPath: input.knownHostsPath,
      script: `mv ${stagingRoot} ${versionRoot}`,
    });
    if (committed.status !== 0) {
      return releaseAndFinish('commit-version', 'fail', 'the version directory was not committed');
    }
    audit('commit-version', 'done');
  }

  const backup = await input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: [
      `mkdir -p ${STATE_ROOT}/backup`,
      `cp ${UPDATE_ROOT}/${input.channel}/${PORTABLE_MANIFEST_NAME} ${STATE_ROOT}/backup/${input.channel}-manifest.json-pre-${input.version} 2>/dev/null || true`,
    ].join(' && '),
  });
  if (backup.status !== 0) {
    return retainAndFinish('incident', 'the previous manifest could not be backed up');
  }
  audit('backup-manifest', 'done');

  const casSha = await readRemoteFileSha(input, `${UPDATE_ROOT}/${input.channel}/${PORTABLE_MANIFEST_NAME}`);
  if (casSha !== baselineSha) {
    audit('cas', 'incident');
    return retainAndFinish(
      'incident',
      'the manifest changed after the lock was taken, which means a bypass; nothing is flipped, rolled back or deleted',
    );
  }
  audit('cas', 'done');

  const tempManifestPath = `${UPDATE_ROOT}/${input.channel}/${PORTABLE_MANIFEST_NAME}.${runid}.tmp`;
  const manifestUploaded = await input.transport.write.sftpUpload({
    localPath: input.manifestPath,
    remotePath: tempManifestPath,
    resume: false,
  });
  if (manifestUploaded.status !== 0) {
    audit('temp-manifest', 'incident', 'the manifest upload failed');
    return retainAndFinish('incident', 'the manifest could not be uploaded, so the outcome is uncertain');
  }
  const remoteTempSha = await readRemoteFileSha(input, tempManifestPath);
  if (remoteTempSha !== local.manifestSha256) {
    audit('temp-manifest', 'incident', 'the uploaded manifest digest does not match the local manifest');
    return retainAndFinish('incident', 'the uploaded manifest does not match the local manifest');
  }
  audit('temp-manifest', 'done');

  const flipped = await input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `mv -f ${tempManifestPath} ${UPDATE_ROOT}/${input.channel}/${PORTABLE_MANIFEST_NAME}`,
  });
  if (flipped.status !== 0) {
    audit('flip', 'incident', 'the atomic flip failed');
    return retainAndFinish('incident', 'the atomic flip failed, so the outcome is uncertain');
  }
  audit('flip', 'done');

  const observed = await input.transport.fetchPublic(`${PUBLIC_BASE_URL}/${input.channel}/${PORTABLE_MANIFEST_NAME}`);
  if (observed.status !== 200 || observed.bodyBytes === undefined) {
    audit('public-verify', 'incident', 'the public manifest could not be read');
    return retainAndFinish('incident', 'the public manifest could not be read, so the outcome is uncertain');
  }
  const observedSha = createHash('sha256').update(Buffer.from(observed.bodyBytes)).digest('hex');
  if (observedSha === local.manifestSha256) {
    const publicCheck = await verifyPublicArtifacts({
      channel: input.channel,
      version: input.version,
      publicKeyBase64: input.publicKeyBase64,
      verifier: input.verifier ?? (() => {}),
      expectedManifestBytes: local.manifestBytes,
      expectedPackageSha256: local.packageSha256,
      expectedPackageSize: local.packageSize,
      expectedFileManifestSha256: local.fileManifestSha256,
      expectedFileManifestSize: local.fileManifestSize,
      transport: input.transport,
      temporaryRoot: input.temporaryRoot,
    });
    if (publicCheck.ok !== true) {
      audit('public-verify', 'incident', publicCheck.reason);
      return retainAndFinish('incident', `the public verification failed: ${publicCheck.reason}`);
    }
    audit('public-verify', 'done');
    audit('reveal', 'done');
  } else if (observedSha === baselineSha) {
    audit('public-verify', 'retry');
    return retainAndFinish('retry', 'the flip did not take effect');
  } else {
    audit('public-verify', 'incident', 'a third manifest digest appeared');
    return retainAndFinish('incident', 'a third manifest digest appeared while flipping');
  }

  recordOutcome('done', 'published');
  const disposition = await releaseChannelLock({
    channel: input.channel,
    transport: input.transport,
    owner,
    runid,
    planHash,
    host: input.host,
    knownHostsPath: input.knownHostsPath,
  });
  const unlockStatus = disposition.release ? 'done' : 'retained';
  stages.find((entry) => entry.stage === 'unlock').status = unlockStatus;
  appendAuditStage({
    auditOut: input.auditOut,
    repositoryRoot: input.repositoryRoot,
    entry: { stage: 'unlock', status: unlockStatus, runid, reason: disposition.reason },
  });
  if (disposition.release !== true) return finish('incident', disposition.reason, disposition.state);
  return finish('done', 'published', disposition.state);
}
```

- [ ] **Step 4: 运行测试并确认通过**

```bash
node --test scripts/lib/feed-publish.test.mjs
```

预期：`fail 0`。

- [ ] **Step 5: 行为级变异验证（逐条对着追踪表）**

1. 把 `verifyLocalArtifacts` 调用移到 `stage` 之后 ⇒ 预期 `the local pre-verification happens before any network write` **按测试名变红**。
2. 把 staging 的 `mkdir -p` 退出码检查改成不检查 ⇒ 本刀**无独立用例覆盖** ⇒ **记"未验证"**，并在 Step 1 补一条 `the staging directory could not be created` 的用例后再跑。
3. 把单次目录 `mv` 改回 `mkdir -p` + 两次逐文件 `mv` ⇒ 预期 `the version directory is committed with a single directory rename` **按测试名变红**。
4. 把 manifest 的 SFTP 上传换成 `cp <本地 Windows 路径>` ⇒ 预期 `the manifest is uploaded to the final directory and its remote digest is checked` **按测试名变红**。
5. 删掉远端临时 manifest 的 SHA 比对 ⇒ 预期 `a mismatched remote manifest digest stops before the flip` **按测试名变红**。
6. 删掉设备号比对 ⇒ 预期 `a staging directory and a final directory on different file systems stops the commit` **按测试名变红**。
7. 把"存在但为空"的分支改成当成不存在 ⇒ 预期 `an existing version directory that is empty is incomplete and refused` **按测试名变红**。
8. 删掉 `compareDirectoryHashes` 调用 ⇒ 预期 `an existing version directory with a different digest is refused` **按测试名变红**。
9. 把 `appendAuditStage` 改成最后一次性写 ⇒ 预期 `every stage is appended to the audit log as it happens` **按测试名变红**。
10. 把 `appendAuditStage` 的 `catch` 改成吞掉 ⇒ 预期 `a failed audit write stops the run instead of publishing silently` **按测试名变红**。
11. 把 `verifyPublicArtifacts` 的调用删掉（只比 manifest SHA）⇒ 预期 `the public verification fails when the served package differs` **按测试名变红**。
12. 把 `runCommit` 里五处 `await`（`verifyLocalArtifacts` / `write.sftpUpload` / `write.sshRun` / `fetchPublic` / `releaseChannelLock`）各删一处 ⇒ 对应测试**按测试名变红**；这是对"漏 await"的正面检查。**`verifyLocalArtifacts` 那处最要紧**：`runCommit` 里它是裸调用、又在 `try` 里，漏掉 `await` 会让 `catch` 永不触发、`planHashOf` 读到 `undefined` 摘要，而 `pre-verify` 审计项却写 `done` —— 正是这轮复核在计划里抓到的那个形状。

恢复后全绿且 `git diff` 为空。

- [ ] **Step 6: 提交**

```bash
git add scripts/lib/feed-publish.mjs scripts/lib/feed-publish.test.mjs
git commit -m "feat(feed): publish the manifest over sftp and verify it on the public url"
```

**验收项（真验证器）**：本任务与 Task 7 是**第一次注入真 `verifyPortableRelease`** 的地方。Task 1 的夹具用的是 `JSON.stringify(payload)`（插入顺序），而真生产者/验证器按 **`canonicalize()`（排序键）** 签 —— 夹具直接喂给真验证器会以 `release manifest signature is invalid` 失败，**看起来像产品 bug**。接真验证器时必须实跑一次三角验证，不要假设。

---

### Task 5: `internal → stable` 重签

**Files:**

- Modify: `scripts/lib/feed-publish.mjs`
- Modify: `scripts/lib/feed-publish.test.mjs`

- [ ] **Step 1: 写失败的测试**

追加：

```js
import { buildStableManifestInput } from './feed-publish.mjs';

test('the stable manifest is re-signed with the stable channel and the stable url', () => {
  const paths = writeArtifacts();
  const input = buildStableManifestInput({
    version: '1.2.3',
    minLauncherVersion: '1.0.0',
    fileManifest: FILE_MANIFEST,
    fileManifestBytes: FILE_MANIFEST_BYTES,
    packagePath: paths.packagePath,
    publishedAt: '2026-09-22T00:00:00.000Z',
  });
  assert.equal(input.channel, 'stable');
  assert.equal(input.baseUrl, PUBLIC_BASE_URL);
  assert.equal(input.version, '1.2.3');
  assert.equal(input.fileManifestBytes, FILE_MANIFEST_BYTES);
  assert.equal(input.packagePath, paths.packagePath);
});

test('the stable input refuses to reuse an internal manifest', () => {
  assert.throws(
    () =>
      buildStableManifestInput({
        version: '1.2.3',
        minLauncherVersion: '1.0.0',
        fileManifest: FILE_MANIFEST,
        fileManifestBytes: FILE_MANIFEST_BYTES,
        packagePath: '/tmp/portable.zip',
        publishedAt: '2026-09-22T00:00:00.000Z',
        manifestBytes: Buffer.from('reuse-me'),
      }),
    /must be signed on its own/u,
  );
});
```

- [ ] **Step 2: 运行测试并确认按测试名失败**

```bash
node --test scripts/lib/feed-publish.test.mjs
```

预期：`buildStableManifestInput` 未定义。

- [ ] **Step 3: 写最小实现**

追加：

```js
export function buildStableManifestInput(input) {
  if (Object.hasOwn(input, 'manifestBytes')) {
    throw new FeedPublishError('the stable manifest must be signed on its own, never copied from the internal channel');
  }
  return {
    version: input.version,
    minLauncherVersion: input.minLauncherVersion,
    channel: 'stable',
    baseUrl: PUBLIC_BASE_URL,
    fileManifest: input.fileManifest,
    fileManifestBytes: input.fileManifestBytes,
    packagePath: input.packagePath,
    publishedAt: input.publishedAt,
  };
}
```

- [ ] **Step 4: 运行测试并确认通过**

```bash
node --test scripts/lib/feed-publish.test.mjs
```

预期：`fail 0`。

- [ ] **Step 5: 行为级变异验证**

1. 把 `channel: 'stable'` 改成 `input.channel` ⇒ 预期 `the stable manifest is re-signed with the stable channel and the stable url` **按测试名变红**。
2. 把 `manifestBytes` 守卫删掉 ⇒ 预期 `the stable input refuses to reuse an internal manifest` **按测试名变红**。

恢复后全绿且 `git diff` 为空。

- [ ] **Step 6: 提交**

```bash
git add scripts/lib/feed-publish.mjs scripts/lib/feed-publish.test.mjs
git commit -m "feat(feed): re-sign the manifest for the stable channel"
```

---

### Task 6: 真实 SSH / SFTP / https transport（**全部 async**）

**Files:**

- Create: `scripts/lib/feed-publish-transport.mjs`
- Test: `scripts/lib/feed-publish-transport.test.mjs`

**规格要求（§6.3、§6.4、§6.8）：** `ssh` / `sftp` 用**参数数组**调用，**禁止**拼接本地 shell 命令；强制 `BatchMode=yes`、`StrictHostKeyChecking=yes`、固定 `UserKnownHostsFile`；服务器、账号、指纹、凭据**一律不硬编码**。

- [ ] **Step 1: 写失败的测试（**async fake**）**

创建 `scripts/lib/feed-publish-transport.test.mjs`：

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { FeedTransportError, createFeedTransport, quoteBatchPath } from './feed-publish-transport.mjs';

const KNOWN_HOSTS = '/outside/repo/known_hosts';
const HOST = 'updates.example.invalid';

function makeFake({ status = 0, stdout = '', stderr = '', error = null } = {}) {
  const calls = [];
  const execFile = async (command, args, options) => {
    calls.push({ command, args, options });
    if (error !== null) return { status: -1, stdout: '', stderr: String(error.message ?? error) };
    return { status, stdout, stderr };
  };
  return { calls, execFile };
}

function makeTransport(overrides = {}) {
  return createFeedTransport({
    host: HOST,
    knownHostsPath: KNOWN_HOSTS,
    execFile: overrides.execFile,
    fetchPublic: overrides.fetchPublic,
    batchFile: overrides.batchFile ?? '/outside/repo/batch.txt',
    writeBatch: overrides.writeBatch,
  });
}

test('the batch path quoting refuses a carriage return, a newline and a nul byte', () => {
  for (const value of ['a\rb', 'a\nb', 'a\u0000b']) {
    assert.throws(() => quoteBatchPath(value), FeedTransportError);
  }
});

test('the batch path quoting wraps a path with spaces and escapes inner quotes', () => {
  assert.equal(quoteBatchPath('/opt/plain'), '/opt/plain');
  assert.equal(quoteBatchPath('C:/build dir/portable.zip'), '"C:/build dir/portable.zip"');
  assert.equal(quoteBatchPath('/opt/we"ird'), '"/opt/we\\"ird"');
});

test('every ssh call carries the pinned options as separate argv entries', async () => {
  const fake = makeFake({ stdout: 'ok' });
  const transport = makeTransport({ execFile: fake.execFile });
  const result = await transport.readOnly.sshRun({ script: 'ls /opt' });

  assert.equal(result.status, 0);
  const [call] = fake.calls;
  assert.equal(call.command, 'ssh');
  assert.ok(Array.isArray(call.args));
  assert.deepEqual(call.args.slice(0, 8), [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${KNOWN_HOSTS}`,
    '-o',
    'ConnectTimeout=15',
  ]);
  assert.equal(call.args.at(-2), HOST);
  assert.equal(call.args.at(-1), 'ls /opt');
  assert.equal(call.options.shell, undefined);
});

test('no ssh option ever relaxes host key checking', async () => {
  const fake = makeFake();
  await makeTransport({ execFile: fake.execFile }).readOnly.sshRun({ script: 'ls' });
  const joined = fake.calls[0].args.join(' ');
  assert.doesNotMatch(joined, /StrictHostKeyChecking=no/u);
  assert.doesNotMatch(joined, /accept-new/u);
  assert.doesNotMatch(joined, /UserKnownHostsFile=\/dev\/null/u);
});

test('a missing known hosts path is refused before any process starts', () => {
  const fake = makeFake();
  assert.throws(
    () => createFeedTransport({ host: HOST, knownHostsPath: '', execFile: fake.execFile }),
    FeedTransportError,
  );
  assert.deepEqual(fake.calls, []);
});

test('an sftp upload writes a quoted batch line and runs sftp with -b', async () => {
  const fake = makeFake();
  const batches = [];
  const transport = makeTransport({ execFile: fake.execFile, writeBatch: (text) => batches.push(text) });
  const result = await transport.write.sftpUpload({
    localPath: 'C:/build dir/portable.zip',
    remotePath: '/opt/rongying/updates-state/staging/internal/1.2.3/abc/portable.zip.part-r1',
    resume: true,
  });

  assert.equal(result.status, 0);
  assert.equal(batches.length, 1);
  assert.match(batches[0], /^reput "/u);
  assert.match(batches[0], /"C:\/build dir\/portable\.zip"/u);
  const [call] = fake.calls;
  assert.equal(call.command, 'sftp');
  assert.ok(call.args.includes('-b'));
  assert.ok(call.args.includes('BatchMode=yes'));
  assert.equal(call.options.shell, undefined);
});

test('a non resuming sftp upload uses put instead of reput', async () => {
  const batches = [];
  const transport = makeTransport({ execFile: makeFake().execFile, writeBatch: (text) => batches.push(text) });
  await transport.write.sftpUpload({ localPath: '/a', remotePath: '/b', resume: false });
  assert.match(batches[0], /^put /u);
});

test('an undefined exit status is reported as a failure rather than success', async () => {
  const fake = makeFake({ error: new Error('spawn ssh ENOENT') });
  const result = await makeTransport({ execFile: fake.execFile }).readOnly.sshRun({ script: 'ls' });
  assert.equal(result.status, -1);
  assert.match(result.stderr, /ENOENT/u);
});

test('the public fetcher returns the raw bytes as a byte array', async () => {
  const seen = [];
  const transport = makeTransport({
    fetchPublic: async (url) => {
      seen.push(url);
      return { status: 200, arrayBuffer: async () => new TextEncoder().encode('body-bytes').buffer };
    },
  });
  const result = await transport.fetchPublic('https://api.rongyinghudong.com/updates/internal/manifest.json');
  assert.equal(result.status, 200);
  assert.equal(Buffer.from(result.bodyBytes).toString('utf8'), 'body-bytes');
  assert.deepEqual(seen, ['https://api.rongyinghudong.com/updates/internal/manifest.json']);
});

test('the transport never builds a shell command string', async () => {
  const fake = makeFake();
  const transport = makeTransport({ execFile: fake.execFile, writeBatch: () => {} });
  await transport.readOnly.sshRun({ script: 'ls /opt' });
  await transport.write.sshRun({ script: 'rmdir /x' });
  await transport.write.sftpUpload({ localPath: '/a', remotePath: '/b', resume: false });
  for (const call of fake.calls) {
    assert.ok(Array.isArray(call.args));
    assert.equal(call.options.shell, undefined);
  }
});
```

- [ ] **Step 2: 运行测试并确认按测试名失败**

```bash
node --test scripts/lib/feed-publish-transport.test.mjs
```

预期：无法解析 `./feed-publish-transport.mjs`。

- [ ] **Step 3: 写最小实现**

创建 `scripts/lib/feed-publish-transport.mjs`：

```js
import { execFile as nodeExecFile } from 'node:child_process';

const SSH_TIMEOUT_MS = 60_000;
const SFTP_TIMEOUT_MS = 600_000;

export class FeedTransportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FeedTransportError';
  }
}

export function quoteBatchPath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new FeedTransportError('an sftp batch path is required');
  }
  if (/[\r\n\u0000]/u.test(value)) {
    throw new FeedTransportError('an sftp batch path must not contain a carriage return, a newline or a nul byte');
  }
  if (!/[\s"]/u.test(value)) return value;
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function pinnedOptions(knownHostsPath) {
  return [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${knownHostsPath}`,
    '-o',
    'ConnectTimeout=15',
  ];
}

export function createFeedTransport(input) {
  const host = input.host;
  const knownHostsPath = input.knownHostsPath;
  if (typeof host !== 'string' || host.length === 0) throw new FeedTransportError('the ssh host is required');
  if (typeof knownHostsPath !== 'string' || knownHostsPath.length === 0) {
    throw new FeedTransportError('the pinned known hosts file is required');
  }

  const runner =
    input.execFile ??
    ((command, args, options) =>
      new Promise((resolve) => {
        nodeExecFile(command, args, options, (error, stdout, stderr) => {
          if (error !== null && error !== undefined) {
            resolve({
              status: typeof error.code === 'number' ? error.code : -1,
              stdout: String(stdout ?? ''),
              stderr: String(stderr ?? error.message ?? ''),
            });
            return;
          }
          resolve({ status: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        });
      }));

  async function sshRun(request) {
    const result = await runner('ssh', [...pinnedOptions(knownHostsPath), host, request.script], {
      encoding: 'utf8',
      timeout: SSH_TIMEOUT_MS,
      windowsHide: true,
    });
    return {
      status: typeof result?.status === 'number' ? result.status : -1,
      stdout: result?.stdout ?? '',
      stderr: result?.stderr ?? '',
    };
  }

  async function sftpUpload(request) {
    const writeBatch = request.writeBatch ?? input.writeBatch;
    if (typeof writeBatch !== 'function') throw new FeedTransportError('the sftp batch writer is required');
    const batchFile = input.batchFile;
    if (typeof batchFile !== 'string' || batchFile.length === 0) {
      throw new FeedTransportError('the sftp batch file path is required');
    }
    const command = request.resume === true ? 'reput' : 'put';
    writeBatch(`${command} ${quoteBatchPath(request.localPath)} ${quoteBatchPath(request.remotePath)}\n`);
    const result = await runner('sftp', [...pinnedOptions(knownHostsPath), '-b', batchFile, host], {
      encoding: 'utf8',
      timeout: SFTP_TIMEOUT_MS,
      windowsHide: true,
    });
    return {
      status: typeof result?.status === 'number' ? result.status : -1,
      stdout: result?.stdout ?? '',
      stderr: result?.stderr ?? '',
    };
  }

  const publicFetch =
    input.fetchPublic ??
    (async (url) => {
      const response = await fetch(url, { redirect: 'error' });
      return { status: response.status, arrayBuffer: () => response.arrayBuffer() };
    });

  return {
    readOnly: { sshRun },
    write: { sshRun, sftpUpload },
    fetchPublic: async (url) => {
      const response = await publicFetch(url);
      if (typeof response?.arrayBuffer !== 'function') {
        return { status: response?.status ?? 0, bodyBytes: new Uint8Array() };
      }
      return { status: response.status, bodyBytes: new Uint8Array(await response.arrayBuffer()) };
    },
  };
}
```

**关键点（写进提交信息）：**

- 全部远端动作是 `execFile(command, argvArray, options)`，**没有 shell 字符串**，`options.shell` 从不设置。
- `BatchMode=yes` 让它**永不**交互提示；`StrictHostKeyChecking=yes` + 固定 `UserKnownHostsFile` 让它**永不**自动接受新指纹。
- `sftp -b <batchFile>` 批处理模式**不会**进入交互提示；`reput` 提供**可续传**（服务器没有 `rsync`，`scp` 不能续传）。
- **二进制一律用 `arrayBuffer()`**，不用 `text()`——ZIP 若用 `text()` 再拼回 Buffer 会损坏字节。
- `quoteBatchPath` 拒绝 CR/LF/NUL，并对含空格或引号的路径加引号与转义（Windows 构建机上的 `C:\build dir\...` 是常态）。
- `fetch` 用 `redirect: 'error'`：公网复验必须落在**本频道的确切 URL**。

- [ ] **Step 4: 运行测试并确认通过**

```bash
node --test scripts/lib/feed-publish-transport.test.mjs
```

预期：`fail 0`、`pass 11`。

- [ ] **Step 5: 行为级变异验证**

1. 把 `StrictHostKeyChecking=yes` 改成 `no` ⇒ 预期 `every ssh call carries the pinned options as separate argv entries` 与 `no ssh option ever relaxes host key checking` **按测试名变红**。
2. 把 `runner('ssh', [...], ...)` 改成拼字符串 + `shell: true` ⇒ 预期 `the transport never builds a shell command string` **按测试名变红**。
3. 把 `resume === true ? 'reput' : 'put'` 改成恒 `'put'` ⇒ 预期 `an sftp upload writes a quoted batch line and runs sftp with -b` **按测试名变红**。
4. 把 `quoteBatchPath` 的 CR/LF/NUL 检查删掉 ⇒ 预期 `the batch path quoting refuses a carriage return, a newline and a nul byte` **按测试名变红**。
5. 把 `quoteBatchPath` 的空格分支删掉 ⇒ 预期 `the batch path quoting wraps a path with spaces and escapes inner quotes` **按测试名变红**。
6. 把 `arrayBuffer()` 换成 `text()` 并 `Buffer.from(text, 'utf8')` ⇒ 预期 `the public fetcher returns the raw bytes as a byte array` **按测试名变红**。
7. 把 `typeof result?.status === 'number' ? result.status : -1` 改成直接用 `result.status` ⇒ 预期 `an undefined exit status is reported as a failure rather than success` **按测试名变红**。

恢复后全绿且 `git diff` 为空。

- [ ] **Step 6: 提交**

```bash
git add scripts/lib/feed-publish-transport.mjs scripts/lib/feed-publish-transport.test.mjs
git commit -m "feat(feed): add the async pinned ssh and sftp transport"
```

---

### Task 7: CLI（四种模式全接，顶层 await）

**Files:**

- Create: `scripts/feed-publish.mjs`
- Test: `scripts/lib/feed-publish-cli.test.mjs`
- Modify: `package.json`（只扩写 Task 1 Step 7 已新增的 `check:portable-feed-publish` 的值，不新增同名键）

- [ ] **Step 1: 写失败的测试**

创建 `scripts/lib/feed-publish-cli.test.mjs`：

```js
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(repositoryRoot, 'scripts', 'feed-publish.mjs');

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

test('the cli prints usage when no mode is given', () => {
  const result = runCli([]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /--dry-run/u);
  assert.match(result.stdout, /--preflight/u);
  assert.match(result.stdout, /--commit/u);
  assert.match(result.stdout, /--break-lock/u);
});

test('the cli rejects an unknown channel before touching anything', () => {
  const result = runCli(['--dry-run', '--channel', 'beta', '--version', '1.2.3']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /channel must be one of/u);
});

test('the cli refuses a network mode without a host or known hosts file', () => {
  const result = runCli(['--preflight', '--channel', 'internal', '--version', '1.2.3']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ssh host|known hosts/u);
});

test('the cli refuses a commit without an audit log path', () => {
  const result = runCli([
    '--commit',
    '--channel',
    'internal',
    '--version',
    '1.2.3',
    '--host',
    'h',
    '--known-hosts',
    'k',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--audit-out is required/u);
});

test('the cli refuses a known hosts file inside the repository', () => {
  const result = runCli([
    '--preflight',
    '--channel',
    'internal',
    '--version',
    '1.2.3',
    '--host',
    'h',
    '--known-hosts',
    join(repositoryRoot, 'known_hosts'),
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside the repository/u);
});

test('the cli refuses a break lock without a reason, an audit log or a confirmation', () => {
  const base = [
    '--break-lock',
    '--channel',
    'internal',
    '--version',
    '1.2.3',
    '--host',
    'h',
    '--known-hosts',
    '/outside/known_hosts',
  ];
  assert.match(runCli(base).stderr, /--reason is required/u);
  assert.match(runCli([...base, '--reason', 'stopped']).stderr, /--audit-out is required/u);
  assert.match(
    runCli([...base, '--reason', 'stopped', '--audit-out', 'x.jsonl']).stderr,
    /--confirm-runid is required/u,
  );
});
```

- [ ] **Step 2: 运行测试并确认按测试名失败**

```bash
node --test scripts/lib/feed-publish-cli.test.mjs
```

预期：CLI 文件不存在。

- [ ] **Step 3: 写最小实现**

创建 `scripts/feed-publish.mjs`：

```js
#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FeedPublishError,
  appendAuditStage,
  assertKnownHostsPath,
  breakChannelLock,
  parsePublishInput,
  planCommit,
  runCommit,
  runPreflight,
} from './lib/feed-publish.mjs';
import { createFeedTransport } from './lib/feed-publish-transport.mjs';
import { verifyPortableRelease } from './lib/portable-update-release.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = [
  'Usage: node scripts/feed-publish.mjs <--dry-run|--preflight|--commit|--break-lock> --channel <internal|stable> --version <x.y.z> [--host <host> --known-hosts <path>]',
  '  --dry-run       offline: validate the three artifacts and print the plan',
  '  --preflight     read only remote checks; never claims to have verified writability',
  '  --commit        publish; needs --package --file-manifest --manifest --audit-out',
  '  --break-lock    needs --reason --audit-out --confirm-runid',
  '  --known-hosts   the pinned known_hosts file, must live outside the repository',
].join('\n');

function flag(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : null;
}

function requirePublicKeyFromEnvironment() {
  const value = process.env.MOFANG_UPDATE_PUBLIC_KEY_B64;
  if (typeof value !== 'string' || value.length === 0) {
    throw new FeedPublishError('MOFANG_UPDATE_PUBLIC_KEY_B64 is required to verify the release manifest');
  }
  return value;
}

async function main(argv) {
  const mode = argv.includes('--commit')
    ? 'commit'
    : argv.includes('--preflight')
      ? 'preflight'
      : argv.includes('--break-lock')
        ? 'break-lock'
        : argv.includes('--dry-run')
          ? 'dry-run'
          : null;
  if (mode === null) {
    console.log(USAGE);
    return 2;
  }

  const channel = flag(argv, '--channel');
  const version = flag(argv, '--version');
  const host = flag(argv, '--host');
  const knownHostsPath = flag(argv, '--known-hosts');
  const auditOut = flag(argv, '--audit-out');
  const needsNetwork = mode !== 'dry-run';

  let input;
  try {
    input = parsePublishInput({ channel, version: version ?? '0.0.0', host, knownHostsPath, needsNetwork });
    if (input.knownHostsPath !== null) assertKnownHostsPath(input.knownHostsPath, repositoryRoot);
  } catch (error) {
    console.error(error instanceof FeedPublishError ? error.message : String(error));
    return 1;
  }

  if (mode === 'dry-run') {
    const packagePath = flag(argv, '--package');
    const fileManifestPath = flag(argv, '--file-manifest');
    const manifestPath = flag(argv, '--manifest');
    if (packagePath === null || fileManifestPath === null || manifestPath === null) {
      console.error('--package, --file-manifest and --manifest are required');
      return 1;
    }
    try {
      const plan = await planCommit({
        channel: input.channel,
        version: input.version,
        packagePath: resolve(packagePath),
        fileManifestPath: resolve(fileManifestPath),
        manifestPath: resolve(manifestPath),
        publicKeyBase64: requirePublicKeyFromEnvironment(),
      });
      console.log(JSON.stringify({ mode, channel: input.channel, version: input.version, plan }, null, 2));
      console.log('dry run: nothing was written, and no permission, remote directory or host key was verified');
      return 0;
    } catch (error) {
      console.error(error instanceof FeedPublishError ? error.message : String(error));
      return 1;
    }
  }

  const batchRoot = mkdtempSync(join(tmpdir(), 'mofang-feed-batch-'));
  const batchFile = join(batchRoot, 'sftp-batch.txt');
  const transport = createFeedTransport({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    batchFile,
    writeBatch: (text) => writeFileSync(batchFile, text, { encoding: 'utf8', flag: 'a' }),
  });

  try {
    if (mode === 'preflight') {
      const result = await runPreflight({
        channel: input.channel,
        version: input.version,
        transport,
        host: input.host,
        knownHostsPath: input.knownHostsPath,
      });
      console.log(JSON.stringify(result, null, 2));
      return result.notes.length === 0 ? 0 : 1;
    }

    if (mode === 'break-lock') {
      const reason = flag(argv, '--reason');
      const confirmRunid = flag(argv, '--confirm-runid');
      if (reason === null) {
        console.error('--reason is required');
        return 1;
      }
      if (auditOut === null) {
        console.error('--audit-out is required');
        return 1;
      }
      if (confirmRunid === null) {
        console.error('--confirm-runid is required');
        return 1;
      }
      const record = await breakChannelLock({
        channel: input.channel,
        transport,
        host: input.host,
        knownHostsPath: input.knownHostsPath,
        reason,
        confirmRunid,
        auditOut,
        operator: process.env.MOFANG_FEED_OPERATOR ?? 'unknown',
      });
      appendAuditStage({ auditOut, repositoryRoot, entry: { stage: 'break-lock', ...record } });
      console.log(JSON.stringify(record, null, 2));
      return 0;
    }

    const packagePath = flag(argv, '--package');
    const fileManifestPath = flag(argv, '--file-manifest');
    const manifestPath = flag(argv, '--manifest');
    if (packagePath === null || fileManifestPath === null || manifestPath === null) {
      console.error('--package, --file-manifest and --manifest are required');
      return 1;
    }
    if (auditOut === null) {
      console.error('--audit-out is required');
      return 1;
    }

    const publicKeyBase64 = requirePublicKeyFromEnvironment();
    const resolvedManifestPath = resolve(manifestPath);
    const resolvedFileManifestPath = resolve(fileManifestPath);
    const resolvedPackagePath = resolve(packagePath);
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'mofang-feed-public-'));

    try {
      const result = await runCommit({
        channel: input.channel,
        version: input.version,
        host: input.host,
        knownHostsPath: input.knownHostsPath,
        runid: randomUUID(),
        packagePath: resolvedPackagePath,
        fileManifestPath: resolvedFileManifestPath,
        manifestPath: resolvedManifestPath,
        auditOut,
        repositoryRoot,
        temporaryRoot,
        transport,
        publicKeyBase64,
        verifySignature: ({ manifestBytes, fileManifestBytes, packagePath }) =>
          verifyPortableRelease({ manifestBytes, fileManifestBytes, packagePath, publicKeyBase64 }),
        verifier: ({ manifestBytes, fileManifestBytes, packagePath }) =>
          verifyPortableRelease({ manifestBytes, fileManifestBytes, packagePath, publicKeyBase64 }),
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.outcome === 'done') return 0;
      if (result.outcome === 'retry') return 3;
      return 1;
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(batchRoot, { recursive: true, force: true });
  }
}

await main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
```

**必须遵守：** 顶层 `await`，只用 `process.exitCode`，**不得**在 Promise 完成前 `process.exit`；batch 文件是**仓库外唯一临时文件**（`mkdtempSync`），并在 `finally` 清理，因此并发运行不会互相覆盖；`--break-lock` 的 `--reason` / `--audit-out` / `--confirm-runid` **三角都必填**。

- [ ] **Step 4: 运行测试并确认通过**

```bash
node --test scripts/lib/feed-publish-cli.test.mjs
```

预期：`fail 0`、`pass 6`。

- [ ] **Step 5: 行为级变异验证**

1. 把 `--reason` 守卫删掉 ⇒ 预期 `the cli refuses a break lock without a reason, an audit log or a confirmation` **按测试名变红**。
2. 把 `--confirm-runid` 守卫删掉 ⇒ 同一条 **按测试名变红**。
3. 把 `--audit-out` 守卫（commit 分支）删掉 ⇒ 预期 `the cli refuses a commit without an audit log path` **按测试名变红**。
4. 把 `needsNetwork` 恒设为 `false` ⇒ 预期 `the cli refuses a network mode without a host or known hosts file` **按测试名变红**。
5. 把 `assertKnownHostsPath` 调用删掉 ⇒ 预期 `the cli refuses a known hosts file inside the repository` **按测试名变红**。
6. 把顶层 `await main(...)` 改成 `main(...); process.exit(0)` ⇒ 预期 6 条 CLI 守卫测试**全部按测试名变红**（进程在 Promise 完成前退出，拿不到 stderr 与退出码）。

恢复后全绿且 `git diff` 为空。

- [ ] **Step 6: 扩写门禁命令**

Task 1 Step 7 已经新增了 `check:portable-feed-publish`（当时只列 `scripts/lib/feed-publish.test.mjs` 一个文件）。本步**只改写这个键的值**，把它扩成三个文件；键名与它在 `check` 链里的位置都不动，**不得**再新增第二条同名脚本、也不得改插入点：

```json
"check:portable-feed-publish": "node --test scripts/lib/feed-publish.test.mjs scripts/lib/feed-publish-transport.test.mjs scripts/lib/feed-publish-cli.test.mjs"
```

新增的两个文件到这一步才存在，所以 Task 1 Step 7 列不上它们：`scripts/lib/feed-publish-transport.test.mjs` 是 Task 6 的产物，`scripts/lib/feed-publish-cli.test.mjs` 是本 Task 的产物。

- [ ] **Step 7: 提交**

```bash
git add scripts/feed-publish.mjs scripts/lib/feed-publish-cli.test.mjs package.json
git commit -m "feat(feed): wire all four cli modes to the real transport"
```

**验收项（签名闸门真的在工作）**：`verifyPortableRelease` 是 **async** 的，注入后必须确认 `verifyLocalArtifacts` 与 `verifyPublicArtifacts` 都 **await** 了它。证明方式不是读代码，而是：注入一个**永远拒绝**的 verifier，确认 `--dry-run` 以 `pre-verify: fail` 收口（而不是未处理的 Promise 拒绝）；再把 `await` 删掉，确认同一条路径**变绿** —— 那就说明闸门是假的。

---

### Task 8: 手册、nginx 与发布前检查单

**Files:**

- Modify: `docs/runbooks/portable-update-release.md`

**不得**写入任何真实 host-key 指纹或服务器凭据。

- [ ] **Step 1: 改写第 7、9、10 步为上传器调用**

````markdown
### 7. 发布到测试频道

此步需要单独的「测试更新源发布」授权。用经过复核的上传器执行，**不要现场拼 `scp` 命令**：

```powershell
node scripts/feed-publish.mjs --dry-run --channel internal --version <版本> --package <portable.zip> --file-manifest <portable-files.json> --manifest <manifest.json>
node scripts/feed-publish.mjs --preflight --channel internal --version <版本> --host <主机> --known-hosts <仓库外的 known_hosts 路径>
node scripts/feed-publish.mjs --commit --channel internal --version <版本> --host <主机> --known-hosts <仓库外的 known_hosts 路径> --package <portable.zip> --file-manifest <portable-files.json> --manifest <manifest.json> --audit-out <仓库外的审计日志路径>
```

退出码：`0` 完成；`3` 可重跑（翻转未生效）；`1` 失败或事故。**任何非 `0` 都要先读审计日志。**

上传器固定执行十三步，**不得调换**：本地预验证 → stage（建 staging 目录 + 续传上传 + 远端改名）→ 远端复核 → 取频道锁 → 锁内重新核验 → 原子提交版本目录（**单次目录 rename**）→ 备份旧 manifest → CAS → **SFTP 上传临时 manifest 并核对远端摘要** → 原子翻转 → 公网复验 → 逐阶段审计 → 释放锁。

- 本地预验证**先于任何网络写**；任一项不过就一个字节都不写。
- `--dry-run` 完全离线，**不需要** `--host` / `--known-hosts`，只校验三个本地产物。
- `--preflight` 只读，只能给出**可写性指标**；真正的写入能力到 stage 阶段才被证明。
- 版本目录**不可变**；已存在且逐字节一致才可复用，**存在但为空视为不完整并拒绝**。
- **CAS 不匹配是完整性事故**：收口为 `incident` 并**保留锁**，不自动翻转、不自动回滚、不自动删除，人工核查后走显式恢复。

### 7b. 卡住时怎么恢复

锁是**目录 + `owner.json`**，不是裸目录。恢复必须先读 owner，再显式确认：

```powershell
node scripts/feed-publish.mjs --break-lock --channel <频道> --version <版本> --host <主机> --known-hosts <路径> --reason "<为什么可以安全破除>" --confirm-runid <审计日志里那条 owner 的 runid> --audit-out <审计日志路径>
```

`--confirm-runid` 必须与远端 owner 的 `runid` **完全一致**，否则立即拒绝；破除结果与真实 `previousOwner`、操作者都会写进审计日志。**删除失败不会记成 `lock-broken`。**

### 9. 复制不可变制品到正式位置

此步需要单独的「正式更新源发布」授权。`stable` **只能复用** `portable.zip` 与 `portable-files.json` 的**原字节**；**`stable` 的 manifest 必须单独离线签名**（`channel: stable` 与 stable 的 `packageUrl`），禁止改字段复用 internal 的 manifest——签名覆盖 `channel` 与 `packageUrl`。

### 10. 最后更新正式签名 manifest

用同一上传器 `--channel stable` 执行同样的十三步。翻转后必须完成公网复验：重新取回 manifest **原始字节**、验签、比对 `channel` / `version` / `packageUrl`（**完整 origin**）以及两个产物的 SHA-256 与大小。
````

- [ ] **Step 2: 追加 nginx 与发布前检查单**

在「立即停止条件」之前插入：

```markdown
## nginx 与权限

- 新 manifest 位于 `/updates/<channel>/manifest.json`，**不继承** `= /updates/latest.yml` 的 `no-cache`。客户端是 Electron 主进程的全局 `fetch`（undici，无隐式 HTTP 缓存），当前风险低。**建议**追加 `location ~ ^/updates/(internal|stable)/manifest\.json$ { add_header Cache-Control "no-cache" always; }`。
- 生产**应当使用受限发布账号**：对版本目录可写、manifest 单独一步可换、不能改动其他内容。
- **当前是显式例外**：`/opt/rongying/updates` 与 `/opt/rongying/backups` 均为 `root:root 755`，首次发布将**临时使用 root**。残留风险：root 一旦被脚本缺陷或误用影响，可改动服务器上任意文件；审计**只能事后发现**。建立受限账号属后续加固。

## 发布前检查单

- [ ] `docs/portable-update-key-registry.md` 的 host-key 指纹已由用户或授权运维人员经**可信带外渠道**核对，并写明核对方式。
- [ ] 上传器使用**仓库外** known_hosts，`BatchMode=yes` 与 `StrictHostKeyChecking=yes` 生效。
- [ ] 三个产物的本地 SHA-256 与大小已记录，且与待发 manifest 逐项一致。
- [ ] 启动器身份挑战（第 6b 步）三条全部通过，读数已归档为**发布期 QC 证据**。
- [ ] `--audit-out` 指向**仓库外**；审计日志含 `open` … `unlock` 的**逐阶段**记录。
- [ ] 已保留上一版 `manifest.json`、`portable-files.json` 与 `portable.zip` 作为回滚材料。
- [ ] 已确认「回滚只能拦住还没升级的客户端」——已升级的客户端**不会**降级，真降级必须另开事故流程。
```

- [ ] **Step 3: 格式与自检**

```bash
./node_modules/.bin/prettier --write docs/runbooks/portable-update-release.md
./node_modules/.bin/prettier --check docs/runbooks/portable-update-release.md
git diff --check
grep -nE "[0-9A-F]{32,}" docs/runbooks/portable-update-release.md || echo "no concrete fingerprints in the runbook"
```

⚠️ prettier 会重排有序列表：`--write` 之后**必须重读**小节的步骤编号（第 1–11 步），确认没有被打乱；若被打乱，改用 `--check` 只报告不修改并手工修正格式。

- [ ] **Step 4: 提交**

```bash
git add docs/runbooks/portable-update-release.md
git commit -m "docs(release): route the feed publishing steps through the uploader"
```

---

## 完整门禁与验收

每个 Task 后运行 `pnpm check`，预期 `exit 0`。失败时按门禁分段处理：`check:portable-launcher`、`check:portable-update-release`、`check:portable-release-assembly`、`check:portable-feed-publish`、`check:udisk-delivery`、`lint`、`typecheck`、`typecheck:tests`、`format:check`、`check:dead-code`、`test`。

**追踪表自审（每个 Task 完成后做一次）：** 对照上面那张 13 步表，逐行确认——①该行在 `runCommit` 里有对应代码；②该行的远端动作确实 `await` 了；③该行声称检查的退出码**真的被检查**；④该行的审计阶段名与 `appendAuditStage` 的字符串一致；⑤该行的失败结果与该行的锁状态一致。**任何一条对不上就是缺陷，不得放过。**

**验收读数（逐条如实填写，未执行的写“未验证”）：**

| 项                                | 命令                                                                | 读数 |
| --------------------------------- | ------------------------------------------------------------------- | ---- |
| 上传器逻辑（含 13 步 happy path） | `node --test scripts/lib/feed-publish.test.mjs`                     | 待填 |
| 真实 transport（async）           | `node --test scripts/lib/feed-publish-transport.test.mjs`           | 待填 |
| CLI 守卫                          | `node --test scripts/lib/feed-publish-cli.test.mjs`                 | 待填 |
| 未联网取证                        | transport 测试全部走注入的**异步**假 `execFile` / `fetchPublic`     | 待填 |
| 没有占位分支                      | `grep -n "not wired" scripts/feed-publish.mjs`（预期无输出）        | 待填 |
| 追踪表逐行核对                    | 13 行全部对得上（见上方自审清单）                                   | 待填 |
| 手册无真实指纹                    | `grep -nE "[0-9A-F]{32,}" docs/runbooks/portable-update-release.md` | 待填 |
| 全量门禁                          | `pnpm check`                                                        | 待填 |

## 未覆盖与后续（不得写成已完成）

- **真实网络路径未自动化验证**：transport 与 CLI 都已接上真实 `ssh` / `sftp` / `https`，但**自动测试只覆盖参数守卫与假 transport**。真实路径必须在真机发布演练中验收，并**由用户先提供主机与经带外核对的 host-key 指纹**。
- **没有上传任何 feed**：没有测试 feed，没有生产 feed，没有改线上 manifest，没有连接或修改服务器。
- **受限发布账号未建立**：当前接受"首次临时使用 root"这一显式例外。
- nginx 的 `no-cache` 建议**未应用**：需要授权后改服务器配置。
- `--break-lock` 的真实远端路径同样未自动化验证；它走的是同一条 transport 与同一个 `breakChannelLock`。

相关：`docs/superpowers/specs/2026-09-22-portable-release-infrastructure-correction-design.md`
