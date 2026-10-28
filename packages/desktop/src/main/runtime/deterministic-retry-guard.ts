/**
 * 确定性重复失败守卫 —— BUG-060 剩余项 (c)「同参确定性失败重复执行」+ BUG-032
 * 「有稳定提案身份时换名重投」的**代码级**落实（2026-10-13 集中整改 E 包）。
 *
 * ## 为什么是可回滚的状态目录插件，而不是改运行时分发
 *
 * 已核（2026-10-13 实读部署 2026.9.3）：
 *   ① `resolveToolLoopDetectionConfig`（`tool-loop-detection-config-BNhSu6Hy.mjs`）只认
 *      `tools.loopDetection.enabled` 一个键——没有阈值/工具/类别配置面，**表达不了**窄策略；
 *   ② 原生 `detectToolCallLoop` 的 generic_repeat 是"全工具、按会话+run、第 10 次才警告、
 *      第 20 次才拦"的全局阈值（`tool-loop-detection-Cl-reY4o.mjs`）——第 2 次同参确定失败
 *      不会被拦，且私改阈值=改全局 genericRepeat（本轮明确禁止）；
 *   ③ 内核给这类"执行前拦截"留的原生闸门就是插件钩子 `before_tool_call`
 *      （返回 `{block:true, blockReason}`，与收件箱守卫同一演练过的机制）+ `after_tool_call`
 *      （观察结果/错误）。
 * 所以本插件 = **最小执行前 hook**：不新增 UI 重试引擎、不动 BUG-050 整轮重试、不设全局阈值。
 *
 * ## 窄策略（唯一真源是下方插件源码；单测直接 import 状态目录里那份代码）
 *
 * 记录（after_tool_call）与拦截（before_tool_call）共用同一把键：
 *   `(agentId, sessionKey|sessionId, runId) + toolName + 规范化参数 sha256 + 失败类别`
 *
 * 白名单类别（只有这些会记录；其余一律放行）——判据 = 该失败**不受状态变化影响**：
 *   - `parameter-validation`      内核参数校验族（"Supply correct parameters before retrying."，
 *                                 BUG-060 现场 `read {action,name}` 缺 path 的确切形状）；
 *   - `skill-name-invalid`        "Skill name must contain at least one letter or number."（名称语法）；
 *   - `proposal-not-pending`      "Only pending proposals can be revised."（提案状态单向推进
 *                                 pending → 终态，不会自行回到 pending）。
 * 2026-10-14 E-R2 修正：`skill-workshop-ownership`（"Skill Workshop can only update skills it
 * generated." 实为当前技能目录查找返回空，目标随后可被创建/恢复）与 `proposal-not-found`
 * （同属"当前查找失败"）**移出白名单** —— 原生没有稳定拒绝原因码/epoch，就不做固定 TTL
 * 缓存；这类失败既不记录也不拦截，目标状态变化后同参重投可真实执行。
 *
 * 稳定身份规则（与同参规则分开）——只覆盖"同一可变更 action + 同一可信目标 + 相同拒绝前提
 * 下的**纯换名重投**"：
 *   - 只有 `tool === 'skill_workshop'`（记录入口核实工具身份：其他工具仅因参数带 proposal_id
 *     不得入此规则）且 action ∈ {revise, apply, reject, quarantine}（提案生命周期写操作）
 *     且类别 ∈ 稳定身份类别时才记录；
 *   - 记录键 = `(scope, action, proposal_id)`，并保存除展示名 `name` 外的参数指纹；
 *   - 拦截要求同 action、同 proposal_id、除 `name` 外参数指纹一致（参数语义有变化 =
 *     另一次调用 ⇒ 放行）、工具身份一致、TTL 内；
 *   - inspect / list / read / evaluate / history 等查询 action 永不记录、永不命中
 *     （E-R1：revise 的失败不得吞掉合法查询）。
 * **无稳定身份的换名**（如 create 用了纯符号名）不做"同一候选"声称——那是 BUG-032
 * 索引/合同面的职责，不在这里猜。
 *
 * 缓存边界（内核**没有**真正可读的权限/工具面 epoch 字段，所以这里的失效条件全部来自
 * 下面这几条可实现的事实 —— 不声称存在版本/授权代数比对）：
 *   - 作用域含 runId：新 run 从头开始，同 run 先拒后授权不受影响（权限/审批结果**不在**
 *     白名单 —— 它们不天然永久，从不记录，授权后同参可真实执行）；
 *   - 记录随宿主给出的 toolKind/toolInputKind 绑定，**两个分支共用同一套 identityMatches**，
 *     工具身份变化即不再命中（E-R3）；身份缺失按"缺 = 缺"严格比较，绝不与具体值万能匹配
 *     （与 byCall 同向 fail-open）；
 *   - 记录有 TTL 与容量上限（256 条，先入先出），只在网关进程内存里，不落盘；所有索引同一
 *     生命周期（E-R4：曾有的 scope+tool 快路集合已移除，不再随 run 无界增长）；
 *   - 网络/超时/审批 pending/正常 polling 等文本不含白名单串 ⇒ 不记录、不误杀。
 *
 * ## 装载三条件（与收件箱守卫/搜索插件同一条路，少一条静默失效）
 *
 * `plugins.load.paths` 指向插件目录 + 目录里三件套（openclaw.plugin.json 含
 * `activation.onStartup:true`、package.json 指入口、index.mjs）+ `plugins.entries.<id>.enabled=true`
 * ——由 `state-config.ts` 每次启动对齐（`hasRetryGuardPolicy` 参与提前返回判据）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const RETRY_GUARD_PLUGIN_ID = 'partner-w-retry-guard';
/** 插件目录族（相对状态目录）：`<stateDir>/policies/partner-w-retry-guard/`。 */
export const RETRY_GUARD_POLICY_DIR_NAME = 'policies';

/** 插件目录的绝对路径。 */
export function retryGuardPolicyDir(stateDir: string): string {
  return path.join(stateDir, RETRY_GUARD_POLICY_DIR_NAME, RETRY_GUARD_PLUGIN_ID);
}

/**
 * 插件源码（`index.mjs`）。零本仓依赖，除 node 内建（`node:crypto`）外不 import。
 *
 * ⚠️ 模板字符串纪律：这份 JS 里**不用** backtick 模板字面量、不写 `${`（外层就是模板
 *    字符串）；所有反斜杠转义（`\\u0000` / `\\p` 等）写成双反斜杠，落到插件源码里是单反斜杠。
 */
export const RETRY_GUARD_PLUGIN_ENTRY = `// Partner-W · 确定性重复失败守卫（由应用生成，请勿手改）
//
// 规则与边界见应用侧 runtime/deterministic-retry-guard.ts 的文件头注释。
// 拦截记录只存在于本网关进程内存；作用域=(agent, session, run)，随 run 结束自然失效。
import { createHash } from 'node:crypto';

const MARKER = '[Partner-W重试保护]';
const RECORD_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_RECORDS = 256;
const NUL = '\\u0000';

const CATEGORY_PATTERNS = [
  ['parameter-validation', ['Supply correct parameters before retrying.']],
  ['skill-name-invalid', ['Skill name must contain at least one letter or number.']],
  ['proposal-not-pending', ['Only pending proposals can be revised.']]
];

// 稳定身份类别：只有拒绝前提不随状态变化（提案状态单向推进）时才参与"同 action 换名重投"。
const IDENTITY_CATEGORIES = { 'proposal-not-pending': true };

// 可变更 action（提案生命周期写操作）。查询类（inspect/list/read/evaluate/history）永不参与。
const MUTABLE_PROPOSAL_ACTIONS = { revise: true, apply: true, reject: true, quarantine: true };

// 换名维度：仅展示名 name。其余任何参数变化 = 语义变化 = 另一次调用 ⇒ 不拦。
const RENAME_KEYS = { name: true };

const RETRY_GUARD_TOOL = 'skill_workshop';

const ADVICE = {
  'parameter-validation':
    '先修正参数再重试：read 需要 path；技能正文按技能清单里的 <location> 用 read 读取；write 需要 path 与 content。',
  'skill-name-invalid':
    '技能名必须包含字母或数字（中文名会自动派生安全键）；请修改名称后重试。',
  'proposal-not-pending':
    '该提案已不在 pending 状态；请先 list 查看当前状态，再决定 inspect/revise。'
};

/** key: scope + NUL + tool + NUL + argsHash -> { category, at, excerpt, toolKind, toolInputKind } */
const byCall = new Map();
/** key: scope + NUL + action + NUL + proposalId -> { category, at, excerpt, toolKind, toolInputKind, restHash } */
const byProposal = new Map();

function trimStore(store, now) {
  for (const entry of store) {
    const key = entry[0];
    const record = entry[1];
    if (!record || now - record.at > RECORD_TTL_MS) store.delete(key);
    else break;
  }
  while (store.size > MAX_RECORDS) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

function scopeOf(ctx) {
  const agentId = ctx && typeof ctx.agentId === 'string' ? ctx.agentId : '';
  const session =
    ctx && typeof ctx.sessionKey === 'string' && ctx.sessionKey
      ? ctx.sessionKey
      : ctx && typeof ctx.sessionId === 'string'
        ? ctx.sessionId
        : '';
  const runId = ctx && typeof ctx.runId === 'string' ? ctx.runId : '';
  return agentId + NUL + session + NUL + runId;
}

function canonicalize(value) {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'string') return JSON.stringify(value);
  if (kind === 'number') return Number.isFinite(value) ? String(value) : JSON.stringify(String(value));
  if (kind === 'boolean') return value ? 'true' : 'false';
  if (kind === 'undefined') return 'undefined';
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (kind === 'object') {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const key of keys) parts.push(JSON.stringify(key) + ':' + canonicalize(value[key]));
    return '{' + parts.join(',') + '}';
  }
  return JSON.stringify(String(value));
}

function argsHashOf(params) {
  return createHash('sha256').update(canonicalize(params)).digest('hex');
}

function classifyFailure(text) {
  if (typeof text !== 'string' || !text) return undefined;
  if (text.indexOf(MARKER) >= 0) return undefined;
  for (const entry of CATEGORY_PATTERNS) {
    const needles = entry[1];
    for (const needle of needles) if (text.indexOf(needle) >= 0) return entry[0];
  }
  return undefined;
}

function failureTextOf(event) {
  if (typeof event.error === 'string' && event.error) return event.error;
  const result = event.result;
  if (!result || typeof result !== 'object') return undefined;
  const details = result.details;
  const looksFailed =
    result.isError === true ||
    (details && typeof details === 'object' && (details.status === 'error' || details.status === 'failed'));
  if (!looksFailed) return undefined;
  try {
    return JSON.stringify(result).slice(0, 20000);
  } catch {
    return undefined;
  }
}

function toolNameOf(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function proposalIdOf(params) {
  if (!params || typeof params !== 'object') return '';
  const value = params.proposal_id;
  return typeof value === 'string' ? value.trim() : '';
}

function actionOf(params) {
  if (!params || typeof params !== 'object') return '';
  const value = params.action;
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** 除换名维度（RENAME_KEYS）外的参数指纹：只有它一致才构成"纯换名重投"。 */
function restHashOf(params) {
  const rest = {};
  for (const key of Object.keys(params)) {
    if (RENAME_KEYS[key] === true) continue;
    rest[key] = params[key];
  }
  return argsHashOf(rest);
}

/**
 * 工具身份判据（byCall 与 byProposal 共用，E-R3）：
 * 严格相等比较（缺身份 = undefined 只能与 undefined 匹配，绝不与具体值万能匹配）。
 * 宿主 after 帧缺 toolKind 时记录为 undefined ⇒ 带身份的 before 帧不会命中（fail-open）。
 */
function identityMatches(record, ctx) {
  const toolKind = ctx && typeof ctx.toolKind === 'string' ? ctx.toolKind : undefined;
  const toolInputKind = ctx && typeof ctx.toolInputKind === 'string' ? ctx.toolInputKind : undefined;
  return record.toolKind === toolKind && record.toolInputKind === toolInputKind;
}

function blockReasonFor(record) {
  return (
    MARKER +
    ' 已阻止重复执行：本次调用与当前运行中上一笔完全相同的失败调用（同一工具 + 同一参数 + 同一确定失败类别：' +
    record.category +
    '）。上一笔失败原文：' +
    record.excerpt +
    '\\n处理建议：' +
    (ADVICE[record.category] || '修好失败原因或换用其他参数/工具后再试；修改任意参数后会真实执行。') +
    '（重复原样提交不会执行；新一轮运行不受影响。）'
  );
}

function proposalBlockReason(category, action, proposalId) {
  return (
    MARKER +
    ' 已阻止重复提交：提案 ' +
    proposalId +
    ' 的 ' +
    action +
    ' 上一次已确定失败（类别：' +
    category +
    '）。同一 action 仅换名称重投不会执行；请改用其他提案 id，或先按建议修正：' +
    (ADVICE[category] || '先 list 提案重取目标。') +
    '（inspect/list 等查询不受影响；其他 action 与其他提案不受影响；新一轮运行不受影响。）'
  );
}

function afterToolCall(event, ctx) {
  try {
    if (!event || typeof event !== 'object') return undefined;
    const text = failureTextOf(event);
    const category = classifyFailure(text);
    if (!category) return undefined;
    const now = Date.now();
    const scope = scopeOf(ctx);
    const tool = toolNameOf(event.toolName);
    const params = event.params && typeof event.params === 'object' ? event.params : {};
    const toolKind = ctx && typeof ctx.toolKind === 'string' ? ctx.toolKind : undefined;
    const toolInputKind = ctx && typeof ctx.toolInputKind === 'string' ? ctx.toolInputKind : undefined;
    byCall.set(scope + NUL + tool + NUL + argsHashOf(params), {
      category,
      at: now,
      excerpt: text.slice(0, 240),
      toolKind,
      toolInputKind
    });
    // 稳定身份记录入口（三条件全过才记录）：工具身份 = skill_workshop；action = 可变更
    // 生命周期写操作；类别 = 稳定身份类别。其他工具仅因参数带 proposal_id 不得入此规则。
    const action = actionOf(params);
    const proposalId = proposalIdOf(params);
    if (
      tool === RETRY_GUARD_TOOL &&
      proposalId &&
      MUTABLE_PROPOSAL_ACTIONS[action] === true &&
      IDENTITY_CATEGORIES[category] === true
    ) {
      byProposal.set(scope + NUL + action + NUL + proposalId, {
        category,
        at: now,
        excerpt: text.slice(0, 240),
        toolKind,
        toolInputKind,
        restHash: restHashOf(params)
      });
    }
    trimStore(byCall, now);
    trimStore(byProposal, now);
    return undefined;
  } catch {
    return undefined;
  }
}

function beforeToolCall(event, ctx) {
  try {
    if (!event || typeof event !== 'object') return undefined;
    const now = Date.now();
    const scope = scopeOf(ctx);
    const tool = toolNameOf(event.toolName);
    const params = event.params && typeof event.params === 'object' ? event.params : {};
    const record = byCall.get(scope + NUL + tool + NUL + argsHashOf(params));
    if (record && now - record.at <= RECORD_TTL_MS && identityMatches(record, ctx)) {
      return { block: true, blockReason: blockReasonFor(record) };
    }
    if (tool === RETRY_GUARD_TOOL) {
      const action = actionOf(params);
      const proposalId = proposalIdOf(params);
      // 稳定身份分支与 byCall 同一套 scope/工具身份/TTL 校验（E-R3）；
      // 仅"同 action + 同提案 + 除 name 外参数指纹一致"（纯换名重投）才拦（E-R1）。
      if (proposalId && MUTABLE_PROPOSAL_ACTIONS[action] === true) {
        const identity = byProposal.get(scope + NUL + action + NUL + proposalId);
        if (
          identity &&
          now - identity.at <= RECORD_TTL_MS &&
          identityMatches(identity, ctx) &&
          identity.restHash === restHashOf(params)
        ) {
          return { block: true, blockReason: proposalBlockReason(identity.category, action, proposalId) };
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export default {
  id: '${RETRY_GUARD_PLUGIN_ID}',
  name: 'Partner-W·重复失败守卫',
  description: '对确定类别的重复失败做执行前拦截（同参重复 / 同一提案换名重投），返回可行动的具名结果。',
  register(api) {
    api.on('before_tool_call', beforeToolCall, { priority: 100 });
    api.on('after_tool_call', afterToolCall);
  }
};
`;

/** 插件清单。`activation.onStartup: true` 是"网关启动时加载"的开关（缺了就不加载，实测）。 */
export const RETRY_GUARD_PLUGIN_MANIFEST = `${JSON.stringify(
  {
    id: RETRY_GUARD_PLUGIN_ID,
    name: 'Partner-W·重复失败守卫',
    description: '对确定类别的重复失败做执行前拦截（同参重复 / 同一提案换名重投），返回可行动的具名结果。',
    activation: { onStartup: true },
    configSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  null,
  2,
)}\n`;

/** 包元数据：`openclaw.extensions` 指入口（缺了同样不加载，实测）。 */
export const RETRY_GUARD_PLUGIN_PACKAGE_JSON = `${JSON.stringify(
  {
    name: RETRY_GUARD_PLUGIN_ID,
    version: '1.0.0',
    private: true,
    type: 'module',
    openclaw: { extensions: ['./index.mjs'] },
  },
  null,
  2,
)}\n`;

/** 插件目录里的三个文件（文件名 → 内容）。 */
export function retryGuardPolicyFiles(): Record<string, string> {
  return {
    'openclaw.plugin.json': RETRY_GUARD_PLUGIN_MANIFEST,
    'package.json': RETRY_GUARD_PLUGIN_PACKAGE_JSON,
    'index.mjs': RETRY_GUARD_PLUGIN_ENTRY,
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
 * 写失败**向上抛** —— 调用方据此决定"这次别把配置指过去"（宁可不装，也不指向不存在的目录）。
 */
export function ensureRetryGuardPolicy(stateDir: string): string {
  const dir = retryGuardPolicyDir(stateDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  for (const [name, contents] of Object.entries(retryGuardPolicyFiles())) {
    writeFileIfChanged(path.join(dir, name), contents);
  }
  return dir;
}
