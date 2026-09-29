import { useState, useCallback } from 'react';
import type {
  InstallEvent,
  AgentCreateResponse,
  AgentInfo,
  AgentListResponse,
  SkillInstallResult,
  IpcResult,
} from '@clawwork/shared';
import type { InstallerDeps } from '@clawwork/core';
import { installTeam, serializeIdentityMd } from '@clawwork/core';
import { WORKSPACE_UNAVAILABLE_MESSAGE, checkInstallWorkspace } from '@/lib/install-workspace';
import { relayModelsFrom } from '@/components/ChatInput/model-families';
import { resolveTeamModelRef } from '@/lib/team-model-ref';
import { useUiStore } from '@/stores/uiStore';
import { toSlug } from './utils';
import type { TeamInfo, AgentDraft } from './types';

type InstallStatus = 'idle' | 'installing' | 'done' | 'error';

/**
 * 装完团队后**强刷助手目录**。
 *
 * 为什么非刷不可（2026-09-22 复核的"层 3"，实机 3 次点击可复现）：
 * 新建的 agent 只进了网关，**客户端那份目录还是陈旧的** ⇒ 用户点「发起对话」时
 * `useGatewaySelector` 发现 id 不在目录里，就把它**静默换成 `main`**（全程没有任何提示），
 * 用户看到的是主罗盘。**重启就好了**（启动那次会强刷）——这正是它长期没被当成 bug 的原因。
 *
 * ⚠️ **动态 import 只买到"加载期解耦"**（照 `MarketPanel/useTemplateInstall.ts` 的先例）：不装团队的
 *    importer 不必加载这条重链。⚠️ **但走到 `done` 时整条链照样会被加载**，代价只是从"模块加载失败"
 *    挪进了 catch —— 既有 `test/use-team-install-workspace.test.tsx` 正是这样吞掉一个
 *    `TypeError: deps.gateway.listAgents is not a function`（该例 ~70ms → ~470ms）。
 *    （要它还回原耗时，让那个用例照本文件测试的做法 mock `@/hooks/useGatewayDispatcherSetup`。）
 * ⚠️ **失败不许影响"装完了"**：目录最多是陈旧的（重启会补），别让一次刷新失败把成功报成失败。
 */
async function refreshAgentCatalog(gatewayId: string): Promise<void> {
  try {
    const { fetchAgentsForGateway } = await import('@/hooks/useGatewayDispatcherSetup');
    await fetchAgentsForGateway(gatewayId, { force: true });
  } catch (err) {
    console.error('[teams] 刷新助手目录失败（安装本身已完成）:', err);
  }
}

/**
 * 安装收尾三步：**先刷新目录 → 再报"装完了" → 再 `onDone`**。
 *
 * ⚠️ 为什么抽成函数：这三步的**顺序**是承重的（报早一步，用户就能在目录还陈旧时点进团队 ⇒
 *    又是"静默换成 main"）。抽成可注入的缝之后，顺序能用普通 spy 确定性地钉住。
 *    （**更正**：一度以为"在组件测试里读不到飞行中的 `installStatus`" ⇒ 已证伪 —— **读得到**，
 *    只是必须在 `act` 作用域**结束之后**读；`runInstall` 那条用例就是这么钉住调用点的。）
 *
 * ⚠️ **隐含契约：注入的 `refresh` 不许抛**。容错住在 `refreshAgentCatalog` 的 catch 里，**不在这里** ——
 *    一个会抛的 `refresh` 会把异常一路冒到 `runInstall` 的 catch，正好变成"装完了被报成装失败"。
 * ⚠️ 调用点（`runInstall` 的 `done` 分支）只许调用本函数：**内联重排现在测试能红了**（`runInstall` 那条
 *    用例在 flush 之后读状态），保持这个形状只是更省事、更不容易写歪。
 */
export async function finishTeamInstall(input: {
  gatewayId: string;
  setStatus: (status: InstallStatus) => void;
  onDone?: (() => void) | undefined;
  refresh?: (gatewayId: string) => Promise<void>;
}): Promise<void> {
  await (input.refresh ?? refreshAgentCatalog)(input.gatewayId);
  input.setStatus('done');
  input.onDone?.();
}

export function useTeamInstall(onDone?: () => void) {
  const [installStatus, setInstallStatus] = useState<InstallStatus>('idle');
  const [installEvents, setInstallEvents] = useState<InstallEvent[]>([]);
  const modelCatalogByGateway = useUiStore((state) => state.modelCatalogByGateway);

  const resetInstall = useCallback(() => {
    setInstallStatus('idle');
    setInstallEvents([]);
  }, []);

  const runInstall = useCallback(
    async (
      teamInfo: TeamInfo,
      agents: AgentDraft[],
      editContext?: { teamId: string; createdAt: string },
      hubMeta?: { slug: string },
    ) => {
      setInstallStatus('installing');
      setInstallEvents([]);

      const parsed = {
        name: teamInfo.name.trim(),
        description: teamInfo.description.trim(),
        version: '1.0.0',
        agents: agents.map((a) => ({
          id: toSlug(a.name),
          name: a.name.trim(),
          role: a.role,
        })),
        body: '',
      };

      const existingMap = new Map<string, string>();
      const existingAgentIds = new Set<string>();
      const fallbackAgentIds = new Set<string>();
      for (const a of agents) {
        if (a.existingAgentId) {
          existingMap.set(toSlug(a.name), a.existingAgentId);
          existingAgentIds.add(a.existingAgentId);
        }
      }

      const agentFiles: Record<string, { agentMd?: string; soulMd?: string; skillsJson?: string }> = {};
      for (const a of agents) {
        const slug = toSlug(a.name);
        const files: { agentMd?: string; soulMd?: string; skillsJson?: string } = {};
        if (!a.existingAgentId) {
          const identity = serializeIdentityMd(a.description, a.agentMd.trim());
          if (identity) files.agentMd = identity;
          if (a.soulMd.trim()) files.soulMd = a.soulMd.trim();
        }
        if (a.skills.length > 0) {
          const skillsObj: Record<string, { source: string; sourceType: string }> = {};
          for (const s of a.skills) skillsObj[s] = { source: s, sourceType: 'clawhub' };
          files.skillsJson = JSON.stringify({ version: 1, skills: skillsObj });
        }
        agentFiles[slug] = files;
      }

      const gwId = teamInfo.gatewayId;
      const availableModels = relayModelsFrom(modelCatalogByGateway[gwId] ?? []).filter(
        (model) => model.available !== false,
      );
      const agentModelMap = new Map<string, string>();
      for (const a of agents) {
        const model = resolveTeamModelRef(a.model, availableModels);
        if (model) agentModelMap.set(toSlug(a.name), model);
      }
      const pendingModelUpdates: Promise<IpcResult>[] = [];
      const waitForModelUpdates = async (): Promise<IpcResult> => {
        const updates = await Promise.all(pendingModelUpdates);
        const failed = updates.find((result) => !result.ok);
        return failed ?? { ok: true };
      };

      let cachedGatewayAgents: AgentInfo[] | null = null;
      const deps: InstallerDeps = {
        createAgent: async (params) => {
          const slug = toSlug(params.name);
          const existingId = existingMap.get(slug);
          if (existingId) {
            return { ok: true, result: { agentId: existingId, name: params.name, workspace: '' } };
          }
          const res = await window.clawwork.createAgent(gwId, params);
          if (!res.ok || !res.result) {
            const errStr = String(res.error ?? '');
            const idMatch = errStr.match(/agent "([^"]+)" already exists/i);
            if (idMatch) {
              if (!cachedGatewayAgents) {
                const listRes = await window.clawwork.listAgents(gwId);
                if (listRes.ok && listRes.result) {
                  cachedGatewayAgents = (listRes.result as unknown as AgentListResponse).agents;
                }
              }
              const existingAgentId = idMatch[1];
              const existingKey = toSlug(existingAgentId);
              const exactMatch = cachedGatewayAgents?.find((a) => a.id === existingAgentId);
              const requestedMatch = cachedGatewayAgents?.find((a) => a.id === slug);
              const normalizedMatches = (cachedGatewayAgents ?? []).filter(
                (a) => toSlug(a.id) === existingKey || toSlug(a.name ?? '') === existingKey,
              );
              const match =
                exactMatch ?? requestedMatch ?? (normalizedMatches.length === 1 ? normalizedMatches[0] : null);
              if (match) {
                fallbackAgentIds.add(match.id);
                return { ok: true, result: { agentId: match.id, name: match.name ?? params.name, workspace: '' } };
              }
              return { ok: false, error: `Existing agent could not be reconciled: ${existingAgentId}` };
            }
            return { ok: false, error: res.error } as IpcResult<AgentCreateResponse>;
          }
          const r = res.result as Record<string, unknown>;
          return { ok: true, result: r as unknown as AgentCreateResponse };
        },
        deleteAgent: (params) => {
          if (existingAgentIds.has(params.agentId) || fallbackAgentIds.has(params.agentId))
            return Promise.resolve({ ok: true } as IpcResult);
          return window.clawwork.deleteAgent(gwId, params);
        },
        setAgentFile: (agentId, name, content) => {
          if (existingAgentIds.has(agentId) || fallbackAgentIds.has(agentId))
            return Promise.resolve({ ok: true } as IpcResult);
          return window.clawwork.setAgentFile(gwId, agentId, name, content);
        },
        installSkill: async (params) => {
          const res = await window.clawwork.installSkill(gwId, params);
          if (!res.ok) return { ok: false, error: res.error } as IpcResult<SkillInstallResult>;
          return { ok: true, result: res.result as unknown as SkillInstallResult };
        },
        getConfig: async () => {
          const modelResult = await waitForModelUpdates();
          if (!modelResult.ok) return { ok: false, error: modelResult.error ?? 'Failed to update agent model' };
          return window.clawwork.getConfig(gwId);
        },
        patchConfig: (params) => window.clawwork.patchConfig(gwId, params),
        persistTeam: editContext
          ? async (team) => {
              const modelResult = await waitForModelUpdates();
              if (!modelResult.ok) return modelResult;
              return window.clawwork.persistTeam({
                ...team,
                id: editContext.teamId,
                createdAt: editContext.createdAt,
                emoji: teamInfo.emoji,
                hubSlug: hubMeta?.slug,
              });
            }
          : async (team) => {
              const modelResult = await waitForModelUpdates();
              if (!modelResult.ok) return modelResult;
              return window.clawwork.persistTeam({ ...team, emoji: teamInfo.emoji });
            },
      };

      try {
        /**
         * ⚠️ 工作区必须是**绝对路径**才装上（2026-09-20 U 盘交付实机）：
         *    没工作区时 `workspace:team-path` 过去会返回 slug 本身（相对路径），
         *    而工作区字符串是交给**网关那个进程**解析的 ⇒ 每个助手都建失败，
         *    界面上只剩一句英文 `No agents were created successfully`。
         *    ⇒ 坏输入**一个助手都不建**，直接抛一条中文原因给界面。
         */
        let workspace: string;
        try {
          workspace = await window.clawwork.getTeamWorkspacePath(toSlug(teamInfo.name));
        } catch {
          // 主进程会 `throw new Error('workspace not configured')`（IPC 会包一层英文前缀，别往界面上摆）
          throw new Error(WORKSPACE_UNAVAILABLE_MESSAGE);
        }
        const checked = checkInstallWorkspace(workspace);
        if (!checked.ok) throw new Error(checked.message);

        for await (const event of installTeam(parsed, agentFiles, teamInfo.gatewayId, checked.path, deps, hubMeta)) {
          setInstallEvents((prev) => [...prev, event]);

          if (event.type === 'agent_created' && event.agentSlug && event.agentId) {
            const model = agentModelMap.get(event.agentSlug);
            if (model) {
              const update = window.clawwork
                .updateAgent(teamInfo.gatewayId, { agentId: event.agentId, model })
                .catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
              pendingModelUpdates.push(update);
            }
          }

          if (event.type === 'error') {
            setInstallStatus('error');
            return;
          }
          if (event.type === 'done') {
            // ⚠️ 三步的顺序是承重的，见 `finishTeamInstall` 的说明（目录陈旧 ⇒ 紧接着的
            //    「发起对话」会被静默换成 main）。
            // ⚠️⚠️ **收尾三步只许出现在 `finishTeamInstall` 里**。把它内联回这里并提前
            //    调一次 `setInstallStatus('done')`，现在**会被 `runInstall` 那条用例红掉**
            //    （它在 `act` 作用域之后读状态）；保持走缝只是更省事，不是"测试看不见"。
            await finishTeamInstall({ gatewayId: teamInfo.gatewayId, setStatus: setInstallStatus, onDone });
            return;
          }
        }
      } catch (err) {
        /**
         * ⚠️ 原来这里是**裸 `catch {}`**：连"为什么"都不留，界面只剩「安装失败」三个字
         *    （2026-09-20 U 盘交付实机就是这么变成"无法定位"的）。
         *    现在把原因送进事件列表 —— 它是界面唯一会显示失败原因的地方。
         */
        const message = err instanceof Error && err.message ? err.message : '安装没能完成，请重试。';
        setInstallEvents((prev) => [...prev, { type: 'error', message }]);
        setInstallStatus('error');
      }
    },
    [modelCatalogByGateway, onDone],
  );

  const runUpdate = useCallback(
    async (teamId: string, createdAt: string, teamInfo: TeamInfo, agents: AgentDraft[]) => {
      setInstallStatus('installing');
      setInstallEvents([]);

      try {
        const gwId = teamInfo.gatewayId;
        const availableModels = relayModelsFrom(modelCatalogByGateway[gwId] ?? []).filter(
          (model) => model.available !== false,
        );
        for (const agent of agents) {
          if (!agent.existingAgentId) continue;
          const model = resolveTeamModelRef(agent.model, availableModels);
          if (!model) continue;
          const update = await window.clawwork.updateAgent(gwId, { agentId: agent.existingAgentId, model });
          if (!update.ok) {
            setInstallEvents([{ type: 'error', message: update.error ?? 'Failed to update agent model' }]);
            setInstallStatus('error');
            return;
          }
        }
        const skillPromises = agents.flatMap((a) =>
          a.skills.length > 0 && a.existingAgentId
            ? a.skills.map((slug) =>
                window.clawwork
                  .installSkill(gwId, { source: 'clawhub', slug })
                  .catch((err) => console.error(`Failed to install skill ${slug}`, err)),
              )
            : [],
        );
        if (skillPromises.length > 0) await Promise.all(skillPromises);

        const teamAgents = agents.map((a) => ({
          agentId: a.existingAgentId!,
          role: a.role,
          isManager: a.role === 'coordinator',
          skills: a.skills,
          // 讨论职位（圆桌用）。老草稿可能没填 ⇒ 落空串，读的时候由 normalizePosition
          // 兜底成领域专家 —— 落库这一步不做兜底，免得把"用户没选"和"用户选了专家"混成一个。
          position: a.position ?? '',
        }));

        const now = new Date().toISOString();
        const res = await window.clawwork.persistTeam({
          id: teamId,
          name: teamInfo.name.trim(),
          emoji: teamInfo.emoji,
          description: teamInfo.description.trim(),
          gatewayId: teamInfo.gatewayId,
          source: 'local',
          version: '1.0.0',
          agents: teamAgents,
          createdAt,
          updatedAt: now,
        });

        if (res.ok) {
          setInstallEvents([{ type: 'team_persisted', progress: { current: 1, total: 1 } }]);
          setInstallStatus('done');
          onDone?.();
        } else {
          setInstallEvents([{ type: 'error', message: res.error ?? 'Failed to update team' }]);
          setInstallStatus('error');
        }
      } catch {
        setInstallStatus('error');
      }
    },
    [modelCatalogByGateway, onDone],
  );

  return { installStatus, installEvents, runInstall, runUpdate, resetInstall };
}
