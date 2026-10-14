/**
 * 导入收件箱（inbox）只读守卫 —— BUG-030「read by default」的**代码级**落实（质量战役 P3-1）。
 *
 * ## 为什么落点不在 App 自己的文件代码里
 *
 * 用户拖入/导入的文件 = **复制**进 `<workspace>/<taskId>/inbox`（`context/file-import.ts`，
 * 源文件只以 `r` 打开）。inbox 里的副本是模型的**只读参考材料**：生成的新成果应写到
 * 别的目录（任务根 / 生成链自己的输出路径），inbox 永远不该被模型改写。
 *
 * 但模型的写操作**不经过桌面主进程**：write / edit / apply_patch 是网关进程里的内置
 * 工具（`tools.effective` 里 source=core、family=base-coding），主进程只是 WS 客户端，
 * 工具调用只在事后以消息记录出现。运行时的 `tools.fs.workspaceOnly=true` 只把写入关在
 * workspace 里 —— inbox 就在 workspace 里，**它不区分**。
 *
 * 运行时给这类"路径级拒写"留的唯一闸门是插件钩子 `before_tool_call`
 * （返回 `{ block: true, blockReason }` → 该次调用终止，blockReason 就是模型看到的工具结果）。
 * 所以这里做的是：**把守卫插件写进状态目录，并让网关在启动时加载它**。
 *
 * ## 装载的三条硬条件（2026-10-07 真机实验，网关 2026.9.3，逐条实测）
 *
 * 1. `plugins.load.paths` 必须指向**插件目录**（裸 `.mjs` 文件不会被启动加载——加载器
 *    读 `openclaw.plugin.json`）；
 * 2. 目录里必须有 `openclaw.plugin.json`（含 `activation.onStartup: true`）+ `package.json`
 *    （`openclaw.extensions` 指向入口）；
 * 3. 还必须有 `plugins.entries.<id>.enabled = true`（只给 load.paths 不会激活——配置
 *    origin 的插件默认不启用）。
 *
 * ⚠️ **三条缺一，网关照常起、一条日志都不打**（实测：少了任一条，插件不在
 *    "http server listening (N plugins: …)" 名单里，钩子从不运行，而 `plugins list`
 *    仍然显示 `enabled: true`）—— 静默失效是最坏形态，所以这里既写文件也写配置，
 *    且由 `state-config.ts` 在**每次启动**对齐（与 MEMORY_TOOLS_DENIED / 三闸门同一条自愈路径）。
 *
 * ## 规则（不需要意图判断）
 *
 * `inbox` **恒只读**：write / edit / apply_patch（Add / Update / Delete / Move 四个
 * `***` 目标）里出现 `inbox` 目录段一律拒绝。判定分三层（BUG-056①）：
 *
 * 1. **字面段**：分隔符归一、`.`/`..` 折叠、win32 大小写不敏感 + **段尾点/空格归一**
 *    （win32 上 `inbox.` / `inbox ` 与 `inbox` 是同一个目录；Node 的 `\\?\` 路径
 *    不会替我们归一，实测 `realpath('inbox.')` 直接 ENOENT —— 两边都不能漏）。
 * 2. **canonical 段**：绝对路径（以及宿主已解析为绝对的 `derivedPaths`）把
 *    **最深已存在祖先** realpath 掉再拼未创建的后缀 —— symlink/junction 别名、
 *    "新文件的父目录是链接"都在这里拦下。
 * 3. **可信 cwd**：相对路径**只在宿主提供可信 cwd 时**按它解析（与执行器同一
 *    `path.resolve` 语义）。**没有可信 cwd 就只做第 1 层字面判定，绝不拿
 *    `process.cwd()` 去猜** —— 猜错会同时制造误杀和漏杀。
 *    ⚠️ 随包内核 2026.9.3 的 `before_tool_call` **事件本体**不带 cwd（证据：
 *    `openclaw/dist/plugin-entry-*.d.ts` 的 `PluginHookBeforeToolCallEvent` 与内核
 *    `agent-tools.before-tool-call-*.mjs` 的事件构造处），所以可信 cwd 由**配对的窄
 *    runtime 补丁** `rongying-inbox-trusted-cwd-v1`（`scripts/lib/inbox-trusted-cwd-runtime.mjs`，
 *    pack-runtime 构建期 hash/锚点 fail-closed）放进钩子 **ctx**：内核
 *    `buildToolContext` 的返回对象补上 `...args.ctx?.cwd ? { cwd: args.ctx.cwd } : {}`，
 *    而 `hookRunner.runBeforeToolCall(event, ctx, …)` 把 ctx **原样**交给插件 handler。
 *    该 cwd 与 write/edit/apply_patch 执行器解析相对路径用的是**同一个值**
 *    （`codingRoot = sandboxRoot ?? runtimeRoot`：执行器拿它当 cwd，钩子 ctx 也拿它当 cwd；
 *    不读模型 `params.cwd`、不猜 `process.cwd()`）。补丁缺席（旧运行时 / 未接线）：ctx
 *    不带 cwd ⇒ 第 3 层自动退回"只做字面判定"的既有行为，不放宽也不额外收紧。
 * 4. **执行器同源终解路径**（`ctx.executorPath`）：相对 cwd 之外，执行器还会先做
 *    `@` 前缀归一（字面 `@` 名字存在 → 当文件名；否则当"提及符号"剥掉）再把 `path`
 *    解析成绝对路径 —— 守卫在原始参数字符串上**无法**复现这层语义（自己剥 `@`
 *    会误杀真实 `@report.docx` 这类名字）。所以由配对补丁
 *    `rongying-inbox-executor-path-v1`（`scripts/lib/inbox-executor-path-runtime.mjs`）
 *    在钩子 ctx 放入执行器**同一段解析**（`normalizeFileToolPathParam` +
 *    `resolveToCwd`，均为内核里 write/edit 执行器实际调用的函数）算出的绝对落点；
 *    守卫把该落点作为**附加目标**做同一 canonical 判定（只认绝对路径；缺席/畸形 ⇒
 *    逐字退回既有判定）。插件侧禁止任何自行剥 `@` 的字符串规则。
 *
 * 读工具（read / ls）不受影响；正常输出路径（任务根、out/、生成目录）不含 `inbox` 段，
 * 不受影响。
 *
 * 判定逻辑的**唯一真源**是下面这份插件源码（`index.mjs`），随文件写进状态目录；
 * 单测直接从状态目录把那份文件 import 回来钉（测的就是真正会跑的那份代码）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const INBOX_READONLY_PLUGIN_ID = 'rongying-inbox-readonly';
/** 插件目录（相对状态目录）：`<stateDir>/policies/rongying-inbox-readonly/`。 */
export const INBOX_READONLY_POLICY_DIR_NAME = 'policies';

/** 模型看到的拒写文案（zh；它就是那一次工具调用的结果）。 */
export const INBOX_READONLY_BLOCK_REASON =
  '[只读参考材料] 这个文件在导入收件箱（inbox）里，是本次任务的只读参考材料：不能修改、覆盖、删除或重命名。' +
  '如果你需要一份改动后的版本，请把新内容写成其他目录下的新文件（新文件名 / 新版本），不要写进 inbox 目录。';

/** 插件目录的绝对路径。 */
export function inboxReadonlyPolicyDir(stateDir: string): string {
  return path.join(stateDir, INBOX_READONLY_POLICY_DIR_NAME, INBOX_READONLY_PLUGIN_ID);
}

/**
 * 插件源码（`index.mjs`）。
 *
 * ⚠️ 这是**运行在网关进程里**的普通 ESM：不 import 本仓任何东西（跨进程、跨打包边界），
 *    只用 node 内置模块。与 `definePluginEntry` 的等价物就是下面这个默认导出对象。
 */
export const INBOX_READONLY_PLUGIN_ENTRY = `// 荣盈魔方 · 导入收件箱只读守卫（由应用生成，请勿手改）
//
// 规则：write / edit / apply_patch 的目标路径里出现 inbox 目录段一律拒绝。
// 判定三层：①字面段（分隔符归一、. / .. 折叠、win32 大小写不敏感 + 段尾点/空格归一）
// ②绝对路径（含宿主给的 derivedPaths）取最深已存在祖先 realpath 再判
// ③相对路径只在宿主提供可信 cwd（event.cwd / ctx.cwd）时按它解析 ——
//   没有可信 cwd 就只做①，绝不拿 process.cwd 去猜。
//   随包 runtime 补丁 rongying-inbox-trusted-cwd-v1 把「执行器同源 cwd」放进 ctx.cwd。
// ④执行器同源终解路径：write/edit 执行器还会做前导 @ 归一（字面 @ 名字存在当文件名、
//   否则当提及符号剥掉）再解析成绝对路径 —— 插件在原始字符串上无法自己复现。
//   随包 runtime 补丁 rongying-inbox-executor-path-v1 把执行器同源解析后的绝对落点
//   放进 ctx.executorPath（只认绝对路径；缺席/畸形 = 退回①②③，插件绝不自行剥 @）。
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

const BLOCK_REASON =
  ${JSON.stringify(INBOX_READONLY_BLOCK_REASON)};

const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch']);
const WRITE_TARGET_MARKERS = [
  /^\\*\\*\\* Add File: (.+)$/,
  /^\\*\\*\\* Update File: (.+)$/,
  /^\\*\\*\\* Delete File: (.+)$/,
  /^\\*\\*\\* Move to: (.+)$/,
];

function isWindows() {
  return process.platform === 'win32';
}

/**
 * Windows 上段的**段尾点/空格**没有意义（Win32 会剥掉它们，"inbox." 就是 "inbox"）；
 * Node 的 fs 走 \\\\?\\ 前缀又**不会**替我们剥 —— 实测 realpath("inbox.") 直接 ENOENT，
 * 所以字面判定必须自己归一。POSIX 不动（"inbox." 是合法且不同的名字）。
 */
function normalizeSegment(segment) {
  if (!isWindows()) return segment;
  return segment.replace(/[ .]+$/, '').toLowerCase();
}

function splitSegments(value) {
  const text = String(value).replace(/\\\\/g, '/');
  const segments = [];
  for (const raw of text.split('/')) {
    if (!raw || raw === '.') continue;
    if (raw === '..') {
      segments.pop();
      continue;
    }
    segments.push(raw);
  }
  return segments;
}

function hasInboxSegment(segments) {
  return segments.some((segment) => normalizeSegment(segment) === 'inbox');
}

/** realpath 最深的已存在祖先 + 尚未创建的后缀（symlink 别名也按 canonical 判）。 */
function canonicalSegments(target) {
  const absolute = resolve(target);
  const tail = [];
  let probe = absolute;
  for (let guard = 0; guard < 64; guard += 1) {
    try {
      return [...splitSegments(realpathSync.native(probe)), ...tail];
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return splitSegments(absolute);
      tail.unshift(basename(probe));
      probe = parent;
    }
  }
  return splitSegments(absolute);
}

/** 宿主（内核）给的可信工具 cwd —— 只在**是绝对路径**时才算数；不接受任何猜测来源。 */
function trustedCwdOf(event, context) {
  const candidates = [event && event.cwd, context && context.cwd];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() && isAbsolute(candidate.trim())) {
      return candidate.trim();
    }
  }
  return null;
}

/**
 * 执行器同源**终解路径**（runtime 补丁 rongying-inbox-executor-path-v1 放进 ctx）：
 * write/edit 的 path 参数经执行器同一段解析（@ 前缀归一 + 相对路径按执行器 cwd）
 * 后的真实落点。只认绝对路径；缺席/畸形 ⇒ 不作数（退回既有判定）。
 * ⚠️ 不要在这里自己剥 @：真实文件名可以以 @ 开头（字面 @ 名字存在时执行器把 @ 当名字、
 *    不存在时当提及符号剥掉）—— 这段语义只由 runtime 侧与执行器同源实现。
 */
function executorPathOf(context) {
  const candidate = context && context.executorPath;
  if (typeof candidate !== 'string' || !candidate.trim() || !isAbsolute(candidate.trim())) return null;
  return candidate.trim();
}

function targetIsReadonlyInbox(rawTarget, trustedCwd) {
  if (typeof rawTarget !== 'string' || !rawTarget.trim()) return false;
  if (hasInboxSegment(splitSegments(rawTarget))) return true;
  const absoluteTarget = isAbsolute(rawTarget)
    ? resolve(rawTarget)
    : trustedCwd
      ? resolve(trustedCwd, rawTarget)
      : null;
  return absoluteTarget !== null && hasInboxSegment(canonicalSegments(absoluteTarget));
}

function writeTargetsOf(params, derivedPaths) {
  const targets = [];
  if (typeof params.path === 'string') targets.push(params.path);
  if (typeof params.input === 'string' && params.input.includes('*** ')) {
    for (const line of params.input.split('\\n')) {
      for (const marker of WRITE_TARGET_MARKERS) {
        const match = marker.exec(line.trim());
        if (match) targets.push(match[1].trim());
      }
    }
  }
  if (Array.isArray(derivedPaths)) {
    for (const entry of derivedPaths) if (typeof entry === 'string') targets.push(entry);
  }
  return targets;
}

const handler = (event, context) => {
  if (!event || !WRITE_TOOLS.has(event.toolName)) return undefined;
  const params = event.params && typeof event.params === 'object' ? event.params : {};
  const trustedCwd = trustedCwdOf(event, context);
  const targets = writeTargetsOf(params, event.derivedPaths);
  const executorPath = executorPathOf(context);
  if (executorPath) targets.push(executorPath);
  const hit = targets.find((target) => targetIsReadonlyInbox(target, trustedCwd));
  if (!hit) return undefined;
  return { block: true, blockReason: BLOCK_REASON };
};

export default {
  id: '${INBOX_READONLY_PLUGIN_ID}',
  name: '荣盈魔方·导入收件箱只读',
  description: '拒绝把模型的写操作落到导入收件箱（inbox）—— 那是只读的参考材料。',
  register(api) {
    api.on('before_tool_call', handler, { priority: 100 });
  },
};
`;

/** 插件清单。`activation.onStartup` 是"网关启动时加载"的开关（缺了就不加载，实测）。 */
export const INBOX_READONLY_PLUGIN_MANIFEST = `${JSON.stringify(
  {
    id: INBOX_READONLY_PLUGIN_ID,
    name: '荣盈魔方·导入收件箱只读',
    description: '拒绝把模型的写操作落到导入收件箱（inbox）—— 那是只读的参考材料。',
    activation: { onStartup: true },
    configSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  null,
  2,
)}\n`;

/** 包元数据：`openclaw.extensions` 指入口（缺了同样不加载，实测）。 */
export const INBOX_READONLY_PLUGIN_PACKAGE_JSON = `${JSON.stringify(
  {
    name: INBOX_READONLY_PLUGIN_ID,
    version: '1.0.0',
    private: true,
    type: 'module',
    openclaw: { extensions: ['./index.mjs'] },
  },
  null,
  2,
)}\n`;

/** 插件目录里的三个文件（文件名 → 内容）。 */
export function inboxReadonlyPolicyFiles(): Record<string, string> {
  return {
    'openclaw.plugin.json': INBOX_READONLY_PLUGIN_MANIFEST,
    'package.json': INBOX_READONLY_PLUGIN_PACKAGE_JSON,
    'index.mjs': INBOX_READONLY_PLUGIN_ENTRY,
  };
}

function writeFileIfChanged(filePath: string, contents: string): void {
  try {
    if (readFileSync(filePath, 'utf-8') === contents) return;
  } catch {
    // 读不到（不存在/不可读）⇒ 照写。
  }
  const tmpPath = `${filePath}.tmp`;
  let written = false;
  try {
    writeFileSync(tmpPath, contents, 'utf-8');
    written = true;
    renameSync(tmpPath, filePath);
    written = false;
  } finally {
    if (written) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // 尽力清理；真正的错误由上面抛出去。
      }
    }
  }
}

/**
 * 确保状态目录里有守卫插件，返回**插件目录**路径（写进 `plugins.load.paths` 的就是它）。
 *
 * 内容变了才写（每次启动重写会改 mtime，没必要）；写失败**向上抛** —— 调用方
 * （`ensureStateConfig`）据此决定"这次别把配置指过去"（宁可不装，也不要指一个不存在的目录）。
 */
export function ensureInboxReadonlyPolicy(stateDir: string): string {
  const dir = inboxReadonlyPolicyDir(stateDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  for (const [name, contents] of Object.entries(inboxReadonlyPolicyFiles())) {
    writeFileIfChanged(path.join(dir, name), contents);
  }
  return dir;
}
