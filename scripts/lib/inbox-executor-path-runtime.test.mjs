import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  INBOX_EXECUTOR_PATH_CONTEXT_ANCHOR,
  INBOX_EXECUTOR_PATH_CONTEXT_ANCHOR_PATCHED,
  INBOX_EXECUTOR_PATH_ENTRY,
  INBOX_EXECUTOR_PATH_IMPORT_ANCHOR,
  INBOX_EXECUTOR_PATH_IMPORT_ANCHOR_PATCHED,
  INBOX_EXECUTOR_PATH_PATCH_ID,
  INBOX_EXECUTOR_PATH_SOURCE_SHA256,
  patchInboxExecutorPathRuntime,
} from './inbox-executor-path-runtime.mjs';
import { INBOX_TRUSTED_CWD_ANCHOR_PATCHED } from './inbox-trusted-cwd-runtime.mjs';

const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-executor-path-'));
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

/**
 * 行为夹具 = 冻结运行时 `agent-tools.before-tool-call-CHXgDzUI.mjs` 里
 * 「import 行（:57）+ `policyAdjustedToolContext` 构造行（:2820）」的**逐字副本**
 * （含制表符缩进），外面套一层最小 wrapper。补丁后按真实词法 import 旁边的
 * `./path-utils-BNJDLd_B.mjs` façade（代打 exec 侧 `resolveToCwd` 的导出符号 `a`）。
 * 真正的防漂移靠两处：①模块 sha256 锚点（构建期 fail-closed）；②下方 real module
 * 用例按冻结字节核对并实打。
 */
const fixtureSource = `import path from "node:path";

globalThis.__F1_EXECUTOR_PATH_CALLS = [];

export function normalizeFileToolPathParam(value, cwd) {
  (globalThis.__F1_EXECUTOR_PATH_CALLS ??= []).push(["normalize", value, cwd]);
  if (value === "__THROW__") throw new Error("normalize boom");
  if (value === "@literal/ok.txt") return "./@literal/ok.txt";
  return value.startsWith("@") ? value.slice(1) : value;
}

export async function buildHookContextOf(args, toolName, policyAdjustedParams) {
  const buildToolContext = (identity) => ({ toolName, ...identity });
  const policyAdjustedToolIdentity = { toolKind: "base-coding" };
\t\tconst policyAdjustedToolContext = buildToolContext(policyAdjustedToolIdentity);
  return policyAdjustedToolContext;
}
`;

const facadeSource = `import path from "node:path";
export function a(filePath, cwd) {
  (globalThis.__F1_EXECUTOR_PATH_CALLS ??= []).push(["resolve", filePath, cwd]);
  return path.resolve(cwd, filePath);
}
`;

let fixtureSeq = 0;
async function loadFixture(source) {
  fixtureSeq += 1;
  const dir = path.join(tempRoot, `case-${fixtureSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'path-utils-BNJDLd_B.mjs'), facadeSource);
  const file = path.join(dir, `fixture-${fixtureSeq}.mjs`);
  fs.writeFileSync(file, source);
  return import(pathToFileURL(file).href);
}

const CWD = 'D:\\scratch\\A';

test('RED baseline: 未打补丁的 ctx 构造不带 executorPath（@ 别名改写缺口的前提）', async () => {
  assert.ok(fixtureSource.includes(INBOX_EXECUTOR_PATH_CONTEXT_ANCHOR), '夹具必须逐字包含锚点②');
  assert.ok(fixtureSource.includes(INBOX_EXECUTOR_PATH_IMPORT_ANCHOR), '夹具必须逐字包含锚点①');
  const mod = await loadFixture(fixtureSource);
  const ctx = await mod.buildHookContextOf({ ctx: { cwd: CWD } }, 'write', { path: '@alias/at.txt' });
  assert.equal(ctx.executorPath, undefined, '补丁前的 ctx 不得携带 executorPath（RED 前提）');
  assert.equal(ctx.cwd, undefined, '该夹具只钉 executorPath 锚点；v1 的 cwd 由 sibling 模块覆盖');
});

test('补丁后：executorPath = 执行器同源「@ 归一 + resolveToCwd」链，调用形状逐字（同参同序）', async () => {
  const patched = patchInboxExecutorPathRuntime(fixtureSource, sha256Hex(fixtureSource));
  assert.ok(patched.includes(INBOX_EXECUTOR_PATH_CONTEXT_ANCHOR_PATCHED));
  assert.ok(patched.includes(INBOX_EXECUTOR_PATH_IMPORT_ANCHOR_PATCHED));
  const mod = await loadFixture(patched);

  const ctx = await mod.buildHookContextOf({ ctx: { cwd: CWD }, toolCallId: 'c1' }, 'write', {
    path: '@alias/at.txt',
    content: 'x',
  });
  assert.equal(ctx.executorPath, path.resolve(CWD, 'alias/at.txt'));
  assert.deepEqual(globalThis.__F1_EXECUTOR_PATH_CALLS, [
    ['normalize', '@alias/at.txt', CWD],
    ['resolve', 'alias/at.txt', CWD],
  ]);
  // 相邻身份字段不丢（只增量展开一个字段）
  assert.equal(ctx.toolName, 'write');
  assert.equal(ctx.toolKind, 'base-coding');

  // 字面 @ 名字：normalize 返回 "./@literal/…" 时，链路原样透传（ctx 侧没有再剥一次 @）
  globalThis.__F1_EXECUTOR_PATH_CALLS = [];
  const literal = await mod.buildHookContextOf({ ctx: { cwd: CWD } }, 'write', { path: '@literal/ok.txt' });
  assert.equal(literal.executorPath, path.resolve(CWD, './@literal/ok.txt'));
  assert.deepEqual(globalThis.__F1_EXECUTOR_PATH_CALLS, [
    ['normalize', '@literal/ok.txt', CWD],
    ['resolve', './@literal/ok.txt', CWD],
  ]);
});

test('只计算 write/edit：read/apply_patch/其它工具名不产生 executorPath', async () => {
  const patched = patchInboxExecutorPathRuntime(fixtureSource, sha256Hex(fixtureSource));
  const mod = await loadFixture(patched);
  const edit = await mod.buildHookContextOf({ ctx: { cwd: CWD } }, 'edit', {
    path: '@alias/edit.txt',
    edits: [{ oldText: 'a', newText: 'b' }],
  });
  assert.equal(edit.executorPath, path.resolve(CWD, 'alias/edit.txt'));
  for (const toolName of ['read', 'apply_patch', 'exec', 'ls']) {
    const ctx = await mod.buildHookContextOf({ ctx: { cwd: CWD } }, toolName, { path: '@alias/at.txt' });
    assert.equal(Object.hasOwn(ctx, 'executorPath'), false, `${toolName} 不得产生 executorPath`);
  }
});

test('缺 cwd / path 非字符串 / 空串 / 抛错 ⇒ 字段整体不出现（退回既有判定，不放宽）', async () => {
  const patched = patchInboxExecutorPathRuntime(fixtureSource, sha256Hex(fixtureSource));
  const mod = await loadFixture(patched);
  const cases = [
    [{ ctx: undefined }, 'write', { path: '@alias/at.txt' }],
    [{ ctx: {} }, 'write', { path: '@alias/at.txt' }],
    [{ ctx: { cwd: '' } }, 'write', { path: '@alias/at.txt' }],
    [{ ctx: { cwd: 42 } }, 'write', { path: '@alias/at.txt' }],
    [{ ctx: { cwd: CWD } }, 'write', { path: '' }],
    [{ ctx: { cwd: CWD } }, 'write', { path: 42 }],
    [{ ctx: { cwd: CWD } }, 'write', undefined],
    [{ ctx: { cwd: CWD } }, 'write', { path: '__THROW__' }],
  ];
  for (const [args, toolName, params] of cases) {
    const ctx = await mod.buildHookContextOf(args, toolName, params);
    assert.equal(
      Object.hasOwn(ctx, 'executorPath'),
      false,
      `此输入不得产生 executorPath: ${JSON.stringify({ args, toolName, params })}`,
    );
  }
});

test('patch mechanics: idempotent, hash-pinned, 两个锚点缺失/重复都 fail-closed', () => {
  const patched = patchInboxExecutorPathRuntime(fixtureSource, sha256Hex(fixtureSource));
  // 二次执行幂等：反向映射校验后原样返回
  assert.equal(patchInboxExecutorPathRuntime(patched, sha256Hex(fixtureSource)), patched);
  // 源 hash 漂移 ⇒ 拒绝
  assert.throws(
    () => patchInboxExecutorPathRuntime(`${fixtureSource}\n// drift`, sha256Hex(fixtureSource)),
    /hash drift/,
  );
  // 锚点①（import 行）缺失 ⇒ 拒绝
  const importBroken = fixtureSource.replace(INBOX_EXECUTOR_PATH_IMPORT_ANCHOR, 'import nope from "node:path";');
  assert.throws(() => patchInboxExecutorPathRuntime(importBroken, sha256Hex(importBroken)), /anchor drift/);
  // 锚点②（ctx 构造行）缺失 ⇒ 拒绝
  const contextBroken = fixtureSource.replace(
    'const policyAdjustedToolContext = buildToolContext(policyAdjustedToolIdentity);',
    'const renamed = buildToolContext(policyAdjustedToolIdentity);',
  );
  assert.throws(() => patchInboxExecutorPathRuntime(contextBroken, sha256Hex(contextBroken)), /anchor drift/);
  // 锚点②重复 ⇒ 拒绝，绝不猜打哪一处
  const duplicated = fixtureSource.replace(
    INBOX_EXECUTOR_PATH_CONTEXT_ANCHOR,
    `${INBOX_EXECUTOR_PATH_CONTEXT_ANCHOR}\n${INBOX_EXECUTOR_PATH_CONTEXT_ANCHOR}`,
  );
  assert.equal(duplicated.split(INBOX_EXECUTOR_PATH_CONTEXT_ANCHOR).length, 3, '构造夹具：锚点必须出现两次');
  assert.throws(() => patchInboxExecutorPathRuntime(duplicated, sha256Hex(duplicated)), /anchor drift/);
  // 锚点①重复 ⇒ 拒绝
  const duplicatedImport = fixtureSource.replace(
    INBOX_EXECUTOR_PATH_IMPORT_ANCHOR,
    `${INBOX_EXECUTOR_PATH_IMPORT_ANCHOR}\n${INBOX_EXECUTOR_PATH_IMPORT_ANCHOR}`,
  );
  assert.throws(() => patchInboxExecutorPathRuntime(duplicatedImport, sha256Hex(duplicatedImport)), /anchor drift/);
});

test('patch id 与入口常量形状固定（pack-runtime 接线与 manifest 标记靠它们）', () => {
  assert.equal(INBOX_EXECUTOR_PATH_PATCH_ID, 'partner-w-inbox-executor-path-v1');
  assert.equal(INBOX_EXECUTOR_PATH_ENTRY, 'node_modules/openclaw/dist/agent-tools.before-tool-call-CHXgDzUI.mjs');
  assert.match(INBOX_EXECUTOR_PATH_SOURCE_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(INBOX_EXECUTOR_PATH_CONTEXT_ANCHOR_PATCHED.includes(INBOX_EXECUTOR_PATH_CONTEXT_ANCHOR), false);
});

/**
 * 真实冻结模块校验（可选加固）：给出解包后的 dist 目录即可按字节核对 + 实打补丁。
 * **链式前提**：输入必须是已打 `partner-w-inbox-trusted-cwd-v1` 的文本（本批 pack-runtime
 * 接线就是 v1 → executor-path 顺序写入同一文件）。已打/未打本补丁都接受；指向别的版本
 * 或第三方改过的字节 ⇒ fail-closed。没有该环境时**显式跳过并说明**（不假装通过）。
 *   M2_RUNTIME_MODULE_DIR=<...>/node_modules/openclaw/dist
 */
test('real module: v1 链上字节 hash/锚点一致，补丁可实打且幂等（需 M2_RUNTIME_MODULE_DIR）', (t) => {
  const distDir = process.env.M2_RUNTIME_MODULE_DIR;
  if (!distDir) {
    t.skip('M2_RUNTIME_MODULE_DIR 未设置：跳过冻结模块字节校验（原生链 GREEN 由 F1 harness 另行实跑）');
    return;
  }
  const modulePath = path.join(distDir, path.basename(INBOX_EXECUTOR_PATH_ENTRY));
  const source = fs.readFileSync(modulePath, 'utf-8');
  assert.ok(source.includes(INBOX_TRUSTED_CWD_ANCHOR_PATCHED), '链式前提：模块必须已打 partner-w-inbox-trusted-cwd-v1');
  const alreadyPatched = source.includes(INBOX_EXECUTOR_PATH_CONTEXT_ANCHOR_PATCHED);
  const v1Text = alreadyPatched
    ? source
        .replace(INBOX_EXECUTOR_PATH_CONTEXT_ANCHOR_PATCHED, INBOX_EXECUTOR_PATH_CONTEXT_ANCHOR)
        .replace(INBOX_EXECUTOR_PATH_IMPORT_ANCHOR_PATCHED, INBOX_EXECUTOR_PATH_IMPORT_ANCHOR)
    : source;
  assert.equal(sha256Hex(v1Text), INBOX_EXECUTOR_PATH_SOURCE_SHA256, 'v1 链上字节与锚点 hash 不一致（fail-closed）');
  assert.equal(v1Text.split(INBOX_EXECUTOR_PATH_CONTEXT_ANCHOR).length, 2, '锚点②在冻结模块里必须唯一命中');
  assert.equal(v1Text.split(INBOX_EXECUTOR_PATH_IMPORT_ANCHOR).length, 2, '锚点①在冻结模块里必须唯一命中');
  const patched = patchInboxExecutorPathRuntime(source);
  assert.equal(patched.split(INBOX_EXECUTOR_PATH_CONTEXT_ANCHOR_PATCHED).length, 2);
  assert.equal(patchInboxExecutorPathRuntime(patched), patched, '幂等');
  if (alreadyPatched) assert.equal(patched, source, '已打补丁的冻结模块必须原样返回');
  // v1 的 cwd 补丁必须原样留存（两补丁互不覆盖）
  assert.equal(patched.split(INBOX_TRUSTED_CWD_ANCHOR_PATCHED).length, 2);
});
