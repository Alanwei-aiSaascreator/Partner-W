/**
 * 能力边界的**注入端**（BUG-043 · Planner 边界的"提示词"那一半）。
 *
 * ## 为什么住在主进程
 *
 * 注入通道是网关的 `agents.files.set`（agent workspace 的提示词文件）——写入能力
 * 只有主进程的网关连接有（渲染层的同名 RPC 走 `ws-handlers`，本轮不改那条面）。
 * 纯逻辑（账本、三态、文案、标记合并）全部住在 `@clawwork/core` 的 `capability/`，
 * 这里只做**接线 + IO**，主进程侧的测试因此可以全用假网关（不起真进程）。
 *
 * ## 往哪儿写、为什么是 AGENTS.md
 *
 * 运行时每轮把 agent workspace 的 `AGENTS/SOUL/IDENTITY/USER/BOOTSTRAP/MEMORY` 全文注入
 * 系统提示词（`WORKSPACE_BOOTSTRAP_FILENAMES`，随包运行时实读）。其中：
 *   · `SOUL.md` / `IDENTITY.md` 由 `main-agent-contract` 按它的版本标记管理；
 *   · `USER.md` 归「个性化中心」；
 *   · **`AGENTS.md` 无人写**，而它正是运行时模板里"本地工具与环境说明"的指定位置
 *     （`docs/reference/templates/AGENTS.md` 的 `## Tools` 一节）。
 * ⇒ 能力边界写进 `AGENTS.md` 一个**带起止标记的区块**：区块内自动维护、区块外一字不动。
 *
 * ⭐ 选 `AGENTS.md` 而不是别的槽位，是**读随包运行时源码**定的（2026-10-08，`dist/workspace-*.mjs`）：
 *   · `ALLOWED_FILE_NAMES = new Set(WORKSPACE_BOOTSTRAP_FILENAMES)`（`dist/agents-*.mjs`）
 *     ⇒ `agents.files.set` 收这 6 个名字，**包含 `AGENTS.md`**；
 *   · `SUBAGENT_BOOTSTRAP_ALLOWLIST = { AGENTS.md }`（**只有它**会进子代理会话），
 *     `CRON_BOOTSTRAP_ALLOWLIST` 也含它 ⇒ 能力边界能覆盖主会话 + 子代理 + 定时任务，
 *     而 `MEMORY.md` 只进主会话、`SOUL/IDENTITY/USER` 会在子代理里被滤掉。
 *   （`TOOLS.md` 是**已退役**的名字：运行时模板明写在 `AGENTS.md` 的 `## Tools` 一节，
 *     写 `TOOLS.md` 不会被注入到任何会话。）
 *
 * ## 硬纪律（与 `main-agent-contract` 同源）
 *
 * · **读不出来就不写**（RPC 失败 / 形状不认识 ⇒ `failed`，绝不盲写）；
 * · **只在区块内动手**：已有区块换版本，用户正文原样保留；
 * · **永不抛、永不阻塞启动**：调用方 `void ... .then(log)`，失败只留一条日志。
 */

import {
  buildCapabilityBoundaryPrompt,
  buildCapabilityRegistry,
  mergeCapabilityBoundaryBlock,
  type CapabilityModelSource,
} from '@clawwork/core';

export const CAPABILITY_BOUNDARY_AGENT_ID = 'main';
export const CAPABILITY_BOUNDARY_FILE = 'AGENTS.md';

/**
 * 本服务真正能服务的模型 provider（与 `relayModelsFrom` 同一把尺）。
 *
 * `models.list` 返回的是 openclaw 的**全量**目录（实测 44 provider / 1018 模型），
 * 不过滤就会把 `claude-opus-4` 这种"根本发不出去"的模型写进"可用模型"清单。
 */
const SERVICEABLE_MODEL_PROVIDER = 'clawrouter';

export interface CapabilityBoundaryGateway {
  listModels(agentId?: string): Promise<Record<string, unknown>>;
  getAgentFile(agentId: string, name: string): Promise<Record<string, unknown>>;
  setAgentFile(agentId: string, name: string, content: string): Promise<Record<string, unknown>>;
}

export type CapabilityBoundaryStatus = 'written' | 'upgraded' | 'unchanged' | 'failed';

export interface CapabilityBoundaryOutcome {
  status: CapabilityBoundaryStatus;
  /** 写进/待写的模型条数（日志与自查用；failed 时为 0）。 */
  modelCount: number;
  reason?: string;
}

/** `models.list` 响应 → 注册表输入（只留本服务的 provider；形状不对 = 空列表，不猜）。 */
export function parseServiceableModels(payload: unknown): CapabilityModelSource[] {
  if (!payload || typeof payload !== 'object') return [];
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  const result: CapabilityModelSource[] = [];
  for (const entry of models) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as { id?: unknown; provider?: unknown; input?: unknown };
    if (typeof record.id !== 'string' || record.id.length === 0) continue;
    if (record.provider !== SERVICEABLE_MODEL_PROVIDER) continue;
    result.push({
      id: record.id,
      ...(typeof record.provider === 'string' ? { provider: record.provider } : {}),
      ...(record.input !== undefined ? { input: record.input } : {}),
    });
  }
  return result;
}

interface AgentFileState {
  exists: boolean;
  content: string;
}

/** `agents.files.get` 响应 → 文件状态；**形状不认识 ⇒ null**（调用方按"读失败"处理）。 */
function readFileState(payload: unknown): AgentFileState | null {
  if (!payload || typeof payload !== 'object' || !('file' in payload)) return null;
  const file = (payload as { file?: unknown }).file;
  if (!file || typeof file !== 'object') return null;
  const missing = 'missing' in file && (file as { missing?: unknown }).missing === true;
  const raw = 'content' in file ? (file as { content?: unknown }).content : '';
  const content = typeof raw === 'string' ? raw : '';
  return { exists: !missing && content.trim().length > 0, content };
}

/**
 * 一次注入尝试（不重试）。任何一步失败都如实返回，**不抛**。
 */
export async function ensureCapabilityBoundaryPrompt(
  gateway: CapabilityBoundaryGateway,
  agentId: string = CAPABILITY_BOUNDARY_AGENT_ID,
): Promise<CapabilityBoundaryOutcome> {
  let state: AgentFileState | null;
  try {
    state = readFileState(await gateway.getAgentFile(agentId, CAPABILITY_BOUNDARY_FILE));
  } catch (error) {
    return { status: 'failed', modelCount: 0, reason: error instanceof Error ? error.message : 'read failed' };
  }
  if (!state) return { status: 'failed', modelCount: 0, reason: 'read unrecognized' };

  let models: CapabilityModelSource[] = [];
  try {
    models = parseServiceableModels(await gateway.listModels(agentId));
  } catch {
    // 目录拉不到不是失败：规则段（不支持什么、怎么说）照样要注入，
    // 只是"可用模型清单"退化为"以工作台模型选择器为准"。
    models = [];
  }
  const registry = buildCapabilityRegistry({ models });
  const block = buildCapabilityBoundaryPrompt(registry);
  const merged = mergeCapabilityBoundaryBlock(state.content, block);
  if (!merged.changed) return { status: 'unchanged', modelCount: models.length };

  try {
    await gateway.setAgentFile(agentId, CAPABILITY_BOUNDARY_FILE, merged.content);
  } catch (error) {
    return {
      status: 'failed',
      modelCount: models.length,
      reason: error instanceof Error ? error.message : 'write failed',
    };
  }
  return { status: state.exists ? 'upgraded' : 'written', modelCount: models.length };
}

export interface CapabilityBoundaryRetryDeps {
  sleep: (ms: number) => Promise<void>;
  delaysMs: readonly number[];
}

/**
 * 带退避的注入（网关刚起来、或还没握手时用）。
 *
 * ⚠️ 与 `ensureMainAgentContractWithRetry` 同形：**永不抛**（调用方在启动链的
 *    fire-and-forget 分支里，炸了会变成 unhandled rejection）。
 * ⚠️ 只在"还没写成"时重试；写成功（含 unchanged）就返回。
 */
export async function ensureCapabilityBoundaryPromptWithRetry(
  gateway: CapabilityBoundaryGateway,
  deps: CapabilityBoundaryRetryDeps,
  agentId: string = CAPABILITY_BOUNDARY_AGENT_ID,
): Promise<CapabilityBoundaryOutcome> {
  let outcome: CapabilityBoundaryOutcome = { status: 'failed', modelCount: 0, reason: 'not attempted' };
  for (let attempt = 0; attempt <= deps.delaysMs.length; attempt += 1) {
    outcome = await ensureCapabilityBoundaryPrompt(gateway, agentId);
    if (outcome.status !== 'failed') return outcome;
    const delay = deps.delaysMs[attempt];
    if (delay === undefined) break;
    await deps.sleep(delay);
  }
  return outcome;
}
