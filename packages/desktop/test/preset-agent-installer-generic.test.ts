import { describe, expect, it } from 'vitest';
import { installPresetAgentPack } from '../src/renderer/lib/preset-agent-installer';
import { PRESET_AGENT_DEFINITIONS } from '../src/renderer/lib/preset-agents';

/**
 * 助手市场的"真安装"要复用 `installPresetAgentPack`（它本来就是幂等 + 多文件 + 回滚）。
 * 本文件钉住三件事：
 *   ① 注入**自定义定义**（模板生成的那种）能正常装、跳过、回滚；
 *   ② 六个预置助手（默认定义）的行为**一字不变** —— 启动准备那条链每天在跑；
 *   ③ 市场模板的"跳过"必须**先读回 IDENTITY.md 比对正文**（2026-10-07 质检 P2-1）——
 *      对不上就明确报错，绝不把别人的助手当本模板复用。
 */

interface MutationResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface Recorder {
  calls: Array<{ fn: string; args: unknown[] }>;
  listAgents: (...args: unknown[]) => Promise<MutationResult>;
  createAgent: (...args: unknown[]) => Promise<MutationResult>;
  updateAgent: (...args: unknown[]) => Promise<MutationResult>;
  getAgentFile: (...args: unknown[]) => Promise<MutationResult>;
  setAgentFile: (...args: unknown[]) => Promise<MutationResult>;
  deleteAgent: (...args: unknown[]) => Promise<MutationResult>;
}

function makeApi(overrides: Record<string, unknown> = {}): Recorder {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const rec =
    (fn: string) =>
    async (...args: unknown[]): Promise<MutationResult> => {
      calls.push({ fn, args });
      if (overrides[fn]) return overrides[fn] as MutationResult;
      if (fn === 'createAgent') {
        const params = args[1] as { name: string };
        return { ok: true, result: { agentId: params.name } };
      }
      if (fn === 'getAgentFile') {
        return {
          ok: true,
          result: { agentId: args[1], file: { name: args[2], missing: false, content: '# existing\n' } },
        };
      }
      return { ok: true, result: {} };
    };
  return {
    calls,
    listAgents: rec('listAgents'),
    createAgent: rec('createAgent'),
    updateAgent: rec('updateAgent'),
    getAgentFile: rec('getAgentFile'),
    setAgentFile: rec('setAgentFile'),
    deleteAgent: rec('deleteAgent'),
  };
}

const templateDef = {
  id: 'partner-w-tpl-3f2a1b4c',
  creationName: 'partner-w-tpl-3f2a1b4c',
  emoji: '📣',
  identityMd: 'IDENTITY',
  soulMd: 'SOUL',
};

describe('installPresetAgentPack —— 可注入自定义定义（助手市场用）', () => {
  it('⭐ 用模板定义安装：create → updateAgent(显示名) → 两个文件', async () => {
    const api = makeApi();
    const res = await installPresetAgentPack({
      gatewayId: 'gw',
      workspaceRoot: 'C:/ws',
      currentAgentIds: [],
      displayNames: { 'partner-w-tpl-3f2a1b4c': '爆款内容教练' },
      definitions: [templateDef],
      api,
    });

    expect(res.installed).toEqual(['partner-w-tpl-3f2a1b4c']);
    expect(api.calls.map((c) => c.fn)).toEqual(['createAgent', 'updateAgent', 'setAgentFile', 'setAgentFile']);
    expect(api.calls[1]?.args[1]).toMatchObject({ name: '爆款内容教练' });
    expect(api.calls[2]?.args.slice(2)).toEqual(['IDENTITY.md', 'IDENTITY']);
    expect(api.calls[3]?.args.slice(2)).toEqual(['SOUL.md', 'SOUL']);
  });

  it('⭐ 已存在同 id 且正文一致 ⇒ 读回比对后跳过（幂等）', async () => {
    // ⚠️ 2026-10-07（质检 P2-1）：市场模板**不再"id 存在即跳过"** —— 跳过前要读回
    //    IDENTITY.md 比对正文（对不上就见下一个用例：明确报错、不复用）。
    const api = makeApi({
      getAgentFile: {
        ok: true,
        result: { file: { name: 'IDENTITY.md', missing: false, content: 'IDENTITY' } },
      },
    });
    const res = await installPresetAgentPack({
      gatewayId: 'gw',
      workspaceRoot: 'C:/ws',
      currentAgentIds: ['partner-w-tpl-3f2a1b4c'],
      displayNames: {},
      definitions: [templateDef],
      api,
    });

    expect(res.skipped).toEqual(['partner-w-tpl-3f2a1b4c']);
    expect(res.installed).toEqual([]);
    expect(api.calls.map((call) => call.fn)).toEqual(['getAgentFile', 'getAgentFile']);
  });

  it('⭐⭐ 已存在同 id 但正文不是这个模板 ⇒ 明确报错、绝不复用、不覆盖（P2-1）', async () => {
    const api = makeApi(); // 默认 getAgentFile 回 '# existing\n'（≠ templateDef.identityMd）
    const res = await installPresetAgentPack({
      gatewayId: 'gw',
      workspaceRoot: 'C:/ws',
      currentAgentIds: ['partner-w-tpl-3f2a1b4c'],
      displayNames: {},
      definitions: [templateDef],
      api,
    });

    expect(res.installed).toEqual([]);
    expect(res.skipped).toEqual([]);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]?.error).toContain('template-agent-identity-mismatch');
    expect(api.calls.some((call) => call.fn === 'setAgentFile' || call.fn === 'deleteAgent')).toBe(false);
  });

  it('⭐ 本地目录陈旧 + 网关报 already exists ⇒ 强制查目录并复用精确 id', async () => {
    const api = makeApi({
      createAgent: { ok: false, error: 'agent "partner-w-tpl-3f2a1b4c" already exists' },
      listAgents: {
        ok: true,
        result: {
          defaultId: 'main',
          mainKey: 'main',
          scope: 'per-sender',
          agents: [{ id: 'partner-w-tpl-3f2a1b4c', name: '爆款内容教练' }],
        },
      },
      getAgentFile: {
        ok: true,
        result: { file: { name: 'IDENTITY.md', missing: false, content: 'IDENTITY' } },
      },
    });

    const res = await installPresetAgentPack({
      gatewayId: 'gw',
      workspaceRoot: 'C:/ws',
      currentAgentIds: [],
      displayNames: {},
      definitions: [templateDef],
      api,
    });

    expect(res).toMatchObject({
      installed: [],
      skipped: ['partner-w-tpl-3f2a1b4c'],
      reconciled: [{ id: 'partner-w-tpl-3f2a1b4c', agentId: 'partner-w-tpl-3f2a1b4c' }],
      failed: [],
    });
    expect(api.calls.map((call) => call.fn)).toEqual(['createAgent', 'listAgents', 'getAgentFile', 'getAgentFile']);
  });

  it('已存在冲突只有一个归一化 id 候选 ⇒ 安全复用', async () => {
    const api = makeApi({
      createAgent: { ok: false, error: 'agent "partner-w-tpl-3f2a1b4c" already exists' },
      listAgents: {
        ok: true,
        result: {
          defaultId: 'main',
          mainKey: 'main',
          scope: 'per-sender',
          agents: [{ id: 'partner-w-TPL-3F2A1B4C' }],
        },
      },
      getAgentFile: {
        ok: true,
        result: { file: { name: 'IDENTITY.md', missing: false, content: 'IDENTITY' } },
      },
    });

    const res = await installPresetAgentPack({
      gatewayId: 'gw',
      workspaceRoot: 'C:/ws',
      currentAgentIds: [],
      displayNames: {},
      definitions: [templateDef],
      api,
    });

    expect(res.failed).toEqual([]);
    expect(res.skipped).toEqual(['partner-w-tpl-3f2a1b4c']);
    // ⭐ 复用**网关里的真实 id**（大小写不同）——市场链拿它去切助手（质检 P3-4）
    expect(res.reconciled).toEqual([{ id: 'partner-w-tpl-3f2a1b4c', agentId: 'partner-w-TPL-3F2A1B4C' }]);
    expect(api.calls.map((call) => call.fn)).toEqual(['createAgent', 'listAgents', 'getAgentFile', 'getAgentFile']);
  });

  it('已存在冲突有多个归一化 id 候选 ⇒ 拒绝猜测，不写文件也不回滚', async () => {
    const api = makeApi({
      createAgent: { ok: false, error: 'agent "partner-w-tpl-3f2a1b4c" already exists' },
      listAgents: {
        ok: true,
        result: {
          defaultId: 'main',
          mainKey: 'main',
          scope: 'per-sender',
          agents: [{ id: 'partner-w-TPL-3F2A1B4C' }, { id: 'partner-w-Tpl-3f2a1b4c' }],
        },
      },
    });

    const res = await installPresetAgentPack({
      gatewayId: 'gw',
      workspaceRoot: 'C:/ws',
      currentAgentIds: [],
      displayNames: {},
      definitions: [templateDef],
      api,
    });

    expect(res.failed).toHaveLength(1);
    expect(res.skipped).toEqual([]);
    expect(api.calls.map((call) => call.fn)).toEqual(['createAgent', 'listAgents']);
    expect(api.calls.some((call) => call.fn === 'setAgentFile' || call.fn === 'deleteAgent')).toBe(false);
  });

  it('⭐ 写文件失败 ⇒ 回滚删掉刚建的 agent（不留半成品）', async () => {
    const api = makeApi({ setAgentFile: { ok: false, error: 'disk full' } });
    const res = await installPresetAgentPack({
      gatewayId: 'gw',
      workspaceRoot: 'C:/ws',
      currentAgentIds: [],
      displayNames: {},
      definitions: [templateDef],
      api,
    });

    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]?.id).toBe('partner-w-tpl-3f2a1b4c');
    expect(api.calls.some((c) => c.fn === 'deleteAgent')).toBe(true);
    expect(api.calls.find((c) => c.fn === 'deleteAgent')?.args[1]).toMatchObject({
      agentId: 'partner-w-tpl-3f2a1b4c',
      deleteFiles: true,
    });
  });

  it('⭐ 默认定义（六个预置助手）行为不变', async () => {
    const api = makeApi();
    const res = await installPresetAgentPack({
      gatewayId: 'gw',
      workspaceRoot: 'C:/ws',
      currentAgentIds: [],
      displayNames: {},
      api,
    });

    expect(res.installed).toHaveLength(PRESET_AGENT_DEFINITIONS.length);
    expect(api.calls.filter((c) => c.fn === 'createAgent')).toHaveLength(PRESET_AGENT_DEFINITIONS.length);
    // 每个助手两个文件（IDENTITY.md + SOUL.md）
    expect(api.calls.filter((c) => c.fn === 'setAgentFile')).toHaveLength(PRESET_AGENT_DEFINITIONS.length * 2);
  });
});
