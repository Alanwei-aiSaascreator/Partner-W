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

**变异与镜像的两条加严纪律（第三修复刀加进本节，Task 4–7 直接继承，别重新发现）：**

1. **变异前先取基线 sha256；恢复后必须先比 sha256，不等就停下。** 备份必须在**变异之前**取 —— 先变异、后备份会把**变异本身**"恢复"回来；恢复后重新读盘算一遍 sha256，与基线**不相等就不许继续**（不许跑下一条变异、不许提交、不许记"恢复成功"）。本刀被这一点救过一次：变异装置先改文件、后做备份，于是那次"逐字节恢复"恢复的是**变异后的内容**，而当时 `git diff` 与"恢复后套件全绿"**两个读数都是绿的** —— 只有基线 sha256 比对抓得到。**这条与上一条纪律里的"逐字节恢复、`git diff` 为空"是加严关系**：`git diff` 为空只证明"与 HEAD 一致"，证明不了"与我变异前的那份一致"。
2. **镜像/一致性检查必须按「连续切片」断言，并写明边界。** 只查"每一行都能在文件里找到"的判据会在镜像**被从中间撑开**时照样通过（本刀第一版镜像检查就是这个更松的形状：一处插入把镜像撑开，而它仍然全绿，重写后才按连续判据抓得到）；判据必须是"**声明的边界**与文件的一段**连续**切片逐行相等"，边界写具体行号（例如 `feed-publish.test.mjs` 行 1–374 ／ 376–561 ／ 563–868），并且**边界本身也要重测**（行号会随插入漂移）。

**每个新增的守卫与接线都必须有一条测试单独钉住它**，并在同一刀的变异清单里有一条**会按测试名变红**的变异证明它是必要的 —— 尤其是“把参数/回调往下传”这类透传（断了不会报错，只会静默失效）。变异记录的措辞必须**无歧义**：同一段代码有两个 `await` 就写成两条，否则实施者删错一处会得到“变异存活”的假读数，进而误以为护栏有效。

3. **（复核刀加进本节，Task 5–8 直接继承）每一条变异记录都必须打印"磁盘上真实发生的那次改动"（hunk），且任何"存活"读数在有人读过 hunk 之前不算数。** 形状来自本刀的一次实测：一次**纯插入**变异落在 `return` 语句**之后**（不可达代码），套件读数 **133/0 全绿** —— 只看绿/红根本分不出"护栏被删掉了"与"变异压根没生效"。因此装置固定做四件事，**缺一条的读数一律作废**：① `diff` 出改动的那几行并**打印**（`-`/`+` 加三行上下文）——只打印半行片段的装置同样作废（改动落在行中间时，`-`/`+` 必须显示**整行**，否则读者看到的是被截断的假 hunk）；② **纯插入**型变异在记"存活"之前先做**可达性检查**：从插入点向前跳过空白，若前一字符是 `;`，再向前找同层边界（`{` 或 `;`），取那一段语句的首词 —— 是 `return` / `throw` / `continue` / `break` 就判 `SURVIVOR_REJECTED`，**不算有效存活**（保守方向：宁可多拒一条也不放过一条假存活；识别不出形状时记 `reachable-or-unknown`，仍按"存活必须有人读 hunk"办）；③ 每条变异**预先写明"哪条测试必须按名变红"**，跑完核对红名单里有那个名字，没有就报 `EXPECTATION_FAILED`（防止"红了，但红的是别的测试"被记成"钉住了"）；④ 其余装置项不变：锚点恰好匹配 1 次、`node --check` 变异产物、变异前取基线 sha256、恢复后比 sha256 并断言该文件的 `git status` 与变异前**逐字相同**。**给 Task 5–8 的验收口径**：每刀的变异清单不止给 pass/fail 两个数，**必须同时给出 hunk 与红名单核对结果**；一条"存活"读数若没有对应的 hunk 打印，视为**未验证**。

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
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

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

function isInsideRepository(target, repositoryRoot) {
  const relation = relative(resolve(repositoryRoot), resolve(target));
  if (relation === '') return true;
  if (isAbsolute(relation)) return false;
  return relation !== '..' && !relation.startsWith(`..${sep}`);
}

export function assertKnownHostsPath(target, repositoryRoot) {
  if (isInsideRepository(target, repositoryRoot)) {
    throw new FeedPublishError('the pinned known hosts file must live outside the repository');
  }
  return resolve(target);
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

test('the anchor helper names a call that did not record its request', () => {
  assert.throws(
    () => assertEveryCallCarriesTheTrustAnchor([['fetchPublic', 'url']]),
    /the fetchPublic call did not record its request/u,
  );
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
  const other = {
    channel: 'stable',
    version: '1.2.4',
    packageSha256: 'changed',
    fileManifestSha256: 'changed',
    manifestSha256: 'changed',
  };
  for (const key of ['version', 'channel', 'packageSha256', 'fileManifestSha256', 'manifestSha256']) {
    assert.notEqual(base, planHashOf({ ...PLAN_INPUT, [key]: other[key] }), `planHash ignored ${key}`);
  }
});

test('the lock mkdir is pinned to the C locale so its diagnostics do not move with the host locale', async () => {
  const transport = fakeWriteTransport();
  await acquireChannelLock(lockInput(transport));
  assert.equal(writeScripts(transport)[0], `LC_ALL=C mkdir ${LOCK_DIR}`);
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
});

test('the plan hash refuses a field that is not a non empty string', () => {
  for (const field of ['channel', 'version', 'packageSha256', 'fileManifestSha256', 'manifestSha256']) {
    for (const value of [undefined, null, '', '   ', 7, {}]) {
      assert.throws(
        () => planHashOf({ ...PLAN_INPUT, [field]: value }),
        FeedPublishError,
        `${field} = ${String(value)}`,
      );
    }
  }
  assert.throws(() => planHashOf({}), FeedPublishError);
  assert.throws(() => planHashOf(undefined), FeedPublishError);
  assert.equal(typeof planHashOf(PLAN_INPUT), 'string');
});

test('an existing lock is a determinate not-acquired and never stolen', async () => {
  const transport = fakeWriteTransport({
    writeSsh: (request) =>
      isLockDirectoryCommand(request)
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
      isLockDirectoryCommand(request)
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

const CHANNEL_CHARACTERS = [...new Set(CHANNELS.join(''))].join('');

function assertSafeChannel(channel) {
  if (typeof channel !== 'string' || channel.length === 0) {
    throw new FeedPublishError('the channel is empty, so it cannot be interpolated into a remote path');
  }
  if (!CHANNELS.includes(channel)) {
    throw new FeedPublishError(
      `the channel ${channel} is not one of ${CHANNELS.join(', ')}, so it is not safe to interpolate into a remote path`,
    );
  }
  for (const character of channel) {
    if (!CHANNEL_CHARACTERS.includes(character)) {
      throw new FeedPublishError(
        `the channel ${channel} carries ${JSON.stringify(character)}, which no channel in the whitelist uses, so it is not safe to interpolate into a remote path`,
      );
    }
  }
}

function lockPath(channel) {
  assertSafeChannel(channel);
  return `${STATE_ROOT}/lock/${channel}`;
}

function ownerPath(channel) {
  return `${lockPath(channel)}/owner.json`;
}

export function planHashOf(input) {
  for (const field of ['channel', 'version', 'packageSha256', 'fileManifestSha256', 'manifestSha256']) {
    const value = input?.[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new FeedPublishError(`the plan hash needs a non empty ${field}`);
    }
  }
  assertSafeChannel(input.channel);
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
    script: `LC_ALL=C mkdir ${lockPath(input.channel)}`,
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
    script: `printf '%s' '${Buffer.from(JSON.stringify(input.owner), 'utf8').toString('base64')}' | base64 -d > ${ownerPath(input.channel)}`,
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

**第二修复刀（代码质量门禁复核，2026-09-22）的四处偏离（第五、第六、第七、第八处；形状同上：规定文本说了什么 / 为什么不行 / 什么变异证明规定清单看不见差别）：**

5. **owner 写入不再把记录直接拼进 shell 单引号串，改成 base64 载荷（第五处，`scripts/lib/feed-publish.mjs` 的 owner 写入）。** 规定文本是 `printf '%s' '${JSON.stringify(input.owner)}' > owner.json`：`JSON.stringify` 会转义 `"` 却**从不转义 `'`**，而上面第一条偏离新增的五字段校验只要求 `trim()` 后非空 —— 于是 `operator`（Task 7 从 `MOFANG_FEED_OPERATOR` 取，CI 显示名或 git author 都是合法值）里一个撇号就能**结束那个单引号串**，后面的内容变成 shell 源码。**实测（真 bash，仓库外临时目录，只跑 `touch PWNED`，不碰网络）：** 拿本模块**真实生成**的那条脚本去跑，`operator: "x'; touch PWNED; echo '"` ⇒ `touch PWNED` **在"发布主机"上被执行**（读数 `MARKER_EXISTS true`），模块仍以 `incident: false` 报"本次持有锁"，而落盘的 `owner.json` 只剩尾巴（`","startedAt":…,"machine":"builder-01"}`）—— **既损坏又不报错**；`operator: "O'Brien"`（现实值）⇒ 单引号串未闭合，**根本不写 `owner.json`**（读数 `OWNER_FILE_BYTES ABSENT`），却报 `incident: true`。实现改为 `printf '%s' '<base64>' | base64 -d > …`，载荷由 `Buffer.from(JSON.stringify(input.owner), 'utf8').toString('base64')` 生成：base64 字母表是 shell 安全的，记录里**没有任何字节能离开它所在的 shell 词**（同一形状的修复在另一条线上已经用过一次）。**规定清单看不见差别（两条实测）：** ① 把 HEAD 模块 + HEAD 套件（70 条）的 `OWNER_RECORD.operator` 夹具值换成 `"x'; touch PWNED; echo '"`（**只改这一处夹具，别的都不动**）⇒ **70/70 全绿** —— 整套规定用例对着一个 shell 注入载荷全绿，因为它们既不执行生成的脚本、也不检查它的引号边界；② 把本刀的实现变异回规定的 `printf '%s' '${JSON.stringify(...)}'` 形式 ⇒ **红 3 条**（`an owner record with an apostrophe cannot end the shell word it is written into` + `a successful acquisition writes the owner record for this run` + `the lock lives under the channel it was given rather than a fixed one`；76 → 73）。**②不是"只红一条"，别按那个口径记**：后两条是规定的"逐字断言写脚本"用例，本刀**必须**把它们更新成 base64 形式，于是它们也钉住了这个修复 —— 是覆盖更宽，不是缺陷。**这条修复还牵动规定的下游**：Task 4 的 `commitTransport` 夹具里那段 `/printf '%s' '(\{.*\})' >/u.exec(request.script)`（从脚本里还原 owner 记录）已同步改为 base64 解码 —— 不改的话 Task 4 那条"解锁时锁被别人换掉"的验收项**永远读不到 owner 记录**，会静默失效（夹具里 `ownerJson` 恒为 `null`，`cat owner.json` 返回空，断言看起来"通过"）。

6. **`channel` 在拼进远端路径之前先过一道本地的字符集前置条件（第六处，`lockPath`）。** 规定文本只靠 Task 1 的 `parsePublishInput` 白名单，而那是**两个文件之外**的一道门；`lockPath` / `ownerPath` 把 `channel` 拼进 `mkdir` / `rm` / `rmdir` / `cat` 的路径里。**不发明比计划更窄的集合**：Task 1 的白名单是 `CHANNELS = ['internal', 'stable']`（`parsePublishInput` 只做 `CHANNELS.includes(raw.channel)`），两个值用到的字符**只有小写 ASCII 字母** ⇒ 实现从白名单**推导**字符集 —— `const CHANNEL_CHARACTERS = [...new Set(CHANNELS.join(''))].join('')` —— 并要求 `channel` 的每个字符都在其中；同一条推导**自动**覆盖将来加进白名单的新字符，所以不会比计划窄。前置条件挂在 `lockPath` 这个**唯一咽喉**上（`ownerPath` 经它拼），因此 `acquireChannelLock` / `releaseChannelLock` / `breakChannelLock` / `readOwnerRecord` 四个入口**一起**被挡住，而不只是 acquire —— 只挡 acquire 会把 `rm` / `rmdir` 留成裸的。**规定清单看不见差别：** 去掉这道前置条件 ⇒ **只红** `a channel that could escape its remote path never reaches a remote call`（76 → 75）；该条对七个恶意 channel（`../evil` / `internal/x` / `internal; id` / 空串 / `INTERNAL` / `internal lock` / `internal\nx`）各断言一遍 acquire 与 break 都抛 `FeedPublishError` **且 `transport.calls.length === 0`**。**"不比计划窄"是被机械钉住的**：`the channel precondition admits every channel the whitelist allows` 遍历 `CHANNELS` 断言每个都放行、且发出恰好两次调用；去掉前置条件时它**保持绿** —— 正说明它钉的是"不许更窄"，而不是"必须拦住"。

**第三修复刀对第六处的两处改动（照录）：** ① 判据**加了一层 `CHANNELS.includes(channel)`** —— 原来那层只是**字符集**，`internall` 这种"字符集安全、但不在白名单里"的值会整个通过并被 `mkdir` 成**第三个频道**，而它给出的报错文案写着 "which no channel in the whitelist uses"（**文案比判据宽**，覆盖了一类判据并不检查的值）；现在两层都查，报文与判据覆盖同一类。② 恶意夹具 `UNSAFE_CHANNELS` 由**七条**加到**八条**（新增 `internall`），所以本节里"七个恶意 channel"这个**数字在本刀之后是八条**（`../evil` / `internal/x` / `internal; id` / 空串 / `INTERNAL` / `internal lock` / `internal\nx` / `internall`）；本刀重跑的读数见账本第 59 条（红 **2** 条，不是原读数的一条 —— 因为 `planHashOf` 也走同一层判据）。**这条判据现在挂在两处**：`lockPath`（第六处原有的咽喉）与 `planHashOf`（本刀新增，第九处的"通道那一半由依赖它的那个函数自己保证"）。

7. **锁的 `mkdir` 前面加 `LC_ALL=C`（第七处，`acquireChannelLock`）。** `isFileExistsFailure` 是**对英文报错文本做子串匹配**（`/File exists/iu`），而 GNU coreutils 的报错由 gettext 按 `LC_MESSAGES` 翻译：会话 locale 不是 `C` 时这条常规争用会**匹配不上**，于是每次都走 `ownership-unknown` + `incident` + `requiresExplicitRecovery`，把"别人正持锁"这条**常规路径**报成完整性事故。**本机量到的边界（记清楚，别把推断说成实测）：** 本机 `locale -a` 装了 zh_CN / fr_FR / de_DE / ja_JP 等（实测这四个地区各 3–4 个变体，共 **14** 项），但 `/usr/share/locale` **根本不存在**（`ls` 报 `No such file or directory`，`/usr/share/locale/*/LC_MESSAGES/coreutils.mo` 计数为 **0**）—— 也就是**没有任何消息目录**，所以换 locale **只改引号样式、不改被匹配的子串**：实测 `LC_ALL=C mkdir /tmp` ⇒ `mkdir: cannot create directory '/tmp': File exists`，`LC_ALL=zh_CN.UTF-8 mkdir /tmp` ⇒ `mkdir: cannot create directory ‘/tmp’: File exists` —— 引号从 `'` 变成 `‘’`，而 `File exists` **仍在**。**因此"非 C locale ⇒ 谓词失配"这条在本机没有复现出来**，它是对"目标主机装了消息目录（例如语言包）"的推断；Task 6 的真机 locale 探针就是去证实或推翻它。`LC_ALL=C` 本身是**只紧不松**的方向：它只会让远端输出**更**接近规定夹具里那份英文原文。**规定清单看不见差别：** 去掉 `LC_ALL=C ` ⇒ 红 4 条（`the lock mkdir is pinned to the C locale so its diagnostics do not move with the host locale` + 上面第 5 处里那三条逐字断言整条脚本的用例；76 → 72）—— 前缀被钉在四处而不是一处。**这条修复牵出的规定夹具改动：** 规定夹具用 `request.script.startsWith('mkdir ')` 判断"这条是锁的 `mkdir`"，加上前缀后**七处**全部失配。实测：直接加前缀 ⇒ 红 **11** 条，其中 7 条只是夹具没匹配上、于是"`mkdir` 成功"走错分支，与断言本身无关。实现把那七处换成一个按命令形状判断的具名谓词 `isLockDirectoryCommand(request)`（`/(?:^|\s)mkdir \S*\/lock\//u`）——它对前缀**免疫**，所以再去掉 `LC_ALL=C ` 时剩下的红**正好**是钉住前缀的那 4 条。Task 4 的 `commitTransport` 里同一形状的 `request.script.startsWith('mkdir ') && request.script.includes('/lock/')` 已同步改成同一个谓词（不改的话 Task 4 的锁夹具在加了前缀后全部失配，锁步骤会"成功"从而走错分支）。

8. **`planHashOf` 对五个输入字段先做前置条件（第八处）。** 规定文本直接读 `input.channel` 等五个字段：`planHashOf({})` 会**平静地返回一个格式完好的哈希**（五个 `undefined` 用 `'\n'` 连起来一样能哈希），而调用方 `runCommit` 把它的结果当作锁的 `planHash` 与 staging 目录名的一部分 —— 不变量（字段都是非空字符串）住在**另一个函数**里，依赖它的却是这一个。实现改为逐字段 fail closed（`typeof !== 'string'` 或 `trim()` 后为空即抛 `FeedPublishError`，风格与 owner 五字段检查一致），并用 `input?.` 兜住 `null` / `undefined`。**`'\n'` 连接符本身保持不变**（它在计划的"刻意不钉"名单上，本次只**补上碰撞证据**，见下文）。**规定清单看不见差别：** 去掉这段前置条件 ⇒ **只红** `the plan hash refuses a field that is not a non empty string`（76 → 75）；该条对五个字段各喂 `undefined` / `null` / 空串 / 全空白 / 数字 / 对象六种坏值，并额外断言 `planHashOf({})` 与 `planHashOf(undefined)` 都抛、而正常输入返回字符串。

**第三修复刀（Task 3 收尾复核，2026-09-22）的一条通则（第九处；它管的不是某段规定文本，而是整套远端脚本的插值纪律）：**

9. **通则（本刀新增，远端脚本一侧）：凡是拼进远端脚本的值，必须满足二者之一 ——（a）被一条本地前置条件限死在一个 shell 惰性字母表内，或（b）base64 编码后再拼接；两者都不满足的值不得拼进脚本。Task 4/5/6 每新增一条远端脚本，必须逐条列出脚本里被拼进去的每个值、它属于哪一类、依据哪条前置条件；清单外的插值即视为未完成。**
   现存值逐条清点：`channel` ——（a），`assertSafeChannel`（第六处），但**只在 `lockPath` 上**，Task 4 必须把同一前置条件提到**任何远端写之前**（把它算进验收项 7③，不只挡 `channel`，`version` 也一起）；`version` ——（a），依据 Task 1 的 `SEMVER_PATTERN`，**必须补一条用例把"版本号会被拼进远端路径"与"该正则不含 shell 元字符与换行"绑在一起**（否则以后放宽正则无人察觉）；`planHash` 与 `runid` ——（a），都是本模块/CLI 自己产出的十六进制与 UUID，**永不接受外部字符串**；owner 记录 ——（b），base64（第五处）。`sort`、`stat`、`sha256sum` 等命令的参数一律来自上述五者或常量。

   **本刀对这份通则的落地（读数都是本刀量的）：** ① **现存值已按 `script:` 逐行核过**（口径：逐行跟踪围栏状态，取出计划里每一条含 `script:` 的行，再抽出该行的 `${…}` 插值）—— 读数 **`TOTAL_SCRIPT_LINES 23`**：**实现侧 18 行**（Task 2 一处 = `stat -c '%d'`；Task 3 七处 = `cat` / `mkdir`（锁）/ owner 写入 / `rm` ×2 / `rmdir` ×2；Task 4 十处 = `find` / `printf 'present\n'` / `sha256sum` ×2 / staging `mkdir -p` / staging 两条 `mv -f`（数组）/ `stat -c '%d'`（同设备号）/ `mv`（提交版本目录）/ 备份两条（数组）/ 翻转 `mv -f`）+ **测试夹具 5 行**（全是 `'ls /opt'` / `'ls'` / `'rmdir /x'` 这类常量）。18 行里 **16 行**把插值写在 `script:` 同一行上，另 **2 行**是数组形式（`script: [` 后跟 `mv -f …`）。⚠️ **"16 条 `script:`"只覆盖那 16 行**；计划里含 `script:` 的**一共 23 条**（16 + 2 条数组形式 + 5 条夹具），别把 16 当成全部 —— 但那 2 条数组形式**也逐项落在清单里**（`stagingRoot` / `runid` / `PORTABLE_PACKAGE_NAME` / `PORTABLE_FILE_MANIFEST_NAME` / `input.channel`）。**没有第六类插值**：`expectedEntries` 的 `name` 就是两个 `PORTABLE_*` 常量（Task 4 的 `inspectRemoteDirectory` 调用点只喂常量那一份，**不是**文件清单里的 `files[].path`），`readRemoteHashes` 的 `directory` / `names` 与 `readRemoteFileSha` 的 `target` 由 `versionRootOf` / `stagingRootOf` / `${UPDATE_ROOT}/${channel}/…` / `${UPDATE_ROOT}/${channel}/${PORTABLE_MANIFEST_NAME}.${runid}.tmp` 拼出，逐项归入上面五类或常量。② **`version` 的字母表一侧本刀已补上钉子**：新增 `the version the input gate admits carries no shell metacharacter and no newline`（10 个载荷：`; id` / `+;id` / `$(id)` / `|` / 反引号 / 单引号 / 双引号 / 末尾换行 / 中间换行 / 空格），变异（把 build metadata 的字符类 `[0-9A-Za-z-]` 改成 `[0-9A-Za-z;-]`）⇒ **只红这一条**（**78 → 77 / 1**，账本第 61 条）。**插值一侧**（`version` 真的被拼进 `stagingRootOf` / `versionRootOf` / 备份名）**归 Task 4**：本刀已把 `version` 写进验收项 7③，Task 4 补那条用例时把两侧绑在一起。

**第二修复刀新增的测试落在规定块的哪一侧（本刀量过，省得复核时按"计划里没有"再报一遍）：** 规定块是**文件的一段连续镜像**，本刀新增的条目分布如下 —— **在镜像里面**：`the anchor helper names a call that did not record its request`（`feed-publish.test.mjs` 行 417，落在 **Task 2** 那份镜像 376–561 里）、`the lock mkdir is pinned to the C locale so its diagnostics do not move with the host locale`（行 621）、`the plan hash refuses a field that is not a non empty string`（行 628）、具名谓词 `isLockDirectoryCommand`（行 646，都在 **Task 3** 那份镜像 563–861 里）；**在镜像外面**（行 862 以后）：`OBSERVED_OPERATOR`（行 921）、`ownerWriteScript`（行 923）、`ownerPayloadOf`（行 926）、`an owner record with an apostrophe cannot end the shell word it is written into`（行 932）、`UNSAFE_CHANNELS`（行 1248）、`a channel that could escape its remote path never reaches a remote call`（行 1250）、`the channel precondition admits every channel the whitelist allows`（行 1261）—— 这七项只在本账本里按**名字 + 读数**记账。**这与上一刀把它的后续用例（行 833–1192）只写进账本、不写进规定块是同一个约定**，不是本刀的遗漏。**六份镜像的边界线（本刀量过，别猜）：** `feed-publish.test.mjs` 行 1–374 ／ 376–561 ／ 563–861，`feed-publish.mjs` 行 1–144 ／ 146–198 ／ 200–433；本刀用"逐行相等**且连续**"的检查跑过这六份（而不是只查"每行都能在文件里找到"—— 那个更松的判据会放过镜像被从中间撑开的情形，本刀就被它放过一次：`feed-publish.test.mjs` 行 417 的插入把 **Task 2** 那份镜像撑开了 7 行，只有连续判据抓得到，已按 376–561 重新对齐）。 **第三修复刀的两个边界变化与一次口径更正（实测）：** 本刀在 Task 3 镜像**里面**改了一条用例，两份镜像因此变长 —— `feed-publish.test.mjs` **563–861（299 行）⇒ 563–868（306 行）**、`feed-publish.mjs` **200–432（233 行）⇒ 200–438（239 行）**。顺带更正本节原文的「200–433」：文件按 `\n` 切分是 433 段，**最后一段是尾随换行产生的空串**，围栏里装的是 200–432 这 233 行 ⇒ 边界应写作 **200–432**（原文多算了那个空串）。**本节记录的行号在本刀之后整体下移**（本刀实测）：`OBSERVED_OPERATOR` 921→928、`ownerWriteScript` 923→930、`ownerPayloadOf` 926→933、`an owner record with an apostrophe cannot end the shell word it is written into` 932→939、`UNSAFE_CHANNELS` 1248→1255、`a channel that could escape its remote path never reaches a remote call` 1250→1266、`the channel precondition admits every channel the whitelist allows` 1261→1277；本刀新增的两条（都在镜像外）是 `the plan hash refuses a channel outside the whitelist`（行 1286）与 `the version the input gate admits carries no shell metacharacter and no newline`（行 1293）。 **Task 4 本刀（第四刀）的镜像边界（实测，取代本节里 module 那三个数）：** `feed-publish.mjs` 行 **1–148 ／ 150–202 ／ 204–442**（本刀第一处偏离落在第一份镜像**里面**：`assertKnownHostsPath` 由 9 行变 14 行 + import 行内容变化 ⇒ 300 之后的 module 边界整体 **+4**）；`feed-publish.test.mjs` 行 **1–374 ／ 376–561 ／ 563–868**（**不变**：本刀对测试的改动全部在行 1319 之后）；本刀另外新增两份镜像 **`test 1321–2117`（Task 4 测试块）与 `mjs 444–990`（Task 4 模块块）**，八份用"逐行相等且连续"的检查一起跑过（读数在第 Task 4 节实施记录的第四节），三对 `diff` 全部为空。

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
   **本计划原文预测的那条测试看不见这个变异**（已实测）：`release re-reads the owner and refuses when it belongs to another run` 传进来的 `owner` 是 `null`，而 `null` owner 在 `resolveLockDisposition` 里**根本不看锁**就返回 `ownership-unknown` ⇒ 删掉 `??` 重读它照样绿。真正变红的是接住"调用方没有 owner、锁上有"这条路的 `release re-reads the owner from the lock when the caller has none`：实测只红这一条（58 → 57），它断言读到 `this run` 的 owner 后一路走到 `rm owner.json` 与 `rmdir lock`。**要把它记成"规定清单看不见的缺口"**：传进去的 owner 为空 ≠ 没有 owner 可读，这两件事必须有各自的钉子，否则 `--break-lock` 之外的第二条恢复路径（先读锁再释放）可以在缺 `??` 的情况下静默走偏。 **本刀重跑于 69 条套件（删掉 `feed-publish.mjs:337` 的 `??` 重读，锚点断言恰好匹配一次）：实测 69 → 66 / 3** —— 除上面那条外，红的还有 `release re-reads the owner and refuses when it belongs to another run` 与 `a corrupt owner record on the lock is unreadable rather than a crash`（注意：上一段"它照样绿"这句**只对 58 条时代成立**，现在它也红，但红在守卫那行、不是红在语义上）。这三条的**死法逐条实测过，不一样**（带桩副本跑同一次变异，读数按名字取）：助手调用 **28 → 27** 次、空调用表 **1 → 3** 次。其中 `release re-reads the owner and refuses when it belongs to another run` 与 `a corrupt owner record on the lock is unreadable rather than a crash` **死在助手那句 `calls.length > 0` 上**（两条都传 `owner: null`，变异后一次远程读取都不再发生 ⇒ `transport.calls` 为空）；而 58 条时代就红的 `release re-reads the owner from the lock when the caller has none` **根本没走到助手** —— 它红在自己的语义断言上，调用总数少掉的那 1 次正是它。空表里的第 1 次是**本刀新增的钉子自己**（它刻意传空数组），与变异无关。所以 58 条时代的"只红一条"在修复刀之后**变成 3 条**：多出来的两条不是新发现的语义缺口，而是信任锚助手的非空守卫**在变异空间里确实有牙** —— 但**守卫本身在 HEAD 上仍然没人钉**（第 51 条把它钉住）。
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
51. 删掉助手里的 `assert.ok(calls.length > 0, 'the trust anchor assertion needs at least one recorded call');`（非空守卫）⇒ **只红**本刀新增的 `the anchor helper refuses an empty call list rather than passing on zero calls`，实测 **70 → 69 / 1**。**为什么必须单钉它**：这是全刀唯一一条没人钉的守卫 —— **加钉子之前**（69 条套件的状态）实测 27 次助手调用**没有一次**拿到空调用表（带桩副本读数 `__ANCHOR_EMPTY_CALL_LIST_N__ 0`），所以那个状态下删掉它**不会红任何一条**，它存在的意义是挡住**将来**那条把 `calls` 传空的用例。而它在**变异空间里有牙**：第 5 条那次变异（删 `??` 重读）实测正好让**两条**用例的调用表变空（`release re-reads the owner and refuses when it belongs to another run` 与 `a corrupt owner record on the lock is unreadable rather than a crash`），两条都停在守卫这句上 —— 守卫的**行为**因此是"有牙且已钉"，只有它的**文案**留在「刻意不钉」名单里。**这份读数的口径（实测，别再估）**：套件里 36 条用例构造假 transport（共 40 次构造），其中 25 条至少发过一次调用、这 25 条全部接了助手；另外 11 条刻意零调用。**助手调用次数与空表次数按世代各记一份**：69 条套件时 27 次调用 / 25 条用例 / 空表 0 次；70 条（加钉子之后）时 28 次调用 / 26 条用例 / 空表 1 次 —— 那一次空调用就是这条新钉子自己（它刻意传空数组），其余 25 条的读数一个都没变。⚠️ **提交 `c323c495` 的信息里那句 "three tests end with an empty call list … and all three die on this guard" 不准确**（实测只有两条停在守卫上，第三条没走到助手），按本计划对 `3ebe23ec` 的同一条纪律处理：不重写那个提交，只在此处记账。

52. **（第二修复刀）** 把 owner 写入变异回规定的 `printf '%s' '${JSON.stringify(input.owner)}' > …` 形式 ⇒ 实测 **红 3 条**：`an owner record with an apostrophe cannot end the shell word it is written into`、`a successful acquisition writes the owner record for this run`、`the lock lives under the channel it was given rather than a fixed one`，**76 → 73 / 3**。**为什么不是"只红一条"、以及"规定清单看不见差别"的 70/70 实测**，口径写在第 5 处偏离里 —— 别按"只红一条"记。
53. **（第二修复刀）** 删掉 `lockPath` 里的 `assertSafeChannel(channel);` ⇒ 实测 **只红** `a channel that could escape its remote path never reaches a remote call`，**76 → 75 / 1**；`the channel precondition admits every channel the whitelist allows` **保持绿**（它钉的是"不比计划窄"，不是"必须拦住"）。
54. **（第二修复刀）** 把锁 `mkdir` 的 `LC_ALL=C ` 前缀删掉 ⇒ 实测 **红 4 条**：`the lock mkdir is pinned to the C locale so its diagnostics do not move with the host locale`、`an owner record with an apostrophe cannot end the shell word it is written into`、`a successful acquisition writes the owner record for this run`、`the lock lives under the channel it was given rather than a fixed one`，**76 → 72 / 4**。前缀被钉在**四处**（三条逐字断言整条脚本 + 那条具名用例）。⚠️ 用 `isLockDirectoryCommand` 换掉 `startsWith('mkdir ')` **之前**，同一个变异红 **11** 条，多出的 7 条只是夹具失配（详见第 7 处偏离）—— 别把 11 当成本刀的红数。
55. **（第二修复刀）** 删掉 `planHashOf` 里那五行前置条件 ⇒ 实测 **只红** `the plan hash refuses a field that is not a non empty string`，**76 → 75 / 1**。
56. **（第二修复刀）** 删掉 `assertEveryCallCarriesTheTrustAnchor` 里的 `assert.ok(request !== undefined, …)`（这是**给一个长久携带的未钉守卫补钉子**，不是新增守卫）⇒ 实测 **只红** `the anchor helper names a call that did not record its request`，**76 → 75 / 1**。**红法要说准：** 不是"断言自己失败"，而是 `assert.throws(…, /the fetchPublic call did not record its request/u)` 报 **"The input did not match the regular expression … Input: TypeError: Cannot read properties of undefined (reading 'host')"** —— 去掉守卫后未定义的 `request` **仍然会抛**（在 `request.host` 上）。所以这条守卫是**诊断/文案质量**守卫，**不是**静默放行的洞（前一版复核把它按"未钉的静默通道"记过一次，口径在此更正）。这条测试钉的是它的**报错文案**，不是"拦住一次静默通过"。
57. **对照变异（必须保持全绿，第二修复刀的那一次）**：把 `not-acquired` 分支里那句 `reason: 'the channel is already locked',` 改写成 `'a lock is already held on this channel',` ⇒ 实测 **76/76 全绿**（`# pass 76 / # fail 0`）⇒ 这套变异装置不是"改什么都红"。
58. **（第二修复刀，灵敏度探针）** 把 `CHANNEL_CHARACTERS` 的推导（`[...new Set(CHANNELS.join(''))].join('')`）换成写死的 `'abcdefghijklmnopqrstuvwxyz'` ⇒ 实测 **76/76 全绿** ⇒ 字符集的**取值来源**确实没被钉住（钉住的是它与白名单**同宽**：一端遍历 `CHANNELS`、一端拦七个恶意串）。这条是**故意的**，记在「刻意不钉」清单第 ⑥ 项里。**它是本刀的第二次对照变异性质**（预期留绿并且确实留绿），因此也计入"对照"次数而不是"变异"次数。

**第三修复刀追加的变异（第 59–64 条，套件规模 78 条；第 61 条钉 `version` 的字母表、第 62 条是复核方那条"位置"读数的重跑、第 63 条是必须留绿的对照、第 64 条是灵敏度探针）：**

59. **（第三修复刀）** 把 `assertSafeChannel` 里 `CHANNELS.includes(channel)` 那一臂（连同它的 `throw` 三行）删掉 ⇒ 实测 **红 2 条**：`a channel that could escape its remote path never reaches a remote call`（靠新成员 `internall`）与 `the plan hash refuses a channel outside the whitelist`（`planHashOf` 走的是**同一层**判据），**78 → 76 / 2**。**不是"只红一条"，口径写清楚**：这一臂是**同一个谓词**，两条红都直接钉它；第六处那条原读数（去掉整道前置条件 ⇒ 76 → 75）是**上一刀**的读数，与本次不同口径。
60. **（第三修复刀）** 删掉 `planHashOf` 里的 `assertSafeChannel(input.channel);` 这一行 ⇒ 实测 **只红** `the plan hash refuses a channel outside the whitelist`，**78 → 77 / 1**。这是第九处"通道那一半必须由依赖它的那个函数自己保证"的钉子（`planHashOf` 的输出是锁的 `planHash` 与 staging 目录名的一部分）。
61. **（第三修复刀）** 把 `SEMVER_PATTERN` 里 build metadata 的字符类 `[0-9A-Za-z-]` 改成 `[0-9A-Za-z;-]`（只改 `(?:\+…)` 那一段）⇒ 实测 **只红** `the version the input gate admits carries no shell metacharacter and no newline`（载荷 `1.2.3+;id` 被放行），**78 → 77 / 1**。⇒ 第九处里 `version` 的（a）类归属**在字母表这一侧**被机械钉住了；插值那一侧归 Task 4 的验收项 7③。
62. **（第三修复刀，复核方那条"位置"读数的重跑）** 把第六处的守卫从 `lockPath` **挪到** `acquireChannelLock`（两处一起改：`lockPath` 里删掉那行、`acquireChannelLock` 开头加一行）⇒ 实测 **只红** `a channel that could escape its remote path never reaches a remote call`，**78 → 77 / 1**。**复核方在 76 条套件上读到的是 `76 → 75 / 1`（同一个测试名）**，两次读数一致 ⇒ 这条守卫的**位置**（挂在四个入口共用的那个咽喉上、而不是只挂在 acquire 上）**是被用例机械钉住的**，不只是散文里的理由（`breakChannelLock` 那条断言正是抓它的那一半）。
63. **对照变异（必须保持全绿，第三修复刀的那一次）**：把 `not-acquired` 分支里那句 `reason: 'the channel is already locked',` 改写成 `'a lock is already held on this channel',` ⇒ 实测 **78/78 全绿**（`# pass 78 / # fail 0`，退出码 0）⇒ 这套变异装置不是"改什么都红"。
64. **（第三修复刀，灵敏度探针）** 把 `assertSafeChannel` 里的**字符集循环**整段删掉 ⇒ 实测 **78/78 全绿**（`ℹ pass 78 / ℹ fail 0`）⇒ 字符集那一层现在被上面新增的**白名单检查完全蕴含**，今天没有任何一条用例能把它单独钉住。**这条是故意的**（保留它是为了将来白名单里加进一个含 shell 元字符的值时还有一层拦得住），记在「刻意不钉」清单第 ⑦ 项里；**同时**它说明第 58 条的读数必须带时代：那一刀量的是"字符集的**取值来源**没被钉住"，本刀量的是"字符集这层**整层**都没被钉住"。

**第三修复刀的两份规定块同步（实测读数）：** 本刀的代码改动落在两份镜像**里面**，所以两份围栏按新文件内容重新同步，并用"逐行相等**且连续**、边界写明"的检查跑过六份：读数 **`MIRRORS 6  MISSING 0`**（`test 1-374` / `mjs 1-144` / `test 376-561` / `mjs 146-198` / `test 563-868` / `mjs 200-438`，六条逐行相等且连续、偏移都是 0）；**边界变化两处**：Task 3 那份测试镜像 **563–861（299 行）⇒ 563–868（306 行）**（`the plan hash binds …` 的 channel 探针由 `'changed'` 换成白名单值 `'stable'`，+7 行）、模块那份 **200–432（233 行）⇒ 200–438（239 行）**（+6 行）。**同一套检查的负对照**（把 `test 563-868` 切片从**中间**抽掉一行再跑）⇒ `MISSING test 563-868`、`MIRRORS 6  MISSING 1` ⇒ 检查器**抓得到"从中间撑开"**，不是只会数行数。

**本修复刀的变异次数：** 第 35–49 条各一次 = **15 次变异**，第 51 条 = **1 次**，外加 1 次对照变异（第 50 条）= **17 次运行** ⇒ Task 3 累计 **61 次变异 + 2 次对照 = 63 次运行**。 **第二修复刀追加：** 第 52–56 条各一次 = **5 次变异**，外加 2 次对照变异（第 57、58 条）= **7 次运行** ⇒ Task 3 累计 **66 次变异 + 4 次对照 = 70 次运行**。另有**一次不计入次数的测量**（它是"规定套件的灵敏度"读数，不是对当前代码的变异）：HEAD 模块 + HEAD 套件、只把 `OWNER_RECORD.operator` 夹具值换成注入载荷 ⇒ **70/70 全绿**。（第 5 条在 69 条套件上的**重跑**是**测量**，不是新变异，不计入次数。）每一次都先断言锚点**恰好匹配一次**、变异后确认**文件在磁盘上真的变了**、跑完**逐字节恢复**并核对恢复后的 SHA-256 与变异前一致；对照那条是"必须留绿"的那一次。 **第三修复刀追加：** 第 59–62 条各一次 = **4 次变异**，外加 2 次对照/探针（第 63、64 条）= **6 次运行** ⇒ Task 3 累计 **70 次变异 + 6 次对照 = 76 次运行**。本刀这 6 次运行全部走同一个装置，读数照录：**变异前**先取文件 sha256 基线（`feed-publish.mjs` 读数 `5e03668734138c552b957984b0ab8685869b24c9250e1e0375845791d03a7e88`，**这是本刀那一刻的读数、不是稳定值**）、断言锚点**恰好匹配一次**（第 62 条是两个锚点各自恰好一次）、确认磁盘上的 sha256 **真的变了**、跑完**逐字节恢复**并核对恢复后的 sha256 **与基线相等**（六次全部 `RESTORE_BYTE_IDENTICAL true`，一次 `REFUSED` 都没有）。

恢复后全绿且 `git diff` 为空。

- [ ] **Step 6: 提交**

```bash
git add scripts/lib/feed-publish.mjs scripts/lib/feed-publish.test.mjs
git commit -m "feat(feed): own the channel lock honestly, including its failure modes"
```

**本刀刻意不钉的东西（复核时别当成缺陷再报一遍）：** `isFileExistsFailure` 正则的 `u` 标志（删掉它改不了任何可观察行为 —— 实测 58/58 全绿）；`planHashOf` 的 `'\n'` 连接符本身（**这条的旧理由已被推翻，只保留结论，且附上证据**：旧理由写的是"五个字段谁也放不进分隔符"，而字段只要求 `trim()` 后非空、**可以含换行**，所以那句话是**假的**。复核者给出的碰撞实例，本刀照录：`channel='internal\n1.2.3', version='x'` 与 `channel='internal', version='1.2.3\nx'` 两个输入的哈希**完全相同** —— `'\n'` 连接在字段边界上是**歧义**的。**本刀复现过（不是转述）**：三个摘要固定为 `'a'` / `'b'` / `'c'` 时，两个输入都得到 `d3d0b28f49ee2ce52eac80bb5b2b831fee3101706a986e817b05416aa6fe263c`（`COLLISION true`）。仍然不换分隔符、也不改写成长度前缀或逐字段分别哈希的绑定，理由是**接线路径上撞不到**：`channel` 被第六处的字符集前置条件限成白名单字符（不含换行，含换行会被拒），`version` 被 Task 1 的严格 SemVer 正则限死（`SEMVER_PATTERN` 不含换行），另外三个摘要是 `sha256` 的十六进制。**这是一条"有证据、有边界说明"的记录，不是"不可能被触发的不变量"** —— 本刀第八处的前置条件只保证五个字段是**非空字符串**，**不**保证它们不含换行；谁以后把换行放进 `channel` 或 `version`，谁就得自己负责。钉住的仍然只是**逐字段**的敏感度：`the plan hash binds channel, version and all three artifact digests` 对五个字段各改一次值并断言哈希都变）；`readOwnerRecord` 对读到 stdout 的 `.trim()`（`JSON.parse` 自己容空白，实测删掉它 58/58 全绿）；`?? 'unknown'` 这个 operator 默认字面量（钉住的是该字段**存在**，不是它的默认文本 —— 实测换成别的字面量 58/58 全绿）；以及所有人类可读的 `reason` 文案 —— 它们是散文，任何地方都不断言，这是**刻意**的（对照：`an owner record that matches the runid but not the plan hash is ownership unknown` 只断言 `reason` 里出现 `planHash`，不比对整句）。 **第 1–34 条（含第 5 条里的 `58 → 57`）与「刻意不钉」清单里的 `58/58` 都是 58 条套件时代的读数**；套件在修复刀涨到 69 条后，这些**计数**必须重跑才有效（名字级的预测不受影响）。

**本修复刀加进这份名单的：** ① owner 校验的报错文案 `the owner record must carry a non empty <field>, so no lock is created without one` —— 散文，被测的只有**字段名**（`/machine/u` 等），整句不断言；② owner 为 `null`/`undefined` 时报的是**清单里第一个**字段（`runid`）——**检查顺序刻意不钉**（`a missing owner record never creates a lock` 只断言抛的是 `FeedPublishError` 且消息含 `owner record`）：顺序不是 §6.6 的要求，只是实现细节；③ `resolveLockDisposition` 对两个前提的 `!== true` 严格性（真值但非 `true`，例如 `'yes'`）——那是既有那一臂的语义，本刀只做透传，测试只覆盖 `false` 与"缺省"两种；④ 助手 `assertEveryCallCarriesTheTrustAnchor` 自己的**断言文案** —— **只剩文案**：该助手的**非空守卫**（`calls.length > 0`，零调用不许空过）本刀已用 `the anchor helper refuses an empty call list rather than passing on zero calls` **钉住**（第 51 条），因此它**不在**这份"刻意不钉"名单里。

**第二修复刀加进这份名单的：** ⑤ `assertSafeChannel` 的两条报错文案（`the channel is empty, so it cannot be interpolated into a remote path` 与 `the channel … carries … which no channel in the whitelist uses …`）—— 散文，被测的只有"抛的是 `FeedPublishError`"与"调用表为空"，整句与 `JSON.stringify(character)` 那截转义**都不断言**；⑥ 第六处字符集判据的**取值来源**（`[...new Set(CHANNELS.join(''))].join('')`）—— 钉住的不是这份推导本身，而是它的**两端**：`the channel precondition admits every channel the whitelist allows` 遍历 `CHANNELS`（不许更窄），`a channel that could escape its remote path never reaches a remote call` 拦住七个恶意串（不许更松）；**实测（第 58 条）：** 把推导换成**写死的** `'abcdefghijklmnopqrstuvwxyz'` ⇒ **76/76 全绿** —— 也就是"怎么从白名单导出字符集"是**刻意不钉**的实现细节，钉住的是它与白名单**同宽**（一端遍历 `CHANNELS` 不许更窄、一端拦住七个恶意串不许更松）。

**第三修复刀加进这份名单的：** ⑦ `assertSafeChannel` 里那层**字符集循环**（`CHANNEL_CHARACTERS` 的逐字符检查）—— 本刀在它上面加了一层白名单检查之后，它**被完全蕴含**：删掉整段循环**78/78 全绿**（第 64 条）。**保留它不是冗余**：白名单检查只保证"值在 `CHANNELS` 里"，字符集那层保证的是"这个值里没有 shell 元字符"—— 将来谁往 `CHANNELS` 里加一个含元字符的频道，**只有这一层拦得住**（白名单检查会放行）。它今天不可达 ⇒ **刻意不钉**；要钉它得能从测试里改 `CHANNELS`（该常量已 `Object.freeze`），代价大于收益。**别按"死代码 / 没人钉的守卫"再报一次**。

**仓库事实（省得下次再去查门禁覆盖）：** `eslint.config.mjs` 的 `ignores` 含 `scripts/**` 与 `**/scripts/**`，所以本模块由 `node --test`、prettier `format:check` 与 knip 覆盖，**不被 eslint 覆盖**；"代码里不写注释"与"代码里不出现 CJK"这两条（`docs/agent-rules/frontend.md`）在本模块上因此**靠人工扫**，而不是靠门禁。

---

### Task 4: 主流程（13 步追踪表的逐行实现）

**Files:**

- Modify: `scripts/lib/feed-publish.mjs`
- Modify: `scripts/lib/feed-publish.test.mjs`

**每写一个 helper，立刻在 `runCommit` 里接上**；不允许出现"定义了但没接"的 helper。

**`planCommit` 的契约要在本刀显式定下来**：Task 2 的 `planCommit` 丢掉了 `verifyLocalArtifacts` 的返回值，而本刀的 `planHashOf` 需要全部三个摘要 ⇒ 本刀必须二选一并在代码里写实——要么在 Task 4 内部自己重新调一次 `verifyLocalArtifacts` 拿摘要，要么扩宽 `planCommit` 的返回值让它把摘要带出来——不允许两种做法并存，也不允许把 `planCommit` 的契约留成歧义。

**计划的形状只有一处推导、两处使用**：`planCommit` 返回 `PUBLISH_STAGES.map((stage) => ({ stage, status: 'pending' }))`，而本刀 `runCommit` 里的 `stages` 是**同一表达式的第二份拷贝**。两份一旦漂移（`--dry-run` 打印出来的计划与审计日志里的阶段列表不是同一个形状），**没有任何测试会红**。二选一并在代码里写实：要么让 `runCommit` 接收 `planCommit` 产出的计划数组（单点推导），要么把两份推导保持**逐字相同**，并在本刀的变异清单里加一条"只改其中一份 ⇒ 指定测试按测试名变红"把这条接线钉住。不允许留成两份没人看着的拷贝。

**owner 记录的三个新字段从哪里来（本刀接线，不许在 `scripts/lib/` 里取系统值）：** §6.6（spec 行 319）要求锁内写全五个字段，而 Task 3 的 `acquireChannelLock` 现在会**逐字段 fail closed**（缺一个就抛 `FeedPublishError`，且**在任何远程调用之前**），所以 `runCommit` 必须把完整记录交给它：`runid` 用本刀的 `randomUUID()`、`planHash` 用 `planHashOf` 的结果，另外三个**由调用方注入**——`operator` 取 CLI 已有的 `MOFANG_FEED_OPERATOR`（Task 7 的 `--break-lock` 分支已经在读它）、`startedAt` 取 CLI 启动时的 `new Date().toISOString()`、`machine` 取 `hostname()`（**不是 `os.hostname()`** —— 见 Task 7 那段的警告；照抄 `os.hostname()` 会 `ReferenceError`）。**`scripts/lib/feed-publish.mjs` 是纯模块：不许出现 `new Date()` 或 `hostname()` / `os.hostname()`**（否则这两个值在测试里只能靠打桩，接线就不可注入）；因此 **Task 7 的 `runCommit` 调用必须把 `operator` / `startedAt` / `machine` 三个值一起传进来**，否则发布会在锁这一步以 `FeedPublishError` 停下（那是诚实的失败，不是回归）。**同一条要求也落在本刀规定的测试夹具上**：`commitInput` 必须显式带上 `operator: 'ops'` / `startedAt: '2026-09-22T00:00:00.000Z'` / `machine: 'builder-01'`（假值，与 Task 3 的 `OWNER_RECORD` 同形，**不得**在测试里调 `new Date()` 或 `os.hostname()`），否则规定的那批 `runCommit` 用例会在锁这一步**全部**抛 `FeedPublishError` —— 五字段校验是在**任何远程调用之前** fail closed 的，夹具缺一个字段就没有一条 `runCommit` 用例能走到第二步。

**两个解锁点都不传 `owner`（§6.6 前提 2 的落地）：** `releaseAndFinish` 与成功路径的 `releaseChannelLock` 调用都**不传 `owner`**，让 `releaseChannelLock` 里的 `input.owner ?? (await readOwnerRecord(input))` 在**解锁那一刻**重新读 `owner.json`。原因：§6.6（spec 行 345）要求"解锁前**重新读取** `owner.json`"并与本次运行比对；先读一次（步骤 5 那次）再把那个快照传进来，等于把步骤 6 → 步骤 13 这段窗口空着——锁在这个窗口里被撞破并被另一个运行重新拿到时，本次运行会**删掉别人的锁**。传 `owner` 会让 §6.6 的前提 2 成为死代码。

**两处 `safeToExit: true` 为什么是诚实的：** 四个 `releaseAndFinish` 调用点（`commit-version` 的三条失败 + 设备号不一致那一条）与成功路径都在**翻转之前**（成功路径是翻转之后**且公网复验已经通过**），§6.6 的保留表（spec 行 331）说"翻转之前失败且**非 CAS 不匹配** ⇒ 确定 ⇒ `fail` ⇒ **释放锁**"，而"翻转之后失败"那一行要的是**不确定**的结果——这里任何一个 `releaseAndFinish` 调用点都是**已经确定**的失败，没有任何"远端状态可能已被改变"的不确定性，所以 `true` 不是乐观假设而是那张表的结论。`retainAndFinish` 走的仍是 `safeToExit: false`（保留锁），两条路各自被规定的用例钉住。

- [ ] **Step 1: 写失败的测试（async 假 transport）**

追加到 `scripts/lib/feed-publish.test.mjs`：

```js
import {
  PORTABLE_FILE_MANIFEST_NAME,
  PORTABLE_PACKAGE_NAME,
  appendAuditStage,
  runCommit,
  verifyPublicArtifacts,
} from './feed-publish.mjs';
import { buildPortableRelease, verifyPortableRelease } from './portable-update-release.mjs';

const BASELINE_BODY = '{"baseline":true}\n';
const THIRD_BODY = '{"third":true}\n';
const digestOf = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const BASELINE_SHA = digestOf(BASELINE_BODY);
const THIRD_SHA = digestOf(THIRD_BODY);

const auditEntriesOf = (auditOut) =>
  readFileSync(auditOut, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

function commitTransport(options = {}) {
  const calls = [];
  let manifestReads = 0;
  let ownerJson = null;
  const listing = `f ${PORTABLE_PACKAGE_NAME} ${PACKAGE_BYTES.length}\nf ${PORTABLE_FILE_MANIFEST_NAME} ${FILE_MANIFEST_BYTES.length}\n`;
  const stagingListing = options.stagingListing ?? listing;
  const digests = (directory, zipDigest) =>
    `${zipDigest}  ${directory}/${PORTABLE_PACKAGE_NAME}\n${FILE_MANIFEST_SHA256}  ${directory}/${PORTABLE_FILE_MANIFEST_NAME}\n`;

  return {
    anchor: null,
    calls,
    readOnly: {
      sshRun: async (request) => {
        calls.push(['readSsh', request.script, request]);
        if (request.script.includes('owner.json')) {
          if (options.foreignOwnerFromReVerify === true) {
            return { status: 0, stdout: JSON.stringify({ runid: 'other', planHash: 'other' }), stderr: '' };
          }
          return ownerJson === null
            ? { status: 1, stdout: '', stderr: 'no such file' }
            : { status: 0, stdout: ownerJson, stderr: '' };
        }
        if (request.script.includes('-mindepth 1 -maxdepth 1 -printf')) {
          if (typeof options.listingStatus === 'number' && options.listingStatus !== 0) {
            return { status: options.listingStatus, stdout: 'find: Permission denied\n', stderr: '' };
          }
          if (request.script.includes('/staging/')) return { status: 0, stdout: stagingListing, stderr: '' };
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
          if (typeof options.directoryProbeStatus === 'number' && options.directoryProbeStatus !== 0) {
            return { status: options.directoryProbeStatus, stdout: 'present\n', stderr: 'connection reset' };
          }
          const state = options.versionDirState ?? 'absent';
          const present = state !== 'absent';
          const insideStaging = request.script.includes('/staging/');
          if (!present && !insideStaging) return { status: 0, stdout: '', stderr: '' };
          return { status: 0, stdout: 'present\n', stderr: '' };
        }
        if (request.script.includes('sha256sum') && request.script.includes('portable-files.json')) {
          if (typeof options.digestStatus === 'number' && options.digestStatus !== 0) {
            return { status: options.digestStatus, stdout: '', stderr: 'sha256sum: Permission denied' };
          }
          const inStaging = request.script.includes('/staging/');
          if (!inStaging && (options.versionDirState ?? 'absent') === 'absent')
            return { status: 0, stdout: '', stderr: '' };
          const zipDigest = options.versionDirState === 'digest' ? THIRD_SHA : PACKAGE_SHA256;
          return { status: 0, stdout: digests(inStaging ? 'staging' : 'version', zipDigest), stderr: '' };
        }
        if (request.script.includes("stat -c '%d'")) {
          if (typeof options.deviceProbeStatus === 'number' && options.deviceProbeStatus !== 0) {
            return { status: options.deviceProbeStatus, stdout: '100\n100\n', stderr: 'stat: cannot statx' };
          }
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
          if (options.baselineDigestAbsent === true && manifestReads === 1) {
            return { status: 0, stdout: '', stderr: '' };
          }
          const digest = options.casDrift === true && manifestReads > 1 ? THIRD_SHA : BASELINE_SHA;
          return { status: 0, stdout: `${digest}  ${UPDATE_ROOT}/internal/manifest.json\n`, stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    },
    write: {
      sshRun: async (request) => {
        calls.push(['writeSsh', request.script, request]);
        if (
          request.script.startsWith('mkdir -p ') &&
          typeof options.stagingCreateStatus === 'number' &&
          options.stagingCreateStatus !== 0
        ) {
          return {
            status: options.stagingCreateStatus,
            stdout: '',
            stderr: 'mkdir: cannot create directory: Permission denied',
          };
        }
        if (isLockDirectoryCommand(request)) {
          if (typeof options.lockStatus === 'number' && options.lockStatus !== 0) {
            return {
              status: options.lockStatus,
              stdout: '',
              stderr: options.lockStderr ?? 'mkdir: cannot create directory: File exists',
            };
          }
          return options.lockState === 'exists'
            ? { status: 1, stdout: '', stderr: 'mkdir: cannot create directory: File exists' }
            : { status: 0, stdout: '', stderr: '' };
        }
        const ownerMatch = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > /u.exec(request.script);
        if (ownerMatch !== null) {
          if (typeof options.ownerWriteStatus === 'number' && options.ownerWriteStatus !== 0) {
            return { status: options.ownerWriteStatus, stdout: '', stderr: 'read only file system' };
          }
          ownerJson = Buffer.from(ownerMatch[1], 'base64').toString('utf8');
        }
        if (
          request.script.startsWith('rmdir ') &&
          typeof options.lockRemovalStatus === 'number' &&
          options.lockRemovalStatus !== 0
        ) {
          return {
            status: options.lockRemovalStatus,
            stdout: '',
            stderr: 'rmdir: failed to remove: Directory not empty',
          };
        }
        if (
          /^mv \/opt\/rongying\/updates-state\/staging\//u.test(request.script) &&
          options.commitStatus !== undefined
        ) {
          if (options.foreignOwnerAfterCommit === true) {
            ownerJson = JSON.stringify({ runid: 'other', planHash: 'other' });
          }
          return { status: options.commitStatus, stdout: '', stderr: 'commit refused' };
        }
        if (options.foreignOwnerAfterFlip === true && /^mv -f \S+\.tmp /u.test(request.script)) {
          ownerJson = JSON.stringify({ runid: 'other', planHash: 'other' });
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
      if (options.manifestBodyMissing === true && url.endsWith('manifest.json')) {
        return { status: 200 };
      }
      const body = url.endsWith('manifest.json')
        ? (options.publicManifestBody ?? BASELINE_BODY)
        : url.endsWith('portable.zip')
          ? (options.publicPackageBody ?? PACKAGE_BYTES.toString('binary'))
          : (options.publicFileManifestBody ?? FILE_MANIFEST_BYTES.toString('binary'));
      return { status: 200, bodyBytes: Uint8Array.from(Buffer.from(body, 'binary')) };
    },
  };
}

function commitInput(transport, overrides = {}) {
  const auditRoot = makeRoot();
  const paths = writeArtifacts();
  const input = {
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
    transport,
    ...paths,
    ...overrides,
  };
  transport.anchor = { host: input.host, knownHostsPath: input.knownHostsPath };
  return input;
}

function assertEveryCommitCallCarriesTheTrustAnchor(transport) {
  const anchor = transport.anchor;
  assert.ok(anchor !== undefined && anchor !== null, 'the commit anchor assertion needs an input that injected a host');
  const sshCalls = transport.calls.filter((call) => call[0] === 'readSsh' || call[0] === 'writeSsh');
  assert.ok(sshCalls.length > 0, 'the commit anchor assertion needs at least one recorded ssh call');
  for (const call of sshCalls) {
    const request = call[2];
    assert.ok(request !== undefined, `the ${String(call[0])} call did not record its request`);
    assert.equal(request.host, anchor.host, `the ${String(call[0])} call did not carry the injected host`);
    assert.equal(
      request.knownHostsPath,
      anchor.knownHostsPath,
      `the ${String(call[0])} call did not carry the injected known hosts file`,
    );
  }
}

function manifestShaOf(paths) {
  return createHash('sha256').update(readFileSync(paths.manifestPath)).digest('hex');
}

function happyTransport(paths, extra = {}) {
  return commitTransport({
    publicManifestBody: readFileSync(paths.manifestPath).toString('binary'),
    tempManifestSha: manifestShaOf(paths),
    ...extra,
  });
}

test('the commit anchor helper refuses a case that recorded no call', () => {
  assert.throws(() =>
    assertEveryCommitCallCarriesTheTrustAnchor({ anchor: { host: 'h', knownHostsPath: 'k' }, calls: [] }),
  );
  assert.throws(() =>
    assertEveryCommitCallCarriesTheTrustAnchor({
      anchor: null,
      calls: [['readSsh', 'ls', { host: 'h', knownHostsPath: 'k' }]],
    }),
  );
});

test('the commit anchor helper names a call that did not record its request', () => {
  assert.throws(
    () =>
      assertEveryCommitCallCarriesTheTrustAnchor({
        anchor: { host: 'h', knownHostsPath: 'k' },
        calls: [
          ['fetchPublic', 'https://example.invalid'],
          ['readSsh', 'ls'],
        ],
      }),
    /the readSsh call did not record its request/u,
  );
});

test('the local pre-verification happens before any network write', async () => {
  const transport = commitTransport();
  const input = commitInput(transport);
  const result = await runCommit({ ...input, packagePath: join(makeRoot(), 'missing.zip') });
  assert.equal(result.outcome, 'fail');
  assert.deepEqual(
    transport.calls.filter((call) => call[0] !== 'readSsh'),
    [],
  );
  assert.deepEqual(transport.calls, []);
});

test('a clean publish walks every stage and releases its own lock', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
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
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
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
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
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
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.equal(result.stages.find((entry) => entry.stage === 'flip').status, 'pending');
  const tempManifest = auditEntriesOf(input.auditOut).find((entry) => entry.stage === 'temp-manifest');
  assert.equal(tempManifest.manifestSha256, manifestShaOf(paths));
  assert.equal(tempManifest.remoteTempSha256, 'F'.repeat(64));
});

test('a manifest upload failure is an incident that keeps the lock', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { manifestUploadStatus: 1 });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.equal(result.stages.find((entry) => entry.stage === 'flip').status, 'pending');
  const tempManifest = auditEntriesOf(input.auditOut).find((entry) => entry.stage === 'temp-manifest');
  assert.equal(tempManifest.manifestSha256, manifestShaOf(paths));
  assert.equal('remoteTempSha256' in tempManifest, false);
});

test('a cas mismatch is an incident that keeps the lock and never rolls anything back', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { casDrift: true });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
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
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'retry');
  assert.equal(result.lockState, 'retained-by-this-run');
  const publicVerify = auditEntriesOf(input.auditOut).find((entry) => entry.stage === 'public-verify');
  assert.equal(publicVerify.status, 'retry');
  assert.equal(publicVerify.observedManifestSha256, BASELINE_SHA);
  assert.equal(publicVerify.previousManifestSha256, BASELINE_SHA);
  assert.equal(publicVerify.manifestSha256, manifestShaOf(paths));
});

test('an indeterminate outcome with a third public sha stops and keeps the lock', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { publicManifestBody: THIRD_BODY });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.match(result.reason, /third/u);
  const publicVerify = auditEntriesOf(input.auditOut).find((entry) => entry.stage === 'public-verify');
  assert.equal(publicVerify.observedManifestSha256, THIRD_SHA);
  assert.equal(publicVerify.previousManifestSha256, BASELINE_SHA);
  assert.equal(publicVerify.manifestSha256, manifestShaOf(paths));
});

test('a staging failure is a plain failure and reports that no lock was acquired', async () => {
  const paths = writeArtifacts();
  const transport = commitTransport({ uploadStatus: 1 });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.equal(result.lockState, 'not-acquired');
  assert.equal(result.stages.find((entry) => entry.stage === 'lock').status, 'pending');
});

test('a failure after the lock but before the flip releases the lock this run owns', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { commitStatus: 1 });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.equal(result.lockState, 'released');
  assert.equal(result.stages.find((entry) => entry.stage === 'unlock').status, 'done');
});

test('the commit never runs when the lock already exists', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { lockState: 'exists' });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.lockState, 'not-acquired');
  assert.equal(result.stages.find((entry) => entry.stage === 'commit-version').status, 'pending');
});

test('a staging directory and a final directory on different file systems stops the commit', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { sameFileSystem: false });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.match(result.reason, /file system/u);
  assert.equal(result.lockState, 'released');
});

test('an existing version directory that is empty is incomplete and refused', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { versionDirState: 'empty' });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.match(result.reason, /incomplete/u);
});

test('an existing version directory with an extra entry is refused', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { versionDirState: 'extra' });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.match(result.reason, /unexpected entry/u);
});

test('an existing version directory with a different size is refused', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { versionDirState: 'size' });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.match(result.reason, /size/u);
});

test('an existing version directory with a different digest is refused', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { versionDirState: 'digest' });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.match(result.reason, /digest/u);
});

test('an existing version directory that matches every byte is reused', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { versionDirState: 'present' });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'done', result.reason);
  assert.equal(result.stages.find((entry) => entry.stage === 'commit-version').status, 'done');
});

test('every stage is appended to the audit log as it happens', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'done', result.reason);
  const stages = auditEntriesOf(input.auditOut).map((entry) => entry.stage);
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
    expectedManifestBytes: readFileSync(paths.manifestPath),
    expectedPackageSha256: PACKAGE_SHA256,
    expectedPackageSize: PACKAGE_BYTES.length,
    expectedFileManifestSha256: FILE_MANIFEST_SHA256,
    expectedFileManifestSize: FILE_MANIFEST_BYTES.length,
    temporaryRoot: makeRoot(),
    transport: {
      fetchPublic: async (url) => {
        calls.push(url);
        if (url.endsWith('manifest.json'))
          return { status: 200, bodyBytes: Uint8Array.from(readFileSync(paths.manifestPath)) };
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
    expectedManifestBytes: readFileSync(paths.manifestPath),
    expectedPackageSha256: PACKAGE_SHA256,
    expectedPackageSize: PACKAGE_BYTES.length,
    expectedFileManifestSha256: FILE_MANIFEST_SHA256,
    expectedFileManifestSize: FILE_MANIFEST_BYTES.length,
    temporaryRoot: makeRoot(),
    transport: {
      fetchPublic: async (url) => {
        if (url.endsWith('manifest.json'))
          return { status: 200, bodyBytes: Uint8Array.from(readFileSync(paths.manifestPath)) };
        if (url.endsWith('portable.zip')) return { status: 200, bodyBytes: Uint8Array.from(Buffer.from('other')) };
        return { status: 200, bodyBytes: Uint8Array.from(FILE_MANIFEST_BYTES) };
      },
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /package/u);
});

test('a staging directory that cannot be created is a plain failure', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { stagingCreateStatus: 1 });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.equal(result.lockState, 'not-acquired');
  assert.match(result.reason, /staging directory could not be created/u);
  assert.equal(result.stages.find((entry) => entry.stage === 'lock').status, 'pending');
});

test('the public verification is actually run after the flip', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { publicPackageBody: Buffer.from('other').toString('binary') });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.match(result.reason, /public package integrity/u);
  const publicVerify = auditEntriesOf(input.auditOut).find((entry) => entry.stage === 'public-verify');
  assert.equal(publicVerify.detail, 'the public package integrity check failed');
  assert.equal(publicVerify.observedManifestSha256, manifestShaOf(paths));
});

test('a lock that fails for any reason other than an existing entry is an incident', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, {
    lockStatus: 1,
    lockStderr: 'mkdir: cannot create directory /opt/rongying/updates-state/lock: Permission denied',
  });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'ownership-unknown');
  assert.equal(result.stages.find((entry) => entry.stage === 'lock').status, 'incident');
  assert.equal(result.stages.find((entry) => entry.stage === 'commit-version').status, 'pending');
  const removals = transport.calls.filter(
    (call) => call[0] === 'writeSsh' && /(?:^|\s)(?:rm|rmdir) /u.test(String(call[1])),
  );
  assert.deepEqual(removals, []);
});

test('an owner write that fails after the lock is an incident that keeps the lock', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { ownerWriteStatus: 1 });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.equal(result.stages.find((entry) => entry.stage === 'lock').status, 'incident');
  assert.equal(result.stages.find((entry) => entry.stage === 'unlock').status, 'retained');
  assert.equal(result.stages.find((entry) => entry.stage === 'commit-version').status, 'pending');
  const entries = auditEntriesOf(input.auditOut);
  assert.equal(entries.at(-1).stage, 'lock-retained');
  assert.ok(entries.every((entry) => entry.stage !== 'unlock' || entry.status !== 'done'));
});

test('an owner record replaced before the unlock stops the run and deletes nothing', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { foreignOwnerAfterFlip: true });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'ownership-unknown');
  assert.equal(result.stages.find((entry) => entry.stage === 'flip').status, 'done');
  assert.equal(result.stages.find((entry) => entry.stage === 'unlock').status, 'retained');
  const removals = transport.calls.filter(
    (call) => call[0] === 'writeSsh' && /(?:^|\s)(?:rm|rmdir) /u.test(String(call[1])),
  );
  assert.deepEqual(removals, []);
  const entries = auditEntriesOf(input.auditOut);
  assert.ok(entries.some((entry) => entry.stage === 'unlock' && entry.status === 'retained'));
  assert.ok(entries.every((entry) => entry.stage !== 'unlock' || entry.status !== 'done'));
});

test('an owner record replaced inside the lock window stops the run and touches nothing', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { foreignOwnerFromReVerify: true });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'ownership-unknown');
  assert.equal(result.stages.find((entry) => entry.stage === 'lock').status, 'done');
  assert.equal(result.stages.find((entry) => entry.stage === 're-verify').status, 'incident');
  assert.equal(result.stages.find((entry) => entry.stage === 'commit-version').status, 'pending');
  const removals = transport.calls.filter(
    (call) => call[0] === 'writeSsh' && /(?:^|\s)(?:rm|rmdir) /u.test(String(call[1])),
  );
  assert.deepEqual(removals, []);
});

test('a lock that cannot be removed after a successful publish is not reported as released', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { lockRemovalStatus: 1 });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.notEqual(result.lockState, 'released');
  assert.equal(result.stages.find((entry) => entry.stage === 'unlock').status, 'retained');
  const entries = auditEntriesOf(input.auditOut);
  assert.ok(entries.every((entry) => entry.stage !== 'unlock' || entry.status !== 'done'));
});

test('a public verifier that rejects after the flip is an incident that keeps the lock', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const input = commitInput(transport, {
    ...paths,
    verifier: () => {
      throw new Error('release manifest signature is invalid');
    },
  });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.match(result.reason, /signature is invalid/u);
  const entries = auditEntriesOf(input.auditOut);
  assert.ok(entries.every((entry) => entry.stage !== 'unlock' || entry.status !== 'done'));
  const publicVerify = entries.find((entry) => entry.stage === 'public-verify');
  assert.equal(publicVerify.manifestSha256, manifestShaOf(paths));
  assert.equal(publicVerify.observedManifestSha256, manifestShaOf(paths));
  assert.equal(publicVerify.previousManifestSha256, BASELINE_SHA);
});

test('every early failure records its outcome in the audit log before it returns', async () => {
  const paths = writeArtifacts();
  const fixtures = [
    {
      stage: 'pre-verify',
      transport: commitTransport(),
      overrides: { packagePath: join(makeRoot(), 'missing.zip') },
      outcome: 'fail',
    },
    { stage: 'stage', transport: commitTransport({ uploadStatus: 1 }), overrides: {}, outcome: 'fail' },
    {
      stage: 'remote-verify',
      transport: commitTransport({ stagingListing: `f ${PORTABLE_PACKAGE_NAME} 1\n` }),
      overrides: {},
      outcome: 'fail',
    },
    {
      stage: 'lock',
      transport: happyTransport(paths, { lockState: 'exists' }),
      overrides: { ...paths },
      outcome: 'blocked',
    },
  ];
  for (const fixture of fixtures) {
    const input = commitInput(fixture.transport, fixture.overrides);
    const result = await runCommit(input);
    assert.equal(result.outcome, fixture.outcome, fixture.stage);
    if (fixture.stage === 'pre-verify') {
      assert.deepEqual(fixture.transport.calls, []);
    } else {
      assertEveryCommitCallCarriesTheTrustAnchor(fixture.transport);
    }
    const entries = auditEntriesOf(input.auditOut);
    assert.equal(entries.at(-1).stage, fixture.outcome, fixture.stage);
    assert.equal(entries.at(-1).runid, 'r1', fixture.stage);
    assert.equal(typeof entries.at(-1).reason, 'string', fixture.stage);
  }
});

test('a channel that could escape its remote path is refused before any remote write', async () => {
  const paths = writeArtifacts({
    manifestOverrides: { channel: 'internal/x', packageUrl: `${PUBLIC_BASE_URL}/internal/x/1.2.3/portable.zip` },
  });
  const transport = happyTransport(paths);
  const result = await runCommit(commitInput(transport, { ...paths, channel: 'internal/x' }));
  assert.equal(result.outcome, 'fail');
  assert.deepEqual(transport.calls, []);
});

test('a version that could escape its remote path is refused before any remote write', async () => {
  const paths = writeArtifacts({
    manifestOverrides: { version: '1.2.3;id', packageUrl: `${PUBLIC_BASE_URL}/internal/1.2.3;id/portable.zip` },
  });
  const transport = happyTransport(paths);
  const result = await runCommit(commitInput(transport, { ...paths, version: '1.2.3;id' }));
  assert.equal(result.outcome, 'fail');
  assert.deepEqual(transport.calls, []);
});

test('a run id that could escape its remote path is refused before any remote write', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const result = await runCommit(commitInput(transport, { ...paths, runid: 'r1; id' }));
  assert.equal(result.outcome, 'fail');
  assert.deepEqual(transport.calls, []);
});

test('a sibling whose name begins with two dots is still inside the repository', () => {
  const root = process.cwd();
  assert.throws(
    () => assertKnownHostsPath(join(root, '..foo', 'known_hosts'), root),
    /must live outside the repository/u,
  );
  assert.throws(
    () =>
      appendAuditStage({
        auditOut: join(root, '..foo', 'audit.jsonl'),
        entry: { stage: 'open' },
        repositoryRoot: root,
      }),
    /must live outside the repository/u,
  );
});

test('the real release verifier accepts a canonically signed manifest and rejects an insertion ordered one', async () => {
  const canonicalFileManifest = {
    files: [{ path: 'a.txt', sha256: 'a'.repeat(64), size: 1 }],
    schemaVersion: 1,
    version: '1.2.3',
  };
  const fileManifestBytes = Buffer.from(JSON.stringify(canonicalFileManifest), 'utf8');
  const packageRoot = makeRoot();
  const packagePath = join(packageRoot, PORTABLE_PACKAGE_NAME);
  writeFileSync(packagePath, PACKAGE_BYTES);
  const built = await buildPortableRelease({
    baseUrl: PUBLIC_BASE_URL,
    channel: 'internal',
    version: '1.2.3',
    minLauncherVersion: '1.0.0',
    publishedAt: '2026-09-22T00:00:00.000Z',
    signingKeyPem: keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyBase64: PUBLIC_KEY_BASE64,
    packagePath,
    fileManifest: canonicalFileManifest,
    fileManifestBytes,
  });
  assert.equal(
    createHash('sha256').update(built.fileManifestBytes).digest('hex'),
    createHash('sha256').update(fileManifestBytes).digest('hex'),
  );

  const serving = (manifestBytes, packageBytes) => ({
    fetchPublic: async (url) => {
      if (url.endsWith('manifest.json')) return { status: 200, bodyBytes: Uint8Array.from(manifestBytes) };
      if (url.endsWith('portable.zip')) return { status: 200, bodyBytes: Uint8Array.from(packageBytes) };
      return { status: 200, bodyBytes: Uint8Array.from(fileManifestBytes) };
    },
  });
  const publicInput = (manifestBytes, packageBytes, expectedManifestBytes) => ({
    channel: 'internal',
    version: '1.2.3',
    publicKeyBase64: PUBLIC_KEY_BASE64,
    verifier: verifyPortableRelease,
    expectedManifestBytes,
    expectedPackageSha256: createHash('sha256').update(packageBytes).digest('hex'),
    expectedPackageSize: packageBytes.length,
    expectedFileManifestSha256: createHash('sha256').update(fileManifestBytes).digest('hex'),
    expectedFileManifestSize: fileManifestBytes.length,
    temporaryRoot: makeRoot(),
    transport: serving(manifestBytes, packageBytes),
  });

  const accepted = await verifyPublicArtifacts(publicInput(built.manifestBytes, PACKAGE_BYTES, built.manifestBytes));
  assert.equal(accepted.ok, true, accepted.reason);

  const insertionOrdered = signedManifest();
  await assert.rejects(
    verifyPublicArtifacts(publicInput(insertionOrdered, PACKAGE_BYTES, insertionOrdered)),
    /release manifest signature is invalid/u,
  );
});

test('an owner record replaced before the unlock on the failure path stops the run and deletes nothing', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { commitStatus: 1, foreignOwnerAfterCommit: true });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.equal(result.reason, 'the version directory was not committed');
  assert.equal(result.lockState, 'ownership-unknown');
  assert.equal(result.stages.find((entry) => entry.stage === 'commit-version').status, 'fail');
  assert.equal(result.stages.find((entry) => entry.stage === 'unlock').status, 'retained');
  const removals = transport.calls.filter(
    (call) => call[0] === 'writeSsh' && /(?:^|\s)(?:rm|rmdir) /u.test(String(call[1])),
  );
  assert.deepEqual(removals, []);
  const entries = auditEntriesOf(input.auditOut);
  assert.ok(entries.some((entry) => entry.stage === 'unlock' && entry.status === 'retained'));
  assert.ok(entries.every((entry) => entry.stage !== 'unlock' || entry.status !== 'done'));
});

test('the channel precondition refuses an empty channel by its own reason before any remote write', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const result = await runCommit(commitInput(transport, { ...paths, channel: '' }));
  assert.equal(result.outcome, 'fail');
  assert.equal(result.reason, 'the channel is empty, so it cannot be interpolated into a remote path');
  assert.deepEqual(transport.calls, []);
});

test('a staging entry that is not a regular file is refused', async () => {
  const paths = writeArtifacts();
  const stagingListing = `d ${PORTABLE_PACKAGE_NAME} ${PACKAGE_BYTES.length}\nf ${PORTABLE_FILE_MANIFEST_NAME} ${FILE_MANIFEST_BYTES.length}\n`;
  const transport = happyTransport(paths, { stagingListing });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.match(result.reason, /is not a regular file/u);
  const remoteVerify = auditEntriesOf(input.auditOut).find((entry) => entry.stage === 'remote-verify');
  assert.equal(remoteVerify.status, 'fail');
  assert.match(remoteVerify.detail, /is not a regular file/u);
  assert.equal(remoteVerify.remote.entries[0].type, 'd');
  assert.equal(remoteVerify.remote.digests, null);
});

test('a staging listing that failed is reported as an empty directory rather than parsed', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { listingStatus: 1 });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.equal(result.reason, 'the staging directory is not the exact final file set: the staging directory is empty');
});

test('a presence probe that failed is not read as a present directory', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { directoryProbeStatus: 1 });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.equal(result.lockState, 'not-acquired');
  assert.equal(result.stages.find((entry) => entry.stage === 'remote-verify').status, 'fail');
  assert.equal(result.stages.find((entry) => entry.stage === 'lock').status, 'pending');
});

test('a digest read that failed stops the run instead of throwing out of the commit', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { digestStatus: 1 });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.equal(
    result.reason,
    'the staging directory is not the exact final file set: the remote digests could not be read',
  );
});

test('a remote manifest whose digest could not be read is logged as absent rather than as a blank', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { baselineDigestAbsent: true });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.stages.find((entry) => entry.stage === 'cas').status, 'incident');
  const cas = auditEntriesOf(input.auditOut).find((entry) => entry.stage === 'cas');
  assert.equal(cas.previousManifestSha256, 'absent');
  assert.equal(cas.observedManifestSha256, BASELINE_SHA);
});

test('a device probe that failed stops the commit even when it printed matching numbers', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { deviceProbeStatus: 1 });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.match(result.reason, /file system/u);
  assert.equal(result.lockState, 'released');
  assert.equal(result.stages.find((entry) => entry.stage === 'commit-version').status, 'fail');
});

test('a public manifest response without body bytes is an incident rather than a crash', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { manifestBodyMissing: true });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.match(result.reason, /public manifest could not be read/u);
  const publicVerify = auditEntriesOf(input.auditOut).find((entry) => entry.stage === 'public-verify');
  assert.equal(publicVerify.manifestSha256, manifestShaOf(paths));
});

test('the audit log carries the operator, the run time and the local digests and sizes', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assert.equal(result.outcome, 'done', result.reason);
  const entries = auditEntriesOf(input.auditOut);
  for (const entry of entries) {
    assert.equal(entry.operator, 'ops', entry.stage);
    assert.equal(entry.at, '2026-09-22T00:00:00.000Z', entry.stage);
  }
  const preVerify = entries.find((entry) => entry.stage === 'pre-verify');
  assert.deepEqual(preVerify.local, {
    packageSha256: PACKAGE_SHA256,
    packageSize: PACKAGE_BYTES.length,
    fileManifestSha256: FILE_MANIFEST_SHA256,
    fileManifestSize: FILE_MANIFEST_BYTES.length,
    manifestSha256: manifestShaOf(paths),
    manifestSize: readFileSync(paths.manifestPath).length,
  });
});

test('the audit log carries the entries and digests the staging directory reported', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assert.equal(result.outcome, 'done', result.reason);
  const remoteVerify = auditEntriesOf(input.auditOut).find((entry) => entry.stage === 'remote-verify');
  assert.equal(remoteVerify.status, 'done');
  assert.equal(remoteVerify.remote.present, true);
  assert.equal(remoteVerify.remote.empty, false);
  assert.deepEqual(remoteVerify.remote.entries, [
    { type: 'f', name: PORTABLE_PACKAGE_NAME, size: PACKAGE_BYTES.length },
    { type: 'f', name: PORTABLE_FILE_MANIFEST_NAME, size: FILE_MANIFEST_BYTES.length },
  ]);
  assert.deepEqual(remoteVerify.remote.digests, {
    [PORTABLE_PACKAGE_NAME]: PACKAGE_SHA256,
    [PORTABLE_FILE_MANIFEST_NAME]: FILE_MANIFEST_SHA256,
  });
});

test('the audit log carries the previous manifest digest and the backup path', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assert.equal(result.outcome, 'done', result.reason);
  const entries = auditEntriesOf(input.auditOut);
  const backup = entries.find((entry) => entry.stage === 'backup-manifest');
  assert.equal(backup.previousManifestSha256, BASELINE_SHA);
  assert.equal(backup.backupPath, `${STATE_ROOT}/backup/internal-manifest.json-pre-1.2.3`);
  const cas = entries.find((entry) => entry.stage === 'cas');
  assert.equal(cas.previousManifestSha256, BASELINE_SHA);
  assert.equal(cas.observedManifestSha256, BASELINE_SHA);
});

test('the audit log carries the new manifest digest at the temp manifest, the flip and the outcome', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assert.equal(result.outcome, 'done', result.reason);
  const manifestSha = manifestShaOf(paths);
  const entries = auditEntriesOf(input.auditOut);
  const tempManifest = entries.find((entry) => entry.stage === 'temp-manifest');
  assert.equal(tempManifest.manifestSha256, manifestSha);
  assert.equal(tempManifest.remoteTempSha256, manifestSha);
  assert.equal(entries.find((entry) => entry.stage === 'flip').manifestSha256, manifestSha);
  assert.equal(entries.find((entry) => entry.stage === 'done').manifestSha256, manifestSha);
});

test('the audit log carries the public digests and sizes the verification compared', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assert.equal(result.outcome, 'done', result.reason);
  const publicVerify = auditEntriesOf(input.auditOut).find((entry) => entry.stage === 'public-verify');
  assert.deepEqual(publicVerify.public, {
    ok: true,
    manifestSha256: manifestShaOf(paths),
    packageSha256: PACKAGE_SHA256,
    packageSize: PACKAGE_BYTES.length,
    fileManifestSha256: FILE_MANIFEST_SHA256,
    fileManifestSize: FILE_MANIFEST_BYTES.length,
  });
});

test('the audit log takes each entry time from the injected clock rather than the run start', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const ticks = ['2026-09-22T00:00:01.000Z', '2026-09-22T00:00:02.000Z', '2026-09-22T00:00:03.000Z'];
  let taken = 0;
  const input = commitInput(transport, { ...paths, now: () => ticks[Math.min(taken++, ticks.length - 1)] });
  const result = await runCommit(input);
  assert.equal(result.outcome, 'done', result.reason);
  const entries = auditEntriesOf(input.auditOut);
  assert.equal(entries[0].at, ticks[0]);
  assert.equal(entries[1].at, ticks[1]);
  assert.equal(entries[2].at, ticks[2]);
  assert.equal(entries.at(-1).at, ticks[2]);
});

test('the audit log keeps the operator and the time as null instead of dropping them', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const input = commitInput(transport, { ...paths, operator: undefined, startedAt: undefined });
  await assert.rejects(runCommit(input), /operator/u);
  const entries = auditEntriesOf(input.auditOut);
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.equal(entry.operator, null, entry.stage);
    assert.equal(entry.at, null, entry.stage);
  }
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
  if (isInsideRepository(target, repositoryRoot)) {
    throw new FeedPublishError('the audit log must live outside the repository');
  }
  return resolve(target);
}

function assertSafeVersion(version) {
  if (typeof version !== 'string' || version.length === 0) {
    throw new FeedPublishError('the version is empty, so it cannot be interpolated into a remote path');
  }
  if (!SEMVER_PATTERN.test(version)) {
    throw new FeedPublishError(
      `the version ${version} is not a strict semantic version, so it is not safe to interpolate into a remote path`,
    );
  }
}

const RUNID_PATTERN = /^[A-Za-z0-9._-]+$/u;

function assertSafeRunid(runid) {
  if (typeof runid !== 'string' || runid.length === 0) {
    throw new FeedPublishError('the run id is empty, so it cannot be interpolated into a remote path');
  }
  if (!RUNID_PATTERN.test(runid)) {
    throw new FeedPublishError(
      `the run id ${runid} carries a character outside the shell inert alphabet, so it is not safe to interpolate into a remote path`,
    );
  }
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
  if (!exists) return { present: false, empty: false, problems: [], entries: [], digests: null };
  const entries = await readRemoteDirectory(input, directory);
  if (entries.length === 0) return { present: true, empty: true, problems: [], entries: [], digests: null };
  const problems = compareDirectoryEntries(entries, expectedEntries);
  let digests = null;
  if (problems.length === 0) {
    digests = await readRemoteHashes(
      input,
      directory,
      expectedEntries.map((item) => item.name),
    );
    problems.push(...compareDirectoryHashes(digests, expectedEntries));
  }
  return {
    present: true,
    empty: false,
    problems,
    entries,
    digests: digests === null ? null : Object.fromEntries(digests),
  };
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
  const publicPackageSha256 = createHash('sha256').update(packageBytes).digest('hex');
  if (publicPackageSha256 !== input.expectedPackageSha256) {
    return { ok: false, reason: 'the public package integrity check failed' };
  }
  if (packageBytes.length !== input.expectedPackageSize) {
    return { ok: false, reason: 'the public package size does not match' };
  }

  const fileManifestResponse = await input.transport.fetchPublic(`${base}/${PORTABLE_FILE_MANIFEST_NAME}`);
  if (fileManifestResponse.status !== 200) return { ok: false, reason: 'the public file manifest is not reachable' };
  const fileManifestBytes = Buffer.from(fileManifestResponse.bodyBytes);
  const publicFileManifestSha256 = createHash('sha256').update(fileManifestBytes).digest('hex');
  if (publicFileManifestSha256 !== input.expectedFileManifestSha256) {
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

  return {
    ok: true,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    packageSha256: publicPackageSha256,
    packageSize: packageBytes.length,
    fileManifestSha256: publicFileManifestSha256,
    fileManifestSize: fileManifestBytes.length,
  };
}

export async function runCommit(input) {
  const stages = PUBLISH_STAGES.map((stage) => ({ stage, status: 'pending' }));
  const runid = input.runid;
  let acquisitionConfirmed = false;
  let acquiredLockState = null;
  let planHash = 'uncomputed';
  let owner = null;

  const atValue = () => (input.now === undefined ? input.startedAt : input.now()) ?? null;
  const baseOf = () => ({ runid, operator: input.operator ?? null, at: atValue() });

  const audit = (stage, status, detail, evidence) => {
    stages.find((entry) => entry.stage === stage).status = status;
    appendAuditStage({
      auditOut: input.auditOut,
      repositoryRoot: input.repositoryRoot,
      entry: { stage, status, ...baseOf(), ...(detail === undefined ? {} : { detail }), ...(evidence ?? {}) },
    });
  };

  const finish = (outcome, reason, lockState) => ({ outcome, reason, lockState, stages, runid, planHash });

  const recordOutcome = (outcome, reason, evidence) => {
    appendAuditStage({
      auditOut: input.auditOut,
      repositoryRoot: input.repositoryRoot,
      entry: { stage: outcome, reason, ...baseOf(), planHash, ...(evidence ?? {}) },
    });
  };

  const retainAndFinish = (outcome, reason) => {
    const disposition = resolveLockDisposition({ acquisitionConfirmed, owner, runid, planHash, safeToExit: false });
    const lockState = owner === null && acquiredLockState !== null ? acquiredLockState : disposition.state;
    stages.find((entry) => entry.stage === 'unlock').status = 'retained';
    recordOutcome(outcome, reason);
    appendAuditStage({
      auditOut: input.auditOut,
      repositoryRoot: input.repositoryRoot,
      entry: { stage: 'lock-retained', status: 'retained', ...baseOf(), reason: disposition.reason },
    });
    return finish(outcome, reason, lockState);
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
      entry: { stage: 'unlock', status: unlockStatus, ...baseOf(), reason: disposition.reason },
    });
    return finish(outcome, reason, disposition.state);
  };

  try {
    appendAuditStage({
      auditOut: input.auditOut,
      repositoryRoot: input.repositoryRoot,
      entry: { stage: 'open', ...baseOf() },
    });
  } catch (error) {
    return finish('fail', error.message, 'not-acquired');
  }

  let local;
  try {
    assertSafeChannel(input.channel);
    assertSafeVersion(input.version);
    assertSafeRunid(runid);
    local = await verifyLocalArtifacts({
      packagePath: input.packagePath,
      fileManifestPath: input.fileManifestPath,
      manifestPath: input.manifestPath,
      expectedChannel: input.channel,
      expectedVersion: input.version,
      publicKeyBase64: input.publicKeyBase64,
      verifySignature: input.verifySignature,
    });
    planHash = planHashOf({
      channel: input.channel,
      version: input.version,
      packageSha256: local.packageSha256,
      fileManifestSha256: local.fileManifestSha256,
      manifestSha256: local.manifestSha256,
    });
  } catch (error) {
    audit('pre-verify', 'fail', error.message);
    recordOutcome('fail', error.message);
    return finish('fail', error.message, 'not-acquired');
  }
  const localEvidence = {
    local: {
      packageSha256: local.packageSha256,
      packageSize: local.packageSize,
      fileManifestSha256: local.fileManifestSha256,
      fileManifestSize: local.fileManifestSize,
      manifestSha256: local.manifestSha256,
      manifestSize: local.manifestBytes.length,
    },
  };
  audit('pre-verify', 'done', undefined, localEvidence);

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
    recordOutcome('fail', 'the staging directory could not be created');
    return finish('fail', 'the staging directory could not be created', 'not-acquired');
  }

  for (const item of [
    { localPath: input.packagePath, remotePath: `${stagingRoot}/${PORTABLE_PACKAGE_NAME}.part-${runid}` },
    { localPath: input.fileManifestPath, remotePath: `${stagingRoot}/${PORTABLE_FILE_MANIFEST_NAME}.part-${runid}` },
  ]) {
    const uploaded = await input.transport.write.sftpUpload({ ...item, resume: true });
    if (uploaded.status !== 0) {
      audit('stage', 'fail', uploaded.stderr ?? 'upload failed');
      recordOutcome('fail', 'the staging upload failed');
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
    recordOutcome('fail', 'the staging directory could not be finalised');
    return finish('fail', 'the staging directory could not be finalised', 'not-acquired');
  }
  audit('stage', 'done');

  const staging = await inspectRemoteDirectory(input, stagingRoot, expectedEntries);
  const stagingEvidence = { remote: staging };
  if (!staging.present || staging.empty || staging.problems.length > 0) {
    const detail = staging.empty ? 'the staging directory is empty' : staging.problems.join('; ');
    const reason = `the staging directory is not the exact final file set: ${detail}`;
    audit('remote-verify', 'fail', detail, stagingEvidence);
    recordOutcome('fail', reason);
    return finish('fail', reason, 'not-acquired');
  }
  audit('remote-verify', 'done', undefined, stagingEvidence);

  const lock = await acquireChannelLock({
    channel: input.channel,
    transport: input.transport,
    owner: { runid, operator: input.operator, startedAt: input.startedAt, planHash, machine: input.machine },
    host: input.host,
    knownHostsPath: input.knownHostsPath,
  });
  if (lock.acquired !== true) {
    const blocked = lock.state === 'not-acquired';
    const outcome = blocked ? 'blocked' : 'incident';
    audit('lock', outcome, lock.reason);
    recordOutcome(outcome, lock.reason);
    return finish(outcome, lock.reason, lock.state);
  }
  acquisitionConfirmed = true;
  acquiredLockState = lock.state;
  owner = lock.owner;
  if (lock.incident === true) {
    audit('lock', 'incident', lock.reason);
    return retainAndFinish('incident', lock.reason);
  }
  audit('lock', 'done');

  const reReadOwner = await readOwnerRecord(input);
  if (reReadOwner !== null && (reReadOwner.runid !== runid || reReadOwner.planHash !== planHash)) {
    owner = reReadOwner;
    audit('re-verify', 'incident', 'the lock owner changed while this run was taking it');
    return retainAndFinish('incident', 'the lock owner changed while this run was taking it');
  }
  owner = reReadOwner ?? owner;
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

  const backupPath = `${STATE_ROOT}/backup/${input.channel}-manifest.json-pre-${input.version}`;
  const backup = await input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: [
      `mkdir -p ${STATE_ROOT}/backup`,
      `cp ${UPDATE_ROOT}/${input.channel}/${PORTABLE_MANIFEST_NAME} ${backupPath} 2>/dev/null || true`,
    ].join(' && '),
  });
  if (backup.status !== 0) {
    return retainAndFinish('incident', 'the previous manifest could not be backed up');
  }
  audit('backup-manifest', 'done', undefined, { previousManifestSha256: baselineSha, backupPath });

  const casSha = await readRemoteFileSha(input, `${UPDATE_ROOT}/${input.channel}/${PORTABLE_MANIFEST_NAME}`);
  const casEvidence = { previousManifestSha256: baselineSha, observedManifestSha256: casSha };
  if (casSha !== baselineSha) {
    audit('cas', 'incident', undefined, casEvidence);
    return retainAndFinish(
      'incident',
      'the manifest changed after the lock was taken, which means a bypass; nothing is flipped, rolled back or deleted',
    );
  }
  audit('cas', 'done', undefined, casEvidence);

  const manifestEvidence = { manifestSha256: local.manifestSha256 };
  const tempManifestPath = `${UPDATE_ROOT}/${input.channel}/${PORTABLE_MANIFEST_NAME}.${runid}.tmp`;
  const manifestUploaded = await input.transport.write.sftpUpload({
    localPath: input.manifestPath,
    remotePath: tempManifestPath,
    resume: false,
  });
  if (manifestUploaded.status !== 0) {
    audit('temp-manifest', 'incident', 'the manifest upload failed', manifestEvidence);
    return retainAndFinish('incident', 'the manifest could not be uploaded, so the outcome is uncertain');
  }
  const remoteTempSha = await readRemoteFileSha(input, tempManifestPath);
  const tempManifestEvidence = { manifestSha256: local.manifestSha256, remoteTempSha256: remoteTempSha };
  if (remoteTempSha !== local.manifestSha256) {
    audit(
      'temp-manifest',
      'incident',
      'the uploaded manifest digest does not match the local manifest',
      tempManifestEvidence,
    );
    return retainAndFinish('incident', 'the uploaded manifest does not match the local manifest');
  }
  audit('temp-manifest', 'done', undefined, tempManifestEvidence);

  const flipped = await input.transport.write.sshRun({
    host: input.host,
    knownHostsPath: input.knownHostsPath,
    script: `mv -f ${tempManifestPath} ${UPDATE_ROOT}/${input.channel}/${PORTABLE_MANIFEST_NAME}`,
  });
  if (flipped.status !== 0) {
    audit('flip', 'incident', 'the atomic flip failed', manifestEvidence);
    return retainAndFinish('incident', 'the atomic flip failed, so the outcome is uncertain');
  }
  audit('flip', 'done', undefined, manifestEvidence);

  const observed = await input.transport.fetchPublic(`${PUBLIC_BASE_URL}/${input.channel}/${PORTABLE_MANIFEST_NAME}`);
  if (observed.status !== 200 || observed.bodyBytes === undefined) {
    audit('public-verify', 'incident', 'the public manifest could not be read', manifestEvidence);
    return retainAndFinish('incident', 'the public manifest could not be read, so the outcome is uncertain');
  }
  const observedSha = createHash('sha256').update(Buffer.from(observed.bodyBytes)).digest('hex');
  const observedEvidence = {
    manifestSha256: local.manifestSha256,
    observedManifestSha256: observedSha,
    previousManifestSha256: baselineSha,
  };
  if (observedSha === local.manifestSha256) {
    let publicCheck;
    try {
      publicCheck = await verifyPublicArtifacts({
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
    } catch (error) {
      audit('public-verify', 'incident', error.message, observedEvidence);
      return retainAndFinish('incident', `the public verification could not be completed: ${error.message}`);
    }
    if (publicCheck.ok !== true) {
      audit('public-verify', 'incident', publicCheck.reason, observedEvidence);
      return retainAndFinish('incident', `the public verification failed: ${publicCheck.reason}`);
    }
    audit('public-verify', 'done', undefined, { public: publicCheck });
    audit('reveal', 'done');
  } else if (observedSha === baselineSha) {
    audit('public-verify', 'retry', undefined, observedEvidence);
    return retainAndFinish('retry', 'the flip did not take effect');
  } else {
    audit('public-verify', 'incident', 'a third manifest digest appeared', observedEvidence);
    return retainAndFinish('incident', 'a third manifest digest appeared while flipping');
  }

  recordOutcome('done', 'published', manifestEvidence);
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
    entry: { stage: 'unlock', status: unlockStatus, ...baseOf(), reason: disposition.reason },
  });
  if (disposition.release !== true) return finish('incident', disposition.reason, disposition.state);
  return finish('done', 'published', disposition.state);
}
```

**硬规则（原先以四条 `//` 中文注释写在上面那个代码块里，已从代码块里删除）：** 每一次 `return finish(...)` 之前**都必须先** `recordOutcome(outcome, reason)` —— `retainAndFinish` 与 `releaseAndFinish` 已经在内部调用它，四条提前失败路径（`pre-verify` / `stage` / `remote-verify` / `lock`）必须各自显式调用一次，否则审计日志会缺掉"这次运行到底以什么结果收场"这一行。⚠️ **为什么把它从代码块搬到计划正文**：`eslint.config.mjs` 的 `ignores` 含 `scripts/**`，所以"代码里不写注释"与"代码里不出现 CJK"这两条（`docs/agent-rules/frontend.md`）在本模块上**不被门禁覆盖、只能人工扫**，而这段注释**正好同时违反两条**。Task 4 写 `scripts/lib/feed-publish.mjs` 时**不得**把这四条注释搬回去 —— 规则留在**计划**里，不留在线代码里。**Task 4–7 区域的全部 `js` 围栏已按这两条扫过**，读数 **`TOTAL_CJK_COMMENT_LINES 0`**（扫描口径：逐行跟踪 ```围栏状态，只看`js` 围栏内、`//` 之后出现 CJK 的行；修复前同一扫描读到**这一处 4 行**）。两个代码文件同一口径的读数：`scripts/lib/feed-publish.mjs`CJK 0 行 /`//` 注释 0 行，`scripts/lib/feed-publish.test.mjs`CJK 0 行 /`//` 注释 0 行。

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

1. **解锁时锁已被别人换掉 ⇒ 拒绝并记 `incident`（§6.6 前提 2 的端到端钉子）。** 这条必须在**接线层**做，不能只调 `releaseChannelLock`：用 `commitTransport` 让**解锁那一刻**读到的 `owner.json` 的 `runid` 与本次运行不同（例如在 `mv -f` 之后把 `ownerJson` 换成一个 `runid: 'other'` 的记录），断言 `runCommit` 以 `incident` 收口、`lockState === 'ownership-unknown'`、**并且一次 `rm`/`rmdir` 都没发**。⚠️ **本项原先写着"这条同时证明两个解锁点确实没有传 `owner`"—— 那是错的（复核刀更正）：本刀那个夹具（`foreignOwnerAfterFlip`）只在翻转之后换记录，因此只走到**成功路径**那个解锁点；`releaseAndFinish` 那个调用点**一次都没被覆盖**（复核刀实测：只在 `releaseAndFinish` 处加 `owner,` ⇒ 117/0 全绿）。**两个解锁点各自由一条用例钉住**：① 成功路径 = `an owner record replaced before the unlock stops the run and deletes nothing`；② 失败路径 = `an owner record replaced before the unlock on the failure path stops the run and deletes nothing`（复核刀补，夹具 = `commitStatus: 1` + `foreignOwnerAfterCommit: true`）。**两条都断言"一次 `rm`/`rmdir` 都没发"\*\*，任一把步骤 5 的旧快照传进去 ⇒ 对应的那条变红。
2. **锁步骤上的确定性配置失败记 `incident`，不是 `blocked`。** Task 3 收窄 `isFileExistsFailure` 之后，**任何非 "File exists" 的非零 `mkdir`**（ENOENT、权限不足、只读文件系统）都会走 `ownership-unknown` ⇒ `incident`。这是**刻意的、安全的方向**：宁可记事故交人工核查，也不要用一句关于远端状态的假话把操作员推向 `--break-lock`。**Task 4 必须有一条用例把这条路径钉住**：夹具让 `mkdir` 返回 `{ status: 1, stderr: 'mkdir: cannot create directory ...: Permission denied' }`，断言 `outcome === 'incident'`、`lockState === 'ownership-unknown'`、`stages` 里 `lock` 是 `incident`，且**后续任何阶段都没跑**（`commit-version` 仍是 `pending`）。
3. ⚠️ **Task 6 必须抓一条真机的 coreutils 权限失败原文。** 上面这条用例（以及 Task 3 的 `a lock mkdir that fails without an existing entry signal is ownership unknown`）现在断言的 `stderr` 是**手写的字符串**——我们**没有在目标主机上实测过** GNU coreutils 在 EPERM/EACCES 下到底打印什么。Task 6 接上真 transport 后，在目标主机上抓**一次**真实的 `mkdir` 权限失败（例如在一个只读目录里 `mkdir`），把原文写进**计划或断言**里（代码里不写注释），并确认收窄后的谓词不会把它误判成 `not-acquired`。在抓到之前，"权限失败 ⇒ `incident`"这条只是**推断**，不是实测。
4. **Task 4 的 `commitTransport` 必须与 Task 3 同规格**：`readOnly.sshRun` / `write.sshRun` 记下**整个 request**，并新增一个 Task-4 形状的助手（`fetchPublic` 记的是 URL 不是 request，Task 3 的 `assertEveryCallCarriesTheTrustAnchor` 直接搬过来会在 `call[2]` 上失败）——在每条走 `commitTransport` 的用例末断言 `host` 与 `knownHostsPath` 恰好等于注入值，**零调用不算通过**。

5. **"锁在、但 owner 记录读不出来"这条状态必须收成 `incident`，而且审计里绝不能看起来像正常收尾（第二修复刀第三处，计划决定）。** 两个位置会造出这个状态：`acquireChannelLock` 的 owner 写入失败（`state: 'retained-by-this-run'` + `incident: true`）与 `releaseChannelLock` 的"删了 owner、`rmdir` 失败"。此时 `breakChannelLock` 只能抛 `… must be inspected by hand`，而 `readOwnerRecord` 对**三种不同成因**（transport 失败 / 文件不存在 / 内容不是 JSON）一律返回裸 `null`，CLI 说不出是哪种。**Task 4 要钉两条**：① `retainAndFinish` 走到它时 `outcome === 'incident'` 且 `lockState` 是**正确的那一个**（`retained-by-this-run`，不是 `released`、也不是拿 `ownership-unknown` 兜底顶替）；② 审计里**不得**出现一条把 `unlock` 写成 `done` 的条目 —— §6.11 说"最后一条是 `unlock`"才代表正常收尾，这个状态恰恰不能看起来像正常收尾。夹具做法：让 owner 写入返回非零（锁步骤）或让 `rmdir` 返回非零（解锁步骤），然后断言审计行序列。**出口本身（CLI 形状 + 手册里的具体命令）由 Task 7 落，见 Task 7 的验收项**；本刀只把形状写进计划，**不动 `readOwnerRecord` 的契约**（它的消费者是 Task 4 与 Task 7）。
6. **`unlock` 审计行只能在两次远端删除都成功之后生成（第二修复刀"记录不改"第一处）。** `resolveLockDisposition` 在**任何东西被释放之前**就已经把 `state: 'released'` 铸好了；今天这条不可达（计划的接线只用 `safeToExit: false` 调它），但 §6.11 让审计里的 `unlock` 行成为**承重**结构 —— 一旦 Task 4 的某个调用点传了 `safeToExit: true`，而 `rm` / `rmdir` 之一失败，`releaseChannelLock` 会返回**另一个**对象（两个失败分支各自造了 `release: false` 的新对象），但 `resolveLockDisposition` 自己那份"已释放"的 verdict **仍然存在且可以被别处拿去用**。**Task 4 要有一条用例**：让 `rmdir` 在"本次持有锁且安全退出"的路径上失败，断言审计里那条 `unlock` **不是** `done`（是 `retained`）、且 `lockState` 不是 `released`。**为什么现在不改代码**：改 `resolveLockDisposition` 的返回形状会同时动到 Task 7 的 CLI 输出与 §6.11 的阶段表，属于 Task 4 的接线面；本刀只把它记成验收项，避免"顺手改"造成两处契约并存。
7. **Task 4 自己的远端命令与夹具要跟上第二修复刀的两条结论（计划决定，照录，别默默改）。** ① **locale：本刀逐个量过 Task 4 会解析输出的其余远程命令** —— `stat -c '%d'`（Task 2 的 preflight）、`sha256sum`、`find -printf '%y %f %s\n'`、`printf 'present\n'`、`cat owner.json` —— 在 `LC_ALL=C` 与 `LC_ALL=fr_FR.UTF-8` 下输出**逐字节相同**（实测），因为它们解析的是**结构化内容**（十进制数、十六进制、`%y` 类型字符、字面量字符串），不是**报错文本**；只有 `mkdir` 那一条是被**按英文报错文本子串匹配**的，所以只有它需要 `LC_ALL=C`。`sort` 的**排序规则**确实随 `LC_COLLATE` 变，但消费者 `compareDirectoryEntries` 用的是集合成员判断（`.some((item) => item.name === entry.name)`），**不消费顺序** ⇒ 也不需要。**结论：Task 4 规定的远程命令一律不加 `LC_ALL=C`**（这是决定，不是遗漏）。② **夹具按命令形状判断**：`commitTransport` 里 `request.script.startsWith('mkdir ') && request.script.includes('/lock/')` 已同步改成 `isLockDirectoryCommand` 同款谓词；从脚本还原 owner 记录那处已同步改 base64 解码。③ **Task 4 自己的路径拼接不在第六处的保护范围内 —— `channel` 与 `version` 这两个值都要管（第三修复刀把 `version` 加进来）**：`versionRootOf` / `stagingRootOf` / `${UPDATE_ROOT}/${input.channel}/…` / `${STATE_ROOT}/backup/${input.channel}-…` 都在**锁步骤之前**（stage 是第 2 步、lock 是第 4 步）就拿到 `channel`，而 `assertSafeChannel` 只挂在 `lockPath` 上；**`version` 同样被拼进远端路径**（`versionRootOf` 的 `${UPDATE_ROOT}/${channel}/${version}`、`stagingRootOf` 的 `${STATE_ROOT}/staging/${channel}/${version}/${planHash}`、备份名的 `-manifest.json-pre-${version}`），而 Task 3 这一侧**没有任何本地前置条件在管它** —— 它只被 Task 1 的 `SEMVER_PATTERN` 挡在 `parsePublishInput` 那道门后面，**与本模块隔着两个文件**。**接线路径上撞不到**（Task 7 的 CLI 先过 `parsePublishInput` 的 `CHANNELS.includes` 白名单与严格 SemVer 正则），所以这不是活缺陷；但**直接调 `runCommit` 的路径**会先按恶意 `channel` 或任意 `version` 建 staging 目录：`channel` 到锁这一步才被拦，**`version` 连锁这一步都不会被拦**（锁路径里没有 `version`）。**Task 4 必须把两个值的路径安全前置条件都挪到 `pre-verify` 之后、任何远端写之前**（`channel` 复用本刀第八处的非空检查 + 第六处的字符集判据，`version` 复用 Task 1 的 `SEMVER_PATTERN`），并补一条用例：**非白名单 `channel` 或非 SemVer `version`** 时 `stage` 阶段**不发任何写调用**（两半各断言一次，别只喂 `channel`）。
8. ⚠️ **Task 6 还必须抓一条真机的 locale 读数（本刀新增，因为本机那半个读数不成立）。** 第 7 处偏离记了一个**没能在本机复现**的推断：`isFileExistsFailure` 匹配英文 `File exists`，而 GNU coreutils 的报错按 `LC_MESSAGES` 翻译 ⇒ 若目标主机装了消息目录且会话 locale 不是 `C`，这条匹配会失效、把"别人正持锁"这条常规争用报成 `incident`。本机 `locale -a` 有 zh_CN / zh_CN.utf8 / fr_FR / de_DE / ja_JP 等（这四个地区共 14 个变体，实测），但 `/usr/share/locale` **根本不存在**（`/usr/share/locale/*/LC_MESSAGES/coreutils.mo` 计数为 0），所以换 locale **只改引号样式**（`'` → `‘’`）、被匹配的 `File exists` 仍在 ⇒ **推断未被证实**。Task 6 接上真 transport 后**必须**在目标主机上抓两条读数：① `locale`（或 `printf '%s\n' "$LC_ALL" "$LANG"`）确认会话 locale 的实际值；② 在目标主机上对一个**已存在的目录**跑一次 `mkdir`，抄下**原始 stderr 全文**（照抄，不是转述），确认其中含 `File exists`、并与 `isFileExistsFailure` 的正则对得上。把原文写进计划或断言（代码里不写注释）。**收口口径**：抓到的原文**不含** `File exists` ⇒ `LC_ALL=C` 这条修复**必需**，本条由"推断"升级为"实测"；**含** ⇒ 记下"在目标主机的 locale（写明具体值）下该谓词成立"，**`LC_ALL=C` 照样保留**（它只紧不松，且挡住将来装语言包或换 locale）。

**待定的设计决定（在本刀内决定，不要留成第三份拷贝）**：本刀新增的 `assertOutsideRepository` 会是仓库里**第三**个"这个路径是否在仓库外"的判据，三份的语义各差一点：兄弟模块 `scripts/lib/portable-update-release.mjs` 的 `assertPathOutsideRepository` 要求相对关系是 `..` **加一个分隔符**（或正好是 `..`）才算仓库外；Task 1 的 `assertKnownHostsPath` 与本刀这一份则接受**任何以 `..` 开头**的相对关系。差别在 `..foo` 这种名字上：`<仓库根>/..foo` **其实在仓库内**，兄弟那份会拒、这两份会放行。**首选修法是统一到兄弟模块那种更严的形式**（顺带把 `..foo` 这个已知边界一起关掉），而不是新增第三份略有差异的拷贝 —— 修哪一份、还是抽成共享的一份，在**本刀**里定下来，别把三份语义不同的判据留给下一个人。

---

---

**Task 4 实施记录（本刀实测；套件 78 → 117；`feed-publish.mjs` 438 → 990 行、`feed-publish.test.mjs` 1319 → 2117 行，均为 `wc -l` 读数）**

**本刀的提交：** `e98c214c`（`feat(feed): run the thirteen publish stages over the injected transport`）。两份文件的 blob sha256 与下面全部变异运行的基线逐字节相同：`feed-publish.mjs` **`487cc87985c9ff9ae03da2dfd14258a7ab72e3eb07d63099500bfcdde286fb5f`**、`feed-publish.test.mjs` **`c9a296379f5899bdf67a46fd917087ca04fd5f68e7246bd8bfb24c9154c4df19`**（`sha256sum` 读数，提交前后各量一次）。

### 一、本刀在 Task 4 规定块上的偏离（12 处 + 复核刀追加 1 处，逐条给"为什么必须改" + 钉住它的测试名 + 变异读数）

1. **规定的测试块引用了 `writeArtifacts` 不返回的 `manifestBytes`（规定块之间自相矛盾）。** Task 4 的测试用 `paths.manifestBytes`（`manifestShaOf`、`happyTransport`、两条 `verifyPublicArtifacts` 用例），而 Task 1 规定的 `writeArtifacts` 只返回三个路径 —— 规定的套件**跑不起来**。**修法**：不扩宽 Task 1 的夹具（那会同时改掉 `test 1-374` 的边界），在 Task 4 自己的块里用 `readFileSync(paths.manifestPath)` 读盘上的字节 —— 那正是 `runCommit` 自己读到的那一份。
2. **`PORTABLE_PACKAGE_NAME` / `PORTABLE_FILE_MANIFEST_NAME` 没在测试块里导入。** 规定的 import 行少了夹具用到的两个常量 ⇒ 规定的块以 `ReferenceError` 失败。修法：加进同一条 import。
3. **`commitInput(transport, …)` 收了 `transport` 却从不放进返回的 input。** `input.transport` 全是 `undefined` ⇒ 30 条 `runCommit` 用例一起抛 `TypeError: Cannot read properties of undefined (reading 'write')`。修法：`transport` 放进 input。**变异 D9**（删掉那一行）⇒ **红 27 条**（`a clean publish walks every stage and releases its own lock` 领衔）。
4. **夹具的 `options.publicManifestBody ?? (…)` 对每个 URL 都生效。** `happyTransport` 一设它，`portable.zip` 与 `portable-files.json` 的取回也返回 manifest 字节 ⇒ 步骤 11 的包完整性必然失败 ⇒ **规定的 happy path 走不到 `done`**。修法：三个 URL 各取各的 body（新增 `publicPackageBody` / `publicFileManifestBody`）。**变异 D8**（退回 `??` 链）⇒ **红 7 条**。
5. **`open` 那条审计写入没有被保护（规定块缺一个 try/catch）。** 裸调的 `appendAuditStage` 写失败即抛 ⇒ `runCommit` **reject**，而规定的用例 `a failed audit write stops the run instead of publishing silently` 断言的是**返回** `{outcome:'fail', reason:/audit/}`。修法：只把 `open` 包进 try/catch，失败即 `return finish('fail', error.message, 'not-acquired')`（审计已经坏了，此时再写 `fail` 条目只会再抛一次）。**变异 P10**（catch 改成吞掉）⇒ **红 1 条**。
6. **四条提前失败路径必须各自写收口条目（计划正文明写的硬规则，规定块里没有）。** 正文要求"每一次 `return finish(...)` 之前都必须先 `recordOutcome(outcome, reason)`"，而规定的四条路径（`pre-verify` / `stage` / `remote-verify` / `lock`）只调了 `audit(...)` ⇒ §6.11"以 `done|fail|incident` 收口"在失败路径上落空。**为什么规定套件看不见**：四条路径的规定用例只断言 `outcome` / `lockState` / 阶段状态，**没有一条读审计尾部** ⇒ 规定清单再全绿也钉不住这条接线。补的用例 `every early failure records its outcome in the audit log before it returns`（四条路径各跑一次）。**变异 D2**（删掉 `pre-verify` 那一次）⇒ **红 1 条**（就是它）。
7. **锁步骤必须查"两条"退出码（追踪表第 4 行：检查退出码 是（两条都查））。** 规定代码只看 `lock.acquired`（= `mkdir` 的结果），**owner 写入失败被完全忽略**：此时 `acquireChannelLock` 返回 `{state:'retained-by-this-run', incident:true}`，规定代码会**继续发布**（`owner` 为 `null`，一路走到 flip），最后在解锁处以 `ownership-unknown` 收口 —— 正是验收项 5 明令禁止的形状。修法：`lock.incident === true` ⇒ `audit('lock','incident')` + `retainAndFinish('incident', lock.reason)`（`commit-version` 保持 `pending`）。**变异 D3**（删掉该分支）⇒ **红 1 条**：`an owner write that fails after the lock is an incident that keeps the lock`。
8. **保留路径要报"获取时确认过的那个状态"。** `resolveLockDisposition` 对读不出来的 owner 一律给 `ownership-unknown`（Task 3 的 `a lock owner that is missing or not a record is ownership unknown` 已钉住，本刀不动它），但 `mkdir` 成功已经证明"本次持有" ⇒ §6.6 的 `retained-by-this-run` 才是诚实描述（验收项 5① 也要求它）。修法：`retainAndFinish` 在 `owner === null && acquiredLockState !== null` 时用**获取步骤报的那个状态**（`acquiredLockState` 由 `acquireChannelLock` 的返回值赋值，不是本地新造）。**变异 D4**（退回 `disposition.state`）⇒ **红 1 条**（同一条，`lockState` 变成 `ownership-unknown`）。
9. **步骤 5 的 `owner.json` 重读必须比对（§6.6 推论 + 追踪表第 5 行的 `incident`）。** 规定代码 `owner = (await readOwnerRecord(input)) ?? owner;` 会把锁窗口里被换掉的记录**当自己的**。修法：重读到记录且 `runid` / `planHash` 任一不同 ⇒ `audit('re-verify','incident')` + `retainAndFinish('incident', …)`，并把 `owner` 换成那条外来记录（收口状态因此是 `ownership-unknown`，与追踪表"不匹配 ⇒ `ownership-unknown`，不触碰该锁"一致）。**变异 D10**（删掉比对）⇒ **红 1 条**：`an owner record replaced inside the lock window stops the run and touches nothing`。
10. **`verifyPublicArtifacts` 的拒绝必须收成 `incident`（§6.6"翻转之后失败 ⇒ 不确定 ⇒ 保留锁"）。** 规定的调用是裸 `await`：`input.verifier`（Task 7 会注入真 `verifyPortableRelease`）一抛就**整个 `runCommit` reject** —— 没有 `incident` 条目、没有"保留锁"的语义，只有一次未捕获异常。修法：包 try/catch ⇒ `audit('public-verify','incident', error.message)` + `retainAndFinish('incident', …)`。**变异 D7**（catch 改成 rethrow）⇒ **红 1 条**：`a public verifier that rejects after the flip is an incident that keeps the lock`。
11. **"是否在仓库外"的三份谓词收敛到最严的那一份（计划"待定的设计决定"，本刀拍板）。** 兄弟模块 `portable-update-release.mjs` 的 `assertPathOutsideRepository` 最严（`..` 必须是**整个路径段**）；Task 1 的 `assertKnownHostsPath` 与本刀的 `assertOutsideRepository` 用 `startsWith('..')` ⇒ 放行 `<仓库根>/..foo`（其实在仓库内）。修法：在 `feed-publish.mjs` 里抽出**一份** `isInsideRepository(target, repositoryRoot)`（判据与兄弟那份同义：`relation === '..' || relation.startsWith('..' + sep)`），两个断言各自只留自己的报错文案；**兄弟模块不动**（它本来就严）⇒ 三份语义一致。**顺带关掉了 `..foo` 这个已接受的角**。副作用：`node:path` 的 import 多了 `sep` ⇒ **Step 3 里那句"本刀不引入 `sep`"随之作废**（它描述的正是被换掉的那份松判据）。**变异 D5**（退回 `startsWith('..')`）⇒ **红 1 条**：`a sibling whose name begins with two dots is still inside the repository`（新用例，两个入口各断言一次）。
12. **`channel` / `version` / `runid` 的路径安全前置条件挪到任何远端写之前（验收项 7③ + 插值登记表）。** 三条都在 `pre-verify` 的 try 里、`verifyLocalArtifacts` **之前** ⇒ 不过就一个字节都不写。`assertSafeChannel` 复用第六处的判据，`assertSafeVersion` 复用 Task 1 的 `SEMVER_PATTERN`，`assertSafeRunid` 是**本刀自行加的**（计划只点名了 `channel` 与 `version`，但 `runid` 同样被拼进远端路径：`.part-<runid>` 与 `.<runid>.tmp`）。用例两半各断言一次（`a channel that could escape its remote path is refused before any remote write` / `a version that could escape its remote path is refused before any remote write`）。**为什么这两个夹具是有效钉子**：`channel: 'internal/x'` 与 `version: '1.2.3;id'` 都**能通过** `verifyLocalArtifacts`（把 manifest 的 `channel` / `version` / `packageUrl` 同步改成同值即可）⇒ 拦住它们的**只**能是路径安全前置条件；换成非白名单的 `internall` 就测不出东西（`verifyLocalArtifacts` 先拒）。**变异**：D6b（删 `assertSafeVersion`）⇒ **红 1 条**；D6c（删 `assertSafeRunid`）⇒ **红 1 条**；**D6a（删 `assertSafeChannel(input.channel)`）⇒ 本刀原记"117/117 全绿（存活）、不可单独钉住"，复核刀实测更正为"可钉、且已钉住"：删掉它 ⇒ 红 1 条**（`the channel precondition refuses an empty channel by its own reason before any remote write`）。**为什么原来那句是错的**：两层之间隔着 `verifyLocalArtifacts` —— `channel: ''` 在 `verifyLocalArtifacts` 里被 `expectedChannel` 的非空检查挡住、报 `an explicit expectedChannel is required`；**有守卫时**这一层先拒、报的是 `the channel is empty, so it cannot be interpolated into a remote path`。两层**文案不同** ⇒ 拿文案就能单独钉住这一层（`planHashOf` 那层只会对"非空但不在白名单里"的值现形，与本层不是同一个输入）。**冗余本身保留，理由不变**：前置条件不应依赖 `planHashOf` 的内部实现、也不应依赖这两条语句的先后（谁把 `planHashOf` 挪到后面，这一条就是唯一的守卫）。**账本里"不可单独钉住"这句话从本节撤掉，别再引用它**。
13. **（复核刀追加的偏离，原刀漏记）规定的 `the local pre-verification happens before any network write` 里那句 `assert.deepEqual(transport.calls, [])` 是一条未声明的加严。** 规定的形状只有 `assert.deepEqual(transport.calls.filter((call) => call[0] !== 'readSsh'), [])`（**放行只读调用**）；本刀在它下面又加了一句 `assert.deepEqual(transport.calls, [])`（**一条调用都不许有**），却**没有记进本清单**，于是"规定块 == 计划原文"这句话在这条用例上是假的（账本缺一项）。**这条加严是对的、保留**：`pre-verify` 在 `runCommit` 里跑在**任何** transport 调用之前，只读调用同样不该出现；弱判据会放过"预验证之前先做一次只读探测"。**它抓的是只读版本**：把 `open` 之后、本地预验证之前的调用改成 `readSsh` 的变异会被它抓住、而那半句规定判据会放行。⚠️ **复核刀没有单独重跑这条只读变异**（本刀的 P1 是把**写**调用插在那里、读数 112/5，两者不是同一条）⇒ 这条加严目前是**声明 + 论证**，不是一条实测读数，别把它写成"已用变异钉住"。

### 二、计划正文被本刀更正的三条（都是实测读数，不是判断）

1. **"`runCommit` 里的 `stages` 是同一表达式的第二份拷贝……两份一旦漂移，没有任何测试会红" —— 实测为假。** 两份拷贝**都被按名钉住**：**S1**（只改 `planCommit` 那份）⇒ **红 2 条**（`the dry run validates the triple and prints the plan without any transport`、`the dry run follows the channel and the version it was given instead of a default`）；**S2**（只改 `runCommit` 那份）⇒ **红 31 条**（首条 `the local pre-verification happens before any network write`）。因此本刀**按计划保留两份拷贝**（没有把计划数组传进 `runCommit`），这两次读数就是"它被钉住了"的证据。
2. **Step 5 第 2 条的"本刀无独立用例覆盖 ⇒ 记'未验证'"已不成立：本刀补了用例。** `a staging directory that cannot be created is a plain failure`（新增 `stagingCreateStatus` 夹具）断言 `outcome === 'fail'`、`lockState === 'not-acquired'`、`reason` 含 `staging directory could not be created`、`lock` 阶段仍 `pending`。**变异 P2**（删掉那三行退出码检查）⇒ **红 1 条**（就是它）。
3. **Step 5 第 11 条的预期红名不成立。** 原文预期"删掉 `verifyPublicArtifacts` 调用"会让 `the public verification fails when the served package differs` 变红 —— 但那条用例**直接调** `verifyPublicArtifacts`，与 `runCommit` 的调用点无关。**实测 P11**（把调用换成 `{ ok: true }`）⇒ **红 2 条**：`the public verification is actually run after the flip`（本刀补的接线钉子）与 `a public verifier that rejects after the flip is an incident that keeps the lock`；**预期的那条没红**。补的用例就是为了让"步骤 11 真的跑了"这件事有名字。

**`planCommit` 的契约（计划要求本刀显式定下来，本刀拍板）：选"在 `runCommit` 内部自己再调一次 `verifyLocalArtifacts`"这一臂**（计划给的两条路里的第一条）。**理由三条**：① 规定的 `runCommit` 代码本来就这么写（`local = await verifyLocalArtifacts({…})`，三个摘要取自 `local.*`）⇒ 不引入第三份契约；② 另一臂（扩宽 `planCommit` 的返回）会同时改掉 Task 2 已冻结的契约与它的三条规定用例（`the dry run validates the triple and prints the plan without any transport` 断言返回的就是计划数组）；③ dry-run 与 commit 本来就是两个进程时刻，各自读一次本地产物是正确语义，不是重复劳动。**没有把 `undefined` 传给 `planHashOf`**：三个摘要全部来自本刀自己那次调用；万一将来有人改成不调，`planHashOf` 的非空校验会当场拒（Task 3 的 `the plan hash refuses a field that is not a non empty string` 已钉住），不会静默算出一个假计划哈希。

### 三、变异清单（本刀最终读数，全部对着提交 `e98c214c` 的字节；每条都先断言锚点恰好匹配 1 次、确认磁盘字节真的变了，跑完**逐字节恢复**并与基线比 sha256）

⚠️ **本表是 Task 4 那一刀的记录（对着 `e98c214c` 的字节）。** 复核刀改了两份文件的字节、重跑了 **36 条**读数（含假存活探针与打印 hunk 的加严），**新的表在第九节**；本表里 **D6a 那一格已被推翻**（见该行与第一节第 12 条）。本表其余读数没有被复核刀重跑过 —— 引用时按"`e98c214c` 那一刀的读数"引用，别当成本文件当前字节的读数。

| #    | 变异                                                                                           | 读数（pass/fail）   | 变红的测试                                                                                                                                                                                                                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 对照 | 把 `retainAndFinish` 里那句 `'the uploaded manifest does not match the local manifest'` 改文案 | **117 / 0（全绿）** | —（证明装置不是"改什么都红"）                                                                                                                                                                                                                                                                                           |
| P1   | 在 `open` 之后、本地预验证之前插入一次远端 `mkdir`                                             | 112 / 5             | `the local pre-verification happens before any network write`、`every early failure records its outcome…`、`a channel that could escape…`、`a version that could escape…`、`a run id that could escape…`（**不是"只红一条"**）                                                                                          |
| P2   | 删掉 staging `mkdir -p` 的退出码检查                                                           | 116 / 1             | `a staging directory that cannot be created is a plain failure`                                                                                                                                                                                                                                                         |
| P3   | 单次目录 `mv` ⇒ `mkdir -p` + 两次逐文件 `mv`                                                   | 115 / 2             | `the version directory is committed with a single directory rename`、`a failure after the lock but before the flip releases the lock this run owns`                                                                                                                                                                     |
| P4   | manifest 的 SFTP 上传 ⇒ `cp <本地路径>`                                                        | 115 / 2             | `the manifest is uploaded to the final directory and its remote digest is checked`、`a manifest upload failure is an incident that keeps the lock`                                                                                                                                                                      |
| P5   | 删掉远端临时 manifest 的 SHA 比对                                                              | 116 / 1             | `a mismatched remote manifest digest stops before the flip`                                                                                                                                                                                                                                                             |
| P6   | 删掉设备号比对                                                                                 | 116 / 1             | `a staging directory and a final directory on different file systems stops the commit`                                                                                                                                                                                                                                  |
| P7   | "存在但为空"当成不存在                                                                         | 116 / 1             | `an existing version directory that is empty is incomplete and refused`                                                                                                                                                                                                                                                 |
| P8   | 删掉目录摘要比对（`compareDirectoryHashes` 整段）                                              | 116 / 1             | `an existing version directory with a different digest is refused`                                                                                                                                                                                                                                                      |
| P9   | 删掉逐阶段审计追加（`audit` 里的 `appendAuditStage`）                                          | 116 / 1             | `every stage is appended to the audit log as it happens`                                                                                                                                                                                                                                                                |
| P10  | 把 `appendAuditStage` 的 catch 改成吞掉                                                        | 116 / 1             | `a failed audit write stops the run instead of publishing silently`                                                                                                                                                                                                                                                     |
| P11  | 步骤 11 的 `verifyPublicArtifacts` 调用 ⇒ `{ ok: true }`                                       | 115 / 2             | `the public verification is actually run after the flip`、`a public verifier that rejects after the flip is an incident that keeps the lock`（**计划预期的红名没红**，见第二节第 3 条）                                                                                                                                 |
| P12a | 删 `verifyLocalArtifacts` 的 `await`                                                           | 90 / 27             | 首条 `a clean publish walks every stage and releases its own lock`（"漏 await"的正面检查；27 条一起红）                                                                                                                                                                                                                 |
| P12b | 删 staging `sftpUpload` 的 `await`                                                             | 92 / 25             | 同上族                                                                                                                                                                                                                                                                                                                  |
| P12c | 删 staging `mkdir -p` 的 `await`                                                               | 90 / 27             | 同上族                                                                                                                                                                                                                                                                                                                  |
| P12d | 删 `fetchPublic` 的 `await`                                                                    | 107 / 10            | `a clean publish…` 等 10 条                                                                                                                                                                                                                                                                                             |
| P12e | 删 `releaseChannelLock`（`releaseAndFinish` 那处）的 `await`                                   | 115 / 2             | `a failure after the lock but before the flip releases the lock this run owns`、`a staging directory and a final directory on different file systems stops the commit`                                                                                                                                                  |
| D2   | 删掉 `pre-verify` 路径的 `recordOutcome`                                                       | 116 / 1             | `every early failure records its outcome in the audit log before it returns`                                                                                                                                                                                                                                            |
| D3   | 删掉 `lock.incident === true` 分支                                                             | 116 / 1             | `an owner write that fails after the lock is an incident that keeps the lock`                                                                                                                                                                                                                                           |
| D4   | `retainAndFinish` 的状态退回 `disposition.state`                                               | 116 / 1             | 同一条（`lockState` ⇒ `ownership-unknown`）                                                                                                                                                                                                                                                                             |
| D5   | 包含谓词退回 `startsWith('..')`                                                                | 116 / 1             | `a sibling whose name begins with two dots is still inside the repository`                                                                                                                                                                                                                                              |
| D6a  | 删掉 `assertSafeChannel(input.channel)`                                                        | **117 / 0（存活）** | ⚠️ **这一格已被复核刀推翻**：删掉它 ⇒ **红 1 条**（`the channel precondition refuses an empty channel by its own reason before any remote write`，见第九节 M-f2）。当时记"存活"是因为读数只看了绿/红、没读被改动的 hunk 与**报错文案**（两层之间隔着 `verifyLocalArtifacts`，文案不同）⇒ 见第一节第 12 条已更正的说明。 |
| D6b  | 删掉 `assertSafeVersion(input.version)`                                                        | 116 / 1             | `a version that could escape its remote path is refused before any remote write`                                                                                                                                                                                                                                        |
| D6c  | 删掉 `assertSafeRunid(runid)`                                                                  | 116 / 1             | `a run id that could escape its remote path is refused before any remote write`                                                                                                                                                                                                                                         |
| D7   | 步骤 11 的 catch 改成 rethrow                                                                  | 116 / 1             | `a public verifier that rejects after the flip is an incident that keeps the lock`                                                                                                                                                                                                                                      |
| D8   | 夹具退回 `publicManifestBody ?? (…)` 单一 body                                                 | 110 / 7             | 见第一节第 4 条列出的七条                                                                                                                                                                                                                                                                                               |
| D9   | 夹具删掉 `transport,`                                                                          | 90 / 27             | `a clean publish…`（30 条 `runCommit` 用例一起红）                                                                                                                                                                                                                                                                      |
| D10  | 删掉步骤 5 的 owner 比对                                                                       | 116 / 1             | `an owner record replaced inside the lock window stops the run and touches nothing`                                                                                                                                                                                                                                     |
| D11  | 把一个调用点的 `host: input.host` 改成 `'wrong.invalid'`                                       | 90 / 27             | `a clean publish…`（锚点助手在每条 ssh 调用上抓到，**零调用不算通过**）                                                                                                                                                                                                                                                 |
| S1   | 只改 `planCommit` 的阶段推导（`slice(1)`）                                                     | 115 / 2             | `the dry run validates the triple…`、`the dry run follows the channel and the version…`                                                                                                                                                                                                                                 |
| S2   | 只改 `runCommit` 的阶段推导（`slice(1)`）                                                      | 86 / 31             | 首条 `the local pre-verification happens before any network write`                                                                                                                                                                                                                                                      |

**次数：31 次有效变异运行**（1 次对照必须留绿 + 30 次变异，其中 D6a 是存活读数）+ **7 次作废重跑**。**作废的 7 次与原因（那些读数已废弃，别引用）**：① 锚点不唯一或不存在（D8 第一版把 old/new 写反 ⇒ `ANCHOR_MATCHES 0 REFUSED`）；② 锚点生成器把整段开头吞掉 ⇒ 产物**语法错**（P3/P4/P11/P12e 的第一版：`node --test` 读成加载失败 `tests 1 pass 0 fail 1` —— **这个读数会被误当成"红"**，所以变异记录必须写清 pass/fail 而不是只看退出码）；③ **P1 第二版**：锚点以 `return finish(...)` 结尾、插入落在 `catch` 的 `return` **之后** ⇒ 变成**不可达代码**，读数 **117/117 全绿**（假"存活"）。**这条是装置自身会骗人的形状**：只看"绿/红"分不出"护栏删对了"与"变异没生效" ⇒ 变异装置此后固定做三件事：断言锚点恰好 1 次、`node --check` 变异产物、`diff` 复核插入点（本刀就是这么抓到 ③ 的）。⚠️ **复核刀把这条加严成通用纪律第 3 条**（打印 hunk、纯插入的可达性拒绝、红名单核对，见本计划"变异与镜像"一节）：本刀只在**作废重跑**里抓到 ③，**没把它变成装置的一条硬门**，所以同一个形状在复核刀上又出现过一次（插入落在 `return` 之后 ⇒ 133/0 全绿），这次由装置直接拒收。

### 四、镜像与规定块（本刀实测）

⚠️ **复核刀重测过本节的行号与条数**（两份文件都长了，规定块边界随之下移，见第九节）：**下面第一、二、四条里"本刀"的行号/条数是 Task 4 提交 `e98c214c` 时的读数**，供追溯用；**当前**的规定块边界与套件条数在第九节末尾给出（`test 1321–2395` / `mjs 444–1030`、**133 条**）。

- **八份镜像逐行相等且连续**（检查器同时要求"连续"，不是"每行都能在文件里找到"）：`test 1–374`、`mjs 1–148`、`test 376–561`、`mjs 150–202`、`test 563–868`、`mjs 204–442`、**`test 1321–2117`（Task 4 测试块）**、**`mjs 444–990`（Task 4 模块块）**。三对 `diff`（Task 4 测试块、Task 4 模块块、模块第一份）**全部 `DIFF_EMPTY`**。
- **边界变化**（因为第一处偏离落在模块第一份镜像**里面**：`assertKnownHostsPath` 9 行 ⇒ 14 行，外加 import 行内容变化）：`mjs 1–144 ⇒ 1–148`、`146–198 ⇒ 150–202`、`200–438 ⇒ 204–442`。`test` 的三份边界**不变**（本刀对测试的改动全部在 1319 行之后）。
- 规定块的现在内容 = 实际文件的那一段（Task 4 步骤 1 的围栏 ⇒ `test 1321–2117`，步骤 3 的围栏 ⇒ `mjs 444–990`）；**本节的偏离清单就是"规定块与计划原文的差异"的唯一账本**（⚠️ 复核刀改了两份文件的字节，因此**同时改了围栏里的规定块本体**以保持"块 = 文件那一段"，并在第九节追加了本刀的偏离项）。
- **两份文件的行数读数**：`feed-publish.mjs` 990、`feed-publish.test.mjs` 2117（`wc -l`）；套件 **117 条**（`node --test` 的 `ℹ tests 117` / `ℹ pass 117` / `ℹ fail 0`），比本刀前多 **39** 条。

### 五、远程脚本插值登记表（验收项 8：每个被拼进远端脚本的值一行）

| 值                                                                                                                | 出现在哪几条远端脚本                                                                                       | 类别                     | 依据的前置条件（本刀实测）                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channel`                                                                                                         | `lockPath` / `versionRootOf` / `stagingRootOf` / `cp` 备份名 / `mv -f` 翻转 / `sha256sum` 与 `find` 的目录 | **(a)** shell 惰性字母表 | `assertSafeChannel`（白名单 `CHANNELS` + 字符集），在 `runCommit` 的 `pre-verify` try 里、**任何远端调用之前**。另外 `planHashOf` 内部对同一值再调一次（见第一节第 12 条：**这一层可单独钉住、且已被钉住** —— 复核刀的 M-f2 删掉它 ⇒ 红 1 条；原先"不可单独钉住"的说法已撤） |
| `version`                                                                                                         | `versionRootOf` / `stagingRootOf` / 备份名 `-manifest.json-pre-<version>`                                  | **(a)**                  | `assertSafeVersion` 复用 Task 1 的 `SEMVER_PATTERN`（第三修复刀第 61 条已机械钉住该正则的字符类不含 shell 元字符），同在 `pre-verify` 的 try 里、任何远端调用之前                                                                                                            |
| `planHash`                                                                                                        | `stagingRootOf` 的目录段（`.part-<runid>` 与 `.tmp` 所在的那条路径）                                       | **(a)**                  | 由本模块的 `planHashOf` 生成（`createHash('sha256')…digest('hex')`，恒为 64 位十六进制），不是外部输入。**本刀实测**：`planHash` 先赋 `'uncomputed'`，但在它进入任何远端脚本之前一定已被 `planHashOf` 覆盖（赋值在步骤 1 内，`stage` 是步骤 2）                              |
| `runid`                                                                                                           | `stagingRoot` 里的 `.part-<runid>`、正式目录里的 `manifest.json.<runid>.tmp`                               | **(a)**                  | `assertSafeRunid`（`/^[A-Za-z0-9._-]+$/u`，**本刀新增**；Task 7 用 `randomUUID()`，落在该字母表内），同在 `pre-verify` 的 try 里、任何远端调用之前                                                                                                                           |
| `UPDATE_ROOT` / `STATE_ROOT` / `PORTABLE_PACKAGE_NAME` / `PORTABLE_FILE_MANIFEST_NAME` / `PORTABLE_MANIFEST_NAME` | 几乎每条                                                                                                   | **(a)**                  | 模块级**字面常量**，不由输入派生                                                                                                                                                                                                                                             |
| `directory` / `target`（探针与 `sha256sum` 的实参）                                                               | `readRemoteDirectory` / `remoteDirectoryExists` / `readRemoteHashes` / `readRemoteFileSha`                 | 组合值（无独立来源）     | 全部由上面几行拼成（`versionRootOf` / `stagingRootOf` / `${UPDATE_ROOT}/${channel}/${MANIFEST}`）⇒ 被同样的前置条件覆盖                                                                                                                                                      |
| `names`（`sha256sum` 的文件名）                                                                                   | `readRemoteHashes`                                                                                         | **(a)**                  | 调用点只传 `expectedEntries` 的两个名字，都来自 `PORTABLE_PACKAGE_NAME` / `PORTABLE_FILE_MANIFEST_NAME` 常量                                                                                                                                                                 |

**owner 记录不进远端脚本**：`acquireChannelLock` 把 `JSON.stringify(input.owner)` 走 **base64**（第三修复刀第五处偏离）⇒ 类别 **(b)**。**唯一带 `LC_ALL=C` 的远端命令是锁 `mkdir`**（它的诊断文本被 `isFileExistsFailure` 按英文子串匹配）；本刀其余命令按计划第 7 处偏离的结论**一律不加**（解析的是结构化内容，`sort` 的顺序不被消费）。

### 六、真验证器三角验证（验收项"真验证器"，本刀实跑的三条读数）

| 方向                                                                                          | 读数                                                                                                                                                         |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. Task 1 夹具签的 manifest → **夹具口径**验证器（按 `JSON.stringify(payload)` 插入顺序验签） | **ACCEPTED**（夹具自洽）                                                                                                                                     |
| B. Task 1 夹具签的 manifest → **真** `verifyPortableRelease`                                  | **REJECTED `release manifest signature is invalid`** ⇐ **这就是那个陷阱：看起来像产品 bug，其实是夹具按插入顺序签、真验证器按 `canonicalize()`（排序键）签** |
| C. `buildPortableRelease` 产出的 manifest → **真** `verifyPortableRelease`                    | **ACCEPTED**                                                                                                                                                 |

**钉子**：新用例 `the real release verifier accepts a canonically signed manifest and rejects an insertion ordered one` 把 B 与 C 两条**钉进套件**（都经过 `verifyPublicArtifacts`，注入真 `verifyPortableRelease`）⇒ 下一个接真验证器的人不会再被这个形状骗一次。**B 的断言是 `/release manifest signature is invalid/u`** —— 真验证器的签名检查排在文件清单与包完整性**之前**，所以拿它指认成因是可靠的。

### 七、本刀刻意不钉的（别当缺陷再报一遍）

1. `assertEveryCommitCallCarriesTheTrustAnchor` 的**断言文案**：夹具的记录形状（`fetchPublic` 记 URL、`sftpUpload` 记 localPath / remotePath，二者都没有 request）决定了它只对 `readSsh` / `writeSsh` 生效；`the commit anchor helper names a call that did not record its request` 钉的是**文案**（去掉 `assert.ok(request !== undefined, …)` 后未定义的 `request` 仍会在 `request.host` 上抛 —— 与第三修复刀第 56 条同一口径：这是诊断质量守卫，不是静默放行的洞）。
2. `commitInput` 把锚点存到 `transport.anchor`（而不是让每条用例自己绑 `input`）：目的是"每条走 `commitTransport` 的用例只加一行断言"，断言本身仍然是真的（拿注入值比每一次记录的 request）。**零调用不算通过** ⚠️ **本刀原先写成"由 `calls.length > 0` 与 `sshCalls.length > 0` 两条守卫保证"—— 复核刀实测更正：只有 `sshCalls.length > 0` 一条在承担它。** `calls.length > 0` 被 `sshCalls.length > 0` **严格蕴含**（`calls` 为空 ⇒ `sshCalls` 为空；`calls` 非空但一条 ssh 都没有 ⇒ 仍然被第二条挡住）⇒ 它是一条**永远不可能单独失败**的断言，删掉它**套件全绿**（复核刀读数）。**处置**：**删掉那条冗余断言**（复核刀，见第九节），保留 `sshCalls.length > 0` 承担这个性质，并由 `the commit anchor helper refuses a case that recorded no call` 钉住（`calls: []` 现在是被第二条断言拒的）。
3. `assertSafeVersion` / `assertSafeRunid` 的**报错文案**（`the version … is not a strict semantic version…` / `the run id … carries a character outside…`）：被测的只有"抛的是 `FeedPublishError`"与"没有远端调用"。
4. `isInsideRepository` 对**跨盘符**那一臂（Windows 上 `relative` 返回绝对路径 ⇒ 判为仓库外）：与兄弟模块同义，今天没有用例单独钉它（构造跨盘用例要碰真实盘符，收益不抵）。
5. `lock.incident === true` 分支里 `audit('lock','incident', …)` 的**文案**（直接用 `acquireChannelLock` 给的 `lock.reason`）：被测的是阶段状态与收口结果，不是那句话。

### 八、本刀未做 / 未验（不得写成已完成）

- **没有连过任何服务器**：全部远端动作走注入的异步假 transport，一条真实 `ssh` / `sftp` / 网络调用都没有。**Task 6 的真机读数（coreutils 权限失败原文、目标主机 `locale`）仍然欠着** —— 本刀因此**没有**让任何断言依赖 `mkdir` 权限失败的具体文本（夹具里的 `Permission denied` 只用来证明"非 `File exists` 的非零 `mkdir` ⇒ `incident`"这条**分类**，不钉文本）。
- **没有把真 `verifyPortableRelease` 接到 `runCommit` 的默认路径**：本刀只把它用在**测试**里（第六节）；CLI 的接线在 Task 7。
- `--dry-run` / `--preflight` 的 CLI 形状、`--audit-out` 必填、`--break-lock` 的出口都属于 Task 7；本刀只把 `runCommit` 的形状定下来。
- **提交时 `pre-commit`（lint-staged）跑过 `eslint --fix` + `prettier --write`**：提交后重新量的两份 blob sha256 与变异基线**逐字节相同**（读数见本节开头），所以上面的变异证据对提交的字节仍然成立。
- 本刀**没有**在 `RunCommit` 里给 `repositoryRoot` 为空串的情况加守卫（`appendAuditStage` 只在 `repositoryRoot` 是非空字符串时才检查）—— 那是 Task 2 已定的契约，本刀不动。
- **（复核刀追加）`flip` 失败那条分支没有任何用例覆盖**：夹具没有"翻转 `mv -f` 返回非零"的臂，因此 `audit('flip','incident','the atomic flip failed')` 这条路径**在套件里不可达**。复核刀**故意没有**给这条分支加证据字段 —— 加了就是一条"没有测试能钉住"的接线，正是复核刀要清掉的那种形状。**Task 5–8 若要动这条分支，先补夹具臂与用例再改。**
- **（复核刀追加）`input.now` 必须由 Task 7 注入真时钟**：`runCommit` 的每条审计条目都取 `at`，来源是 `input.now()`（未注入时回退到注入的 `startedAt`，所以缺省读数不是"没有时间"，而是"整轮同一个时间"）。Task 7 的 CLI 必须传 `now: () => new Date().toISOString()`（那是 CLI 层的事，`scripts/lib/` 里**没有** `new Date()`）。

### 九、复核刀（spec 合规闸门五项）的落地、读数与本账本更正

**这一刀是什么：** Task 4 的三个提交（`e98c214c` 代码 / `139146b8` 账本 / `7d89aade` contracts）过 spec 合规闸门时被记了**五条**，每条都有复核者复现过的实测（不是意见）。本节给出：① 每条的落地；② **每一处新增接线/守卫的钉子与变异读数（34 条，全部打印了 hunk）**；③ 对本账本**三处错误陈述**的更正。代码提交：`3503965a`（模块，blob sha256 `3133378f…`）、`4f5bb3af`（测试，blob sha256 `abcbaca1…`）—— **与变异基线逐字节相同**（提交时 `pre-commit` 跑过 `eslint --fix` + `prettier --write`，两个 blob 都没被改动）。

**一、五条各自的落地**

1. **`releaseAndFinish` 那个解锁调用点原先没被任何用例覆盖（最重要的一条）。** 复核者实测：只在 `releaseAndFinish` 的 `releaseChannelLock({…})` 里加一个 `owner,` ⇒ **117/0 全绿（存活）**；同样的改动加在成功路径那处 ⇒ 116/1。原因：夹具 `foreignOwnerAfterFlip` 只在**翻转之后**换 `ownerJson`，所以只走到成功路径那个解锁点。**落地**：① 新夹具臂 `foreignOwnerAfterCommit`（在**提交版本目录那次 `mv`** 之后换 `owner.json`，与 `commitStatus: 1` 组合 ⇒ 走到 `releaseAndFinish`）；② 新用例 `an owner record replaced before the unlock on the failure path stops the run and deletes nothing`（`feed-publish.test.mjs:2166`），断言 `outcome === 'fail'`、`lockState === 'ownership-unknown'`、`commit-version` 是 `fail`、`unlock` 是 `retained`、**一次 `rm`/`rmdir` 都没发**、审计里没有把 `unlock` 写成 `done` 的条目；③ **验收项 1 的措辞已改**（原话"这条同时证明两个解锁点没有传 `owner`"是假的，见该验收项）。
2. **`D6a` 的"不可钉住"是错的（本账本第 12 条的说明 + 第三节的 D6a 行 + 第五节 `channel` 行都已更正）。** 实测钉子：`channel: ''` 时两层**报错文案不同**（两层之间隔着 `verifyLocalArtifacts`）⇒ 新用例 `the channel precondition refuses an empty channel by its own reason before any remote write`（`feed-publish.test.mjs:2186`）把 `runCommit` 入口那句 `assertSafeChannel(input.channel)` 单独钉住。**冗余保留，但"不可单独钉住"这句话从账本撤掉。**
3. **装置纪律加严（本计划"变异与镜像"一节新增第 3 条，Task 5–8 继承）。** 复核者的作废读数 ③ 与本刀**同形**：把 `audit('commit-version','done');` 插在设备号检查里那条 `return releaseAndFinish(…)` **之后** ⇒ 语法合法、磁盘字节真的变了、套件 **133/0 全绿**（不可达代码被当成"存活"）。本刀的装置因此：**打印 hunk**（整行，不是半行片段）、**对纯插入做可达性检查并拒收**（本刀用它复现并拒收了那条假存活，同时用一次真变异验证了拒收会触发）、**预先写明"哪条测试必须按名变红"并核对红名单**。⚠️ 装置自身的第一版 `locateInsertion` **是错的**（对纯插入，`before.slice(offset) === after.slice(offset+n)` 在**任何** `offset ≤ 真插入点` 处都成立 ⇒ 它会返回一个偏前的偏移、于是可达性检查在**它本该拒收的那条**上报了 `reachable-or-unknown`）。**这正是"先验你自己的验证脚本"**：不拿那条已知形状去试装置，就会把"装置没生效"读成"这是真存活"。
4. **七个守卫 + 一条冗余断言（逐个给处置）：** 复核者逐条实测"删掉 ⇒ 117/0 全绿"，本刀**七个全部选"钉住"**（都便宜，且都是 fail-closed 方向），**第八条（`calls.length > 0`）选"删掉"**（见第七节第 2 条：它被第二条断言严格蕴含，永远不可能单独失败 ⇒ 留着只会在账本里冒充第二条守卫）。七个钉子与它们的变异见下面的表；每条的**处置理由**：这七个都是"远端说了什么都不信"的守卫，删掉它们不会让套件红、只会让**某一条真路径静默地按乐观解释走**（把失败当空目录、把无回应当不存在、把探针失败当目录在），这正是本工具存在的理由（可审计）——所以一律钉住，不记"刻意冗余"。
5. **审计内容按 §6.11 补全（本刀实现，不是声明）。** 形状见下节。**"时间"必须是注入值**：`scripts/lib/` 里没有 `new Date()`（沿用 `startedAt` 的待遇），新增可选输入 `input.now`（函数）。**没有"带不了"的项**：spec 列出的每一项都有对应的值；唯一**故意不带**的是 `flip` 失败分支（**没有任何夹具臂能到达它**，见第八节末 —— 给它加证据就是加一条钉不住的接线）。

**二、审计条目的形状变化（**这是对外可观察的行为改动，Task 7 的 CLI 与手册要跟上**）**

- 每条条目（`open` / 各阶段 / `lock-retained` / `done|fail|incident|retry|blocked` / `unlock`）现在都带 **`operator`**（来自 `input.operator`，缺失时写 `null` —— 显式写 `null` 而不是让 `JSON.stringify` 静默丢掉这个键）与 **`at`**（来自 `input.now()`，未注入时回退到注入的 `startedAt`，都缺失时也是 `null`）。条目的 `runid` / `planHash` / `reason` / `detail` / `status` 字段名**不变**（既有断言不受影响）。
- 新增证据字段（都挂在"该值成为事实"的那条上，成功与失败两条都挂）：
  - `pre-verify` done ⇒ `local`：三个产物的本地 `packageSha256`/`packageSize`/`fileManifestSha256`/`fileManifestSize`/`manifestSha256`/`manifestSize`；
  - `remote-verify` done **与** fail ⇒ `remote`：远端探针**实际观察到**的 `present`/`empty`/`problems`/`entries`（`type`/`name`/`size`）/`digests`（名字→摘要；读不到时是 `null`，不是 `{}`）；
  - `backup-manifest` done ⇒ `previousManifestSha256`（旧 manifest 的原始 SHA-256）+ `backupPath`；
  - `cas` done **与** incident ⇒ `previousManifestSha256` + `observedManifestSha256`；
  - `temp-manifest`（上传失败 / 摘要不匹配 / done）⇒ `manifestSha256`（新 manifest）+ 后两者再加 `remoteTempSha256`；
  - `flip` done ⇒ `manifestSha256`；
  - `public-verify`（读失败 / 验签抛错 / `ok !== true` / retry / third）⇒ `manifestSha256` + `observedManifestSha256` + `previousManifestSha256`；done ⇒ `public`：`verifyPublicArtifacts` **实际比对**的那五个值（`ok`/`manifestSha256`/`packageSha256`/`packageSize`/`fileManifestSha256`/`fileManifestSize`）；
  - 收口条目 `done` ⇒ `manifestSha256`。
- **两个"值被算出来又被丢掉"的函数现在把它们返回出来**：`inspectRemoteDirectory`（原先丢弃远端 entries/digests，只回 problems）、`verifyPublicArtifacts`（原先丢弃 `manifestSha256`，只回 `{ok, reason}`）。第三个被点名的值是 `baselineSha`/`casSha`/`remoteTempSha` —— 它们此前只参与比较、从不进日志，现在都进了。

**三、变异清单（复核刀，全部对着 `3503965a` / `4f5bb3af` 的字节）**

装置每条的固定动作：断言锚点恰好匹配 **1** 次 → 变异前取 sha256 基线 → 写入 → 重读确认落盘 → `node --check` → 跑套件 → **打印 hunk** → 纯插入做可达性检查 → **核对"哪条测试必须按名变红"的红名单** → 逐字节恢复 → 比 sha256 → 断言该文件 `git status` 与变异前逐字相同。**34 条全部：锚点 1 次、`node --check` ok、恢复后 sha256 相等、`git status` 未变。**

| #          | 变异（hunk：`-` 删 / `+` 加）                                                                                                                                       | 读数                        | 按名变红的测试                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------- |
| 对照       | `- 'the uploaded manifest does not match the local manifest'` / `+ … did not match …`（只改一句报错文案）                                                           | **133 / 0（全绿）**         | —（证明装置不是"改什么都红"）                                                                                                                                                                     |
| M-f1       | `releaseAndFinish` 的 `releaseChannelLock({…})` 里 `+ owner,`（把步骤 5 的快照传进去）                                                                              | **133 / 1**                 | `an owner record replaced before the unlock on the failure path stops the run and deletes nothing`                                                                                                |
| M-f2       | `- assertSafeChannel(input.channel);`（`runCommit` 入口那处，保留 `assertSafeVersion`）                                                                             | **133 / 1**                 | `the channel precondition refuses an empty channel by its own reason before any remote write`                                                                                                     |
| M-1        | `- if (listing.status !== 0) return [];`                                                                                                                            | **133 / 1**                 | `a staging listing that failed is reported as an empty directory rather than parsed`                                                                                                              |
| M-2        | `- return probe.status === 0 && String(probe.stdout ?? '').trim() === 'present';` / `+ return String(probe.stdout ?? '').trim() === 'present';`                     | **133 / 1**                 | `a presence probe that failed is not read as a present directory`                                                                                                                                 |
| M-3        | `- if (entry.type !== 'f') problems.push(…)`                                                                                                                        | **133 / 1**                 | `a staging entry that is not a regular file is refused`                                                                                                                                           |
| M-4        | `- if (hashes === null) return ['the remote digests could not be read'];`                                                                                           | **133 / 1**                 | `a digest read that failed stops the run instead of throwing out of the commit`（没有守卫时 `hashes.get` 抛 `TypeError` ⇒ `runCommit` reject）                                                    |
| M-5        | `- …split(/\s+/u)[0]                                                                                                                                                |                             | 'absent';`/`+ …split(/\s+/u)[0];`                                                                                                                                                                 | **133 / 1** | `a remote manifest whose digest could not be read is logged as absent rather than as a blank` |
| M-6        | `- if (devices.status !== 0 \|\| deviceList.length !== 2 …` / `+ if (deviceList.length !== 2 …`（删状态码那一臂）                                                   | **133 / 1**                 | `a device probe that failed stops the commit even when it printed matching numbers`                                                                                                               |
| M-7        | `- if (observed.status !== 200 \|\| observed.bodyBytes === undefined)` / `+ if (observed.status !== 200)`                                                           | **133 / 1**                 | `a public manifest response without body bytes is an incident rather than a crash`                                                                                                                |
| M-8        | **对照方向**：把删掉的那条断言**加回去** ⇒ `+ assert.ok(transport.calls.length > 0, '… needs at least one recorded call');`                                         | **133 / 0（全绿）**         | —（**两个方向都不被套件察觉**：删掉全绿、加回也全绿 ⇒ 它不是一条"被钉住的守卫"，处置 = 删除并由 `sshCalls.length > 0` 承担该性质，见第七节第 2 条。**这条是"哪里都没有它的读数"，不是假存活**。） |
| M-9        | `- audit('pre-verify', 'done', undefined, localEvidence);` / `+ audit('pre-verify', 'done');`                                                                       | **133 / 1**                 | `the audit log carries the operator, the run time and the local digests and sizes`                                                                                                                |
| M-10       | `baseOf` 里 `- operator: input.operator ?? null, at: atValue()` / `+ at: atValue()`（整条 operator 接线）                                                           | **133 / 2**                 | 上一条 + `the audit log keeps the operator and the time as null instead of dropping them`                                                                                                         |
| M-11       | `baseOf` 里 `- at: atValue()`（整条 at 接线）                                                                                                                       | **133 / 3**                 | M-9 那条 + `the audit log takes each entry time from the injected clock rather than the run start` + `… as null instead of dropping them`                                                         |
| M-12       | `- const atValue = () => (input.now === undefined ? input.startedAt : input.now()) ?? null;` / `+ const atValue = () => input.startedAt ?? null;`（无视注入的时钟） | **133 / 1**                 | `the audit log takes each entry time from the injected clock rather than the run start`                                                                                                           |
| M-13       | `operator: input.operator ?? null` ⇒ `operator: input.operator`（去掉 null 兜底）                                                                                   | **133 / 1**                 | `the audit log keeps the operator and the time as null instead of dropping them`                                                                                                                  |
| M-14       | `atValue` 去掉 `?? null`                                                                                                                                            | **133 / 1**                 | 同上一条                                                                                                                                                                                          |
| M-15       | `- audit('remote-verify', 'done', undefined, stagingEvidence);`                                                                                                     | **133 / 1**                 | `the audit log carries the entries and digests the staging directory reported`                                                                                                                    |
| M-16       | `- audit('remote-verify', 'fail', detail, stagingEvidence);`                                                                                                        | **133 / 1**                 | `a staging entry that is not a regular file is refused`（断言失败那条的 `remote` 证据）                                                                                                           |
| M-17       | `- audit('backup-manifest', 'done', undefined, { previousManifestSha256: baselineSha, backupPath });`                                                               | **133 / 1**                 | `the audit log carries the previous manifest digest and the backup path`                                                                                                                          |
| M-18       | `- audit('cas', 'done', undefined, casEvidence);`                                                                                                                   | **133 / 1**                 | 同上一条（同一用例也断言 `cas` done 的两个摘要）                                                                                                                                                  |
| M-19       | `- audit('cas', 'incident', undefined, casEvidence);`                                                                                                               | **133 / 1**                 | `a remote manifest whose digest could not be read is logged as absent rather than as a blank`                                                                                                     |
| M-20       | `- audit('temp-manifest', 'incident', 'the manifest upload failed', manifestEvidence);`                                                                             | **133 / 1**                 | `a manifest upload failure is an incident that keeps the lock`                                                                                                                                    |
| M-21       | `- tempManifestEvidence,`（摘要不匹配那条）                                                                                                                         | **133 / 1**                 | `a mismatched remote manifest digest stops before the flip`                                                                                                                                       |
| M-22       | `- audit('temp-manifest', 'done', undefined, tempManifestEvidence);`                                                                                                | **133 / 1**                 | `the audit log carries the new manifest digest at the temp manifest, the flip and the outcome`                                                                                                    |
| M-23       | `- audit('flip', 'done', undefined, manifestEvidence);`                                                                                                             | **133 / 1**                 | 同上一条                                                                                                                                                                                          |
| M-24       | `- recordOutcome('done', 'published', manifestEvidence);`                                                                                                           | **133 / 1**                 | 同上一条                                                                                                                                                                                          |
| M-25       | `- audit('public-verify', 'incident', 'the public manifest could not be read', manifestEvidence);`                                                                  | **133 / 1**                 | `a public manifest response without body bytes is an incident rather than a crash`                                                                                                                |
| M-26       | `- audit('public-verify', 'done', undefined, { public: publicCheck });`                                                                                             | **133 / 1**                 | `the audit log carries the public digests and sizes the verification compared`                                                                                                                    |
| M-27       | `verifyPublicArtifacts` 的返回退回 `+ return { ok: true, manifestSha256: … };`（丢掉新加的三个值）                                                                  | **133 / 1**                 | 同上一条                                                                                                                                                                                          |
| M-28       | `- audit('public-verify', 'retry', undefined, observedEvidence);`                                                                                                   | **133 / 1**                 | `an indeterminate outcome with the old public sha allows a retry and keeps the lock`                                                                                                              |
| M-29       | `- audit('public-verify', 'incident', 'a third manifest digest appeared', observedEvidence);`                                                                       | **133 / 1**                 | `an indeterminate outcome with a third public sha stops and keeps the lock`                                                                                                                       |
| M-30       | `- audit('public-verify', 'incident', error.message, observedEvidence);`                                                                                            | **133 / 1**                 | `a public verifier that rejects after the flip is an incident that keeps the lock`                                                                                                                |
| M-31       | `- audit('public-verify', 'incident', publicCheck.reason, observedEvidence);`                                                                                       | **133 / 1**                 | `the public verification is actually run after the flip`                                                                                                                                          |
| M-32       | `inspectRemoteDirectory` 的返回里 `- digests: digests === null ? null : Object.fromEntries(digests),`（返回不再带远端摘要）                                         | **133 / 2**                 | `a staging entry that is not a regular file is refused`（断言 `remote.digests === null`）+ `the audit log carries the entries and digests the staging directory reported`                         |
| 假存活探针 | 把 `audit('commit-version','done');` 插在设备号检查那条 `return releaseAndFinish(…)` **之后**（不可达）                                                             | **133 / 0（但被装置拒收）** | —（装置报 `SURVIVOR_REJECTED … after an unconditional return`；**这一条是装置自身的验证，不是一项变异读数**）                                                                                     |

**次数：36 条读数**（1 条对照 + 34 条变异 + 1 条假存活探针；其中 M-8 与假存活探针**各单独跑了一次**，其余 34 条一次跑完），**0 条 `EXPECTATION_FAILED`**（每条都在红名单里核对了"必须变红的那条测试"）。**红线之外没有意外**：只有 M-10 / M-11 / M-32 红到 2–3 条，原因是它们动的是被多条审计用例共同依赖的基座（`baseOf`）与返回形状；**没有一条变异只红"别的测试"**。

**四、当前读数（复核刀重测，取代第四节的旧读数）**

- `feed-publish.mjs` **1030** 行、`feed-publish.test.mjs` **2395** 行（`wc -l`）；套件 **133 条**（`node --test` 的 `ℹ tests 133` / `ℹ pass 133` / `ℹ fail 0`），比本刀前 **117** 条多 **16** 条（**全部**是新增用例：解锁失败路径 1 + 空 channel 前置条件 1 + 七个守卫 7 + 审计内容与形状 7）。
- **规定块边界（同时是这一刀改过的两段）**：Task 4 测试块 = 计划第 1762–2836 行 ⇔ `feed-publish.test.mjs` **1321–2395**（围栏在计划第 1761 / 2837 行）；Task 4 模块块 = 计划第 2852–3438 行 ⇔ `feed-publish.mjs` **444–1030**（围栏在计划第 2851 / 3439 行）。⚠️ 这四个计划行号是**跑过 `prettier --write` 之后**重测的（prettier 把本节前面一段正文折行 ⇒ 围栏整体下移 2 行 —— 行号会漂，别拿折行前的读数引用）。**两对 `diff` 都是 `DIFF_EMPTY`**（复核刀改文件的同时把围栏里的规定块**一起**改成新的那一段，因此"块 = 文件那一段"仍然成立；这也是为什么本节的偏离清单必须补记第 13 条）。
- **没有连过任何服务器**：这一刀的所有读数都来自注入的假 transport，与 Task 4 同规格。

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

**必须遵守：** 顶层 `await`，只用 `process.exitCode`，**不得**在 Promise 完成前 `process.exit`；batch 文件是**仓库外唯一临时文件**（`mkdtempSync`），并在 `finally` 清理，因此并发运行不会互相覆盖；`--break-lock` 的 `--reason` / `--audit-out` / `--confirm-runid` **三角都必填**；`--commit` 分支必须把锁记录的三个注入值一起交给 `runCommit`（`operator` 取 `process.env.MOFANG_FEED_OPERATOR ?? 'unknown'`，与 `--break-lock` 同一来源；`startedAt` 取 CLI 启动时的 `new Date().toISOString()`；`machine` 取 `hostname()`，导入行是 `import { hostname } from 'node:os';`）—— `scripts/lib/` 是纯模块，**不得**出现 `new Date()` 或 `hostname()` / `os.hostname()`，三个值只能由 CLI 注入。⚠️ **`machine` 只有一种写法：`hostname()`**（规定块里 `import { hostname } from 'node:os';` 是解构导入，所以调用端不能写 `os.hostname()`）。照抄散文里的 `os.hostname()` 会在 CLI 启动时以 `ReferenceError: os is not defined` 死掉，而那条路径的守卫测试**只覆盖 `--reason` / `--audit-out` / `--confirm-runid` 与 hosts 文件**，**不会**覆盖它 —— 本计划原先在 Task 4 的接线段与 Task 7 的这段里都误写成 `os.hostname()`，已两处改成 `hostname()`。

**第二修复刀追加的 Task 7 验收项（本刀只写计划，代码在 Task 7 落）：**

1. **"锁在、但 owner 记录读不出来"必须有一条被确认的 CLI 出口（第二修复刀第三处）。** 现在是死路：`breakChannelLock` 对 `owner === null` 一律抛 `the lock has no readable owner record, so it must be inspected by hand`，而 `readOwnerRecord` 把**三种成因**（transport 失败 / 文件不存在 / 内容不是 JSON）压成同一个裸 `null`，CLI 说不出是哪种、也就无从确认 `--confirm-runid`。**"交给人工检查"单独一句不是可接受的终态指令**：这个仓库有一条硬规定就是**永远不要对 openclaw 状态目录 `rm -rf`**（它是 junction 高发区），而"交给人工"正是把操作员推向那一步。要做两件事：
   - **CLI**：新增一条走**同一套 reason / audit / 确认纪律**的路径 —— `--break-lock --owner-record-unreadable --reason "<文本>"`：仍然必填 `--reason` 与 `--audit-out`，仍然要求操作员**显式声明**"已确认前一次运行不在进行中"（用这个 flag 本身就是那次声明），审计里记 `stage: 'break-lock'` + `ownerRecordUnreadable: true` + 原因 + 执行人；**不要求** `--confirm-runid`（根本没有可确认的 runid —— 这正是这个状态的定义）。删除动作仍是先 `rm owner.json` 再 `rmdir <lock>`，**两次都成功才算成功**，任一次失败按现在的形状抛错、**不得**记录成 `lock-broken`。
   - **手册**（`docs/runbooks/portable-update-release.md`）：给出**确切的状态路径**与**确切的命令**。状态路径是 `/opt/rongying/updates-state/lock/<channel>`，记录文件是它下面的 `owner.json`。人工核查三条精确命令：① `ls -la /opt/rongying/updates-state/lock/<channel>`（看清楚目录里到底有什么、时间戳是多少）；② `cat /opt/rongying/updates-state/lock/<channel>/owner.json`（三种成因各自长什么样：`No such file or directory` = 记录没写成或已被删；非 JSON 文本 = 写坏了；`Permission denied` = 取不到）；③ 确认前一次运行确实不在进行中之后，才走 `node scripts/feed-publish.mjs --break-lock --channel <channel> --owner-record-unreadable --reason "<文本>" --audit-out <仓库外路径> --host <host> --known-hosts <仓库外路径>`。**手册里必须写明"不要 `rm -rf` 这个目录"**，并把 §6.6 的常规 `--break-lock`（owner 可读）与本条并列成两种情况。
2. **`readOwnerRecord` 的契约宽化归 Task 7（第二修复刀第三处，别在别的刀里动它）。** 现在它返回 `null` 表示**三种**成因。Task 7 负责把它改成**能区分三者**的形状（例如 `{ status: 'read' | 'missing' | 'transport' | 'corrupt', record }`，或抛 `FeedPublishError` 并带成因），并同步它的**两个消费者**（Task 4 的解锁路径、Task 7 的 `--break-lock` 两条路径）与全部断言。**本刀不改**：动它的返回形状会同时改到 Task 4 与 Task 7 的接线面，属于"先把契约定清楚再改代码"的那一类。
3. **`auditOut` 必须真的被用掉（第二修复刀"记录不改"第二处）。** `breakChannelLock` 已经**校验**了 `input.auditOut`（非空字符串），但函数体内**一次都没用它** —— 它是在 Task 7 的 CLI 里被接上的（`appendAuditStage({ auditOut, repositoryRoot, entry: { stage: 'break-lock', ...record } })`）。实现 Task 7 时**必须**确认**四种模式的每一条**都把 `--audit-out` 接到某个真实写入点，而不是"传进去、校验过、然后忘掉"。特别是 `--break-lock` 与 `--owner-record-unreadable` **两条都要**写审计行。**验收方式必须是可观测的**：跑一次 `--break-lock`，确认目标路径**真的多了一行**（不是看代码里有没有引用它）。
4. **把本次运行自己的 owner 记录送到那个状态需要的出口（第二修复刀"记录不改"第三处）。** `owner` 在两个分支里含义不同：owner 写入**成功**时返回 `owner: input.owner`（本次运行自己的记录），owner 写入**失败**时返回 `owner: null` —— 而后者恰恰就是"锁在、记录读不出来"那个状态。于是操作员**拿不到 `--confirm-runid` 需要的那个值**（`runid` 只在**运行方**手里，锁里没有）。Task 7 要在这个状态下**把本次运行自己的 `runid` 与 `planHash` 送到操作员看得见的地方**（CLI 打印 + 审计行），否则"要不要人工拆这把锁"这个判断没有依据。**本条的形状随上面第 2 条一起定**（第 2 条宽化 `readOwnerRecord` 的契约，本条决定谁把运行方自己的记录带出来）—— 两条都在 Task 7，一起改，别分两次动契约。

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

**锁在、但 `owner.json` 读不出来时**（`--confirm-runid` 无从确认 —— 上面那条命令**不适用**）：状态路径是 `/opt/rongying/updates-state/lock/<频道>`，记录文件是它下面的 `owner.json`。**不要 `rm -rf` 这个目录，也不要 `rm` 掉锁目录本身**（状态目录是 junction 高发区，本仓库有硬规定；裸删会留下无法解释的状态）。在发布主机上按顺序做三件事：

```bash
ls -la /opt/rongying/updates-state/lock/<频道>
cat /opt/rongying/updates-state/lock/<频道>/owner.json
```

第二条的输出分四种，分别意味着不同的事：`No such file or directory` = 记录没写成或已被删；非 JSON 文本 = 写坏了；`Permission denied` = 取不到；**空输出（0 字节）= 文件被创建但载荷没写进去**（owner 写入是 `printf … | base64 -d > owner.json`，重定向**先**创建/清空文件，所以 `base64 -d` 失败、中途被杀、或路径上根本没有 `base64` 都会留下一个 0 字节或半截的文件）。**确认前一次运行确实不在进行中**之后，才走这条专用路径（仍然必填 `--reason` 与 `--audit-out`，并用这个 flag 本身作为"已确认不在进行中"的声明；**不要求** `--confirm-runid`，因为根本没有可确认的 runid）：

```powershell
node scripts/feed-publish.mjs --break-lock --channel <频道> --owner-record-unreadable --reason "<为什么可以安全破除>" --host <主机> --known-hosts <路径> --audit-out <审计日志路径>
```

审计日志里会记 `stage: break-lock` + `ownerRecordUnreadable: true` + 原因 + 执行人。**「交给人工检查」单独一句不是可接受的终态指令**：没有上面这条路径，操作员面前只剩"自己想办法删掉那个目录"一条路，而那正是本仓库禁止的动作。

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
