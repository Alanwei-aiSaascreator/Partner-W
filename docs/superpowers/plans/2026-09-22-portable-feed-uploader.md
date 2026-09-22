# 整目录 feed 人工上传器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让整目录更新 feed 的发布成为一件**可恢复、可审计、可并发控制**的操作：本地先验证再上传、版本目录不可变、manifest 最后原子翻转、任何不确定结果都保留锁并交人工处理。

**Architecture:** 一个纯逻辑模块 `scripts/lib/feed-publish.mjs` 承担全部判定与流程编排，所有远端动作（`ssh` 只读命令、`sftp` 上传、公网 `fetch`）都通过**注入的 transport** 完成；CLI `scripts/feed-publish.mjs` 才把它们接到真实的 `ssh`/`sftp`/`https`。因此**全部测试都不需要服务器**。发布流程实现为显式的有序阶段数组，测试可以逐项断言顺序与收口状态。

**Tech Stack:** Node 20（ESM、`node:test`、`node:assert/strict`）、系统 `ssh`/`sftp` 二进制（仓库无任何 SSH 依赖）、pnpm 10。

**规格来源：** `docs/superpowers/specs/2026-09-22-portable-release-infrastructure-correction-design.md` §6.1–§6.16。

---

## 文件地图

| 文件                                          | 动作 | 职责                                                                                              |
| --------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------- |
| `scripts/lib/feed-publish.mjs`                | 新建 | 常量、输入校验、本地预验证、锁与所有权、13 步流程编排、CAS、不确定结果三分、审计阶段记录          |
| `scripts/lib/feed-publish-transport.mjs`      | 新建 | **真实** SSH / SFTP / https 适配器：argv 数组、BatchMode、StrictHostKeyChecking、固定 known_hosts |
| `scripts/lib/feed-publish-transport.test.mjs` | 新建 | 注入假 `execFile` / `fetchPublic` 的 transport 单测（**不联网**）                                 |
| `scripts/lib/feed-publish.test.mjs`           | 新建 | 上述全部逻辑的单测（注入假 transport，不联网）                                                    |
| `scripts/feed-publish.mjs`                    | 新建 | CLI：`--dry-run` / `--preflight` / `--commit` / `--break-lock`；真实 transport 接线               |
| `scripts/lib/feed-publish-cli.test.mjs`       | 新建 | CLI 守卫测试（缺参、未知旗标、`--audit-out` 必填、拒绝非白名单频道）                              |
| `docs/runbooks/portable-update-release.md`    | 修改 | 第 7/9/10 步改为调用上传器；新增受限账号、nginx、发布前检查单                                     |
| `package.json`                                | 修改 | 新增 `check:portable-feed-publish` 并接入 `check`                                                 |

**禁止事项（贯穿全计划）：** 不连接、不修改任何服务器；不生成生产密钥；不写入任何真实口令、token 或 host-key 指纹；不把审计日志写进仓库。

**测试纪律：** 任何测试**不得**真的调用 `ssh`/`sftp`/网络——真实 transport 通过**注入的 `execFile` / `fetchPublic`** 被替换成假实现，所以联网代码路径存在、可测，但测试从不联网。这是刻意的分工：**实现网络适配器**与**在测试里连接服务器**是两件事，前者是交付物，后者被禁止。

**"未验证"清单（不得写成通过）：** `--preflight` / `--commit` / `--break-lock` 的**真实网络路径**没有自动化覆盖，必须在真机发布演练中验收；本计划把它们的自动测试记为"只覆盖参数守卫与假 transport"。

---

## 依赖与执行顺序

1. Task 1（输入与本地预验证）→ 其余全部任务依赖它。
2. Task 2（dry-run / preflight）→ Task 4 之前。
3. Task 3（锁与所有权）→ Task 4 之前。
4. Task 4（固定时序 + CAS）→ Task 5 之前。
5. Task 5（公网复验与审计）→ Task 7 之前。
6. Task 6（**真实 transport**）→ **Task 7 依赖它**（CLI 接线要用 `createFeedTransport`）。
7. Task 7（CLI 接线，四种模式全部可用）→ Task 8 之前。
8. Task 8（文档 + 检查单）最后。

**每刀的通用纪律（与计划 1、2 相同，不再展开）：** 命名 RED → 按测试名失败 → 最小 GREEN → 行为级变异验证（删关键护栏 ⇒ 指定测试按名变红 ⇒ 逐字节恢复，`git diff` 为空）→ 判据含 `passed > 0` 与 `fail 0` → “跳过”记“未验证” → 完整门禁 `pnpm check` → 显式 pathspec 独立提交，禁止 `git add -A`。

**测试运行方式：**

```bash
node --test scripts/lib/feed-publish.test.mjs
node --test scripts/lib/feed-publish-cli.test.mjs
```

---

### Task 1: 输入纪律与本地预验证

**Files:**

- Create: `scripts/lib/feed-publish.mjs`
- Test: `scripts/lib/feed-publish.test.mjs`

固定常量（规格 §6.2）：发布根 `/opt/rongying/updates`、状态根 `/opt/rongying/updates-state`、频道白名单 `internal` / `stable`、公网基址 `https://api.rongyinghudong.com/updates`。**两个根都是常量，不由命令行传入**；主机名与 known_hosts 路径由命令行传入且必填，因为仓库**不得**内置服务器地址。

- [ ] **Step 1: 写失败的测试**

创建 `scripts/lib/feed-publish.test.mjs`：

```js
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const PACKAGE_BYTES = Buffer.from('portable-zip-bytes', 'utf8');
const PACKAGE_SHA256 = createHash('sha256').update(PACKAGE_BYTES).digest('hex');

const FILE_MANIFEST = {
  schemaVersion: 1,
  version: '1.2.3',
  files: [{ path: 'a.txt', size: 1, sha256: 'a'.repeat(64) }],
};
const FILE_MANIFEST_BYTES = Buffer.from(JSON.stringify(FILE_MANIFEST), 'utf8');
const FILE_MANIFEST_SHA256 = createHash('sha256').update(FILE_MANIFEST_BYTES).digest('hex');

const MANIFEST = {
  schemaVersion: 1,
  channel: 'internal',
  version: '1.2.3',
  minLauncherVersion: '1.0.0',
  packageUrl: 'https://api.rongyinghudong.com/updates/internal/1.2.3/portable.zip',
  packageSize: PACKAGE_BYTES.length,
  packageSha256: PACKAGE_SHA256,
  fileManifestSha256: FILE_MANIFEST_SHA256,
  publishedAt: '2026-09-22T00:00:00.000Z',
  mandatory: false,
  signature: 'c2lnbmF0dXJl',
};

function writeArtifacts(overrides = {}) {
  const root = makeRoot();
  const paths = {
    packagePath: join(root, 'portable.zip'),
    fileManifestPath: join(root, 'portable-files.json'),
    manifestPath: join(root, 'manifest.json'),
  };
  writeFileSync(paths.packagePath, overrides.packageBytes ?? PACKAGE_BYTES);
  writeFileSync(paths.fileManifestPath, overrides.fileManifestBytes ?? FILE_MANIFEST_BYTES);
  writeFileSync(paths.manifestPath, overrides.manifestText ?? JSON.stringify(overrides.manifest ?? MANIFEST));
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

test('the input rejects a missing host or known hosts path', () => {
  assert.throws(
    () => parsePublishInput({ channel: 'internal', version: '1.2.3', host: '', knownHostsPath: 'k' }),
    FeedPublishError,
  );
  assert.throws(
    () => parsePublishInput({ channel: 'internal', version: '1.2.3', host: 'h', knownHostsPath: '' }),
    FeedPublishError,
  );
});

test('the known hosts file must live outside the repository', () => {
  assert.throws(() => assertKnownHostsPath(join(process.cwd(), 'known_hosts'), process.cwd()), FeedPublishError);
  assert.equal(assertKnownHostsPath(join(tmpdir(), 'known_hosts'), process.cwd()), join(tmpdir(), 'known_hosts'));
});

test('the local verification accepts a self consistent triple', () => {
  const paths = writeArtifacts();
  const result = verifyLocalArtifacts({ ...paths, expectedChannel: 'internal', expectedVersion: '1.2.3' });
  assert.equal(result.packageSha256, PACKAGE_SHA256);
  assert.equal(result.packageSize, PACKAGE_BYTES.length);
  assert.equal(result.fileManifestSha256, FILE_MANIFEST_SHA256);
  assert.equal(result.packageUrl, MANIFEST.packageUrl);
});

test('the local verification rejects a package whose bytes do not match the manifest', () => {
  const paths = writeArtifacts({ packageBytes: Buffer.from('tampered', 'utf8') });
  assert.throws(
    () => verifyLocalArtifacts({ ...paths, expectedChannel: 'internal', expectedVersion: '1.2.3' }),
    /package integrity/i,
  );
});

test('the local verification rejects a file manifest whose bytes do not match the manifest', () => {
  const paths = writeArtifacts({ fileManifestBytes: Buffer.from('[]', 'utf8') });
  assert.throws(
    () => verifyLocalArtifacts({ ...paths, expectedChannel: 'internal', expectedVersion: '1.2.3' }),
    /file manifest/i,
  );
});

test('the local verification rejects a manifest for another channel or version', () => {
  const paths = writeArtifacts();
  assert.throws(
    () => verifyLocalArtifacts({ ...paths, expectedChannel: 'stable', expectedVersion: '1.2.3' }),
    /channel/i,
  );
  assert.throws(
    () => verifyLocalArtifacts({ ...paths, expectedChannel: 'internal', expectedVersion: '1.2.4' }),
    /version/i,
  );
});

test('the local verification rejects a package url that is not https or not in this channel', () => {
  const insecure = writeArtifacts({
    manifest: { ...MANIFEST, packageUrl: 'http://example.com/internal/1.2.3/portable.zip' },
  });
  assert.throws(
    () => verifyLocalArtifacts({ ...insecure, expectedChannel: 'internal', expectedVersion: '1.2.3' }),
    /package url/i,
  );
  const wrongChannel = writeArtifacts({
    manifest: { ...MANIFEST, packageUrl: 'https://api.rongyinghudong.com/updates/stable/1.2.3/portable.zip' },
  });
  assert.throws(
    () => verifyLocalArtifacts({ ...wrongChannel, expectedChannel: 'internal', expectedVersion: '1.2.3' }),
    /package url/i,
  );
});

test('the local verification reports a signature failure rather than trusting the payload', () => {
  const paths = writeArtifacts();
  const verified = verifyLocalArtifacts({
    ...paths,
    expectedChannel: 'internal',
    expectedVersion: '1.2.3',
    verifySignature: () => {
      throw new Error('release manifest signature is invalid');
    },
  });
  assert.equal(verified.signatureChecked, true);
});

test('the local verification surfaces the signature failure to the caller', () => {
  const paths = writeArtifacts();
  assert.throws(
    () =>
      verifyLocalArtifacts({
        ...paths,
        expectedChannel: 'internal',
        expectedVersion: '1.2.3',
        verifySignature: () => {
          throw new Error('release manifest signature is invalid');
        },
        requireSignature: true,
      }),
    /signature is invalid/i,
  );
});
```

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
import { resolve, sep } from 'node:path';

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
  if (typeof raw.host !== 'string' || raw.host.length === 0) {
    throw new FeedPublishError('the ssh host is required');
  }
  if (typeof raw.knownHostsPath !== 'string' || raw.knownHostsPath.length === 0) {
    throw new FeedPublishError('the pinned known hosts file is required');
  }
  return {
    channel: raw.channel,
    version: raw.version,
    host: raw.host,
    knownHostsPath: resolve(raw.knownHostsPath),
  };
}

export function assertKnownHostsPath(target, repositoryRoot) {
  const resolved = resolve(target);
  const root = resolve(repositoryRoot);
  if (resolved === root || resolved.startsWith(`${root}${sep}`)) {
    throw new FeedPublishError('the pinned known hosts file must live outside the repository');
  }
  return resolved;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function verifyLocalArtifacts(input) {
  const packageBytes = readFileSync(input.packagePath);
  const fileManifestBytes = readFileSync(input.fileManifestPath);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(input.manifestPath, 'utf8'));
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
  try {
    packageUrl = new URL(manifest.packageUrl);
  } catch {
    throw new FeedPublishError('the package url is not a valid url');
  }
  const expectedPath = `${new URL(PUBLIC_BASE_URL).pathname}/${manifest.channel}/${manifest.version}/${PORTABLE_PACKAGE_NAME}`;
  if (packageUrl.protocol !== 'https:' || packageUrl.pathname !== expectedPath) {
    throw new FeedPublishError('the package url does not point at this channel and version over https');
  }

  const requireSignature = input.requireSignature !== false;
  if (requireSignature) {
    if (typeof input.verifySignature !== 'function') {
      throw new FeedPublishError('a signature verifier is required before any network write');
    }
    input.verifySignature({ manifest, packagePath: input.packagePath, fileManifestPath: input.fileManifestPath });
  }

  return {
    manifest,
    packageSha256,
    packageSize: packageBytes.length,
    fileManifestSha256,
    fileManifestSize: fileManifestBytes.length,
    packageUrl: manifest.packageUrl,
    signatureChecked: typeof input.verifySignature === 'function',
  };
}
```

- [ ] **Step 4: 运行测试并确认通过**

```bash
node --test scripts/lib/feed-publish.test.mjs
```

预期：`fail 0`，`pass` 计数 > 0。

- [ ] **Step 5: 行为级变异验证**

1. 把 `CHANNELS.includes(raw.channel)` 改成 `typeof raw.channel === 'string'` ⇒ 预期 `the input rejects any channel outside the whitelist` **按测试名变红**。
2. 把包哈希比较整条删掉 ⇒ 预期 `the local verification rejects a package whose bytes do not match the manifest` **按测试名变红**。
3. 把 `packageUrl.protocol !== 'https:'` 里的协议判断删掉，只留路径判断 ⇒ 预期 `the local verification rejects a package url that is not https or not in this channel` 的 http 用例**按测试名变红**。
4. 把 `assertKnownHostsPath` 的目录判断改成永远返回 ⇒ 预期 `the known hosts file must live outside the repository` **按测试名变红**。

恢复后 `git diff` 为空且全绿。

- [ ] **Step 6: 提交**

```bash
git add scripts/lib/feed-publish.mjs scripts/lib/feed-publish.test.mjs
git commit -m "feat(feed): verify the release triple before any network write"
```

---

### Task 2: `--dry-run` 与只读 `--preflight`

**Files:**

- Modify: `scripts/lib/feed-publish.mjs`
- Modify: `scripts/lib/feed-publish.test.mjs`

**语义边界（规格 §6.3，必须体现在断言里）：** `--dry-run` **完全离线**，不得触碰 transport；`--preflight` **只读联网**，只能调用只读动作，并且**只能声明“可写性指标”**——它没有写过任何字节，因此不得报告“可写”或“已验证权限”。

- [ ] **Step 1: 写失败的测试**

追加到 `scripts/lib/feed-publish.test.mjs`：

```js
import { planCommit, runPreflight, PUBLISH_STAGES } from './feed-publish.mjs';

function fakeTransport(overrides = {}) {
  const calls = [];
  const record =
    (name) =>
    (...args) => {
      calls.push([name, ...args]);
      return overrides[name]?.(...args) ?? { status: 0, stdout: '', stderr: '' };
    };
  return {
    calls,
    readOnly: {
      sshRun: record('sshRun'),
    },
    write: {
      sftpUpload: record('sftpUpload'),
      sshRun: record('sshRunWrite'),
    },
    fetchPublic: record('fetchPublic'),
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
  const plan = planCommit({ channel: 'internal', version: '1.2.3' });
  assert.deepEqual(
    plan.map((entry) => entry.stage),
    [...PUBLISH_STAGES],
  );
  assert.equal(plan[0].stage, 'pre-verify');
  assert.equal(plan[plan.length - 1].stage, 'unlock');
});

test('the dry run never touches any transport', () => {
  const transport = fakeTransport();
  const paths = writeArtifacts();
  planCommit({
    channel: 'internal',
    version: '1.2.3',
    ...paths,
    dryRun: true,
    transport,
    verifySignature: () => {},
  });
  assert.deepEqual(transport.calls, []);
});

test('the preflight only performs read only actions', () => {
  const transport = fakeTransport({
    sshRun: () => ({ status: 0, stdout: `${UPDATE_ROOT}\n${STATE_ROOT}\n`, stderr: '' }),
  });
  const result = runPreflight({
    channel: 'internal',
    version: '1.2.3',
    host: 'example.invalid',
    transport,
    knownHostsPath: join(tmpdir(), 'known_hosts'),
  });
  const names = transport.calls.map((call) => call[0]);
  assert.deepEqual([...new Set(names)], ['sshRun']);
  assert.equal(result.writabilityIndicators.verifiedWrite, false);
});

test('the preflight reports uncertainty instead of claiming end to end writability', () => {
  const transport = fakeTransport();
  const result = runPreflight({
    channel: 'internal',
    version: '1.2.3',
    host: 'example.invalid',
    transport,
    knownHostsPath: join(tmpdir(), 'known_hosts'),
  });
  assert.equal(result.writabilityIndicators.verifiedWrite, false);
  assert.match(result.writabilityIndicators.note, /not verified|indicator/i);
});

test('the preflight detects two roots on different file systems', () => {
  const transport = fakeTransport({
    sshRun: () => ({ status: 0, stdout: 'device 100\n device 200\n', stderr: '' }),
  });
  const result = runPreflight({
    channel: 'internal',
    version: '1.2.3',
    host: 'example.invalid',
    transport,
    knownHostsPath: join(tmpdir(), 'known_hosts'),
  });
  assert.equal(result.sameFileSystem, false);
  assert.match(result.notes.join(' '), /file system/i);
});
```

**命名对齐（必须先执行）：** 上面的 `PUBLISH_STAGES` 顺序必须与规格 §6.5 的十三步一一对应。注意规格里第 12 步是「审计」、第 13 步是「释放锁」；实现里把「审计」表达为**贯穿全程的阶段记录器**，因此阶段名表用 `reveal`（公网复验之后的收口）与 `unlock` 收尾——**在写实现前先重读规格 §6.5 与 §6.11，确认名字与顺序后按本节写**；若你选择的命名与上面不同，把测试与实现**同时**改到位，不要只改一边。

- [ ] **Step 2: 运行测试并确认按测试名失败**

```bash
node --test scripts/lib/feed-publish.test.mjs
```

预期：`PUBLISH_STAGES`、`planCommit`、`runPreflight` 未定义。

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

export function planCommit(input) {
  const plan = PUBLISH_STAGES.map((stage) => ({ stage, status: 'pending' }));
  if (input.dryRun !== true) return plan;
  return plan;
}

export function runPreflight(input) {
  const notes = [];
  const probe = input.transport.readOnly.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `stat -c '%d %n' ${UPDATE_ROOT} ${STATE_ROOT}`,
  });
  const devices = String(probe.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(/\s+/u)[0]);

  const sameFileSystem = devices.length === 2 && devices[0] === devices[1];
  if (!sameFileSystem) {
    notes.push('the staging root and the update root do not report the same file system');
  }
  if (probe.status !== 0) {
    notes.push('the read only probe did not succeed');
  }

  return {
    sameFileSystem,
    notes,
    writabilityIndicators: {
      verifiedWrite: false,
      note: 'writability is an indicator read from the remote metadata, not verified: nothing was written yet',
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

1. 把 `PUBLISH_STAGES` 里 `'lock'` 与 `'stage'` 的位置互换 ⇒ 预期 `the commit plan lists the thirteen stages in the fixed order` **按测试名变红**。
2. 把 `runPreflight` 里的只读探测改成调用 `input.transport.write.sftpUpload` ⇒ 预期 `the preflight only performs read only actions` **按测试名变红**。
3. 把 `writabilityIndicators.verifiedWrite` 改成 `true` ⇒ 预期 `the preflight reports uncertainty instead of claiming end to end writability` **按测试名变红**。
4. 把 `sameFileSystem` 改成恒 `true` ⇒ 预期 `the preflight detects two roots on different file systems` **按测试名变红**。

恢复后全绿且 `git diff` 为空。

- [ ] **Step 6: 提交**

```bash
git add scripts/lib/feed-publish.mjs scripts/lib/feed-publish.test.mjs
git commit -m "feat(feed): separate an offline dry run from a read only preflight"
```

---

### Task 3: 频道锁、owner 与解锁的所有权前提

**Files:**

- Modify: `scripts/lib/feed-publish.mjs`
- Modify: `scripts/lib/feed-publish.test.mjs`

**必须在断言里固化的四条（规格 §6.6）：** ①锁用原子 `mkdir` 获取，失败即退出、不等待不强抢；②陈旧锁**不自动破除**；③解锁必须同时满足"本次运行成功获取过锁"且"`owner.json` 的 `runid` 与 `planHash` 与本次完全一致"；④**未取得锁时不得声称保留或释放一把不属于自己的锁**。

- [ ] **Step 1: 写失败的测试**

追加到 `scripts/lib/feed-publish.test.mjs`：

```js
import {
  LOCK_STATES,
  acquireChannelLock,
  breakChannelLock,
  planHashOf,
  resolveLockDisposition,
} from './feed-publish.mjs';

const PLAN_INPUT = {
  channel: 'internal',
  version: '1.2.3',
  packageSha256: 'a'.repeat(64),
  fileManifestSha256: 'b'.repeat(64),
  manifestSha256: 'c'.repeat(64),
};

test('the plan hash binds channel, version and all three artifact digests', () => {
  const base = planHashOf(PLAN_INPUT);
  assert.equal(base, planHashOf({ ...PLAN_INPUT }));
  assert.notEqual(base, planHashOf({ ...PLAN_INPUT, version: '1.2.4' }));
  assert.notEqual(base, planHashOf({ ...PLAN_INPUT, channel: 'stable' }));
  assert.notEqual(base, planHashOf({ ...PLAN_INPUT, packageSha256: 'd'.repeat(64) }));
  assert.notEqual(base, planHashOf({ ...PLAN_INPUT, fileManifestSha256: 'd'.repeat(64) }));
  assert.notEqual(base, planHashOf({ ...PLAN_INPUT, manifestSha256: 'd'.repeat(64) }));
});

test('the lock is acquired with an atomic mkdir and never steals an existing lock', () => {
  const transport = fakeTransport({ sshRun: () => ({ status: 1, stdout: 'exists', stderr: '' }) });
  const result = acquireChannelLock({
    channel: 'internal',
    transport,
    owner: { runid: 'r1', planHash: 'p1' },
    host: 'h',
    knownHostsPath: 'k',
  });
  assert.equal(result.acquired, false);
  assert.match(result.reason, /already locked/i);
  assert.equal(
    transport.calls.filter((call) => call[0] === 'sshRun' && /rmdir|rm -rf/u.test(String(call[2]?.script ?? '')))
      .length,
    0,
  );
});

test('a stale lock is refused rather than broken automatically', () => {
  const transport = fakeTransport({ sshRun: () => ({ status: 1, stdout: 'exists', stderr: '' }) });
  const result = acquireChannelLock({
    channel: 'internal',
    transport,
    owner: { runid: 'r1', planHash: 'p1' },
    host: 'h',
    knownHostsPath: 'k',
  });
  assert.equal(result.acquired, false);
  assert.equal(result.requiresExplicitRecovery, true);
});

test('the lock states are exactly the four documented ones', () => {
  assert.deepEqual([...LOCK_STATES], ['not-acquired', 'released', 'retained-by-this-run', 'ownership-unknown']);
});

test('the lock is released only when this run owns it and the outcome is safe to close', () => {
  const owner = { runid: 'r1', planHash: 'p1' };
  const verdict = resolveLockDisposition({
    acquisitionConfirmed: true,
    owner,
    runid: 'r1',
    planHash: 'p1',
    safeToExit: true,
  });
  assert.equal(verdict.release, true);
  assert.equal(verdict.state, 'released');
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
  assert.equal(verdict.release, false);
  assert.equal(verdict.state, 'retained-by-this-run');
  assert.equal(verdict.incident, false);
});

test('an unconfirmed acquisition is ownership unknown and never touches the lock', () => {
  const owner = { runid: 'r1', planHash: 'p1' };
  const verdict = resolveLockDisposition({
    acquisitionConfirmed: false,
    owner,
    runid: 'r1',
    planHash: 'p1',
    safeToExit: true,
  });
  assert.equal(verdict.release, false);
  assert.equal(verdict.state, 'ownership-unknown');
  assert.equal(verdict.incident, true);
  assert.match(verdict.reason, /cannot confirm/i);
});

test('the lock is never released when the owner belongs to another run', () => {
  const owner = { runid: 'other', planHash: 'p1' };
  const verdict = resolveLockDisposition({
    acquisitionConfirmed: true,
    owner,
    runid: 'r1',
    planHash: 'p1',
    safeToExit: true,
  });
  assert.equal(verdict.release, false);
  assert.equal(verdict.state, 'ownership-unknown');
  assert.equal(verdict.incident, true);
  assert.match(verdict.reason, /runid/u);
});

test('the lock is never released when the plan hash belongs to another run', () => {
  const owner = { runid: 'r1', planHash: 'other' };
  const verdict = resolveLockDisposition({
    acquisitionConfirmed: true,
    owner,
    runid: 'r1',
    planHash: 'p1',
    safeToExit: true,
  });
  assert.equal(verdict.release, false);
  assert.equal(verdict.state, 'ownership-unknown');
  assert.equal(verdict.incident, true);
  assert.match(verdict.reason, /planHash/u);
});

test('an unreadable owner record is ownership unknown and never broken silently', () => {
  const verdict = resolveLockDisposition({
    acquisitionConfirmed: true,
    owner: null,
    runid: 'r1',
    planHash: 'p1',
    safeToExit: true,
  });
  assert.equal(verdict.release, false);
  assert.equal(verdict.state, 'ownership-unknown');
  assert.equal(verdict.incident, true);
});

test('breaking a lock requires a reason and records the previous owner', () => {
  const transport = fakeTransport();
  assert.throws(
    () => breakChannelLock({ channel: 'internal', transport, host: 'h', knownHostsPath: 'k', reason: '' }),
    FeedPublishError,
  );
  const record = breakChannelLock({
    channel: 'internal',
    transport,
    host: 'h',
    knownHostsPath: 'k',
    reason: 'operator confirmed the previous run is not running',
    previousOwner: { runid: 'r0', planHash: 'p0' },
  });
  assert.equal(record.auditEntry.outcome, 'lock-broken');
  assert.equal(record.auditEntry.previousOwner.runid, 'r0');
});
```

- [ ] **Step 2: 运行测试并确认按测试名失败**

```bash
node --test scripts/lib/feed-publish.test.mjs
```

预期：四个新符号未定义。

- [ ] **Step 3: 写最小实现**

追加到 `scripts/lib/feed-publish.mjs`：

```js
export function planHashOf(input) {
  return sha256(
    Buffer.from(
      [input.channel, input.version, input.packageSha256, input.fileManifestSha256, input.manifestSha256].join('\n'),
      'utf8',
    ),
  );
}

function lockPath(channel) {
  return `${STATE_ROOT}/lock/${channel}`;
}

function ownerPath(channel) {
  return `${lockPath(channel)}/owner.json`;
}

export function acquireChannelLock(input) {
  const created = input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `mkdir ${lockPath(input.channel)}`,
  });
  if (created.status !== 0) {
    const owner = readOwnerRecord(input);
    return {
      acquired: false,
      reason: 'the channel is already locked',
      requiresExplicitRecovery: true,
      owner,
    };
  }
  input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `printf '%s' '${JSON.stringify(input.owner)}' > ${ownerPath(input.channel)}`,
  });
  return {
    acquired: true,
    owner: input.owner,
    requiresExplicitRecovery: false,
    ownerRecordPath: ownerPath(input.channel),
  };
}

function readOwnerRecord(input) {
  const read = input.transport.readOnly.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `cat ${ownerPath(input.channel)}`,
  });
  if (read.status !== 0) return null;
  try {
    return JSON.parse(String(read.stdout ?? ''));
  } catch {
    return null;
  }
}

export const LOCK_STATES = Object.freeze(['not-acquired', 'released', 'retained-by-this-run', 'ownership-unknown']);

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
    return {
      release: false,
      state: 'ownership-unknown',
      incident: true,
      reason: 'the owner record is unreadable, so the lock is left for a human',
    };
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

export function breakChannelLock(input) {
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
    throw new FeedPublishError('breaking a lock requires a written reason');
  }
  input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `rm -rf ${lockPath(input.channel)}`,
  });
  return {
    auditEntry: {
      outcome: 'lock-broken',
      reason: input.reason,
      previousOwner: input.previousOwner ?? null,
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

1. 把 `if (input.acquisitionConfirmed !== true)` 整条判断删掉 ⇒ 预期 `an unconfirmed acquisition is ownership unknown and never touches the lock` **按测试名变红**。
   1b. 把 `if (input.safeToExit !== true)` 那条分支删掉（直接落到 `released`）⇒ 预期 `a run that holds the lock but cannot close safely keeps it` **按测试名变红**。
2. 把 `input.owner.runid !== input.runid` 改成 `false` ⇒ 预期 `the lock is never released when the owner belongs to another run` **按测试名变红**。
3. 把 `input.owner.planHash !== input.planHash` 改成 `false` ⇒ 预期 `the lock is never released when the plan hash belongs to another run` **按测试名变红**。
4. 把 `acquireChannelLock` 在 `created.status !== 0` 时改成先 `rm -rf` 再重建 ⇒ 预期 `the lock is acquired with an atomic mkdir and never steals an existing lock` **按测试名变红**。
5. 把 `planHashOf` 里的 `input.channel` 从输入里去掉 ⇒ 预期 `the plan hash binds channel, version and all three artifact digests` **按测试名变红**。

恢复后全绿且 `git diff` 为空。

- [ ] **Step 6: 提交**

```bash
git add scripts/lib/feed-publish.mjs scripts/lib/feed-publish.test.mjs
git commit -m "feat(feed): make the channel lock owner aware and never steal it"
```

---

### Task 4: 固定时序、CAS 与不确定结果

**Files:**

- Modify: `scripts/lib/feed-publish.mjs`
- Modify: `scripts/lib/feed-publish.test.mjs`

**三条必须固化的行为（规格 §6.5、§6.6、§6.7）：** ①本地预验证必须发生在**任何**网络写之前；②CAS 基线不匹配 ⇒ `incident` + **保留锁**，且**不得自动翻转、回滚或删除孤儿版本目录**；③翻转后结果不确定时按公网 manifest 的 SHA-256 三分。

- [ ] **Step 1: 写失败的测试**

追加到 `scripts/lib/feed-publish.test.mjs`：

```js
import { runCommit } from './feed-publish.mjs';

const BASELINE_BODY = '{"baseline":true}\n';
const NEW_BODY = '{"new":true}\n';
const THIRD_BODY = '{"third":true}\n';
const digestOf = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const BASELINE_SHA = digestOf(BASELINE_BODY);
const NEW_SHA = digestOf(NEW_BODY);
const THIRD_SHA = digestOf(THIRD_BODY);

function commitTransport({
  casDrift = false,
  publicBody = BASELINE_BODY,
  publicStatus = 200,
  uploadStatus = 0,
  versionStatus = 0,
  lockStatus = 0,
  versionDirExists = false,
  versionDirMatches = true,
  versionDirHasExtraEntry = false,
  versionDirDigestDiffers = false,
} = {}) {
  const calls = [];
  let manifestReads = 0;
  let ownerJson = null;
  const listing = `f ${PORTABLE_PACKAGE_NAME} ${PACKAGE_BYTES.length}\nf ${PORTABLE_FILE_MANIFEST_NAME} ${FILE_MANIFEST_BYTES.length}\n`;
  const digests = (directory, zipDigest) =>
    `${zipDigest}  ${directory}/${PORTABLE_PACKAGE_NAME}\n${FILE_MANIFEST_SHA256}  ${directory}/${PORTABLE_FILE_MANIFEST_NAME}\n`;
  return {
    calls,
    readOnly: {
      sshRun: (request) => {
        calls.push(['sshRun', request.script]);
        if (/owner\.json/u.test(request.script)) {
          return ownerJson === null
            ? { status: 1, stdout: '', stderr: 'no such file' }
            : { status: 0, stdout: ownerJson, stderr: '' };
        }
        if (/-mindepth 1 -maxdepth 1 -printf/u.test(request.script)) {
          if (request.script.includes('/staging/')) return { status: 0, stdout: listing, stderr: '' };
          if (!versionDirExists) return { status: 0, stdout: '', stderr: '' };
          if (versionDirHasExtraEntry) return { status: 0, stdout: `${listing}f extra.bin 3\n`, stderr: '' };
          if (!versionDirMatches) {
            return {
              status: 0,
              stdout: `f ${PORTABLE_PACKAGE_NAME} ${PACKAGE_BYTES.length + 1}\nf ${PORTABLE_FILE_MANIFEST_NAME} ${FILE_MANIFEST_BYTES.length}\n`,
              stderr: '',
            };
          }
          return { status: 0, stdout: listing, stderr: '' };
        }
        if (/sha256sum .*portable-files\.json/u.test(request.script)) {
          const directory = request.script.includes('/staging/')
            ? `${STATE_ROOT}/staging/internal/1.2.3`
            : `${UPDATE_ROOT}/internal/1.2.3`;
          if (!request.script.includes('/staging/') && !versionDirExists) {
            return { status: 0, stdout: '', stderr: '' };
          }
          const zipDigest = versionDirDigestDiffers ? THIRD_SHA : PACKAGE_SHA256;
          return { status: 0, stdout: digests(directory, zipDigest), stderr: '' };
        }
        if (/manifest\.json/u.test(request.script)) {
          manifestReads += 1;
          const digest = casDrift && manifestReads > 1 ? THIRD_SHA : BASELINE_SHA;
          return { status: 0, stdout: `${digest}  ${UPDATE_ROOT}/internal/manifest.json\n`, stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    },
    write: {
      sshRun: (request) => {
        calls.push(['sshRunWrite', request.script]);
        if (/mkdir .*lock/u.test(request.script)) {
          return lockStatus === 0
            ? { status: 0, stdout: '', stderr: '' }
            : { status: lockStatus, stdout: 'exists', stderr: '' };
        }
        if (/^mv \/opt\/rongying\/updates-state\/staging\//u.test(request.script)) {
          return versionStatus === 0
            ? { status: 0, stdout: '', stderr: '' }
            : { status: versionStatus, stdout: '', stderr: 'commit failed' };
        }
        const ownerMatch = /printf '%s' '(\{.*\})' >/u.exec(request.script);
        if (ownerMatch !== null) ownerJson = ownerMatch[1];
        return { status: 0, stdout: '', stderr: '' };
      },
      sftpUpload: () => {
        calls.push(['sftpUpload']);
        return uploadStatus === 0
          ? { status: 0, bytesSent: 1 }
          : { status: uploadStatus, bytesSent: 0, stderr: 'connection lost' };
      },
    },
    fetchPublic: (url) => {
      calls.push(['fetchPublic', url]);
      return { status: publicStatus, body: publicBody };
    },
  };
}

function commitInput(transport, overrides = {}) {
  const paths = writeArtifacts();
  return {
    channel: 'internal',
    version: '1.2.3',
    host: 'example.invalid',
    knownHostsPath: join(tmpdir(), 'known_hosts'),
    runid: 'r1',
    baselineManifestSha: BASELINE_SHA,
    newManifestSha: NEW_SHA,
    transport,
    verifySignature: () => {},
    ...paths,
    ...overrides,
  };
}

function stageStatus(result, stage) {
  return result.stages.find((entry) => entry.stage === stage).status;
}

test('the local pre-verification happens before any network write', () => {
  const transport = commitTransport();
  const input = commitInput(transport);
  runCommit({ ...input, packagePath: join(makeRoot(), 'missing.zip') });
  const writes = transport.calls.filter((call) => call[0] === 'sftpUpload' || call[0] === 'sshRunWrite');
  assert.deepEqual(writes, []);
});

test('a clean publish walks every stage and releases its own lock', () => {
  const transport = commitTransport();
  const result = runCommit(commitInput(transport));
  assert.equal(result.outcome, 'done', result.reason);
  assert.deepEqual(
    result.stages.map((entry) => entry.status),
    PUBLISH_STAGES.map(() => 'done'),
  );
});

test('a cas mismatch is an incident that keeps the lock and never rolls anything back', () => {
  const transport = commitTransport({ casDrift: true });
  const result = runCommit(commitInput(transport));
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.equal(stageStatus(result, 're-verify'), 'done');
  assert.equal(stageStatus(result, 'cas'), 'incident');
  assert.equal(stageStatus(result, 'flip'), 'pending');
  const destructive = transport.calls.filter((call) => /rm -rf|mv -f|rmdir/u.test(String(call[1] ?? '')));
  assert.deepEqual(destructive, []);
});

test('an indeterminate outcome with the old public sha allows a retry and keeps the lock', () => {
  const transport = commitTransport({ publicBody: BASELINE_BODY });
  const result = runCommit(commitInput(transport));
  assert.equal(result.outcome, 'retry');
  assert.equal(result.lockState, 'retained-by-this-run');
});

test('an indeterminate outcome with a third public sha stops and keeps the lock', () => {
  const transport = commitTransport({ publicBody: THIRD_BODY });
  const result = runCommit(commitInput(transport));
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.match(result.reason, /third/i);
});

test('a staging failure is a plain failure and reports that no lock was acquired', () => {
  const transport = commitTransport({ uploadStatus: 1 });
  const result = runCommit(commitInput(transport));
  assert.equal(result.outcome, 'fail');
  assert.equal(result.lockState, 'not-acquired');
  assert.equal(stageStatus(result, 'lock'), 'pending');
});

test('a failure after the lock but before the flip releases the lock this run owns', () => {
  const transport = commitTransport({ versionStatus: 1 });
  const result = runCommit(commitInput(transport));
  assert.equal(result.outcome, 'fail');
  assert.equal(result.lockState, 'released');
  assert.equal(stageStatus(result, 'lock'), 'done');
  assert.equal(stageStatus(result, 'unlock'), 'done');
  assert.equal(stageStatus(result, 'flip'), 'pending');
});

test('a lost receipt after the flip retains the lock instead of claiming a result', () => {
  const transport = commitTransport({ publicStatus: 0 });
  const result = runCommit(commitInput(transport));
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.match(result.reason, /uncertain/i);
});

test('the commit never runs and reports not-acquired when the lock cannot be taken', () => {
  const transport = commitTransport({ lockStatus: 1 });
  const result = runCommit(commitInput(transport));
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.lockState, 'not-acquired');
  assert.equal(stageStatus(result, 'commit-version'), 'pending');
  const unlocked = transport.calls.filter((call) => call[0] === 'sshRunWrite' && /rmdir/u.test(String(call[1])));
  assert.deepEqual(unlocked, []);
});

test('an existing version directory with identical bytes is reused instead of refused', () => {
  const transport = commitTransport({ versionDirExists: true, versionDirMatches: true });
  const result = runCommit(commitInput(transport));
  assert.equal(result.outcome, 'done', result.reason);
  assert.equal(stageStatus(result, 'commit-version'), 'done');
});

test('an existing version directory with different bytes stops immediately and releases the lock', () => {
  const transport = commitTransport({ versionDirExists: true, versionDirMatches: false });
  const result = runCommit(commitInput(transport));
  assert.equal(result.outcome, 'fail');
  assert.equal(result.lockState, 'released');
  assert.equal(stageStatus(result, 'commit-version'), 'fail');
  assert.equal(stageStatus(result, 'flip'), 'pending');
  assert.match(result.reason, /size/u);
});

test('an existing version directory carrying an extra file is refused', () => {
  const transport = commitTransport({ versionDirExists: true, versionDirHasExtraEntry: true });
  const result = runCommit(commitInput(transport));
  assert.equal(result.outcome, 'fail');
  assert.equal(result.lockState, 'released');
  assert.match(result.reason, /unexpected entry/u);
});

test('an existing version directory whose digest differs is refused', () => {
  const transport = commitTransport({ versionDirExists: true, versionDirDigestDiffers: true });
  const result = runCommit(commitInput(transport));
  assert.equal(result.outcome, 'fail');
  assert.match(result.reason, /digest/u);
});

test('the version directory is committed with a single directory rename', () => {
  const transport = commitTransport();
  const result = runCommit(commitInput(transport));
  assert.equal(result.outcome, 'done', result.reason);
  const renames = transport.calls.filter(
    (call) => call[0] === 'sshRunWrite' && String(call[1]).startsWith('mv /opt/rongying/updates-state/staging/'),
  );
  assert.equal(renames.length, 1);
  const perFileMoves = transport.calls.filter(
    (call) =>
      call[0] === 'sshRunWrite' &&
      /mv -f [^\n]*portable(\.zip|-files\.json)\.part-/u.test(String(call[1])) &&
      !String(call[1]).includes('/staging/'),
  );
  assert.deepEqual(perFileMoves, []);
});
```

- [ ] **Step 2: 运行测试并确认按测试名失败**

```bash
node --test scripts/lib/feed-publish.test.mjs
```

预期：`runCommit` 未定义。

- [ ] **Step 3: 写最小实现**

追加到 `scripts/lib/feed-publish.mjs`：

```js
function stageRecord(stages, stage, status, detail = null) {
  const entry = stages.find((item) => item.stage === stage);
  entry.status = status;
  if (detail !== null) entry.detail = detail;
  return entry;
}

export function runCommit(input) {
  const stages = PUBLISH_STAGES.map((stage) => ({ stage, status: 'pending' }));
  const runid = input.runid;
  let acquisitionConfirmed = false;
  let planHash = input.planHash ?? 'uncomputed';
  let owner = null;

  const finish = (outcome, reason, lockState) => ({
    outcome,
    reason,
    lockState,
    stages,
    runid,
    planHash,
  });

  const retainAndFinish = (outcome, reason) => {
    const release = resolveLockDisposition({ acquisitionConfirmed, owner, runid, planHash, safeToExit: false });
    stageRecord(stages, 'unlock', 'retained', release.reason);
    return finish(outcome, reason, release.state);
  };

  const releaseAndFinish = (failedStage, outcome, reason) => {
    stageRecord(stages, failedStage, 'fail', reason);
    const release = resolveLockDisposition({ acquisitionConfirmed, owner, runid, planHash, safeToExit: true });
    if (release.release !== true) {
      stageRecord(stages, 'unlock', release.incident ? 'incident' : 'retained', release.reason);
      return finish(release.incident ? 'incident' : 'fail', reason, release.state);
    }
    input.transport.write.sshRun({
      host: input.host,
      knownHostsPath: input.knownHostsPath,
      script: `rmdir ${lockPath(input.channel)}`,
    });
    stageRecord(stages, 'unlock', 'done');
    return finish(outcome, reason, release.state);
  };

  let local;
  try {
    local = verifyLocalArtifacts({ ...input, requireSignature: true });
  } catch (error) {
    stageRecord(stages, 'pre-verify', 'fail', error.message);
    return finish('fail', error.message, 'not-acquired');
  }
  planHash = planHashOf({
    channel: input.channel,
    version: input.version,
    packageSha256: local.packageSha256,
    fileManifestSha256: local.fileManifestSha256,
    manifestSha256: sha256(readFileSync(input.manifestPath)),
  });
  stageRecord(stages, 'pre-verify', 'done');

  const versionRoot = `${UPDATE_ROOT}/${input.channel}/${input.version}`;
  const stagingRoot = `${STATE_ROOT}/staging/${input.channel}/${input.version}`;

  for (const name of [PORTABLE_PACKAGE_NAME, PORTABLE_FILE_MANIFEST_NAME]) {
    const uploaded = input.transport.write.sftpUpload({
      localPath: name === PORTABLE_PACKAGE_NAME ? input.packagePath : input.fileManifestPath,
      remotePath: `${stagingRoot}/${name}.part-${runid}`,
      resume: true,
    });
    if (uploaded.status !== 0) {
      stageRecord(stages, 'stage', 'fail', uploaded.stderr ?? 'upload failed');
      return finish('fail', 'the staging upload failed', 'not-acquired');
    }
  }

  const finalised = input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: [
      `mv -f ${stagingRoot}/${PORTABLE_PACKAGE_NAME}.part-${runid} ${stagingRoot}/${PORTABLE_PACKAGE_NAME}`,
      `mv -f ${stagingRoot}/${PORTABLE_FILE_MANIFEST_NAME}.part-${runid} ${stagingRoot}/${PORTABLE_FILE_MANIFEST_NAME}`,
    ].join(' && '),
  });
  if (finalised.status !== 0) {
    stageRecord(stages, 'stage', 'fail', 'the staging directory could not be finalised');
    return finish('fail', 'the staging directory could not be finalised', 'not-acquired');
  }
  stageRecord(stages, 'stage', 'done');

  const expectedEntries = [
    { name: PORTABLE_PACKAGE_NAME, size: local.packageSize, sha256: local.packageSha256 },
    { name: PORTABLE_FILE_MANIFEST_NAME, size: local.fileManifestSize, sha256: local.fileManifestSha256 },
  ];

  const staging = inspectRemoteVersionDirectory(input, stagingRoot, expectedEntries);
  if (!staging.present || staging.problems.length > 0) {
    const detail = staging.present ? staging.problems.join('; ') : 'the staging directory is missing';
    stageRecord(stages, 'remote-verify', 'fail', detail);
    return finish('fail', `the staging directory is not the exact final file set: ${detail}`, 'not-acquired');
  }
  stageRecord(stages, 'remote-verify', 'done');

  const lock = acquireChannelLock({
    channel: input.channel,
    transport: input.transport,
    owner: { runid, planHash },
    host: input.host,
    knownHostsPath: input.knownHostsPath,
  });
  if (lock.acquired !== true) {
    stageRecord(stages, 'lock', 'blocked', lock.reason);
    return finish('blocked', lock.reason, 'not-acquired');
  }
  acquisitionConfirmed = true;
  stageRecord(stages, 'lock', 'done');

  owner = readOwnerRecord(input);
  const baseline = input.transport.readOnly.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `sha256sum ${UPDATE_ROOT}/${input.channel}/${PORTABLE_MANIFEST_NAME} || true`,
  });
  const baselineSha = String(baseline.stdout ?? '').split(/\s+/u)[0] || 'absent';
  if (String(baselineSha) !== String(input.baselineManifestSha ?? baselineSha)) {
    stageRecord(stages, 're-verify', 'incident');
    return retainAndFinish('incident', 'the manifest changed between the preflight and the lock');
  }
  const stagingAfterLock = inspectRemoteVersionDirectory(input, stagingRoot, expectedEntries);
  if (!stagingAfterLock.present || stagingAfterLock.problems.length > 0) {
    stageRecord(stages, 're-verify', 'incident', stagingAfterLock.problems.join('; '));
    return retainAndFinish('incident', 'the staging bytes changed while the lock was being taken');
  }
  stageRecord(stages, 're-verify', 'done');

  const existing = inspectRemoteVersionDirectory(input, versionRoot, expectedEntries);
  if (existing.present && existing.problems.length > 0) {
    return releaseAndFinish(
      'commit-version',
      'fail',
      `the immutable version directory already exists and does not match: ${existing.problems.join('; ')}`,
    );
  }

  if (existing.present) {
    stageRecord(stages, 'commit-version', 'done', 'the immutable version directory already matched every byte');
  } else {
    const committed = input.transport.write.sshRun({
      host: input.host,
      knownHostsPath: input.knownHostsPath,
      script: `mv ${stagingRoot} ${versionRoot}`,
    });
    if (committed.status !== 0) {
      return releaseAndFinish('commit-version', 'fail', 'the version directory was not committed');
    }
    stageRecord(stages, 'commit-version', 'done');
  }

  input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `cp ${UPDATE_ROOT}/${input.channel}/${PORTABLE_MANIFEST_NAME} ${STATE_ROOT}/backup/${input.channel}-manifest.json-pre-${input.version} 2>/dev/null || true`,
  });
  stageRecord(stages, 'backup-manifest', 'done');

  const cas = input.transport.readOnly.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `sha256sum ${UPDATE_ROOT}/${input.channel}/${PORTABLE_MANIFEST_NAME} || true`,
  });
  const casSha = String(cas.stdout ?? '').split(/\s+/u)[0] || 'absent';
  if (String(casSha) !== String(baselineSha)) {
    stageRecord(stages, 'cas', 'incident');
    return retainAndFinish(
      'incident',
      'the manifest changed after the lock was taken, which means a bypass; nothing is flipped, rolled back or deleted',
    );
  }
  stageRecord(stages, 'cas', 'done');

  input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `cp ${input.manifestPath} ${UPDATE_ROOT}/${input.channel}/${PORTABLE_MANIFEST_NAME}.${runid}.tmp`,
  });
  stageRecord(stages, 'temp-manifest', 'done');

  input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `mv -f ${UPDATE_ROOT}/${input.channel}/${PORTABLE_MANIFEST_NAME}.${runid}.tmp ${UPDATE_ROOT}/${input.channel}/${PORTABLE_MANIFEST_NAME}`,
  });
  stageRecord(stages, 'flip', 'done');

  const observed = input.transport.fetchPublic(`${PUBLIC_BASE_URL}/${input.channel}/${PORTABLE_MANIFEST_NAME}`);
  if (observed.status !== 200 || typeof observed.body !== 'string') {
    stageRecord(stages, 'public-verify', 'incident');
    return retainAndFinish('incident', 'the public manifest could not be read, so the outcome is uncertain');
  }
  const observedSha = sha256(Buffer.from(observed.body, 'utf8'));
  if (observedSha === input.newManifestSha) {
    stageRecord(stages, 'public-verify', 'done');
    stageRecord(stages, 'reveal', 'done');
  } else if (observedSha === input.baselineManifestSha) {
    stageRecord(stages, 'public-verify', 'retry');
    return retainAndFinish('retry', 'the flip did not take effect');
  } else {
    stageRecord(stages, 'public-verify', 'incident');
    return retainAndFinish('incident', 'a third manifest digest appeared while flipping');
  }

  const release = resolveLockDisposition({
    acquisitionConfirmed,
    owner,
    runid,
    planHash,
    safeToExit: true,
  });
  if (release.release !== true) {
    stageRecord(stages, 'unlock', release.incident ? 'incident' : 'retained', release.reason);
    return finish(release.incident ? 'incident' : 'retry', release.reason, release.state);
  }
  input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `rmdir ${lockPath(input.channel)}`,
  });
  stageRecord(stages, 'unlock', 'done');
  return finish('done', 'published', 'released');
}

function readRemoteDirectory(input, directory) {
  const listing = input.transport.readOnly.sshRun({
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
    if (!expected.some((item) => item.name === entry.name)) {
      problems.push(`${entry.name} is an unexpected entry`);
    }
  }
  return problems;
}

function readRemoteHashes(input, directory, names) {
  const result = input.transport.readOnly.sshRun({
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

function compareDirectoryHashes(hashes, expected) {
  if (hashes === null) return ['the remote digests could not be read'];
  const problems = [];
  for (const item of expected) {
    if (hashes.get(item.name) !== item.sha256) {
      problems.push(`${item.name} does not carry the expected digest`);
    }
  }
  return problems;
}

function inspectRemoteVersionDirectory(input, directory, expectedEntries) {
  const entries = readRemoteDirectory(input, directory);
  if (entries.length === 0) return { present: false, problems: [] };
  const problems = compareDirectoryEntries(entries, expectedEntries);
  if (problems.length === 0) {
    const hashes = readRemoteHashes(
      input,
      directory,
      expectedEntries.map((item) => item.name),
    );
    problems.push(...compareDirectoryHashes(hashes, expectedEntries));
  }
  return { present: true, problems };
}
```

- [ ] **Step 4: 运行测试并确认通过**

```bash
node --test scripts/lib/feed-publish.test.mjs
```

预期：`fail 0`。

- [ ] **Step 5: 行为级变异验证**

1. 把 `verifyLocalArtifacts` 调用移到 `stage` 阶段之后 ⇒ 预期 `the local pre-verification happens before any network write` **按测试名变红**。
2. 把 CAS 不匹配分支的 `finish('incident', ..., true)` 改成 `finish('fail', ..., false)` ⇒ 预期 `a cas mismatch is an incident that keeps the lock and never rolls anything back` **按测试名变红**。
3. 在 CAS 不匹配分支里加一句 `rm -rf ${versionRoot}` ⇒ 预期同一测试的 `destructive` 断言 **按测试名变红**。
4. 把三种公网 SHA 的分支里 `'third'` 那条改成 `finish('retry', ...)` ⇒ 预期 `an indeterminate outcome with a third public sha stops and keeps the lock` **按测试名变红**。
5. 把 `lock.acquired !== true` 的返回从 `'blocked'` 改成继续执行 ⇒ 预期 `the commit never runs when this run did not acquire the lock` **按测试名变红**。
6. 把 `releaseAndFinish` 里的 `resolveLockDisposition` 调用删掉、直接 `rmdir` ⇒ 预期 Task 3 的 `the lock is never released when the owner belongs to another run` 与 `an unconfirmed acquisition is ownership unknown and never touches the lock` **按测试名变红**。
7. 把 `releaseAndFinish` 里的 `rmdir` 调用删掉（直接返回）⇒ 预期 `a failure after the lock but before the flip releases the lock this run owns` **按测试名变红**。
8. 把“版本目录已存在且完全一致”的分支改成一律 `releaseAndFinish`（即退回“简单拒绝”）⇒ 预期 `an existing version directory with identical bytes is reused instead of refused` **按测试名变红**。
9. 把 `inspectRemoteVersionDirectory` 里的 `compareDirectoryEntries` 调用删掉，只保留 `present` 判断 ⇒ 预期 `an existing version directory whose file sizes differ is refused` 与 `…carrying an extra file is refused` **按测试名变红**。
10. 把 `compareDirectoryHashes` 调用删掉 ⇒ 预期 `an existing version directory whose digest differs is refused` **按测试名变红**。
11. 把 `readRemoteDirectory` 里的 `entry.type !== 'f'` 检查删掉 ⇒ 预期 `an existing version directory carrying an extra file is refused` 之外的符号链接用例（若你补了链接用例）**按测试名变红**；若没补链接用例，本变异**不适用**，按"未验证"记账。
12. 把 `commit-version` 的单次目录 `mv` 改回 `mkdir -p` + 两次逐文件 `mv` ⇒ 预期 `the version directory is committed with a single directory rename` **按测试名变红**。
13. 把 `stage` 阶段里 staging 内的 `.part-` → 最终名 的 `mv -f` 删掉 ⇒ 预期 `a staging failure is a plain failure and reports that no lock was acquired` 之外的 staging 完整性用例（`the staging directory is not the exact final file set`）**按测试名变红**；若该路径未被独立用例覆盖，**按"未验证"记账**并在 Step 4 补一条用例。

恢复后全绿且 `git diff` 为空。

- [ ] **Step 6: 提交**

```bash
git add scripts/lib/feed-publish.mjs scripts/lib/feed-publish.test.mjs
git commit -m "feat(feed): publish in the fixed order and keep the lock when unsure"
```

---

### Task 5: 公网复验、逐阶段审计与 `internal → stable` 重签

**Files:**

- Modify: `scripts/lib/feed-publish.mjs`
- Modify: `scripts/lib/feed-publish.test.mjs`

- [ ] **Step 1: 写失败的测试**

追加到 `scripts/lib/feed-publish.test.mjs`：

```js
import { appendAuditStage, verifyPublicArtifacts, buildStableManifestInput } from './feed-publish.mjs';

test('the audit log is appended stage by stage and never only at the end', () => {
  const root = makeRoot();
  const auditOut = join(root, 'audit.jsonl');
  appendAuditStage({ auditOut, entry: { stage: 'open', runid: 'r1' } });
  appendAuditStage({ auditOut, entry: { stage: 'pre-verify', status: 'done', runid: 'r1' } });
  const lines = readFileSync(auditOut, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).stage, 'open');
  assert.equal(JSON.parse(lines[1]).status, 'done');
});

test('the audit log refuses to write inside the repository', () => {
  assert.throws(
    () => appendAuditStage({ auditOut: join(process.cwd(), 'audit.jsonl'), entry: {}, repositoryRoot: process.cwd() }),
    FeedPublishError,
  );
});

test('the public verification recomputes both artifact digests over https', () => {
  const calls = [];
  const transport = {
    fetchPublic: (url) => {
      calls.push(url);
      if (url.endsWith(PORTABLE_PACKAGE_NAME)) return { status: 200, body: PACKAGE_BYTES.toString('binary') };
      if (url.endsWith(PORTABLE_FILE_MANIFEST_NAME))
        return { status: 200, body: FILE_MANIFEST_BYTES.toString('binary') };
      return { status: 404, body: '' };
    },
  };
  const result = verifyPublicArtifacts({
    channel: 'internal',
    version: '1.2.3',
    transport,
    expectedPackageSha256: PACKAGE_SHA256,
    expectedFileManifestSha256: FILE_MANIFEST_SHA256,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
});

test('the public verification fails when the served package differs', () => {
  const transport = {
    fetchPublic: (url) =>
      url.endsWith(PORTABLE_PACKAGE_NAME)
        ? { status: 200, body: 'other-bytes' }
        : { status: 200, body: FILE_MANIFEST_BYTES.toString('binary') },
  };
  const result = verifyPublicArtifacts({
    channel: 'internal',
    version: '1.2.3',
    transport,
    expectedPackageSha256: PACKAGE_SHA256,
    expectedFileManifestSha256: FILE_MANIFEST_SHA256,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /package/i);
});

test('the stable manifest is re-signed with the stable channel and the stable url', () => {
  const input = buildStableManifestInput({
    version: '1.2.3',
    minLauncherVersion: '1.0.0',
    fileManifest: FILE_MANIFEST,
    fileManifestBytes: FILE_MANIFEST_BYTES,
    packagePath: '/tmp/portable.zip',
    publishedAt: '2026-09-22T00:00:00.000Z',
  });
  assert.equal(input.channel, 'stable');
  assert.equal(input.baseUrl, PUBLIC_BASE_URL);
  assert.equal(input.version, '1.2.3');
  assert.equal(input.fileManifestBytes, FILE_MANIFEST_BYTES);
  assert.equal(Object.hasOwn(input, 'manifestBytes'), false);
});

test('the stable input never accepts a pre-built manifest to copy', () => {
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
    /must be signed on its own/i,
  );
});
```

- [ ] **Step 2: 运行测试并确认按测试名失败**

```bash
node --test scripts/lib/feed-publish.test.mjs
```

预期：三个新符号未定义。

- [ ] **Step 3: 写最小实现**

追加到 `scripts/lib/feed-publish.mjs`（补 `appendFileSync` 从 `node:fs` 的导入）：

```js
export function appendAuditStage(input) {
  if (typeof input.repositoryRoot === 'string' && input.repositoryRoot.length > 0) {
    assertKnownHostsPath(input.auditOut, input.repositoryRoot);
  }
  appendFileSync(input.auditOut, `${JSON.stringify(input.entry)}\n`, 'utf8');
  return input.auditOut;
}

export function verifyPublicArtifacts(input) {
  const base = `${PUBLIC_BASE_URL}/${input.channel}/${input.version}`;
  const packageResponse = input.transport.fetchPublic(`${base}/${PORTABLE_PACKAGE_NAME}`);
  if (packageResponse.status !== 200) {
    return { ok: false, reason: 'the public package is not reachable' };
  }
  const packageSha256 = sha256(Buffer.from(packageResponse.body, 'binary'));
  if (packageSha256 !== input.expectedPackageSha256) {
    return { ok: false, reason: 'the public package integrity check failed' };
  }
  const fileManifestResponse = input.transport.fetchPublic(`${base}/${PORTABLE_FILE_MANIFEST_NAME}`);
  if (fileManifestResponse.status !== 200) {
    return { ok: false, reason: 'the public file manifest is not reachable' };
  }
  const fileManifestSha256 = sha256(Buffer.from(fileManifestResponse.body, 'binary'));
  if (fileManifestSha256 !== input.expectedFileManifestSha256) {
    return { ok: false, reason: 'the public file manifest integrity check failed' };
  }
  return { ok: true, packageSha256, fileManifestSha256 };
}

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

1. 把 `appendAuditStage` 改成把全部条目攒进数组最后写一次 ⇒ 预期 `the audit log is appended stage by stage and never only at the end` **按测试名变红**。
2. 把 `verifyPublicArtifacts` 里包哈希比较删掉 ⇒ 预期 `the public verification fails when the served package differs` **按测试名变红**。
3. 把 `buildStableManifestInput` 的 `manifestBytes` 守卫删掉 ⇒ 预期 `the stable input never accepts a pre-built manifest to copy` **按测试名变红**。
4. 把 `channel: 'stable'` 改成 `input.channel` ⇒ 预期 `the stable manifest is re-signed with the stable channel and the stable url` **按测试名变红**。

恢复后全绿且 `git diff` 为空。

- [ ] **Step 6: 提交**

```bash
git add scripts/lib/feed-publish.mjs scripts/lib/feed-publish.test.mjs
git commit -m "feat(feed): verify over the public url and re-sign for the stable channel"
```

---

### Task 6: 真实 SSH / SFTP / https transport

**Files:**

- Create: `scripts/lib/feed-publish-transport.mjs`
- Test: `scripts/lib/feed-publish-transport.test.mjs`

**规格要求（§6.3、§6.4、§6.8）：** `ssh` 与 `sftp` 用**参数数组**调用，**禁止**拼接本地 shell 命令；强制 `BatchMode=yes`；强制 `StrictHostKeyChecking=yes`；强制使用操作员提供的**仓库外** known_hosts；主机、known_hosts、审计路径都由显式参数传入；**不硬编码服务器、账号、指纹或凭据**。

**可测性：** 本模块把 `execFile` 与 `fetch` 作为**注入**依赖，因此全部测试用假实现，**绝不连网**。"本轮不连接服务器"不等于"不实现网络适配器"——本刀就是那个适配器。

- [ ] **Step 1: 写失败的测试**

创建 `scripts/lib/feed-publish-transport.test.mjs`：

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { FeedTransportError, createFeedTransport } from './feed-publish-transport.mjs';

const KNOWN_HOSTS = '/outside/repo/known_hosts';
const HOST = 'updates.example.invalid';

function makeFake({ status = 0, stdout = '', stderr = '', error = null } = {}) {
  const calls = [];
  const execFile = (command, args, options) => {
    calls.push({ command, args, options });
    return { status, stdout, stderr, error };
  };
  return { calls, execFile };
}

function makeTransport(overrides = {}) {
  return createFeedTransport({
    host: HOST,
    knownHostsPath: KNOWN_HOSTS,
    execFile: overrides.execFile,
    fetchPublic: overrides.fetchPublic,
    sftpBatchFile: overrides.sftpBatchFile ?? '/outside/repo/batch.txt',
  });
}

test('every ssh call carries the pinned host key options as separate argv entries', () => {
  const fake = makeFake({ stdout: 'ok' });
  const transport = makeTransport({ execFile: fake.execFile });
  const result = transport.readOnly.sshRun({ script: 'ls /opt' });

  assert.equal(result.status, 0);
  assert.equal(fake.calls.length, 1);
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
  assert.equal(call.args[call.args.length - 2], HOST);
  assert.equal(call.args[call.args.length - 1], 'ls /opt');
  assert.equal(call.options.shell, undefined);
});

test('no ssh option ever relaxes host key checking', () => {
  const fake = makeFake();
  makeTransport({ execFile: fake.execFile }).readOnly.sshRun({ script: 'ls' });
  const joined = fake.calls[0].args.join(' ');
  assert.doesNotMatch(joined, /StrictHostKeyChecking=no/u);
  assert.doesNotMatch(joined, /StrictHostKeyChecking=accept-new/u);
  assert.doesNotMatch(joined, /UserKnownHostsFile=\/dev\/null/u);
});

test('a missing known hosts path is refused before any process is started', () => {
  const fake = makeFake();
  assert.throws(
    () => createFeedTransport({ host: HOST, knownHostsPath: '', execFile: fake.execFile }),
    FeedTransportError,
  );
  assert.deepEqual(fake.calls, []);
});

test('sftp uploads run from a batch file with the same pinned options', () => {
  const fake = makeFake();
  const written = [];
  const transport = makeTransport({
    execFile: fake.execFile,
    sftpBatchFile: '/outside/repo/batch.txt',
  });
  transport.write.sftpUpload({
    localPath: 'C:/build/portable.zip',
    remotePath: '/opt/rongying/updates-state/staging/internal/1.2.3/portable.zip.part-r1',
    resume: true,
    writeBatch: (text) => written.push(text),
  });

  const [call] = fake.calls;
  assert.equal(call.command, 'sftp');
  assert.ok(call.args.includes('-b'));
  assert.ok(call.args.includes('/outside/repo/batch.txt'));
  assert.ok(call.args.includes('-o'));
  assert.ok(call.args.includes('BatchMode=yes'));
  assert.equal(written.length, 1);
  assert.match(written[0], /reput/u);
  assert.match(written[0], /portable\.zip\.part-r1/u);
});

test('a failed ssh exit code is reported instead of being swallowed', () => {
  const fake = makeFake({ status: 255, stderr: 'host key verification failed' });
  const result = makeTransport({ execFile: fake.execFile }).readOnly.sshRun({ script: 'ls' });
  assert.equal(result.status, 255);
  assert.match(result.stderr, /host key verification failed/u);
});

test('a transport level failure is reported as an error rather than a status', () => {
  const fake = makeFake({ status: null, error: new Error('spawn ssh ENOENT') });
  const result = makeTransport({ execFile: fake.execFile }).readOnly.sshRun({ script: 'ls' });
  assert.equal(result.status, -1);
  assert.match(result.stderr, /ENOENT/u);
});

test('the public fetcher returns the exact bytes of the served manifest', async () => {
  const seen = [];
  const transport = makeTransport({
    fetchPublic: async (url) => {
      seen.push(url);
      return { status: 200, text: async () => 'body-bytes' };
    },
  });
  const result = await transport.fetchPublic('https://api.rongyinghudong.com/updates/internal/manifest.json');
  assert.equal(result.status, 200);
  assert.equal(result.body, 'body-bytes');
  assert.deepEqual(seen, ['https://api.rongyinghudong.com/updates/internal/manifest.json']);
});

test('the transport never builds a shell command string', () => {
  const fake = makeFake();
  const transport = makeTransport({ execFile: fake.execFile });
  transport.readOnly.sshRun({ script: 'ls /opt' });
  transport.write.sshRun({ script: 'rmdir /opt/rongying/updates-state/lock/internal' });
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
import { execFileSync } from 'node:child_process';

const SSH_TIMEOUT_MS = 60_000;
const SFTP_TIMEOUT_MS = 600_000;

export class FeedTransportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FeedTransportError';
  }
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
  if (typeof host !== 'string' || host.length === 0) {
    throw new FeedTransportError('the ssh host is required');
  }
  if (typeof knownHostsPath !== 'string' || knownHostsPath.length === 0) {
    throw new FeedTransportError('the pinned known hosts file is required');
  }
  const runner =
    input.execFile ??
    ((command, args, options) => {
      try {
        const stdout = execFileSync(command, args, options);
        return { status: 0, stdout: String(stdout ?? ''), stderr: '' };
      } catch (error) {
        return {
          status: typeof error?.status === 'number' ? error.status : -1,
          stdout: typeof error?.stdout === 'string' ? error.stdout : '',
          stderr: String(error?.stderr ?? error?.message ?? ''),
        };
      }
    });

  function sshRun(request) {
    const result = runner('ssh', [...pinnedOptions(knownHostsPath), host, request.script], {
      encoding: 'utf8',
      timeout: SSH_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.error !== undefined && result.error !== null && result.status === undefined) {
      return { status: -1, stdout: '', stderr: String(result.error.message ?? result.error) };
    }
    return { status: result.status ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  function sftpUpload(request) {
    const writeBatch = request.writeBatch ?? input.writeBatch;
    if (typeof writeBatch !== 'function') {
      throw new FeedTransportError('the sftp batch writer is required');
    }
    const batchPath = input.sftpBatchFile;
    if (typeof batchPath !== 'string' || batchPath.length === 0) {
      throw new FeedTransportError('the sftp batch file path is required');
    }
    const command = request.resume === true ? 'reput' : 'put';
    writeBatch(`${command} ${request.localPath} ${request.remotePath}\n`);
    return runner('sftp', [...pinnedOptions(knownHostsPath), '-b', batchPath, host], {
      encoding: 'utf8',
      timeout: SFTP_TIMEOUT_MS,
      windowsHide: true,
    });
  }

  const publicFetch =
    input.fetchPublic ??
    (async (url) => {
      const response = await fetch(url, { redirect: 'error' });
      return { status: response.status, text: () => response.text() };
    });

  return {
    readOnly: { sshRun },
    write: { sshRun, sftpUpload },
    fetchPublic: async (url) => {
      const response = await publicFetch(url);
      if (typeof response?.text !== 'function') {
        return { status: response?.status ?? 0, body: '' };
      }
      return { status: response.status, body: await response.text() };
    },
  };
}
```

**设计要点（写进提交信息）：**

- 所有远端动作都是 `execFile(command, argvArray, options)`，**没有任何 shell 字符串**；`options.shell` 从不设置。
- `BatchMode=yes` 让它**永不**交互提示；`StrictHostKeyChecking=yes` + 固定 `UserKnownHostsFile` 让它**永不**自动接受新指纹。
- 生产路径的 `execFileSync` 与假的 `execFile` **签名相同**，所以计划 3 的全部测试都走假实现。
- `sftp` 用 `-b <batchFile>` 批处理模式：批处理模式下 `sftp` 不会进入交互式提示；`reput` 提供**可续传**（服务器没有 `rsync`，`scp` 不能续传）。
- `fetch` 用 `redirect: 'error'`：公网复验必须落在**本频道的确切 URL** 上，不允许跟随跳转。

- [ ] **Step 4: 运行测试并确认通过**

```bash
node --test scripts/lib/feed-publish-transport.test.mjs
```

预期：`fail 0`、`pass 8`。

- [ ] **Step 5: 行为级变异验证**

1. 把 `pinnedOptions` 里的 `StrictHostKeyChecking=yes` 改成 `no` ⇒ 预期 `every ssh call carries the pinned host key options as separate argv entries` 与 `no ssh option ever relaxes host key checking` **按测试名变红**。
2. 把 `runner('ssh', [...], ...)` 改成把整条命令拼成一个字符串传 `shell: true` ⇒ 预期 `the transport never builds a shell command string` **按测试名变红**。
3. 把 `request.resume === true ? 'reput' : 'put'` 改成恒 `'put'` ⇒ 预期 `sftp uploads run from a batch file with the same pinned options` **按测试名变红**。
4. 把 `knownHostsPath` 空值检查删掉 ⇒ 预期 `a missing known hosts path is refused before any process is started` **按测试名变红**。
5. 把 `redirect: 'error'` 删掉 ⇒ 本刀**不适用**（该断言在公网 fetch 的生产实现上，需要真实网络才能触发）；**按"未验证"记账**，不得写成已验证。

恢复后 `git diff` 为空且全绿。

- [ ] **Step 6: 提交**

```bash
git add scripts/lib/feed-publish-transport.mjs scripts/lib/feed-publish-transport.test.mjs
git commit -m "feat(feed): add the pinned ssh and sftp transport"
```

---

### Task 7: CLI 接线（四种模式全部可用）

**Files:**

- Create: `scripts/feed-publish.mjs`
- Test: `scripts/lib/feed-publish-cli.test.mjs`
- Modify: `package.json`

CLI 守卫（**不得**在测试里真连服务器）：`--dry-run` / `--preflight` / `--commit` 三选一，缺省为 `--dry-run`；`--audit-out` 在 `--commit` 下**必填**；`--break-lock` 需要 `--reason`；频道必须是白名单值。

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
});

test('the cli rejects an unknown channel before touching anything', () => {
  const result = runCli(['--dry-run', '--channel', 'beta', '--version', '1.2.3', '--host', 'h', '--known-hosts', 'k']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /channel must be one of/u);
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

test('the cli refuses to break a lock without a written reason', () => {
  const result = runCli(['--break-lock', '--channel', 'internal', '--host', 'h', '--known-hosts', 'k']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--reason is required/u);
});

test('the cli refuses a known hosts file inside the repository', () => {
  const result = runCli([
    '--dry-run',
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
```

- [ ] **Step 2: 运行测试并确认按测试名失败**

```bash
node --test scripts/lib/feed-publish-cli.test.mjs
```

预期：CLI 文件不存在，5 个用例全部失败。

- [ ] **Step 3: 写最小实现**

创建 `scripts/feed-publish.mjs`：

```js
#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FeedPublishError,
  appendAuditStage,
  assertKnownHostsPath,
  breakChannelLock,
  parsePublishInput,
  runCommit,
  runPreflight,
} from './lib/feed-publish.mjs';
import { createFeedTransport } from './lib/feed-publish-transport.mjs';
import { verifyPortableRelease } from './lib/portable-update-release.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function requirePublicKeyFromEnvironment() {
  const value = process.env.MOFANG_UPDATE_PUBLIC_KEY_B64;
  if (typeof value !== 'string' || value.length === 0) {
    throw new FeedPublishError('MOFANG_UPDATE_PUBLIC_KEY_B64 is required to verify the release manifest');
  }
  return value;
}

const USAGE = [
  'Usage: node scripts/feed-publish.mjs <--dry-run|--preflight|--commit|--break-lock> --channel <internal|stable> --host <host> --known-hosts <path>',
  '  --dry-run       offline: print the plan and the local digests, touch nothing',
  '  --preflight     read only remote checks; never claims to have verified writability',
  '  --commit        publish; requires --version, --package, --file-manifest, --manifest and --audit-out',
  '  --break-lock    requires --reason; records the previous owner in the audit log',
  '  --known-hosts   the pinned known_hosts file, must live outside the repository',
].join('\n');

function flag(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : null;
}

// The pinned ssh options live in lib/feed-publish-transport.mjs so that the
// command line and the tests share exactly one implementation.

function main(argv) {
  const auditOut = flag(argv, '--audit-out');
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
  const host = flag(argv, '--host');
  const knownHostsPath = flag(argv, '--known-hosts');
  const version = flag(argv, '--version');

  if (mode === 'break-lock') {
    const reason = flag(argv, '--reason');
    if (reason === null) {
      console.error('--reason is required when breaking a lock');
      return 1;
    }
    if (channel === null || host === null || knownHostsPath === null) {
      console.error('--channel, --host and --known-hosts are required');
      return 1;
    }
    const transport = createFeedTransport({
      host,
      knownHostsPath: assertKnownHostsPath(knownHostsPath, repositoryRoot),
      sftpBatchFile: join(dirname(resolve(knownHostsPath)), 'feed-publish-sftp-batch.txt'),
      writeBatch: (text) =>
        writeFileSync(join(dirname(resolve(knownHostsPath)), 'feed-publish-sftp-batch.txt'), text, 'utf8'),
    });
    const record = breakChannelLock({ channel, host, knownHostsPath, reason, transport, previousOwner: null });
    if (auditOut !== null) {
      appendAuditStage({ auditOut, entry: { stage: 'break-lock', ...record.auditEntry }, repositoryRoot });
    }
    console.log(JSON.stringify(record.auditEntry, null, 2));
    return 0;
  }

  if (mode === 'commit' && auditOut === null) {
    console.error('--audit-out is required for --commit');
    return 1;
  }

  if (channel === null || host === null || knownHostsPath === null) {
    console.error('--channel, --host and --known-hosts are required');
    return 1;
  }

  let input;
  try {
    input = parsePublishInput({ channel, version: version ?? '0.0.0', host, knownHostsPath });
    assertKnownHostsPath(input.knownHostsPath, repositoryRoot);
  } catch (error) {
    console.error(error instanceof FeedPublishError ? error.message : String(error));
    return 1;
  }

  if (mode === 'dry-run') {
    const packagePath = flag(argv, '--package');
    const packageDigest = packagePath === null ? null : readFileSync(packagePath);
    console.log(
      JSON.stringify(
        {
          mode,
          channel: input.channel,
          version: input.version,
          host: input.host,
          auditedBytes: packageDigest === null ? 0 : packageDigest.length,
        },
        null,
        2,
      ),
    );
    console.log('dry run: nothing was written and no permission, remote directory or host key was verified');
    return 0;
  }

  const transport = createFeedTransport({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    sftpBatchFile: join(dirname(input.knownHostsPath), 'feed-publish-sftp-batch.txt'),
    writeBatch: (text) =>
      writeFileSync(join(dirname(input.knownHostsPath), 'feed-publish-sftp-batch.txt'), text, 'utf8'),
  });

  if (mode === 'preflight') {
    const result = runPreflight({
      channel: input.channel,
      version: input.version,
      host: input.host,
      transport,
      knownHostsPath: input.knownHostsPath,
    });
    console.log(JSON.stringify(result, null, 2));
    return result.notes.length === 0 ? 0 : 1;
  }

  const packagePath = flag(argv, '--package');
  const fileManifestPath = flag(argv, '--file-manifest');
  const manifestPath = flag(argv, '--manifest');
  if (packagePath === null || fileManifestPath === null || manifestPath === null) {
    console.error('--package, --file-manifest and --manifest are required for --commit');
    return 1;
  }

  const result = runCommit({
    channel: input.channel,
    version: input.version,
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    runid: randomUUID(),
    packagePath: resolve(packagePath),
    fileManifestPath: resolve(fileManifestPath),
    manifestPath: resolve(manifestPath),
    transport,
    auditOut,
    repositoryRoot,
    verifySignature: () =>
      verifyPortableRelease({
        manifestBytes: readFileSync(manifestPath),
        fileManifestBytes: readFileSync(fileManifestPath),
        packagePath: resolve(packagePath),
        publicKeyBase64: requirePublicKeyFromEnvironment(),
      }),
  });

  console.log(JSON.stringify(result, null, 2));
  if (result.outcome === 'done') return 0;
  if (result.outcome === 'retry') return 3;
  return 1;
}

process.exit(main(process.argv.slice(2)));
```

**四种模式全部接上真实 transport，不存在占位分支：**

| 模式           | 行为                                                                    | 退出码                                  |
| -------------- | ----------------------------------------------------------------------- | --------------------------------------- |
| `--dry-run`    | 完全离线；**不构造 transport**，因此不可能联网                          | `0`                                     |
| `--preflight`  | 真实**只读** transport：`runPreflight` 只调 `transport.readOnly.sshRun` | `0`（无 note）／`1`（有 note）          |
| `--commit`     | 真实 transport：SFTP 上传 + 受限固定远端动作 + 公网复验                 | `0` done／`3` retry（可重跑）／`1` 其它 |
| `--break-lock` | 真实 transport：走同一 `breakChannelLock`                               | `0`                                     |

**签名校验器**由 CLI 注入：它读取 `MOFANG_UPDATE_PUBLIC_KEY_B64` 并调用**既有**的 `verifyPortableRelease`（`scripts/lib/portable-update-release.mjs`）——复用已经验收过的验签实现，不新写一份。缺该环境变量即硬失败，**绝不**跳过签名校验。

**测试边界（必须写进提交信息）：** 自动测试只覆盖参数守卫与假 transport；`--preflight` / `--commit` / `--break-lock` 的**真实网络路径标记为"未验证"**，它们的验收发生在真机发布演练里，绝不能写成已测。

- [ ] **Step 4: 运行测试并确认通过**

```bash
node --test scripts/lib/feed-publish-cli.test.mjs
```

预期：`fail 0`、`pass 5`。

- [ ] **Step 5: 行为级变异验证**

1. 把 `mode === 'commit' && auditOut === null` 的守卫删掉 ⇒ 预期 `the cli refuses a commit without an audit log path` **按测试名变红**。
2. 把 `--reason` 守卫删掉 ⇒ 预期 `the cli refuses to break a lock without a written reason` **按测试名变红**。
3. 把 `parsePublishInput` 调用删掉、直接使用原始 `channel` ⇒ 预期 `the cli rejects an unknown channel before touching anything` **按测试名变红**。
4. 把 `assertKnownHostsPath` 调用删掉 ⇒ 预期 `the cli refuses a known hosts file inside the repository` **按测试名变红**。

恢复后全绿且 `git diff` 为空。

- [ ] **Step 6: 接入门禁**

`package.json` 新增：

```json
"check:portable-feed-publish": "node --test scripts/lib/feed-publish.test.mjs scripts/lib/feed-publish-transport.test.mjs scripts/lib/feed-publish-cli.test.mjs"
```

并把 `pnpm check:portable-feed-publish` 插到 `check` 里 `pnpm check:portable-release-assembly` **之后**、`pnpm lint` **之前**。

- [ ] **Step 7: 提交**

```bash
git add scripts/feed-publish.mjs scripts/lib/feed-publish-cli.test.mjs package.json
git commit -m "feat(feed): add the publish cli with offline and preflight modes"
```

---

### Task 8: 手册、nginx 与发布前检查单

**Files:**

- Modify: `docs/runbooks/portable-update-release.md`

**不得**在本刀写入任何真实 host-key 指纹或服务器凭据。

- [ ] **Step 1: 改写第 7、9、10 步为上传器调用**

把 `docs/runbooks/portable-update-release.md` 第 7 步正文替换为：

````markdown
### 7. 发布到测试频道

此步需要单独的「测试更新源发布」授权。用经过复核的上传器执行，**不要现场拼 `scp` 命令**：

```powershell
node scripts/feed-publish.mjs --preflight --channel internal --host <主机> --known-hosts <仓库外的 known_hosts 路径>
node scripts/feed-publish.mjs --commit --channel internal --version <版本> --host <主机> --known-hosts <仓库外的 known_hosts 路径> --package <portable.zip> --file-manifest <portable-files.json> --manifest <manifest.json> --audit-out <仓库外的审计日志路径>
```
````

上传器固定执行这个顺序，**不得调换**：本地预验证 → stage → 远端复核 → 取频道锁 → 锁内重新核验 → 原子提交版本目录 → 备份旧 manifest → CAS → 临时 manifest → 原子翻转 → 公网复验 → 审计 → 释放锁。

- 本地预验证**先于任何网络写**；任一项不过就一个字节都不写。
- `--dry-run` 完全离线，**不代表**权限、远端目录或 host key 已被验证。
- `--preflight` 只读，只能给出**可写性指标**；真正的写入能力到 stage 阶段才被证明。
- 版本目录**不可变**；已存在且字节一致时可继续，字节不同则立即停止。
- **CAS 不匹配是完整性事故**：收口为 `incident` 并**保留锁**，且**不自动翻转、不自动回滚、不自动删除**孤儿版本目录，人工核查后走显式恢复。
- 翻转后结果不确定时按公网 manifest 的 SHA-256 三分：等于新值 ⇒ 继续复验；等于旧值 ⇒ 允许重试；出现第三种值 ⇒ 停止并进事故流程。

````

并把第 10 步正文替换为：

```markdown
### 10. 最后更新正式签名 manifest

正式频道使用同一上传器，但 `--channel stable`，且 manifest 必须**单独离线签名**（`channel: stable` 与 stable 的 `packageUrl`）——**不得**复用 internal 的 manifest 改字段：签名覆盖 `channel` 与 `packageUrl`，改了签名即失效。

`portable.zip` 与 `portable-files.json` 复用 internal 的**原字节**，禁止重新打包、重新压缩或修改时间戳。
````

- [ ] **Step 2: 追加 nginx、受限账号与发布前检查单**

在 `docs/runbooks/portable-update-release.md` 的「立即停止条件」之前插入：

```markdown
## nginx 与权限

- 新的 manifest 位于 `/updates/<channel>/manifest.json`，**不继承** `= /updates/latest.yml` 的 `no-cache`。客户端是 Electron 主进程的全局 `fetch`（undici，无隐式 HTTP 缓存），因此当前风险低。**建议**追加一条 `location ~ ^/updates/(internal|stable)/manifest\.json$ { add_header Cache-Control "no-cache" always; }` 作为廉价保险。
- 生产**应当使用受限发布账号**：对版本目录可写、manifest 单独一步可换、不能改动其他内容。
- **当前状态是显式例外**：`/opt/rongying/updates` 与 `/opt/rongying/backups` 均为 `root:root 755`，首次发布将**临时使用 root**。残留风险：root 一旦被脚本缺陷或误用影响，可以改动服务器上的任意文件；审计**只能事后发现，不能事前阻止**。建立受限账号属于后续加固。

## 发布前检查单

- [ ] `docs/portable-update-key-registry.md` 里的**服务器 host-key 指纹**已由用户或授权运维人员经**可信带外渠道**核对，并写明核对方式。
- [ ] SSH 使用固定的仓库外 known_hosts 文件；上传器以 `BatchMode=yes` 与 `StrictHostKeyChecking=yes` 运行，**永不自动接受新指纹**。
- [ ] 三个产物的本地 SHA-256 与大小已记录，且与待发 manifest 逐项一致。
- [ ] 启动器身份挑战（第 6b 步）三条全部通过，读数已归档为**发布期 QC 证据**。
- [ ] `--audit-out` 指向**仓库外**的路径；审计日志从操作开始逐阶段追加。
- [ ] 已保留上一版 `manifest.json`、`portable-files.json` 与 `portable.zip` 作为回滚材料。
- [ ] 已确认「回滚只能拦住还没升级的客户端」——已升级的客户端**不会**降级，需要真降级必须另开事故流程。
```

- [ ] **Step 3: 格式与自检**

```bash
./node_modules/.bin/prettier --write docs/runbooks/portable-update-release.md
./node_modules/.bin/prettier --check docs/runbooks/portable-update-release.md
git diff --check
```

⚠️ prettier 会重排有序列表：`--write` 之后**必须重读**小节的步骤编号（第 1–11 步），确认没有被改写。若被打乱，用 `--check` 只报告不修改并手工修正格式。

确认手册里没有任何真实指纹：

```bash
grep -nE "[0-9A-F]{32,}" docs/runbooks/portable-update-release.md || echo "no concrete fingerprints in the runbook"
```

- [ ] **Step 4: 提交**

```bash
git add docs/runbooks/portable-update-release.md
git commit -m "docs(release): route the feed publishing steps through the uploader"
```

---

## 完整门禁与验收

每个 Task 后运行：

```bash
pnpm check
```

预期 `exit 0`。失败时按门禁分段处理：`check:portable-launcher`、`check:portable-update-release`、`check:portable-release-assembly`、`check:portable-feed-publish`、`check:udisk-delivery`、`lint`、`typecheck`、`typecheck:tests`、`format:check`、`check:dead-code`、`test`。

**验收读数（逐条如实填写，未执行的写“未验证”）：**

| 项                 | 命令                                                                  | 读数 |
| ------------------ | --------------------------------------------------------------------- | ---- |
| 上传器逻辑         | `node --test scripts/lib/feed-publish.test.mjs`                       | 待填 |
| **真实 transport** | `node --test scripts/lib/feed-publish-transport.test.mjs`             | 待填 |
| 上传器 CLI 守卫    | `node --test scripts/lib/feed-publish-cli.test.mjs`                   | 待填 |
| 四种模式均已接线   | `grep -n "not wired" scripts/feed-publish.mjs`（预期无输出）          | 待填 |
| 未联网取证         | transport 测试全部走注入的假 `execFile`；`--dry-run` 不构造 transport | 待填 |
| 手册无真实指纹     | `grep -nE "[0-9A-F]{32,}" docs/runbooks/portable-update-release.md`   | 待填 |
| 全量门禁           | `pnpm check`                                                          | 待填 |

## 未覆盖与后续（不得写成已完成）

- **真实网络路径未自动化验证**：transport **已实现并接线**（`--preflight` / `--commit` / `--break-lock` 都会真的调用 `ssh` / `sftp` / `https`），但**自动测试只覆盖参数守卫与假 transport**。真实路径必须在真机发布演练中验收，并**由用户先提供主机与经带外核对的 host-key 指纹**。
- **没有任何真实发布被执行**：没有上传测试 feed，没有上传生产 feed，没有改线上 manifest，没有连接或修改服务器。
- **`--break-lock` 的真实远端路径同样未自动化验证**：它走的是与 `--commit` 相同的 transport 与同一个 `breakChannelLock`，但需要服务器才能实测。
- **受限发布账号未建立**：当前方案接受“首次临时使用 root”这一显式例外。
- nginx 的 `no-cache` 建议**未应用**：需要在获得授权后改服务器配置。

相关：`docs/superpowers/specs/2026-09-22-portable-release-infrastructure-correction-design.md`
