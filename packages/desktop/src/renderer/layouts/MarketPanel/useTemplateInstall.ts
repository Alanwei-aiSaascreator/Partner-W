import { useCallback, useState } from 'react';
import type { AgentTemplateDetail } from '@clawwork/shared';
import { COMMON_OPERATING_CONTRACT } from '@/lib/preset-agents';
import { fetchAgentsForGateway } from '@/hooks/useGatewayDispatcherSetup';
import { useGatewaySelector } from '@/hooks/useGatewaySelector';
import { installTemplate, type TemplateInstallOutcome } from '@/lib/template-install';
import { useUiStore } from '@/stores/uiStore';

/**
 * 「安装一个模板」的 React 包装：把真实依赖（网关 id、工作区路径、当前助手目录、
 * 记账 IPC）接上 `installTemplate`，并对外只暴露"正在装哪一个"。
 *
 * 真正的编排在 `lib/template-install.ts`（纯函数、可单测）；这里刻意不写逻辑。
 */
export function useTemplateInstall(): {
  install: (template: AgentTemplateDetail) => Promise<TemplateInstallOutcome>;
  installingId: string | null;
} {
  const { selectedGwId } = useGatewaySelector();
  const [installingId, setInstallingId] = useState<string | null>(null);

  const install = useCallback(
    async (template: AgentTemplateDetail): Promise<TemplateInstallOutcome> => {
      setInstallingId(template.id);
      try {
        const workspaceRoot = (await window.clawwork.getWorkspacePath()) ?? '';
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
            refreshAgents: () => fetchAgentsForGateway(selectedGwId, { force: true }),
            recordInstalled: (id) => window.clawwork.marketTemplateInstalled(id),
            commonContract: COMMON_OPERATING_CONTRACT,
          },
          template,
        );
      } finally {
        setInstallingId(null);
      }
    },
    [selectedGwId],
  );

  return { install, installingId };
}
