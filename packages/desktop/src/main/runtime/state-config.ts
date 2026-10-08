/**
 * 网关状态目录的 `openclaw.json` + 客户端 config 里的 `local-runtime` 条目。
 *
 * ⚠️ **令牌的唯一真相源是 ClawWork 自己的 store**（`runtime/token-store.ts`，
 * `<userData>/runtime/local-gateway-auth.json`）。这里产出的两份都是**镜像**：
 *   - `openclaw.json` —— 网关的 bootstrap 输入；按 store 对齐，不一致就改写回来
 *   - 客户端 config 的 `local-runtime` 条目 —— 给 WS 连接用（safeStorage 加密落盘）
 *
 * 镜像不一致的现象极其难查：WS 连上去被 1008 拒绝，界面上看着就是"网关没起来"，
 * 日志里只有一句 1008。⇒ 所以每次启动都按 store 做一次**对齐**，不一致就改写并报漂移。
 *
 * ⚠️ 绝不能让 token 的生命周期由 openclaw 的配置行为决定：那份文件被换掉/删掉时
 * 若"重新生成一个"，就会拿新 token 去认证还在用旧 token 跑的网关 ⇒ 认证失败 ⇒
 * 被误判成 foreign。详见 `token-store.ts` 的头注释。
 *
 * ⚠️ `openclaw.json` 里**刻意不写** `gateway.mode`（这正是启动参数必须带
 * `--allow-unconfigured` 的原因）、**不写** `gateway.port`（端口归 `--port`）。
 * 写进去就把网关自己的配置语义接管了，上游改默认值时我们会悄悄掉队。
 *
 * ⚠️ openclaw 自己也会往这个目录写东西（`openclaw.json.last-good` 等），
 * 所以**只在缺失或认证段不一致时补**，绝不整文件覆盖。
 *
 * 除了认证段，这里还会补一条**记忆检索的默认值**（`memory.search.provider = 'none'`，
 * 见 `MEMORY_SEARCH_PROVIDER`）—— 不补的话模型每次调 `memory_search` 都会卡 15 秒再失败。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { GATEWAY_WS_PORT } from '@clawwork/shared';
import { plannerDeniedToolIds } from '@clawwork/core';
import { writeJsonAtomic } from '../util/json-file.js';
import { readConfig, updateConfig } from '../workspace/config.js';
import type { AppConfig, GatewayServerConfig } from '../workspace/config.js';
import { INBOX_READONLY_PLUGIN_ID, ensureInboxReadonlyPolicy } from '../guard/inbox-readonly.js';
import { ensureLocalGatewayToken } from './token-store.js';
import { preparePortableState } from './portable-state-migration.js';

export const STATE_DIR_NAME = 'openclaw-state';
export const STATE_CONFIG_FILE = 'openclaw.json';
export const PORTABLE_STATE_DIR_NAME = 'state';
/** 稳定 id：有了它，upsert 才是幂等的（不会每次启动多出一条网关）。 */
export const LOCAL_GATEWAY_ID = 'local-runtime';
export const LOCAL_GATEWAY_NAME = 'Local Runtime';

/**
 * 记忆检索走**本地 FTS-only**，不接任何嵌入服务。
 *
 * 现场（2026-09-18，用户机器）：对话里模型一调 `memory_search` 就卡**整整 15.0 秒**
 * 然后报错，再接着调别的工具（`ls`/`ask_user` 都正常）—— 用户看到的正是"调用
 * memory 失败然后继续调用其他工具"。调试日志里三次调用，每次都是 15.0 秒后才 error。
 *
 * 根因不是我们写错了配置，而是**没写**：`memory.search.provider` 不写默认是 `openai`
 * （`docs/reference/memory-config.md`），而我们从不出任何嵌入凭据 ⇒ 每次调用都去够
 * OpenAI 直到超时。文档同时写明"显式远端 provider 在运行时不可达时 **fail closed**"，
 * 即它不是悄悄退回全文检索，而是直接失败 —— 这就是那 15 秒。
 *
 * `none` 是运行时**一等公民**（`memory-core/manager-runtime.js` 多处特判走 FTS-only 分支），
 * 文档写明"`provider: "none"` 有意选择 FTS-only 模式，记忆召回仍可正常工作"。
 * 选它而不是 `enabled: false`：召回继续可用、不出网、不要凭据，符合"内容不出网"。
 *
 * ⚠️ 将来 T6b 接上我们自己的嵌入通道（走 relay 并计费）时，把这里换成对应 provider。
 */
export const MEMORY_SEARCH_PROVIDER = 'none';

export interface OpenClawStateConfig {
  gateway: {
    auth: { mode: 'token'; token: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function stateDirFor(userDataDir: string): string {
  return path.join(userDataDir, STATE_DIR_NAME);
}

export function stateConfigPath(stateDir: string): string {
  return path.join(stateDir, STATE_CONFIG_FILE);
}

/**
 * 便携版的 OpenClaw state 还要按**便携身份**隔离。
 *
 * 本机 runtime cache 的外层 scope 只区分 `E:\\荣盈魔方-运行数据` 这类路径；换一支
 * U 盘后盘符和目录可能完全相同。若直接共用 `<cache>/openclaw-state`，后一支盘会继承
 * 前一支盘的 provider key、会话和插件状态。token 是每支盘自己的稳定随机身份，取
 * SHA-256 的前 96 bit 作目录名既不泄露 token，也足够把一台机器上的几支盘隔开。
 * 不用完整 64 hex：OpenClaw 的 npm/plugin 子树很深，Windows 路径预算是真实故障面。
 */
export function portableStateDirFor(stateRootDir: string, token: string): string {
  const identity = createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 24);
  return path.join(stateRootDir, PORTABLE_STATE_DIR_NAME, identity);
}

/**
 * 最小可用配置（纯函数）。
 *
 * `mode` 必须是 `'token'`：写别的值等于告诉网关换一种认证方式，
 * 而客户端只会用 token。
 */
export function minimalGatewayConfig(token: string): OpenClawStateConfig {
  return { gateway: { auth: { mode: 'token', token } } };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 从（任意的）配置里挖出 `memory.search.provider`；没有则 null。 */
export function readMemorySearchProvider(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const memory = raw.memory;
  if (!isRecord(memory)) return null;
  const search = memory.search;
  if (!isRecord(search)) return null;
  const provider = search.provider;
  return typeof provider === 'string' && provider.length > 0 ? provider : null;
}

/**
 * 记忆段合并（纯函数）：**只在没有 provider 时补默认**，设过的一个字都不动。
 *
 * 为什么要合并而不是整段覆盖：用户机器上这份文件**早就存在**（`ensureStateConfig`
 * 里那条"已经一致就一个字节都不写"的提前返回会直接跳过它）⇒ 只在"新建"路径上补默认值
 * 等于对存量用户完全没修。另外 openclaw 自己也可能往 `memory` 里写别的东西。
 */
export function mergeMemoryDefaults(existing: Record<string, unknown> | null): Record<string, unknown> {
  const memory = existing && isRecord(existing.memory) ? existing.memory : {};
  if (readMemorySearchProvider(existing) !== null) return memory;

  const search = isRecord(memory.search) ? memory.search : {};
  return { ...memory, search: { ...search, provider: MEMORY_SEARCH_PROVIDER } };
}

/**
 * 便携版的 agent workspace 在 U 盘上，可能是 exFAT。OpenClaw 2026.9.3
 * 默认创建 bootstrap 文件时会用硬链接，exFAT 不支持，Node 在真盘上返回
 * `EISDIR` 并使 `agents.create` 整体失败。ClawWork 在创建后会自己写入
 * IDENTITY.md / SOUL.md，所以便携形态只需跳过上游这次 bootstrap。
 *
 * 安装版仍用上游默认值：只有 state 与便携数据分根时才合并这段。
 */
function hasPortableBootstrapDisabled(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const agents = raw.agents;
  if (!isRecord(agents)) return false;
  const defaults = agents.defaults;
  return isRecord(defaults) && defaults.skipBootstrap === true;
}

function readPortableMainWorkspace(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const agents = raw.agents;
  if (!isRecord(agents)) return null;
  const entries = agents.entries;
  if (!isRecord(entries)) return null;
  const main = entries.main;
  if (!isRecord(main)) return null;
  return typeof main.workspace === 'string' && main.workspace.length > 0 ? main.workspace : null;
}

function hasPortableAgentDefaults(raw: unknown, workspacePath?: string): boolean {
  return (
    hasPortableBootstrapDisabled(raw) &&
    !needsPortableHeartbeatDefault(isRecord(raw) ? raw : null) &&
    (!workspacePath || readPortableMainWorkspace(raw) === workspacePath)
  );
}

function needsPortableHeartbeatDefault(existing: Record<string, unknown> | null): boolean {
  const agents = existing && isRecord(existing.agents) ? existing.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  const heartbeat = isRecord(defaults.heartbeat) ? defaults.heartbeat : {};
  if (existing && isRecord(existing.channels) && Object.keys(existing.channels).length > 0) return false;
  const agentEntries = [
    ...(isRecord(agents.entries) ? Object.values(agents.entries) : []),
    ...(Array.isArray(agents.list) ? agents.list : []),
  ];
  if (agentEntries.some((entry) => isRecord(entry) && isRecord(entry.heartbeat))) return false;
  return Object.keys(heartbeat).every((key) => key === 'agentId');
}

function mergePortableAgentDefaults(
  existing: Record<string, unknown> | null,
  workspacePath?: string,
): Record<string, unknown> {
  const agents = existing && isRecord(existing.agents) ? existing.agents : {};
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  const heartbeat = isRecord(defaults.heartbeat) ? defaults.heartbeat : {};
  const portableDefaults = {
    ...defaults,
    skipBootstrap: true,
    ...(needsPortableHeartbeatDefault(existing) ? { heartbeat: { ...heartbeat, every: '0m' } } : {}),
  };
  if (!workspacePath) return { ...agents, defaults: portableDefaults };

  const entries = isRecord(agents.entries) ? agents.entries : {};
  const main = isRecord(entries.main) ? entries.main : {};
  return {
    ...agents,
    defaults: portableDefaults,
    entries: { ...entries, main: { ...main, workspace: workspacePath } },
  };
}

/**
 * 要从模型可见的工具里摘掉的两个名字。
 *
 * 为什么摘：模型每轮都可能调 `memory_search`，而在 `provider: "none"` 下
 * `corpus=sessions` **必然失败**（`Session transcript search is not enabled.`）——
 * 用户原话（2026-09-20）：「我不希望每次对话就有这个报错，用户会认为卡了」。
 *
 * ⚠️ **两个一起摘**。只摘 `memory_search` 的话，记忆提示段会换成 `memory_get` 版本
 *（`memory-tool-contract-*.mjs` 的 `hasMemoryGet` 分支），"强制回忆"的指令还在，
 * 模型照样去调。
 *
 * ⚠️ **不要改用 `memory.search.enabled: false`**：那条更"干净"（工具根本不注册），
 * 但会**静默关掉 "## Project Memory" 注入**（manager 变 null ⇒ 那一段消失），
 * 是个看不见的损失。
 *
 * ⚠️ 代价要说清（免得后人以为是白捡）：`provider: "none"` 下 `memory_search` 对
 * `MEMORY.md` / `USER.md` / `memory/**` 的 **FTS 召回是能用的**，摘掉它等于放弃这条。
 * 之所以可接受：根 `MEMORY.md` 本来就**每轮全文注入**（6 文件 bootstrap 清单），
 * 召回它的边际价值很小；真正有价值的 `sessions` 语料在本配置下根本用不了。
 * 将来 T6b 接上自己的嵌入通道时，把这里连同 `MEMORY_SEARCH_PROVIDER` 一起改。
 */
export const MEMORY_TOOLS_DENIED = ['memory_search', 'memory_get'] as const;

/**
 * **平台特异工具**（2026-10-07 交付日 P0-3）：本产品=Windows 桌面，这些工具在本平台
 * 不可执行（`canvas` = macOS 配对节点工具，`tool-*.mjs` 注册名实读 `name: "canvas"`；
 * 语料 434k 行内 0 次调用，但暴露给 Planner 只会换来失败调用）——与 memory 两工具一样
 * 并进 deny（同一个 `mergeToolsDefaults`，幂等并集）。
 * ⚠️ 待查证候选（确切注册名未经工具清单实读，勿凭"族名"猜测写入）：computer / nodes /
 *    mobile_ui / portal / dashboard。
 */
export const PLATFORM_IRRELEVANT_TOOLS_DENIED = ['canvas'] as const;

/**
 * **网络搜索工具**（2026-10-07 交付日用户指令）：无稳定国内搜索源前，从 Planner 的默认
 * 可用能力中降级——不让用户持续看到"搜索失败"（根因见 BUG-033：DuckDuckGo 在大陆用户
 * 网络被反爬，实锤 0/2；dev 机代理下可用）。将来接入稳定国内源（或换回可用 provider）时，
 * **删掉这一行常量**即整体恢复（merge 并集、必备判据、workflow-tools 的跟随方全自动）。
 */
export const WEB_TOOLS_DENIED = ['web_search', 'web_fetch'] as const;

/**
 * **无沙箱的看图工具**（BUG-049，2026-10-08 真机定案）——同样并入 deny。
 *
 * 现场（pre18 真机 run6b，任务 `8e5b7580`）：模型用 `exec` 递归扫工作目录 → 命中
 * **另一个任务**（vision 场景 `f1ff8ac5`）inbox 里的验收探针 PNG → 调 `view_image`
 * 把该图读进模型私有上下文（toolResult 里带 base64 图片载荷）→ 随后 14 个连续回合
 * 复述图里的「验收测试码 7441」，并把它说成"你发的这张PPT截图"。
 *
 * 为什么摘它对产品**没有损失**（三条实证）：
 *   ① 产品唯一的看图通路是 App 侧附件投递（BUG-027「识别图片」：图片作为消息附件
 *      投给模型），不依赖模型自己去磁盘捞图；
 *   ② 全库随包技能（`packages/desktop/our-skills`）**0 处**引用 `view_image`；
 *   ③ 它**没有任务级路径沙箱**：`tools.fs.workspaceOnly` 只把边界定在 workspace 根，
 *      而 workspace 是**设备级共享**（所有任务目录同根）⇒ 任一任务都能把别家任务的
 *      图片读进上下文。产品侧修不到内核工具的沙箱（结构性修复=任务级 workspace 定界，
 *      另立工单），所以先在能力面摘掉它。
 *
 * 与 `canvas` / web 工具同一条机制：并入 `mergeToolsDefaults` 的 deny 并集 +
 * `hasMemoryToolsDenied` 自愈判据（存量用户也拿得到）+ `workflow-tools.ts` 自动跟随。
 */
export const SANDBOXLESS_VISION_TOOLS_DENIED = ['view_image'] as const;

/**
 * **能力注册表判定为 `unavailable` 的工具**（BUG-043，2026-10-08）——同样并入 deny。
 *
 * 本轮落地的是图片/视频生成（`image_generate` / `video_generate`）：media-loop 本轮
 * 不接入，留在模型可见面只会换来"调一次、失败一次"的 Tool Failure（用户原话要的正是
 * "不要看到失败"）。真源在 `@clawwork/core` 的能力注册表（`plannerDeniedToolIds()`，
 * 与验证账本逐字对齐）——**别在这里再抄一份名单**。
 *
 * ⚠️ **懒取、顶层不直接求值**：本模块的 import 顺序敏感（2026-10-07 实测：顶层求值
 *    会在 license 系测试的 collect 期炸 `… is not iterable`），常量在"首次调用"时拿，
 *    那时全部模块已初始化。
 */
function capabilityToolsDenied(): readonly string[] {
  return plannerDeniedToolIds();
}

/** 从（任意的）配置里挖出全局 `tools.deny`；不是字符串数组则 null。 */
export function readToolsDeny(raw: unknown): string[] | null {
  if (!isRecord(raw)) return null;
  const tools = raw.tools;
  if (!isRecord(tools)) return null;
  const deny = tools.deny;
  if (!Array.isArray(deny)) return null;
  return deny.filter((v): v is string => typeof v === 'string');
}

/** 那两个名字是不是都已经被 deny 掉了（决定"要不要写盘"的判据）。 */
export function hasMemoryToolsDenied(raw: unknown): boolean {
  const deny = readToolsDeny(raw);
  return (
    deny !== null &&
    MEMORY_TOOLS_DENIED.every((name) => deny.includes(name)) &&
    // 2026-10-07 P0-3：平台特异工具（canvas）同走这条判据——只查 memory 两名的话，
    // 存量用户会因提前返回**永远拿不到**新增的 deny（与 memory/工具闸门当初同一个坑）。
    PLATFORM_IRRELEVANT_TOOLS_DENIED.every((name) => deny.includes(name)) &&
    // 2026-10-07 交付日：web 工具降级（BUG-033）同走这条判据（同上坑理）。
    WEB_TOOLS_DENIED.every((name) => deny.includes(name)) &&
    // 2026-10-08 BUG-049：无沙箱看图工具 view_image 同走这条判据 —— 漏了它，存量用户
    // （配置里已有 canvas/web 等旧名单）会被提前返回**永远锁在没有新 deny 的状态**。
    SANDBOXLESS_VISION_TOOLS_DENIED.every((name) => deny.includes(name)) &&
    // 2026-10-08：能力注册表的 unavailable 工具（image/video 生成，BUG-043）同走这条判据 ——
    // 漏了它，存量用户（配置里已有旧的四个名字）会被提前返回**永远锁在没有新 deny 的状态**。
    capabilityToolsDenied().every((name) => deny.includes(name))
  );
}

/**
 * 红线闸门的确切值。三个键在运行时 2026.9.3 的默认值**都不设防**（实测，见设计文档 §1）：
 * `tools.fs.workspaceOnly` 默认 false、`exec` 默认 `security:"full" + ask:"off"`、`elevated` 未关。
 *
 * ⚠️ `exec.mode` 是**规范键**；旧写法 `security`/`ask` 与它**不能并存**（混合策略会被运行时拒绝），
 *    所以 `mergeToolsDefaults` 在写 `mode` 时必须把同对象的 `security`/`ask` 移掉。
 *
 * ⚠️⚠️ **不要往这里加 `askFallback`**：实测（2026-09-23，真运行时 CLI）它**不在
 *    `tools.exec` 的 schema 里**，写进去会让**整份配置被判非法**：
 *    `config get tools` ⇒ `cli_error: OpenClaw config is invalid` + `Unrecognized key: "askFallback"`。
 *    审批通道不可达时的默认行为本来就是 **deny**（文档 + 实现），所以不写它 = 用默认值，语义不变。
 *    （那个键属于**审批存储**那一侧，不是 openclaw.json 的 tools 段。）
 */
export const TOOL_GUARD_FS_WORKSPACE_ONLY = true;
export const TOOL_GUARD_EXEC_MODE = 'ask';
export const TOOL_GUARD_ELEVATED_ENABLED = false;

/** 从（任意的）配置里挖出 `tools.fs.workspaceOnly`；不是布尔则 null。 */
export function readFsWorkspaceOnly(raw: unknown): boolean | null {
  if (!isRecord(raw)) return null;
  const tools = raw.tools;
  if (!isRecord(tools)) return null;
  const fsSection = tools.fs;
  if (!isRecord(fsSection)) return null;
  const value = fsSection.workspaceOnly;
  return typeof value === 'boolean' ? value : null;
}

/** 从（任意的）配置里挖出 `tools.exec.mode`；不是字符串则 null。 */
export function readExecMode(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const tools = raw.tools;
  if (!isRecord(tools)) return null;
  const exec = tools.exec;
  if (!isRecord(exec)) return null;
  const mode = exec.mode;
  return typeof mode === 'string' ? mode : null;
}

/** 从（任意的）配置里挖出 `tools.elevated.enabled`；不是布尔则 null。 */
export function readElevatedEnabled(raw: unknown): boolean | null {
  if (!isRecord(raw)) return null;
  const tools = raw.tools;
  if (!isRecord(tools)) return null;
  const elevated = tools.elevated;
  if (!isRecord(elevated)) return null;
  const enabled = elevated.enabled;
  return typeof enabled === 'boolean' ? enabled : null;
}

/** 三个闸门是不是都已经是红线值（提前返回的判据之一）。 */
export function hasToolGuard(raw: unknown): boolean {
  return (
    readFsWorkspaceOnly(raw) === TOOL_GUARD_FS_WORKSPACE_ONLY &&
    readExecMode(raw) === TOOL_GUARD_EXEC_MODE &&
    readElevatedEnabled(raw) === TOOL_GUARD_ELEVATED_ENABLED
  );
}

/**
 * 运行时**不认**、留在文件里就会让**整份配置被判非法**的 exec 键（实测）。
 *
 * `askFallback` 不在 `openclaw.json` 的 `tools.exec` schema 里（它属于**审批存储**那一侧）：
 * `config get tools` ⇒ `Unrecognized key: "askFallback"` ⇒ 网关起不来。
 *
 * ⚠️ 为什么要有这个谓词：提前返回若只看三个闸门的**值**，一个带着这种键的文件会**永远**
 * 走提前返回 ⇒ 永远不重写 ⇒ **自愈路径被堵死**。这个客户端**从未**写过它
 * （只有未发布的本分支提交 `2b2c5517` 写过一版），但合并与判据两处都要认它。
 */
export const STALE_EXEC_KEYS: readonly string[] = ['askFallback'];

/** `tools.exec` 里还有没有"运行时不认"的键。 */
export function hasStaleExecKeys(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const tools = raw.tools;
  if (!isRecord(tools)) return false;
  const exec = tools.exec;
  if (!isRecord(exec)) return false;
  return STALE_EXEC_KEYS.some((key) => Object.hasOwn(exec, key));
}

/**
 * 工具段合并（纯函数）：把这两个名字**并进** deny + **红线三闸门**（确保并保留）。
 *
 * 为什么是并集而不是"没有才补"：用户/将来版本可能已经 deny 了别的东西，
 * 整段覆盖会把他的设置抹掉；而这两个名字必须确保在里面，所以只能并。
 * 幂等由 `Set` 保证 —— 连跑多次不会重复追加。
 *
 * ⚠️ 三个闸门同上：**确保**而不是"没有才补"。红线是产品决定、不是用户偏好 ——
 *    用户设过 `workspaceOnly:false` 也会被改回 true（设计文档 §2.1）。
 */
export function mergeToolsDefaults(existing: Record<string, unknown> | null): Record<string, unknown> {
  const tools = existing && isRecord(existing.tools) ? existing.tools : {};
  const deny = readToolsDeny(existing) ?? [];
  const fsSection = isRecord(tools.fs) ? tools.fs : {};
  const execSection = isRecord(tools.exec) ? tools.exec : {};
  const elevatedSection = isRecord(tools.elevated) ? tools.elevated : {};

  // ⚠️ 写 `mode` 时不要把旧写法留在同一个对象里：
  //    - `security`/`ask` 与 `mode` 并存会被**运行时自己的配置校验拒绝**（**实测**，2026-09-23：
  //      `config get tools` ⇒ `mode cannot be combined with security or ask in the same exec object`，
  //      并点名 `tools.exec.mode`）⇒ 这里是**必须删**，不是顺手清理。
  //      `mode:"ask"` 与 `security:"allowlist" + ask:"on-miss"` 等价，所以删除无损；
  //      合并后的形态单独喂给运行时读回过（`{strictInlineEval:true, mode:"ask"}` 被接受）。
  //    - `STALE_EXEC_KEYS`（如 `askFallback`）是**运行时不认**的键 —— 实测会让整份配置非法，
  //      必须从这里删掉，**而且**提前返回的判据也得认它（见 `hasStaleExecKeys`），否则锁死。
  const execRest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(execSection)) {
    if (key === 'security' || key === 'ask') continue;
    if (STALE_EXEC_KEYS.includes(key)) continue;
    execRest[key] = value;
  }

  return {
    ...tools,
    deny: [
      ...new Set([
        ...deny,
        ...MEMORY_TOOLS_DENIED,
        ...PLATFORM_IRRELEVANT_TOOLS_DENIED,
        ...WEB_TOOLS_DENIED,
        ...SANDBOXLESS_VISION_TOOLS_DENIED,
        ...capabilityToolsDenied(),
      ]),
    ],
    fs: { ...fsSection, workspaceOnly: TOOL_GUARD_FS_WORKSPACE_ONLY },
    // ⚠️ 只写 `mode`：**不要**加 `askFallback`（见上面常量处的实测）。
    exec: { ...execRest, mode: TOOL_GUARD_EXEC_MODE },
    elevated: { ...elevatedSection, enabled: TOOL_GUARD_ELEVATED_ENABLED },
  };
}

/**
 * 导入收件箱只读守卫的**配置侧**（插件文件本体在 `guard/inbox-readonly.ts`）。
 *
 * 为什么和工具闸门一样写在"每次启动对齐"的这条路径上：网关只认 `openclaw.json` 里的
 * `plugins.load.paths` + `plugins.entries.<id>.enabled`（其余字段一律不生效）；而
 * `ensureStateConfig` 的**提前返回是存量用户每次启动的必经之路** —— 只在新装时写，
 * 对已经用上这个版本的用户就是"保护从未存在"（与 memory 默认值/工具 deny 当初栽的
 * 是同一个坑）。所以：`hasInboxReadonlyGuard` 参与提前返回判据，缺了就合并回写。
 *
 * ⚠️ 少写一条就**静默失效**（2026-10-07 真机实验：只给 `load.paths` 指向裸文件、
 *    或只给目录不给 `entries.<id>.enabled`，网关都不加载该插件，且不打任何日志）。
 */
export function readPluginsLoadPaths(raw: unknown): string[] | null {
  if (!isRecord(raw)) return null;
  const plugins = raw.plugins;
  if (!isRecord(plugins)) return null;
  const load = plugins.load;
  if (!isRecord(load)) return null;
  const paths = load.paths;
  if (!Array.isArray(paths)) return null;
  return paths.filter((value): value is string => typeof value === 'string');
}

/**
 * 「是守卫插件目录」判定：只看**目录名尾段**，与盘符无关。
 *
 * 用途：清理换盘符后的残留死条目。2026-10-07 真机事故——盘在 G: 下写的配置换插后
 * 以 E: 挂载，旧 G: 条目在新机器上不存在，网关把"任一 load path 不存在"判为
 * Invalid config ⇒ 拒绝启动 ⇒ 整盘卡在"本机服务"（U 盘漫游场景必踩）。
 */
function isInboxReadonlyPolicyPath(candidate: string): boolean {
  const normalized = candidate.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized === INBOX_READONLY_PLUGIN_ID || normalized.endsWith(`/${INBOX_READONLY_PLUGIN_ID}`);
}

function isSamePolicyPath(a: string, b: string): boolean {
  const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalize(a) === normalize(b);
}

/** 守卫条目是不是已经完整（load 路径 + 显式启用；有 allow 名单时必须含它）。 */
export function hasInboxReadonlyGuard(raw: unknown, policyDir: string): boolean {
  if (!isRecord(raw)) return false;
  const plugins = raw.plugins;
  if (!isRecord(plugins)) return false;
  const paths = readPluginsLoadPaths(raw);
  if (!paths || !paths.some((path) => isSamePolicyPath(path, policyDir))) return false;
  // 同插件的**异路径**（旧盘符残留）也判「未就绪」：它在网关侧同样致命，而提前返回
  // 会让它永远留在配置里（每次启动都拒启）——必须强制走合并回写把它清掉。
  if (paths.some((path) => isInboxReadonlyPolicyPath(path) && !isSamePolicyPath(path, policyDir))) return false;
  const entries = plugins.entries;
  if (!isRecord(entries)) return false;
  const entry = entries[INBOX_READONLY_PLUGIN_ID];
  if (!isRecord(entry) || entry.enabled !== true) return false;
  if (Array.isArray(plugins.allow)) {
    return (plugins.allow as unknown[]).includes(INBOX_READONLY_PLUGIN_ID);
  }
  return true;
}

/**
 * plugins 段合并（纯函数）：**并进** load 路径与显式启用，不动别的插件条目。
 *
 * ⚠️ `plugins.allow` 一旦存在就是白名单：不把守卫 id 加进去，插件会被
 *    "not-in-allowlist" 静默挡住 —— 那等于给用户装了一个假装在跑的保护。
 *    （没有 allow 字段时不创建它：不要凭空给用户加白名单语义。）
 *
 * ⚠️ 同插件的**异路径**（换盘符残留）必须一并剔除：每多留一条死路径，网关的
 *    "任一 load path 不存在 ⇒ Invalid config" 就多拒启一次（见 isInboxReadonlyPolicyPath）。
 */
export function mergeInboxReadonlyGuard(
  existing: Record<string, unknown> | null,
  policyDir: string,
): Record<string, unknown> {
  const plugins = existing && isRecord(existing.plugins) ? existing.plugins : {};
  const load = isRecord(plugins.load) ? plugins.load : {};
  const paths = readPluginsLoadPaths(existing) ?? [];
  const pruned = paths.filter((path) => !isInboxReadonlyPolicyPath(path) || isSamePolicyPath(path, policyDir));
  const nextPaths = pruned.some((path) => isSamePolicyPath(path, policyDir)) ? pruned : [...pruned, policyDir];
  const entries = isRecord(plugins.entries) ? plugins.entries : {};
  const guardEntry = isRecord(entries[INBOX_READONLY_PLUGIN_ID]) ? entries[INBOX_READONLY_PLUGIN_ID] : {};
  const allow = Array.isArray(plugins.allow)
    ? plugins.allow.filter((value): value is string => typeof value === 'string')
    : null;
  return {
    ...plugins,
    load: { ...load, paths: nextPaths },
    entries: { ...entries, [INBOX_READONLY_PLUGIN_ID]: { ...guardEntry, enabled: true } },
    ...(allow && !allow.includes(INBOX_READONLY_PLUGIN_ID)
      ? { allow: [...allow, INBOX_READONLY_PLUGIN_ID] }
      : allow
        ? { allow }
        : {}),
  };
}

/** 从（任意的）已有配置里挖出 token；没有则 null。 */
export function readStateToken(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const gateway = raw.gateway;
  if (!isRecord(gateway)) return null;
  const auth = gateway.auth;
  if (!isRecord(auth)) return null;
  const token = auth.token;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * 客户端 config 里 `local-runtime` 那条的 token；没有则 null。
 *
 * 只用于 store **首次**建立时的一次性接管（见下），不是真相源。
 */
function readClientLocalRuntimeToken(): string | null {
  try {
    const entry = readConfig()?.gateways.find((g) => g.id === LOCAL_GATEWAY_ID);
    return typeof entry?.token === 'string' && entry.token.length > 0 ? entry.token : null;
  } catch {
    return null;
  }
}

function readStateConfigFile(configPath: string): Record<string, unknown> | null {
  if (!existsSync(configPath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf-8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    // 半截 JSON（掉电）当成“没有”——重建，而不是让整个启动失败。
    return null;
  }
}

/**
 * 确保状态目录里那份 `openclaw.json` 带的是 **store 的** token。
 *
 * 语义（2026-09-13 定稿）：
 *   - 真相源是 ClawWork 自己的 store，**不在**这份文件里
 *   - 因此"文件不见了/被改掉了"**不等于**"token 没了" —— 绝不因此重新生成
 *   - 这份文件是**镜像**：缺了、或认证段与 store 不一致 ⇒ 按 store 写回去
 *   - 已有配置里的其它字段一律保留（openclaw 也会往这里写东西）
 *
 * store 首次建立时只接管 **U 盘旧 state** → 客户端 config，不能接管本机缓存里残留的
 * token：同一个盘符以后可能插入另一支 U 盘，本机残留没有资格冒充新盘的身份。
 */
export function ensureStateConfig(
  userDataDir: string,
  stateUserDataDir = userDataDir,
  portableWorkspacePath?: string,
): {
  token: string;
  created: boolean;
  configPath: string;
  stateDir: string;
} {
  const splitState = stateUserDataDir !== userDataDir || Boolean(portableWorkspacePath?.trim());
  const legacyPortableConfig = readStateConfigFile(stateConfigPath(stateDirFor(userDataDir)));
  const legacyPortableToken = readStateToken(legacyPortableConfig);

  // ① 真相源：U 盘上 ClawWork 自己的 store。store 不存在时才问一次旧便携身份。
  const store = ensureLocalGatewayToken({
    userDataDir,
    adopt: () => legacyPortableToken ?? readClientLocalRuntimeToken(),
  });

  const stateDir = splitState ? portableStateDirFor(stateUserDataDir, store.token) : stateDirFor(userDataDir);
  const configPath = stateConfigPath(stateDir);
  mkdirSync(stateDir, { recursive: true });
  const existing = splitState ? readStateConfigFile(configPath) : legacyPortableConfig;
  const existingToken = readStateToken(existing);

  // ①b 收件箱只读守卫：插件**文件先落盘**，再决定要不要把配置指过去。
  //     写失败（盘满/只读）⇒ 这条守卫本次不装（宁可不装，也不把配置指向不存在的目录），
  //     并且**出声**；下次启动会重试（写文件在提前返回之前，不走那条捷径）。
  let inboxGuardDir: string | null = null;
  try {
    inboxGuardDir = ensureInboxReadonlyPolicy(stateDir);
  } catch (error) {
    console.warn(
      '[runtime] runtime.inbox-guard-unavailable：导入收件箱只读守卫未能写入状态目录，本次不装载（不影响启动）',
      error,
    );
  }

  // ② 已经一致 ⇒ 一个字节都不写（不每次启动都重写别人的文件）
  //
  // ⚠️ "一致"必须**含**记忆默认值：这条提前返回是存量用户的必经之路（他们的 token
  //    本来就是对的），只看 token 的话 `memory.search.provider` 永远补不上 ——
  //    那正是"对用户机器无效"的那一版修法。token 对 + 记忆段已设 ⇒ 才真的不写。
  // ⚠️ "一致"必须**同时**含记忆默认值、工具 deny、**红线闸门**，以及"没有运行时不认的键"：
  //    这条提前返回是存量用户每次启动的必经之路（他们的 token 本来就是对的）。漏掉任一项 ⇒
  //    对用户那台机器完全无效，症状原样还在（memory 那条当初就是这么栽的）；
  //    而漏掉最后一项更糟 —— 非法键会被**永久**锁在文件里，连自愈的机会都没有。
  if (
    existingToken === store.token &&
    existing &&
    readMemorySearchProvider(existing) !== null &&
    hasMemoryToolsDenied(existing) &&
    hasToolGuard(existing) &&
    !hasStaleExecKeys(existing) &&
    (!inboxGuardDir || hasInboxReadonlyGuard(existing, inboxGuardDir)) &&
    (!splitState || hasPortableAgentDefaults(existing, portableWorkspacePath))
  ) {
    return { token: store.token, created: false, configPath, stateDir };
  }

  const gateway = existing && isRecord(existing.gateway) ? existing.gateway : {};
  const merged: Record<string, unknown> = {
    ...(existing ?? {}),
    gateway: { ...gateway, auth: { mode: 'token', token: store.token } },
    memory: mergeMemoryDefaults(existing),
    tools: mergeToolsDefaults(existing),
    ...(inboxGuardDir ? { plugins: mergeInboxReadonlyGuard(existing, inboxGuardDir) } : {}),
    ...(splitState ? { agents: mergePortableAgentDefaults(existing, portableWorkspacePath) } : {}),
  };

  writeJsonAtomic(configPath, merged);

  // ⚠️ 只报"不一致"这件事，绝不把 token 本身写进日志
  if (existingToken && existingToken !== store.token) {
    console.warn(
      '[runtime] runtime.state-token-drift：state 文件里的网关令牌与 ClawWork 持有的不一致，已按 store 改写回来',
    );
  }

  return { token: store.token, created: existing === null, configPath, stateDir };
}

/**
 * 把本机网关 upsert 进客户端 config 的 `gateways`（纯函数，便于钉住幂等）。
 *
 * ⚠️ 只动 `id === LOCAL_GATEWAY_ID` 那一条：用户自己配的网关**原封不动**。
 */
export function mergeGatewayEntry(
  gateways: readonly GatewayServerConfig[],
  entry: GatewayServerConfig,
): GatewayServerConfig[] {
  const index = gateways.findIndex((g) => g.id === LOCAL_GATEWAY_ID);
  if (index < 0) return [...gateways, entry];
  const next = [...gateways];
  next[index] = { ...next[index], ...entry };
  return next;
}

function isLegacyEmptyLocalGateway(gateway: GatewayServerConfig): boolean {
  if (gateway.id === LOCAL_GATEWAY_ID) return false;
  const url = gateway.url.trim().replace(/\/+$/u, '');
  if (url !== 'ws://127.0.0.1:' + GATEWAY_WS_PORT) return false;
  return ![gateway.token, gateway.password, gateway.pairingCode].some(
    (credential) => typeof credential === 'string' && credential.trim().length > 0,
  );
}

export interface EnsureClientGatewayEntryResult {
  token: string;
  /** config 被改写了没。 */
  changed: boolean;
  /** 是否发生了令牌漂移（store 与客户端 config 不一致，已按 store 纠正）。 */
  drifted: boolean;
  stateDir: string;
}

/**
 * 让客户端 config 与 state 镜像都按 U 盘 token store 对齐。
 *
 * ⚠️ 必须走 `updateConfig`（而不是自己拼 JSON）：safeStorage 加密是在
 * `writeConfig` 里做的，绕过去 token 就明文落盘了。
 */
export async function ensureClientGatewayEntry(opts: {
  userDataDir: string;
  stateUserDataDir?: string;
  portableWorkspacePath?: string;
  legacyStateUserDataDir?: string;
}): Promise<EnsureClientGatewayEntryResult> {
  const stateUserDataDir = opts.stateUserDataDir ?? opts.userDataDir;
  const current: AppConfig = readConfig() ?? { workspacePath: '', gateways: [] };
  const portableWorkspacePath = opts.portableWorkspacePath?.trim() || undefined;
  let previousStateDir: string | undefined;
  if (portableWorkspacePath && stateUserDataDir === opts.userDataDir) {
    const store = ensureLocalGatewayToken({
      userDataDir: opts.userDataDir,
      adopt: () =>
        readStateToken(readStateConfigFile(stateConfigPath(stateDirFor(opts.userDataDir)))) ??
        readClientLocalRuntimeToken(),
    });
    const prepared = await preparePortableState({
      stateDir: portableStateDirFor(opts.userDataDir, store.token),
      sourceDir:
        opts.legacyStateUserDataDir && opts.legacyStateUserDataDir !== opts.userDataDir
          ? portableStateDirFor(opts.legacyStateUserDataDir, store.token)
          : undefined,
      token: store.token,
      workspacePath: portableWorkspacePath,
    });
    previousStateDir = prepared.previousStateDir;
  }
  const { token, stateDir } = ensureStateConfig(opts.userDataDir, stateUserDataDir, portableWorkspacePath);
  const retainedGateways = current.gateways.filter((gateway) => !isLegacyEmptyLocalGateway(gateway));
  const existing = retainedGateways.find((g) => g.id === LOCAL_GATEWAY_ID);
  const configuredDefaultStillExists = retainedGateways.some((gateway) => gateway.id === current.defaultGatewayId);
  const defaultGatewayId = configuredDefaultStillExists ? current.defaultGatewayId : LOCAL_GATEWAY_ID;

  const entry: GatewayServerConfig = {
    id: LOCAL_GATEWAY_ID,
    name: LOCAL_GATEWAY_NAME,
    url: `ws://127.0.0.1:${GATEWAY_WS_PORT}`,
    token,
    authMode: 'token',
    isDefault: defaultGatewayId === LOCAL_GATEWAY_ID,
  };

  const drifted = Boolean(existing && existing.token !== undefined && existing.token !== token);
  const gateways = mergeGatewayEntry(retainedGateways, entry);
  let bundledSkillRecords = current.bundledSkillRecords;
  if (previousStateDir && bundledSkillRecords) {
    const oldSkillsDir = path.join(previousStateDir, 'skills');
    const newSkillsDir = path.join(stateDir, 'skills');
    if (oldSkillsDir !== newSkillsDir && Object.hasOwn(bundledSkillRecords, oldSkillsDir)) {
      bundledSkillRecords = {
        ...bundledSkillRecords,
        [newSkillsDir]: bundledSkillRecords[newSkillsDir] ?? bundledSkillRecords[oldSkillsDir]!,
      };
      delete bundledSkillRecords[oldSkillsDir];
    }
  }
  const changed =
    JSON.stringify(gateways) !== JSON.stringify(current.gateways) ||
    current.defaultGatewayId !== defaultGatewayId ||
    bundledSkillRecords !== current.bundledSkillRecords;

  if (!changed) {
    return { token, changed: false, drifted: false, stateDir };
  }

  updateConfig({
    gateways,
    defaultGatewayId,
    ...(bundledSkillRecords ? { bundledSkillRecords } : {}),
  });

  if (drifted) {
    console.warn('[runtime] runtime.token-mismatch：客户端 config 里的网关令牌与 token store 不一致，已按 store 纠正');
  }

  return { token, changed: true, drifted, stateDir };
}
