import type {
  ParsedTeam,
  InstallEvent,
  AgentFileSet,
  SkillRef,
  AgentCreateParams,
  AgentCreateResponse,
  AgentDeleteParams,
  ConfigPatchParams,
  ConfigPatchResult,
  ConfigSnapshot,
  IpcResult,
  SkillInstallParams,
  SkillInstallResult,
} from '@clawwork/shared';
import { extractSkillSlugs } from './team-parser.js';

export interface InstallerDeps {
  createAgent: (params: AgentCreateParams) => Promise<IpcResult<AgentCreateResponse>>;
  deleteAgent: (params: AgentDeleteParams) => Promise<IpcResult>;
  setAgentFile: (agentId: string, name: string, content: string) => Promise<IpcResult>;
  installSkill: (params: SkillInstallParams) => Promise<IpcResult<SkillInstallResult>>;
  getConfig: () => Promise<IpcResult<ConfigSnapshot>>;
  patchConfig: (params: ConfigPatchParams) => Promise<IpcResult<ConfigPatchResult>>;
  persistTeam: (team: {
    id: string;
    name: string;
    emoji?: string;
    description?: string;
    gatewayId: string;
    source?: string;
    version?: string;
    hubSlug?: string;
    agents: Array<{ agentId: string; role?: string; isManager?: boolean; skills?: string[] }>;
    createdAt: string;
    updatedAt: string;
  }) => Promise<IpcResult>;
}

function countFileOps(files: AgentFileSet | undefined): number {
  if (!files) return 0;
  let n = 0;
  if (files.agentMd) n++;
  if (files.soulMd) n++;
  return n;
}

function buildSkillInstallParams(skill: SkillRef): SkillInstallParams | null {
  if (skill.sourceType === 'clawhub') {
    return { source: 'clawhub', slug: skill.id };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 读某个助手当前的 `subagents.allowAgents`。
 *
 * ⚠️ **形状是 `agents.entries.<agentId>`（以 id 为键的对象），不是 `agents.list`（数组）。**
 *    2026-09-20 实机踩到：老写法打 patch 时运行时直接拒 ——
 *    `invalid config: agents: Unrecognized key: "list"` —— **团队根本装不完**
 *    （卡在 75% 的"配置 subagent"那一步）。
 *    权威依据是随包运行时的类型定义：`agents.entries` 下每个助手可带
 *    `subagents.allowAgents`（注释原文 "Allow spawning sub-agents under other agent ids"），
 *    而网关自己的控制台也写 `agents.entries.<id>`。
 *
 * ⚠️ 这个 bug 之所以长期没被发现，是因为**测试用了同一个错误假设**（旧测试断言的
 *    就是 `agents.list`），于是代码和测试一起绿、真机一起挂。
 */
function readAllowAgents(config: Record<string, unknown>, agentId: string): string[] {
  const agents = config.agents;
  const entries = isRecord(agents) && isRecord(agents.entries) ? agents.entries : undefined;
  const entry = entries ? entries[agentId] : undefined;
  if (!isRecord(entry) || !isRecord(entry.subagents) || !Array.isArray(entry.subagents.allowAgents)) return [];
  return entry.subagents.allowAgents.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
}

/** 连点两次安装时，网关会回 `AGENT "X" ALREADY EXISTS` —— 那是成功，不是失败。 */
function parseAlreadyExistsAgentId(error: string | undefined): string | null {
  const match = (error ?? '').match(/agent\s+"([^"]+)"\s+already exists/i);
  return match?.[1] ?? null;
}

function isConfigChangedError(error: string | undefined): boolean {
  return /config changed/i.test(error ?? '');
}

async function patchSubagentAllowList(
  snapshot: ConfigSnapshot,
  managerIds: string[],
  workerIds: string[],
  deps: InstallerDeps,
): Promise<IpcResult> {
  // ⚠️ 形状必须是 `agents.entries.<agentId>.subagents.allowAgents`（以 id 为键的对象）。
  //    写成 `agents.list: [{id, ...}]` 会被运行时拒：`Unrecognized key: "list"`。
  //    `config.patch` 是**深合并**（`applyMergePatch`），所以只写 entries 这一支
  //    不会破坏 `agents.defaults`、`agents.ownership` 或别的助手。
  const entries: Record<string, { subagents: { allowAgents: string[] } }> = {};
  for (const agentId of managerIds) {
    entries[agentId] = {
      subagents: {
        // 并集：保留它原有的白名单（可能是别的团队装的），别覆盖掉。
        allowAgents: [...new Set([...readAllowAgents(snapshot.config, agentId), ...workerIds])],
      },
    };
  }

  return deps.patchConfig({
    baseHash: snapshot.hash,
    raw: JSON.stringify({ agents: { entries } }),
  });
}

async function configureTeamSubagents(
  teamAgents: Array<{ agentId: string; role?: string; isManager?: boolean; skills?: string[] }>,
  deps: InstallerDeps,
): Promise<IpcResult> {
  const managerIds = teamAgents.filter((agent) => agent.role === 'coordinator').map((agent) => agent.agentId);
  const workerIds = teamAgents.filter((agent) => agent.role === 'worker').map((agent) => agent.agentId);
  if (managerIds.length === 0 || workerIds.length === 0) return { ok: true };

  const configRes = await deps.getConfig();
  if (!configRes.ok || !configRes.result) return { ok: false, error: configRes.error ?? 'failed to read config' };

  let patchRes = await patchSubagentAllowList(configRes.result, managerIds, workerIds, deps);
  // 乐观并发：别人刚改过配置 ⇒ 再 GET 一次、用新 hash 重试一次。再失败才算失败。
  if (!patchRes.ok && isConfigChangedError(patchRes.error)) {
    const retry = await deps.getConfig();
    if (!retry.ok || !retry.result) return { ok: false, error: retry.error ?? patchRes.error };
    patchRes = await patchSubagentAllowList(retry.result, managerIds, workerIds, deps);
  }
  if (!patchRes.ok) return { ok: false, error: patchRes.error ?? 'failed to configure subagents' };
  return { ok: true };
}

export async function* installTeam(
  parsed: ParsedTeam,
  agentFiles: Record<string, AgentFileSet>,
  gatewayId: string,
  workspace: string,
  deps: InstallerDeps,
  hubMeta?: { slug: string },
): AsyncGenerator<InstallEvent> {
  const createdAgentIds: string[] = [];
  const agentMap = new Map<string, string>();
  const skillsByAgent = new Map<string, SkillRef[]>();

  let totalSteps = 1;
  for (const agent of parsed.agents) {
    totalSteps++;
    const files = agentFiles[agent.id];
    totalSteps += countFileOps(files);
    const skills = files ? extractSkillSlugs(files) : [];
    skillsByAgent.set(agent.id, skills);
    totalSteps += skills.length;
  }

  let step = 0;

  for (const agent of parsed.agents) {
    yield {
      type: 'agent_creating',
      agentSlug: agent.id,
      message: agent.name,
      progress: { current: step, total: totalSteps },
    };

    const res = await deps.createAgent({ name: agent.name, workspace });
    let agentId: string | null = null;
    let newlyCreated = false;
    if (res.ok && res.result) {
      agentId = res.result.agentId;
      newlyCreated = true;
    } else {
      // 连点两次 / 助手已经在网关里：quoted 名就是它的 id。当成功，不要进回滚删除名单。
      agentId = parseAlreadyExistsAgentId(res.error);
    }
    if (!agentId) {
      yield {
        type: 'warning',
        agentSlug: agent.id,
        message: `Failed to create agent "${agent.name}": ${res.error ?? 'unknown'}`,
      };
      const skipped = 1 + countFileOps(agentFiles[agent.id]) + (skillsByAgent.get(agent.id)?.length ?? 0);
      step += skipped;
      continue;
    }

    if (newlyCreated) createdAgentIds.push(agentId);
    agentMap.set(agent.id, agentId);
    yield { type: 'agent_created', agentSlug: agent.id, agentId, progress: { current: ++step, total: totalSteps } };

    const files = agentFiles[agent.id];
    if (files?.agentMd) {
      yield { type: 'file_setting', agentSlug: agent.id, agentId, fileName: 'IDENTITY.md' };
      const r = await deps.setAgentFile(agentId, 'IDENTITY.md', files.agentMd);
      step++;
      if (!r.ok) yield { type: 'warning', agentSlug: agent.id, message: `Failed to set IDENTITY.md: ${r.error}` };
      else
        yield {
          type: 'file_set',
          agentSlug: agent.id,
          agentId,
          fileName: 'IDENTITY.md',
          progress: { current: step, total: totalSteps },
        };
    }
    if (files?.soulMd) {
      yield { type: 'file_setting', agentSlug: agent.id, agentId, fileName: 'SOUL.md' };
      const r = await deps.setAgentFile(agentId, 'SOUL.md', files.soulMd);
      step++;
      if (!r.ok) yield { type: 'warning', agentSlug: agent.id, message: `Failed to set SOUL.md: ${r.error}` };
      else
        yield {
          type: 'file_set',
          agentSlug: agent.id,
          agentId,
          fileName: 'SOUL.md',
          progress: { current: step, total: totalSteps },
        };
    }

    const skills = skillsByAgent.get(agent.id) ?? [];
    for (const skill of skills) {
      yield {
        type: 'skill_installing',
        agentSlug: agent.id,
        agentId,
        skillId: skill.id,
        progress: { current: step, total: totalSteps },
      };

      const params = buildSkillInstallParams(skill);
      if (!params) {
        yield {
          type: 'warning',
          agentSlug: agent.id,
          skillId: skill.id,
          message: `Skill "${skill.id}" has unsupported sourceType "${skill.sourceType}", skipped`,
        };
        step++;
        continue;
      }

      const installRes = await deps.installSkill(params);
      step++;
      if (!installRes.ok) {
        yield {
          type: 'warning',
          agentSlug: agent.id,
          skillId: skill.id,
          message: `Skill "${skill.id}" install failed: ${installRes.error ?? 'unknown'}`,
        };
      } else {
        yield {
          type: 'skill_installed',
          agentSlug: agent.id,
          agentId,
          skillId: skill.id,
          progress: { current: step, total: totalSteps },
        };
      }
    }
  }

  const teamAgents = parsed.agents
    .filter((a) => agentMap.has(a.id))
    .map((a) => ({
      agentId: agentMap.get(a.id)!,
      role: a.role,
      isManager: a.role === 'coordinator',
      skills: (skillsByAgent.get(a.id) ?? []).map((skill) => skill.id),
    }));

  if (teamAgents.length === 0) {
    yield* rollback(createdAgentIds, deps);
    yield { type: 'error', message: 'No agents were created successfully' };
    return;
  }

  const subagentsRes = await configureTeamSubagents(teamAgents, deps);
  if (!subagentsRes.ok) {
    yield* rollback(createdAgentIds, deps);
    yield { type: 'error', message: `Failed to configure subagents: ${subagentsRes.error}` };
    return;
  }

  yield { type: 'team_persisting', progress: { current: step, total: totalSteps } };

  const now = new Date().toISOString();
  const teamId = crypto.randomUUID();

  const persistRes = await deps.persistTeam({
    id: teamId,
    name: parsed.name,
    description: parsed.description,
    gatewayId,
    source: hubMeta ? 'hub' : 'local',
    version: parsed.version,
    hubSlug: hubMeta?.slug,
    agents: teamAgents,
    createdAt: now,
    updatedAt: now,
  });

  if (!persistRes.ok) {
    yield* rollback(createdAgentIds, deps);
    yield { type: 'error', message: `Failed to persist team: ${persistRes.error}` };
    return;
  }

  yield { type: 'team_persisted', progress: { current: ++step, total: totalSteps } };
  yield { type: 'done', message: teamId };
}

async function* rollback(agentIds: string[], deps: InstallerDeps): AsyncGenerator<InstallEvent> {
  for (const agentId of agentIds) {
    try {
      await deps.deleteAgent({ agentId });
    } catch {
      yield { type: 'warning', agentId, message: `Rollback: failed to delete agent ${agentId}` };
    }
  }
}
