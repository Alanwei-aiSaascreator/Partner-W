/**
 * 把**已确认**记忆投影进助手工作区的 `MEMORY.md`（真召回通道）。
 *
 * ## 证据链是什么（为什么不是"写进文件就算"）
 *
 * 这里做的是**两段式**：
 *   ① 读该助手现在的 `MEMORY.md`（读不出来 ⇒ **不写**，记为 failed）；
 *   ② 并入受管区块后写回，**再从网关读回来**，把读回来的区块条目行放进 `readback`。
 *
 * `readback` 才是"助手下一轮真的会读到这些字"的那份证据 —— 它是**经网关 RPC 回读**的
 * 文件内容，而不是我们自己内存里刚拼的那个字符串。`MEMORY.md` 又在运行时的
 * `WORKSPACE_BOOTSTRAP_FILENAMES`（每轮全文注入）里，所以这条链是完整的：
 * `confirm → 库(真源) → 网关写 MEMORY.md → 网关回读 → 与库一致`。
 *
 * ## 写给"盘上每一个助手"
 *
 * 口径与 `USER.md` 一致（记忆页文件头"这块盘懂我"）：用户心里记的是**这块盘**，
 * 不是"当前这个助手"。所以调用方把目录里的助手 id 全传进来，逐个写。
 * 某个助手写失败**不影响**其它助手（如实计数，不报"全部成功"）。
 */

import { memoryBlockEntryLines, mergeMemoryBlock, renderMemoryBlock, type MemoryEntry } from '@clawwork/core';

export const MEMORY_FILE_NAME = 'MEMORY.md';

export interface MemoryGatewayApi {
  getAgentFile(agentId: string, name: string): Promise<unknown>;
  setAgentFile(agentId: string, name: string, content: string): Promise<unknown>;
}

export interface MaterializeResult {
  /** 这次真的改动了文件的助手。 */
  written: string[];
  /** 已经是最新内容、一个字节都不用写的助手（幂等命中）。 */
  unchanged: string[];
  /** 读不出来 / 写不进去的助手（**如实报**，绝不吞）。 */
  failed: Array<{ agentId: string; error: string }>;
  /** 这次写进区块的正文（调用方用于回执与断言）。 */
  block: string;
  /** 每个助手上**回读**到的区块条目行 —— 召回证据链的落点。 */
  readback: Record<string, string[]>;
}

/** 从 `agents.files.get` 的真机载荷里取正文；形状不认识 ⇒ `null`（= 读失败，不写）。 */
export function agentFileContent(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || !('file' in payload)) return null;
  const file = (payload as { file?: unknown }).file;
  if (!file || typeof file !== 'object') return null;
  const missing = (file as { missing?: unknown }).missing === true;
  const raw = 'content' in file ? (file as { content?: unknown }).content : '';
  if (missing) return '';
  if (raw === undefined || raw === null) return '';
  return typeof raw === 'string' ? raw : null;
}

/**
 * 逐个助手投影。**永不抛**：每个助手各自 try/catch，失败只进 `failed`。
 */
export async function materializeMemory(input: {
  gateway: MemoryGatewayApi;
  agentIds: readonly string[];
  entries: readonly Pick<MemoryEntry, 'text'>[];
}): Promise<MaterializeResult> {
  const block = renderMemoryBlock(input.entries);
  const result: MaterializeResult = { written: [], unchanged: [], failed: [], block, readback: {} };

  for (const agentId of input.agentIds) {
    let existing: string | null;
    try {
      existing = agentFileContent(await input.gateway.getAgentFile(agentId, MEMORY_FILE_NAME));
    } catch (error) {
      result.failed.push({ agentId, error: error instanceof Error ? error.message : 'read failed' });
      continue;
    }
    if (existing === null) {
      // ⚠️ 形状不认识 = 读失败。**不写** —— 那可能是把一个本来有内容的文件覆盖成"只有我们这一块"。
      result.failed.push({ agentId, error: 'read unrecognized' });
      continue;
    }

    const merged = mergeMemoryBlock(existing, block);
    if (!merged.changed) {
      result.unchanged.push(agentId);
      result.readback[agentId] = memoryBlockEntryLines(merged.content);
      continue;
    }

    try {
      await input.gateway.setAgentFile(agentId, MEMORY_FILE_NAME, merged.content);
    } catch (error) {
      result.failed.push({ agentId, error: error instanceof Error ? error.message : 'write failed' });
      continue;
    }

    // 回读（证据链的第二段）：不拿自己刚拼的字符串冒充"文件里现在是什么"。
    try {
      const readBack = agentFileContent(await input.gateway.getAgentFile(agentId, MEMORY_FILE_NAME));
      if (readBack === null) {
        result.failed.push({ agentId, error: 'readback unrecognized' });
        continue;
      }
      result.written.push(agentId);
      result.readback[agentId] = memoryBlockEntryLines(readBack);
    } catch (error) {
      result.failed.push({ agentId, error: error instanceof Error ? error.message : 'readback failed' });
    }
  }

  return result;
}
