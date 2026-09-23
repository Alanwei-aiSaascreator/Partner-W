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

const refreshMock = vi.hoisted(() => ({ fetchAgentsForGateway: vi.fn(async () => undefined) }));

vi.mock('@/hooks/useGatewayDispatcherSetup', () => ({
  fetchAgentsForGateway: refreshMock.fetchAgentsForGateway,
}));

import { useTeamInstall } from '../src/renderer/layouts/TeamsPanel/useTeamInstall';
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

  it('⭐ 刷新**完**了才报"装完了"（`await` 的顺序有含义：紧接着点「发起对话」不能被陈旧目录撞上）', async () => {
    // 钉的是**副作用顺序**，不是计时：刷新尚未结束（`refresh:end` 还没推）时，
    // `onDone` 不许先响 —— 改成 `void refreshAgentCatalog(...)`（调用还在、只是不等）这条会红。
    refreshMock.fetchAgentsForGateway.mockImplementationOnce(async () => {
      orderLog.push('refresh:start');
      await Promise.resolve();
      orderLog.push('refresh:end');
    });

    await mount();
    await run();

    expect(orderLog).toEqual(['refresh:start', 'refresh:end', 'onDone']);
  });
});
