import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  INBOX_TRUSTED_CWD_ANCHOR,
  INBOX_TRUSTED_CWD_ANCHOR_PATCHED,
  INBOX_TRUSTED_CWD_PATCH_ID,
  INBOX_TRUSTED_CWD_SOURCE_SHA256,
  patchInboxTrustedCwdRuntime,
} from './inbox-trusted-cwd-runtime.mjs';

const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');

/**
 * 源码 fixture = 冻结运行时 `agent-tools.before-tool-call-CHXgDzUI.mjs` 里
 * `buildToolContext` 那一段的**逐字副本**（含制表符缩进），外面套一层最小 wrapper
 * 让它可被求值。真正的防漂移靠两处：①本模块的 sha256 锚点（构建期 fail-closed）；
 * ②下方 `real module` 用例在给出冻结模块路径时按字节校验原文并实打一遍。
 */
const contextFixture = `function buildHookContextOf(args, freezeDiagnosticTraceContext) {
\t\tconst toolName = "write";
\t\tconst toolIdentity = { toolKind: "base-coding" };
\t\tconst buildToolContext = (identity) => ({
\t\t\ttoolName,
\t\t\t...identity,
\t\t\t...args.ctx?.agentId && { agentId: args.ctx.agentId },
\t\t\t...args.ctx?.sessionKey && { sessionKey: args.ctx.sessionKey },
\t\t\t...args.ctx?.sessionId && { sessionId: args.ctx.sessionId },
\t\t\t...args.ctx?.runId && { runId: args.ctx.runId },
\t\t\t...args.signal ? { abortSignal: args.signal } : {},
\t\t\t...args.ctx?.trace && { trace: freezeDiagnosticTraceContext(args.ctx.trace) },
\t\t\t...args.toolCallId && { toolCallId: args.toolCallId },
\t\t\t...args.ctx?.channelId && { channelId: args.ctx.channelId },
\t\t\t...args.ctx?.requester ? { requester: args.ctx.requester } : {}
\t\t});
\t\treturn buildToolContext(toolIdentity);
}`;

const fixtureHash = (source) => sha256Hex(source);

function evaluate(buildContextSource) {
  return new Function(`${buildContextSource}\nreturn buildHookContextOf;`)();
}

const passthroughFreeze = (trace) => trace;

test('RED baseline: fixture 里 buildToolContext 丢掉 args.ctx.cwd（hook ctx 没有可信 cwd）', () => {
  const buildContextOf = evaluate(contextFixture);
  const ctx = buildContextOf(
    { ctx: { cwd: 'D:\\scratch\\A', agentId: 'main', sessionKey: 's', runId: 'r' }, toolCallId: 'c1' },
    passthroughFreeze,
  );
  assert.equal(ctx.cwd, undefined, '补丁前的 hook ctx 不得携带 cwd（否则 RED 前提不成立）');
  assert.equal(ctx.agentId, 'main', '相邻身份字段仍在（缺口只在 cwd 一个字段）');
  assert.equal(ctx.runId, 'r');
});

test('补丁后：ctx.cwd 来自 args.ctx.cwd（执行器同源值），不是 params/其它来源', () => {
  const patched = patchInboxTrustedCwdRuntime(contextFixture, fixtureHash(contextFixture));
  assert.ok(patched.includes(INBOX_TRUSTED_CWD_ANCHOR_PATCHED));
  const buildContextOf = evaluate(patched);

  const ctx = buildContextOf(
    {
      ctx: { cwd: 'D:\\scratch\\A', agentId: 'main', sessionKey: 's', sessionId: 'sid', runId: 'r' },
      // 模型伪造的 params.cwd 不在 buildToolContext 的输入面里：它不可能进入 ctx
      params: { cwd: 'D:\\decoy' },
      toolCallId: 'c1',
    },
    passthroughFreeze,
  );
  assert.equal(ctx.cwd, 'D:\\scratch\\A');
  assert.notEqual(ctx.cwd, 'D:\\decoy');

  // 无可信 cwd 的调用路径：字段整体不出现（守卫回到补丁前的字面判定，不多不少）
  for (const ctxInput of [undefined, {}, { cwd: undefined }, { cwd: '' }]) {
    const bare = buildContextOf({ ctx: ctxInput, toolCallId: 'c2' }, passthroughFreeze);
    assert.equal(Object.hasOwn(bare, 'cwd'), false, `ctx.cwd 不得为 ${JSON.stringify(ctxInput)} 生成`);
  }
});

test('补丁只增加 cwd 一个字段：其余 ctx 键集合逐字不变', () => {
  const args = {
    ctx: { cwd: 'D:\\scratch\\A', agentId: 'main', sessionKey: 's', sessionId: 'sid', runId: 'r', channelId: 'ch' },
    signal: undefined,
    toolCallId: 'c1',
  };
  const before = evaluate(contextFixture)(args, passthroughFreeze);
  const after = evaluate(patchInboxTrustedCwdRuntime(contextFixture, fixtureHash(contextFixture)))(
    args,
    passthroughFreeze,
  );
  const beforeKeys = Object.keys(before).sort();
  const afterKeys = Object.keys(after).sort();
  assert.deepEqual(
    afterKeys.filter((key) => key !== 'cwd'),
    beforeKeys,
    '除新增 cwd 外，键集合必须与补丁前一致',
  );
  assert.deepEqual({ ...after, cwd: undefined }, { ...before, cwd: undefined }, '除 cwd 外，字段值必须与补丁前一致');
});

test('patch mechanics: idempotent, hash-pinned, anchor-pinned（漂移 fail-closed）', () => {
  const patched = patchInboxTrustedCwdRuntime(contextFixture, fixtureHash(contextFixture));
  // 二次执行幂等：再打一遍返回逐字同一份
  assert.equal(patchInboxTrustedCwdRuntime(patched, fixtureHash(contextFixture)), patched);
  // 源 hash 漂移 ⇒ 拒绝
  assert.throws(
    () => patchInboxTrustedCwdRuntime(`${contextFixture}\n// drift`, fixtureHash(contextFixture)),
    /hash drift/,
  );
  // 锚点缺失 ⇒ 拒绝
  const anchorBroken = contextFixture.replace(
    'const buildToolContext = (identity) => ({',
    'const renamedToolContext = (identity) => ({',
  );
  assert.throws(() => patchInboxTrustedCwdRuntime(anchorBroken, fixtureHash(anchorBroken)), /anchor drift/);
  // 锚点重复（例如将来出现第二处同形构造）⇒ 拒绝，绝不猜打哪一处
  const duplicated = contextFixture.replace(
    '\t\tconst toolIdentity',
    `${INBOX_TRUSTED_CWD_ANCHOR}\n\t\tconst toolIdentity`,
  );
  assert.equal(duplicated.split(INBOX_TRUSTED_CWD_ANCHOR).length, 3, '构造夹具：锚点必须出现两次');
  assert.throws(() => patchInboxTrustedCwdRuntime(duplicated, fixtureHash(duplicated)), /anchor drift/);
});

test('patch id 与入口常量形状固定（pack-runtime 接线与 manifest 标记靠它们）', () => {
  assert.equal(INBOX_TRUSTED_CWD_PATCH_ID, 'rongying-inbox-trusted-cwd-v1');
  assert.match(INBOX_TRUSTED_CWD_SOURCE_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(INBOX_TRUSTED_CWD_ANCHOR_PATCHED.includes(INBOX_TRUSTED_CWD_ANCHOR), false);
});

/**
 * 真实冻结模块校验（可选加固）：给出 r5 归档里解出的 dist 目录即可按字节核对 +
 * 实打一遍补丁。**未打 / 已打补丁的模块都接受**——已打时按模块自身的反向映射还原
 * 原始字节再比 pin（指到别的版本/被第三方改过 ⇒ 仍 fail-closed）。
 * 没有该环境时**显式跳过并说明**（不假装通过）。
 *   M2_RUNTIME_MODULE_DIR=<...>/node_modules/openclaw/dist
 */
test('real module: 冻结模块字节与锚点 hash 一致，补丁可实打且幂等（需 M2_RUNTIME_MODULE_DIR）', (t) => {
  const distDir = process.env.M2_RUNTIME_MODULE_DIR;
  if (!distDir) {
    t.skip('M2_RUNTIME_MODULE_DIR 未设置：跳过冻结模块字节校验（原生链 GREEN 由 M2 harness 另行实跑）');
    return;
  }
  const modulePath = path.join(distDir, 'agent-tools.before-tool-call-CHXgDzUI.mjs');
  const source = fs.readFileSync(modulePath, 'utf-8');
  const alreadyPatched = source.includes(INBOX_TRUSTED_CWD_ANCHOR_PATCHED);
  const original = alreadyPatched ? source.replace(INBOX_TRUSTED_CWD_ANCHOR_PATCHED, INBOX_TRUSTED_CWD_ANCHOR) : source;
  assert.equal(sha256Hex(original), INBOX_TRUSTED_CWD_SOURCE_SHA256, '冻结模块字节与锚点 hash 不一致（fail-closed）');
  assert.equal(original.split(INBOX_TRUSTED_CWD_ANCHOR).length, 2, '锚点在冻结模块里必须唯一命中');
  const patched = patchInboxTrustedCwdRuntime(source);
  assert.equal(patched.split(INBOX_TRUSTED_CWD_ANCHOR_PATCHED).length, 2);
  assert.equal(patchInboxTrustedCwdRuntime(patched), patched, '幂等');
  if (alreadyPatched) assert.equal(patched, source, '已打补丁的冻结模块必须原样返回');
});
