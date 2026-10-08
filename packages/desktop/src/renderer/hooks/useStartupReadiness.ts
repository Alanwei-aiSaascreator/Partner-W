import { useCallback, useEffect, useRef, useState } from 'react';
import type { RelayBootstrapPublicState, RuntimeBootstrapStatus, WorkspaceFsIdentity } from '@clawwork/shared';
import i18n from '@/i18n';
import { relayModelsFrom } from '@/components/ChatInput/model-families';
import {
  fetchAgentsForGateway,
  refreshCatalogsForGateway,
  reinitializeGatewayBootstrap,
} from '@/hooks/useGatewayDispatcherSetup';
import {
  presetAgentBootstrapCoordinator,
  type PresetAgentBootstrapDeps,
  type PresetAgentBootstrapSnapshot,
} from '@/lib/preset-agent-bootstrap';
import { PRESET_AGENT_DEFINITIONS } from '@/lib/preset-agents';
import { installPresetAgentPack } from '@/lib/preset-agent-installer';
import { deriveStartupReadiness } from '@/lib/startup-readiness';
import { ensureBundledSkillsWithRetry } from '@/lib/ensure-bundled-skills';
import { ensureMainAgentContract, ensureMainAgentContractWithRetry } from '@/lib/main-agent-contract';
import { runWorkspaceGatedBootstrap } from '@/lib/startup-workspace-gate';
import { useUiStore } from '@/stores/uiStore';
import { useTaskStore } from '@/stores/taskStore';

function emptyAssistantSnapshot(): PresetAgentBootstrapSnapshot {
  return {
    phase: 'idle',
    completed: 0,
    total: PRESET_AGENT_DEFINITIONS.length,
    missingIds: [],
  };
}

function agentIdsFor(gatewayId: string): string[] {
  return useUiStore.getState().agentCatalogByGateway[gatewayId]?.agents.map((agent) => agent.id) ?? [];
}

export function createBootstrapDeps(gatewayId: string): PresetAgentBootstrapDeps {
  return {
    refreshAgents: () => fetchAgentsForGateway(gatewayId, { force: true }),
    readAgentIds: () => agentIdsFor(gatewayId),
    install: async (currentAgentIds, onProgress) => {
      const workspaceRoot = await window.clawwork.getWorkspacePath();
      if (!workspaceRoot) throw new Error(i18n.t('presetAgents.workspaceUnavailable'));
      const presetIds = new Set<string>(PRESET_AGENT_DEFINITIONS.map((definition) => definition.id));
      const repairAgentIds = (useUiStore.getState().agentCatalogByGateway[gatewayId]?.agents ?? [])
        .filter((agent) => presetIds.has(agent.id) && (agent.name === agent.id || agent.identity?.name === agent.id))
        .map((agent) => agent.id);
      const displayNames = Object.fromEntries(
        PRESET_AGENT_DEFINITIONS.map((definition) => [definition.id, i18n.t(definition.displayNameKey)]),
      );
      return installPresetAgentPack({
        gatewayId,
        workspaceRoot,
        currentAgentIds,
        repairAgentIds,
        verifyExisting: true,
        preservePartialOnFailure: true,
        displayNames,
        api: window.clawwork,
        onProgress,
      });
    },
  };
}

export function useStartupReadiness(enabled: boolean) {
  const workspaceEpoch = useTaskStore((state) => state.workspaceEpoch);
  const active = useRef(true);
  const bootstrapAttempt = useRef(0);
  const currentScope = useRef({ enabled, workspaceEpoch, gatewayId: null as string | null });
  const gatewayId = useUiStore((state) => state.defaultGatewayId);
  currentScope.current = { enabled, workspaceEpoch, gatewayId };
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      bootstrapAttempt.current += 1;
    };
  }, []);
  const gatewayStatus = useUiStore((state) =>
    state.defaultGatewayId ? state.gatewayStatusMap[state.defaultGatewayId] : undefined,
  );
  const rawModelCatalog = useUiStore((state) =>
    state.defaultGatewayId ? state.modelCatalogByGateway[state.defaultGatewayId] : undefined,
  );
  // 目录**取不到**（退避已用尽）与"还在取"是两件事：前者得落显式失败态，
  // 否则界面永远停在"正在准备模型…"（2026-09-20 用户报障）。
  const catalogFailed = useUiStore((state) =>
    state.defaultGatewayId ? state.modelCatalogFailureByGateway[state.defaultGatewayId] === true : false,
  );
  // ⭐ 连接层对这个网关的重连信息（含 `gaveUp`）：没有它，"连接被明确拒绝"会被推导成
  //    "正在准备模型"，而那个状态**永远不会自己好**（2026-09-25 真日志：6 分钟还在转圈）。
  const gatewayReconnect = useUiStore((state) =>
    state.defaultGatewayId ? state.gatewayReconnectInfo?.[state.defaultGatewayId] : undefined,
  );
  // ⭐ 本机运行时（18789 那个网关）**起不来**的公开原因。这条与上面那条是两层事：
  //    端口被**别的**程序占着时连 WS 都没建起来，从连接层一个字都读不到。
  //    没有它，界面只会显示"正在准备模型"一直转（2026-09-25 真日志：六分钟）。
  const runtimeBootstrapFailure = useUiStore((state) => state.runtimeBootstrapFailure);
  const [assistantSnapshot, setAssistantSnapshot] = useState<PresetAgentBootstrapSnapshot>(emptyAssistantSnapshot);
  const [relayState, setRelayState] = useState<RelayBootstrapPublicState | null>(null);
  const relaySnapshot = useRef<RelayBootstrapPublicState | null>(null);
  /**
   * 工作区所在文件系统的探测结果（FAT32 上 `dev=0` ⇒ 助手读写身份文件必失败）。
   *
   * ⚠️ **失败/读不到一律当"没有结论"**（`null`），绝不折算成"文件系统有问题"：
   *    这条结论会把用户劝去换盘，说错一次代价很大。判据见 `deriveStartupReadiness`。
   */
  const [workspaceProbe, setWorkspaceProbe] = useState<{
    identity: WorkspaceFsIdentity | null;
    gatewayId: string | null;
    workspaceEpoch: number;
    attempt: number;
  } | null>(null);
  const workspaceFsIdentity =
    enabled &&
    workspaceProbe?.gatewayId === gatewayId &&
    workspaceProbe.workspaceEpoch === workspaceEpoch &&
    workspaceProbe.attempt === bootstrapAttempt.current
      ? workspaceProbe.identity
      : null;
  // 请求重试那一刻手头那条快照的时间戳：只有**比它更新**的结论才算这一轮的答复。
  const [relayRetryFrom, setRelayRetryFrom] = useState<number | null>(null);

  useEffect(() => {
    if (!gatewayId) {
      setAssistantSnapshot(emptyAssistantSnapshot());
      return;
    }
    return presetAgentBootstrapCoordinator.subscribe(gatewayId, setAssistantSnapshot);
  }, [gatewayId]);

  /**
   * ⭐ 中转公开状态：**先订阅，再读初始快照**。
   *
   * 为什么要读：bootstrap 在窗口建好**之前**就跑过一轮，那之前的事件没人收 ⇒ 只能补读。
   * 为什么要先订阅：补读是异步的，反过来写的话，**订阅前那一瞬**发生的事件会丢，
   * 而晚到的初始读又把更旧的结论盖回去 —— 界面于是把已经确定的失败重新显示成
   * "正在准备模型"（第二台机器那次实机的形状）。
   *
   * 取舍一律看 `updatedAt`（主进程那边严格单调，见 `@clawwork/shared` 的事件契约）：
   * **不是**"事件优先"也不是"读优先"。幂等键是 `(phase, errorCode, updatedAt)`，
   * 内容完全相同的事件可能重复发（被单飞吸收的那次触发也会推成 `running`），
   * 所以这里**不**假设"一条事件 = 一次状态转变"。
   */
  useEffect(() => {
    const api = window.clawwork;
    if (typeof api?.onCommercialRelayBootstrapState !== 'function') return;
    let active = true;
    const accept = (next: RelayBootstrapPublicState): void => {
      if (relaySnapshot.current && relaySnapshot.current.updatedAt >= next.updatedAt) return;
      relaySnapshot.current = next;
      setRelayState((current) => (current && current.updatedAt >= next.updatedAt ? current : next));
    };
    const unsubscribe = api.onCommercialRelayBootstrapState((next) => {
      if (active) accept(next);
    });
    void api
      .commercialRelayBootstrapState()
      .then((result) => {
        if (!active) return;
        // ⚠️ 读不到 = **没有结论**，不是"出错了"：什么都不改，照旧走目录那条有界推断。
        if (result?.ok && result.result) accept(result.result);
      })
      .catch(() => {
        // 同上：初始读这条路不可用，不该在界面上变成一条失败结论。
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!enabled || gatewayId !== 'local-runtime' || gatewayStatus !== 'connected' || relayState?.phase !== 'ready')
      return;
    let current = true;
    const isCurrent = () =>
      current &&
      active.current &&
      currentScope.current.enabled &&
      currentScope.current.gatewayId === gatewayId &&
      currentScope.current.workspaceEpoch === workspaceEpoch &&
      useUiStore.getState().defaultGatewayId === gatewayId &&
      useUiStore.getState().gatewayStatusMap[gatewayId] === 'connected' &&
      useTaskStore.getState().workspaceEpoch === workspaceEpoch &&
      relaySnapshot.current?.phase === 'ready' &&
      relaySnapshot.current.updatedAt === relayState.updatedAt;
    // ⭐ 晚热目录的**有界**恢复观察（2026-10-04 真机）：中转 ready 后第一次目录刷新可能
    //    整个退避窗（~74s）都撞上"目录还没热"，空结论落进 store 之后**不再有任何计时器**，
    //    而真实目录这次到 102.5 秒才可用 —— 界面就永久停在「暂时没有可用模型」。
    //    所以同一 ready 代次、同一 scope 内最多再补问两次（+60s / +120s 起步，整个代次
    //    不超过 180s），直到**真实可用的中转目录进入 store**才停。
    //
    //    边界（数字只限制观察，**不产生 ready 结论** —— ready 仍由 deriveStartupReadiness
    //    按 store 里真实可用的目录推导）：
    //      - 只在当前 ready 代次 / 当前 scope / 仍 connected 时才真发；
    //      - 成功（可用目录已入 store）、失效（scope 变）、断连、禁用、卸载 ⇒ 立刻停；
    //      - 不 reset、不 reinitialize；重渲染不会清零预算（窗口挂在本 effect 生命周期上，
    //        只有真正的代次/scope 变化才重开）。
    const catalogUsable = () =>
      relayModelsFrom(useUiStore.getState().modelCatalogByGateway[gatewayId] ?? []).length > 0;
    const nextAtMs = [60_000, 120_000];
    const timers: number[] = [];
    const attempt = (index: number): void => {
      if (!current || !isCurrent() || catalogUsable()) return;
      void refreshCatalogsForGateway(gatewayId, { isCurrent }).catch((error) => {
        if (isCurrent()) console.warn('[catalogs] Relay-ready catalog refresh failed', error);
      });
      const next = nextAtMs[index];
      if (next !== undefined) {
        const delay = next - (nextAtMs[index - 1] ?? 0);
        timers.push(window.setTimeout(() => attempt(index + 1), delay));
      }
    };
    attempt(0);
    return () => {
      current = false;
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [enabled, gatewayId, gatewayStatus, workspaceEpoch, relayState]);

  const runAssistantBootstrap = useCallback(async () => {
    if (!gatewayId) return;
    await presetAgentBootstrapCoordinator.run(gatewayId, createBootstrapDeps(gatewayId));
  }, [gatewayId]);

  /**
   * 随包技能自装（2026-09-24）：**缺了就补**，不动已装的。
   *
   * 为什么和助手安装同一个时机：两者都是"这个网关上该有的东西齐不齐"，
   * 而且都必须等网关连上（安装目录是**问网关要**的，不本地猜 —— 见 `skills/handlers.ts`）。
   *
   * ⚠️ **尽力而为**：失败只吞掉，不进 readiness 的结论、不挡启动。
   *    技能装不上最坏是"这个能力用不了"，不该让用户卡在准备页。
   */
  const ensureOurSkills = useCallback(async () => {
    if (!gatewayId) return;
    const ready = await ensureBundledSkillsWithRetry(gatewayId, {
      ensure: (id) => window.clawwork.ensureOurSkills(id),
      sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
      delaysMs: [500, 1_500],
    });
    if (!ready) console.warn('[skills] 随包技能自装重试后仍失败');
  }, [gatewayId]);

  /**
   * 主罗盘（`main`）的**交付合同**自装（2026-10-07）：六个预置助手各有一份
   * IDENTITY.md + SOUL.md（每轮全文注入的提示词通道），而工作台**默认助手**主罗盘
   * 什么都没有 —— 从默认入口发起的任务拿不到交付合同（演示走错路/谎报"已生成"的根因之一）。
   *
   * 与随包技能同一个时机、同一条闸门、同样**尽力而为**：写不上只是"这一版合同没到"，
   * 不该让用户卡在准备页。幂等与"不碰用户手改"的判据见 `main-agent-contract.ts`。
   */
  const ensureCompassContract = useCallback(async () => {
    if (!gatewayId) return;
    const ready = await ensureMainAgentContractWithRetry(gatewayId, {
      ensure: (id) => ensureMainAgentContract(id, window.clawwork),
      sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
      delaysMs: [500, 1_500],
    });
    if (!ready) console.warn('[compass] 主罗盘交付合同写入重试后仍失败');
  }, [gatewayId]);

  /**
   * 量一次工作区所在文件系统（探测文件建完就删，不留东西）。
   *
   * 为什么值得单开一路：FAT32 的盘上六个助手**必定**失败，而失败原因在界面上长成一句
   * 「助手失败」—— 用户唯一能做的动作（换到 NTFS 的盘）从界面上看不出来。
   * 探测量的是 fs-safe 判的**那两个数**（`dev`/`ino`），不是盘符或卷标。
   */
  const probeWorkspaceFilesystem = useCallback(
    async (isCurrent: () => boolean, attempt: number): Promise<WorkspaceFsIdentity | null> => {
      try {
        const result = await window.clawwork.probeWorkspaceFsIdentity();
        if (!isCurrent()) return null;
        setWorkspaceProbe({ identity: result ?? null, gatewayId, workspaceEpoch, attempt });
        return result ?? null;
      } catch {
        if (isCurrent()) setWorkspaceProbe({ identity: null, gatewayId, workspaceEpoch, attempt });
        return null;
      }
    },
    [gatewayId, workspaceEpoch],
  );

  const runGatedBootstrap = useCallback(() => {
    const ownsScope = () =>
      active.current &&
      enabled &&
      currentScope.current.enabled &&
      currentScope.current.gatewayId === gatewayId &&
      currentScope.current.workspaceEpoch === workspaceEpoch &&
      useUiStore.getState().defaultGatewayId === gatewayId &&
      useTaskStore.getState().workspaceEpoch === workspaceEpoch &&
      Boolean(gatewayId && useUiStore.getState().gatewayStatusMap[gatewayId] === 'connected');
    if (!ownsScope()) return Promise.resolve(null);
    const attempt = ++bootstrapAttempt.current;
    const isCurrent = () => ownsScope() && bootstrapAttempt.current === attempt;
    setWorkspaceProbe(null);
    return runWorkspaceGatedBootstrap({
      isCurrent,
      probe: () => probeWorkspaceFilesystem(isCurrent, attempt),
      bootstrapAssistants: runAssistantBootstrap,
      ensureSkills: ensureOurSkills,
      ensureMainContract: ensureCompassContract,
    });
  }, [
    enabled,
    workspaceEpoch,
    gatewayId,
    ensureOurSkills,
    ensureCompassContract,
    probeWorkspaceFilesystem,
    runAssistantBootstrap,
  ]);

  useEffect(() => {
    if (enabled && gatewayId && gatewayStatus === 'connected') void runGatedBootstrap();
    return () => {
      bootstrapAttempt.current += 1;
    };
  }, [enabled, gatewayId, gatewayStatus, runGatedBootstrap]);

  const readiness = deriveStartupReadiness({
    gatewayId,
    gatewayStatus,
    rawModelCatalog,
    catalogFailed,
    assistantSnapshot,
    relayState: relayState ?? undefined,
    workspaceFsIdentity,
    gatewayReconnect,
    runtimeBootstrapFailure,
  });

  /**
   * ⭐ 重试之后**第二步**：中转换到 `ready` 才刷网关/目录/助手。
   *
   * 判据是"比请求重试那一刻**更新**的结论"（`updatedAt` 严格单调），不是"又来了一条事件"、
   * 也不是"相位变了"：内容相同的 `running` 会被重发，而请求重试时手头那条失败结论
   * 也还挂在那儿 —— 用那两个判据都会在**还没开始**的时候就把刷新做掉（白刷：
   * 中转配置还没落上去，目录照样取不到）。
   */
  useEffect(() => {
    if (relayRetryFrom === null || !relayState) return;
    if (relayState.updatedAt <= relayRetryFrom) return;
    if (relayState.phase === 'running') return; // 新一轮已经跑起来了：等它跑完
    setRelayRetryFrom(null);
    if (relayState.phase !== 'ready') return; // 又失败了：不白刷（失败结论已经给到界面）
    void reinitializeGatewayBootstrap().then(() => {
      if (gatewayId && useUiStore.getState().gatewayStatusMap[gatewayId] === 'connected') {
        void runGatedBootstrap();
      }
    });
  }, [gatewayId, relayRetryFrom, relayState, runGatedBootstrap]);

  const retry = useCallback(async () => {
    // ⭐ 本机运行时**起不来**（部署失败 / 端口被占 / 等就绪超时…）：出口是让主进程
    //    **真的重跑一轮 bootstrap**（IPC `runtime:bootstrap-retry`，与启动同一条路）。
    //    原来这里落到下面那条通用路径（重新初始化连接层）—— 在同一个"起不来"上再转
    //    一圈，什么都不会变，用户唯一的出路是完全退出应用重开（体检问题 4）。
    //    ⚠️ 快照**直接向主进程读**（不靠 store 里那条推送）：这条判据决定"按下去有没有用"，
    //    读岔了的代价是用户点了一个什么都不做的按钮。
    //    ⚠️ 全部走**可选调用**（`?.` / typeof 判函数）：宿主与测试替身都可能没有这几条
    //    通道（pwa、更老的 preload）。缺了就当"没有结论"，落到下面的通用路径 ——
    //    一次重试绝不该因为少一条通道把界面炸掉。
    const api = window.clawwork as
      | {
          runtimeStatus?: () => Promise<RuntimeBootstrapStatus | null>;
          runtimeBootstrapRetry?: () => Promise<RuntimeBootstrapStatus | null>;
          reconnectGateway?: (gatewayId: string) => Promise<unknown>;
        }
      | undefined;
    const runtimeSnapshot =
      typeof api?.runtimeStatus === 'function' ? await api.runtimeStatus().catch(() => null) : null;
    if (runtimeSnapshot && !runtimeSnapshot.ok && typeof api?.runtimeBootstrapRetry === 'function') {
      const after = await api.runtimeBootstrapRetry().catch(() => null);
      if (after?.ok && gatewayId && typeof api.reconnectGateway === 'function') {
        // 网关这条 WS 可能早就放弃重连了（`gaveUp`）—— 起得来还要**叫它去连**。
        await api.reconnectGateway(gatewayId).catch(() => undefined);
      }
      await reinitializeGatewayBootstrap();
      if (gatewayId && useUiStore.getState().gatewayStatusMap[gatewayId] === 'connected') {
        await runGatedBootstrap();
      }
      return;
    }
    // ⭐ 已知的中转失败：出口是**让主进程重跑一轮**，不是"重新准备模型"。
    //     ⚠️ 确定性失败（去激活 / 换账号）连这一下都不发：再试一万次也是一样的结论，
    //     界面上也没有那个按钮（`StartupReadinessPanel` 按 `kind` 决定给哪个出口）。
    //     `updatedAt` 要在**发请求之前**记下来，否则主进程那条 `running` 可能先到。
    if (readiness.relayFailure) {
      if (readiness.relayFailure.kind !== 'retryable') return;
      setRelayRetryFrom(relayState?.updatedAt ?? 0);
      await window.clawwork.commercialRelayBootstrapRetry();
      return;
    }
    if (gatewayId) presetAgentBootstrapCoordinator.reset(gatewayId);
    // 重试也要重新量一次：用户完全可能在这期间**把工作区换到另一块盘**，
    // 而结论是按旧盘下的（换盘正是这条失败唯一的出路）。
    if (readiness.ai.phase === 'ready' && gatewayStatus === 'connected') {
      await runGatedBootstrap();
      return;
    }
    await reinitializeGatewayBootstrap();
    if (gatewayId && useUiStore.getState().gatewayStatusMap[gatewayId] === 'connected') {
      await runGatedBootstrap();
    }
  }, [gatewayId, gatewayStatus, readiness.ai.phase, readiness.relayFailure, relayState, runGatedBootstrap]);

  return { ...readiness, retry };
}
