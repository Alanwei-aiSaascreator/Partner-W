import {
  MAIN_AGENT_ID,
  MAIN_AGENT_PROMPT_FILES,
  PRESET_PROMPT_VERSION,
  readPresetPromptVersion,
  stampPresetPrompt,
} from '@/lib/preset-agents';
import type { MainAgentPromptFile } from '@/lib/preset-agents';

/**
 * 给**主罗盘**（网关里的 `main`）写交付合同。
 *
 * ## 🔴 为什么需要这一步（2026-10-07 真机调查）
 *
 * 六个预置助手由 `preset-agent-installer` 写 `IDENTITY.md` / `SOUL.md`，而**主罗盘什么都没有**。
 * 这两个文件是运行时**每轮全文注入**的提示词通道 —— 也就是说：用户从工作台默认入口
 * （主罗盘）发起的任务，**交付合同根本到不了它**。同一产品、两个入口、两套行为，
 * 演示走错路、"已生成"式谎报的坑在这里没有任何护栏。
 *
 * 工程上照 `ensureOurSkills`（随包技能自装）的形状做：**启动链里的一步、尽力而为、
 * 缺了什么补什么、绝不覆盖用户后来手改的内容**。
 *
 * ## 幂等与"不碰用户的东西"
 *
 * 与预置助手安装器**同一套版本标记**（`<!-- mofang-prompt:<版本> -->`）：
 * - 文件**缺失** ⇒ 写（带标记）；
 * - 文件带**我们的旧标记** ⇒ 覆盖升级（版本号对不上 = 是我们写的旧版）；
 * - 文件带**当前标记** ⇒ 跳过；
 * - 文件**没有标记** ⇒ **一律不碰** —— 那是用户手改的、或标记机制出现之前就存在的文件，
 *   覆盖会抹掉用户的东西（`preset-agents.ts` 的长注释即此契约）。
 *
 * ⚠️ **读不出来就不写**：`getAgentFile` 失败、或返回的形状不是我们认识的那种，
 *    都记成 failed 并跳过那个文件 —— 宁可少写一份，也绝不把"读不到"当成"不存在"而盲写。
 */

export interface MainAgentFileResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface MainAgentContractApi {
  getAgentFile: (gatewayId: string, agentId: string, name: string) => Promise<MainAgentFileResult>;
  setAgentFile: (gatewayId: string, agentId: string, name: string, content: string) => Promise<MainAgentFileResult>;
}

export interface MainAgentContractResult {
  /** 之前没有、这次写上的。 */
  written: string[];
  /** 是我们写的旧版本、这次覆盖升级的。 */
  upgraded: string[];
  /** 已是当前版本，或不是我们写的（用户手改）——两种都算"不动作"。 */
  skipped: string[];
  failed: Array<{ name: string; error: string }>;
}

function readFileState(result: MainAgentFileResult): { exists: boolean; content: string } | null {
  if (!result.ok) return null;
  const payload = result.result;
  if (!payload || typeof payload !== 'object' || !('file' in payload)) return null;
  const file = (payload as { file?: unknown }).file;
  if (!file || typeof file !== 'object') return null;
  const missing = 'missing' in file && (file as { missing?: unknown }).missing === true;
  const raw = 'content' in file ? (file as { content?: unknown }).content : '';
  const content = typeof raw === 'string' ? raw : '';
  return { exists: !missing && content.trim().length > 0, content };
}

export async function ensureMainAgentContract(
  gatewayId: string,
  api: MainAgentContractApi,
  files: readonly MainAgentPromptFile[] = MAIN_AGENT_PROMPT_FILES,
): Promise<MainAgentContractResult> {
  const result: MainAgentContractResult = { written: [], upgraded: [], skipped: [], failed: [] };

  for (const file of files) {
    try {
      const state = readFileState(await api.getAgentFile(gatewayId, MAIN_AGENT_ID, file.name));
      if (!state) {
        // ⚠️ 读不到 ≠ 不存在：不写（写下去可能覆盖用户的内容）。
        result.failed.push({ name: file.name, error: 'read failed' });
        continue;
      }

      if (state.exists) {
        const stamped = readPresetPromptVersion(state.content);
        // 没有标记 = 不是我们写的（用户手改 / 老盘遗留）⇒ 一个字都不动。
        if (stamped === null || stamped === PRESET_PROMPT_VERSION) {
          result.skipped.push(file.name);
          continue;
        }
      }

      const write = await api.setAgentFile(
        gatewayId,
        MAIN_AGENT_ID,
        file.name,
        stampPresetPrompt(file.content, PRESET_PROMPT_VERSION),
      );
      if (!write.ok) {
        result.failed.push({ name: file.name, error: write.error ?? 'write failed' });
        continue;
      }
      (state.exists ? result.upgraded : result.written).push(file.name);
    } catch (error) {
      result.failed.push({
        name: file.name,
        error: error instanceof Error ? error.message : 'write failed',
      });
    }
  }

  return result;
}

export interface MainAgentContractRetryDeps {
  ensure: (gatewayId: string) => Promise<MainAgentContractResult>;
  sleep: (ms: number) => Promise<void>;
  delaysMs: readonly number[];
}

/**
 * 与 `ensureBundledSkillsWithRetry` 同形的重试：网关刚连上时可能还没热，
 * 而这一步**不该挡启动** —— 失败重试后仍失败就返回 false，由调用方记一条 warn。
 * **永不抛**（`runWorkspaceGatedBootstrap` 的 `Promise.all` 里不能有会炸的分支）。
 */
export async function ensureMainAgentContractWithRetry(
  gatewayId: string,
  deps: MainAgentContractRetryDeps,
): Promise<boolean> {
  for (let attempt = 0; attempt <= deps.delaysMs.length; attempt += 1) {
    try {
      const result = await deps.ensure(gatewayId);
      if (result.failed.length === 0) return true;
    } catch {}
    const delay = deps.delaysMs[attempt];
    if (delay === undefined) break;
    await deps.sleep(delay);
  }
  return false;
}
