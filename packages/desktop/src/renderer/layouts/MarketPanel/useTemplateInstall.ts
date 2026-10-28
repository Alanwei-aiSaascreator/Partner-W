import { useCallback, useRef, useState } from 'react';
import type { AgentTemplateDetail } from '@clawwork/shared';
import { COMMON_OPERATING_CONTRACT } from '@/lib/preset-agents';
import { useGatewaySelector } from '@/hooks/useGatewaySelector';
import { installTemplate, type TemplateInstallOutcome } from '@/lib/template-install';
import { useUiStore } from '@/stores/uiStore';

export interface TemplateInstallController {
  /**
   * 备好一个模板助手。**同一个模板 id 在飞时复用同一条 promise** ——
   * 双击、多个入口并发都只建一次、只记一次账（2026-10-07 质检 P1-1）。
   */
  install: (template: AgentTemplateDetail) => Promise<TemplateInstallOutcome>;
  /** 正在准备/正在装的模板 id 集合（按钮据此置忙）。 */
  installingIds: ReadonlySet<string>;
  /**
   * 入口即置忙（**拉详情之前**就要禁用按钮并挡住重复点击）。
   * 与 `endInstall` 成对使用，调用方用 try/finally 保证收尾。
   */
  beginInstall: (templateId: string) => void;
  endInstall: (templateId: string) => void;
}

/**
 * 「安装一个模板」的 React 包装：把真实依赖（网关 id、工作区路径、当前助手目录、
 * 记账 IPC）接上 `installTemplate`，并对外暴露"正在装哪些"。
 *
 * ⚠️ 2026-10-07（质检 P1-1）：以前是**单个 `installingId`**，且只在 `install` 内部置忙
 *    —— 拉详情的窗口里按钮还是可点的（双击发两次 install）；装 A 时点 B 会把 A 的忙态
 *    顶掉提前恢复可点。现在改成 **id 集合 + 同 id 在飞去重**，两个洞一起堵。
 *
 * 真正的编排在 `lib/template-install.ts`（纯函数、可单测）；这里刻意不写业务逻辑。
 */
export function useTemplateInstall(): TemplateInstallController {
  const { selectedGwId } = useGatewaySelector();
  const [installingIds, setInstallingIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const inFlight = useRef(new Map<string, Promise<TemplateInstallOutcome>>());

  const setBusy = useCallback((templateId: string, busy: boolean) => {
    setInstallingIds((previous) => {
      const next = new Set(previous);
      if (busy) next.add(templateId);
      else next.delete(templateId);
      return next;
    });
  }, []);

  const beginInstall = useCallback((templateId: string) => setBusy(templateId, true), [setBusy]);
  const endInstall = useCallback((templateId: string) => setBusy(templateId, false), [setBusy]);

  const install = useCallback(
    (template: AgentTemplateDetail): Promise<TemplateInstallOutcome> => {
      const existing = inFlight.current.get(template.id);
      if (existing) return existing;

      beginInstall(template.id);
      const task = (async (): Promise<TemplateInstallOutcome> => {
        try {
          // ⚠️ 不在这里 `?? ''`：拿不到工作区就交给 `installTemplate` 明确拒绝，
          //    空串一路拼下去会变成根相对路径，坏得看不见（2026-09-20 U 盘交付实机）
          const workspaceRoot = await window.clawwork.getWorkspacePath();
          const currentAgentIds = (useUiStore.getState().agentCatalogByGateway[selectedGwId]?.agents ?? []).map(
            (agent) => agent.id,
          );

          return await installTemplate(
            {
              gatewayId: selectedGwId,
              workspaceRoot,
              currentAgentIds,
              // 安装 agent 用的就是这几个既有 IPC（与创建向导、预置助手同一条链）
              api: window.clawwork,
              refreshAgents: async () => {
                // ⚠️ 动态 import：这条链会一路拉到网关 dispatcher（很重），而"安装完刷新目录"
                //    是低频动作。静态引入会让任何 import 本模块的页面/测试都被迫加载整条
                //    网关链（实测：两个只 mock 了 core/platform 的既有测试直接加载失败）。
                const { fetchAgentsForGateway } = await import('@/hooks/useGatewayDispatcherSetup');
                await fetchAgentsForGateway(selectedGwId, { force: true });
              },
              recordInstalled: (id) => window.clawwork.marketTemplateInstalled(id),
              commonContract: COMMON_OPERATING_CONTRACT,
              probeWorkspaceFsIdentity: () => window.clawwork.probeWorkspaceFsIdentity(),
            },
            template,
          );
        } finally {
          inFlight.current.delete(template.id);
          endInstall(template.id);
        }
      })();
      inFlight.current.set(template.id, task);
      return task;
    },
    [beginInstall, endInstall, selectedGwId],
  );

  return { install, installingIds, beginInstall, endInstall };
}
