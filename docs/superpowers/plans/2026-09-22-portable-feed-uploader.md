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

| #   | 阶段              | 输入                                                   | 本地/远端动作                                                                                       | await                | 检查退出码               | 审计阶段名                                                               | 失败结果                                           | 锁状态                                                                          |
| --- | ----------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | -------------------- | ------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | `pre-verify`      | 三个本地产物路径、`expectedChannel`、`expectedVersion` | 本地：读三产物、验签、比对 channel/version/URL/hash/size                                            | 是（await verifier） | —                        | `pre-verify`                                                             | `fail`                                             | `not-acquired`                                                                  |
| 2   | `stage`           | `planHash`、staging 路径                               | 远端：`mkdir -p <staging>` → SFTP `reput` 两个 `.part-<runid>` → 远端 `mv -f` 成最终名              | 是                   | **是**（每个写操作都查） | `stage`                                                                  | `fail`                                             | `not-acquired`                                                                  |
| 3   | `remote-verify`   | staging 目录                                           | 远端：`find -printf` + `sha256sum`                                                                  | 是                   | **是**                   | `remote-verify`                                                          | `fail`                                             | `not-acquired`                                                                  |
| 4   | `lock`            | `channel`、`runid`、`planHash`                         | 远端：`mkdir <lock>`，成功后写 `owner.json`                                                         | 是                   | **是**（两条都查）       | `lock`                                                                   | 已存在 ⇒ `blocked`；不确定 ⇒ `incident`            | `not-acquired` / `ownership-unknown`                                            |
| 5   | `re-verify`       | 锁内                                                   | 本地：重读 `owner.json`；远端：读 manifest baseline、重探 staging                                   | 是                   | **是**                   | `re-verify`                                                              | `incident`                                         | `retained-by-this-run`                                                          |
| 6   | `commit-version`  | staging 与最终目录                                     | 远端：`stat -c %d` 比设备号；不存在则**单次目录 `mv`**；存在则整体比对                              | 是                   | **是**                   | `commit-version`                                                         | `fail`                                             | `released`                                                                      |
| 7   | `backup-manifest` | 旧 manifest                                            | 远端：`cp` 到备份路径                                                                               | 是                   | **是**                   | `backup-manifest`                                                        | `incident`                                         | `retained-by-this-run`                                                          |
| 8   | `cas`             | baseline                                               | 远端：重读 manifest SHA                                                                             | 是                   | **是**                   | `cas`                                                                    | 不匹配 ⇒ `incident`                                | `retained-by-this-run`                                                          |
| 9   | `temp-manifest`   | 本地 `manifest.json`                                   | **SFTP 上传**到正式 manifest **同目录**的 `<runid>.tmp`；远端重算 SHA 必须等于本地 `manifestSha256` | 是                   | **是**                   | `temp-manifest`                                                          | `incident`                                         | `retained-by-this-run`                                                          |
| 10  | `flip`            | 临时 manifest                                          | 远端：单次 `mv -f`                                                                                  | 是                   | **是**                   | `flip`                                                                   | `incident`                                         | `retained-by-this-run`                                                          |
| 11  | `public-verify`   | 公网                                                   | 公网：取回 manifest + 两个产物，验签、比 SHA/size/URL；三分                                         | 是                   | **是**                   | `public-verify`                                                          | 新 SHA ⇒ 继续；旧 SHA ⇒ `retry`；其它 ⇒ `incident` | `retained-by-this-run`                                                          |
| 12  | 收口              | —                                                      | 本地：写结果条目 `done` / `retry` / `fail` / `blocked` / `incident`                                 | 否（同步追加）       | —                        | `reveal`（与 `PUBLISH_STAGES` 第 12 项一致；该条目的 status 取结果本身） | —                                                  | 该条目里**不含**锁状态；锁状态由紧随其后的 `unlock` 或 `lock-retained` 条目承载 |
| 13  | `unlock`          | `owner.json`                                           | 远端：重读 owner → `rm owner.json` → `rmdir lock`                                                   | 是                   | **是**                   | `unlock`                                                                 | 任一失败 ⇒ **不得报告 `released`**                 | `released` / `retained-by-this-run`                                             |

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

**每个新增的守卫与接线都必须有一条测试单独钉住它**，并在同一刀的变异清单里有一条**会按测试名变红**的变异证明它是必要的 —— 尤其是“把参数/回调往下传”这类透传（断了不会报错，只会静默失效）。变异记录的措辞必须**无歧义**：同一段代码有两个 `await` 就写成两条，否则实施者删错一处会得到“变异存活”的假读数，进而误以为护栏有效。

**复核纪律（拿"规定文本"的方式）：** 复核者手里的那份**规定文本**必须取自**被复核提交的父提交**（`git show <base>:<plan-file>`），**绝不能用 HEAD 的那份** —— 实施者会改计划（本刀的所有"实现偏离"就是这么改的），所以 HEAD 的那份已经**悄悄变成了对实现的描述**，拿它去比对等于拿实现给自己的自我描述去验收实现，什么都验不出来。缺的正是"独立规格"这四个字。

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
import { join, resolve } from 'node:path';
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

const HOST = 'publish.example.invalid';
const KNOWN_HOSTS_PATH = '/etc/mofang/known_hosts';

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

test('a host that ssh would read as an option is rejected', () => {
  assert.throws(
    () =>
      parsePublishInput({
        channel: 'internal',
        version: '1.2.3',
        needsNetwork: true,
        host: '-oProxyCommand=x',
        knownHostsPath: '/tmp/known_hosts',
      }),
    /must not start with a dash/u,
  );
});

test('a host containing whitespace is rejected', () => {
  assert.throws(
    () =>
      parsePublishInput({
        channel: 'internal',
        version: '1.2.3',
        needsNetwork: true,
        host: 'bad host',
        knownHostsPath: '/tmp/known_hosts',
      }),
    /contain whitespace/u,
  );
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

test('the local verification hands the verifier bytes rather than paths', async () => {
  const paths = writeArtifacts();
  const received = [];
  await verifyLocalArtifacts({
    ...paths,
    expectedChannel: 'internal',
    expectedVersion: '1.2.3',
    publicKeyBase64: PUBLIC_KEY_BASE64,
    verifySignature: async (context) => {
      received.push(context);
    },
  });
  assert.equal(received.length, 1);
  const [context] = received;
  assert.deepEqual(Object.keys(context).sort(), [
    'fileManifestBytes',
    'manifestBytes',
    'packagePath',
    'publicKeyBase64',
  ]);
  assert.ok(Buffer.isBuffer(context.manifestBytes));
  assert.ok(Buffer.isBuffer(context.fileManifestBytes));
  assert.ok(context.fileManifestBytes.equals(FILE_MANIFEST_BYTES));
  assert.ok(context.manifestBytes.equals(readFileSync(paths.manifestPath)));
  assert.equal(context.packagePath, paths.packagePath);
  assert.equal(context.publicKeyBase64, PUBLIC_KEY_BASE64);
});

test('a well formed network input keeps its host and resolves the known hosts path', () => {
  const parsed = parsePublishInput({
    channel: 'internal',
    version: '1.2.3',
    needsNetwork: true,
    host: 'release.example.com',
    knownHostsPath: '/tmp/known_hosts',
  });
  assert.equal(parsed.host, 'release.example.com');
  assert.equal(parsed.knownHostsPath, resolve('/tmp/known_hosts'));
});

test('the known hosts guard is insensitive to case on windows', { skip: process.platform !== 'win32' }, (t) => {
  const root = process.cwd();
  if (root.toUpperCase() === root) {
    t.skip('the working directory has no lowercase letters to vary');
    return;
  }
  assert.throws(
    () => assertKnownHostsPath(join(root, 'known_hosts').toUpperCase(), root),
    /must live outside the repository/u,
  );
});

test('a manifest that is not a JSON object is rejected', async () => {
  const paths = writeArtifacts({ manifestBytes: Buffer.from('null', 'utf8') });
  await assert.rejects(
    verifyLocalArtifacts({
      ...paths,
      expectedChannel: 'internal',
      expectedVersion: '1.2.3',
      publicKeyBase64: PUBLIC_KEY_BASE64,
    }),
    /is not a JSON object/u,
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
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new FeedPublishError('the release manifest is not a JSON object');
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

**URL 检查是 origin 级**：`protocol` + `origin` + `pathname` + 无 query / fragment / userinfo。只比 `pathname` 会放过别的域名与 `user:pass@`。**验签是 async 的**：`verifyLocalArtifacts` 因此是 `async`，调用方必须 `await`；漏掉 `await` 会让拒绝变成未处理的 Promise 拒绝，而函数照常返回成功 —— 那等于这道闸门不存在。**产物在这里哈希一次、又在注入的验证器内部再哈希一次，是刻意的**：本地这道闸门必须能独立成立（不依赖验证器是否真读了文件、也不依赖验证器是否被注入），验证器里的第二次校验是它自己的一部分；不要为了"省一次哈希"把那一次删掉。同理，验证器收到的是**字节**而不是路径 —— 收到路径的验证器可以绕开本次运行已经读过的那些字节，`fileManifestBytes` 一旦换回 `fileManifestPath`，本地产物与签名就不再绑定在同一份字节上。

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
8. 把 `raw.host.startsWith('-')` 判断删掉 ⇒ 预期 `a host that ssh would read as an option is rejected` **按测试名变红**。
9. 把 `/\s/u.test(raw.host)` 判断删掉 ⇒ 预期 `a host containing whitespace is rejected` **按测试名变红**。
   （8 与 9 的夹具必须互斥：dash 那条**不含空白**（`-oProxyCommand=x`）、空白那条**不以 dash 开头**（`bad host`）。否则一个条件会替另一个兜底，单独删掉任一个都不会红 —— 那正是这个文件里刚修过的假绿形状。）
10. 把 verifier 上下文的 `fileManifestBytes` 换回 `fileManifestPath: input.fileManifestPath` ⇒ 预期 `the local verification hands the verifier bytes rather than paths` **按测试名变红**。**这条是回滚上一轮 Critical 修复的等价变异**：在补上这条测试**之前**它不会红（当时没有任何测试断言过 verifier 收到了什么）；**现在必须红**。
11. 把 `assertKnownHostsPath` 换回 `startsWith`/`sep` 形式 ⇒ 预期 `the known hosts guard is insensitive to case on windows` **按测试名变红**（非 Windows 平台上该测试被 skip ⇒ 记「未验证」，不得记「通过」）。**这条测试还会在运行时自跳**：判据是 `process.cwd().toUpperCase() === process.cwd()`（**不是**拿 `join(cwd, 'known_hosts')` 去比 —— `'known_hosts'` 字面量本身是小写，那样比**永远不会成立**，等于没有自跳；实测过：`C:\UPPERCASEPROBE` 下两种守卫都判「拒绝」⇒ 读数一样 ⇒ 假绿照旧）。命中的环境只能报 `the working directory has no lowercase letters to vary` ⇒ 此时本变异**必须记「未验证」，绝不能记「通过」** —— 那是这个文件里刚抓到的假绿形状：工作目录本身不含小写字母时，**修复前的守卫也一样会拒**，于是测试在缺陷仍在时保持全绿。
12. 把 host 判断整体换成 `if (true)`（拒绝一切 host）⇒ 预期 `a well formed network input keeps its host and resolves the known hosts path` **按测试名变红**。（这条会连带红三条：预测的那条，外加 host 守卫的两条 —— 全部 host 都被拒了，所以那两条收到的报错文案也不对。**连带红是良性方向**：这份清单要防的是"红得太少"（那才是假绿），多红不会掩盖缺失的钉子。）
13. 把非对象 manifest 的守卫删掉 ⇒ 预期 `a manifest that is not a JSON object is rejected` **按测试名变红**。

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
        calls.push(['sshRun', request.script, request]);
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

function assertEveryCallCarriesTheTrustAnchor(calls) {
  assert.ok(calls.length > 0, 'the trust anchor assertion needs at least one recorded call');
  for (const call of calls) {
    const request = call[2];
    assert.ok(request !== undefined, `the ${String(call[0])} call did not record its request`);
    assert.equal(request.host, HOST, `the ${String(call[0])} call did not carry the pinned host`);
    assert.equal(
      request.knownHostsPath,
      KNOWN_HOSTS_PATH,
      `the ${String(call[0])} call did not carry the pinned known hosts file`,
    );
  }
}

test('the anchor helper refuses an empty call list rather than passing on zero calls', () => {
  assert.throws(() => assertEveryCallCarriesTheTrustAnchor([]));
});

async function preflightWithProbe(probe) {
  const transport = fakeReadOnlyTransport({ sshRun: () => probe });
  const result = await runPreflight({
    channel: 'internal',
    version: '1.2.3',
    transport,
    host: HOST,
    knownHostsPath: KNOWN_HOSTS_PATH,
  });
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
  return result;
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
  assert.ok(Object.isFrozen(PUBLISH_STAGES));
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
  assert.equal(plan.length, PUBLISH_STAGES.length);
  assert.ok(plan.every((entry) => entry.status === 'pending'));
});

test('the dry run follows the channel and the version it was given instead of a default', async () => {
  const paths = writeArtifacts({
    manifestOverrides: {
      channel: 'stable',
      version: '1.2.4',
      packageUrl: `${PUBLIC_BASE_URL}/stable/1.2.4/portable.zip`,
    },
  });
  const plan = await planCommit({
    channel: 'stable',
    version: '1.2.4',
    ...paths,
    publicKeyBase64: PUBLIC_KEY_BASE64,
  });
  assert.equal(plan.length, PUBLISH_STAGES.length);
});

test('the dry run propagates a local verification failure instead of printing a plan', async () => {
  const paths = writeArtifacts({ packageBytes: Buffer.from('tampered', 'utf8') });
  await assert.rejects(
    planCommit({ channel: 'internal', version: '1.2.3', ...paths, publicKeyBase64: PUBLIC_KEY_BASE64 }),
    /package integrity/u,
  );
});

test('the dry run passes the signature verifier through to the local verification', async () => {
  const paths = writeArtifacts();
  await assert.rejects(
    planCommit({
      channel: 'internal',
      version: '1.2.3',
      ...paths,
      publicKeyBase64: PUBLIC_KEY_BASE64,
      verifySignature: async () => {
        throw new Error('signature rejected through the dry run');
      },
    }),
    /signature rejected through the dry run/u,
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
    host: HOST,
    knownHostsPath: KNOWN_HOSTS_PATH,
  });
  const names = transport.calls.map((call) => call[0]);
  assert.deepEqual([...new Set(names)], ['sshRun']);
  assert.equal(transport.calls[0][1], `stat -c '%d' ${STATE_ROOT} ${UPDATE_ROOT}`);
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
  assert.equal(result.sameFileSystem, true);
  assert.equal(result.writabilityIndicators.verifiedWrite, false);
  assert.match(result.writabilityIndicators.note, /indicator/u);
});

test('the preflight reports different file systems instead of assuming one', async () => {
  const transport = fakeReadOnlyTransport({ sshRun: () => ({ status: 0, stdout: '100\n200\n', stderr: '' }) });
  const result = await runPreflight({
    channel: 'internal',
    version: '1.2.3',
    transport,
    host: HOST,
    knownHostsPath: KNOWN_HOSTS_PATH,
  });
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
  assert.equal(result.sameFileSystem, false);
  assert.match(result.notes.join(' '), /file system/u);

  const empty = await preflightWithProbe({ status: 0, stdout: '', stderr: '' });
  assert.equal(empty.sameFileSystem, false);
  assert.match(empty.notes.join(' '), /file system/u);

  const single = await preflightWithProbe({ status: 0, stdout: '5\n', stderr: '' });
  assert.equal(single.sameFileSystem, false);
});

test('the preflight records a failed probe instead of reporting all clear', async () => {
  const failed = await preflightWithProbe({ status: 1, stdout: '5\n5\n', stderr: 'stat: cannot statx' });
  assert.equal(failed.sameFileSystem, true);
  assert.match(failed.notes.join(' '), /did not succeed/u);
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
6. 把 `runPreflight` **函数内部**的 `await`（`const probe = await input.transport.readOnly.sshRun(...)`）删掉 ⇒ 预期 `the preflight only performs read only actions and never claims writability` **按测试名变红**：`probe` 变成 Promise、`devices` 变空 ⇒ `sameFileSystem` 变 `false`，而该测试断言它必须是 `true`。
7. 把**测试调用处**的 `await runPreflight(` 删掉（拿 Promise 当结果比较） ⇒ 预期 `the preflight reports different file systems instead of assuming one` **按测试名变红**。
   （6 与 7 是两处不同的 `await`。原文只写"`runPreflight` 的 `await`"，实测删函数内部那处时**什么都不红** —— 一条会让人误判"变异存活"的记录。）
8. 把 `planCommit` 里的 `verifySignature: input.verifySignature` **透传**删掉 ⇒ 预期 `the dry run passes the signature verifier through to the local verification` **按测试名变红**。**这条防的是静默旁路**：透传一断，Task 7 注入的真验证器永远不会被调用，而 `--dry-run` 照样报到"计划已生成"。
9. 把 `runPreflight` 的 `devices.length === 2` 删掉（只留 `devices[0] === devices[1]`）⇒ 预期 `the preflight reports different file systems instead of assuming one` **按测试名变红**：探测输出为空时两个 `undefined` 相等 ⇒ `sameFileSystem` 变成 `true`、`notes` 变成空数组，Task 7 据此退 **0**（"探测失败"被读成"一切正常"）。
10. 把 `if (probe.status !== 0) notes.push('the read only probe did not succeed');` **整行**删掉 ⇒ 预期 `the preflight records a failed probe instead of reporting all clear` **按测试名变红**：`{status: 1, stdout: '5\n5\n'}` 会给出 `sameFileSystem: true` 与空 `notes`，任务 7 退 **0**。
11. 把探测脚本里的 `${STATE_ROOT}` 换成 `${UPDATE_ROOT}`（即 `` `stat -c '%d' ${UPDATE_ROOT} ${UPDATE_ROOT}` ``）⇒ 预期 `the preflight only performs read only actions and never claims writability` **按测试名变红**：两个根被换成同一个根，`sameFileSystem` 永远为真而没人发现。
12. 把 `PUBLISH_STAGES` 的 `Object.freeze(...)` 删掉（只留数组字面量）⇒ 预期 `the commit plan lists the thirteen stages in the fixed order` **按测试名变红**。
13. 把 `planCommit` 里的 `expectedChannel: input.channel` 写成字面量 `'internal'`（或把 `expectedVersion: input.version` 写成字面量 `'1.2.3'`）⇒ 预期 `the dry run follows the channel and the version it was given instead of a default` **按测试名变红**：夹具是 `stable` / `1.2.4`，写死默认值就再也验不过 —— 这条专门证明"频道与版本是从参数接进去的"，因为其余用例全走默认值，写死也能全绿。
14. 把 `planCommit` 传给 `verifyLocalArtifacts` 的三个路径接错任一个（例如 `manifestPath: input.fileManifestPath`）⇒ 预期 `the dry run validates the triple and prints the plan without any transport` 与 `the dry run follows the channel and the version it was given instead of a default` **按测试名变红**。
15. 把 `planCommit` 返回的计划里**除第一条以外**的 `status` 改成 `'done'`（只留 `plan[0]` 是 `'pending'`）⇒ 预期 `the dry run validates the triple and prints the plan without any transport` **按测试名变红**：`every(... === 'pending')` 是唯一抓得住它的断言，这正是不满足于只看 `plan[0]` 的理由。

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

const OWNER_RECORD = {
  runid: 'r1',
  operator: 'ops',
  startedAt: '2026-09-22T00:00:00.000Z',
  planHash: 'p1',
  machine: 'builder-01',
};

function fakeWriteTransport(handlers = {}) {
  const calls = [];
  return {
    calls,
    readOnly: {
      sshRun: async (request) => {
        calls.push(['readSsh', request.script, request]);
        return handlers.readSsh ? handlers.readSsh(request) : { status: 0, stdout: '', stderr: '' };
      },
    },
    write: {
      sshRun: async (request) => {
        calls.push(['writeSsh', request.script, request]);
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
    owner: OWNER_RECORD,
    host: HOST,
    knownHostsPath: KNOWN_HOSTS_PATH,
  });
  assert.equal(result.state, 'not-acquired');
  assert.equal(result.requiresExplicitRecovery, true);
  assert.equal(transport.calls.filter((call) => /rm |rmdir/u.test(String(call[1] ?? ''))).length, 0);
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
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
    owner: OWNER_RECORD,
    host: HOST,
    knownHostsPath: KNOWN_HOSTS_PATH,
  });
  assert.equal(result.state, 'ownership-unknown');
  assert.match(result.reason, /cannot confirm/u);
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
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
    owner: OWNER_RECORD,
    host: HOST,
    knownHostsPath: KNOWN_HOSTS_PATH,
  });
  assert.equal(result.state, 'retained-by-this-run');
  assert.equal(result.incident, true);
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
});

test('release verifies the owner, then removes the owner file, then the lock directory', async () => {
  const owner = OWNER_RECORD;
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
    host: HOST,
    knownHostsPath: KNOWN_HOSTS_PATH,
    acquisitionConfirmed: true,
    safeToExit: true,
  });
  assert.equal(verdict.state, 'released');
  assert.deepEqual(order, ['rm-owner', 'rmdir-lock']);
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
});

test('a failed owner removal is never reported as released', async () => {
  const owner = OWNER_RECORD;
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
    host: HOST,
    knownHostsPath: KNOWN_HOSTS_PATH,
    acquisitionConfirmed: true,
    safeToExit: true,
  });
  assert.equal(verdict.state, 'retained-by-this-run');
  assert.equal(verdict.incident, true);
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
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
    host: HOST,
    knownHostsPath: KNOWN_HOSTS_PATH,
    acquisitionConfirmed: true,
    safeToExit: true,
  });
  assert.equal(verdict.state, 'ownership-unknown');
  assert.equal(transport.calls.filter((call) => /rm |rmdir/u.test(String(call[1] ?? ''))).length, 0);
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
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
    host: HOST,
    knownHostsPath: KNOWN_HOSTS_PATH,
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
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
});

test('breaking a lock records the real previous owner and the operator', async () => {
  const owner = { runid: 'r0', planHash: 'p0' };
  const transport = fakeWriteTransport({ readSsh: () => ({ status: 0, stdout: JSON.stringify(owner), stderr: '' }) });
  const record = await breakChannelLock({
    channel: 'internal',
    transport,
    host: HOST,
    knownHostsPath: KNOWN_HOSTS_PATH,
    reason: 'operator confirmed the previous run stopped',
    confirmRunid: 'r0',
    auditOut: '/outside/audit.jsonl',
    operator: 'ops',
  });
  assert.equal(record.outcome, 'lock-broken');
  assert.deepEqual(record.previousOwner, owner);
  assert.equal(record.operator, 'ops');
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
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
      host: HOST,
      knownHostsPath: KNOWN_HOSTS_PATH,
      reason: 'stopped',
      confirmRunid: 'r0',
      auditOut: '/outside/audit.jsonl',
      operator: 'ops',
    }),
    /could not be removed/u,
  );
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
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
  return /File exists/iu.test(`${result.stderr ?? ''} ${result.stdout ?? ''}`);
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
  for (const field of ['runid', 'operator', 'startedAt', 'planHash', 'machine']) {
    const value = input.owner?.[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new FeedPublishError(`the owner record must carry a non empty ${field}, so no lock is created without one`);
    }
  }
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
    acquisitionConfirmed: input.acquisitionConfirmed,
    owner,
    runid: input.runid,
    planHash: input.planHash,
    safeToExit: input.safeToExit,
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

**实现偏离（已提交于 `3ebe23ec`，别改回宽臂）：** 上面的 `isFileExistsFailure` 只匹配 `File exists`。GNU coreutils 在 EPERM/EACCES 下打印的是 `mkdir: cannot create directory '<path>': Permission denied`，所以 `cannot create directory` 那一臂会把**权限失败**判成 `not-acquired`，理由写成「the channel is already locked」—— 这是一句关于远端状态的**假话**，而且正是这句话把操作者推向 `--break-lock`，也就是去砸一把**不属于自己**的锁。实测：把宽臂加回去，**只**红本刀新增的 `a lock mkdir that fails without an existing entry signal is ownership unknown`，规定的十三条**全绿** ⇒ 规定的那份套件看不见这个差别。计划自带的夹具（`mkdir: cannot create directory '...': File exists`）仍然匹配收窄后的谓词，因为它们含 `File exists`。

**本修复刀的三处偏离（第二、第三、第四处，形状与上面那条相同：规定文本说了什么 / 为什么不行 / 什么变异证明规定清单看不见差别）：**

1. **`owner.json` 必须携带 §6.6 的五个字段（第二个实现偏离）。** 规定文本的 `acquireChannelLock` **完全不校验** `input.owner`，规定夹具传的是两字段的 `{ runid, planHash }`，Task 4 的获取处也照此传。§6.6（spec 行 319）要求锁内写 `runid`、`operator`、`startedAt`、`planHash`、执行机标识；spec 行 322 要求 `--break-lock` 打印原 owner 的**完整信息**并让操作员确认"前一次运行确实不在进行中"——两字段的记录让这个判断无从做起，`startedAt` 更是**全计划里找不到出处**。实现改为在 `mkdir` **之前**逐字段校验（每个字段都必须 `trim()` 后非空，坏记录**永远不创建锁**）。**规定清单看不见差别**：五个字段检查逐个删掉，**规定的十三条全绿**（它们的 owner 都是完整记录），红的只有本刀新增的**六条**字段用例（五个 `an owner record without a <field> never creates a lock` 加一条 blank；实测：删 `runid` / `operator` / `startedAt` / `planHash` 各只红自己那一条，删 `machine` 红两条）。规定的夹具与三条规定的 acquire 用例因此改用完整的 `OWNER_RECORD`——**规定的 13 条测试名一个都没改**。
2. **`releaseChannelLock` 不再把两个 §6.6 前提写成字面量（第三个实现偏离）。** 规定文本里 `acquisitionConfirmed: true` 与 `safeToExit: true` 是**字面量**，于是 §6.6 的推论（"本次尚未取得锁时……**不得声称「保留」或「释放」一个并不属于自己的锁**"，spec 行 352）与保留表（"翻转之后失败 ⇒ `incident` ⇒ **保留锁**"，spec 行 333）在这个入口上**无法表达**——Task 4 的 `releaseAndFinish` 正是不传这两个参数调用它的，于是它无条件断言"本次确实取得过锁"且"安全退出"。实现改为把两个输入往下传（`resolveLockDisposition` 内部本来就 fail closed：`!== true` 即拒绝）。规定的三条 release 用例因此各自补上 `acquisitionConfirmed: true, safeToExit: true`——**测试名不变**。**规定清单看不见差别**：把 `acquisitionConfirmed` 还原成字面量 `true` ⇒ 只红本刀新增的 `a release that never confirmed its own acquisition refuses and writes nothing`（69 → 68）；把 `safeToExit` 还原成字面量 ⇒ 只红 `a release that is not safe to exit keeps the lock this run owns`（69 → 68）。
3. **§6.4 的信任锚现在每条远程调用都被钉住（第四个偏离，改动落在测试夹具与规定用例上）。** 规定夹具只记 `request.script`，所以从七个调用点里删掉 `host:` 或 `knownHostsPath:` **58/58 全绿**（实测）——`knownHostsPath` 是签名闸门之外的另一道信任锚，掉线不报错、只静默失效。实现：假 transport 记下**整个 request**，并用共享助手 `assertEveryCallCarriesTheTrustAnchor(calls)` 在每条走 transport 的测试里断言 `host` 与 `knownHostsPath` 恰好等于 `HOST` / `KNOWN_HOSTS_PATH`；助手**先断言 `calls.length > 0`**（零调用不许空过）。Task 1/2 的 preflight 夹具与三条 preflight 用例一并接上——只修 Task 3 会把同一个洞留在隔壁。**规定清单看不见差别**：删 `readOwnerRecord` 调用里的 `host:` ⇒ 红 13 条（69 → 56），删 `acquireChannelLock` 的 `mkdir` 调用里的 `knownHostsPath:` ⇒ 红 10 条（69 → 59）；两条在修复前都是 58/58 全绿。

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
5. 把 `releaseChannelLock` 里的 `owner ?? readOwnerRecord(input)` 改成直接用传入的 `owner` ⇒ 预期 `release re-reads the owner from the lock when the caller has none` **按测试名变红**。
   **本计划原文预测的那条测试看不见这个变异**（已实测）：`release re-reads the owner and refuses when it belongs to another run` 传进来的 `owner` 是 `null`，而 `null` owner 在 `resolveLockDisposition` 里**根本不看锁**就返回 `ownership-unknown` ⇒ 删掉 `??` 重读它照样绿。真正变红的是接住"调用方没有 owner、锁上有"这条路的 `release re-reads the owner from the lock when the caller has none`：实测只红这一条（58 → 57），它断言读到 `this run` 的 owner 后一路走到 `rm owner.json` 与 `rmdir lock`。**要把它记成"规定清单看不见的缺口"**：传进去的 owner 为空 ≠ 没有 owner 可读，这两件事必须有各自的钉子，否则 `--break-lock` 之外的第二条恢复路径（先读锁再释放）可以在缺 `??` 的情况下静默走偏。 **本刀重跑于 69 条套件（删掉 `feed-publish.mjs:337` 的 `??` 重读，锚点断言恰好匹配一次）：实测 69 → 66 / 3** —— 除上面那条外，红的还有 `release re-reads the owner and refuses when it belongs to another run` 与 `a corrupt owner record on the lock is unreadable rather than a crash`（注意：上一段"它照样绿"这句**只对 58 条时代成立**，现在它也红，但红在守卫那行、不是红在语义上）。这三条**都死在助手那句 `calls.length > 0` 上，不是语义断言变了**：用带桩副本跑同一次变异读得 `__ANCHOR_EMPTY_CALL_LIST_N__ 3`，即这三条在变异后**一次远程读取都不再发生**（都传 `owner: null`）⇒ `transport.calls` 为空 ⇒ 先撞非空守卫。所以 58 条时代的"只红一条"在修复刀之后**变成 3 条**：多出来的两条不是新发现的语义缺口，而是信任锚助手的非空守卫**在变异空间里确实有牙** —— 但**守卫本身在 HEAD 上仍然没人钉**（第 51 条把它钉住）。
   **第 1–34 条（含第 5 条里的 `58 → 57`）与「刻意不钉」清单里的 `58/58` 都是 58 条套件时代的读数**；套件在修复刀涨到 69 条后，这些**计数**必须重跑才有效（名字级的预测不受影响）。本刀加进第 51 条后套件为 **70** 条，因此本刀写下的每个计数都注明了它是在 **69 条**还是 **70 条**上读的。
6. 把 `confirmRunid !== owner.runid` 检查删掉 ⇒ 预期 `breaking a lock needs a reason, an audit log and a matching runid` **按测试名变红**。
7. 把 `removedOwner.status !== 0 || removedLock.status !== 0` 的拒绝改成照常返回 ⇒ 预期 `a failed remote deletion is not recorded as lock-broken` **按测试名变红**。
8. 把 `planHashOf` 里的 `manifestSha256` 去掉 ⇒ 预期 `the plan hash binds channel, version and all three artifact digests` **按测试名变红**。
9. 把 `LOCK_STATES` 的 `Object.freeze(...)` 删掉（只留数组字面量）⇒ 预期 `the lock states are frozen so no run can add a fifth one` **按测试名变红**（四态**取值**由规定的第 1 条钉住，**冻结**没人钉）。
10. 把 `planHashOf` 哈希输入里的 `input.channel` 删掉 ⇒ 预期 `the plan hash binds channel, version and all three artifact digests` **按测试名变红**。
11. 把 `planHashOf` 哈希输入里的 `input.packageSha256` 删掉 ⇒ 预期同上那条 **按测试名变红**。
12. 把 `planHashOf` 哈希输入里的 `input.fileManifestSha256` 删掉 ⇒ 预期同上那条 **按测试名变红**。
    （10–12 加规定的第 8 条必须**分四次各删一个**：那条测试逐个字段比较，一次删多个虽然也会红，但证明不了任何一个字段被绑住。原文只覆盖了 `manifestSha256`。）
13. 把 `isFileExistsFailure` 的谓词加回宽臂（`/File exists|cannot create directory/iu`）⇒ 预期 `a lock mkdir that fails without an existing entry signal is ownership unknown` **按测试名变红**，而且**只**红它：规定的十三条全绿 ⇒ 规定清单看不见这个差别。这正是上面「实现偏离」那段必须留在计划里的理由。
14. 把既有条目信号的 `i` 标志删掉（`/File exists/iu` → `/File exists/u`）⇒ 预期 `the existing entry signal is read from either stream and without regard to case` **按测试名变红**（该夹具刻意走 `stdout` 且是大写 `FILE EXISTS`）。
15. 把既有条目信号的 `stdout` 臂删掉（`` `${result.stderr ?? ''} ${result.stdout ?? ''}` `` 收成只读 `stderr`）⇒ 预期同上那条 **按测试名变红**。
    （14 与 15 在**同一行**的两个不同位置：`i` 标志与两个流的拼接。必须分两次，各删一个。）
16. 把 `if (created.status === -1 || !isFileExistsFailure(created))` 里的 `created.status === -1 ||` 删掉 ⇒ 预期 `a transport level mkdir failure is ownership unknown even when its output looks like an existing entry` **按测试名变红**：该夹具是 `status: -1` 而输出**长得像**既有条目（含 `File exists`），收窄后的谓词正好会把它判成 `not-acquired`，只有这个臂拦得住。（规定的第 1 条删的是整个分支，证明不了这一臂单独必要。）
17. 把 `not-acquired` 分支返回的 `owner,` 改成 `owner: null,` ⇒ 预期 `an existing lock reports the owner it found so a human can confirm it` **按测试名变红**（该测试同时钉住 `cat <lock>/owner.json` 那一次读）。
18. 把 `readOwnerRecord` 的 `if (read.status !== 0) return null;` 删掉 ⇒ 预期 `an owner read that exits non-zero is unreadable even when it printed a record` **按测试名变红**（夹具刻意"退了非零但打印了完整记录"，只有这条守卫能把它判成不可读）。
19. 把 `resolveLockDisposition` 记录守卫的 `input.owner === null ||` 删掉 ⇒ 预期 `a lock owner that is missing or not a record is ownership unknown` **按测试名变红**（`null` 也满足 `typeof === 'object'`，随后读 `input.owner.runid` 抛 TypeError）。
20. 把同一条守卫的 `|| typeof input.owner !== 'object'` 删掉 ⇒ 预期同一条 **按测试名变红**（该测试用 `null` 与 `undefined` 各跑一遍，这一臂抓的是 `undefined`）。
    （19 与 20 是同一条条件下的两个臂，必须分两次各删一个。）
21. 把 `resolveLockDisposition` 的 planHash 不符分支（`if (input.owner.planHash !== input.planHash) { ... }`）整段删掉 ⇒ 预期 `an owner record that matches the runid but not the plan hash is ownership unknown` **按测试名变红**（runid 相符但计划已变，必须仍然不许释放）。
22. 把 release 里 `if (removedLock.status !== 0) { ... }` 的条件改成恒假（等价于删掉这段拒绝）⇒ 预期 `release that removed the owner file but not the lock directory is not released` **按测试名变红**。**与规定的第 4 条区分**：第 4 条删的是 `removedOwner.status !== 0`（owner 文件那一半），这里是 `rmdir` 那一半 —— 两半各自都要红，否则"删了 owner 文件但锁目录还在"会被报成已释放。
23. 把 break 里 `if (removedOwner.status !== 0 || removedLock.status !== 0)` 收成 `if (removedOwner.status !== 0)` ⇒ 预期 `a break whose lock directory survives is not recorded as lock-broken` **按测试名变红**。（规定的第 7 条删的是整条 `||`，单删 `rmdir` 这一半没人钉。）
24. 把 break 的 `if (owner === null) { throw new FeedPublishError('the lock has no readable owner record, ...'); }` 整段删掉 ⇒ 预期 `breaking a lock without a readable owner record is refused` **按测试名变红**（删掉后会掉到 `input.confirmRunid !== owner.runid` 上读 `null.runid` 抛 TypeError ⇒ 仍然红，但不是那句"必须人工看"的文案；该测试同时钉住"一次写都没发"）。
25. 把 break 里两条写调用的**脚本**对调（先 `rmdir <lock>`、后 `rm <lock>/owner.json`）⇒ 预期 `breaking a lock removes the owner file before the lock directory and records the reason` **按测试名变红**（它断言 `order` 恰好是 `['rm …','rmdir …']`）。**只动 `breakChannelLock` 里那两条**：`releaseChannelLock` 里有两条同形调用，别删错（规定的第 3 条管的是 release 那对）。
26. 把 break 返回里的 `reason: input.reason,` 改成一个字面量 ⇒ 预期 `breaking a lock removes the owner file before the lock directory and records the reason` **按测试名变红**（那是唯一断言 `record.reason` 等于传进去的 reason 的地方）。
27. 把 break 返回里的 `operator: input.operator ?? 'unknown',` 改成写死 ⇒ 预期 `breaking a lock records the real previous owner and the operator` **按测试名变红**。
28. 把"必须写明 reason"守卫的 `typeof input.reason !== 'string' ||` 删掉 ⇒ 预期 `breaking a lock refuses a reason that is not a written string` **按测试名变红**（`reason: 42` ⇒ 读 `42.trim` 抛 TypeError，抛的不是 `FeedPublishError`）。
29. 把同一条守卫的 `input.reason.trim().length === 0` 改成 `input.reason.length === 0` ⇒ 预期同一条 **按测试名变红**（`reason: '   '` 会放行）。
    （28 与 29 在**同一行**的两个臂上，必须分两次各删一个。）
30. 把 `--audit-out` 守卫的 `typeof input.auditOut !== 'string' ||` 删掉 ⇒ 预期 `breaking a lock refuses a reason that is not a written string` **按测试名变红**（`auditOut: undefined` ⇒ 读 `undefined.length` 抛 TypeError）；这条会**连带红**规定的 `breaking a lock needs a reason, an audit log and a matching runid`（那里的 `auditOut: null` 靠同一臂拒绝）—— 连带红是良性方向。
31. 逐处删 `await`（这一类在本刀是**活的**，因为假 transport 全是 async：`await` 一删结果就变成 Promise）：`readOwnerRecord` 里的 `readOnly.sshRun`；`acquireChannelLock` 里的 `mkdir`、`readOwnerRecord(input)`、owner 写入；`releaseChannelLock` 里的 `readOwnerRecord(input)`、`rm owner.json`、`rmdir lock`；`breakChannelLock` 里的 `readOwnerRecord(input)`、`rm owner.json`、`rmdir lock` —— **十处，一次删一处**。实测：
    - **只由本刀新增测试抓住（规定的十三条全绿）的三处**：acquire 的 owner 读取 ⇒ 红 `an existing lock reports the owner it found so a human can confirm it` 与 `an owner read that exits non-zero is unreadable even when it printed a record`；acquire 的 owner 写入 ⇒ 红 `a successful acquisition writes the owner record for this run`；release 的 owner 读取 ⇒ 红 `release re-reads the owner from the lock when the caller has none`。规定的十三条在这三处**没有一条读到被 Promise 替掉的字段** ⇒ 只靠原清单，缺 `await` 会静默存活。
    - 其余七处删掉时规定的十三条**也会**红（不算缺口，但仍逐处记名，别拿"反正会红"当覆盖）：`readOwnerRecord` 的 `sshRun` 红规定三条（`breaking a lock needs a reason, an audit log and a matching runid`、`breaking a lock records the real previous owner and the operator`、`a failed remote deletion is not recorded as lock-broken`）；acquire 的 `mkdir` 红规定两条（`an existing lock is a determinate not-acquired and never stolen`、`a failed owner write is an incident that keeps the lock`）；release 的 `rm` 与 `rmdir` 各红规定的 `release verifies the owner, then removes the owner file, then the lock directory`；break 的 owner 读取红规定两条（`breaking a lock records the real previous owner and the operator`、`a failed remote deletion is not recorded as lock-broken`）；break 的 `rm` 与 `rmdir` 各红规定的 `breaking a lock records the real previous owner and the operator`。
32. 把 `lockPath` 里的 `${channel}` 写死成 `internal` ⇒ 预期 `the lock lives under the channel it was given rather than a fixed one` **按测试名变红**（两条写脚本的路径都由它拼出来）。
33. 把 owner 写入脚本里的 `JSON.stringify(input.owner)` 改动一个字符（例如末尾多一个空格）⇒ 预期 `a successful acquisition writes the owner record for this run` 与 `the lock lives under the channel it was given rather than a fixed one` **按测试名变红**（两条都逐字断言写脚本）。
34. 成功分支的结果字段：把 `state` / `acquired` / `incident` / `requiresExplicitRecovery` / `owner` 任一改错（实测把 `acquired: true` 翻成 `false`、把 `owner: input.owner` 改成 `null`、把 `requiresExplicitRecovery: false` 翻成 `true`，三次都）⇒ 预期 `a successful acquisition writes the owner record for this run` **按测试名变红**。`not-acquired` 分支的字段另有钉子：`requiresExplicitRecovery` 由规定的 `an existing lock is a determinate not-acquired and never stolen` 钉住，`incident: false` 由 `an existing lock reports the owner it found so a human can confirm it` 钉住。

**变异次数（第 1–34 条的算术，别再算错）：** 第 1–30 条各一次 = **30**；第 31 条**十处** `await` 各一次 = **10**（"十处"是对的：`readOwnerRecord` 1 处、`acquireChannelLock` 3 处、`releaseChannelLock` 3 处、`breakChannelLock` 3 处）；第 32、33 条各一次 = **2**；第 34 条三次字段翻转 = **3** ⇒ 第一次提交（`3ebe23ec`）**共 45 次变异**，外加 1 次对照变异（把 `not-acquired` 那句没人断言的 `reason` 散文改写一个词，**58/58 全绿**）= **46 次运行**。⚠️ **`3ebe23ec` 的提交信息里 "fifty-one ledger runs" 是错的（多算了 5 次）**；同一段信息里 "the await on each of the five transport calls" 也是错的（是**十处**，不是五处；"十一"这个数字在计划全文里不存在）。**不重写 `3ebe23ec`**，只在此处记账。

**本修复刀追加的变异（第 35–50 条，套件规模 69 条；第 50 条是必须留绿的那次对照）：**

35. 删掉 `readOwnerRecord` 调用里的 `host: input.host,` ⇒ 实测**红 13 条**（`an existing lock is a determinate not-acquired and never stolen`、`an existing lock reports the owner it found so a human can confirm it`、`an owner read that exits non-zero is unreadable even when it printed a record`、`release re-reads the owner and refuses when it belongs to another run`、`release re-reads the owner from the lock when the caller has none`、`breaking a lock needs a reason, an audit log and a matching runid`、`breaking a lock records the real previous owner and the operator`、`a failed remote deletion is not recorded as lock-broken`、`a break whose lock directory survives is not recorded as lock-broken`、`breaking a lock without a readable owner record is refused`、`breaking a lock removes the owner file before the lock directory and records the reason`、`the existing entry signal is read from either stream and without regard to case`、`a corrupt owner record on the lock is unreadable rather than a crash`），69 → 56 pass / 13 fail。**修复前这条变异 58/58 全绿。**
36. 删掉 `acquireChannelLock` 的 `mkdir` 调用里的 `knownHostsPath: input.knownHostsPath,` ⇒ 实测**红 10 条**（八条 acquire 用例 + `an existing lock is a determinate not-acquired and never stolen` + `an owner read that exits non-zero is unreadable even when it printed a record`），69 → 59 / 10。**修复前同样 58/58 全绿。**
    （35 与 36 分别对应 §6.4 的两个信任锚字段；七个调用点其余五处由同一条助手覆盖。）
37. 把 `readOwnerRecord` 的 `try/catch` 删掉（`status` 为 0 时直接 `return JSON.parse(...)`）⇒ **红 3 条**：`a corrupt owner record on the lock is unreadable rather than a crash`（本刀新增）+ 连带 `an existing lock is a determinate not-acquired and never stolen`、`the existing entry signal is read from either stream and without regard to case`（这两条的默认 `readSsh` 返回空 stdout，同样会撞上 `JSON.parse`；连带红是良性方向），69 → 66 / 3。
38. 把 `--audit-out` 守卫的 `|| input.auditOut.length === 0` 臂删掉 ⇒ **只红** `breaking a lock refuses an empty audit log path`，69 → 68 / 1。（规定的拒绝用例传的是 `null`/`undefined`，走的是 `typeof` 那一臂 ⇒ 收窄后这条臂原本没人钉。）
39. 把 `releaseChannelLock` 的 `acquisitionConfirmed: input.acquisitionConfirmed` 还原成字面量 `true` ⇒ **只红** `a release that never confirmed its own acquisition refuses and writes nothing`，69 → 68 / 1。
40. 把 `releaseChannelLock` 的 `safeToExit: input.safeToExit` 还原成字面量 `true` ⇒ **只红** `a release that is not safe to exit keeps the lock this run owns`，69 → 68 / 1。（39 与 40 是同一个对象字面量里的两个表达式，必须分两次各改一个。）
41. 删掉 owner 字段清单里的 `'runid'` ⇒ **只红** `an owner record without a runid never creates a lock`，69 → 68 / 1。
42. 同上，删 `'operator'` ⇒ 只红 `an owner record without an operator never creates a lock`，69 → 68 / 1。
43. 同上，删 `'startedAt'` ⇒ 只红 `an owner record without a startedAt never creates a lock`，69 → 68 / 1。
44. 同上，删 `'planHash'` ⇒ 只红 `an owner record without a planHash never creates a lock`，69 → 68 / 1。
45. 同上，删 `'machine'` ⇒ 红 2 条：`an owner record without a machine never creates a lock` 与 `an owner record with a blank machine never creates a lock`，69 → 67 / 2（两条钉的是同一个字段检查，删掉它两条都放行；连带红是良性方向）。
    （41–45 必须**分五次各删一个**：一次删多个虽然也会红，但证明不了任何一个字段被绑住。）
46. 把 `typeof value !== 'string' || value.trim().length === 0` 里的 `.trim()` 删掉 ⇒ **只红** `an owner record with a blank machine never creates a lock`（该夹具刻意用 `'   '`），69 → 68 / 1。
47. 把 `const value = input.owner?.[field];` 的 `?.` 删掉 ⇒ **只红** `a missing owner record never creates a lock`（`null`/`undefined` owner 会抛 TypeError 而不是 `FeedPublishError`），69 → 68 / 1。
48. 把逐字段校验**整段移到 `mkdir` 调用之后** ⇒ **红 7 条**（六条 owner 字段用例 + `a missing owner record never creates a lock`），69 → 62 / 7：六条断言的 `transport.calls.length === 0` 正是"坏记录**永远不创建锁**"这条**顺序**保证的钉子。
49. 把 owner 写入脚本里的 `JSON.stringify(input.owner)` 收成只写 `runid`/`operator`/`planHash` 三个字段 ⇒ 红 2 条：`a successful acquisition writes the owner record for this run` 与 `the lock lives under the channel it was given rather than a fixed one`（两条都逐字断言写脚本），69 → 67 / 2。
50. **对照变异（必须保持全绿）**：把 `not-acquired` 分支里那句 `reason: 'the channel is already locked',` 改写成 `'a lock is already held on this channel',` ⇒ 实测 **70/70 全绿** ⇒ 这套变异装置不是"改什么都红"。
51. 删掉助手里的 `assert.ok(calls.length > 0, 'the trust anchor assertion needs at least one recorded call');`（非空守卫）⇒ **只红**本刀新增的 `the anchor helper refuses an empty call list rather than passing on zero calls`，实测 **70 → 69 / 1**。**为什么必须单钉它**：这是全刀唯一一条没人钉的守卫 —— 实测 HEAD 上 27 次助手调用**没有一次**拿到空调用表（带桩副本读数 `__ANCHOR_EMPTY_CALL_LIST_N__ 0`），所以删掉它整个套件仍然 70/70 全绿，它存在的意义是挡住**将来**那条把 `calls` 传空的用例。而它在**变异空间里有牙**：第 5 条那次变异（删 `??` 重读）实测正好让 3 条用例的调用表变空（`__ANCHOR_EMPTY_CALL_LIST_N__ 3`），三条全部被它抓住 —— 守卫的**行为**因此是"有牙且已钉"，只有它的**文案**留在「刻意不钉」名单里。**这份读数的口径（实测，别再估）：套件里 36 条用例构造假 transport（共 40 次构造），其中 25 条**至少发过一次调用**、这 25 条**全部**接了助手；另外 11 条**刻意零调用**；助手共被调用 27 次、分布在 25 条用例上。**

**本修复刀的变异次数：** 第 35–49 条各一次 = **15 次变异**，第 51 条 = **1 次**，外加 1 次对照变异（第 50 条）= **17 次运行** ⇒ Task 3 累计 **61 次变异 + 2 次对照 = 63 次运行**。（第 5 条在 69 条套件上的**重跑**是**测量**，不是新变异，不计入次数。）每一次都先断言锚点**恰好匹配一次**、变异后确认**文件在磁盘上真的变了**、跑完**逐字节恢复**并核对恢复后的 SHA-256 与变异前一致；对照那条是"必须留绿"的那一次。

恢复后全绿且 `git diff` 为空。

- [ ] **Step 6: 提交**

```bash
git add scripts/lib/feed-publish.mjs scripts/lib/feed-publish.test.mjs
git commit -m "feat(feed): own the channel lock honestly, including its failure modes"
```

**本刀刻意不钉的东西（复核时别当成缺陷再报一遍）：** `isFileExistsFailure` 正则的 `u` 标志（删掉它改不了任何可观察行为 —— 实测 58/58 全绿）；`planHashOf` 的 `'\n'` 连接符（五个字段谁也放不进分隔符，换成任何"字段里不可能出现的分隔符"哈希都一样 —— 钉住的只是**逐字段**的敏感度）；`readOwnerRecord` 对读到 stdout 的 `.trim()`（`JSON.parse` 自己容空白，实测删掉它 58/58 全绿）；`?? 'unknown'` 这个 operator 默认字面量（钉住的是该字段**存在**，不是它的默认文本 —— 实测换成别的字面量 58/58 全绿）；以及所有人类可读的 `reason` 文案 —— 它们是散文，任何地方都不断言，这是**刻意**的（对照：`an owner record that matches the runid but not the plan hash is ownership unknown` 只断言 `reason` 里出现 `planHash`，不比对整句）。 **第 1–34 条（含第 5 条里的 `58 → 57`）与「刻意不钉」清单里的 `58/58` 都是 58 条套件时代的读数**；套件在修复刀涨到 69 条后，这些**计数**必须重跑才有效（名字级的预测不受影响）。

**本修复刀加进这份名单的：** ① owner 校验的报错文案 `the owner record must carry a non empty <field>, so no lock is created without one` —— 散文，被测的只有**字段名**（`/machine/u` 等），整句不断言；② owner 为 `null`/`undefined` 时报的是**清单里第一个**字段（`runid`）——**检查顺序刻意不钉**（`a missing owner record never creates a lock` 只断言抛的是 `FeedPublishError` 且消息含 `owner record`）：顺序不是 §6.6 的要求，只是实现细节；③ `resolveLockDisposition` 对两个前提的 `!== true` 严格性（真值但非 `true`，例如 `'yes'`）——那是既有那一臂的语义，本刀只做透传，测试只覆盖 `false` 与"缺省"两种；④ 助手 `assertEveryCallCarriesTheTrustAnchor` 自己的**断言文案** —— **只剩文案**：该助手的**非空守卫**（`calls.length > 0`，零调用不许空过）本刀已用 `the anchor helper refuses an empty call list rather than passing on zero calls` **钉住**（第 51 条），因此它**不在**这份"刻意不钉"名单里。

**仓库事实（省得下次再去查门禁覆盖）：** `eslint.config.mjs` 的 `ignores` 含 `scripts/**` 与 `**/scripts/**`，所以本模块由 `node --test`、prettier `format:check` 与 knip 覆盖，**不被 eslint 覆盖**；"代码里不写注释"与"代码里不出现 CJK"这两条（`docs/agent-rules/frontend.md`）在本模块上因此**靠人工扫**，而不是靠门禁。

---

### Task 4: 主流程（13 步追踪表的逐行实现）

**Files:**

- Modify: `scripts/lib/feed-publish.mjs`
- Modify: `scripts/lib/feed-publish.test.mjs`

**每写一个 helper，立刻在 `runCommit` 里接上**；不允许出现"定义了但没接"的 helper。

**`planCommit` 的契约要在本刀显式定下来**：Task 2 的 `planCommit` 丢掉了 `verifyLocalArtifacts` 的返回值，而本刀的 `planHashOf` 需要全部三个摘要 ⇒ 本刀必须二选一并在代码里写实——要么在 Task 4 内部自己重新调一次 `verifyLocalArtifacts` 拿摘要，要么扩宽 `planCommit` 的返回值让它把摘要带出来——不允许两种做法并存，也不允许把 `planCommit` 的契约留成歧义。

**计划的形状只有一处推导、两处使用**：`planCommit` 返回 `PUBLISH_STAGES.map((stage) => ({ stage, status: 'pending' }))`，而本刀 `runCommit` 里的 `stages` 是**同一表达式的第二份拷贝**。两份一旦漂移（`--dry-run` 打印出来的计划与审计日志里的阶段列表不是同一个形状），**没有任何测试会红**。二选一并在代码里写实：要么让 `runCommit` 接收 `planCommit` 产出的计划数组（单点推导），要么把两份推导保持**逐字相同**，并在本刀的变异清单里加一条"只改其中一份 ⇒ 指定测试按测试名变红"把这条接线钉住。不允许留成两份没人看着的拷贝。

**owner 记录的三个新字段从哪里来（本刀接线，不许在 `scripts/lib/` 里取系统值）：** §6.6（spec 行 319）要求锁内写全五个字段，而 Task 3 的 `acquireChannelLock` 现在会**逐字段 fail closed**（缺一个就抛 `FeedPublishError`，且**在任何远程调用之前**），所以 `runCommit` 必须把完整记录交给它：`runid` 用本刀的 `randomUUID()`、`planHash` 用 `planHashOf` 的结果，另外三个**由调用方注入**——`operator` 取 CLI 已有的 `MOFANG_FEED_OPERATOR`（Task 7 的 `--break-lock` 分支已经在读它）、`startedAt` 取 CLI 启动时的 `new Date().toISOString()`、`machine` 取 `os.hostname()`。**`scripts/lib/feed-publish.mjs` 是纯模块：不许出现 `new Date()` 或 `os.hostname()`**（否则这两个值在测试里只能靠打桩，接线就不可注入）；因此 **Task 7 的 `runCommit` 调用必须把 `operator` / `startedAt` / `machine` 三个值一起传进来**，否则发布会在锁这一步以 `FeedPublishError` 停下（那是诚实的失败，不是回归）。**同一条要求也落在本刀规定的测试夹具上**：`commitInput` 必须显式带上 `operator: 'ops'` / `startedAt: '2026-09-22T00:00:00.000Z'` / `machine: 'builder-01'`（假值，与 Task 3 的 `OWNER_RECORD` 同形，**不得**在测试里调 `new Date()` 或 `os.hostname()`），否则规定的那批 `runCommit` 用例会在锁这一步**全部**抛 `FeedPublishError` —— 五字段校验是在**任何远程调用之前** fail closed 的，夹具缺一个字段就没有一条 `runCommit` 用例能走到第二步。

**两个解锁点都不传 `owner`（§6.6 前提 2 的落地）：** `releaseAndFinish` 与成功路径的 `releaseChannelLock` 调用都**不传 `owner`**，让 `releaseChannelLock` 里的 `input.owner ?? (await readOwnerRecord(input))` 在**解锁那一刻**重新读 `owner.json`。原因：§6.6（spec 行 345）要求"解锁前**重新读取** `owner.json`"并与本次运行比对；先读一次（步骤 5 那次）再把那个快照传进来，等于把步骤 6 → 步骤 13 这段窗口空着——锁在这个窗口里被撞破并被另一个运行重新拿到时，本次运行会**删掉别人的锁**。传 `owner` 会让 §6.6 的前提 2 成为死代码。

**两处 `safeToExit: true` 为什么是诚实的：** 四个 `releaseAndFinish` 调用点（`commit-version` 的三条失败 + 设备号不一致那一条）与成功路径都在**翻转之前**（成功路径是翻转之后**且公网复验已经通过**），§6.6 的保留表（spec 行 331）说"翻转之前失败且**非 CAS 不匹配** ⇒ 确定 ⇒ `fail` ⇒ **释放锁**"，而"翻转之后失败"那一行要的是**不确定**的结果——这里任何一个 `releaseAndFinish` 调用点都是**已经确定**的失败，没有任何"远端状态可能已被改变"的不确定性，所以 `true` 不是乐观假设而是那张表的结论。`retainAndFinish` 走的仍是 `safeToExit: false`（保留锁），两条路各自被规定的用例钉住。

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
    operator: 'ops',
    startedAt: '2026-09-22T00:00:00.000Z',
    machine: 'builder-01',
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
  const verifier = input.verifier ?? (() => {});
  await verifier({ manifestBytes, fileManifestBytes, packagePath, publicKeyBase64: input.publicKeyBase64 });

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
      runid,
      planHash,
      host: input.host,
      knownHostsPath: input.knownHostsPath,
      acquisitionConfirmed,
      safeToExit: true,
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
    owner: { runid, operator: input.operator, startedAt: input.startedAt, planHash, machine: input.machine },
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
      verifier: input.verifier,
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
    runid,
    planHash,
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    acquisitionConfirmed,
    safeToExit: true,
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

**本修复刀追加的验收项（Task 4 实施时必须做，否则上面那几处锁上的修复在真路径上仍然是空的）：**

1. **解锁时锁已被别人换掉 ⇒ 拒绝并记 `incident`（§6.6 前提 2 的端到端钉子）。** 这条必须在**接线层**做，不能只调 `releaseChannelLock`：用 `commitTransport` 让**解锁那一刻**读到的 `owner.json` 的 `runid` 与本次运行不同（例如在 `mv -f` 之后把 `ownerJson` 换成一个 `runid: 'other'` 的记录），断言 `runCommit` 以 `incident` 收口、`lockState === 'ownership-unknown'`、**并且一次 `rm`/`rmdir` 都没发**。这条同时证明"两个解锁点确实**没有**传 `owner`"：一旦某个调用点把步骤 5 的旧快照传进去，比对就只看旧快照而放过这次替换，本项即变红。
2. **锁步骤上的确定性配置失败记 `incident`，不是 `blocked`。** Task 3 收窄 `isFileExistsFailure` 之后，**任何非 "File exists" 的非零 `mkdir`**（ENOENT、权限不足、只读文件系统）都会走 `ownership-unknown` ⇒ `incident`。这是**刻意的、安全的方向**：宁可记事故交人工核查，也不要用一句关于远端状态的假话把操作员推向 `--break-lock`。**Task 4 必须有一条用例把这条路径钉住**：夹具让 `mkdir` 返回 `{ status: 1, stderr: 'mkdir: cannot create directory ...: Permission denied' }`，断言 `outcome === 'incident'`、`lockState === 'ownership-unknown'`、`stages` 里 `lock` 是 `incident`，且**后续任何阶段都没跑**（`commit-version` 仍是 `pending`）。
3. ⚠️ **Task 6 必须抓一条真机的 coreutils 权限失败原文。** 上面这条用例（以及 Task 3 的 `a lock mkdir that fails without an existing entry signal is ownership unknown`）现在断言的 `stderr` 是**手写的字符串**——我们**没有在目标主机上实测过** GNU coreutils 在 EPERM/EACCES 下到底打印什么。Task 6 接上真 transport 后，在目标主机上抓**一次**真实的 `mkdir` 权限失败（例如在一个只读目录里 `mkdir`），把原文写进**计划或断言**里（代码里不写注释），并确认收窄后的谓词不会把它误判成 `not-acquired`。在抓到之前，"权限失败 ⇒ `incident`"这条只是**推断**，不是实测。
4. **Task 4 的 `commitTransport` 必须与 Task 3 同规格**：`readOnly.sshRun` / `write.sshRun` 记下**整个 request**，并新增一个 Task-4 形状的助手（`fetchPublic` 记的是 URL 不是 request，Task 3 的 `assertEveryCallCarriesTheTrustAnchor` 直接搬过来会在 `call[2]` 上失败）——在每条走 `commitTransport` 的用例末断言 `host` 与 `knownHostsPath` 恰好等于注入值，**零调用不算通过**。

**待定的设计决定（在本刀内决定，不要留成第三份拷贝）**：本刀新增的 `assertOutsideRepository` 会是仓库里**第三**个"这个路径是否在仓库外"的判据，三份的语义各差一点：兄弟模块 `scripts/lib/portable-update-release.mjs` 的 `assertPathOutsideRepository` 要求相对关系是 `..` **加一个分隔符**（或正好是 `..`）才算仓库外；Task 1 的 `assertKnownHostsPath` 与本刀这一份则接受**任何以 `..` 开头**的相对关系。差别在 `..foo` 这种名字上：`<仓库根>/..foo` **其实在仓库内**，兄弟那份会拒、这两份会放行。**首选修法是统一到兄弟模块那种更严的形式**（顺带把 `..foo` 这个已知边界一起关掉），而不是新增第三份略有差异的拷贝 —— 修哪一份、还是抽成共享的一份，在**本刀**里定下来，别把三份语义不同的判据留给下一个人。

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

**验收项（preflight 必须真的是只读）**：Task 2 的 `the preflight only performs read only actions and never claims writability` 实测**证明的比它名字声称的少** —— 它的假 transport 让 `readOnly.sshRun` 与 `write.sshRun` 记**同一个 tag**，所以在只读探测**旁边额外加一个写调用，27/27 依然全绿**。本任务接上**真实** transport 之后，写操作才真的会碰到服务器，因此必须补一条**能分辨 transport 身份**的判据：让假 transport 分别打 `readOnly` / `write` / `fetchPublic` 的 tag，并断言 preflight **只产生了 `readOnly` 的调用**。补之前，"preflight 零副作用"这条对操作员的承诺是没被钉住的。

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
import { hostname, tmpdir } from 'node:os';
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
  const startedAt = new Date().toISOString();
  const machine = hostname();

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
      const publicKeyBase64 = requirePublicKeyFromEnvironment();
      const plan = await planCommit({
        channel: input.channel,
        version: input.version,
        packagePath: resolve(packagePath),
        fileManifestPath: resolve(fileManifestPath),
        manifestPath: resolve(manifestPath),
        publicKeyBase64,
        verifySignature: ({ manifestBytes, fileManifestBytes, packagePath }) =>
          verifyPortableRelease({ manifestBytes, fileManifestBytes, packagePath, publicKeyBase64 }),
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
        operator: process.env.MOFANG_FEED_OPERATOR ?? 'unknown',
        startedAt,
        machine,
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

**待定的设计决定（在本刀内定，不要拖到 CLI 写完以后）**：探测失败时操作者只看得到 `notes` 里那句 "the read only probe did not succeed" —— **退出码与 stderr 都没有**，虽然 `probe.status` 与 `probe.stderr` 当时**就在 `probe` 里**。想让失败可诊断，只能扩宽 `runPreflight` 的**返回形状**（例如把 `status` 与一行 stderr 摘要带进 `notes`，或新增字段）；**现在定比 CLI 写完之后再定便宜得多**（那时要同时改 CLI 的输出、Task 8 的手册与发布前检查单）。本刀只做决定与记录，**不要**为这件事去改 Task 2 的代码。**必须在本行下方写明"选了哪个"（扩宽返回形状 ／ 维持现状）以及理由** —— 只留一句"待定"不算做完，那会变成一条无人认领的悬空决定。

**必须遵守：** 顶层 `await`，只用 `process.exitCode`，**不得**在 Promise 完成前 `process.exit`；batch 文件是**仓库外唯一临时文件**（`mkdtempSync`），并在 `finally` 清理，因此并发运行不会互相覆盖；`--break-lock` 的 `--reason` / `--audit-out` / `--confirm-runid` **三角都必填**；`--commit` 分支必须把锁记录的三个注入值一起交给 `runCommit`（`operator` 取 `process.env.MOFANG_FEED_OPERATOR ?? 'unknown'`，与 `--break-lock` 同一来源；`startedAt` 取 CLI 启动时的 `new Date().toISOString()`；`machine` 取 `os.hostname()`，`import { hostname } from 'node:os'`）—— `scripts/lib/` 是纯模块，**不得**出现 `new Date()` 或 `os.hostname()`，三个值只能由 CLI 注入。

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

**验收项（签名闸门真的在工作）**：`verifyPortableRelease` 是 **async** 的，注入后必须确认 `verifyLocalArtifacts` 与 `verifyPublicArtifacts` 都 **await** 了它。证明方式不是读代码，而是：`--dry-run` 分支在 Step 3 里已经注入真 verifier（`planCommit` 的 `verifySignature` 透传），所以这条**是可观测的** —— 把 manifest 的 `signature` 字段**改坏一个字节**跑 `--dry-run`（CLI 分支里 verifier 是写死的，所以"注入一个永远拒绝的 verifier"在 CLI 层面做不到 —— 可执行的路子只有改坏签名），确认它**以 verifier 的报错信息 reject**，且**一个字节的 plan JSON 都没打印**；再把 `verifyLocalArtifacts` 里那处 `await` 删掉，确认同一条路径**先打印出 plan JSON** —— 那就说明闸门是假的。⚠️ **判据是"plan JSON 有没有被打印"（以及 verifier 的报错在不在），不是退出码**：实测**两态都退出 1** —— 诚实的拒绝退出 1，而漏 `await` 那条先打印 plan JSON、再死于未处理的 Promise 拒绝，**也退出 1**。只盯退出码的人会看到两个 1，可能把变异记成"存活"，甚至反过来以为闸门是真的。⚠️ **不要把验收判据写成"以 `pre-verify: fail` 收口"**：`planCommit` 只返回 `{stage, status:'pending'}` 数组、**不改写任何阶段状态**，`--dry-run` 上根本观测不到 `pre-verify: fail`（那是 Task 4 的 `runCommit` 才有的形状）。拿一个观测不到的判据当验收，等于没验。

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
