# 发布组装与 CI 纠偏 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让启动器构建产出**带指纹的回执**、让组装器与交付审计**按密钥台账硬拒绝配错**，把 CI 从生产签名彻底解耦，并删掉那个从不被消费的假密钥门禁。

**Architecture:** 新增一个纯函数模块 `scripts/lib/portable-executable.mjs`（PE 结构检查）与一个回执模块 `scripts/lib/launcher-receipt.mjs`（生成 + 校验，硬拒绝与警告分级）。构建脚本产出 `<out>/launcher-build-receipt.json`；组装器与验收审计都从**外部**通过 `--receipt` 读取它。CI 侧把 portable 制品 job 从上游多平台 `release.yml` 拆成独立 workflow，只产出 **unsigned** 制品，绝不持有生产私钥。

**Tech Stack:** Node 20（ESM、`node:test`、`node:assert/strict`）、Go 1.25、GitHub Actions、pnpm 10。

**规格来源：** `docs/superpowers/specs/2026-09-22-portable-release-infrastructure-correction-design.md` §3.5、§3.6、§5.1–§5.8、§7、§8。

---

## 文件地图

| 文件                                                                  | 动作 | 职责                                                                            |
| --------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------- |
| `scripts/lib/key-registry.mjs`                                        | 新建 | 机器可读密钥台账的解析、按版本查登记、指纹比对（统一走 `normalizeFingerprint`） |
| `scripts/lib/key-registry.test.mjs`                                   | 新建 | 台账规则的单测                                                                  |
| `docs/portable-update-key-registry.json`                              | 新建 | 机器可读台账**模板**（`keys` 为空数组，**不含任何真实值**）                     |
| `scripts/lib/portable-executable.mjs`                                 | 新建 | 纯函数：校验 `MZ` / `PE\0\0` / AMD64 / PE32+ / GUI 子系统                       |
| `scripts/lib/portable-executable.test.mjs`                            | 新建 | 上述检查的单元测试（含逐字节构造的假 PE）                                       |
| `scripts/lib/launcher-receipt.mjs`                                    | 新建 | 回执的生成、解析、硬拒绝与警告分级；公开指纹的规范化                            |
| `scripts/lib/launcher-receipt.test.mjs`                               | 新建 | 回执规则的单测                                                                  |
| `scripts/lib/portable-launcher-build.mjs`                             | 修改 | 用 PE 检查器替换两字节判断；产出回执                                            |
| `scripts/build-portable-launcher.mjs`                                 | 修改 | 新增 `--out` 与 `--receipt`                                                     |
| `scripts/lib/portable-launcher-build.test.mjs`                        | 修改 | `--out` 与回执的行为断言                                                        |
| `scripts/assemble-udisk-delivery.mjs`                                 | 修改 | 新增必填 `--receipt`；空目录检查移到最前；硬拒绝/警告分级                       |
| `scripts/lib/udisk-delivery.test.mjs`                                 | 修改 | 组装器与审计的新规则                                                            |
| `scripts/lib/udisk-delivery.mjs`                                      | 修改 | 新增 `warning()` 与四条启动器规则                                               |
| `scripts/udisk-delivery.mjs`                                          | 修改 | 新增 `--receipt`；IO 适配器补二进制读取                                         |
| `scripts/lib/portable-launcher-challenge.mjs`                         | 新建 | 发布期 QC 挑战的判定逻辑与负向样本生成                                          |
| `scripts/portable-launcher-challenge.mjs`                             | 新建 | 挑战 CLI                                                                        |
| `scripts/lib/portable-launcher-challenge.test.mjs`                    | 新建 | 判定逻辑与 CLI 守卫的单测                                                       |
| `scripts/make-portable-unsigned-artifacts.mjs`                        | 新建 | 只产出 unsigned 的 ZIP 与文件清单（CI 用）                                      |
| `scripts/lib/portable-unsigned-artifacts.test.mjs`                    | 新建 | 上者的单测                                                                      |
| `.github/workflows/portable-artifacts.yml`                            | 新建 | 独立的制品 workflow（`workflow_dispatch`）                                      |
| `.github/workflows/release.yml`                                       | 修改 | 删除 portable job 与三密钥门禁，改为上游语义说明                                |
| `scripts/lib/portable-update-ci.test.mjs`                             | 修改 | 断言新形态；删掉假门禁断言                                                      |
| `docs/runbooks/portable-launcher-signing-ceremony.md`                 | 新建 | 生产密钥仪式：加密卷、NTFS ACL、临时目录、用后删除、不承诺擦除                  |
| `docs/portable-update-key-registry.md`                                | 新建 | 公钥与指纹台账（**模板，不含任何值**）                                          |
| `docs/runbooks/portable-update-release.md`                            | 修改 | 第 19 行纠正；新增组装/QC/残留风险引用                                          |
| `docs/superpowers/plans/2026-09-21-portable-full-directory-update.md` | 修改 | 删除 `MOFANG_UPDATE_FEED_UPLOAD_TOKEN` 条目                                     |
| `docs/status/2026-09-15-demo-bug-fix-log.md`                          | 修改 | **追加**带日期的后记，不改写历史                                                |
| `package.json`                                                        | 修改 | 新增 `check:portable-release-assembly` 并接入 `check`                           |

**禁止事项（贯穿全计划）：** 不生成任何真实生产密钥；不写入任何真实指纹、token、口令或服务器地址凭据；不构建客户候选包；不推送远端；不连接或修改服务器。

**指纹格式（已裁决，不再作为未决项）：**

- **机器线格式**：64 字符、**无分隔符**、大写 hex。
- **台账与手册**：允许按每 4 字符一组加空格**展示**。
- **比较规则**：先去掉全部空白，再按 `/^[0-9A-F]{64}$/` 严格校验；两种写法必须比中。
- 因此 `scripts/lib/launcher-receipt.mjs` 与 `scripts/lib/key-registry.mjs` 都必须通过同一个 `normalizeFingerprint()`，**不得**各自手写比较。

---

## 依赖与执行顺序

1. Task 1（PE 检查器）→ Task 2、Task 3 依赖它。
2. Task 2（回执 + `normalizeFingerprint`）→ **Task 3 的台账模块依赖 `normalizeFingerprint`**，因此 Task 3 不能早于 Task 2。
3. Task 3（台账模块 + 组装器 + 审计）→ Task 6 的文档引用了它的规则名与台账文件名，必须在其后。
4. Task 4（QC 挑战）→ Task 5 的 workflow 会调用它，必须在其后。
5. Task 5（CI）→ Task 6 之前。
6. Task 6（文档 + 台账模板）最后。

**每刀的通用纪律（与计划 1 相同，不再展开）：** 命名 RED → 按测试名失败 → 最小 GREEN → 行为级变异验证（删关键护栏 ⇒ 指定测试按名变红 ⇒ 逐字节恢复，`git diff` 为空）→ 判据含 `passed > 0` → “跳过”记“未验证” → 完整门禁 `pnpm check` → 显式 pathspec 独立提交，禁止 `git add -A`。

**测试运行方式（本计划全部为 `node:test`）：**

```bash
node --test scripts/lib/<file>.test.mjs
```

---

### Task 1: PE 结构检查器

**Files:**

- Create: `scripts/lib/portable-executable.mjs`
- Test: `scripts/lib/portable-executable.test.mjs`

PE 偏移（必须照此实现）：`e_lfanew` 在 `0x3C`（uint32 LE）；COFF 头在 `e_lfanew+4`，`Machine` 在 `e_lfanew+4`；可选头在 `e_lfanew+24`，`Magic` 在 `e_lfanew+24`，`Subsystem` 在 `e_lfanew+92`。常量：`IMAGE_FILE_MACHINE_AMD64 = 0x8664`、`PE32_PLUS = 0x20B`、`IMAGE_SUBSYSTEM_WINDOWS_GUI = 2`。

- [ ] **Step 1: 写失败的测试**

创建 `scripts/lib/portable-executable.test.mjs`：

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { PE_REQUIREMENTS, inspectPortableExecutable } from './portable-executable.mjs';

const PE_OFFSET = 0x80;

function buildPe({ machine = 0x8664, magic = 0x20b, subsystem = 2, signature = 'PE\0\0', offset = PE_OFFSET } = {}) {
  const bytes = Buffer.alloc(offset + 96);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(offset, 0x3c);
  bytes.write(signature, offset, 'ascii');
  bytes.writeUInt16LE(machine, offset + 4);
  bytes.writeUInt16LE(0x00f0, offset + 22);
  bytes.writeUInt16LE(magic, offset + 24);
  bytes.writeUInt16LE(subsystem, offset + 92);
  return bytes;
}

test('a well formed amd64 gui image satisfies every requirement', () => {
  const result = inspectPortableExecutable(buildPe());
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.satisfied, PE_REQUIREMENTS);
});

test('a file that is too short is rejected', () => {
  const result = inspectPortableExecutable(Buffer.from('MZ', 'ascii'));
  assert.ok(result.errors.length > 0);
  assert.match(result.errors.join(' '), /dos header|too short/i);
});

test('a missing MZ signature is rejected', () => {
  const bytes = buildPe();
  bytes.write('ZZ', 0, 'ascii');
  assert.match(inspectPortableExecutable(bytes).errors.join(' '), /dos signature/i);
});

test('a missing PE signature is rejected', () => {
  const bytes = buildPe({ signature: 'PX\0\0' });
  assert.match(inspectPortableExecutable(bytes).errors.join(' '), /pe signature/i);
});

test('a non amd64 machine is rejected', () => {
  const bytes = buildPe({ machine: 0x014c });
  assert.match(inspectPortableExecutable(bytes).errors.join(' '), /machine/i);
});

test('a pe32 image is rejected because the launcher must be pe32+', () => {
  const bytes = buildPe({ magic: 0x010b });
  assert.match(inspectPortableExecutable(bytes).errors.join(' '), /pe32\+/i);
});

test('a console subsystem image is rejected because the launcher must be a gui image', () => {
  const bytes = buildPe({ subsystem: 3 });
  assert.match(inspectPortableExecutable(bytes).errors.join(' '), /subsystem/i);
});

test('an out of range pe offset is rejected instead of reading past the end', () => {
  const bytes = buildPe();
  bytes.writeUInt32LE(0xfffffff0, 0x3c);
  assert.match(inspectPortableExecutable(bytes).errors.join(' '), /offset/i);
});
```

- [ ] **Step 2: 运行测试并确认按测试名失败**

```bash
node --test scripts/lib/portable-executable.test.mjs
```

预期：失败并报无法解析 `./portable-executable.mjs`。

- [ ] **Step 3: 写最小实现**

创建 `scripts/lib/portable-executable.mjs`：

```js
const DOS_SIGNATURE = 'MZ';
const PE_SIGNATURE = 'PE\0\0';
const PE_OFFSET_POSITION = 0x3c;
const COFF_HEADER_SIZE = 20;
const MACHINE_AMD64 = 0x8664;
const PE32_PLUS_MAGIC = 0x20b;
const SUBSYSTEM_WINDOWS_GUI = 2;
const MINIMUM_LENGTH = 0x40 + 4;

export const PE_REQUIREMENTS = ['dos-signature', 'pe-signature', 'machine-amd64', 'pe32-plus', 'subsystem-gui'];

export function inspectPortableExecutable(bytes) {
  const errors = [];
  const satisfied = [];
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);

  if (buffer.length < MINIMUM_LENGTH) {
    return { errors: ['the dos header is too short to be a portable executable'], satisfied };
  }
  if (buffer.subarray(0, 2).toString('ascii') !== DOS_SIGNATURE) {
    errors.push('the dos signature is not MZ');
  } else {
    satisfied.push('dos-signature');
  }

  const peOffset = buffer.readUInt32LE(PE_OFFSET_POSITION);
  if (peOffset < MINIMUM_LENGTH || peOffset + COFF_HEADER_SIZE + 96 > buffer.length) {
    errors.push(`the pe offset ${peOffset} is outside the file`);
    return { errors, satisfied };
  }

  if (buffer.subarray(peOffset, peOffset + 4).toString('ascii') !== PE_SIGNATURE) {
    errors.push('the pe signature is missing');
  } else {
    satisfied.push('pe-signature');
  }

  if (buffer.readUInt16LE(peOffset + 4) !== MACHINE_AMD64) {
    errors.push('the machine type is not amd64');
  } else {
    satisfied.push('machine-amd64');
  }

  if (buffer.readUInt16LE(peOffset + 24) !== PE32_PLUS_MAGIC) {
    errors.push('the optional header is not pe32+');
  } else {
    satisfied.push('pe32-plus');
  }

  if (buffer.readUInt16LE(peOffset + 92) !== SUBSYSTEM_WINDOWS_GUI) {
    errors.push('the subsystem is not the windows gui subsystem');
  } else {
    satisfied.push('subsystem-gui');
  }

  return { errors, satisfied };
}
```

- [ ] **Step 4: 运行测试并确认通过**

```bash
node --test scripts/lib/portable-executable.test.mjs
```

预期：`pass 8`、`fail 0`。

- [ ] **Step 5: 行为级变异验证**

1. 把 `peOffset + COFF_HEADER_SIZE + 96 > buffer.length` 边界判断删掉 ⇒ 预期 `an out of range pe offset is rejected instead of reading past the end` **按测试名变红**。
2. 把 `MACHINE_AMD64` 改成 `0x014c` ⇒ 预期 `a non amd64 machine is rejected` 与 `a well formed amd64 gui image satisfies every requirement` **按测试名变红**。
3. 把 `SUBSYSTEM_WINDOWS_GUI` 改成 `3` ⇒ 预期 `a console subsystem image is rejected because the launcher must be a gui image` **按测试名变红**。

恢复后 `git diff` 为空且全绿。

- [ ] **Step 6: 提交**

```bash
git add scripts/lib/portable-executable.mjs scripts/lib/portable-executable.test.mjs
git commit -m "feat(release): inspect the launcher portable executable structure"
```

---

### Task 2: 启动器构建回执

**Files:**

- Create: `scripts/lib/launcher-receipt.mjs`
- Test: `scripts/lib/launcher-receipt.test.mjs`
- Modify: `scripts/lib/portable-launcher-build.mjs`
- Modify: `scripts/build-portable-launcher.mjs`
- Modify: `scripts/lib/portable-launcher-build.test.mjs`

回执字段（规格 §5.3）：`receiptVersion`、`launcherVersion`、`commit`、`commitDirty`、`embeddedKeysBase64`、`embeddedKeyFingerprints`、`exeSha256`、`exeSize`、`outDir`、`builtAt`、`toolchain{go,node,pnpm,os}`、`trust: 'self-declared'`。**不含** `signingKeyFingerprint`。

- [ ] **Step 1: 写失败的测试**

创建 `scripts/lib/launcher-receipt.test.mjs`：

```js
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { LauncherReceiptError, buildReceipt, checkReceipt, parseReceipt } from './launcher-receipt.mjs';

const EXE = Buffer.from('MZ-launcher-bytes', 'utf8');
const EXE_SHA256 = createHash('sha256').update(EXE).digest('hex');
const PUBLIC_KEY = 'cHVibGljLWtleS1maXh0dXJl';
const FINGERPRINT = 'A'.repeat(64);
const NOW = Date.parse('2026-09-22T10:00:00.000Z');

function makeReceipt(overrides = {}) {
  return buildReceipt({
    launcherVersion: '1.2.3',
    commit: 'a'.repeat(40),
    commitDirty: false,
    embeddedKeysBase64: [PUBLIC_KEY],
    exeSha256: EXE_SHA256,
    exeSize: EXE.length,
    outDir: 'C:/build/out',
    builtAt: '2026-09-22T09:00:00.000Z',
    toolchain: { go: 'go1.25.0', node: process.version, pnpm: '10.0.0', os: process.platform },
    ...overrides,
  });
}

function check(overrides = {}, options = {}) {
  return checkReceipt({
    receipt: makeReceipt(overrides),
    exeSha256: EXE_SHA256,
    exeSize: EXE.length,
    expectedFingerprints: [FINGERPRINT],
    now: NOW,
    maxAgeMs: 7 * 24 * 60 * 60 * 1000,
    ...options,
  });
}

test('a matching receipt passes with no errors and no warnings', () => {
  const result = check();
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('a mismatched executable hash is a hard error', () => {
  const result = check({ exeSha256: 'b'.repeat(64) });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /hash/i);
});

test('a mismatched executable size is a hard error', () => {
  const result = check({ exeSize: EXE.length + 1 });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /size/i);
});

test('a dirty working tree is a hard error', () => {
  const result = check({ commitDirty: true });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /uncommitted/i);
});

test('an unexpected fingerprint set is a hard error', () => {
  const result = check({ embeddedKeyFingerprints: ['C'.repeat(64)] });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /fingerprint/i);
});

test('a stale receipt is only a warning', () => {
  const result = check({ builtAt: '2026-08-01T00:00:00.000Z' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /stale/i);
});

test('a receipt from the future is only a warning', () => {
  const result = check({ builtAt: '2026-12-01T00:00:00.000Z' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /future/i);
});

test('a different output directory is only a warning', () => {
  const result = checkReceipt({
    receipt: makeReceipt(),
    exeSha256: EXE_SHA256,
    exeSize: EXE.length,
    expectedFingerprints: [FINGERPRINT],
    outDir: 'D:/elsewhere/out',
    now: NOW,
    maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /output directory/i);
});

test('an unknown receipt field is rejected when parsing', () => {
  const text = JSON.stringify({ ...makeReceipt(), signingKeyFingerprint: 'deadbeef' });
  assert.throws(() => parseReceipt(text), LauncherReceiptError);
});

test('a receipt without the self declared trust marker is rejected when parsing', () => {
  const text = JSON.stringify({ ...makeReceipt(), trust: 'trusted-source-proof' });
  assert.throws(() => parseReceipt(text), LauncherReceiptError);
});

test('a receipt missing a required field is rejected when parsing', () => {
  const receipt = makeReceipt();
  delete receipt.exeSize;
  assert.throws(() => parseReceipt(JSON.stringify(receipt)), LauncherReceiptError);
});

test('the builder stamps the self declared trust marker and never a signing key', () => {
  const receipt = makeReceipt();
  assert.equal(receipt.trust, 'self-declared');
  assert.equal(receipt.receiptVersion, 1);
  assert.equal(Object.hasOwn(receipt, 'signingKeyFingerprint'), false);
});

test('a fingerprint is normalised to 64 uppercase hex characters without separators', () => {
  const grouped = 'AAAA BBBB CCCC DDDD EEEE FFFF 0000 1111 2222 3333 4444 5555 6666 7777 8888 9999';
  assert.equal(normalizeFingerprint(grouped), 'AAAABBBBCCCCDDDDEEEEFFFF0000111122223333444455556666777788889999');
  assert.equal(normalizeFingerprint(''), null);
  assert.equal(normalizeFingerprint('Z'.repeat(64)), null);
  assert.equal(normalizeFingerprint('A'.repeat(63)), null);
  assert.equal(normalizeFingerprint(undefined), null);
});

test('a grouped ledger fingerprint compares equal to the compact wire format', () => {
  const compact = 'A'.repeat(64);
  const grouped = `${'A'.repeat(4)} `.repeat(15) + 'AAAA';
  const result = checkReceipt({
    receipt: makeReceipt({ embeddedKeyFingerprints: [compact] }),
    exeSha256: EXE_SHA256,
    exeSize: EXE.length,
    expectedFingerprints: [grouped],
    now: NOW,
    maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  });
  assert.deepEqual(result.errors, []);
});

test('a fingerprint that is not strict uppercase hex is a hard error', () => {
  const result = checkReceipt({
    receipt: makeReceipt({ embeddedKeyFingerprints: ['abc'] }),
    exeSha256: EXE_SHA256,
    exeSize: EXE.length,
    expectedFingerprints: ['abc'],
    now: NOW,
    maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /fingerprint/i);
});
```

- [ ] **Step 2: 运行测试并确认按测试名失败**

```bash
node --test scripts/lib/launcher-receipt.test.mjs
```

预期：无法解析 `./launcher-receipt.mjs`。

- [ ] **Step 3: 写最小实现**

创建 `scripts/lib/launcher-receipt.mjs`：

```js
const RECEIPT_VERSION = 1;
const TRUST_MARKER = 'self-declared';
const REQUIRED_FIELDS = [
  'receiptVersion',
  'launcherVersion',
  'commit',
  'commitDirty',
  'embeddedKeysBase64',
  'embeddedKeyFingerprints',
  'exeSha256',
  'exeSize',
  'outDir',
  'builtAt',
  'toolchain',
  'trust',
];

export class LauncherReceiptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LauncherReceiptError';
  }
}

export function buildReceipt(input) {
  return {
    receiptVersion: RECEIPT_VERSION,
    launcherVersion: input.launcherVersion,
    commit: input.commit,
    commitDirty: input.commitDirty,
    embeddedKeysBase64: [...input.embeddedKeysBase64],
    embeddedKeyFingerprints: [...input.embeddedKeyFingerprints],
    exeSha256: input.exeSha256,
    exeSize: input.exeSize,
    outDir: input.outDir,
    builtAt: input.builtAt,
    toolchain: { ...input.toolchain },
    trust: TRUST_MARKER,
  };
}

export function parseReceipt(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new LauncherReceiptError('the launcher build receipt is not valid JSON');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new LauncherReceiptError('the launcher build receipt is not an object');
  }
  for (const field of Object.keys(payload)) {
    if (!REQUIRED_FIELDS.includes(field)) {
      throw new LauncherReceiptError(`the launcher build receipt carries the unknown field ${field}`);
    }
  }
  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(payload, field)) {
      throw new LauncherReceiptError(`the launcher build receipt is missing ${field}`);
    }
  }
  if (payload.receiptVersion !== RECEIPT_VERSION) {
    throw new LauncherReceiptError(`unsupported launcher build receipt version ${payload.receiptVersion}`);
  }
  if (payload.trust !== TRUST_MARKER) {
    throw new LauncherReceiptError(
      'the launcher build receipt must declare itself self-declared, not a trusted source proof',
    );
  }
  if (!Array.isArray(payload.embeddedKeysBase64) || !Array.isArray(payload.embeddedKeyFingerprints)) {
    throw new LauncherReceiptError('the launcher build receipt must list the embedded keys as arrays');
  }
  if (!Number.isInteger(payload.exeSize) || payload.exeSize < 0) {
    throw new LauncherReceiptError('the launcher build receipt carries an unusable executable size');
  }
  return payload;
}

export function normalizeFingerprint(value) {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/\s+/gu, '').toUpperCase();
  return /^[0-9A-F]{64}$/u.test(compact) ? compact : null;
}

function canonicalFingerprints(values) {
  const normalised = [];
  for (const value of values) {
    const compact = normalizeFingerprint(value);
    if (compact === null) return null;
    normalised.push(compact);
  }
  return [...normalised].sort().join(',');
}

export function checkReceipt(input) {
  const errors = [];
  const warnings = [];
  const receipt = input.receipt;

  if (receipt.exeSha256 !== input.exeSha256) {
    errors.push('the launcher executable hash does not match the build receipt');
  }
  if (receipt.exeSize !== input.exeSize) {
    errors.push('the launcher executable size does not match the build receipt');
  }
  if (receipt.commitDirty === true) {
    errors.push('the build receipt was produced from a working tree with uncommitted changes');
  }
  const embedded = canonicalFingerprints(receipt.embeddedKeyFingerprints);
  const expected = canonicalFingerprints(input.expectedFingerprints);
  if (embedded === null || expected === null) {
    errors.push('a key fingerprint is not 64 uppercase hex characters');
  } else if (embedded !== expected) {
    errors.push('the embedded key fingerprints do not match the registered keys for this launcher version');
  }

  const builtAt = Date.parse(receipt.builtAt);
  if (Number.isNaN(builtAt)) {
    errors.push('the build receipt carries an unusable timestamp');
  } else if (builtAt > input.now) {
    warnings.push('the build receipt is dated in the future');
  } else if (input.now - builtAt > input.maxAgeMs) {
    warnings.push('the build receipt is stale');
  }

  if (typeof input.outDir === 'string' && receipt.outDir !== input.outDir) {
    warnings.push('the build receipt was produced in a different output directory');
  }

  return { errors, warnings };
}
```

- [ ] **Step 4: 运行测试并确认通过**

```bash
node --test scripts/lib/launcher-receipt.test.mjs
```

预期：`pass 12`、`fail 0`。

- [ ] **Step 5: 写失败的测试（构建侧接线）**

追加到 `scripts/lib/portable-launcher-build.test.mjs`：

```js
test('the build writer refuses a non empty output directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mofang-launcher-out-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'occupied.txt'), 'x', 'utf8');

  assert.throws(
    () =>
      buildPortableLauncher({
        env: { MOFANG_LAUNCHER_VERSION: '1.2.3', MOFANG_UPDATE_PUBLIC_KEY_B64: PUBLIC_KEY },
        outputPath: path.join(root, 'launcher.exe'),
        runner: () => ({ status: 0, stdout: '', stderr: '' }),
      }),
    /non-empty/i,
  );
});

test('the receipt records the version, the fingerprint and the executable digest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mofang-launcher-receipt-'));
  roots.push(root);
  const outputPath = path.join(root, launcherOutputName);
  const receiptPath = path.join(root, 'launcher-build-receipt.json');
  const bytes = peBytes();

  const result = buildPortableLauncher({
    env: { MOFANG_LAUNCHER_VERSION: '1.2.3', MOFANG_UPDATE_PUBLIC_KEY_B64: PUBLIC_KEY },
    outputPath,
    receiptPath,
    runner: () => ({ status: 0, stdout: '', stderr: '' }),
    writeBinary: (target) => fs.writeFileSync(target, bytes),
    readCommit: () => ({ commit: 'a'.repeat(40), commitDirty: false }),
    now: () => new Date('2026-09-22T09:00:00.000Z'),
  });

  assert.equal(result.receiptPath, receiptPath);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.launcherVersion, '1.2.3');
  assert.equal(receipt.trust, 'self-declared');
  assert.equal(receipt.exeSize, bytes.length);
  assert.match(receipt.exeSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(receipt.embeddedKeysBase64, [PUBLIC_KEY]);
  assert.equal(receipt.embeddedKeyFingerprints.length, 1);
  assert.equal(receipt.commitDirty, false);
  assert.equal(Object.hasOwn(receipt, 'signingKeyFingerprint'), false);
});

test('a build without an explicit output directory produces no receipt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mofang-launcher-dev-'));
  roots.push(root);
  const result = buildPortableLauncher({
    env: { MOFANG_LAUNCHER_VERSION: '1.2.3', MOFANG_UPDATE_PUBLIC_KEY_B64: PUBLIC_KEY },
    outputPath: path.join(root, 'launcher.exe'),
    runner: () => ({ status: 0, stdout: '', stderr: '' }),
    writeBinary: (target) => fs.writeFileSync(target, peBytes()),
  });
  assert.equal(result.receiptPath, null);
});
```

**命名对齐（必须先执行）：** 上面的 `roots`、`peBytes`、`PUBLIC_KEY`、`fs`、`path`、`os`、`buildPortableLauncher`、`launcherOutputName` 都取自该文件既有内容。先运行：

```bash
grep -n "^import\|^const roots\|function peBytes\|const PUBLIC_KEY\|function peBytes\|buildPortableLauncher(" scripts/lib/portable-launcher-build.test.mjs | head -30
```

用打印出的真实名字与导入形式替换；若该文件用的是 `node:fs` 的命名导入而非 `fs` 命名空间，按它的写法调整访问方式，断言不变。

- [ ] **Step 6: 运行测试并确认按测试名失败**

```bash
node --test scripts/lib/portable-launcher-build.test.mjs
```

预期：新增 3 个用例失败，其中至少一个报 `receiptPath` 相关或“非空输出目录未被拒绝”。

- [ ] **Step 7: 写最小实现（构建侧）**

修改 `scripts/lib/portable-launcher-build.mjs`：

(a) 导入 PE 检查器与回执模块：

```js
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { inspectPortableExecutable } from './portable-executable.mjs';
import { buildReceipt } from './launcher-receipt.mjs';
```

(b) 把模块私有 `isPortableExecutable` 换成基于检查器的判断，并让失败信息带上具体原因：

```js
function assertPortableExecutable(path) {
  const bytes = readFileSync(path);
  const inspection = inspectPortableExecutable(bytes);
  if (inspection.errors.length > 0) {
    throw new PortableLauncherBuildError(
      `the launcher output is not a Windows PE image: ${inspection.errors.join('; ')}`,
    );
  }
  return bytes;
}
```

(c) `buildPortableLauncher` 增加参数并产出回执：

```js
export function buildPortableLauncher({
  env,
  outputPath = defaultLauncherOutput,
  receiptPath = null,
  runner = spawnSync,
  goBinary = 'go',
  log = () => {},
  writeBinary = null,
  readCommit = null,
  now = () => new Date(),
}) {
```

在写出二进制之后（原 `:95-107` 的检查段）改为：

```js
  const bytes = assertPortableExecutable(outputPath);
  const size = statSync(outputPath).size;
  log(`portable launcher written to ${outputPath} (${size} bytes)`);

  if (receiptPath === null) {
    return { outputPath, size, receiptPath: null };
  }

  const commit = readCommit === null ? readRepositoryCommit() : readCommit();
  const digest = createHash('sha256').update(bytes).digest('hex');
  const derived = publicKeyFingerprint(publicKeyBase64);
  const receipt = buildReceipt({
    launcherVersion: version,
    commit: commit.commit,
    commitDirty: commit.commitDirty,
    embeddedKeysBase64: [publicKeyBase64],
    embeddedKeyFingerprints: derived === null ? [] : [derived],
    exeSha256: digest,
    exeSize: size,
    outDir: dirname(outputPath),
    builtAt: now().toISOString(),
    toolchain: {
      go: toolchainVersion(runner, goBinary),
      node: process.version,
      pnpm: 'unknown',
      os: process.platform,
    },
  });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', encoding: 'utf8' });
  return { outputPath, size, receiptPath };
}
```

`writeBinary` 参数用于让测试注入字节（生产路径为 `null`，此时构建仍由 Go 工具链实际产出文件）；若实现后发现注入路径与真实构建冲突，改为**只在 `writeBinary !== null` 时用它落盘**，其余不变。

同文件新增三个私有辅助：

```js
function publicKeyFingerprint(publicKeyBase64) {
  try {
    const der = Buffer.from(publicKeyBase64, 'base64');
    return createHash('sha256').update(der).digest('hex').toUpperCase();
  } catch {
    return null;
  }
}

function readRepositoryCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' });
  const commit = result.status === 0 ? String(result.stdout).trim() : '';
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: repositoryRoot, encoding: 'utf8' });
  const commitDirty = status.status !== 0 || String(status.stdout).trim().length > 0;
  return { commit, commitDirty };
}

function toolchainVersion(runner, goBinary) {
  const result = runner(goBinary, ['version'], { cwd: repositoryRoot, stdio: 'pipe', encoding: 'utf8' });
  if (result?.status !== 0) return 'unknown';
  return String(result.stdout ?? '').trim();
}
```

并在写出前加**空目录检查**（回执与 EXE 所在目录非空则拒绝，除非只有本次已写出的 EXE）：

```js
if (receiptPath !== null) {
  const entries = readdirSync(dirname(outputPath));
  const unexpected = entries.filter((entry) => entry !== basename(outputPath));
  if (unexpected.length > 0) {
    throw new PortableLauncherBuildError(
      `refusing to build into a non-empty output directory: ${unexpected.join(', ')}`,
    );
  }
}
```

（在 `readFileSync` 等导入里补 `readdirSync`，并补 `basename, dirname` 的 `node:path` 导入。）

- [ ] **Step 8: 修改 CLI**

`scripts/build-portable-launcher.mjs`：

```js
import { dirname, join, resolve } from 'node:path';
import { PortableLauncherBuildError, buildPortableLauncher } from './lib/portable-launcher-build.mjs';

function parseArguments(argv) {
  const index = argv.indexOf('--out');
  if (index < 0) return { outDir: null };
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error('--out requires a directory');
  return { outDir: resolve(value) };
}

try {
  const input = parseArguments(process.argv.slice(2));
  const outputPath = input.outDir === null ? undefined : join(input.outDir, LAUNCHER_NAME_PLACEHOLDER);
  const result = buildPortableLauncher({
    env: process.env,
    ...(outputPath === undefined ? {} : { outputPath }),
    ...(input.outDir === null ? {} : { receiptPath: join(input.outDir, 'launcher-build-receipt.json') }),
    log: (message) => console.log(message),
  });
  if (result.receiptPath === null) {
    console.warn('WARNING: dev build without a receipt. Release builds must pass --out.');
  }
  console.log(`portable launcher ready: ${result.size} bytes`);
} catch (error) {
  console.error(error instanceof PortableLauncherBuildError ? error.message : error);
  process.exit(1);
}
```

把 `LAUNCHER_NAME_PLACEHOLDER` 替换为从 `./lib/portable-launcher-build.mjs` 导入的 `launcherOutputName`。

- [ ] **Step 9: 运行测试并确认通过**

```bash
node --test scripts/lib/portable-launcher-build.test.mjs
```

预期：`fail 0`，`pass` 计数 ≥ 既有 13 + 3。

- [ ] **Step 10: 行为级变异验证**

1. 把回执里的 `trust: TRUST_MARKER` 改成 `'trusted-source-proof'` ⇒ 预期 `a receipt without the self declared trust marker is rejected when parsing` 与 `the builder stamps the self declared trust marker and never a signing key` **按测试名变红**。
2. 把 `checkReceipt` 里 `receipt.commitDirty === true` 那条错误降级为 `warnings.push` ⇒ 预期 `a dirty working tree is a hard error` **按测试名变红**。
3. 把 `exeSize` 的比较删掉 ⇒ 预期 `a mismatched executable size is a hard error` **按测试名变红**。
4. 把 `expectedFingerprints` 的比较改成永远 `false` ⇒ 预期 `an unexpected fingerprint set is a hard error` **按测试名变红**。

每处变异后运行 `node --test scripts/lib/launcher-receipt.test.mjs` 与 `node --test scripts/lib/portable-launcher-build.test.mjs`，判据：出现对应测试名 + `fail`。恢复后全绿且 `git diff` 为空。

- [ ] **Step 11: 提交**

```bash
git add scripts/lib/launcher-receipt.mjs scripts/lib/launcher-receipt.test.mjs scripts/lib/portable-launcher-build.mjs scripts/lib/portable-launcher-build.test.mjs scripts/build-portable-launcher.mjs
git commit -m "feat(release): record what each launcher build actually produced"
```

---

### Task 3: 组装器与交付审计的硬拒绝 / 警告分级（**台账驱动**）

**Files:**

- Create: `scripts/lib/key-registry.mjs`
- Create: `scripts/lib/key-registry.test.mjs`
- Create: `docs/portable-update-key-registry.json`
- Modify: `scripts/assemble-udisk-delivery.mjs`
- Modify: `scripts/lib/udisk-delivery.mjs`
- Modify: `scripts/udisk-delivery.mjs`
- Modify: `scripts/lib/udisk-delivery.test.mjs`

**硬约束（规格 §5.4，不得降级）：** `embeddedKeyFingerprints` 与该启动器版本在密钥台账里登记的集合不一致时**必须硬拒绝**。因此**正式**组装与**正式**交付审计都**必须**提供 `--key-registry`；台账缺失、不可解析、该版本无登记、指纹不一致——**四类全部硬失败**。**不得**默认"没有台账就跳过检查"。

**唯一的旁路是显式的 test-only 模式**：`--test-only`。它必须同时满足

1. 输出目录的**目录名**以 `_TEST-ONLY-` 开头（否则硬失败）；
2. 审计记录一条 `warn` 级 `launcher-key-registry-bypassed`；
3. 控制台打印一行醒目的"本制品不可发布"警告。

这样开发夹具能跑，而生产绕过没有入口——因为一份名叫 `_TEST-ONLY-…` 的交付包不可能被当成正式包发出去。

#### 前置：密钥台账模块（Step 0.1 – 0.3）

- [ ] **Step 0.1: 写失败的测试**

创建 `scripts/lib/key-registry.test.mjs`：

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { KeyRegistryError, fingerprintsForVersion, parseKeyRegistry } from './key-registry.mjs';

const COMPACT = 'A'.repeat(64);
const GROUPED = `${'A'.repeat(4)} `.repeat(15) + 'AAAA';

function registryText(keys) {
  return JSON.stringify({ schemaVersion: 1, keys });
}

test('an empty registry parses but registers nothing', () => {
  const registry = parseKeyRegistry(registryText([]));
  assert.deepEqual(registry.keys, []);
  assert.equal(fingerprintsForVersion(registry, '1.2.3'), null);
});

test('a registry entry is found by its launcher version range', () => {
  const registry = parseKeyRegistry(
    registryText([
      { keyId: 'k1', fingerprint: COMPACT, publicKeyBase64: 'abc', status: 'active', minLauncherVersion: '1.0.0' },
    ]),
  );
  assert.deepEqual(fingerprintsForVersion(registry, '1.2.3'), [COMPACT]);
  assert.equal(fingerprintsForVersion(registry, '0.9.0'), null);
});

test('a grouped fingerprint is normalised so the ledger may use 4 character groups', () => {
  const registry = parseKeyRegistry(
    registryText([
      { keyId: 'k1', fingerprint: GROUPED, publicKeyBase64: 'abc', status: 'active', minLauncherVersion: '1.0.0' },
    ]),
  );
  assert.deepEqual(fingerprintsForVersion(registry, '1.2.3'), [COMPACT]);
});

test('an unusable fingerprint is rejected when parsing', () => {
  assert.throws(
    () =>
      parseKeyRegistry(
        registryText([
          { keyId: 'k1', fingerprint: 'nope', publicKeyBase64: 'abc', status: 'active', minLauncherVersion: '1.0.0' },
        ]),
      ),
    KeyRegistryError,
  );
});

test('a retired key is never returned for a new release', () => {
  const registry = parseKeyRegistry(
    registryText([
      { keyId: 'k1', fingerprint: COMPACT, publicKeyBase64: 'abc', status: 'retired', minLauncherVersion: '1.0.0' },
    ]),
  );
  assert.equal(fingerprintsForVersion(registry, '1.2.3'), null);
});

test('a malformed registry is rejected', () => {
  for (const text of ['not json', '{}', '{"schemaVersion":2,"keys":[]}', '{"schemaVersion":1,"keys":{}}']) {
    assert.throws(() => parseKeyRegistry(text), KeyRegistryError);
  }
});

test('an unknown field in the registry is rejected', () => {
  assert.throws(() => parseKeyRegistry(JSON.stringify({ schemaVersion: 1, keys: [], extra: true })), KeyRegistryError);
});
```

- [ ] **Step 0.2: 运行测试并确认按测试名失败**

```bash
node --test scripts/lib/key-registry.test.mjs
```

预期：无法解析 `./key-registry.mjs`。

- [ ] **Step 0.3: 写最小实现**

创建 `scripts/lib/key-registry.mjs`：

```js
import { normalizeFingerprint } from './launcher-receipt.mjs';

const REGISTRY_VERSION = 1;
const STATUSES = Object.freeze(['active', 'retired']);
const REGISTRY_FIELDS = ['schemaVersion', 'keys'];
const KEY_FIELDS = ['keyId', 'fingerprint', 'publicKeyBase64', 'status', 'minLauncherVersion'];

export class KeyRegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KeyRegistryError';
  }
}

function assertOnlyFields(record, allowed, label) {
  for (const field of Object.keys(record)) {
    if (!allowed.includes(field)) throw new KeyRegistryError(`${label} carries the unknown field ${field}`);
  }
}

export function parseKeyRegistry(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new KeyRegistryError('the key registry is not valid JSON');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new KeyRegistryError('the key registry is not an object');
  }
  assertOnlyFields(payload, REGISTRY_FIELDS, 'the key registry');
  if (payload.schemaVersion !== REGISTRY_VERSION) {
    throw new KeyRegistryError(`unsupported key registry version ${payload.schemaVersion}`);
  }
  if (!Array.isArray(payload.keys)) {
    throw new KeyRegistryError('the key registry must carry a keys array');
  }
  const keys = [];
  for (const entry of payload.keys) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new KeyRegistryError('a key registry entry is not an object');
    }
    assertOnlyFields(entry, KEY_FIELDS, 'a key registry entry');
    for (const field of KEY_FIELDS) {
      if (!Object.hasOwn(entry, field)) throw new KeyRegistryError(`a key registry entry is missing ${field}`);
    }
    const fingerprint = normalizeFingerprint(entry.fingerprint);
    if (fingerprint === null) {
      throw new KeyRegistryError('a key registry entry does not carry 64 uppercase hex characters as its fingerprint');
    }
    if (!STATUSES.includes(entry.status)) {
      throw new KeyRegistryError(`a key registry entry uses the unknown status ${entry.status}`);
    }
    keys.push({
      keyId: entry.keyId,
      fingerprint,
      publicKeyBase64: entry.publicKeyBase64,
      status: entry.status,
      minLauncherVersion: entry.minLauncherVersion,
    });
  }
  return { schemaVersion: REGISTRY_VERSION, keys };
}

export function fingerprintsForVersion(registry, launcherVersion) {
  const match = registry.keys.filter(
    (entry) => entry.status === 'active' && entry.minLauncherVersion === launcherVersion,
  );
  if (match.length === 0) return null;
  return match.map((entry) => entry.fingerprint);
}
```

**说明：** `fingerprintsForVersion` 按"该启动器版本"精确匹配 `minLauncherVersion`，因为回执里的 `launcherVersion` 就是构建启动器时用的版本。若实际登记需要区间语义，先在 Step 0.1 里把测试改成区间用例再改实现——**不要**两边不一致。

- [ ] **Step 0.4: 运行测试并确认通过**

```bash
node --test scripts/lib/key-registry.test.mjs
```

预期：`fail 0`、`pass 7`。

- [ ] **Step 0.5: 行为级变异验证**

1. 把 `entry.status === 'active'` 过滤删掉 ⇒ 预期 `a retired key is never returned for a new release` **按测试名变红**。
2. 把 `normalizeFingerprint(entry.fingerprint)` 换成直接用 `entry.fingerprint` ⇒ 预期 `an unusable fingerprint is rejected when parsing` 与 `a grouped fingerprint is normalised so the ledger may use 4 character groups` **按测试名变红**。
3. 把 `assertOnlyFields(payload, ...)` 调用删掉 ⇒ 预期 `an unknown field in the registry is rejected` **按测试名变红**。

恢复后 `git diff` 为空且全绿。

- [ ] **Step 0.6: 提交**

```bash
git add scripts/lib/key-registry.mjs scripts/lib/key-registry.test.mjs
git commit -m "feat(release): read the registered keys from the machine readable registry"
```

- [ ] **Step 1: 写失败的测试**

追加到 `scripts/lib/udisk-delivery.test.mjs`：

```js
test('a launcher that is too small is a release-blocking error', () => {
  const root = makeDelivery({ launcherBytes: Buffer.from('MZ', 'ascii') });
  const findings = auditDelivery(io, root);
  assert.ok(ids(findings).includes('launcher-too-small'));
});

test('a launcher without a pe structure is a release-blocking error', () => {
  const root = makeDelivery({ launcherBytes: Buffer.from('MZnot-a-pe-file', 'ascii') });
  const findings = auditDelivery(io, root);
  assert.ok(ids(findings).includes('launcher-pe-invalid'));
});

test('a launcher missing the registered public key is a release-blocking error', () => {
  const root = makeDelivery({ launcherBytes: makePeBytes(), launcherText: 'no keys here' });
  const findings = auditDelivery(io, root, {
    expectedPublicKeyBase64: 'cHVibGljLWtleS1maXh0dXJl',
    knownPublicKeysBase64: [],
  });
  assert.ok(ids(findings).includes('launcher-key-mismatch'));
});

test('a launcher carrying another registered public key is a release-blocking error', () => {
  const root = makeDelivery({ launcherBytes: makePeBytes(), launcherText: 'other=cHVibGljLWtleS1vdGhlcg==' });
  const findings = auditDelivery(io, root, {
    expectedPublicKeyBase64: 'cHVibGljLWtleS1maXh0dXJl',
    knownPublicKeysBase64: ['cHVibGljLWtleS1vdGhlcg=='],
  });
  assert.ok(ids(findings).includes('launcher-key-mismatch'));
});

test('a launcher that satisfies every rule produces no launcher findings', () => {
  const root = makeDelivery({ launcherBytes: makePeBytes(), launcherText: 'key=cHVibGljLWtleS1maXh0dXJl' });
  const findings = auditDelivery(io, root, {
    expectedPublicKeyBase64: 'cHVibGljLWtleS1maXh0dXJl',
    knownPublicKeysBase64: [],
  });
  const launcherFindings = ids(findings).filter((id) => id.startsWith('launcher-'));
  assert.deepEqual(launcherFindings, []);
});

test('warnings do not make the delivery fail', () => {
  const root = makeDelivery({ launcherBytes: makePeBytes(), launcherText: 'key=cHVibGljLWtleS1maXh0dXJl' });
  const findings = auditDelivery(io, root, {
    expectedPublicKeyBase64: 'cHVibGljLWtleS1maXh0dXJl',
    knownPublicKeysBase64: [],
    receiptWarnings: ['the build receipt is stale'],
  });
  const errors = findings.filter((finding) => finding.level === 'error');
  const warnings = findings.filter((finding) => finding.level === 'warn');
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].detail, /stale/i);
});
```

**命名对齐（必须先执行）：** 上面的 `makeDelivery({ launcherBytes, launcherText })`、`makePeBytes()`、`io` 是该文件既有夹具的**扩展**。先运行：

```bash
sed -n '1,80p' scripts/lib/udisk-delivery.test.mjs
```

按打印出的真实夹具（它有 `makeDelivery(overrides)` 与 `write(relativePath, content)`）扩展出 `launcherBytes` 与 `launcherText` 两个开关；`makePeBytes()` 用 Task 1 的 PE 构造方式生成一个最小的合法 AMD64/GUI 镜像。断言与规则名不变。

- [ ] **Step 2: 运行测试并确认按测试名失败**

```bash
node --test scripts/lib/udisk-delivery.test.mjs
```

预期：新增的 6 个用例失败，报 `launcher-too-small` 等 id 不存在。

- [ ] **Step 3: 写最小实现（审计库）**

修改 `scripts/lib/udisk-delivery.mjs`：

(a) 在 `finding()` 之后新增警告层，使 `warn` 真正可达：

```js
function warning(id, title, detail) {
  return { id, level: 'warn', title, detail };
}
```

(b) 导入 PE 检查器：

```js
import { inspectPortableExecutable } from './portable-executable.mjs';
```

(c) `auditDelivery` 签名扩为三参，并在启动器检查处加入四条规则：

```js
export async function auditDelivery(io, root, options = {}) {
```

在既有的 `missing-launcher` 检查之后、且**仅当启动器存在**时插入：

```js
if (launcherPresent) {
  const bytes = typeof io.readBinary === 'function' ? await io.readBinary(path.join(root, LAUNCHER_EXE_NAME)) : null;
  if (bytes === null || bytes === undefined) {
    findings.push(
      finding(
        'launcher-unreadable',
        `Unreadable ${LAUNCHER_EXE_NAME}`,
        'The root launcher could not be read as bytes.',
      ),
    );
  } else {
    if (bytes.length < MINIMUM_LAUNCHER_BYTES) {
      findings.push(
        finding(
          'launcher-too-small',
          `Suspiciously small ${LAUNCHER_EXE_NAME}`,
          `The launcher is ${bytes.length} bytes; a release launcher is at least ${MINIMUM_LAUNCHER_BYTES}.`,
        ),
      );
    }
    const inspection = inspectPortableExecutable(bytes);
    if (inspection.errors.length > 0) {
      findings.push(finding('launcher-pe-invalid', `Invalid ${LAUNCHER_EXE_NAME}`, inspection.errors.join('; ')));
    }
    const expected = options.expectedPublicKeyBase64;
    if (typeof expected === 'string' && expected.length > 0) {
      if (!bufferHasString(bytes, expected)) {
        findings.push(
          finding(
            'launcher-key-mismatch',
            'Launcher does not embed the expected public key',
            'The bytes of the launcher do not contain the registered update public key.',
          ),
        );
      }
      for (const other of options.knownPublicKeysBase64 ?? []) {
        if (other === expected) continue;
        if (bufferHasString(bytes, other)) {
          findings.push(
            finding(
              'launcher-key-mismatch',
              'Launcher embeds another registered public key',
              'The bytes of the launcher contain a different registered update public key.',
            ),
          );
        }
      }
    }
  }
}

for (const message of options.receiptWarnings ?? []) {
  findings.push(warning('launcher-receipt-warning', 'Launcher build receipt warning', message));
}
```

同文件顶部新增常量：

```js
export const MINIMUM_LAUNCHER_BYTES = 64 * 1024;
```

并在 `scripts/udisk-delivery.mjs` 的 IO 适配器里补：

```js
  readBinary: (target) => {
    try {
      return fs.readFileSync(target);
    } catch {
      return null;
    }
  },
```

并对 CLI 增加 `--receipt <path>`：读取回执 → `parseReceipt` → 解析失败 ⇒ 新增 `launcher-receipt-missing` 级别错误；成功 ⇒ 计算 EXE 的 SHA-256 与大小，调用 `checkReceipt`，**`errors` 升级为 findings（`level: 'error'`，id `launcher-receipt-invalid`），`warnings` 原样作为 warn findings 传入 `auditDelivery` 的 `options.receiptWarnings`**。

`checkReceipt` 的 `expectedFingerprints` 与 `knownPublicKeysBase64` 来自 `--key-registry <path>`（指向机器可读台账 `docs/portable-update-key-registry.json`）。**该参数在正式路径上是必填的**：

| 情形                                         | 结果                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| `--key-registry` 缺失                        | **硬失败**：`--key-registry is required unless --test-only is given`               |
| 台账不可解析 / 字段非法 / 指纹不合法         | **硬失败**（`parseKeyRegistry` 抛 `KeyRegistryError`）                             |
| 台账里该启动器版本没有 active 登记           | **硬失败**：`the key registry has no active key registered for launcher version …` |
| 指纹集合不一致                               | **硬失败**（`checkReceipt` 报 error）                                              |
| 显式 `--test-only` 且 `_TEST-ONLY-` 前缀成立 | 允许缺省，但记 `warn` + 打印不可发布警告                                           |

**不得**有任何"没有台账就跳过检查"的路径。台账模板的 `keys` 为空数组，因此**真实组装在密钥仪式完成之前会被正确地挡住**——这是预期行为，不是缺陷。

- [ ] **Step 4: 运行测试并确认通过**

```bash
node --test scripts/lib/udisk-delivery.test.mjs scripts/lib/udisk-archive.test.mjs scripts/lib/udisk-diagnose.test.mjs
```

预期：`fail 0`，且既有 48 个用例全部仍然通过。

- [ ] **Step 5: 写失败的测试（组装器）**

追加到 `scripts/lib/udisk-delivery.test.mjs`：

```js
test('the assemble CLI refuses to run without a build receipt', () => {
  const root = makeDelivery({ launcherBytes: makePeBytes() });
  const result = spawnSync(
    process.execPath,
    [
      path.join(repositoryRoot, 'scripts', 'assemble-udisk-delivery.mjs'),
      '--app-dir',
      path.join(root, APP_DIR_NAME),
      '--launcher',
      path.join(root, LAUNCHER_EXE_NAME),
      '--out',
      path.join(root, '..', 'assembled'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--receipt is required/);
});

test('the assemble CLI refuses a mismatched build receipt', () => {
  const root = makeDelivery({ launcherBytes: makePeBytes() });
  const receiptPath = path.join(root, 'receipt.json');
  fs.writeFileSync(
    receiptPath,
    JSON.stringify({
      receiptVersion: 1,
      launcherVersion: '1.2.3',
      commit: 'a'.repeat(40),
      commitDirty: false,
      embeddedKeysBase64: [],
      embeddedKeyFingerprints: [],
      exeSha256: 'f'.repeat(64),
      exeSize: 1,
      outDir: root,
      builtAt: '2026-09-22T09:00:00.000Z',
      toolchain: {},
      trust: 'self-declared',
    }),
    'utf8',
  );
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'udisk-assembled-'));
  roots.push(out);
  fs.rmdirSync(out);
  const result = spawnSync(
    process.execPath,
    [
      path.join(repositoryRoot, 'scripts', 'assemble-udisk-delivery.mjs'),
      '--app-dir',
      path.join(root, APP_DIR_NAME),
      '--launcher',
      path.join(root, LAUNCHER_EXE_NAME),
      '--receipt',
      receiptPath,
      '--out',
      out,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /hash does not match/i);
});

test('the assemble CLI refuses to run without a key registry', () => {
  const root = makeDelivery({ launcherBytes: makePeBytes() });
  const receiptPath = writeMatchingReceipt(root, makePeBytes());
  const out = makeEmptyOutputDir();
  const result = spawnSync(
    process.execPath,
    [
      path.join(repositoryRoot, 'scripts', 'assemble-udisk-delivery.mjs'),
      '--app-dir',
      path.join(root, APP_DIR_NAME),
      '--launcher',
      path.join(root, LAUNCHER_EXE_NAME),
      '--receipt',
      receiptPath,
      '--out',
      out,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--key-registry is required/u);
});

test('the assemble CLI refuses a test only build whose output directory is not marked', () => {
  const root = makeDelivery({ launcherBytes: makePeBytes() });
  const receiptPath = writeMatchingReceipt(root, makePeBytes());
  const out = makeEmptyOutputDir();
  const result = spawnSync(
    process.execPath,
    [
      path.join(repositoryRoot, 'scripts', 'assemble-udisk-delivery.mjs'),
      '--app-dir',
      path.join(root, APP_DIR_NAME),
      '--launcher',
      path.join(root, LAUNCHER_EXE_NAME),
      '--receipt',
      receiptPath,
      '--test-only',
      '--out',
      out,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /_TEST-ONLY-/u);
});

test('the assemble CLI refuses a registry that has no key for this launcher version', () => {
  const root = makeDelivery({ launcherBytes: makePeBytes() });
  const receiptPath = writeMatchingReceipt(root, makePeBytes());
  const registryPath = path.join(root, 'registry.json');
  fs.writeFileSync(registryPath, JSON.stringify({ schemaVersion: 1, keys: [] }), 'utf8');
  const out = makeEmptyOutputDir();
  const result = spawnSync(
    process.execPath,
    [
      path.join(repositoryRoot, 'scripts', 'assemble-udisk-delivery.mjs'),
      '--app-dir',
      path.join(root, APP_DIR_NAME),
      '--launcher',
      path.join(root, LAUNCHER_EXE_NAME),
      '--receipt',
      receiptPath,
      '--key-registry',
      registryPath,
      '--out',
      out,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no active key registered/u);
});
```

**命名对齐：** 上面的 `writeMatchingReceipt(root, bytes)` 与 `makeEmptyOutputDir()` 需要按该文件既有的夹具风格补两个小辅助：前者生成一份 `exeSha256`/`exeSize` 与给定字节**完全匹配**的回执（复用 Task 2 的回执字段表），后者用 `fs.mkdtempSync` + `fs.rmdirSync` 造一个"存在但为空"的输出目录。先把它们加进夹具区，再运行测试。

- [ ] **Step 6: 运行测试并确认按测试名失败**

```bash
node --test scripts/lib/udisk-delivery.test.mjs
```

预期：两个新用例失败，`--receipt is required` 的断言先红。

- [ ] **Step 7: 写最小实现（组装器）**

修改 `scripts/assemble-udisk-delivery.mjs`：

(a) `parseArguments` 的 `names` 改为 `['app-dir', 'launcher', 'receipt', 'out']`，返回值增加 `receiptPath: values.receipt`。

(b) 把**非空输出目录检查提到最前**（在 `mkdir` 之前），保持既有错误串不变：

```js
if (existsSync(input.outDir)) {
  const existing = await readdir(input.outDir);
  if (existing.length > 0) {
    throw new Error('refusing to assemble into a non-empty output directory');
  }
}
```

(c) 在启动器校验之后插入回执校验：

```js
const receipt = parseReceipt(await readFile(input.receiptPath, 'utf8'));
const launcherBytes = await readFile(input.launcher);
const verdict = checkReceipt({
  receipt,
  exeSha256: createHash('sha256').update(launcherBytes).digest('hex'),
  exeSize: launcherBytes.length,
  expectedFingerprints: await resolveRegisteredFingerprints(input, receipt),
  outDir: dirname(input.launcher),
  now: Date.now(),
  maxAgeMs: RECEIPT_MAX_AGE_MS,
});
if (verdict.errors.length > 0) {
  throw new Error(`the launcher build receipt does not match: ${verdict.errors.join('; ')}`);
}
for (const message of verdict.warnings) console.warn(`WARNING: ${message}`);
```

（`RECEIPT_MAX_AGE_MS` 定义为 `7 * 24 * 60 * 60 * 1000`，并在文件里注明这是提醒窗口而非安全属性——留一行注释即可，`scripts/` 允许注释。）

(c2) 新增本刀的核心函数——**期望指纹只能来自台账**，不能来自回执自身（拿回执比回执等于什么都没验）：

```js
async function resolveRegisteredFingerprints(input, receipt) {
  if (input.testOnly === true) {
    if (!basename(input.outDir).startsWith(TEST_ONLY_DIRECTORY_PREFIX)) {
      throw new Error(`--test-only requires an output directory whose name starts with ${TEST_ONLY_DIRECTORY_PREFIX}`);
    }
    console.warn('WARNING: this delivery bypasses the key registry and must never be published');
    return receipt.embeddedKeyFingerprints;
  }
  if (input.keyRegistryPath === null) {
    throw new Error('--key-registry is required unless --test-only is given');
  }
  const registry = parseKeyRegistry(await readFile(input.keyRegistryPath, 'utf8'));
  const registered = fingerprintsForVersion(registry, receipt.launcherVersion);
  if (registered === null) {
    throw new Error(`the key registry has no active key registered for launcher version ${receipt.launcherVersion}`);
  }
  return registered;
}
```

顶部补常量与导入（`basename` 来自 `node:path`）：

```js
const TEST_ONLY_DIRECTORY_PREFIX = '_TEST-ONLY-';
```

```js
import { fingerprintsForVersion, parseKeyRegistry } from './lib/key-registry.mjs';
```

(c3) `parseArguments` 增加两个**非必填**旗标（`--key-registry` 在 test-only 下允许缺省，因此不能进必填列表）：

```js
function parseArguments(argv) {
  const names = ['app-dir', 'launcher', 'receipt', 'out'];
  const values = {};
  for (const name of names) {
    const index = argv.indexOf(`--${name}`);
    if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error(`--${name} is required`);
    }
    values[name] = argv[index + 1];
  }
  const registryIndex = argv.indexOf('--key-registry');
  return {
    appDir: resolve(values['app-dir']),
    launcher: resolve(values.launcher),
    receiptPath: resolve(values.receipt),
    outDir: resolve(values.out),
    keyRegistryPath: registryIndex >= 0 && argv[registryIndex + 1] ? resolve(argv[registryIndex + 1]) : null,
    testOnly: argv.includes('--test-only'),
  };
}
```

(d) 把启动器的两字节检查换成 PE 检查器：

```js
const inspection = inspectPortableExecutable(launcherBytes);
if (inspection.errors.length > 0) {
  throw new Error(`launcher is not a Windows PE image: ${inspection.errors.join('; ')}`);
}
```

(e) 把 `await buildPortableFileManifest({ programDir: input.appDir, version: '0.0.0' });` 里的字面量抽成具名常量，消除“魔法版本号”：

```js
const PROGRAM_TREE_VALIDATION_VERSION = '0.0.0';
```

调用改为 `await buildPortableFileManifest({ programDir: input.appDir, version: PROGRAM_TREE_VALIDATION_VERSION });`，并在上一行注明：这一调用的**唯一目的**是借它校验程序目录（符号链接、受保护目录、路径冲突），返回的文件清单刻意丢弃。

- [ ] **Step 8: 运行测试并确认通过**

```bash
node --test scripts/lib/udisk-delivery.test.mjs
```

预期：`fail 0`。

- [ ] **Step 9: 行为级变异验证**

1. 把 `MINIMUM_LAUNCHER_BYTES` 改成 `0` ⇒ 预期 `a launcher that is too small is a release-blocking error` **按测试名变红**。
2. 删掉 `launcher-key-mismatch` 的“必须出现”分支 ⇒ 预期 `a launcher missing the registered public key is a release-blocking error` **按测试名变红**。
3. 把 `warning()` 返回的 `level` 改成 `'error'` ⇒ 预期 `warnings do not make the delivery fail` **按测试名变红**。
4. 把组装器里 `verdict.errors.length > 0` 的拒绝改成 `console.warn` ⇒ 预期 `the assemble CLI refuses a mismatched build receipt` **按测试名变红**。
5. 把 `resolveRegisteredFingerprints` 里 `input.keyRegistryPath === null` 的硬失败改成 `return receipt.embeddedKeyFingerprints`（即退回"没有台账就跳过"）⇒ 预期 `the assemble CLI refuses to run without a key registry` **按测试名变红**。
6. 把 `resolveRegisteredFingerprints` 里 `registered === null` 的硬失败改成 `return receipt.embeddedKeyFingerprints` ⇒ 预期 `the assemble CLI refuses a registry that has no key for this launcher version` **按测试名变红**。
7. 把 `_TEST-ONLY-` 前缀检查删掉 ⇒ 预期 `the assemble CLI refuses a test only build whose output directory is not marked` **按测试名变红**。
8. 把 `fingerprintsForVersion` 里 `status === 'active'` 过滤删掉 ⇒ 预期 Task 0.5 的 `a retired key is never returned for a new release` **按测试名变红**。

恢复后 `git diff` 为空且全绿。

- [ ] **Step 10: 把新测试文件接入门禁**

修改 `package.json`：新增

```json
"check:portable-release-assembly": "node --test scripts/lib/portable-executable.test.mjs scripts/lib/launcher-receipt.test.mjs scripts/lib/key-registry.test.mjs scripts/lib/portable-launcher-challenge.test.mjs scripts/lib/portable-unsigned-artifacts.test.mjs"
```

并把 `pnpm check:portable-release-assembly` 插到 `check` 里 `pnpm check:portable-update-release` **之后**、`pnpm lint` **之前**。

（`portable-launcher-challenge.test.mjs` 与 `portable-unsigned-artifacts.test.mjs` 在 Task 4 / Task 5 才会存在；**本步先只加入前两个文件**，Task 4 与 Task 5 各自把自己的文件补进这个脚本。）

- [ ] **Step 11: 提交**

```bash
git add scripts/lib/udisk-delivery.mjs scripts/udisk-delivery.mjs scripts/assemble-udisk-delivery.mjs scripts/lib/udisk-delivery.test.mjs package.json
git commit -m "feat(release): refuse a misconfigured launcher before it reaches customers"
```

---

### Task 4: 发布期 QC 挑战

**Files:**

- Create: `scripts/lib/portable-launcher-challenge.mjs`
- Test: `scripts/lib/portable-launcher-challenge.test.mjs`
- Create: `scripts/portable-launcher-challenge.mjs`

**两条路径必须分清（规格 §5.7）：**

| 路径         | 正向样本                                                     | 在哪里执行                                                                                                             |
| ------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 仓库自动化   | **fixture 钥匙**签的样本                                     | 已在**计划 1** 的 Go 测试里覆盖（`launcher/testdata/manifest.json` + `--verify-manifest`）；本刀只做**判定逻辑**的单测 |
| 生产发布质检 | **生产钥匙**签的 manifest（优先用本次待发布的真实 manifest） | 本刀的 CLI，由操作员在获授权的离线签名会话之后执行                                                                     |

本刀**不生成生产密钥**，也**不发明生产样本**。

- [ ] **Step 1: 写失败的测试**

创建 `scripts/lib/portable-launcher-challenge.test.mjs`：

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { PortableLauncherChallengeError, evaluateChallenge } from './portable-launcher-challenge.mjs';

const describeOk = {
  schemaVersion: 1,
  launcherVersion: '1.2.3',
  embeddedKeys: [{ fingerprint: 'A'.repeat(64), base64: 'k' }],
};

function evaluate(overrides = {}) {
  return evaluateChallenge({
    describe: describeOk,
    positiveOk: true,
    positiveKeyFingerprint: 'A'.repeat(64),
    negativeOk: false,
    negativeErrorCode: 'signature-invalid',
    ...overrides,
  });
}

test('a fully passing challenge reports no failures', () => {
  assert.deepEqual(evaluate().failures, []);
});

test('a challenge that fails the positive sample is reported', () => {
  const result = evaluate({ positiveOk: false, positiveErrorCode: 'signature-invalid' });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /positive/i);
});

test('a challenge whose negative sample verifies is reported', () => {
  const result = evaluate({ negativeOk: true });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /negative/i);
});

test('a negative sample rejected for the wrong reason is reported', () => {
  const result = evaluate({ negativeErrorCode: 'manifest-invalid' });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /signature-invalid/i);
});

test('a describe payload that reports no key is reported', () => {
  const result = evaluate({ describe: { ...describeOk, embeddedKeys: [] } });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /embedded key/i);
});

test('a positive sample verified by a different key than the launcher reports is reported', () => {
  const result = evaluate({ positiveKeyFingerprint: 'B'.repeat(64) });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /fingerprint/i);
});

test('the challenge refuses to treat a missing positive sample as a pass', () => {
  assert.throws(() => evaluateChallenge({ describe: describeOk, positiveOk: null }), PortableLauncherChallengeError);
});
```

- [ ] **Step 2: 运行测试并确认按测试名失败**

```bash
node --test scripts/lib/portable-launcher-challenge.test.mjs
```

预期：无法解析 `./portable-launcher-challenge.mjs`。

- [ ] **Step 3: 写最小实现（判定逻辑）**

创建 `scripts/lib/portable-launcher-challenge.mjs`：

```js
export class PortableLauncherChallengeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PortableLauncherChallengeError';
  }
}

export function evaluateChallenge(input) {
  if (typeof input.positiveOk !== 'boolean' || typeof input.negativeOk !== 'boolean') {
    throw new PortableLauncherChallengeError('the challenge needs both a positive and a negative verification result');
  }
  const failures = [];
  const keys = Array.isArray(input.describe?.embeddedKeys) ? input.describe.embeddedKeys : [];

  if (keys.length === 0) {
    failures.push('the launcher reported no embedded key');
  }
  if (!input.positiveOk) {
    failures.push(`the positive sample did not verify (${input.positiveErrorCode ?? 'unknown'})`);
  }
  if (input.negativeOk) {
    failures.push('the negative sample verified, so the launcher does not enforce the signature');
  } else if (input.negativeErrorCode !== 'signature-invalid') {
    failures.push(`the negative sample was rejected with ${input.negativeErrorCode}, expected signature-invalid`);
  }
  if (
    input.positiveOk &&
    typeof input.positiveKeyFingerprint === 'string' &&
    keys.length > 0 &&
    !keys.some((entry) => entry.fingerprint === input.positiveKeyFingerprint)
  ) {
    failures.push('the positive sample was verified by a key the launcher does not report');
  }

  return { failures, keyFingerprints: keys.map((entry) => entry.fingerprint) };
}

export function createNegativeManifestInput({ canonicalizeJson, sign, privateKey }) {
  const payload = {
    schemaVersion: 1,
    channel: 'internal',
    version: '0.0.1',
    minLauncherVersion: '0.0.1',
    packageUrl: 'https://example.invalid/updates/internal/0.0.1/portable.zip',
    packageSize: 1,
    packageSha256: '0'.repeat(64),
    fileManifestSha256: '0'.repeat(64),
    publishedAt: '2026-09-22T00:00:00.000Z',
    mandatory: false,
  };
  const signature = sign(null, Buffer.from(canonicalizeJson(payload), 'utf8'), privateKey).toString('base64');
  return `${canonicalizeJson({ ...payload, signature })}\n`;
}
```

- [ ] **Step 4: 运行测试并确认通过**

```bash
node --test scripts/lib/portable-launcher-challenge.test.mjs
```

预期：`pass 7`、`fail 0`。

- [ ] **Step 5: 写 CLI**

创建 `scripts/portable-launcher-challenge.mjs`：

```js
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { canonicalizeJson } from '../packages/shared/src/portable-update.ts';
import { createNegativeManifestInput, evaluateChallenge } from './lib/portable-launcher-challenge.mjs';

const USAGE = [
  'Usage: node scripts/portable-launcher-challenge.mjs --launcher <exe> --positive-manifest <path>',
  '  --launcher            the built launcher executable',
  '  --positive-manifest   a manifest signed by the PRODUCTION key (the pending release manifest,',
  '                        or a harmless manifest signed during an authorised offline signing session)',
  '',
  'This command never signs anything with a production key and never touches the update feed.',
].join('\n');

function flag(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : null;
}

function runLauncher(launcherPath, args) {
  try {
    const stdout = execFileSync(launcherPath, args, { encoding: 'utf8', timeout: 10000, windowsHide: true });
    return { exitCode: 0, payload: JSON.parse(stdout) };
  } catch (error) {
    const status = typeof error?.status === 'number' ? error.status : -1;
    let payload = null;
    try {
      payload = JSON.parse(typeof error?.stdout === 'string' ? error.stdout : '');
    } catch {
      payload = null;
    }
    return { exitCode: status, payload };
  }
}

const argv = process.argv.slice(2);
const launcherPath = flag(argv, '--launcher');
const positiveManifest = flag(argv, '--positive-manifest');
if (launcherPath === null || positiveManifest === null) {
  console.log(USAGE);
  process.exit(2);
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'mofang-launcher-challenge-'));
try {
  const described = runLauncher(resolve(launcherPath), ['--describe-json']);
  if (described.payload === null) {
    console.error('the launcher did not report a readable description');
    process.exit(1);
  }
  const positive = runLauncher(resolve(launcherPath), ['--verify-manifest', resolve(positiveManifest)]);

  const unknownPair = generateKeyPairSync('ed25519');
  const negativePath = join(temporaryRoot, 'negative-manifest.json');
  writeFileSync(
    negativePath,
    createNegativeManifestInput({ canonicalizeJson, sign, privateKey: unknownPair.privateKey }),
    'utf8',
  );
  const negative = runLauncher(resolve(launcherPath), ['--verify-manifest', negativePath]);

  const verdict = evaluateChallenge({
    describe: described.payload,
    positiveOk: positive.payload?.ok === true,
    positiveKeyFingerprint: positive.payload?.keyFingerprint,
    positiveErrorCode: positive.payload?.errorCode,
    negativeOk: negative.payload?.ok === true,
    negativeErrorCode: negative.payload?.errorCode,
  });

  console.log(JSON.stringify({ launcher: resolve(launcherPath), verdict }, null, 2));
  process.exit(verdict.failures.length === 0 ? 0 : 1);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
```

- [ ] **Step 6: 运行 CLI 守卫并确认按测试名失败**

先补一条 CLI 守卫测试到 `scripts/lib/portable-launcher-challenge.test.mjs`：

```js
test('the challenge CLI refuses to run without a positive manifest', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(repositoryRoot, 'scripts', 'portable-launcher-challenge.mjs'), '--launcher', 'x.exe'],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /--positive-manifest/);
});
```

（顶部补 `spawnSync` 与 `repositoryRoot` 的导入，`repositoryRoot` 用该目录既有写法：`resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')`。）

运行：

```bash
node --test scripts/lib/portable-launcher-challenge.test.mjs
```

预期：新用例一开始失败（脚本尚不存在）；写完 CLI 后通过。

- [ ] **Step 7: 把测试文件接入门禁**

修改 `package.json` 的 `check:portable-release-assembly`，在文件列表里加入 `scripts/lib/portable-launcher-challenge.test.mjs`。

- [ ] **Step 8: 行为级变异验证**

1. 把 `evaluateChallenge` 里 `if (input.negativeOk)` 分支整个删掉 ⇒ 预期 `a challenge whose negative sample verifies is reported` **按测试名变红**。
2. 把 `keys.length === 0` 那条判断删掉 ⇒ 预期 `a describe payload that reports no key is reported` **按测试名变红**。
3. 把“positive 指纹必须出现在 describe 里”的判断删掉 ⇒ 预期 `a positive sample verified by a different key than the launcher reports` **按测试名变红**。
4. 把 CLI 的 `exit(2)` 守卫改成 `exit(0)` ⇒ 预期 `the challenge CLI refuses to run without a positive manifest` **按测试名变红**。

恢复后 `git diff` 为空且全绿。

- [ ] **Step 9: 提交**

```bash
git add scripts/lib/portable-launcher-challenge.mjs scripts/lib/portable-launcher-challenge.test.mjs scripts/portable-launcher-challenge.mjs package.json
git commit -m "feat(release): challenge the launcher identity before a release"
```

---

### Task 5: CI 与生产签名彻底解耦

**Files:**

- Create: `scripts/make-portable-unsigned-artifacts.mjs`
- Test: `scripts/lib/portable-unsigned-artifacts.test.mjs`
- Create: `.github/workflows/portable-artifacts.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `scripts/lib/portable-update-ci.test.mjs`
- Modify: `package.json`

**硬约束：** 生产私钥**不得**进入 GitHub secret 使用路径。CI **不得**产出生产签名 manifest。本刀删除 `MOFANG_UPDATE_FEED_UPLOAD_TOKEN`。

- [ ] **Step 1: 写失败的测试（unsigned 制品）**

创建 `scripts/lib/portable-unsigned-artifacts.test.mjs`：

```js
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeProgram(root) {
  const programDir = join(root, 'program');
  const files = {
    '\u8363\u76c8\u9b54\u65b9.exe': 'desktop-binary',
    'resources/app.asar': 'asar-content',
    'resources/runtime/openclaw-runtime-manifest.json': '{}',
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = join(programDir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  return programDir;
}

test('the unsigned artifact CLI writes exactly the package and the file manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'mofang-unsigned-'));
  roots.push(root);
  const programDir = writeProgram(root);
  const outDir = join(root, 'out');

  const result = spawnSync(
    process.execPath,
    [
      join(repositoryRoot, 'scripts', 'make-portable-unsigned-artifacts.mjs'),
      '--program-dir',
      programDir,
      '--version',
      '1.2.3',
      '--out',
      outDir,
    ],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(outDir).sort(), ['portable-files.json', 'portable.zip']);
});

test('the unsigned artifact CLI never writes a signed manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'mofang-unsigned-'));
  roots.push(root);
  const programDir = writeProgram(root);
  const outDir = join(root, 'out');

  spawnSync(
    process.execPath,
    [
      join(repositoryRoot, 'scripts', 'make-portable-unsigned-artifacts.mjs'),
      '--program-dir',
      programDir,
      '--version',
      '1.2.3',
      '--out',
      outDir,
    ],
    { encoding: 'utf8' },
  );

  assert.equal(existsSync(join(outDir, 'manifest.json')), false);
});

test('the unsigned artifact CLI refuses a non empty output directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'mofang-unsigned-'));
  roots.push(root);
  const programDir = writeProgram(root);
  const outDir = join(root, 'out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'occupied.txt'), 'x', 'utf8');

  const result = spawnSync(
    process.execPath,
    [
      join(repositoryRoot, 'scripts', 'make-portable-unsigned-artifacts.mjs'),
      '--program-dir',
      programDir,
      '--version',
      '1.2.3',
      '--out',
      outDir,
    ],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing to overwrite/i);
});

test('the unsigned artifact CLI does not read a signing key from the environment', () => {
  const source = readFileSync(join(repositoryRoot, 'scripts', 'make-portable-unsigned-artifacts.mjs'), 'utf8');
  assert.equal(source.includes('MOFANG_UPDATE_SIGNING_KEY'), false);
  assert.equal(source.includes('MOFANG_UPDATE_SIGNING_KEY_FILE'), false);
  assert.equal(source.includes('readSigningKeyFile'), false);
});
```

（顶部补 `mkdirSync`、`writeFileSync` 的导入。）

- [ ] **Step 2: 运行测试并确认按测试名失败**

```bash
node --test scripts/lib/portable-unsigned-artifacts.test.mjs
```

预期：CLI 不存在，4 个用例全部失败。

- [ ] **Step 3: 写最小实现**

创建 `scripts/make-portable-unsigned-artifacts.mjs`：

```js
#!/usr/bin/env node

import { mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  buildPortableFileManifest,
  createPortableUpdateArchive,
  PORTABLE_FILE_MANIFEST_NAME,
  PORTABLE_PACKAGE_NAME,
} from './lib/portable-update-release.mjs';

function parseArguments(argv) {
  const names = ['program-dir', 'version', 'out'];
  const values = {};
  for (const name of names) {
    const index = argv.indexOf(`--${name}`);
    if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error(`--${name} is required`);
    }
    values[name] = argv[index + 1];
  }
  return { programDir: resolve(values['program-dir']), version: values.version, outDir: resolve(values.out) };
}

async function assertEmptyOutput(outDir) {
  try {
    const entries = await readdir(outDir);
    if (entries.length > 0) throw new Error('refusing to overwrite an existing artifact');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function main() {
  const input = parseArguments(process.argv.slice(2));
  await assertEmptyOutput(input.outDir);
  await mkdir(input.outDir, { recursive: true });

  const { fileManifest, fileManifestBytes } = await buildPortableFileManifest({
    programDir: input.programDir,
    version: input.version,
  });
  await createPortableUpdateArchive({
    programDir: input.programDir,
    archivePath: join(input.outDir, PORTABLE_PACKAGE_NAME),
    files: fileManifest.files,
  });
  await writeFile(join(input.outDir, PORTABLE_FILE_MANIFEST_NAME), fileManifestBytes);

  console.log(`Unsigned portable artifacts written to ${input.outDir}`);
  console.log('This artifact set carries no signature and must never be published to the update feed as is.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
```

（补 `writeFile` 从 `node:fs/promises` 导入。）

- [ ] **Step 4: 运行测试并确认通过**

```bash
node --test scripts/lib/portable-unsigned-artifacts.test.mjs
```

预期：`pass 4`、`fail 0`。

- [ ] **Step 5: 把测试文件接入门禁**

修改 `package.json` 的 `check:portable-release-assembly`，加入 `scripts/lib/portable-unsigned-artifacts.test.mjs`。

- [ ] **Step 6: 写失败的测试（CI 形态）**

改写 `scripts/lib/portable-update-ci.test.mjs` 的第二个断言块，并把第一块扩为对两个 workflow 的检查：

```js
test('CI produces unsigned artifacts and never touches production signing material', () => {
  const workflow = read('.github/workflows/portable-artifacts.yml');

  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*push:/m);
  assert.doesNotMatch(workflow, /^\s*pull_request:/m);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /MOFANG_UPDATE_SIGNING_KEY/);
  assert.doesNotMatch(workflow, /MOFANG_UPDATE_SIGNING_KEY_FILE/);
  assert.doesNotMatch(workflow, /MOFANG_UPDATE_FEED_UPLOAD_TOKEN/);
  assert.match(workflow, /node scripts\/make-portable-unsigned-artifacts\.mjs/);
  assert.match(workflow, /actions\/upload-artifact@v7/);
  assert.doesNotMatch(workflow, /gh release upload/);
});

test('the upstream release workflow no longer carries the dead upload token gate', () => {
  const workflow = read('.github/workflows/release.yml');

  assert.doesNotMatch(workflow, /MOFANG_UPDATE_FEED_UPLOAD_TOKEN/);
  assert.doesNotMatch(workflow, /portable-update-release:/);
  assert.doesNotMatch(workflow, /environment:\s*\n\s+name: portable-update-production/);
});

test('the artifact workflow migrates the version consistency check instead of needing another workflow', () => {
  const workflow = read('.github/workflows/portable-artifacts.yml');

  assert.match(workflow, /Unsupported release tag format/);
  assert.match(workflow, /Version mismatch/);
  assert.doesNotMatch(workflow, /needs:\s*\[?prepare-release/);
});
```

- [ ] **Step 7: 运行测试并确认按测试名失败**

```bash
node --test scripts/lib/portable-update-ci.test.mjs
```

预期：三个用例失败（`portable-artifacts.yml` 不存在；`release.yml` 仍有假门禁与 portable job）。

- [ ] **Step 8: 写实现（workflow）**

创建 `.github/workflows/portable-artifacts.yml`：

```yaml
name: Portable artifacts

on:
  workflow_dispatch:
    inputs:
      tag:
        description: 'Release tag whose version the artifacts are built for (for example: v1.2.3)'
        required: true
        type: string

permissions:
  contents: read

jobs:
  prepare:
    runs-on: ubuntu-latest
    outputs:
      release_tag: ${{ steps.meta.outputs.release_tag }}
    steps:
      - name: Checkout
        uses: actions/checkout@v7
        with:
          ref: ${{ inputs.tag }}

      - name: Verify tag format and version consistency
        id: meta
        run: |
          RELEASE_TAG="${{ inputs.tag }}"
          if [[ ! "$RELEASE_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-((alpha|beta|rc)\.[0-9]+))?$ ]]; then
            echo "::error::Unsupported release tag format: $RELEASE_TAG"
            exit 1
          fi
          DESKTOP_VERSION=$(node -p "require('./packages/desktop/package.json').version")
          TAG_VERSION="${RELEASE_TAG#v}"
          if [ "$DESKTOP_VERSION" != "$TAG_VERSION" ]; then
            echo "::error::Version mismatch: package.json=${DESKTOP_VERSION}, tag=${TAG_VERSION}"
            exit 1
          fi
          echo "release_tag=$RELEASE_TAG" >> "$GITHUB_OUTPUT"

  artifacts:
    needs: [prepare]
    runs-on: windows-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v7
        with:
          ref: ${{ needs.prepare.outputs.release_tag }}

      - name: Setup pnpm
        uses: pnpm/action-setup@v5
        with:
          version: 10

      - name: Setup Node.js
        uses: actions/setup-node@v7
        with:
          node-version: 20
          cache: pnpm

      - name: Setup Go
        uses: actions/setup-go@v7
        with:
          go-version-file: launcher/go.mod
          cache: false

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run portable gates
        run: |
          pnpm check:portable-launcher
          pnpm check:portable-release-assembly

      - name: Generate ephemeral launcher public key
        shell: pwsh
        run: |
          node -e "const {generateKeyPairSync}=require('node:crypto'); const {publicKey}=generateKeyPairSync('ed25519'); require('node:fs').appendFileSync(process.env.GITHUB_ENV, 'MOFANG_UPDATE_PUBLIC_KEY_B64=' + publicKey.export({type:'spki',format:'der'}).toString('base64') + '\nMOFANG_LAUNCHER_VERSION=0.0.0-ci\n');"

      - name: Build the application directory
        run: |
          pnpm --filter @clawwork/desktop build
          pnpm --filter @clawwork/desktop exec electron-builder --win --x64 --dir --publish never -c.buildVersion="${{ github.run_number }}"

      - name: Build the unsigned portable artifacts
        env:
          TAG_VERSION: ${{ needs.prepare.outputs.release_tag }}
        run: |
          node scripts/make-portable-unsigned-artifacts.mjs --program-dir packages/desktop/dist/win-unpacked --version "${TAG_VERSION#v}" --out artifacts/portable-unsigned

      - name: Upload the unsigned artifacts
        uses: actions/upload-artifact@v7
        with:
          name: portable-unsigned-${{ needs.prepare.outputs.release_tag }}
          path: artifacts/portable-unsigned/
          if-no-files-found: error
          retention-days: 30
```

说明（写进 workflow 顶部注释即可，`scripts/` 与 workflow 允许注释）：本 workflow **只产出 unsigned 制品**；生产 manifest 必须由离线签名流程产生。注意 `--version` 必须收到**剥掉 `v` 前缀**的严格 SemVer——`buildPortableFileManifest` 会拒绝 `v1.2.3`（`scripts/lib/portable-update-release.mjs` 的 `assertVersion` 报 `must be a strict semantic version`），因此上面用 `"${TAG_VERSION#v}"` 而不是直接传标签。

修改 `.github/workflows/release.yml`：

- 整段删除 `portable-update-release:` job（现 `:186-302`）。
- 在文件顶部注释里写明：本 workflow 是**上游 ClawWork 的多平台发布流水线**，与本产品的 U 盘交付无关；本产品的制品由 `portable-artifacts.yml`（unsigned）与离线签名流程负责。

- [ ] **Step 9: 运行测试并确认通过**

```bash
node --test scripts/lib/portable-update-ci.test.mjs
```

预期：`fail 0`。

同时确认旧的假门禁在仓库里彻底消失：

```bash
grep -rn "MOFANG_UPDATE_FEED_UPLOAD_TOKEN" .github/ scripts/ docs/runbooks/ || echo "no occurrences in workflows, scripts and runbooks"
```

预期：只在 `docs/superpowers/` 的历史文档里可能仍有提及；`.github/`、`scripts/`、`docs/runbooks/` 三处必须为 `no occurrences`（文档纠正见 Task 6）。

- [ ] **Step 10: 行为级变异验证**

1. 在 `portable-artifacts.yml` 里加一行 `MOFANG_UPDATE_FEED_UPLOAD_TOKEN: ${{ secrets.X }}` ⇒ 预期 `CI produces unsigned artifacts and never touches production signing material` **按测试名变红**。
2. 把 `make-portable-unsigned-artifacts.mjs` 换成 `make-portable-update.mjs` ⇒ 预期同一测试的 `make-portable-unsigned-artifacts` 断言 **按测试名变红**。
3. 在 `release.yml` 里恢复 `portable-update-release:` job ⇒ 预期 `the upstream release workflow no longer carries the dead upload token gate` **按测试名变红**。

恢复后 `git diff` 为空且全绿。

- [ ] **Step 11: 提交**

```bash
git add .github/workflows/portable-artifacts.yml .github/workflows/release.yml scripts/make-portable-unsigned-artifacts.mjs scripts/lib/portable-unsigned-artifacts.test.mjs scripts/lib/portable-update-ci.test.mjs package.json
git commit -m "ci(release): build unsigned portable artifacts without production secrets"
```

---

### Task 6: 文档与密钥仪式

**Files:**

- Create: `docs/runbooks/portable-launcher-signing-ceremony.md`
- Create: `docs/portable-update-key-registry.md`
- Modify: `docs/runbooks/portable-update-release.md`
- Modify: `docs/superpowers/plans/2026-09-21-portable-full-directory-update.md`
- Modify: `docs/status/2026-09-15-demo-bug-fix-log.md`

**禁止：** 台账里不得出现任何**具体的**指纹、公钥或密钥路径——本轮一个真实密钥都不生成，台账只能是模板。

- [ ] **Step 1: 纠正发布手册第 19 行**

`docs/runbooks/portable-update-release.md:19` 改为：

```markdown
- 发布服务必须支持“先传不可变版本目录，最后原子替换频道 manifest”。仓库现在有经过复核的上传器 `scripts/feed-publish.mjs`（见第 7 步）；**未持有该上传器或服务端操作手册时，完成第 6 步后停止，不得进入第 7 步**，不得现场拼命令。
```

- [ ] **Step 2: 创建密钥仪式 runbook**

创建 `docs/runbooks/portable-launcher-signing-ceremony.md`，内容必须包含且只能包含下列要点（**不得填入任何真实值**）：

1. **适用范围**：一次性离线签名会话；本文件不授权生成密钥，生成必须另获用户授权。
2. **Windows 私钥处理**：私钥存放在**加密卷**（VeraCrypt 容器或 BitLocker To Go 介质）上，不放在系统盘普通目录；会话期间解密挂载到最小权限临时目录；**显式设置 NTFS ACL**——命令模板 `icacls <目录> /inheritance:r /grant:r "<签名账号>:(OI)(CI)F"`；会话结束立即删除临时文件并卸载卷。
3. **不得承诺取证级擦除**：在带磨损均衡与 TRIM 的 SSD 上，覆盖写或普通删除都不能可靠清除先前副本；内容还可能残留在卷影副本、页面文件与休眠文件中。本流程**不声称 shred 能力**，实际依赖卷级加密、最短暴露窗口、ACL 限制与及时删除。若需要取证级保证，应改用硬件令牌或 HSM。
4. **禁令**：不把私钥粘贴到会被记录的终端、不用带备份或交换文件的编辑器打开、不进入 shell 历史、不写入仓库 / GitHub / Gitee / 任何服务器 / 日志 / 客户包。
5. **指纹备案**：会话结束后把公钥与 `SHA-256(SPKI DER)` 指纹（大写 hex）登记进 `docs/portable-update-key-registry.md`。
6. **发布期 QC**：在签名会话内或紧随其后，按第 7 步运行 `scripts/portable-launcher-challenge.mjs`，正向样本用**生产钥匙**签出的 manifest（优先用本次待发布的真实 manifest），负向样本由该工具自行生成的未知钥匙产生。三条（报告版本与指纹、正向通过、负向失败）全过才算通过；**这是发布期 QC 证据，不是普通 CI 测试**。
7. **残留风险**：启动器本体未做操作系统级代码签名（无 Authenticode）。SmartScreen 会拦、无法用操作系统机制验证未被篡改；这与 Ed25519 清单签名是两件事。该风险写进台账，直到取得代码签名证书才可关闭。**本阶段不实现、不伪装 Authenticode。**
8. **备份与演练**：私钥丢失 ⇒ 无法再签任何新版本，只能停发更新。因此必须有可用的加密备份，并**定期演练恢复**（恢复 → 签一条 → 验证 → 销毁演练产物）。

- [ ] **Step 3: 创建密钥台账模板**

创建 `docs/portable-update-key-registry.md`：

```markdown
# 便携更新公钥台账

本文件只登记**公开**信息：公钥与指纹。**任何私钥、口令、容器路径都不得出现在这里。**

指纹 = `SHA-256(SPKI DER)`，以大写 hex 表示；台账里可以按 4 字符一组加空格展示，代码比较时会去掉空格。

## 登记项

| keyId  | 指纹（大写 hex） | 公钥（SPKI Base64） | 用途         | 生成日期 | 状态   | 对应启动器最低版本 |
| ------ | ---------------- | ------------------- | ------------ | -------- | ------ | ------------------ |
| 待登记 | 待登记           | 待登记              | 更新清单签名 | 待登记   | 待登记 | 待登记             |

## 服务器 host-key 指纹

| 环节                | 指纹   | 核对人 | 核对日期 | 带外核对方式 |
| ------------------- | ------ | ------ | -------- | ------------ |
| 更新源 SSH host key | 待核对 | 待填   | 待填     | 待填         |

> 首次生产发布前，必须由用户或授权运维人员通过**可信带外渠道**核对上表，并把核对方式写明。
> 核对命令与拒绝条件见 `docs/runbooks/portable-update-release.md`。**本仓库不填任何默认指纹，不提供假值。**

## 残留风险

- 启动器本体**未做 Authenticode 签名**：SmartScreen 会拦截，且无法用操作系统机制验证启动器未被篡改。关闭条件 = 取得代码签名证书。

## 变更记录

- 2026-09-22：建立台账骨架（模板）。本轮未生成任何真实密钥。
```

- [ ] **Step 3b: 创建机器可读台账模板**

创建 `docs/portable-update-key-registry.json`：

```json
{
  "schemaVersion": 1,
  "keys": []
}
```

**这是模板，不是可用的台账。** `keys` 为空数组意味着：任何**真实**组装与**真实**交付审计都会因为"该启动器版本没有 active 登记"而**硬失败**——这正是规格 §5.4 要求的行为。台账内容只能在**获授权的离线签名仪式**之后，由 `docs/runbooks/portable-launcher-signing-ceremony.md` 记录的公钥与指纹填进去。

在 `docs/portable-update-key-registry.md` 里加一行说明两者的关系：

```markdown
> 机器可读台账是 `docs/portable-update-key-registry.json`（组装器与审计读取它）；本文件是它的**人类可读对照**。
> 两者必须一致，且**都只含公开信息**。`keys` 为空时，正式组装会被正确拒绝。
```

- [ ] **Step 4: 修正计划书里的假门禁**

`docs/superpowers/plans/2026-09-21-portable-full-directory-update.md:998` 所在的三个名字代码块：删掉 `MOFANG_UPDATE_FEED_UPLOAD_TOKEN` 一行，并在该代码块下方注明：该密钥从未被任何脚本消费，已在 2026-09-22 的 CI 纠偏中删除；生产签名改为离线流程。

- [ ] **Step 5: 追加历史后记（不改写历史）**

`docs/status/2026-09-15-demo-bug-fix-log.md`：**不得改动第 122 行原文**。在 `### 仍未完成（需要人工/运维动作）` 该节末尾**追加**：

```markdown
> **2026-09-22 后记（不改写上文）**：上文第 2 条「上传脚本都还没做」在当时是准确的。此后仓库新增了经过复核的 `scripts/feed-publish.mjs`（见 `docs/runbooks/portable-update-release.md` 第 7 步）与独立的 `portable-artifacts.yml`。**更新源尚未发布、真盘矩阵尚未执行**，因此这条记录保持“未完成”，直到真盘验收通过并单独获得发布授权。
```

- [ ] **Step 6: 在发布手册里加入组装与 QC 引用**

在 `docs/runbooks/portable-update-release.md` 的第 3 步与第 4 步之间插入：

```markdown
### 3b. 取回并核对构建回执

`pnpm build:portable-launcher` 必须带 `--out <空目录>`，该目录会同时产出 `荣盈魔方启动器.exe` 与 `launcher-build-receipt.json`。

回执**只是防配错与审计元数据**：它是未签名声明，任何人都能伪造，**不是**可信来源证明。组装器会用 `--receipt` 读取它，并对哈希不符、指纹不符、工作树未提交这三类情形**硬拒绝**；对输出目录不一致、回执陈旧或时间在未来只给**警告**。

回执**不得放进交付目录**——交付目录仍然只允许盘根启动器、`荣盈魔方/` 程序目录和 `使用说明.txt` 三样东西。
```

并在第 6 步之后插入：

````markdown
### 6b. 启动器身份挑战（发布期 QC 证据）

```powershell
node scripts/portable-launcher-challenge.mjs --launcher artifacts/荣盈魔方启动器.exe --positive-manifest <本次待发布的 manifest.json>
```

三个结果必须同时成立：启动器报告出真实版本与嵌入公钥指纹；**生产钥匙**签出的正向样本验证通过；工具自行生成的未知钥匙样本验证**失败**。任一条不成立即停止。

这一步**不是**普通 CI 测试：正向样本必须来自生产钥匙，且只在**已授权的离线签名会话**中产生。详情见 `docs/runbooks/portable-launcher-signing-ceremony.md`。
````

- [ ] **Step 7: 标定旧 SCP 记录为历史参考**

`docs/plan/2026-09-19-自主任务队列.md` 的 SCP 记录区域（约 2820–2860 行）**原文保留**，在其上方插入一行：

```markdown
> ⚠️ **历史参考（2026-09-22 标注）**：下面记录的是**旧安装器链路**（`.exe` + `.blockmap` + `latest.yml`）的一次人工 `scp` 操作，**不适用于**当前的整目录 feed（`portable.zip` + `portable-files.json` + `manifest.json`）。它引用的 `dev/deploy-updates-channel-2026-09-18.sh` **在当前可见的 Git 历史里找不到**——不得据此断定该脚本从未存在。可复用的纪律只有三条：临时名上传、上传后复核、manifest 最后原子替换；其中「ASCII 改名」那条在新 feed 上**没有存在理由**（文件名本身已是 ASCII）。
```

- [ ] **Step 8: 门禁与提交**

运行：

```bash
./node_modules/.bin/prettier --write docs/runbooks/portable-launcher-signing-ceremony.md docs/portable-update-key-registry.md docs/runbooks/portable-update-release.md docs/status/2026-09-15-demo-bug-fix-log.md docs/superpowers/plans/2026-09-21-portable-full-directory-update.md docs/plan/2026-09-19-自主任务队列.md
./node_modules/.bin/prettier --check .
git diff --check
```

⚠️ **prettier 会重排有序列表**：`portable-update-release.md` 的 11 步编号与 `2026-09-19-自主任务队列.md` 的编号在 `--write` 之后**必须重读一遍**，确认没有被打乱。若被打乱，改用 `--check` 只报告不修改，并手工修正格式。

确认台账里没有真实值：

```bash
grep -nE "[0-9A-F]{32,}" docs/portable-update-key-registry.md || echo "the registry carries no concrete fingerprint"
```

预期：`the registry carries no concrete fingerprint`。

```bash
git add docs/runbooks/portable-launcher-signing-ceremony.md docs/portable-update-key-registry.md docs/runbooks/portable-update-release.md docs/superpowers/plans/2026-09-21-portable-full-directory-update.md docs/status/2026-09-15-demo-bug-fix-log.md docs/plan/2026-09-19-自主任务队列.md
git commit -m "docs(release): record the signing ceremony, the key registry and the corrections"
```

---

## 完整门禁与验收

每个 Task 后运行：

```bash
pnpm check
```

预期 `exit 0`。失败时按门禁分段处理，**不得混为一谈**：`check:portable-launcher`、`check:portable-update-release`、`check:portable-release-assembly`、`check:udisk-delivery`、`lint`、`typecheck`、`typecheck:tests`、`format:check`、`check:dead-code`、`test`。

**knip 提醒：** `scripts/**` 是 knip 的 entry，因此新脚本的导出不会被判为死代码；但**新脚本文件本身**必须被 `package.json` 的某个 `check:*` 或 workflow 引用，否则它不会被任何入口覆盖——新增脚本时同步接入 `check:portable-release-assembly`。

**验收读数（逐条如实填写，未执行的写“未验证”）：**

| 项            | 命令                                                                          | 读数 |
| ------------- | ----------------------------------------------------------------------------- | ---- |
| PE 检查器     | `node --test scripts/lib/portable-executable.test.mjs`                        | 待填 |
| 回执规则      | `node --test scripts/lib/launcher-receipt.test.mjs`                           | 待填 |
| 组装器 + 审计 | `node --test scripts/lib/udisk-delivery.test.mjs`                             | 待填 |
| QC 判定       | `node --test scripts/lib/portable-launcher-challenge.test.mjs`                | 待填 |
| unsigned 制品 | `node --test scripts/lib/portable-unsigned-artifacts.test.mjs`                | 待填 |
| CI 形态       | `node --test scripts/lib/portable-update-ci.test.mjs`                         | 待填 |
| 假门禁已消失  | `grep -rn "MOFANG_UPDATE_FEED_UPLOAD_TOKEN" .github/ scripts/ docs/runbooks/` | 待填 |
| 台账无真实值  | `grep -nE "[0-9A-F]{32,}" docs/portable-update-key-registry.md`               | 待填 |
| 全量门禁      | `pnpm check`                                                                  | 待填 |

## 未覆盖与后续（不得写成已完成）

- **没有生成任何生产密钥**。密钥的实际生成必须在另获授权后、按 `docs/runbooks/portable-launcher-signing-ceremony.md` 在离线签名仪式中执行。
- **生产发布质检尚未执行**：`portable-launcher-challenge.mjs` 的正向样本需要生产钥匙签出的 manifest，本轮不存在。
- **没有构建客户候选包、没有触碰更新源、没有连接服务器**。
- **Authenticode 未实现**，只作为残留风险记录在台账与手册里。
- host-key 指纹**未核对**：台账中该行保持“待核对”，必须由用户或授权运维人员经可信带外渠道完成。
- **机器可读台账的 `keys` 是空数组**，因此**真实组装在密钥仪式完成之前会被正确硬拒绝**。这是规格 §5.4 要求的行为，不是缺陷；不要为了让组装跑通而放宽台账检查。
- `--test-only` 是一条**显式**旁路，只用于开发夹具：它要求输出目录名以 `_TEST-ONLY-` 开头并记 `warn`。因此它不构成生产绕过入口——一份叫 `_TEST-ONLY-…` 的交付包不可能被当成正式包发出去。
- CI 跑通与否**未验证**：本轮不推送远端，`portable-artifacts.yml` 是否能在 GitHub 上真正执行属于未验证项。

相关：`docs/superpowers/specs/2026-09-22-portable-release-infrastructure-correction-design.md`
