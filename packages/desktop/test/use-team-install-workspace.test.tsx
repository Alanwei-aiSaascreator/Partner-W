// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTeamInstall } from '../src/renderer/layouts/TeamsPanel/useTeamInstall';
import { useUiStore } from '../src/renderer/stores/uiStore';
import type { AgentDraft, TeamInfo } from '../src/renderer/layouts/TeamsPanel/types';
import { toSlug } from '../src/renderer/layouts/TeamsPanel/utils';
import { WORKSPACE_UNAVAILABLE_MESSAGE } from '../src/renderer/lib/install-workspace';

/**
 * 团队安装的**工作区守卫**（2026-09-20 U 盘交付实机）。
 *
 * ⚠️ 实机上出的事：工作区没解析出来时 `workspace:team-path` 返回 slug 本身
 *    （相对路径），四个助手全建失败，界面上只有一句英文
 *    `No agents were created successfully` —— 用户看不到原因，我们也定位不了。
 *    ⇒ 这里钉住两件事：
 *      ① 坏工作区 ⇒ **一次 createAgent 都不许发**，错误事件带中文原因；
 *      ② 好工作区 ⇒ 照旧装上（守卫不许误伤）。
 */

const teamInfo: TeamInfo = {
  name: '开发团队',
  emoji: '🧑💻',
  description: '',
  gatewayId: 'gw-1',
};

function makeAgents(): AgentDraft[] {
  return [
    {
      uid: 'a1',
      name: '后端工程师',
      description: '',
      role: 'worker',
      model: '',
      agentMd: '',
      soulMd: '',
      skills: [],
    },
    {
      uid: 'a2',
      name: '前端工程师',
      description: '',
      role: 'worker',
      model: '',
      agentMd: '',
      soulMd: '',
      skills: [],
    },
  ];
}

type ClawworkMock = {
  getTeamWorkspacePath: ReturnType<typeof vi.fn>;
  createAgent: ReturnType<typeof vi.fn>;
  deleteAgent: ReturnType<typeof vi.fn>;
  setAgentFile: ReturnType<typeof vi.fn>;
  getConfig: ReturnType<typeof vi.fn>;
  patchConfig: ReturnType<typeof vi.fn>;
  persistTeam: ReturnType<typeof vi.fn>;
  installSkill: ReturnType<typeof vi.fn>;
  updateAgent: ReturnType<typeof vi.fn>;
  listAgents: ReturnType<typeof vi.fn>;
};

let clawwork: ClawworkMock;
let api: ReturnType<typeof useTeamInstall> | null = null;
let container: HTMLDivElement;
let root: Root;

function Harness() {
  api = useTeamInstall();
  return null;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
    listAgents: vi.fn(async () => ({ ok: true, result: { agents: [] } })),
  };
  (window as unknown as { clawwork: ClawworkMock }).clawwork = clawwork;
  useUiStore.setState({
    modelCatalogByGateway: {
      'gw-1': [{ id: 'deepseek-v4-flash', provider: 'clawrouter', name: 'DeepSeek V4 Flash' }],
    },
  });

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

describe('useTeamInstall 的工作区守卫', () => {
  it('⭐ 工作区是相对路径（＝没解析出来时返回的 slug）⇒ 一个助手都不建，错误事件带中文原因', async () => {
    clawwork.getTeamWorkspacePath.mockResolvedValue('kai-fa-tuan-dui');
    await mount();
    await run();

    expect(clawwork.createAgent).not.toHaveBeenCalled();
    expect(api?.installStatus).toBe('error');
    const errorEvent = api?.installEvents.find((e) => e.type === 'error');
    expect(errorEvent?.message).toBe(WORKSPACE_UNAVAILABLE_MESSAGE);
  });

  it('⭐ 主进程直接抛（没有工作区）⇒ 同样落到中文原因上，而不是静默失败', async () => {
    clawwork.getTeamWorkspacePath.mockRejectedValue(
      new Error('Error invoking remote method: workspace not configured'),
    );
    await mount();
    await run();

    expect(clawwork.createAgent).not.toHaveBeenCalled();
    const errorEvent = api?.installEvents.find((e) => e.type === 'error');
    expect(errorEvent?.message).toBe(WORKSPACE_UNAVAILABLE_MESSAGE);
  });

  it('工作区正常 ⇒ 守卫不误伤：照旧把每个助手建出来', async () => {
    await mount();
    await run();

    expect(clawwork.getTeamWorkspacePath).toHaveBeenCalledWith(toSlug(teamInfo.name));
    expect(clawwork.createAgent).toHaveBeenCalledTimes(2);
    expect(clawwork.createAgent.mock.calls[0]?.[1]).toMatchObject({ workspace: 'D:\\ws\\开发团队' });
    expect(api?.installStatus).toBe('done');
  });

  it('重复安装时网关用展示名报 already exists ⇒ 复用已有 id，不能整队安装失败', async () => {
    const agents = makeAgents();
    agents[0].name = 'Marketing Copywriter';
    agents[1].name = 'Growth Director';
    clawwork.createAgent
      .mockResolvedValueOnce({ ok: false, error: 'AGENT "MARKETING COPYWRITER" ALREADY EXISTS' })
      .mockResolvedValueOnce({
        ok: true,
        result: { agentId: 'growth-director', name: 'Growth Director', workspace: '' },
      });
    clawwork.listAgents.mockResolvedValue({
      ok: true,
      result: {
        agents: [
          { id: 'marketing_copywriter', name: 'Marketing_Copywriter' },
          { id: 'marketing-copywriter', name: 'Marketing Copywriter' },
        ],
      },
    });

    await mount();
    await act(async () => {
      await api?.runInstall(teamInfo, agents);
    });

    expect(api?.installStatus).toBe('done');
    expect(clawwork.listAgents).toHaveBeenCalledTimes(1);
    expect(clawwork.persistTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: expect.arrayContaining([expect.objectContaining({ agentId: 'marketing-copywriter' })]),
      }),
    );
    expect(clawwork.deleteAgent).not.toHaveBeenCalledWith('gw-1', { agentId: 'marketing-copywriter' });
  });

  it('模型写入返回 ok:false ⇒ 安装必须失败，不能保存团队并显示成功', async () => {
    const agents = makeAgents();
    agents[0].model = 'clawrouter/deepseek-v4-flash';
    clawwork.updateAgent.mockResolvedValue({ ok: false, error: 'model update rejected' });

    await mount();
    await act(async () => {
      await api?.runInstall(teamInfo, agents);
    });

    expect(api?.installStatus).toBe('error');
    expect(clawwork.persistTeam).not.toHaveBeenCalled();
    expect(api?.installEvents.some((event) => event.type === 'error')).toBe(true);
  });

  it('手工入口传入非 relay 或 unavailable 模型 ⇒ 执行边界不许写进助手', async () => {
    const agents = makeAgents();
    agents[0].model = 'openai/deepseek-v4-flash';
    useUiStore.setState({
      modelCatalogByGateway: {
        'gw-1': [
          { id: 'deepseek-v4-flash', provider: 'clawrouter', available: false },
          { id: 'deepseek-v4-flash', provider: 'openai', available: true },
        ],
      },
    });

    await mount();
    await act(async () => {
      await api?.runInstall(teamInfo, agents);
    });

    expect(api?.installStatus).toBe('done');
    expect(clawwork.updateAgent).not.toHaveBeenCalled();
  });
});
