// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 团队安装完**必须刷新助手目录**（2026-09-22 只读复核的"层 3"）。
 *
 * 实机症状（3 次点击可复现）：建/装一个团队 → **不重启** → 打开团队点「发起对话」
 * ⇒ 出的是**主罗盘**。重启就恢复（启动会强刷目录）。
 *
 * 机制：装完的 agent 只进了网关，**客户端目录还是陈旧的** ⇒
 * `useGatewaySelector` 把不在目录里的 id **静默换成 `main`**（用户全程看不到提示）。
 * 全渲染层原本只有三处 `force: true` 强刷（启动 / `MainArea` / 模板安装），**团队路径一个都不在**。
 *
 * ⚠️ **mock 的纪律**：这里 mock 的是 `fetchAgentsForGateway` 本身，断言的是**它被叫过**——
 * 被测的东西是"装完有没有去刷**这一次接线**"，不是目录内容。⚠️ 别写成"桩里替它答一句
 * '刷过了'再断言目录"——那会把缺陷抄进夹具（[[stale-green-tests]] 第三形状），
 * 本项目在别处正是这么栽的。
 */

const refreshMock = vi.hoisted(() => ({
  // ⚠️ 按**真实签名**标注（`Promise<void>`）：写成 `async () => undefined` 会得到 `Promise<undefined>`，
  //    而 vitest 不做类型检查 ⇒ 只有 `typecheck:tests` 会红（本刀实测栽过一次）。
  fetchAgentsForGateway: vi.fn<(gatewayId: string, options?: { force?: boolean }) => Promise<void>>(
    async () => undefined,
  ),
}));

vi.mock('@/hooks/useGatewayDispatcherSetup', () => ({
  fetchAgentsForGateway: refreshMock.fetchAgentsForGateway,
}));

import { finishTeamInstall, useTeamInstall } from '../src/renderer/layouts/TeamsPanel/useTeamInstall';
import type { AgentDraft, TeamInfo } from '../src/renderer/layouts/TeamsPanel/types';

const teamInfo: TeamInfo = {
  name: '开发团队',
  emoji: '🧑💻',
  description: '',
  gatewayId: 'gw-1',
};

function makeAgents(): AgentDraft[] {
  return [
    { uid: 'a1', name: '后端工程师', description: '', role: 'worker', model: '', agentMd: '', soulMd: '', skills: [] },
    { uid: 'a2', name: '前端工程师', description: '', role: 'worker', model: '', agentMd: '', soulMd: '', skills: [] },
  ];
}

type ClawworkMock = Record<
  | 'getTeamWorkspacePath'
  | 'createAgent'
  | 'deleteAgent'
  | 'setAgentFile'
  | 'getConfig'
  | 'patchConfig'
  | 'persistTeam'
  | 'installSkill'
  | 'updateAgent',
  ReturnType<typeof vi.fn>
>;

let clawwork: ClawworkMock;
let api: ReturnType<typeof useTeamInstall> | null = null;
let container: HTMLDivElement;
let root: Root;
/** 副作用顺序账（刷新 vs `onDone`）——用来钉"先刷完再报成功"。 */
let orderLog: string[] = [];

function Harness() {
  api = useTeamInstall(() => orderLog.push('onDone'));
  return null;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  refreshMock.fetchAgentsForGateway.mockClear();
  orderLog = [];
  clawwork = {
    getTeamWorkspacePath: vi.fn(async () => 'D:\\ws\\开发团队'),
    createAgent: vi.fn(async (_gw: string, params: { name: string }) => ({
      ok: true,
      result: { agentId: params.name, name: params.name, workspace: '' },
    })),
    deleteAgent: vi.fn(async () => ({ ok: true })),
    setAgentFile: vi.fn(async () => ({ ok: true })),
    getConfig: vi.fn(async () => ({ ok: true, result: { agents: { entries: {} } } })),
    patchConfig: vi.fn(async () => ({ ok: true })),
    persistTeam: vi.fn(async () => ({ ok: true })),
    installSkill: vi.fn(async () => ({ ok: true })),
    updateAgent: vi.fn(async () => ({ ok: true })),
  };
  (window as unknown as { clawwork: ClawworkMock }).clawwork = clawwork;

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  api = null;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function mount() {
  await act(async () => {
    root.render(<Harness />);
  });
}

async function run() {
  await act(async () => {
    await api?.runInstall(teamInfo, makeAgents());
  });
}

describe('useTeamInstall 装完刷新助手目录', () => {
  it('⭐ 装完团队 ⇒ **强刷一次目录**（否则点「发起对话」会把新 agent 静默换成 main）', async () => {
    await mount();
    await run();

    expect(api?.installStatus).toBe('done');
    expect(refreshMock.fetchAgentsForGateway).toHaveBeenCalledTimes(1);
    expect(refreshMock.fetchAgentsForGateway).toHaveBeenCalledWith('gw-1', { force: true });
  });

  it('装失败（工作区坏）⇒ **不刷**目录（刷新只属于"装完了"这一步）', async () => {
    clawwork.getTeamWorkspacePath.mockResolvedValue('kai-fa-tuan-dui');
    await mount();
    await run();

    expect(api?.installStatus).toBe('error');
    expect(refreshMock.fetchAgentsForGateway).not.toHaveBeenCalled();
  });

  it('⭐ 刷新失败**不能**把"装完了"变成"装失败"（目录最多陈旧，重启会补上）', async () => {
    refreshMock.fetchAgentsForGateway.mockRejectedValueOnce(new Error('gateway is not reachable'));
    await mount();
    await run();

    expect(api?.installStatus).toBe('done');
    expect(api?.installEvents.some((e) => e.type === 'error')).toBe(false);
  });

  it('⭐ `await runInstall(...)` 必须**等到刷新结束**才返回（`void` 化 ⇒ 这条红）', async () => {
    // ⚠️ 踩过两次的坑：**副作用顺序**区分不出 `void`（`onDone`/`setStatus` 本来就都在刷新 resolve 之后，
    //    `void` 只是让**调用方**不再等）⇒ 判据只能是"`runInstall` 在刷新结束前不许 resolve"。
    //    React 的状态也读不了（`act` 会把更新攒到作用域结束），所以这条**完全靠 promise**，确定性。
    let release!: () => void;
    refreshMock.fetchAgentsForGateway.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve();
        }),
    );

    await mount();
    let finished = false;
    await act(async () => {
      const pending = api!.runInstall(teamInfo, makeAgents()).then(() => {
        finished = true;
      });
      for (let i = 0; i < 50 && refreshMock.fetchAgentsForGateway.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }
      expect(refreshMock.fetchAgentsForGateway).toHaveBeenCalledTimes(1);
      expect(finished).toBe(false); // ← 刷新还挂着 ⇒ `runInstall` 不许已经返回
      // ⚠️ 收尾三步一步都不许发生（复核者 P1 实测：调用点删掉 `onDone` 透传时全套全绿 ⇒
      //    这条断言就是它的钉子）。顺序守卫只长在缝里，这里钉的是"调用点确实还在走那个缝"。
      expect(orderLog).toEqual([]);

      release();
      await pending;
    });

    expect(finished).toBe(true);
    expect(orderLog).toEqual(['onDone']);
  });

  it('生成器报 error（落库失败 ⇒ core 先 rollback）⇒ **不刷**目录（这条走的是 error 分支，不是预检）', async () => {
    // ⚠️ 与第 2 条的区别：第 2 条死在 `installTeam` **启动之前**（工作区预检），
    // 这条才真的走到 `event.type === 'error'` 那个分支。
    clawwork.persistTeam.mockResolvedValue({ ok: false, error: 'db is locked' });
    await mount();
    await run();

    expect(api?.installStatus).toBe('error');
    expect(refreshMock.fetchAgentsForGateway).not.toHaveBeenCalled();
  });
});

describe('finishTeamInstall 的收尾顺序（与 React 时序无关的确定性断言）', () => {
  it('⭐ 先刷新 → 再报 done → 再 onDone', async () => {
    // ⚠️ 为什么不放在组件测试里：React 的 `act` 会把状态更新攒到作用域结束 ⇒
    //    "刷新还挂着时 installStatus 是多少"在组件测试里**读不到**（本项目实测两次：
    //    effect 记顺序被批处理骗过、飞行中直接读被批处理骗过）。把三步注入进来之后，
    //    顺序就是普通 spy 的顺序，确定性地钉得住。
    const order: string[] = [];

    await finishTeamInstall({
      gatewayId: 'gw-1',
      refresh: async (gatewayId) => {
        order.push(`refresh:${gatewayId}`);
      },
      setStatus: (status) => order.push(`status:${status}`),
      onDone: () => order.push('onDone'),
    });

    expect(order).toEqual(['refresh:gw-1', 'status:done', 'onDone']);
  });
});
