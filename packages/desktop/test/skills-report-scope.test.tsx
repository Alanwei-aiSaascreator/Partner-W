// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ⭐ B3(b)（2026-10-11 整改）：随包技能报告的**发布校验**（网关 + 工作区代次归属）。
 *
 * 真源复审（CHANGES_REQUIRED）：报告是单槽状态；一次 ensure 是异步的（重试 + 名称解析）。
 * 用户切到另一个网关之后，**晚到的旧网关结论**既不许覆盖新网关刚发布的报告，
 * 也不许把它清掉（旧网关"全生效"就 `clearBundledSkillsReport()` 是旧实现的形状）。
 *
 * 这条用例驱动**真实 hook**（`useStartupReadiness`）与**真实报告模块**；只把网关侧
 * 的助手安装/目录刷新换成哑件（它们的时序另有专测），让"谁有资格写报告"成为唯一变量。
 */

const gatewayMocks = vi.hoisted(() => ({
  fetchAgentsForGateway: vi.fn(async () => undefined),
  refreshCatalogsForGateway: vi.fn(async () => undefined),
  reinitializeGatewayBootstrap: vi.fn(async () => undefined),
}));
const coordinatorMocks = vi.hoisted(() => ({
  subscribe: vi.fn(() => () => {}),
  run: vi.fn(async () => undefined),
  reset: vi.fn(),
}));
const toastSpy = vi.hoisted(() => vi.fn());

vi.mock('../src/renderer/hooks/useGatewayDispatcherSetup', () => gatewayMocks);
vi.mock('../src/renderer/lib/preset-agent-bootstrap', () => ({ presetAgentBootstrapCoordinator: coordinatorMocks }));
vi.mock('../src/renderer/lib/main-agent-contract', () => ({
  ensureMainAgentContract: vi.fn(async () => false),
  ensureMainAgentContractWithRetry: vi.fn(async () => false),
}));
vi.mock('@/lib/toast', () => ({ toast: toastSpy }));

import { useStartupReadiness } from '../src/renderer/hooks/useStartupReadiness';
import { useUiStore } from '../src/renderer/stores/uiStore';
import { useTaskStore } from '../src/renderer/stores/taskStore';
import {
  captureBundledSkillsOperationScope,
  currentBundledSkillsReportRevision,
  getBundledSkillsReport,
  publishBundledSkillsReport,
  reconcileBundledSkillsAfterResolvedSkill,
  resetBundledSkillsReportForTests,
} from '../src/renderer/lib/ensure-bundled-skills';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type EnsureResult = {
  ok: boolean;
  result?: {
    installed?: string[];
    upgraded?: string[];
    adopted?: string[];
    conflicts?: Array<{ slug: string; reason: string; paths: string[] }>;
    failed?: Array<{ slug: string; error: string }>;
  };
};

const pendingEnsures = new Map<string, Array<(result: EnsureResult) => void>>();
const ensureCalls: string[] = [];

function conflictResult(slug: string): EnsureResult {
  return {
    ok: true,
    result: {
      installed: [],
      upgraded: [],
      adopted: [],
      conflicts: [{ slug, reason: 'user-modified', paths: ['SKILL.md'] }],
      failed: [],
    },
  };
}
function allEffectiveResult(): EnsureResult {
  return { ok: true, result: { installed: [], upgraded: [], adopted: [], conflicts: [], failed: [] } };
}

const unmounts: Array<() => void> = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

function mountHarness(): {
  /** 调 hook 的「重试」出口（会重新跑一轮引导 = 新的 attempt）。 */
  retry: () => Promise<void>;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  let retryFn: (() => Promise<void>) | null = null;
  function Harness(): ReactElement | null {
    const state = useStartupReadiness(true);
    retryFn = () => Promise.resolve(state.retry());
    return null;
  }
  act(() => root.render(<Harness />));
  unmounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return {
    retry: async () => {
      if (!retryFn) throw new Error('harness 还没渲染出第一帧');
      // ⚠️ 刻意**不 await** `retry()` 的返回值：它会一直等到本轮引导的 `Promise.all`
      //    （含本用例故意挂起的 ensure）。这里只把它发起，再把微任务放干净，
      //    让新一轮的 ensure 真正起跑即可。
      act(() => {
        void retryFn?.();
      });
      for (let tick = 0; tick < 10; tick += 1) await flush();
    },
  };
}

async function flush(): Promise<void> {
  await act(async () => undefined);
}

/** 切默认网关（连带把两个网关都标成已连接）。 */
async function switchGateway(gatewayId: string): Promise<void> {
  await act(async () => {
    useUiStore.setState({
      defaultGatewayId: gatewayId,
      gatewayStatusMap: { 'gw-1': 'connected', 'gw-2': 'connected' },
    } as never);
  });
  await flush();
}

/** 解析某个网关**最早**一笔挂起的 ensure 答复（同一网关可能有多轮：老的先答）。 */
async function resolveEnsure(gatewayId: string, result: EnsureResult): Promise<void> {
  const queue = pendingEnsures.get(gatewayId);
  const resolver = queue?.shift();
  if (!queue || !resolver) throw new Error(`没有挂起的 ensure：${gatewayId}`);
  if (queue.length === 0) pendingEnsures.delete(gatewayId);
  await act(async () => {
    resolver(result);
  });
  await flush();
}

beforeEach(() => {
  resetBundledSkillsReportForTests();
  toastSpy.mockClear();
  pendingEnsures.clear();
  ensureCalls.length = 0;
  useUiStore.setState({
    defaultGatewayId: 'gw-1',
    gatewayStatusMap: { 'gw-1': 'connected' },
    modelCatalogByGateway: {},
    modelCatalogFailureByGateway: {},
  } as never);
  useTaskStore.setState({ workspaceEpoch: 0 } as never);
  Object.defineProperty(window, 'clawwork', {
    configurable: true,
    value: {
      probeWorkspaceFsIdentity: vi.fn(async () => ({ state: 'ok' as const, dev: '1', ino: '2' })),
      ensureOurSkills: vi.fn(
        (gatewayId: string) =>
          new Promise<EnsureResult>((resolve) => {
            ensureCalls.push(gatewayId);
            const queue = pendingEnsures.get(gatewayId) ?? [];
            queue.push(resolve);
            pendingEnsures.set(gatewayId, queue);
          }),
      ),
    },
  });
});

describe('随包技能报告：按网关 + 工作区代次归属发布（B3b）', () => {
  it('⭐ 切到新网关后，旧网关晚到的结论不许发布（新网关的 ensure 还挂着也不许插队）', async () => {
    mountHarness();
    await flush();
    expect(ensureCalls, '第一个网关的 ensure 已起跑').toEqual(['gw-1']);

    await switchGateway('gw-2');
    expect(ensureCalls, '切网关后新网关的 ensure 也起跑').toEqual(['gw-1', 'gw-2']);

    // 旧网关（gw-1）的结论晚到：不进报告（新网关的结论还没回来）。
    await resolveEnsure('gw-1', conflictResult('deck-layout'));
    expect(getBundledSkillsReport(), '旧网关晚到的结论不许写进报告').toBeNull();

    // 新网关（gw-2）的结论回来：正常发布，归属是它自己。
    await resolveEnsure('gw-2', conflictResult('html-deliverable'));
    const report = getBundledSkillsReport();
    expect(report?.gatewayId).toBe('gw-2');
    expect(report?.conflicts.map((entry) => entry.slug)).toEqual(['html-deliverable']);
  });

  it('⭐ 旧网关"全生效"的晚到结论不许把新网关的冲突报告清掉', async () => {
    mountHarness();
    await flush();
    await switchGateway('gw-2');
    // 新网关的报告已经发布（模拟它先完成）。
    publishBundledSkillsReport({
      gatewayId: 'gw-2',
      conflicts: [{ slug: 'deck-layout', reason: 'user-modified', paths: ['SKILL.md'] }],
      failed: [],
      names: {},
      updatedAt: 1,
    });

    // 旧网关（gw-1）晚到的"全生效"：不许 clear。
    await resolveEnsure('gw-1', allEffectiveResult());
    expect(getBundledSkillsReport(), '旧网关的 allEffective 不许清新网关的冲突报告').not.toBeNull();
    expect(getBundledSkillsReport()?.gatewayId).toBe('gw-2');
  });

  it('⭐ 当前网关自己的"全生效"照常清（真实恢复路径不许被这刀误伤）', async () => {
    publishBundledSkillsReport({
      gatewayId: 'gw-1',
      conflicts: [{ slug: 'deck-layout', reason: 'user-modified', paths: ['SKILL.md'] }],
      failed: [],
      names: {},
      updatedAt: 1,
    });
    mountHarness();
    await flush();

    await resolveEnsure('gw-1', allEffectiveResult());
    expect(getBundledSkillsReport(), '当前网关全生效 ⇒ 上一次的提示收掉').toBeNull();
  });

  it('⭐ 工作区代次变了（换工作区）⇒ 旧结论同样丢弃', async () => {
    mountHarness();
    await flush();

    await act(async () => {
      useTaskStore.setState({ workspaceEpoch: 1 } as never);
    });
    await flush();

    await resolveEnsure('gw-1', conflictResult('deck-layout'));
    expect(getBundledSkillsReport(), '工作区代次已变：旧结论不许落进报告').toBeNull();
  });

  it('⭐ 同网关点了重试：上一轮晚到的结论不许覆盖新一轮的结果', async () => {
    const harness = mountHarness();
    await flush();
    expect(ensureCalls).toEqual(['gw-1']);

    // 第一轮还在飞的时候点重试 ⇒ 第二轮 ensure 起跑。
    await harness.retry();
    expect(ensureCalls, '重试会开新一轮 ensure').toEqual(['gw-1', 'gw-1']);

    // 第一轮（旧结论）晚到：丢弃。
    await resolveEnsure('gw-1', conflictResult('deck-layout'));
    expect(getBundledSkillsReport(), '上一轮晚到的结论不许落进报告').toBeNull();

    // 第二轮的结论照常发布。
    await resolveEnsure('gw-1', conflictResult('html-deliverable'));
    expect(getBundledSkillsReport()?.conflicts.map((entry) => entry.slug)).toEqual(['html-deliverable']);
  });

  it('⭐ B3（复审二轮）：ensure 卡在名称解析时用户已修复 —— 晚到的旧结论不许把修好的冲突贴回来', async () => {
    const twoConflicts: EnsureResult = {
      ok: true,
      result: {
        installed: [],
        upgraded: [],
        adopted: [],
        conflicts: [
          { slug: 'deck-layout', reason: 'user-modified', paths: ['SKILL.md'] },
          { slug: 'html-deliverable', reason: 'user-modified', paths: ['SKILL.md'] },
        ],
        failed: [],
      },
    };
    // 报告先有一份 deck + html；ensure 会在中途卡在名称解析（listOurSkills 挂起）。
    publishBundledSkillsReport({
      gatewayId: 'gw-1',
      conflicts: [
        { slug: 'deck-layout', reason: 'user-modified', paths: ['SKILL.md'] },
        { slug: 'html-deliverable', reason: 'user-modified', paths: ['SKILL.md'] },
      ],
      failed: [],
      names: {},
      updatedAt: 1,
      workspaceEpoch: 0,
    });
    let resolveNames!: (value: unknown) => void;
    const namesPending = new Promise((resolve) => (resolveNames = resolve));
    const clawwork = (window as unknown as { clawwork: Record<string, unknown> }).clawwork;
    clawwork.listOurSkills = vi.fn(() => namesPending);

    mountHarness();
    await flush();
    // ensure 拿到结论（deck+html），进入名称解析 —— 挂住。
    await resolveEnsure('gw-1', twoConflicts);
    expect(clawwork.listOurSkills).toHaveBeenCalled();

    // 用户在技能市场修复 deck 成功（真实收敛入口 + 发起时捕获的作用域）。
    const scope = captureBundledSkillsOperationScope('gw-1', 0);
    reconcileBundledSkillsAfterResolvedSkill(scope, 'deck-layout', {
      gatewayId: useUiStore.getState().defaultGatewayId ?? '',
      workspaceEpoch: useTaskStore.getState().workspaceEpoch,
    });
    expect(getBundledSkillsReport()?.conflicts.map((entry) => entry.slug)).toEqual(['html-deliverable']);

    // 名称解析终于回来：旧 ensure 的结论（含已修好的 deck）**不许**被贴回来 ——
    // 但这是**结果语义**：合并后的报告允许名称信息更新（旧断言要求报告引用逐字不变，
    // 那会连合法的名称刷新一起禁掉）。
    await act(async () => {
      resolveNames({
        ok: true,
        result: { managedDirKnown: true, skills: [{ slug: 'deck-layout', name: '幻灯版面' }] },
      });
    });
    await flush();
    const lateReport = getBundledSkillsReport();
    expect(lateReport, '晚到的旧 ensure 结论：报告仍在，其余未解决项不许被丢').not.toBeNull();
    expect(
      lateReport?.conflicts.map((entry) => entry.slug),
      '已修项不出现、其余项保留',
    ).toEqual(['html-deliverable']);
    expect(lateReport?.gatewayId).toBe('gw-1');
    expect(lateReport?.workspaceEpoch).toBe(0);
    expect(lateReport?.names['deck-layout'], '名称信息允许随成功结果/晚到解析更新').toBe('幻灯版面');
  });

  // ─────────── ⭐ B3 四轮（2026-10-11）：先成功后报告 / 旧回调不围栏（复审 P2 #2） ───────────

  it('⭐ B3 四轮 #2a：ensure 在途时用户已修复（报告还是空的）—— 晚到的全量结论仍要发布，已修项不出现', async () => {
    const twoConflicts: EnsureResult = {
      ok: true,
      result: {
        installed: [],
        upgraded: [],
        adopted: [],
        conflicts: [
          { slug: 'deck-layout', reason: 'user-modified', paths: ['SKILL.md'] },
          { slug: 'html-deliverable', reason: 'user-modified', paths: ['SKILL.md'] },
        ],
        failed: [],
      },
    };
    mountHarness();
    await flush();
    expect(ensureCalls).toEqual(['gw-1']);

    // 用户在技能市场修好了 deck —— 此刻报告还是空的（ensure 还在飞）。
    const scope = captureBundledSkillsOperationScope('gw-1', 0);
    reconcileBundledSkillsAfterResolvedSkill(scope, 'deck-layout', {
      gatewayId: useUiStore.getState().defaultGatewayId ?? '',
      workspaceEpoch: useTaskStore.getState().workspaceEpoch,
    });
    expect(getBundledSkillsReport(), '没有报告可收敛：不许凭空造一份').toBeNull();

    // 在飞的 ensure 现在才拿到结论：整份未解决报告照常首次发布（只滤掉已修项）。
    // 旧实现的"整表轮次"判据会因成功回调推进过轮次，把**整份结论**丢在地上（复审 P2 #2a）。
    await resolveEnsure('gw-1', twoConflicts);

    const report = getBundledSkillsReport();
    expect(report, '旧回调不得让整份未解决报告消失').not.toBeNull();
    expect(
      report?.conflicts.map((entry) => entry.slug),
      '已修项不出现、其余项保留',
    ).toEqual(['html-deliverable']);
    expect(report?.gatewayId).toBe('gw-1');
  });

  it('⭐ B3 四轮 #2b：旧网关的操作回调不许推进/围栏当前 ensure —— 当前整份未解决报告照常发布', async () => {
    // 操作在**别的网关**上发起（用户后来切到了 gw-1）。
    const staleScope = captureBundledSkillsOperationScope('gw-2', 0);
    mountHarness();
    await flush();
    expect(ensureCalls).toEqual(['gw-1']);

    const revisionBefore = currentBundledSkillsReportRevision();
    reconcileBundledSkillsAfterResolvedSkill(staleScope, 'deck-layout', {
      gatewayId: useUiStore.getState().defaultGatewayId ?? '',
      workspaceEpoch: useTaskStore.getState().workspaceEpoch,
    });
    expect(currentBundledSkillsReportRevision(), '旧网关回调一个副作用都不许留（含报告轮次）').toBe(revisionBefore);
    expect(getBundledSkillsReport()).toBeNull();

    // 当前网关在飞的 ensure 结论回来：整份报告照常发布。
    // 旧实现里旧回调会推进轮次 → 当前 ensure 被整表判据围栏、整份结论被丢（复审 P2 #2b）。
    await resolveEnsure('gw-1', {
      ok: true,
      result: {
        installed: [],
        upgraded: [],
        adopted: [],
        conflicts: [
          { slug: 'deck-layout', reason: 'user-modified', paths: ['SKILL.md'] },
          { slug: 'html-deliverable', reason: 'user-modified', paths: ['SKILL.md'] },
        ],
        failed: [],
      },
    });

    const report = getBundledSkillsReport();
    expect(report, '旧网关回调不得让当前整份未解决报告消失').not.toBeNull();
    expect(
      report?.conflicts.map((entry) => entry.slug),
      '当前 ensure 的全量结论原样发布',
    ).toEqual(['deck-layout', 'html-deliverable']);
  });

  it('⭐ B3 四轮 #2c：成功记账只按开始序号收敛 —— 后续新 ensure 重新发现同一冲突照常报告', async () => {
    const harness = mountHarness();
    await flush();
    expect(ensureCalls).toEqual(['gw-1']);

    // 第一轮 ensure 报 deck 冲突 → 发布；用户修复成功 → 报告收敛（清空）。
    await resolveEnsure('gw-1', conflictResult('deck-layout'));
    expect(getBundledSkillsReport()?.conflicts.map((entry) => entry.slug)).toEqual(['deck-layout']);
    const scope = captureBundledSkillsOperationScope('gw-1', 0);
    reconcileBundledSkillsAfterResolvedSkill(scope, 'deck-layout', {
      gatewayId: useUiStore.getState().defaultGatewayId ?? '',
      workspaceEpoch: useTaskStore.getState().workspaceEpoch,
    });
    expect(getBundledSkillsReport(), '最后一个未解决项收敛 ⇒ 报告撤下').toBeNull();

    // 新一轮 ensure（点重试）：仍发现 deck 冲突（冲突重新出现）—— 历史成功只对
    // "开始序号更早的结论"生效，不许把它永久掩盖。
    await harness.retry();
    expect(ensureCalls, '重试会开新一轮 ensure').toEqual(['gw-1', 'gw-1']);
    await resolveEnsure('gw-1', conflictResult('deck-layout'));

    expect(
      getBundledSkillsReport()?.conflicts.map((entry) => entry.slug),
      '新 ensure 的结论照常发布',
    ).toEqual(['deck-layout']);
  });
});
