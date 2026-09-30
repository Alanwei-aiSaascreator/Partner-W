import { describe, expect, it, vi, type Mocked } from 'vitest';
import { PRESET_AGENT_DEFINITIONS, PRESET_PROMPT_VERSION, stampPresetPrompt } from '../src/renderer/lib/preset-agents';
import { installPresetAgentPack, type PresetAgentInstallerApi } from '../src/renderer/lib/preset-agent-installer';

function createApi(): Mocked<PresetAgentInstallerApi> {
  return {
    listAgents: vi.fn<PresetAgentInstallerApi['listAgents']>().mockResolvedValue({
      ok: true,
      result: { defaultId: 'main', mainKey: 'main', scope: 'per-sender', agents: [] },
    }),
    createAgent: vi.fn<PresetAgentInstallerApi['createAgent']>(),
    updateAgent: vi.fn<PresetAgentInstallerApi['updateAgent']>().mockResolvedValue({ ok: true }),
    getAgentFile: vi
      .fn<PresetAgentInstallerApi['getAgentFile']>()
      .mockImplementation(async (_gatewayId, agentId, name) => ({
        ok: true,
        result: { agentId, file: { name, missing: false, content: '# existing\n' } },
      })),
    setAgentFile: vi.fn<PresetAgentInstallerApi['setAgentFile']>().mockResolvedValue({ ok: true }),
    deleteAgent: vi.fn<PresetAgentInstallerApi['deleteAgent']>().mockResolvedValue({ ok: true }),
  };
}

describe('installPresetAgentPack', () => {
  it('⭐ second startup verifies complete presets with zero mutations', async () => {
    const api = createApi();

    const result = await installPresetAgentPack({
      gatewayId: 'gw-1',
      workspaceRoot: 'E:/cube',
      currentAgentIds: ['main', 'rongying-content'],
      verifyExisting: true,
      definitions: PRESET_AGENT_DEFINITIONS.slice(0, 1),
      displayNames: { 'rongying-content': '内容创作' },
      api,
    });

    expect(result).toEqual({ installed: [], skipped: ['rongying-content'], failed: [] });
    expect(api.getAgentFile).toHaveBeenCalledTimes(2);
    expect(api.createAgent).not.toHaveBeenCalled();
    expect(api.updateAgent).not.toHaveBeenCalled();
    expect(api.setAgentFile).not.toHaveBeenCalled();
    expect(api.deleteAgent).not.toHaveBeenCalled();
  });

  it('陈旧目录触发 already exists 对账后，verifyExisting 仍会补齐缺失文件', async () => {
    const api = createApi();
    api.createAgent.mockResolvedValue({
      ok: false,
      error: 'agent "rongying-content" already exists',
    });
    api.listAgents.mockResolvedValue({
      ok: true,
      result: {
        defaultId: 'main',
        mainKey: 'main',
        scope: 'per-sender',
        agents: [{ id: 'rongying-content', name: '内容创作' }],
      },
    });
    api.getAgentFile.mockImplementation(async (_gatewayId, agentId, name) => ({
      ok: true,
      result: {
        agentId,
        file: name === 'SOUL.md' ? { name, missing: true, content: '' } : { name, missing: false, content: '# kept\n' },
      },
    }));

    const result = await installPresetAgentPack({
      gatewayId: 'gw-1',
      workspaceRoot: 'E:/cube',
      currentAgentIds: [],
      verifyExisting: true,
      definitions: PRESET_AGENT_DEFINITIONS.slice(0, 1),
      displayNames: { 'rongying-content': '内容创作' },
      api,
    });

    expect(result).toMatchObject({
      installed: ['rongying-content'],
      skipped: [],
      reconciled: ['rongying-content'],
      failed: [],
    });
    expect(api.getAgentFile).toHaveBeenCalledTimes(2);
    expect(api.setAgentFile).toHaveBeenCalledOnce();
    expect(api.setAgentFile).toHaveBeenCalledWith(
      'gw-1',
      'rongying-content',
      'SOUL.md',
      stampPresetPrompt(PRESET_AGENT_DEFINITIONS[0].soulMd),
    );
    expect(api.updateAgent).not.toHaveBeenCalled();
    expect(api.deleteAgent).not.toHaveBeenCalled();
  });

  it('skips existing roles and configures only missing roles', async () => {
    const api = createApi();
    api.createAgent.mockResolvedValue({
      ok: true,
      result: { agentId: 'rongying-video' },
    });

    const result = await installPresetAgentPack({
      gatewayId: 'gw-1',
      workspaceRoot: 'D:/cube',
      currentAgentIds: ['main', 'rongying-content'],
      verifyExisting: true,
      definitions: PRESET_AGENT_DEFINITIONS.slice(0, 2),
      displayNames: {
        'rongying-content': 'Content Creation',
        'rongying-video': 'Video Production',
      },
      api,
    });

    expect(result).toEqual({
      installed: ['rongying-video'],
      skipped: ['rongying-content'],
      failed: [],
    });
    expect(api.createAgent).toHaveBeenCalledOnce();
    expect(api.createAgent).toHaveBeenCalledWith('gw-1', {
      name: 'rongying-video',
      workspace: 'D:/cube/rongying-agents/rongying-video',
      emoji: '🎬',
    });
    expect(api.updateAgent).toHaveBeenCalledWith('gw-1', {
      agentId: 'rongying-video',
      name: 'Video Production',
    });
    expect(api.setAgentFile).toHaveBeenCalledTimes(2);
    expect(api.setAgentFile).toHaveBeenNthCalledWith(
      1,
      'gw-1',
      'rongying-video',
      'IDENTITY.md',
      stampPresetPrompt(PRESET_AGENT_DEFINITIONS[1].identityMd),
    );
    expect(api.setAgentFile).toHaveBeenNthCalledWith(
      2,
      'gw-1',
      'rongying-video',
      'SOUL.md',
      stampPresetPrompt(PRESET_AGENT_DEFINITIONS[1].soulMd),
    );
    expect(api.getAgentFile).toHaveBeenCalledTimes(2);
  });

  it('leaves an incomplete new role for idempotent repair instead of creating an exFAT deletion tombstone', async () => {
    const api = createApi();
    api.createAgent.mockResolvedValue({
      ok: true,
      result: { agentId: 'rongying-content' },
    });
    api.setAgentFile.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, error: 'write denied' });

    const result = await installPresetAgentPack({
      gatewayId: 'gw-1',
      workspaceRoot: 'D:/cube/',
      currentAgentIds: ['main'],
      preservePartialOnFailure: true,
      definitions: PRESET_AGENT_DEFINITIONS.slice(0, 1),
      displayNames: { 'rongying-content': 'Content Creation' },
      api,
    });

    expect(result.installed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([{ id: 'rongying-content', error: 'write denied' }]);
    expect(api.deleteAgent).not.toHaveBeenCalled();
  });

  it('⭐⭐ repairs a missing SOUL file without deleting, recreating, or rewriting an existing identity/name', async () => {
    const api = createApi();
    api.getAgentFile.mockImplementation(async (_gatewayId, agentId, name) => ({
      ok: true,
      result: {
        agentId,
        file: name === 'SOUL.md' ? { name, missing: true, content: '' } : { name, missing: false, content: '# kept\n' },
      },
    }));

    const result = await installPresetAgentPack({
      gatewayId: 'gw-1',
      workspaceRoot: 'E:/cube',
      currentAgentIds: ['main', 'rongying-content'],
      verifyExisting: true,
      definitions: PRESET_AGENT_DEFINITIONS.slice(0, 1),
      displayNames: { 'rongying-content': '内容创作' },
      api,
    });

    expect(result).toEqual({ installed: ['rongying-content'], skipped: [], failed: [] });
    expect(api.createAgent).not.toHaveBeenCalled();
    expect(api.deleteAgent).not.toHaveBeenCalled();
    expect(api.updateAgent).not.toHaveBeenCalled();
    expect(api.setAgentFile).toHaveBeenCalledOnce();
    expect(api.setAgentFile).toHaveBeenCalledWith(
      'gw-1',
      'rongying-content',
      'SOUL.md',
      stampPresetPrompt(PRESET_AGENT_DEFINITIONS[0].soulMd),
    );
  });

  it('⭐ repairs a stable-id display name while preserving two complete user-editable files', async () => {
    const api = createApi();

    const result = await installPresetAgentPack({
      gatewayId: 'gw-1',
      workspaceRoot: 'E:/cube',
      currentAgentIds: ['main', 'rongying-content'],
      repairAgentIds: ['rongying-content'],
      definitions: PRESET_AGENT_DEFINITIONS.slice(0, 1),
      displayNames: { 'rongying-content': '内容创作' },
      api,
    });

    expect(result).toEqual({ installed: ['rongying-content'], skipped: [], failed: [] });
    expect(api.createAgent).not.toHaveBeenCalled();
    expect(api.updateAgent).toHaveBeenCalledWith('gw-1', {
      agentId: 'rongying-content',
      name: '内容创作',
    });
    expect(api.setAgentFile).not.toHaveBeenCalled();
    expect(api.deleteAgent).not.toHaveBeenCalled();
  });

  /**
   * ⭐⭐ **提示词升级路**（2026-09-27）。
   *
   * 标记机制（`<!-- mofang-prompt:<版本> -->`）建好很久了，但安装器原先**只在文件缺失时写**
   * ⇒ 已发出去的盘**永远拿不到改过的提示词**。原话就写在 `preset-agents.ts` 里：
   * 「改一次提示词，改动只在"新装"的盘上生效，已发出去的盘永远不会变」。
   *
   * **实测代价**：交付合同里那句「内容装得下时优先用模板 —— 填格子更快」把助手送进了
   * **每格约 40 字**的模板；用户真机上整份被拒、产物里什么都没有。
   * 改掉那句话**只有新盘生效**，老盘照旧踩 —— 所以这条升级路不是锦上添花。
   *
   * ⚠️ 三条边界缺一不可：**我们的旧版 ⇒ 升** · **没标记 ⇒ 绝不碰**（用户改过）·
   *    **已是当前版 ⇒ 什么都不做**（幂等）。
   */
  describe('提示词升级路', () => {
    const withMarker = (version: string): string => `# SOUL\n\n<!-- mofang-prompt:${version} -->\n`;

    async function installWithExisting(content: string) {
      const api = createApi();
      api.getAgentFile.mockImplementation(async (_gatewayId, agentId, name) => ({
        ok: true,
        result: { agentId, file: { name, missing: false, content } },
      }));
      const result = await installPresetAgentPack({
        gatewayId: 'gw-1',
        workspaceRoot: 'E:/cube',
        currentAgentIds: ['rongying-content'],
        verifyExisting: true,
        definitions: PRESET_AGENT_DEFINITIONS.slice(0, 1),
        displayNames: { 'rongying-content': '内容创作' },
        api,
      });
      return { api, result };
    }

    it('⭐ 带**旧版本标记** ⇒ 覆盖成当前版（老盘终于升得上来了）', async () => {
      const { api, result } = await installWithExisting(withMarker('2020-01-01.1'));

      expect(api.setAgentFile, '旧版没被升级 —— 老盘会一直拿不到改过的提示词').toHaveBeenCalledTimes(2);
      expect(result.skipped).toEqual([]);
      // 覆盖后的正文必须盖**当前**版本号，否则下一轮还会被当成旧版、反复重写。
      expect(api.setAgentFile.mock.calls[0]?.[3] ?? '').toContain(`mofang-prompt:${PRESET_PROMPT_VERSION}`);
    });

    it('upgrades the preceding image-refusal contract to the capability-driven version', async () => {
      const { api, result } = await installWithExisting(withMarker('2026-09-30.1'));

      expect(result.installed).toEqual(['rongying-content']);
      expect(api.setAgentFile).toHaveBeenCalledWith(
        'gw-1',
        'rongying-content',
        'SOUL.md',
        expect.stringContaining('image_generate'),
      );
      const soul = api.setAgentFile.mock.calls.find((call) => call[2] === 'SOUL.md')?.[3] ?? '';
      expect(soul).toContain('mofang-prompt:2026-09-30.2');
      expect(soul).not.toMatch(/cannot\*{0,2} produce images/i);
    });

    it('⭐ **没有标记** ⇒ 一个字节都不碰（那是用户自己改过的）', async () => {
      // 这一条是标记机制存在的**全部理由**：分不清"我们写的旧版"和"用户改过的"，
      // 就只能选择不碰。少了它，用户的自定义会被每次开机悄悄抹掉。
      const { api, result } = await installWithExisting('# SOUL\n\n我改过的内容\n');

      expect(api.setAgentFile).not.toHaveBeenCalled();
      expect(result.skipped).toEqual(['rongying-content']);
    });

    it('标记已是**当前版** ⇒ 什么都不做（幂等，不然每次开机都重写一遍）', async () => {
      const { api, result } = await installWithExisting(withMarker(PRESET_PROMPT_VERSION));

      expect(api.setAgentFile).not.toHaveBeenCalled();
      expect(result.skipped).toEqual(['rongying-content']);
    });
  });
});
