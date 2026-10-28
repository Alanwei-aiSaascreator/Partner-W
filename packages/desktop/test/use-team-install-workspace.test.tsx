// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTeamInstall } from '../src/renderer/layouts/TeamsPanel/useTeamInstall';
import { useTeamHubInstall } from '../src/renderer/layouts/TeamsPanel/useTeamHubInstall';
import { useUiStore } from '../src/renderer/stores/uiStore';
import type { AgentDraft, TeamInfo } from '../src/renderer/layouts/TeamsPanel/types';
import { toSlug } from '../src/renderer/layouts/TeamsPanel/utils';
import { WORKSPACE_UNAVAILABLE_MESSAGE } from '../src/renderer/lib/install-workspace';
import { configToAgentDrafts, parseTeamConfig, type TeamConfig } from '../src/renderer/components/TeamBuilderDialog';
import { buildInstallEventView } from '../src/renderer/lib/install-event-view';

vi.mock('../src/renderer/hooks/useGatewayDispatcherSetup', () => ({ fetchAgentsForGateway: vi.fn() }));

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
      position: 'challenger',
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
      position: 'scribe',
      model: '',
      agentMd: '',
      soulMd: '',
      skills: [],
    },
  ];
}

type ClawworkMock = {
  hubDownloadTeam: ReturnType<typeof vi.fn>;
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
  probeWorkspaceFsIdentity: ReturnType<typeof vi.fn>;
};

let clawwork: ClawworkMock;
let api: ReturnType<typeof useTeamInstall> | null = null;
let hubApi: ReturnType<typeof useTeamHubInstall> | null = null;
let container: HTMLDivElement;
let root: Root;

function Harness() {
  api = useTeamInstall();
  return null;
}

function HubHarness() {
  hubApi = useTeamHubInstall();
  return null;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clawwork = {
    hubDownloadTeam: vi.fn(),
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
    probeWorkspaceFsIdentity: vi.fn(async () => ({ state: 'ok', dev: '1', ino: '2' })),
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
  hubApi = null;
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
  it.each(['create', 'skill'])(
    'keeps saved usable members but reports degraded after a %s failure',
    async (failure) => {
      const drafts = makeAgents();
      if (failure === 'create') clawwork.createAgent.mockResolvedValueOnce({ ok: false, error: 'quota exceeded' });
      else {
        drafts[0].skills = ['missing-skill'];
        clawwork.installSkill.mockResolvedValue({ ok: false, error: 'not found' });
      }
      await mount();
      await act(async () => {
        await api?.runInstall(teamInfo, drafts);
      });
      expect(api?.installStatus).toBe('degraded');
      expect(clawwork.persistTeam).toHaveBeenCalledOnce();
      expect(clawwork.deleteAgent).not.toHaveBeenCalled();
      expect(api?.installEvents.at(-1)).toMatchObject({
        type: 'degraded',
        summary: {
          agentsSucceeded: failure === 'create' ? 1 : 2,
          agentsFailed: failure === 'create' ? 1 : 0,
          skillsFailed: failure === 'skill' ? 1 : 0,
        },
      });
    },
  );

  it('keeps degraded status and warnings at the marketplace entry', async () => {
    clawwork.hubDownloadTeam.mockResolvedValue({
      ok: true,
      result: {
        parsed: {
          name: 'Market',
          agents: [{ id: 'author', name: 'Author', role: 'worker' }],
          version: '1',
          description: '',
          body: '',
        },
        agentFiles: { author: { skillsJson: JSON.stringify({ skills: { absent: { sourceType: 'clawhub' } } }) } },
      },
    });
    clawwork.installSkill.mockResolvedValue({ ok: false, error: 'not found' });
    await act(async () => {
      root.render(<HubHarness />);
    });
    await act(async () => {
      await hubApi?.install(
        {
          _registryId: 'registry',
          slug: 'market',
          name: 'Market',
          emoji: '',
          description: '',
          version: '1',
          agentCount: 1,
          category: '',
          tags: [],
          author: '',
        },
        'gw-1',
      );
    });
    expect(hubApi?.phase).toBe('degraded');
    expect(hubApi?.installEvents.some((event) => event.type === 'warning' && event.skillId === 'absent')).toBe(true);
    expect(clawwork.deleteAgent).not.toHaveBeenCalled();
  });

  it.each(['result', 'throw'])('does not save an existing team when a skill install fails: %s', async (failure) => {
    if (failure === 'result') clawwork.installSkill.mockResolvedValue({ ok: false, error: 'skill not found' });
    else clawwork.installSkill.mockRejectedValue(new Error('network disconnected'));
    const drafts = makeAgents().map((draft, index) => ({
      ...draft,
      existingAgentId: `existing-${index}`,
      skills: ['requested-skill'],
    }));
    await mount();
    await act(async () => {
      await api?.runUpdate('team-id', 'created-at', teamInfo, drafts);
    });
    expect(api?.installStatus).toBe('error');
    expect(api?.installEvents.find((event) => event.type === 'error')?.message).toMatch(/技能.*requested-skill.*重试/);
    expect(clawwork.installSkill).toHaveBeenCalledWith('gw-1', {
      agentId: 'existing-0',
      source: 'clawhub',
      slug: 'requested-skill',
    });
    expect(clawwork.persistTeam).not.toHaveBeenCalled();
    expect(clawwork.deleteAgent).not.toHaveBeenCalled();
  });

  it('preserves marketplace ids through the shared installer and repeat-install reconciliation', async () => {
    const members = [
      { id: 'finance-chief', name: '\u878d\u8d44\u4e3b\u7ba1', role: 'coordinator' },
      { id: 'finance-research', name: '\u5546\u4e1a\u5206\u6790\u5e08', role: 'worker' },
    ];
    const entry = {
      _registryId: 'registry',
      slug: 'finance-team',
      name: 'Finance',
      emoji: '',
      description: '',
      version: '1.0.0',
      agentCount: 2,
      category: 'business',
      tags: [],
      author: 'author',
    };
    clawwork.hubDownloadTeam.mockResolvedValue({
      ok: true,
      result: {
        parsed: { name: 'Finance', description: '', version: '1.0.0', agents: members, body: '' },
        agentFiles: Object.fromEntries(
          members.map((member) => [
            member.id,
            {
              agentMd: `Identity for ${member.id}`,
              skillsJson: JSON.stringify({ version: 1, skills: { [member.id + '-skill']: { sourceType: 'clawhub' } } }),
            },
          ]),
        ),
      },
    });
    clawwork.getConfig.mockResolvedValue({ ok: true, result: { hash: 'hash', config: { agents: { entries: {} } } } });
    await act(async () => {
      root.render(<HubHarness />);
    });
    await act(async () => {
      await hubApi?.install(entry, 'gw-1');
    });

    expect(hubApi?.phase).toBe('done');
    expect(clawwork.createAgent.mock.calls.map((call) => call[1].name)).toEqual(members.map((member) => member.id));
    for (const member of members) {
      expect(clawwork.setAgentFile).toHaveBeenCalledWith(
        'gw-1',
        member.id,
        'IDENTITY.md',
        `Identity for ${member.id}\n\n- Name: ${member.name}`,
      );
      expect(clawwork.updateAgent).toHaveBeenCalledWith('gw-1', { agentId: member.id, name: member.name });
    }
    expect(clawwork.persistTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        hubSlug: entry.slug,
        agents: members.map((member) =>
          expect.objectContaining({ agentId: member.id, skills: [member.id + '-skill'] }),
        ),
      }),
    );
    expect(clawwork.patchConfig).toHaveBeenCalledWith('gw-1', {
      baseHash: 'hash',
      raw: JSON.stringify({
        agents: { entries: { 'finance-chief': { subagents: { allowAgents: ['finance-research'] } } } },
      }),
    });

    clawwork.setAgentFile.mockClear();
    clawwork.updateAgent.mockClear();
    clawwork.createAgent.mockImplementation(async (_gw, params) => ({
      ok: false,
      error: `agent "${params.name}" already exists`,
    }));
    clawwork.listAgents.mockResolvedValue({ ok: true, result: { agents: members } });
    await act(async () => {
      await hubApi?.install(entry, 'gw-1');
    });
    expect(hubApi?.phase).toBe('done');
    expect(clawwork.setAgentFile).not.toHaveBeenCalled();
    expect(clawwork.updateAgent).not.toHaveBeenCalled();
    expect(clawwork.deleteAgent).not.toHaveBeenCalled();
  });

  it('installs parsed Chinese AI configs with matching ids, files, models, skills and progress', async () => {
    const names = ['\u878d\u8d44\u4e3b\u7ba1', '\u5546\u4e1a\u5206\u6790\u5e08', '\u6f14\u793a\u8bbe\u8ba1\u5e08'];
    const models = names.map((_, index) => ({ id: `model-${index}`, provider: 'clawrouter' }));
    useUiStore.setState({ modelCatalogByGateway: { 'gw-1': models } });
    const raw = {
      name: 'Team',
      emoji: '',
      description: 'Team description',
      agents: names.map((name, index) => ({
        name,
        role: index === 0 ? 'coordinator' : 'worker',
        description: `Description ${index}`,
        model: `clawrouter/model-${index}`,
        identity: `Identity ${index}`,
      })),
    };
    const config = parseTeamConfig('```team-config\n' + JSON.stringify(raw) + '\n```', models) as TeamConfig;
    const drafts = configToAgentDrafts(config, models).map((draft, index) => ({
      ...draft,
      skills: [`skill-${index}`],
    }));
    clawwork.getConfig.mockResolvedValue({ ok: true, result: { hash: 'hash', config: { agents: { entries: {} } } } });
    await mount();
    await act(async () => {
      await api?.runInstall(teamInfo, drafts);
    });

    expect(api?.installStatus).toBe('done');
    for (const [index, draft] of drafts.entries()) {
      const id = config.agents[index].id;
      expect(clawwork.createAgent).toHaveBeenNthCalledWith(index + 1, 'gw-1', {
        name: id,
        workspace: `D:\\ws\\${teamInfo.name}\\${id}`,
      });
      expect(clawwork.setAgentFile).toHaveBeenCalledWith(
        'gw-1',
        id,
        'IDENTITY.md',
        expect.stringContaining(draft.agentMd),
      );
      expect(clawwork.updateAgent).toHaveBeenCalledWith('gw-1', { agentId: id, name: names[index] });
      expect(clawwork.updateAgent).toHaveBeenCalledWith('gw-1', { agentId: id, model: `clawrouter/model-${index}` });
      expect(clawwork.persistTeam).toHaveBeenCalledWith(
        expect.objectContaining({
          agents: expect.arrayContaining([expect.objectContaining({ agentId: id, skills: [`skill-${index}`] })]),
        }),
      );
    }
    expect(
      api?.installEvents.filter((event) => event.type === 'agent_created').map((event) => event.agentSlug),
    ).toEqual(config.agents.map((agent) => agent.id));
    expect(
      buildInstallEventView(config.agents, api?.installEvents ?? []).agentStates.map((state) => state.status),
    ).toEqual(['created', 'created', 'created']);
  });

  it('keeps colliding names separate across files, models, persisted agents and progress', async () => {
    const drafts = makeAgents().map((draft, index) => ({
      ...draft,
      id: index === 0 ? 'a1' : 'a1-2',
      name: `${draft.name} A1`,
      model: 'clawrouter/deepseek-v4-flash',
      agentMd: `Identity ${index}`,
      skills: [`skill-${index}`],
    }));
    await mount();
    await act(async () => {
      await api?.runInstall(teamInfo, drafts);
    });

    expect(clawwork.createAgent.mock.calls.map((call) => call[1].name)).toEqual(['a1', 'a1-2']);
    expect(clawwork.setAgentFile).toHaveBeenCalledWith(
      'gw-1',
      'a1',
      'IDENTITY.md',
      `Identity 0\n\n- Name: ${drafts[0].name}`,
    );
    expect(clawwork.setAgentFile).toHaveBeenCalledWith(
      'gw-1',
      'a1-2',
      'IDENTITY.md',
      `Identity 1\n\n- Name: ${drafts[1].name}`,
    );
    expect(clawwork.updateAgent).toHaveBeenCalledWith('gw-1', {
      agentId: 'a1-2',
      model: 'clawrouter/deepseek-v4-flash',
    });
    expect(clawwork.persistTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: [
          expect.objectContaining({ agentId: 'a1', skills: ['skill-0'] }),
          expect.objectContaining({ agentId: 'a1-2', skills: ['skill-1'] }),
        ],
      }),
    );
    expect(buildInstallEventView(drafts, api?.installEvents ?? []).agentStates.map((state) => state.slug)).toEqual([
      'a1',
      'a1-2',
    ]);
  });

  it('reuses existing stable ids after a Chinese display-name change without touching their files', async () => {
    const drafts = makeAgents().map((draft, index) => ({
      ...draft,
      id: `stable-${index}`,
      agentMd: `Identity ${index}`,
    }));
    clawwork.createAgent.mockImplementation(async (_gw, params) => ({
      ok: false,
      error: `agent "${params.name}" already exists`,
    }));
    clawwork.listAgents.mockResolvedValue({
      ok: true,
      result: { agents: drafts.map((draft) => ({ id: draft.id, name: draft.name })) },
    });
    await mount();
    await act(async () => {
      await api?.runInstall(teamInfo, drafts);
    });

    expect(api?.installStatus).toBe('done');
    expect(clawwork.persistTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: [expect.objectContaining({ agentId: 'stable-0' }), expect.objectContaining({ agentId: 'stable-1' })],
      }),
    );
    expect(clawwork.setAgentFile).not.toHaveBeenCalled();
    expect(clawwork.updateAgent).not.toHaveBeenCalled();
    expect(clawwork.deleteAgent).not.toHaveBeenCalled();
  });

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
    expect(clawwork.createAgent.mock.calls[0]?.[1]).toMatchObject({
      workspace: `D:\\ws\\${teamInfo.name}\\${toSlug(makeAgents()[0].name)}`,
    });
    expect(clawwork.persistTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: expect.arrayContaining([
          expect.objectContaining({ agentId: toSlug(makeAgents()[0].name), position: 'challenger' }),
          expect.objectContaining({ agentId: toSlug(makeAgents()[1].name), position: 'scribe' }),
        ]),
      }),
    );
    expect(api?.installStatus).toBe('done');
  });

  it('⭐ exFAT/FAT32 能力探测不通过 ⇒ 一个助手都不建', async () => {
    clawwork.probeWorkspaceFsIdentity.mockResolvedValue({
      state: 'unsupported-identity',
      dev: null,
      ino: null,
      error: 'unsupported filesystem: exFAT',
    });
    await mount();
    await run();

    expect(clawwork.createAgent).not.toHaveBeenCalled();
    expect(clawwork.persistTeam).not.toHaveBeenCalled();
    expect(api?.installStatus).toBe('error');
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

  it('⭐ 新装团队显式指定非 relay 或 unavailable 模型 ⇒ 失败关闭，不能静默用默认模型冒充成功', async () => {
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

    expect(api?.installStatus).toBe('error');
    expect(clawwork.updateAgent).not.toHaveBeenCalled();
    expect(clawwork.createAgent).not.toHaveBeenCalled();
    expect(clawwork.persistTeam).not.toHaveBeenCalled();
    expect(api?.installEvents.find((event) => event.type === 'error')?.message).toContain('deepseek-v4-flash');
  });

  it('⭐ 编辑已装成员：姓名 / IDENTITY / SOUL 必须真的写回网关（不能只改模型）', async () => {
    const agents = makeAgents().map((draft, index) => ({
      ...draft,
      existingAgentId: `existing-${index}`,
      name: `新名字${index}`,
      model: 'deepseek-v4-flash',
      description: '负责后端服务',
      agentMd: '你要先讲清楚边界。',
      soulMd: '保持克制，不编造。',
    }));

    await mount();
    await act(async () => {
      await api?.runUpdate('team-1', '2026-09-20T00:00:00.000Z', teamInfo, agents);
    });

    expect(clawwork.updateAgent).toHaveBeenCalledWith(
      'gw-1',
      expect.objectContaining({ agentId: 'existing-0', name: '新名字0' }),
    );
    expect(clawwork.setAgentFile).toHaveBeenCalledWith(
      'gw-1',
      'existing-0',
      'IDENTITY.md',
      expect.stringContaining('负责后端服务'),
    );
    expect(clawwork.setAgentFile).toHaveBeenCalledWith('gw-1', 'existing-0', 'SOUL.md', '保持克制，不编造。');
    expect(api?.installStatus).toBe('done');
  });

  it('⭐ 编辑已有团队时显式模型无法解析 ⇒ 不能跳过更新后仍保存并显示成功', async () => {
    const agents = makeAgents();
    agents[0].existingAgentId = 'backend-existing';
    agents[0].model = 'openai/unknown-domestic-model';

    await mount();
    await act(async () => {
      await api?.runUpdate('team-1', '2026-09-20T00:00:00.000Z', teamInfo, agents);
    });

    expect(api?.installStatus).toBe('error');
    expect(clawwork.updateAgent).not.toHaveBeenCalled();
    expect(clawwork.installSkill).not.toHaveBeenCalled();
    expect(clawwork.persistTeam).not.toHaveBeenCalled();
    expect(api?.installEvents.find((event) => event.type === 'error')?.message).toContain(
      'openai/unknown-domestic-model',
    );
  });
});
