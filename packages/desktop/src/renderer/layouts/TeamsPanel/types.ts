import type { TeamPosition } from '@clawwork/shared';

export type InstallStatus = 'idle' | 'installing' | 'done' | 'degraded' | 'error';

export interface AgentDraft {
  id?: string;
  uid: string;
  name: string;
  description: string;
  /**
   * **编排**角色（决定 subagent 白名单，见 `team-installer.ts`）。
   * ⚠️ 与 `position` 是两回事，别合并 —— 前者是"谁派活"，后者是"讨论时谁先说话"。
   */
  role: 'coordinator' | 'worker';
  /** **讨论**职位（圆桌用）。不填由 `normalizePosition` 兜底成领域专家。 */
  position?: TeamPosition;
  model: string;
  agentMd: string;
  soulMd: string;
  skills: string[];
  existingAgentId?: string;
  lockedExisting?: boolean;
  expandedByDefault?: boolean;
}

export interface TeamInfo {
  name: string;
  emoji: string;
  description: string;
  gatewayId: string;
}
