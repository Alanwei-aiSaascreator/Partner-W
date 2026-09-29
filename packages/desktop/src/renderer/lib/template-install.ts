import type { AgentTemplateDetail } from '@clawwork/shared';
import { describeTemplateError, templateToInstallDefinition } from '@clawwork/core';
import { checkInstallWorkspaceCapability } from './install-workspace';
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
  /**
   * 工作区根。**可以是 null**：拿不到工作区时不许在这里用 `?? ''` 吞掉 ——
   * 空串会被拼成 `/rongying-agents/<id>`（根相对路径），交给网关那个进程去
   * 按它自己的 cwd 解释 ⇒ 每个助手都建失败，而界面上只剩一句英文
   * `No agents were created successfully`（2026-09-20 U 盘交付实机）。
   * ⇒ 判定收在 `checkInstallWorkspace`，坏输入直接拒绝并给中文原因。
   */
  workspaceRoot: string | null;
  currentAgentIds: string[];
  api: PresetAgentInstallerApi;
  refreshAgents: () => Promise<void>;
  recordInstalled: (templateId: string) => Promise<{ ok: boolean; errorCode?: string }>;
  /** 装出来的助手共用的操作契约（`COMMON_OPERATING_CONTRACT`）。 */
  commonContract: string;
  probeWorkspaceFsIdentity: () => ReturnType<typeof window.clawwork.probeWorkspaceFsIdentity>;
}

export interface TemplateInstallOutcome {
  ok: boolean;
  agentId?: string;
  /** 网关里已经有同 id 的助手 ⇒ 跳过创建（幂等），不是失败。 */
  alreadyInstalled?: boolean;
  /** 本地装好了、只是服务端记账没成功（只提示，不影响结果）。 */
  recordWarning?: string;
  /** 失败时给用户看的本地化结论。 */
  message?: string;
  /** 仅供日志或显式展开的技术详情，不得默认拼进用户提示。 */
  diagnostic?: string;
}

export async function installTemplate(
  deps: TemplateInstallDeps,
  template: AgentTemplateDetail,
): Promise<TemplateInstallOutcome> {
  if (!deps.gatewayId) {
    return { ok: false, message: '还没有连上本地服务，先等它准备好再试。' };
  }

  // ⚠️ 必须在**发任何请求之前**判：工作区坏掉时"建一个助手试试看"只会在网关那边
  //    留下 N 条失败记录，而用户看到的仍然只是一句「操作没成功，请稍后重试。」
  const workspace = await checkInstallWorkspaceCapability(deps.workspaceRoot, deps.probeWorkspaceFsIdentity);
  if (!workspace.ok) return { ok: false, message: workspace.message };

  const definition = templateToInstallDefinition(template, deps.commonContract);

  const res = await installPresetAgentPack({
    gatewayId: deps.gatewayId,
    workspaceRoot: workspace.path,
    currentAgentIds: deps.currentAgentIds,
    displayNames: { [definition.id]: template.name },
    definitions: [definition],
    api: deps.api,
  });

  if (res.failed.length > 0) {
    // 安装器已回滚掉刚建的 agent。用户提示只放本地化结论；
    // 网关原文单独保留为诊断，由 UI 写日志或在用户主动展开时显示。
    const reason = res.failed
      .map((failure) => failure.error)
      .filter((text) => Boolean(text))
      .join('; ');
    return {
      ok: false,
      message: describeTemplateError('unknown'),
      ...(reason ? { diagnostic: reason } : {}),
    };
  }

  const alreadyInstalled = res.skipped.length > 0;
  const reconciledExisting = (res.reconciled?.length ?? 0) > 0;

  // 新建成功要刷；本地目录陈旧时，虽然网关对账后归类为“已安装”，
  // renderer store 仍然是旧的，也必须强刷；普通已安装仍不多发请求。
  if (!alreadyInstalled || reconciledExisting) await deps.refreshAgents();

  const recorded = await deps.recordInstalled(template.id);
  return {
    ok: true,
    agentId: definition.id,
    alreadyInstalled,
    ...(recorded.ok ? {} : { recordWarning: describeTemplateError(recorded.errorCode) }),
  };
}
