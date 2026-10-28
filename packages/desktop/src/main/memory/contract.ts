/**
 * 把「记忆草案契约」注入 `AGENTS.md`（助手**怎么提草案**的唯一说明来源）。
 *
 * ## 为什么必须注入
 *
 * "助手只提草案"这句话只有助手知道才有用。没有这段契约，`collectMemoryDrafts` 那条路
 * 就是**有测试、没人触发**的死代码（这个仓库为此付过代价 —— 见 H4 那条"有测试没人看"）。
 *
 * ## 为什么是 `AGENTS.md`
 *
 * 运行时每轮全文注入 `AGENTS/SOUL/IDENTITY/USER/BOOTSTRAP/MEMORY` 六个文件，其中
 * **只有 `AGENTS.md` 会进子代理会话与定时任务**（`SUBAGENT_BOOTSTRAP_ALLOWLIST` /
 * `CRON_BOOTSTRAP_ALLOWLIST`，见 `capability-boundary-prompt.ts` 的实读结论）。
 * 能力边界已经住在那里（它自己的标记），记忆契约用**另一个标记**同住 ——
 * 两个前缀不互相匹配（`marked-block.ts` 的注释），谁也换不掉谁。
 *
 * ## 纪律（与能力边界同源）
 *
 * · **读不出来就不写**（RPC 失败 / 形状不认识 ⇒ `failed`，绝不盲写）；
 * · 只在区块内动手，用户正文原样保留；
 * · **永不抛**：注入失败只影响"模型提不提草案"，不许挡住任何东西。
 */

import { mergeMemoryContractBlock, renderMemoryContractPrompt } from '@clawwork/core';
import { getDebugLogger } from '../debug/index.js';
import { agentFileContent, type MemoryGatewayApi } from './materialize.js';

export const MEMORY_CONTRACT_AGENT_ID = 'main';
export const MEMORY_CONTRACT_FILE = 'AGENTS.md';

export interface MemoryContractOutcome {
  status: 'written' | 'upgraded' | 'unchanged' | 'failed';
  reason?: string;
}

/**
 * 一次注入尝试（不重试；重试由调用方按启动链的节奏做）。
 */
export async function ensureMemoryContractPrompt(
  gateway: MemoryGatewayApi,
  agentId: string = MEMORY_CONTRACT_AGENT_ID,
): Promise<MemoryContractOutcome> {
  let existing: string | null;
  try {
    existing = agentFileContent(await gateway.getAgentFile(agentId, MEMORY_CONTRACT_FILE));
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : 'read failed' };
  }
  if (existing === null) return { status: 'failed', reason: 'read unrecognized' };

  const merged = mergeMemoryContractBlock(existing, renderMemoryContractPrompt());
  if (!merged.changed) return { status: 'unchanged' };

  try {
    await gateway.setAgentFile(agentId, MEMORY_CONTRACT_FILE, merged.content);
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : 'write failed' };
  }
  return { status: existing.includes('partner-w-memory-contract:') ? 'upgraded' : 'written' };
}

/** 带退避的重试包装（与 `ensureCapabilityBoundaryPromptWithRetry` 同形状）。 */
export async function ensureMemoryContractPromptWithRetry(
  gateway: MemoryGatewayApi,
  options: { delaysMs?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<MemoryContractOutcome> {
  const delays = options.delaysMs ?? [5000, 15000, 30000];
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let outcome: MemoryContractOutcome = { status: 'failed', reason: 'not-attempted' };
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    outcome = await ensureMemoryContractPrompt(gateway);
    if (outcome.status !== 'failed') return outcome;
    const delay = delays[attempt];
    if (delay === undefined) break;
    getDebugLogger().info({
      domain: 'memory',
      event: 'memory.contract.retry',
      data: { attempt: attempt + 1, reason: outcome.reason ?? 'unknown' },
    });
    await sleep(delay);
  }
  return outcome;
}
