import path from 'node:path';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import type { ToolCall } from '@clawwork/shared';
import { readWorkspaceBytes } from '../slidegen/source-file.js';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const WRITE_TOOLS = new Set(['write', 'write_file']);
const EDIT_TOOLS = new Set(['edit', 'apply_patch']);

/**
 * ⭐ T23（2026-10-16 本地全量执行 · Owner D，产物侧半边）：**可信 nativeInputTarget
 * 从源端（模型自己的 exec 命令）接通到生产调用点**。
 *
 * 现场：模型是用 **exec 工具**跑
 * `node "<skill>/deck-layout/scripts/generate.cjs" "<file>.native-ppt.json"`（改稿时再加
 * `--previous "<r>.receipt.json"`）发起原生渲染的 —— 命令里那个 `.native-ppt.json` 参数
 * 就是**模型自己指名**要渲染的那一份。它是"执行身份"的源端声明，不是数组序 / 收包时间 /
 * mtime 这类**猜测**（那三条是 BUG-046③ / BUG-054 实证不可信的）。所以它在 mtime 平局时
 * 可以用于消歧 —— 但仍然**只在并列候选里**生效（见 `nativeInputFromCompletedWrites`）。
 *
 * ⚠️ 网关把 exec 回包的 `name` 记为 `exec`（与 `core/gateway-dispatcher` 的判据同源）。
 *
 * ⭐ T23 源端半边（2026-10-16 本地全量执行 · 执行身份来源，`NativeInputOptions.execOrder`）：
 * 上面的"模型自己指名的目标"仍留一个死局 —— 两条 exec **指名不同**源文件时无从裁决。
 * 现在补上**运行时自己的执行记录**：agent `item` 通道的 `toolCallId` / `startedAt` /
 * `endedAt` 由调用方（run 收尾）压成 `execOrder` 显式透传，取**最后真的跑过**那条 exec 的
 * 目标。它同样不是猜测（运行时执行序 ≠ 数组序 ≠ 收包时刻），且**缺它就照旧 fail-closed**。
 */
const EXEC_TOOL_NAMES = new Set(['exec']);
const NATIVE_SOURCE_SUFFIX = '.native-ppt.json';

const DIRECT_HELPER = /deck-layout[\\/]+scripts[\\/]+generate\.cjs/i;
/** `cd <目录>`（引号可选）：`cd "x/deck-layout" && ...` / `cd x/deck-layout; ...`。 */
const CD_PREFIX = /(?:^|[^\w])cd\s+(?:"([^"]+)"|'([^']+)'|([^\s&|;]+))/i;
/**
 * 相对形态的 helper（`scripts/generate.cjs`，不带 `deck-layout/` 前缀）。
 *
 * ⚠️ **必须有 token 左边界**（2026-10-17 统一审核 §T23② 反例）。没有边界时，
 *    `cd "<...>/deck-layout" && node other/scripts/generate.cjs "a.native-ppt.json"`
 *    里**更深路径**的 `other/scripts/generate.cjs`（**不是** deck-layout 的 helper）
 *    也会被当成 helper ⇒ 读出的目标是另一个脚本渲的 —— 一次**有界误认**。
 *
 * 边界 = `scripts` 前面**必须是 token 起点**（`^` / 空白 / 引号 / `&` `;` `|` 等
 * 非路径非词字符）；`other/scripts/…` 前面是 `/` ⇒ **不认**（保持 fail-closed）。
 * 另**只**额外放行一个 `./` 前缀（`node ./scripts/generate.cjs` = 同目录，仍是这个 helper）；
 * 更深的相对路径（`x/scripts/…`）一律不认 —— 不做别名 / 符号链接 / PATH 解析。
 */
const RELATIVE_HELPER = /(?:^|[^\w\\/])(?:\.\/)?scripts[\\/]+generate\.cjs/i;

/**
 * 命令里 deck-layout helper 调用**末尾**的下标（从这里往后找源文件参数）；读不出 ⇒ `undefined`。
 *
 * 两种被承认的形态：
 *  ① **全路径**：命令里出现连续的 `deck-layout/scripts/generate.cjs`（原判据，一字未改）；
 *  ② **`cd` + 相对调用**（⭐ 补自 2026-10-17 统一审核 §T23②，真实可达）：模型常先
 *     `cd "<...>/deck-layout"` 再 `node scripts/generate.cjs "<file>"`，此时命令里**没有**
 *     连续的 `deck-layout/scripts/generate.cjs`（SKILL 文档也只要求"用已安装的
 *     deck-layout/scripts/generate.cjs"，**没要求写全路径**）⇒ 旧判据读不出目标、仍
 *     fail-closed。这里把 `cd` 的目录与后续相对路径 `scripts/generate.cjs` **拼起来解析**
 *     这个 helper 的身份。
 *
 * ⛔ 有界，不做通用路径解析：只在 `cd` 目录**以 `deck-layout` 结尾**时才认，且只并
 *    `cd 目录 + scripts/generate.cjs` 这一条 —— 不做别名 / 任意符号链接 / PATH 解析。
 */
function helperInvocationEnd(command: string): number | undefined {
  const direct = DIRECT_HELPER.exec(command);
  if (direct) return direct.index + direct[0].length;
  const cd = CD_PREFIX.exec(command);
  if (!cd) return undefined;
  const dir = cd[1] ?? cd[2] ?? cd[3] ?? '';
  if (!/(?:^|[\\/])deck-layout[\\/]*$/.test(dir)) return undefined;
  const after = command.slice(cd.index + cd[0].length);
  const rel = RELATIVE_HELPER.exec(after);
  if (!rel) return undefined;
  return cd.index + cd[0].length + rel.index + rel[0].length;
}

/**
 * 从一条 exec **命令串**里取回被指名的 `.native-ppt.json` 源文件；读不出 ⇒ `undefined`。
 *
 * 判据收窄到"命令里出现过 deck-layout 的 `scripts/generate.cjs`（全路径 **或** `cd` + 相对调用，
 * 见 `helperInvocationEnd`），取它后面**第一个**以 `.native-ppt.json` 结尾的参数（去引号）"：
 *  · `--previous "x.receipt.json"` 是 `.receipt.json`，不会被误取；
 *  · 完全没有这个 helper / 没有源参数 ⇒ `undefined`（不发明结论）。
 *
 * ⚠️ **读出的目标按命令里**原样**返回**（不把 `cd` 的目录并到源路径上）：源文件是本轮写在
 *    工作区里的产物，命令里那个参数就是"模型自己指名"的写法，`nativeInputFromCompletedWrites`
 *    再按工作区归一化后去并列候选里配对。把 cwd 并进去只会得到一个**不在候选里**的路径 ⇒
 *    反而恒 fail-closed。未覆盖的形态见报告（余下缺口）。
 */
export function nativeSourceFromCommand(command: string): string | undefined {
  const index = helperInvocationEnd(command);
  if (index === undefined) return undefined;
  const rest = command.slice(index);
  for (const raw of rest.match(/"[^"]*"|'[^']*'|\S+/g) ?? []) {
    const token = raw.replace(/^["']/, '').replace(/["']$/, '');
    if (token.startsWith('--')) continue;
    if (token.toLowerCase().endsWith(NATIVE_SOURCE_SUFFIX)) return token;
  }
  return undefined;
}

/**
 * 一条已完成的 exec 命令**指名**了什么原生源文件（读不出 ⇒ 不入列）。
 */
interface DeclaredExecTarget {
  toolId: string;
  target: string;
}

/** 所有已完成的 exec 命令各自指名什么（同一条命令只记一次）。 */
function execDeclaredTargets(tools: ToolCall[]): DeclaredExecTarget[] {
  const declared: DeclaredExecTarget[] = [];
  for (const tool of tools) {
    if (tool.status !== 'done' || !EXEC_TOOL_NAMES.has(tool.name)) continue;
    const command = tool.args?.command;
    if (typeof command !== 'string') continue;
    const target = nativeSourceFromCommand(command);
    if (target) declared.push({ toolId: tool.id, target });
  }
  return declared;
}

/** 取 record 里第一个能解析成毫秒的时间；都读不出 ⇒ `undefined`（不猜）。 */
function runtimeStampMs(tool: ToolCall): number | undefined {
  for (const value of [tool.completedAt, tool.startedAt]) {
    const ms = typeof value === 'string' ? Date.parse(value) : NaN;
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

/**
 * ⭐ T23 源端半边（2026-10-16 本地全量执行，执行身份来源）：**本轮原生渲染 exec 的执行
 * 顺序**（`toolCallId` 的数组，早 → 晚），原料 = `ToolCall` 上的 `startedAt`/`completedAt`。
 *
 * ⚠️ 只收**已完成**（`status === 'done'`）的 exec：没跑完/没跑成的命令不构成"本轮真的
 *    用它渲过"的证据。读不出任何时间戳（`runtimeStampMs` 为 `undefined`）的条目也**不收**。
 *
 * ⛔ 时间戳来源**未做判别**（Lead 裁决 2026-10-16 ⇒ 保持现状 + 登记后继工单）：`ToolCall`
 *    的这两个字段是 **item 帧（运行时真实起止）与 tool 流（本地收包时刻）合并**的产物，
 *    **字段上不带来源标记** —— `gateway-dispatcher.ts:2173`（item/end ⇒ `endedAt ?? new Date()`）
 *    对 `:2001`（tool/result ⇒ `new Date()`）、`:2333`（approval 未跑成 ⇒ `new Date()`）；
 *    合并器 `message-store.ts:606` 是 `completedAt: incoming ?? existing`（**后到者胜**；
 *    `startedAt` 走 `:605` 取两者更早）。⇒ 这里可能与**收包时刻**混入，沿用 BUG-058④
 *    「真正执行记录」未完全闭合的口径，不得据此宣称"纯运行时真实时间"。
 *
 * ⛔ 这**不是**"数组序"：调用方（`data-handlers` 的 run **收尾**）把这份记录**显式透传**
 *    进来；本模块自己**从不**去读 `tools` 的数组顺序。
 * ⚠️ **绑定时机**：是"run 收尾时从 `input.toolCalls` 构造"，**不是**"item 帧到达即增量落盘
 *    到 run 对象" —— 后者需要跨 dispatcher/store 的更大改动，本轮**不做**（Lead 裁决 ③）。
 */
export function nativeExecOrderFromTools(tools: ToolCall[]): string[] {
  const observed: Array<{ toolId: string; at: number }> = [];
  for (const tool of tools) {
    if (tool.status !== 'done' || !EXEC_TOOL_NAMES.has(tool.name)) continue;
    const at = runtimeStampMs(tool);
    if (at === undefined) continue;
    observed.push({ toolId: tool.id, at });
  }
  return observed.sort((a, b) => a.at - b.at).map((entry) => entry.toolId);
}

/**
 * 本轮原生渲染命令指名的**可信目标**。
 *
 * 恰好一个**不同**目标 ⇒ 直接用它。
 * ≥2 个不同目标（两条命令指着不同的源）：只有在**给了运行时执行顺序**时才能裁决 ——
 * 取执行顺序里**最靠后**（最后真的跑过）那条 exec 的目标；没有执行顺序、或入列的 exec
 * 都不在执行顺序里 ⇒ `undefined`（保持二义，不取第一个）。
 */
function resolveDeclaredTarget(tools: ToolCall[], execOrder: readonly string[] | undefined): string | undefined {
  const declared = execDeclaredTargets(tools);
  if (declared.length === 0) return undefined;
  const distinct = new Set(declared.map((entry) => entry.target));
  if (distinct.size === 1) return declared[0].target;
  if (!execOrder || execOrder.length === 0) return undefined;
  const rank = new Map(execOrder.map((toolId, index) => [toolId, index]));
  let latest: { target: string; index: number } | undefined;
  for (const entry of declared) {
    const index = rank.get(entry.toolId);
    if (index === undefined) continue;
    if (!latest || index > latest.index) latest = { target: entry.target, index };
  }
  return latest?.target;
}

export interface NativeInputOptions {
  /**
   * 本轮 run 的开始时刻（`run.createdAt`）。
   *
   * ⭐ BUG-046 ③（2026-10-08 真机 69 次 `native-current-write-required` 误诊）：
   * 判据从「write 工具 args 的 sha 必须与盘上一致」放宽为两层证据——
   *   ① 最强：本轮**某一次** write 的内容与盘上字节一致（sha 匹配，未变；
   *      BUG-054：同文件多次 write 时保留全部记录，任一次一致即通过 —— 数组序
   *      ≠ 执行序，旧的"最后一次胜出"在倒序时会覆盖掉正确证据）；
   *   ② 本轮被 edit/apply_patch 改过、且盘上 mtime 不早于 run 开始（edit 的 args
   *      不是全文，没有 sha 可对；freshness 就是它的"这是本轮产物"证明）。
   * 守卫强度不松：**run 开始前就存在、本轮没碰过的旧文件永不入选**（旧 Artifact
   * 冒充新 Artifact 的那个洞，一字没放宽）。
   */
  sinceMs?: number;
  /**
   * ⭐ BUG-058④（2026-10-13 联审残余）：**显式目标**（相对工作区的路径；绝对路径
   * 按同一口径归一）。可信调用方**确实知道**要渲染哪一份时用它消歧。
   *
   * 语义边界（刻意收窄，别扩大解释）：
   *  · **只在 mtime 并列**（真的分不出谁最新）时生效；它必须**就在并列候选里**，
   *    否则歧义照旧 —— 它不是"指定谁就选谁"的后门；
   *  · 它**不绕过** sha / freshness / containment 任何一道守卫（候选是这些判据的
   *    产物，target 只是从中挑一个）；
   *  · 原生**执行顺序**的透传不在本函数内猜测（数组序、收包 completedAt 都不可信，
   *    见 BUG-058④）。⭐ T23（2026-10-16）：现在补了两条**非猜测**的来源 —— 模型自己
   *    exec 命令里指名的源文件（`nativeSourceFromCommand`，见上），以及调用方透传的
   *    **运行时执行顺序**（`execOrder`）；调用方显式给的 `target` 仍然优先。
   *    三者都读不出 ⇒ 保持"无证据 ⇒ 明确歧义"。
   */
  target?: string;
  /**
   * ⭐ T23 源端半边（2026-10-16 本地全量执行 · 执行身份来源）：**本轮原生渲染 exec 的
   * 运行时执行顺序**（`nativeExecOrderFromTools` 的产物；`toolCallId` 数组，早 → 晚）。
   *
   * 这补上的正是 `NativeInputOptions.target` 那条注释里写明的缺口 ——「原生执行顺序的
   * 透传是显式依赖」：`data-handlers` 的 run 收尾现在把运行时 `item` 帧记录的执行顺序
   * **显式**传进来，于是"两条 exec 指名不同目标"不再是死局（取最后真的跑过那条）。
   *
   * 边界（一条不放松）：
   *  · 只在 `mtime` 平局、且**确有 exec 指名目标**时参与裁决；
   *  · 只在**已经指名的目标**里挑（不绕过 sha / freshness / containment，也不是后门）；
   *  · 缺省 / 空 / 没有一个被指名的 exec 落在顺序里 ⇒ **保持 `native-input-ambiguous`**。
   */
  execOrder?: readonly string[];
}

/**
 * 从本轮已完成的工具调用里挑出「当前这轮的 .native-ppt.json 源文件」。
 *
 * ⭐ BUG-046 ③：候选排序**按盘上 mtime**，不再按工具调用数组序——数组序是模型
 * 写回的顺序，mtime 才是执行序（10-04/10-05/10-08 三度复发实证）。只有 mtime
 * 完全相同才判 `native-input-ambiguous`（真的分不出谁最新）。
 */
export function nativeInputFromCompletedWrites(
  workspace: string,
  tools: ToolCall[],
  options: NativeInputOptions = {},
): string | undefined {
  const sinceMs = options.sinceMs;
  const candidates = new Map<string, { contents: string[]; edited: boolean }>();
  for (const tool of tools) {
    if (tool.status !== 'done' || !tool.args) continue;
    const write = WRITE_TOOLS.has(tool.name);
    if (!write && !EDIT_TOOLS.has(tool.name)) continue;
    const file = tool.args.path ?? tool.args.file_path;
    if (typeof file !== 'string' || !file.endsWith('.native-ppt.json')) continue;
    const relative = path.isAbsolute(file) ? path.relative(workspace, file) : file;
    const entry = candidates.get(relative) ?? { contents: [], edited: false };
    // ⭐ BUG-054（2026-10-09 只读复审）：同一文件多次写入时**保留每一次的内容**作为
    //    候选证据 —— 数组序 ≠ 执行序（同 BUG-046 ③ 的实证）。旧的"最后一次 write 胜出"
    //    在数组倒序时留下的是旧内容，sha 对不上 ⇒ 真新文件落选。现在 sha 与**任一次**
    //    记录一致即通过；多候选之间的裁决仍然只由盘上 mtime 负责（见文件头）。
    if (write && typeof tool.args.content === 'string') entry.contents.push(tool.args.content);
    // ⭐ F-A2：edit 证据与 write 证据**独立记账**——同 run 先 write 后 edit 同一文件时，
    //    write 记录的 args 是 edit 前的旧内容（第一层 sha 必不匹配），若第二层再因
    //    "该文件有 write 记录"跳过，候选两落空 → case A 误诊 native-current-write-required。
    if (EDIT_TOOLS.has(tool.name)) entry.edited = true;
    candidates.set(relative, entry);
  }
  const fresh = (relative: string): boolean => {
    if (sinceMs === undefined) return true;
    try {
      return statSync(path.resolve(workspace, relative)).mtimeMs >= sinceMs;
    } catch {
      return false;
    }
  };
  // 第一层：sha 匹配（内容逐字节一致）——最强证据。
  //    同文件多次 write ⇒ 与**任一次**记录一致即通过（BUG-054；数组序不作数）。
  const verified: Array<{ relative: string; mtimeMs: number }> = [];
  for (const [relative, entry] of candidates) {
    if (entry.contents.length === 0) continue;
    try {
      const disk = readWorkspaceBytes(workspace, relative, 1024 * 1024);
      const diskSha = sha(disk);
      if (!entry.contents.some((content) => sha(Buffer.from(content)) === diskSha)) continue;
      if (!fresh(relative)) continue;
      verified.push({ relative, mtimeMs: statSync(path.resolve(workspace, relative)).mtimeMs });
    } catch {
      continue;
    }
  }
  // 第二层：本轮有 edit/apply_patch 证据 + 盘上够新（只在调用方给了 run 起点时才启用）。
  //    判据就是"本轮改过 + freshness"，不再排除同时有 write 记录的候选（F-A2）。
  const edited: Array<{ relative: string; mtimeMs: number }> = [];
  if (sinceMs !== undefined) {
    for (const [relative, entry] of candidates) {
      if (!entry.edited) continue;
      try {
        const stat = statSync(path.resolve(workspace, relative));
        if (!stat.isFile() || stat.mtimeMs < sinceMs) continue;
        edited.push({ relative, mtimeMs: stat.mtimeMs });
      } catch {
        continue;
      }
    }
  }
  // 两层证据合并（同一文件两层都命中时按 relative 去重、取较大 mtime）。
  const merged = new Map<string, number>();
  for (const item of [...verified, ...edited])
    merged.set(item.relative, Math.max(merged.get(item.relative) ?? 0, item.mtimeMs));
  const chosen = [...merged.entries()]
    .map(([relative, mtimeMs]) => ({ relative, mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (chosen.length === 0) return undefined;
  if (chosen.length > 1 && chosen[0].mtimeMs === chosen[1].mtimeMs) {
    const tied = chosen.filter((item) => item.mtimeMs === chosen[0].mtimeMs);
    // ⭐ BUG-058④：mtime 平局时**只**认"落在并列候选里的显式目标"。
    //    ⛔ 数组序、收包 completedAt 都不是执行序（BUG-046 ③/BUG-054 实证），
    //    拿它们猜选会把"渲染了哪一份"这种事交给巧合 —— 不许。
    // ⭐ T23 源端半边（2026-10-16）：`resolveDeclaredTarget` 在"多条 exec 指名不同目标"时
    //    用**运行时执行顺序**（`options.execOrder`，由调用方从 item 帧透传）取最后真的
    //    跑过那条的目标；没有执行顺序 ⇒ 与从前一字不差地保持二义。
    const requested = (options.target ?? resolveDeclaredTarget(tools, options.execOrder))?.trim();
    if (requested) {
      const normalized = path.isAbsolute(requested) ? path.relative(workspace, requested) : requested;
      const picked = tied.find((item) => item.relative === normalized);
      if (picked) return picked.relative;
    }
    throw Error(
      `native-input-ambiguous: ${tied.map((item) => item.relative).join(', ')}` +
        ` 的修改时间完全相同，无法确定要渲染哪一份（数组序与收包时间都不足以裁决）；` +
        `请在调用处显式指定目标文件（target），或先重新写入目标文件使其 mtime 更新后重试`,
    );
  }
  return chosen[0].relative;
}
