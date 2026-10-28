import { createHash } from 'node:crypto';

/**
 * partner-w-inbox-executor-path-v1 —— BUG-056① 残余（F1）：inbox 只读守卫拿到
 * **执行器同源的终解路径**（M2/runtime 返工批 · runtime owner，2026-10-14）。
 *
 * ## 缺口（补丁前，冻结 runtime 完整执行器实跑复现；r6 终审 runtime 分审 §确定问题）
 *
 * `partner-w-inbox-trusted-cwd-v1` 已把执行器同源 cwd 交给钩子（`ctx.cwd`），普通相对路径
 * `alias/x`（junction → inbox）由此闭合。但执行器对 write/edit 的 `path` 参数还有**第二段**
 * 语义：**前导 `@` 归一再解析** ——
 *   - 字面 `@` 名字存在（`<cwd>/@alias` 或 `<cwd>/@alias/at.txt`）⇒ 把 `@` 当文件名保留；
 *   - 否则 `@` 当"提及符号"**剥掉**（`@alias/at.txt` → `alias/at.txt`）。
 * 守卫在原始参数字符串上做 `isAbsolute/resolve`+realpath 判不出这层 ⇒ 原字节实测：
 *   - `write  '@alias/at.txt'`           未拦截，真实写入 `A/inbox/at.txt`
 *   - `write  '@' + <A>/alias/at-abs.txt` 未拦截，真实写入 `A/inbox/at-abs.txt`
 *   - `edit   '@alias/edit.txt'`          未拦截，真实替换 `A/inbox/edit.txt`
 * （普通 `alias/x` 控制被拒、伪造 `params.cwd` 不改变落点 —— 问题不在 cwd 通道，而在
 *  guard/executor 的路径语义不一致。）
 *
 * ## 同源依据（为什么这就是"执行器实际会写的那个绝对路径"，而不是另一套猜测）
 *
 * write/edit 的宿主执行器链（冻结 runtime 2026.9.3，逐处实读）：
 *   1. 工具包装：`createHostWorkspaceWriteTool/EditTool`（agent-tools.read-*.mjs:772 一带）
 *      → `wrapToolParamValidation(base, REQUIRED_PARAM_GROUPS.write|edit, root)`
 *      （agent-tools.before-tool-call.decision-*.mjs:144）→
 *      `normalizeFileToolPathParamsFromKeys(record, ['path'], root, bridge=undefined)`
 *      (:106) → `normalizeFileToolPathParam(value, root)` (:87) →
 *      `stripMalformedXmlArgValueSuffix` + `normalizeHallucinatedOfficePathExtension` +
 *      `preserveAtPrefixedRelativePath`（path-policy-*.mjs:98）—— 这就是 `@` 语义所在；
 *   2. 基础工具：`createWriteToolDefinition`（resource-loader-*.mjs:7912）/
 *      `createEditToolDefinition`（:6029）里 `resolvePath = options?.operations ? resolveToCwd : …`，
 *      宿主工具都传 operations ⇒ `absolutePath = resolveToCwd(path, cwd)`
 *      （path-utils-*.mjs:41；`expandPath` :28 → `normalizeAtPrefix` :19 剥前导 `@`、`~`/file:// 展开）。
 *
 * 本补丁在钩子派发点（`policyAdjustedToolContext` 构造，hook 模块 :2820）计算
 *   `resolveToCwd(await normalizeFileToolPathParam(params.path, ctx.cwd), ctx.cwd)`
 * —— 两个函数都是**内核里执行器实际调用的同一模块函数**（`normalizeFileToolPathParam`
 * 该模块已 import 自 decision 模块；`resolveToCwd` 由本补丁按导出符号 `a` 从
 * `path-utils-BNJDLd_B.mjs` 新增 import）。钩子先于执行器派发（实测：钩子看到的
 * `params.path` 仍是原始 `@alias/at.txt`），所以这是"在钩子点复现同一次解析"，
 * 不是读执行器的结果 —— 但因复用同一对函数、同一个 `ctx.cwd`（= codingRoot，
 * 与执行器解析根同值，见 trusted-cwd 补丁），链路逐字等价（host 工具分支，无 sandbox bridge）。
 *
 * ## 补丁面（两个锚点，唯一改动点）
 *
 * ① import 行：`import path from "node:path";`（hook 模块 :57）之前插入
 *    `import { a as resolvepartner-wExecutorPathToCwd } from "./path-utils-BNJDLd_B.mjs";`
 *    （新绑定名 `resolvepartner-wExecutorPathToCwd`，与模块内既有标识符零冲突）；
 * ② 单行 → 三行：`const policyAdjustedToolContext = buildToolContext(policyAdjustedToolIdentity);`
 *    （:2820）替换为「计算 `policyAdjustedExecutorPath` + 展开 `{ executorPath }` 的
 *    `policyAdjustedToolContext`」。该 ctx 由 `hookRunner.runBeforeToolCall(event, ctx, receipt)`
 *    （:2852）**原样**交给插件 handler；事件本体、trusted policies 的早先 ctx
 *    （`toolContext`，:1140 一带）与执行器均不动。
 *
 * 行为边界（与 v1 同一纪律）：
 *   - 只对 `toolName ∈ {write, edit}` 且 `params.path` 是非空字符串、`args.ctx.cwd`
 *     是非空字符串时计算；其余工具（含 apply_patch —— 其 derivedPaths 已由内核同 cwd
 *     解析）与无 cwd 路径**不产生** `executorPath` ⇒ 守卫逐字退回既有判定；
 *   - 计算抛错时 `void 0`（不产生字段），不改变钩子派发的健壮性；
 *   - `@` 归一由 `normalizeFileToolPathParam` 原文语义决定：**字面 `@` 名字存在 ⇒ 保留**
 *     （真实 `@report.docx` 不被误判），不存在 ⇒ 剥前导 `@`。"无条件剥 `@`" 在这里
 *     与执行器逐字一致的部分是 `normalizeAtPrefix`（它本就无条件剥）—— 条件性在它之前的
 *     `preserveAtPrefixedRelativePath` 里，两者按执行器同序执行。
 *
 * ## 锚点与 hash（fail-closed，链在 trusted-cwd 补丁之后）
 *
 * 本补丁的输入 = 已打 `partner-w-inbox-trusted-cwd-v1` 的模块文本（r6 随包副本实读）：
 *   - agent-tools.before-tool-call-CHXgDzUI.mjs（v1 后）
 *     470850670e769f9fd3586c1e34b005b9c41afdf18e886c4388659f2b49180a58
 * 未打 v1 / 上游换版 / 锚点漂移 ⇒ 构建期直接失败，不产出静默错包。
 * pack-runtime 接线必须**紧跟** v1 的 writeFileSync 之后（同一文件、链式 hash）。
 */

export const INBOX_EXECUTOR_PATH_ENTRY = 'node_modules/openclaw/dist/agent-tools.before-tool-call-CHXgDzUI.mjs';
/** 输入必须是已打 partner-w-inbox-trusted-cwd-v1 的文本（r6/r7 链式）。 */
export const INBOX_EXECUTOR_PATH_SOURCE_SHA256 = '470850670e769f9fd3586c1e34b005b9c41afdf18e886c4388659f2b49180a58';
export const INBOX_EXECUTOR_PATH_PATCH_ID = 'partner-w-inbox-executor-path-v1';

/** 锚点①（原始）：hook 模块 :57 的裸 node:path import 行。 */
export const INBOX_EXECUTOR_PATH_IMPORT_ANCHOR = 'import path from "node:path";';

/** 锚点①（补丁后）：在其前插入执行器同源的 path-utils 导入（别名避冲突）。 */
export const INBOX_EXECUTOR_PATH_IMPORT_ANCHOR_PATCHED = `import { a as resolvepartner-wExecutorPathToCwd } from "./path-utils-BNJDLd_B.mjs";\nimport path from "node:path";`;

/** 锚点②（原始）：hook 模块 :2820，钩子派发前的 ctx 构造行（两制表符缩进，逐字节）。 */
export const INBOX_EXECUTOR_PATH_CONTEXT_ANCHOR = `\t\tconst policyAdjustedToolContext = buildToolContext(policyAdjustedToolIdentity);`;

/**
 * 锚点②（补丁后）：先算执行器同源终解路径，再把它展开进 ctx。
 *
 * - `toolName ∈ {write, edit}`、`params.path` 非空字符串、`args.ctx.cwd` 非空字符串
 *   才计算（与执行器 `wrapToolParamValidation` 的适用面一致）；
 * - `normalizeFileToolPathParam`（本模块既有 import，:87 的同名函数）=
 *   XML 后缀修复 + 幻觉扩展名修复 + `preserveAtPrefixedRelativePath`（`@` 语义）；
 * - `resolvepartner-wExecutorPathToCwd`（本补丁新增 import，导出符号 `a`）=
 *   执行器 write/edit 的 `resolveToCwd`（path-utils-*.mjs:41，`expandPath` 剥前导 `@`）；
 * - 任一步抛错 ⇒ `void 0`（不产生字段，守卫退回既有判定）。
 */
export const INBOX_EXECUTOR_PATH_CONTEXT_ANCHOR_PATCHED = `\t\tconst policyAdjustedExecutorPath = await (async () => {
\t\t\tif (toolName !== "write" && toolName !== "edit") return void 0;
\t\t\tif (!policyAdjustedParams || typeof policyAdjustedParams !== "object") return void 0;
\t\t\tconst rawExecutorPath = policyAdjustedParams.path;
\t\t\tconst executorPathCwd = args.ctx?.cwd;
\t\t\tif (typeof rawExecutorPath !== "string" || rawExecutorPath.length === 0) return void 0;
\t\t\tif (typeof executorPathCwd !== "string" || executorPathCwd.length === 0) return void 0;
\t\t\ttry {
\t\t\t\tconst normalizedExecutorParam = await normalizeFileToolPathParam(rawExecutorPath, executorPathCwd);
\t\t\t\treturn resolvepartner-wExecutorPathToCwd(normalizedExecutorParam, executorPathCwd);
\t\t\t} catch {
\t\t\t\treturn void 0;
\t\t\t}
\t\t})();
\t\tconst policyAdjustedToolContext = {
\t\t\t...buildToolContext(policyAdjustedToolIdentity),
\t\t\t...typeof policyAdjustedExecutorPath === "string" && policyAdjustedExecutorPath.length > 0 ? { executorPath: policyAdjustedExecutorPath } : {}
\t\t};`;

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function assertAnchor(source, anchor) {
  if (source.split(anchor).length !== 2) throw new Error('inbox executor path anchor drift');
}

/**
 * 给 `agent-tools.before-tool-call-*.mjs` 打 partner-w-inbox-executor-path-v1。
 *
 * - 传入已打 v1 的原文：先按 `expectedHash` 校验（fail-closed），再断言两个锚点各自唯一，最后替换；
 * - 传入已打本补丁的文本（幂等）：反向映射回 v1 文本逐字校验后原样返回；
 * - 未打 v1 / hash 漂移（上游换版）/ 锚点缺失或重复：抛错，构建期失败，不产出静默错包。
 */
export function patchInboxExecutorPathRuntime(source, expectedHash = INBOX_EXECUTOR_PATH_SOURCE_SHA256) {
  const alreadyPatched = source.includes(INBOX_EXECUTOR_PATH_CONTEXT_ANCHOR_PATCHED);
  const original = alreadyPatched
    ? source
        .replace(INBOX_EXECUTOR_PATH_CONTEXT_ANCHOR_PATCHED, INBOX_EXECUTOR_PATH_CONTEXT_ANCHOR)
        .replace(INBOX_EXECUTOR_PATH_IMPORT_ANCHOR_PATCHED, INBOX_EXECUTOR_PATH_IMPORT_ANCHOR)
    : source;
  if (sha256(original) !== expectedHash) throw new Error('inbox executor path source hash drift');
  assertAnchor(original, INBOX_EXECUTOR_PATH_IMPORT_ANCHOR);
  assertAnchor(original, INBOX_EXECUTOR_PATH_CONTEXT_ANCHOR);
  if (alreadyPatched) return source;
  return original
    .replace(INBOX_EXECUTOR_PATH_IMPORT_ANCHOR, INBOX_EXECUTOR_PATH_IMPORT_ANCHOR_PATCHED)
    .replace(INBOX_EXECUTOR_PATH_CONTEXT_ANCHOR, INBOX_EXECUTOR_PATH_CONTEXT_ANCHOR_PATCHED);
}
