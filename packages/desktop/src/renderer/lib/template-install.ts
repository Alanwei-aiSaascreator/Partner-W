import type { AgentTemplateDetail } from '@clawwork/shared';
import { describeTemplateError, describeTemplateErrorKey, templateToInstallDefinition } from '@clawwork/core';
import { WORKSPACE_FILESYSTEM_UNSUPPORTED_MESSAGE, checkInstallWorkspaceCapability } from './install-workspace';
import {
  TEMPLATE_AGENT_IDENTITY_MISMATCH,
  installPresetAgentPack,
  type PresetAgentInstallerApi,
} from './preset-agent-installer';

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
  /**
   * 失败时给用户看的 **i18n 键**（`market.error.*`）—— UI 一律 `t(messageKey)`。
   *
   * ⚠️ 2026-10-07（质检 P1-2）：以前这里只有中文 `message` ⇒ 9 语言里有 7 种
   *    用户看到的是中文。纯函数层没有 `t()`，所以键与中文回落**成对**给出：
   *    UI 用键，没有 i18n 的调用方用回落。
   */
  messageKey?: string;
  /** 无 i18n 场景的中文回落（与 `messageKey` 一一对应）。 */
  message?: string;
  /** 仅供日志或显式展开的技术详情，不得默认拼进用户提示。 */
  diagnostic?: string;
}

/** 中文回落：与 core 映射表同源，这里只承载"这条链自己造"的两句。 */
const NO_GATEWAY_FALLBACK = '还没有连上本地服务，先等它准备好再试。';
const ASSISTANT_CONFLICT_FALLBACK =
  '本机已有一个内容不一致的同名助手；为避免覆盖它，这次没有直接复用。删除那个助手后再试一次。';

export async function installTemplate(
  deps: TemplateInstallDeps,
  template: AgentTemplateDetail,
): Promise<TemplateInstallOutcome> {
  if (!deps.gatewayId) {
    return { ok: false, messageKey: 'market.error.noGateway', message: NO_GATEWAY_FALLBACK };
  }

  // ⚠️ 必须在**发任何请求之前**判：工作区坏掉时"建一个助手试试看"只会在网关那边
  //    留下 N 条失败记录，而用户看到的仍然只是一句「操作没成功，请稍后重试。」
  const workspace = await checkInstallWorkspaceCapability(deps.workspaceRoot, deps.probeWorkspaceFsIdentity);
  if (!workspace.ok) {
    // 工作区判定属于共享的 `install-workspace`（别的入口也在用），这里只按它的**结论**
    // 分键：不支持的文件系统能给出可执行的下一步，别的都归"工作区还没就绪"。
    const unsupported = workspace.message === WORKSPACE_FILESYSTEM_UNSUPPORTED_MESSAGE;
    return {
      ok: false,
      messageKey: unsupported ? 'market.error.workspaceUnsupported' : 'market.error.workspaceUnavailable',
      message: workspace.message,
    };
  }

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
    // 安装器已回滚掉刚建的 agent。用户提示只放本地化键/中文回落；
    // 网关原文单独保留为诊断，由 UI 写日志或在用户主动展开时显示。
    const reason = res.failed
      .map((failure) => failure.error)
      .filter((text) => Boolean(text))
      .join('; ');
    // ⭐ 本机那个同 id 助手不是这个模板的东西（撞 id / 手改过）⇒ 明确说清"没有复用"，
    //    不能落"操作没成功"那种让人以为可以重试的兜底（2026-10-07 质检 P2-1）。
    const conflict = res.failed.some((failure) => failure.error.includes(TEMPLATE_AGENT_IDENTITY_MISMATCH));
    return {
      ok: false,
      messageKey: conflict ? 'market.error.assistantConflict' : describeTemplateErrorKey('unknown'),
      message: conflict ? ASSISTANT_CONFLICT_FALLBACK : describeTemplateError('unknown'),
      ...(reason ? { diagnostic: reason } : {}),
    };
  }

  const alreadyInstalled = res.skipped.length > 0;
  const reconciledExisting = (res.reconciled?.length ?? 0) > 0;
  const reconciledAgentId = res.reconciled?.find((entry) => entry.id === definition.id)?.agentId;

  // 新建成功要刷；本地目录陈旧时，虽然网关对账后归类为“已安装”，
  // renderer store 仍然是旧的，也必须强刷；普通已安装仍不多发请求。
  if (!alreadyInstalled || reconciledExisting) await deps.refreshAgents();

  const recorded = await deps.recordInstalled(template.id);
  return {
    ok: true,
    // ⭐ 对账复用时用**网关里的真实 id**（可能与定义 id 只差大小写/规格化）——
    //    恒返回 `definition.id` 会让「在罗盘助手中使用」落到"助手不在本机"（质检 P3-4）。
    agentId: reconciledAgentId ?? definition.id,
    alreadyInstalled,
    ...(recorded.ok ? {} : { recordWarning: describeTemplateError(recorded.errorCode) }),
  };
}
