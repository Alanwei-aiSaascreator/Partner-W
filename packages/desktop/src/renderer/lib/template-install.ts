import type { AgentTemplateDetail } from '@clawwork/shared';
import { describeTemplateError, templateToInstallDefinition } from '@clawwork/core';
import { installPresetAgentPack, type PresetAgentInstallerApi } from './preset-agent-installer';

/**
 * 「安装一个模板」的编排 —— **先在本地网关把助手真建出来，再去服务端记一笔**。
 *
 * ⚠️ 顺序是刻意的：反过来（先记账再建）会出现"服务端显示已安装、但用户的助手栏里
 *    根本没有那个助手"。所以记账失败**只提示、不撤销本地**（用户要的结果已经拿到）。
 *
 * 抽成不依赖 React 的纯函数，是为了能用假边界把**整条链**测掉（见
 * `test/template-install.test.ts`），而不是去渲染一个面板。
 */
export interface TemplateInstallDeps {
  gatewayId: string;
  workspaceRoot: string;
  currentAgentIds: string[];
  api: PresetAgentInstallerApi;
  refreshAgents: () => Promise<void>;
  recordInstalled: (templateId: string) => Promise<{ ok: boolean; errorCode?: string }>;
  /** 装出来的助手共用的操作契约（`COMMON_OPERATING_CONTRACT`）。 */
  commonContract: string;
}

export interface TemplateInstallOutcome {
  ok: boolean;
  agentId?: string;
  /** 网关里已经有同 id 的助手 ⇒ 跳过创建（幂等），不是失败。 */
  alreadyInstalled?: boolean;
  /** 本地装好了、只是服务端记账没成功（只提示，不影响结果）。 */
  recordWarning?: string;
  /** 失败时给用户看的中文原因。 */
  message?: string;
}

export async function installTemplate(
  deps: TemplateInstallDeps,
  template: AgentTemplateDetail,
): Promise<TemplateInstallOutcome> {
  if (!deps.gatewayId) {
    return { ok: false, message: '还没有连上本地服务，先等它准备好再试。' };
  }

  const definition = templateToInstallDefinition(template, deps.commonContract);

  const res = await installPresetAgentPack({
    gatewayId: deps.gatewayId,
    workspaceRoot: deps.workspaceRoot,
    currentAgentIds: deps.currentAgentIds,
    displayNames: { [definition.id]: template.name },
    definitions: [definition],
    api: deps.api,
  });

  if (res.failed.length > 0) {
    // 安装器已经回滚掉刚建的 agent；这里只把中文原因带出去
    return { ok: false, message: describeTemplateError('unknown') };
  }

  const alreadyInstalled = res.skipped.length > 0;

  // 只有真的建了才需要刷新目录（跳过时目录里本来就有它）
  if (!alreadyInstalled) await deps.refreshAgents();

  const recorded = await deps.recordInstalled(template.id);
  return {
    ok: true,
    agentId: definition.id,
    alreadyInstalled,
    ...(recorded.ok ? {} : { recordWarning: describeTemplateError(recorded.errorCode) }),
  };
}
