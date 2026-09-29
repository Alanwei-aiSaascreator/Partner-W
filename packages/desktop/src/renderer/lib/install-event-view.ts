import type { InstallEvent } from '@clawwork/shared';
import { withAgentIds } from '@/layouts/TeamsPanel/utils';

/**
 * 安装事件流 → 界面视图。
 *
 * 从 `layouts/TeamsPanel/InstallStep.tsx` 里**原样搬出来**的一份（2026-09-20），
 * 因为另一个进度面板（`components/TeamBuilderDialog` → `InstallProgress`）当时只读
 * `type:'error'` 的那一句，**逐助手的原因全被丢掉**：`team-installer` 把每个助手的
 * 失败原因放在 `warning` 事件里（`Failed to create agent "X": <网关原文>`），于是
 * 用户看到的就成了"四行 slug + 一句大写英文 `NO AGENTS WERE CREATED SUCCESSFULLY`"
 * —— 原因上不了屏，我们也无法远程定位（截图 4 就是它）。
 *
 * ⚠️ 一份实现，两个面板都用它：再复制一份就等于把同一个坑留在另一个面板里。
 */
export interface InstallAgentState {
  slug: string;
  status: 'pending' | 'creating' | 'created' | 'warning';
  files: Array<{ name: string; ok: boolean }>;
  skills: Array<{ id: string; ok: boolean }>;
  warnings: string[];
}

export interface InstallEventView {
  agentStates: InstallAgentState[];
  teamSaved: boolean;
  globalWarnings: string[];
  globalError: string | null;
}

export function buildInstallEventView(
  agents: ReadonlyArray<{ id?: string; name: string }>,
  events: InstallEvent[],
): InstallEventView {
  const stateMap = new Map<string, InstallAgentState>();
  const identifiedAgents = withAgentIds(agents);
  for (const a of identifiedAgents) {
    const slug = a.id;
    stateMap.set(slug, { slug, status: 'pending', files: [], skills: [], warnings: [] });
  }

  let teamSaved = false;
  const globalWarnings: string[] = [];
  let globalError: string | null = null;

  for (const e of events) {
    const s = e.agentSlug ? stateMap.get(e.agentSlug) : undefined;
    switch (e.type) {
      case 'agent_creating':
        if (s) s.status = 'creating';
        break;
      case 'agent_created':
        if (s) s.status = 'created';
        break;
      case 'file_set':
        if (s && e.fileName) s.files.push({ name: e.fileName, ok: true });
        break;
      case 'file_setting':
        break;
      case 'skill_installed':
        if (s && e.skillId) s.skills.push({ id: e.skillId, ok: true });
        break;
      case 'skill_installing':
        break;
      case 'team_persisted':
        teamSaved = true;
        break;
      case 'warning':
        // ⚠️ 这里就是"原因"落地的地方：挂到助手上；没有 agentSlug 的落全局 —— 两条都不许丢
        if (s) {
          s.warnings.push(e.message ?? 'Warning');
          if (s.status === 'creating') s.status = 'warning';
        } else {
          globalWarnings.push(e.message ?? 'Warning');
        }
        break;
      case 'error':
        globalError = e.message ?? 'Installation failed';
        break;
    }
  }

  const agentStates = identifiedAgents.map((a) => stateMap.get(a.id)!).filter(Boolean);
  return { agentStates, teamSaved, globalWarnings, globalError };
}
