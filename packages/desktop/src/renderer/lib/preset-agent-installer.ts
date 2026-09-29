import {
  PRESET_AGENT_DEFINITIONS,
  PRESET_PROMPT_VERSION,
  readPresetPromptVersion,
  stampPresetPrompt,
} from '@/lib/preset-agents';
import type { AgentInstallDefinition } from '@clawwork/core';
import type { AgentInfo, AgentListResponse } from '@clawwork/shared';

interface MutationResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface PresetAgentInstallerApi {
  listAgents: (gatewayId: string) => Promise<MutationResult>;
  createAgent: (
    gatewayId: string,
    params: { name: string; workspace: string; emoji?: string },
  ) => Promise<MutationResult>;
  updateAgent: (gatewayId: string, params: { agentId: string; name?: string }) => Promise<MutationResult>;
  getAgentFile: (gatewayId: string, agentId: string, name: string) => Promise<MutationResult>;
  setAgentFile: (gatewayId: string, agentId: string, name: string, content: string) => Promise<MutationResult>;
  deleteAgent: (gatewayId: string, params: { agentId: string; deleteFiles?: boolean }) => Promise<MutationResult>;
}

export interface PresetAgentInstallProgress {
  completed: number;
  total: number;
  currentId: string;
}

export interface PresetAgentInstallResult {
  installed: string[];
  skipped: string[];
  /** 本地目录陈旧，创建冲突后通过网关实时目录安全对账复用的项。 */
  reconciled?: string[];
  failed: Array<{ id: string; error: string }>;
}

interface InstallPresetAgentPackParams {
  gatewayId: string;
  workspaceRoot: string;
  currentAgentIds: string[];
  /** 已存在但目录名称仍是稳定 ID 的半成品；只修名称，不覆盖非空用户文件。 */
  repairAgentIds?: string[];
  /** 启动内置助手时校验关键文件；市场模板沿用“ID 存在即跳过”的既有语义。 */
  verifyExisting?: boolean;
  /** U 盘预置助手保留半成品供下一轮修复，避免 exFAT 删除 tombstone。 */
  preservePartialOnFailure?: boolean;
  displayNames: Record<string, string>;
  definitions?: readonly AgentInstallDefinition[];
  api: PresetAgentInstallerApi;
  onProgress?: (progress: PresetAgentInstallProgress) => void;
}

function readCreatedAgentId(result: unknown): string {
  if (!result || typeof result !== 'object' || !('agentId' in result)) return '';
  return typeof result.agentId === 'string' ? result.agentId : '';
}

function resultError(result: MutationResult, fallback: string): string {
  return result.error?.trim() || fallback;
}

const ALREADY_EXISTS_RE = /agent "([^"]+)" already exists/i;

/** Mirrors OpenClaw's agent-id normalization, without its unsafe `main` fallback. */
function normalizeAgentIdForLookup(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 64);
}

function readListedAgents(result: unknown): AgentInfo[] {
  if (!result || typeof result !== 'object') return [];
  const agents = (result as Partial<AgentListResponse>).agents;
  if (!Array.isArray(agents)) return [];
  return agents.filter((agent): agent is AgentInfo => Boolean(agent && typeof agent.id === 'string'));
}

async function reconcileAlreadyExistingAgent(
  api: PresetAgentInstallerApi,
  gatewayId: string,
  expectedId: string,
  createError: string,
): Promise<string | null> {
  const claimedId = createError.match(ALREADY_EXISTS_RE)?.[1]?.trim();
  if (!claimedId) return null;

  const expectedKey = normalizeAgentIdForLookup(expectedId);
  if (!expectedKey || normalizeAgentIdForLookup(claimedId) !== expectedKey) return null;

  const listed = await api.listAgents(gatewayId);
  if (!listed.ok) throw new Error(resultError(listed, 'agent catalog refresh failed'));
  const agents = readListedAgents(listed.result);

  const exact = agents.find((agent) => agent.id === expectedId);
  if (exact) return exact.id;

  const normalizedMatches = agents.filter((agent) => normalizeAgentIdForLookup(agent.id) === expectedKey);
  return normalizedMatches.length === 1 ? normalizedMatches[0]!.id : null;
}

/** 读一个助手文件：在不在 + 正文（正文用来认版本标记）。 */
interface AgentFileState {
  exists: boolean;
  content: string;
}

async function readAgentFile(
  api: PresetAgentInstallerApi,
  gatewayId: string,
  agentId: string,
  name: string,
): Promise<AgentFileState> {
  const result = await api.getAgentFile(gatewayId, agentId, name);
  if (!result.ok) throw new Error(resultError(result, `${name} read failed`));
  const payload = result.result;
  if (!payload || typeof payload !== 'object' || !('file' in payload)) {
    throw new Error(`${name} read returned an invalid payload`);
  }
  const file = payload.file;
  if (!file || typeof file !== 'object') throw new Error(`${name} read returned an invalid file`);
  const missing = 'missing' in file && file.missing === true;
  const content = 'content' in file && typeof file.content === 'string' ? file.content : '';
  return { exists: !missing && content.trim().length > 0, content };
}

/**
 * 这份文件是不是「**我们写的**、但**不是这一版**」⇒ 该覆盖。
 *
 * ## 🔴 为什么必须补上这一段（2026-09-27）
 *
 * 标记机制（`<!-- mofang-prompt:<版本> -->`）建好很久了，但**从来没有人用它做升级** ——
 * 安装器只在**文件缺失**时写。后果写在 `preset-agents.ts` 的注释里却一直成立：
 *
 * > 改一次提示词，改动只在"新装"的盘上生效，**已发出去的盘永远不会变**。
 *
 * 实测代价：交付合同里那句"内容装得下时优先用模板"把助手送进了**每格约 40 字**的模板，
 * 用户真机上整份被拒、产物什么都没有。改掉那句话**新盘才生效**，老盘照旧踩坑。
 *
 * ⚠️ **没标记一律不碰**。标记的含义是"这份文件是我们写的、而且是我们这一版写的"；
 *    读不到标记 = 用户自己改过（或标记机制之前的老盘）。
 *    覆盖会**抹掉用户的修改** —— 这正是当初要盖这个标记的全部理由。
 */
function needsPromptUpgrade(content: string): boolean {
  const version = readPresetPromptVersion(content);
  return version !== null && version !== PRESET_PROMPT_VERSION;
}

/**
 * 是不是**内置的六个预置助手** —— 只有它们才盖/认我们的版本标记。
 *
 * ⚠️ 市场模板（`rongying-tpl-*`）与用户自己建的 agent **一律不算**：
 *    它们的正文来自数据库或用户本人，覆盖会**抹掉用户的东西**。
 *    同一个白名单判据在盖章那一侧也必须成立，两边缺一不可。
 */
function isBuiltInPresetId(id: string): boolean {
  return PRESET_AGENT_DEFINITIONS.some((preset) => preset.id === id);
}

async function rollbackNewAgent(
  api: PresetAgentInstallerApi,
  gatewayId: string,
  agentId: string,
): Promise<string | null> {
  try {
    const result = await api.deleteAgent(gatewayId, { agentId, deleteFiles: true });
    return result.ok ? null : resultError(result, 'rollback failed');
  } catch (error) {
    return error instanceof Error ? error.message : 'rollback failed';
  }
}

export async function installPresetAgentPack({
  gatewayId,
  workspaceRoot,
  currentAgentIds,
  repairAgentIds = [],
  verifyExisting = false,
  preservePartialOnFailure = false,
  displayNames,
  definitions = PRESET_AGENT_DEFINITIONS,
  api,
  onProgress,
}: InstallPresetAgentPackParams): Promise<PresetAgentInstallResult> {
  const installed: string[] = [];
  const skipped: string[] = [];
  const reconciled: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  const knownAgentIds = new Set(currentAgentIds);
  const repairAgentIdSet = new Set(repairAgentIds);
  const cleanWorkspaceRoot = workspaceRoot.replace(/[\\/]+$/, '');

  let completed = 0;
  for (const definition of definitions) {
    let createdAgentId = '';
    let createdNewAgent = false;
    let shouldRollbackUnexpectedId = false;
    let failureMessage = '';
    try {
      let alreadyExists = knownAgentIds.has(definition.id);
      let identityFile: AgentFileState = { exists: false, content: '' };
      let soulFile: AgentFileState = { exists: false, content: '' };
      /** ⭐ 「是**我们写的旧版本** ⇒ 该覆盖」。新装的 agent 两个都保持 `false`。 */
      let identityUpgrade = false;
      let soulUpgrade = false;

      if (!alreadyExists) {
        const createResult = await api.createAgent(gatewayId, {
          name: definition.creationName,
          workspace: `${cleanWorkspaceRoot}/rongying-agents/${definition.id}`,
          emoji: definition.emoji,
        });
        if (!createResult.ok) {
          const createError = resultError(createResult, 'agent creation failed');
          const reconciledId = await reconcileAlreadyExistingAgent(api, gatewayId, definition.id, createError);
          if (!reconciledId) throw new Error(createError);

          alreadyExists = true;
          createdAgentId = reconciledId;
          knownAgentIds.add(definition.id);
          reconciled.push(definition.id);
        } else {
          createdAgentId = readCreatedAgentId(createResult.result);
          createdNewAgent = Boolean(createdAgentId);
          if (createdAgentId !== definition.id) {
            shouldRollbackUnexpectedId = Boolean(createdAgentId);
            throw new Error(
              createdAgentId
                ? `gateway returned unexpected agent id: ${createdAgentId}`
                : 'gateway did not return an agent id',
            );
          }
        }
      }

      if (alreadyExists) {
        if (!verifyExisting && !repairAgentIdSet.has(definition.id)) {
          skipped.push(definition.id);
          completed++;
          onProgress?.({ completed, total: definitions.length, currentId: definition.id });
          continue;
        }
        createdAgentId ||= definition.id;
        identityFile = await readAgentFile(api, gatewayId, createdAgentId, 'IDENTITY.md');
        soulFile = await readAgentFile(api, gatewayId, createdAgentId, 'SOUL.md');
        // ⭐ **升级路**：文件都在、也**没有**"我们盖的旧版本标记"要处理时，才算跳过。
        //    ⚠️ 少了这两个 `needsPromptUpgrade` 条件，**老盘永远升不上来** ——
        //    提示词改动只在"新装"的机器上生效（见 `needsPromptUpgrade` 的说明）。
        //    ⚠️ 只有**内置预置**才判升级：市场模板（`rongying-tpl-*`）与用户的 agent 不归我们管。
        const builtIn = isBuiltInPresetId(definition.id);
        identityUpgrade = builtIn && needsPromptUpgrade(identityFile.content);
        soulUpgrade = builtIn && needsPromptUpgrade(soulFile.content);
        if (
          identityFile.exists &&
          soulFile.exists &&
          !repairAgentIdSet.has(definition.id) &&
          !identityUpgrade &&
          !soulUpgrade
        ) {
          skipped.push(definition.id);
          completed++;
          onProgress?.({ completed, total: definitions.length, currentId: definition.id });
          continue;
        }
      }

      // 新建项要设置本地化显示名；现有项只有明确仍是稳定 raw ID 时才修名称。
      // 单纯补 IDENTITY/SOUL 缺文件时不得碰名称，否则 OpenClaw 的 agents.update
      // 会连带重写用户已有的 IDENTITY.md。
      if (createdNewAgent || repairAgentIdSet.has(definition.id)) {
        const updateResult = await api.updateAgent(gatewayId, {
          agentId: createdAgentId,
          name: displayNames[definition.id] ?? definition.creationName,
        });
        if (!updateResult.ok) throw new Error(resultError(updateResult, 'agent name update failed'));
      }

      // ⚠️ 只有**内置的六个预置助手**才盖版本标记。标记的含义是"这份文件是我们写的、
      //    并且是我们这一版写的" —— 市场模板的内容来自数据库（`rongying-tpl-*`），
      //    用户还会自己改，盖我们的版本号会让"是我们的旧版本 ⇒ 可升级"
      //    的判据把**用户改过的模板**也认成我们的。判断按 id 白名单，不做例外。
      const stamp = (text: string) => (isBuiltInPresetId(definition.id) ? stampPresetPrompt(text) : text);

      if (!identityFile.exists || identityUpgrade) {
        // 为什么必须盖章：这两个文件是运行时**每轮全文注入**的提示词，而安装器原先只在
        // 文件缺失时才写 ⇒ 没有标记就永远无法安全地升级已有盘
        // （分不清"我们写的旧版本"和"用户自己改过的"）。见 `preset-agents.ts` 的长注释。
        //
        // ⭐ 2026-09-27 起 `identityUpgrade` 也在这一支里：**老盘终于能升上来了**。
        const identityResult = await api.setAgentFile(
          gatewayId,
          createdAgentId,
          'IDENTITY.md',
          stamp(definition.identityMd),
        );
        if (!identityResult.ok) throw new Error(resultError(identityResult, 'IDENTITY.md write failed'));
      }

      if (!soulFile.exists || soulUpgrade) {
        const soulResult = await api.setAgentFile(gatewayId, createdAgentId, 'SOUL.md', stamp(definition.soulMd));
        if (!soulResult.ok) throw new Error(resultError(soulResult, 'SOUL.md write failed'));
      }

      installed.push(definition.id);
      knownAgentIds.add(definition.id);
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : 'agent setup failed';
      // 普通半成品保留给下一次幂等修复；只清理网关返回的意外 ID。
      // exFAT 上 deleteFiles 会留下 deletion tombstone，反而让重试永久失败。
      if (createdAgentId && (shouldRollbackUnexpectedId || (createdNewAgent && !preservePartialOnFailure))) {
        const rollbackError = await rollbackNewAgent(api, gatewayId, createdAgentId);
        if (rollbackError) failureMessage = `${failureMessage} (rollback failed: ${rollbackError})`;
      }
      failed.push({ id: definition.id, error: failureMessage });
    }

    completed++;
    onProgress?.({ completed, total: definitions.length, currentId: definition.id });
  }

  return { installed, skipped, ...(reconciled.length > 0 ? { reconciled } : {}), failed };
}
