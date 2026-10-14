import { createHash } from 'node:crypto';

/**
 * rongying-inbox-trusted-cwd-v1 —— BUG-056①：inbox 只读守卫的「可信 cwd」从执行器
 * 真正同源地传进 `before_tool_call` 钩子 ctx（M2 · runtime/inbox 守卫 owner，2026-10-14）。
 *
 * ## 缺口（补丁前，冻结 runtime 完整执行器实跑复现）
 *
 * 应用侧插件 `rongying-inbox-readonly`（见 `packages/desktop/src/main/guard/inbox-readonly.ts`）
 * 有三层判定：①字面 `inbox` 段；②绝对路径 / derivedPaths 的 canonical 祖先 realpath；
 * ③**相对路径只在宿主给出可信绝对 cwd 时**按它解析（`event.cwd` / `ctx.cwd`），
 * 没有可信 cwd 就只做第 ① 层，绝不拿 `process.cwd()` 去猜（猜错会同时制造误杀和漏杀）。
 *
 * 但 2026.9.3 内核在 `runBeforeToolCallHook → buildToolContext`（本模块锚点所在文件）
 * 构造 hook ctx 时**没有把执行器实际 cwd 传进去**。于是 `alias → <根>/inbox` 这类链接
 * 别名 + 相对路径 `alias/x`：既没有字面 `inbox` 段，又没有可信 cwd 可用 ⇒ 第 ③ 层永远
 * "契约就绪、等宿主给"。
 *
 * M2 原生链 harness（冻结 r5 runtime 完整 `write`/`edit`/`apply_patch` 执行器 + 原生
 * `finalizeAgentTools`/`runBeforeToolCallHook` 派发 + 应用真实生成的守卫插件）复现：
 *   - `write alias/ref.docx`（junction 与目录 symlink 同形，cwd=根 A）未被拒，
 *     文件真实落在 `A/inbox/ref.docx`（**字节变化**）；`edit`、新建文件同形；
 *     模型伪造 `params.cwd` 不改变落点（执行器根仍是 A）。
 *   - 同形 `alias → A/out` 放行、`apply_patch` 相对/绝对路径经 junction 已被拦
 *     （内核既有的 apply_patch 专用 derivedPaths 用同一 cwd 解析）——这两条是补丁
 *     不得回退的既有行为。
 *
 * ## 同源依据（为什么把 `args.ctx.cwd` 交给钩子就是"执行器实际根"，而不是猜测）
 *
 * 内核 `agent-tools-*.mjs` 里 `codingRoot = sandboxRoot ?? runtimeRoot` 是**同一个变量**，
 * 同一处 `hookContext` 构造把 `cwd: codingRoot` 交给所有工具钩子（产品 hookContext
 * 构造点），而：
 *   - write/edit 执行器：`createHostWorkspaceWriteTool/EditTool(options.codingRoot, …)`
 *     → `createWriteTool/EditTool(cwd=codingRoot)`，相对路径解析就是 `resolve(codingRoot, path)`；
 *   - apply_patch：`createApplyPatchTool({ cwd: options.codingRoot, root: options.containmentRoot })`；
 *   - 既有 `deriveOptions.cwd = args.ctx?.cwd`（apply_patch 的 derivedPaths 已经在吃这个 cwd）。
 * 所以 `args.ctx.cwd` **就是**执行器解析相对路径用的那个根：同一次构造、同一个值。
 * 补丁不读模型 `params.cwd`、不猜 `process.cwd()`、不自行拼路径。
 *
 * sandbox 分支：`codingRoot = sandbox.workspaceDir`，是 sandbox 工作区的**宿主路径**
 * （guest 侧路径在 `sandbox.containerWorkdir`，两字段分开存放）；sandbox 下的
 * write/edit/apply_patch 同样把相对路径解析在这个宿主根上（bridge 调用统一带
 * `cwd: root`）。因此把 `args.ctx.cwd` 交给守卫不会把 guest 路径当 host canonical。
 *
 * ## 补丁面（唯一改动点）
 *
 * `buildToolContext` 返回的 hook ctx 增加 `cwd`（`...args.ctx?.cwd ? { cwd: args.ctx.cwd } : {}`）。
 * 该 ctx 由 `hookRunner.runBeforeToolCall(event, ctx, receipt)` **原样**交给插件
 * `before_tool_call` handler（第二参数），也交给 trusted tool policies。事件本体
 * （hookEvent，`:2851` 一带）不动；执行器、apply_patch path parser、共享 normalize 均不动。
 *
 * 缺 `args.ctx.cwd` 的调用路径：ctx 照旧**不带** cwd ⇒ 守卫行为与补丁前逐字相同
 * （只做字面判定）——本补丁不改变任何"无 cwd"路径的决策，也不放开任何额外写入面。
 *
 * 锚点 = 冻结 runtime 2026.9.3 原始模块 sha256（r5 归档实读；M2 原生链 harness 运行的
 * 就是这份字节）：
 *   - agent-tools.before-tool-call-CHXgDzUI.mjs
 *     5fd613210587d87085d3da02d8509b0bf01a75ad8bcfc9d91b2432c9176e959c
 * 上游换版 ⇒ 构建期 hash 漂移直接失败（fail-closed），不静默改错文件。
 */

export const INBOX_TRUSTED_CWD_ENTRY = 'node_modules/openclaw/dist/agent-tools.before-tool-call-CHXgDzUI.mjs';
export const INBOX_TRUSTED_CWD_SOURCE_SHA256 = '5fd613210587d87085d3da02d8509b0bf01a75ad8bcfc9d91b2432c9176e959c';
export const INBOX_TRUSTED_CWD_PATCH_ID = 'rongying-inbox-trusted-cwd-v1';

/** 锚点（原始文本；含制表符缩进，取自冻结模块 :2736 一带，逐字节）。 */
export const INBOX_TRUSTED_CWD_ANCHOR = `\t\tconst buildToolContext = (identity) => ({
\t\t\ttoolName,
\t\t\t...identity,
\t\t\t...args.ctx?.agentId && { agentId: args.ctx.agentId },`;

/** 锚点（补丁后文本）：在 `...identity,` 之后插入执行器同源可信 cwd。 */
export const INBOX_TRUSTED_CWD_ANCHOR_PATCHED = `\t\tconst buildToolContext = (identity) => ({
\t\t\ttoolName,
\t\t\t...identity,
\t\t\t...args.ctx?.cwd ? { cwd: args.ctx.cwd } : {},
\t\t\t...args.ctx?.agentId && { agentId: args.ctx.agentId },`;

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function assertAnchor(source, anchor) {
  if (source.split(anchor).length !== 2) throw new Error('inbox trusted cwd anchor drift');
}

/**
 * 给 `agent-tools.before-tool-call-*.mjs` 打 rongying-inbox-trusted-cwd-v1。
 *
 * - 传入未打补丁的原文：先按 `expectedHash` 校验原文（fail-closed），再断言锚点唯一，最后替换；
 * - 传入已打补丁的文本（幂等）：逐字返回原样；
 * - hash 漂移（上游换版）或锚点缺失/重复：抛错，构建期失败，不产出静默错包。
 */
export function patchInboxTrustedCwdRuntime(source, expectedHash = INBOX_TRUSTED_CWD_SOURCE_SHA256) {
  const alreadyPatched = source.includes(INBOX_TRUSTED_CWD_ANCHOR_PATCHED);
  const original = alreadyPatched ? source.replace(INBOX_TRUSTED_CWD_ANCHOR_PATCHED, INBOX_TRUSTED_CWD_ANCHOR) : source;
  if (sha256(original) !== expectedHash) throw new Error('inbox trusted cwd source hash drift');
  assertAnchor(original, INBOX_TRUSTED_CWD_ANCHOR);
  if (alreadyPatched) return source;
  return original.replace(INBOX_TRUSTED_CWD_ANCHOR, INBOX_TRUSTED_CWD_ANCHOR_PATCHED);
}
