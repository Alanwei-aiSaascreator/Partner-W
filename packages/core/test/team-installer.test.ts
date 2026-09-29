import { describe, it, expect, vi } from 'vitest';
import { installTeam } from '../src/services/team-installer';
import type { InstallerDeps } from '../src/services/team-installer';
import type { ParsedTeam, AgentFileSet, InstallEvent } from '@clawwork/shared';

function makeParsed(overrides?: Partial<ParsedTeam>): ParsedTeam {
  return {
    name: 'test-team',
    description: 'A test team',
    version: '1.0.0',
    agents: [
      { id: 'manager', name: 'Manager', role: 'coordinator' },
      { id: 'dev', name: 'Developer', role: 'worker' },
    ],
    body: '# Mission\nTest.',
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<InstallerDeps>): InstallerDeps {
  let agentCounter = 0;
  return {
    createAgent: vi.fn().mockImplementation(async () => ({
      ok: true,
      result: { agentId: `agent-${++agentCounter}`, name: 'x', workspace: '/w' },
    })),
    deleteAgent: vi.fn().mockResolvedValue({ ok: true }),
    setAgentFile: vi.fn().mockResolvedValue({ ok: true }),
    installSkill: vi
      .fn()
      .mockResolvedValue({ ok: true, result: { ok: true, message: 'ok', stdout: '', stderr: '', code: 0 } }),
    getConfig: vi.fn().mockResolvedValue({
      ok: true,
      result: {
        raw: '{}',
        hash: 'config-hash',
        config: { agents: { entries: { 'agent-1': {}, 'agent-2': {} } } },
        path: '/openclaw.json',
      },
    }),
    patchConfig: vi.fn().mockResolvedValue({ ok: true, result: { ok: true, path: '/openclaw.json', config: {} } }),
    persistTeam: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

async function collect(gen: AsyncGenerator<InstallEvent>): Promise<InstallEvent[]> {
  const events: InstallEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe('installTeam', () => {
  it('installs a team successfully with no files', async () => {
    const parsed = makeParsed();
    const deps = makeDeps();
    const events = await collect(installTeam(parsed, {}, 'gw-1', '/workspace', deps));

    expect(deps.createAgent).toHaveBeenCalledTimes(2);
    expect(deps.persistTeam).toHaveBeenCalledTimes(1);

    const types = events.map((e) => e.type);
    expect(types).toContain('agent_creating');
    expect(types).toContain('agent_created');
    expect(types).toContain('team_persisting');
    expect(types).toContain('team_persisted');
    expect(types[types.length - 1]).toBe('done');

    const doneEvent = events.find((e) => e.type === 'done')!;
    expect(doneEvent.message).toBeTruthy();
  });

  it('sets agent files when provided', async () => {
    const parsed = makeParsed();
    const files: Record<string, AgentFileSet> = {
      manager: { agentMd: '# Manager', soulMd: '# Soul' },
    };
    const deps = makeDeps();
    const events = await collect(installTeam(parsed, files, 'gw-1', '/w', deps));

    expect(deps.setAgentFile).toHaveBeenCalledTimes(2);
    expect(deps.setAgentFile).toHaveBeenCalledWith('agent-1', 'IDENTITY.md', '# Manager');
    expect(deps.setAgentFile).toHaveBeenCalledWith('agent-1', 'SOUL.md', '# Soul');

    const types = events.map((e) => e.type);
    expect(types).toContain('file_setting');
    expect(types).toContain('file_set');
  });

  it('installs skills from skills.json', async () => {
    const parsed = makeParsed();
    const files: Record<string, AgentFileSet> = {
      dev: {
        skillsJson: JSON.stringify({
          version: 1,
          skills: { 'web-search': { source: 'ws', sourceType: 'clawhub' } },
        }),
      },
    };
    const deps = makeDeps();
    const events = await collect(installTeam(parsed, files, 'gw-1', '/w', deps));

    expect(deps.installSkill).toHaveBeenCalledTimes(1);
    expect(deps.installSkill).toHaveBeenCalledWith({ source: 'clawhub', slug: 'web-search' });

    const types = events.map((e) => e.type);
    expect(types).toContain('skill_installing');
    expect(types).toContain('skill_installed');
  });

  it('skips skills with unsupported sourceType', async () => {
    const parsed = makeParsed();
    const files: Record<string, AgentFileSet> = {
      dev: {
        skillsJson: JSON.stringify({
          version: 1,
          skills: { 'local-skill': { source: './path', sourceType: 'local' } },
        }),
      },
    };
    const deps = makeDeps();
    const events = await collect(installTeam(parsed, files, 'gw-1', '/w', deps));

    expect(deps.installSkill).not.toHaveBeenCalled();
    const warning = events.find((e) => e.type === 'warning' && e.skillId === 'local-skill');
    expect(warning).toBeTruthy();
    expect(warning!.message).toContain('unsupported sourceType');
  });

  it('warns on agent creation failure and continues', async () => {
    const parsed = makeParsed();
    const deps = makeDeps({
      createAgent: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, error: 'quota exceeded' })
        .mockResolvedValueOnce({ ok: true, result: { agentId: 'agent-2', name: 'dev', workspace: '/w' } }),
    });
    const events = await collect(installTeam(parsed, {}, 'gw-1', '/w', deps));

    const warnings = events.filter((e) => e.type === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('quota exceeded');

    const types = events.map((e) => e.type);
    expect(types).toContain('done');

    const persistCall = (deps.persistTeam as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(persistCall.agents).toHaveLength(1);
    expect(persistCall.agents[0].agentId).toBe('agent-2');
  });

  it('warns on skill install failure and continues', async () => {
    const parsed = makeParsed();
    const files: Record<string, AgentFileSet> = {
      dev: {
        skillsJson: JSON.stringify({
          version: 1,
          skills: { 'bad-skill': { source: 'x', sourceType: 'clawhub' } },
        }),
      },
    };
    const deps = makeDeps({
      installSkill: vi.fn().mockResolvedValue({ ok: false, error: 'not found' }),
    });
    const events = await collect(installTeam(parsed, files, 'gw-1', '/w', deps));

    const warning = events.find((e) => e.type === 'warning' && e.skillId === 'bad-skill');
    expect(warning).toBeTruthy();
    expect(warning!.message).toContain('not found');

    expect(events.map((e) => e.type)).toContain('done');
  });

  it('rolls back and errors when all agents fail', async () => {
    const parsed = makeParsed();
    const deps = makeDeps({
      createAgent: vi.fn().mockResolvedValue({ ok: false, error: 'fail' }),
    });
    const events = await collect(installTeam(parsed, {}, 'gw-1', '/w', deps));

    const types = events.map((e) => e.type);
    expect(types).toContain('error');
    expect(types).not.toContain('done');

    const errorEvent = events.find((e) => e.type === 'error')!;
    expect(errorEvent.message).toContain('No agents were created');
  });

  it('rolls back created agents when persist fails', async () => {
    const parsed = makeParsed();
    const deps = makeDeps({
      persistTeam: vi.fn().mockResolvedValue({ ok: false, error: 'db error' }),
    });
    const events = await collect(installTeam(parsed, {}, 'gw-1', '/w', deps));

    expect(deps.deleteAgent).toHaveBeenCalledTimes(2);
    expect(deps.deleteAgent).toHaveBeenCalledWith({ agentId: 'agent-1' });
    expect(deps.deleteAgent).toHaveBeenCalledWith({ agentId: 'agent-2' });

    const errorEvent = events.find((e) => e.type === 'error')!;
    expect(errorEvent.message).toContain('db error');
  });

  it('reinstall: reused agents still get files set', async () => {
    const parsed = makeParsed();
    const files: Record<string, AgentFileSet> = {
      manager: { agentMd: '# Manager Identity', soulMd: '# Manager Soul' },
      dev: { agentMd: '# Dev Identity' },
    };
    const deps = makeDeps({
      createAgent: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, result: { agentId: 'existing-1', name: 'Manager', workspace: '/w' } })
        .mockResolvedValueOnce({ ok: true, result: { agentId: 'existing-2', name: 'Developer', workspace: '/w' } }),
    });
    const events = await collect(installTeam(parsed, files, 'gw-1', '/w', deps));

    expect(deps.setAgentFile).toHaveBeenCalledWith('existing-1', 'IDENTITY.md', '# Manager Identity');
    expect(deps.setAgentFile).toHaveBeenCalledWith('existing-1', 'SOUL.md', '# Manager Soul');
    expect(deps.setAgentFile).toHaveBeenCalledWith('existing-2', 'IDENTITY.md', '# Dev Identity');
    expect(deps.setAgentFile).toHaveBeenCalledTimes(3);

    expect(deps.deleteAgent).not.toHaveBeenCalled();

    const persistCall = (deps.persistTeam as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(persistCall.agents).toHaveLength(2);
    expect(persistCall.agents[0].agentId).toBe('existing-1');
    expect(persistCall.agents[1].agentId).toBe('existing-2');

    expect(events.map((e) => e.type)).toContain('done');
  });

  it('persists skill bindings on team agents', async () => {
    const parsed = makeParsed();
    const files: Record<string, AgentFileSet> = {
      manager: {
        skillsJson: JSON.stringify({ version: 1, skills: { plan: { source: 'x', sourceType: 'clawhub' } } }),
      },
      dev: {
        skillsJson: JSON.stringify({
          version: 1,
          skills: {
            code: { source: 'x', sourceType: 'clawhub' },
            review: { source: 'x', sourceType: 'clawhub' },
          },
        }),
      },
    };
    const deps = makeDeps();

    await collect(installTeam(parsed, files, 'gw-1', '/w', deps));

    const persistCall = (deps.persistTeam as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(persistCall.agents).toEqual([
      { agentId: 'agent-1', role: 'coordinator', isManager: true, skills: ['plan'] },
      { agentId: 'agent-2', role: 'worker', isManager: false, skills: ['code', 'review'] },
    ]);
  });

  it('⭐ 给协调者配 subagent 白名单，形状必须是 agents.entries.<id>（不是 agents.list）', async () => {
    const parsed = makeParsed();
    const deps = makeDeps({
      getConfig: vi.fn().mockResolvedValue({
        ok: true,
        result: {
          raw: '{}',
          hash: 'config-hash',
          config: {
            agents: {
              entries: {
                'agent-1': { subagents: { allowAgents: ['existing-worker'] } },
                'existing-worker': {},
                'agent-2': {},
              },
            },
          },
          path: '/openclaw.json',
        },
      }),
    });

    await collect(installTeam(parsed, {}, 'gw-1', '/w', deps));

    expect(deps.getConfig).toHaveBeenCalledTimes(1);
    expect(deps.patchConfig).toHaveBeenCalledTimes(1);
    expect(deps.patchConfig).toHaveBeenCalledWith({
      baseHash: 'config-hash',
      raw: JSON.stringify({
        // ⚠️ 形状是 `agents.entries.<id>`（以 id 为键的对象）。老写法 `agents.list: [...]`
        //    会被随包运行时拒（`Unrecognized key: "list"`）—— 而旧测试断言的正是那个
        //    错形状，所以代码和测试一起绿、真机一起挂（2026-09-20 实机踩到）。
        agents: {
          entries: {
            'agent-1': { subagents: { allowAgents: ['existing-worker', 'agent-2'] } },
          },
        },
      }),
    });
  });

  it('rolls back and errors when subagent configuration fails', async () => {
    const parsed = makeParsed();
    const deps = makeDeps({
      patchConfig: vi.fn().mockResolvedValue({ ok: false, error: 'permission denied' }),
    });

    const events = await collect(installTeam(parsed, {}, 'gw-1', '/w', deps));

    expect(deps.deleteAgent).toHaveBeenCalledWith({ agentId: 'agent-1' });
    expect(deps.deleteAgent).toHaveBeenCalledWith({ agentId: 'agent-2' });
    expect(deps.persistTeam).not.toHaveBeenCalled();
    const errorEvent = events.find((e) => e.type === 'error')!;
    expect(errorEvent.message).toContain('Failed to configure subagents');
  });

  it('progress total includes file and skill operations', async () => {
    const parsed = makeParsed();
    const files: Record<string, AgentFileSet> = {
      manager: { agentMd: '# M' },
      dev: {
        agentMd: '# D',
        soulMd: '# S',
        skillsJson: JSON.stringify({ version: 1, skills: { s1: { source: 'x', sourceType: 'clawhub' } } }),
      },
    };
    const deps = makeDeps();
    const events = await collect(installTeam(parsed, files, 'gw-1', '/w', deps));

    const withProgress = events.filter((e) => e.progress);
    const totals = new Set(withProgress.map((e) => e.progress!.total));
    expect(totals.size).toBe(1);
    const total = [...totals][0];
    expect(total).toBe(2 + 1 + 2 + 1 + 1);
  });

  it('ALREADY EXISTS 当成功：连点两次也能装完，且不把已有助手列入回滚删除', async () => {
    const parsed = makeParsed();
    const deps = makeDeps({
      createAgent: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, error: 'AGENT "Manager" ALREADY EXISTS' })
        .mockResolvedValueOnce({ ok: true, result: { agentId: 'agent-2', name: 'dev', workspace: '/w' } }),
    });
    const events = await collect(installTeam(parsed, {}, 'gw-1', '/w', deps));

    expect(events.map((e) => e.type)).toContain('done');
    expect(events.filter((e) => e.type === 'warning')).toHaveLength(0);

    const persistCall = (deps.persistTeam as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(persistCall.agents.map((a: { agentId: string }) => a.agentId)).toEqual(['Manager', 'agent-2']);

    expect(deps.deleteAgent).not.toHaveBeenCalled();
  });

  it('ALREADY EXISTS 的助手在 persist 失败时也不删除（那是别人的助手）', async () => {
    const parsed = makeParsed();
    const deps = makeDeps({
      createAgent: vi.fn().mockResolvedValue({ ok: false, error: 'AGENT "Manager" ALREADY EXISTS' }),
      persistTeam: vi.fn().mockResolvedValue({ ok: false, error: 'db error' }),
    });
    await collect(installTeam(parsed, {}, 'gw-1', '/w', deps));
    expect(deps.deleteAgent).not.toHaveBeenCalled();
  });

  it('config changed ⇒ 再 GET 一次并用新 hash 重试 patch，第二次成功就算装完', async () => {
    const parsed = makeParsed();
    const getConfig = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        result: {
          raw: '{}',
          hash: 'h1',
          config: { agents: { entries: { 'agent-1': {}, 'agent-2': {} } } },
          path: '/openclaw.json',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          raw: '{}',
          hash: 'h2',
          config: { agents: { entries: { 'agent-1': {}, 'agent-2': {} } } },
          path: '/openclaw.json',
        },
      });
    const patchConfig = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: 'CONFIG CHANGED SINCE LAST LOAD; RE-RUN CONFIG.GET AND RETRY',
      })
      .mockResolvedValueOnce({ ok: true, result: { ok: true, path: '/openclaw.json', config: {} } });
    const deps = makeDeps({ getConfig, patchConfig });
    const events = await collect(installTeam(parsed, {}, 'gw-1', '/w', deps));

    expect(getConfig).toHaveBeenCalledTimes(2);
    expect(patchConfig).toHaveBeenCalledTimes(2);
    expect(patchConfig.mock.calls[1][0].baseHash).toBe('h2');
    expect(events.map((e) => e.type)).toContain('done');
    expect(deps.deleteAgent).not.toHaveBeenCalled();
  });

  it('config changed 重试仍失败 ⇒ 回滚', async () => {
    const parsed = makeParsed();
    const patchConfig = vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'CONFIG CHANGED SINCE LAST LOAD; RE-RUN CONFIG.GET AND RETRY' });
    const deps = makeDeps({ patchConfig });
    const events = await collect(installTeam(parsed, {}, 'gw-1', '/w', deps));

    expect(deps.getConfig).toHaveBeenCalledTimes(2);
    expect(patchConfig).toHaveBeenCalledTimes(2);
    expect(deps.deleteAgent).toHaveBeenCalledTimes(2);
    expect(events.find((e) => e.type === 'error')?.message).toContain('Failed to configure subagents');
  });

  it('回滚删除返回 ok:false ⇒ 必须留下 warning，不能静默残留助手', async () => {
    const deps = makeDeps({
      patchConfig: vi.fn().mockResolvedValue({ ok: false, error: 'permission denied' }),
      deleteAgent: vi.fn().mockResolvedValue({ ok: false, error: 'delete rejected' }),
    });

    const events = await collect(installTeam(makeParsed(), {}, 'gw-1', '/w', deps));

    expect(events.filter((event) => event.type === 'warning').map((event) => event.message)).toEqual([
      'Rollback: failed to delete agent agent-1: delete rejected',
      'Rollback: failed to delete agent agent-2: delete rejected',
    ]);
  });
});
