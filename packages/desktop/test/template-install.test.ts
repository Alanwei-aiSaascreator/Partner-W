import { describe, expect, it, vi } from 'vitest';
import { templateToInstallDefinition } from '@clawwork/core';
import { installTemplate, type TemplateInstallDeps } from '../src/renderer/lib/template-install';
import type { AgentTemplateDetail } from '@clawwork/shared';

/**
 * 「真安装」的编排：**先在本地网关把助手真建出来，再去服务端记一笔**。
 *
 * 顺序是刻意的 —— 反过来的话，服务端记了账而本地没建成，用户会看到"已安装"
 * 却找不到助手。所以这里有一条断言专门钉"记账失败不许撤销本地"。
 */

const template: AgentTemplateDetail = {
  id: '3f2a1b4c-5d6e-7f80-9a0b-1c2d3e4f5a6b',
  name: '爆款内容教练',
  description: '从选题到成稿的内容工作流',
  category: 'content',
  emoji: '📣',
  isOfficial: true,
  authorName: '官方',
  installCount: 0,
  viewCount: 0,
  installedByMe: false,
  instructions: '你是内容创作教练。',
  isMine: false,
  status: 'published',
};

interface MutationResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

function makeApi(overrides: Record<string, unknown> = {}) {
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

function makeDeps(overrides: Partial<TemplateInstallDeps> = {}) {
  const api = makeApi();
  const refreshAgents = vi.fn(async () => {});
  const recordInstalled = vi.fn(async () => ({ ok: true }));
  const deps: TemplateInstallDeps = {
    gatewayId: 'gw-1',
    workspaceRoot: 'C:/ws',
    currentAgentIds: [],
    api,
    refreshAgents,
    recordInstalled,
    commonContract: '公共契约',
    probeWorkspaceFsIdentity: vi.fn(async () => ({ state: 'ok' as const, dev: '1', ino: '2' })),
    ...overrides,
  };
  return { deps, api, refreshAgents, recordInstalled };
}

/** 这个模板的 IDENTITY.md 正文（模板装出来的助手写的就是它）。 */
const TEMPLATE_IDENTITY = templateToInstallDefinition(template, '公共契约').identityMd;
/** 整 id 哈希前 12 位算出来的 slug（2026-10-07 起，不再是最初 8 个可读字符）。 */
const TEMPLATE_AGENT_ID = 'partner-w-tpl-88a1c42c9d74';

/** 让「既有助手」看起来正是这个模板装出来的：IDENTITY.md 正文逐字一致。 */
function matchingIdentityApi(overrides: Record<string, unknown> = {}) {
  return makeApi({
    getAgentFile: {
      ok: true,
      result: { file: { name: 'IDENTITY.md', missing: false, content: TEMPLATE_IDENTITY } },
    },
    ...overrides,
  });
}

describe('installTemplate —— 真安装的编排', () => {
  it('⭐ 成功：建 agent（带模板的提示词）→ 刷新目录 → 服务端记账', async () => {
    const { deps, api, refreshAgents, recordInstalled } = makeDeps();

    const outcome = await installTemplate(deps, template);

    expect(outcome.ok).toBe(true);
    expect(outcome.agentId).toBe(TEMPLATE_AGENT_ID);
    // 建出来的 agent 带着模板的提示词
    const identityWrite = api.calls.find((c) => c.fn === 'setAgentFile' && c.args[2] === 'IDENTITY.md');
    expect(String(identityWrite?.args[3])).toContain('你是内容创作教练。');
    // 显示名是模板名
    expect(api.calls.find((c) => c.fn === 'updateAgent')?.args[1]).toMatchObject({ name: '爆款内容教练' });
    expect(refreshAgents).toHaveBeenCalledOnce();
    expect(recordInstalled).toHaveBeenCalledWith(template.id);
  });

  it('⭐ 记账失败**只提示、不撤销本地**（助手已经建好了，用户要的结果已在）', async () => {
    // ⚠️ 断言必须打在**注入的那个** spy 上：makeDeps 返回的 recordInstalled 是默认实现
    const failingRecord = vi.fn(async () => ({ ok: false, errorCode: 'network' }));
    const { deps, api } = makeDeps({ recordInstalled: failingRecord });

    const outcome = await installTemplate(deps, template);

    expect(outcome.ok).toBe(true);
    expect(outcome.recordWarning).toBeTruthy();
    expect(failingRecord).toHaveBeenCalledOnce();
    expect(api.calls.some((c) => c.fn === 'deleteAgent')).toBe(false);
  });

  it('⭐ 本地建失败（写文件挂）⇒ 回滚、**不记账**、结果带中文原因', async () => {
    // 同上：把失败版 api 显式握住再注入，断言才打得到它
    const failingApi = makeApi({ setAgentFile: { ok: false, error: 'disk full' } });
    const { deps, recordInstalled, refreshAgents } = makeDeps({ api: failingApi });

    const outcome = await installTemplate(deps, template);

    expect(outcome.ok).toBe(false);
    expect(failingApi.calls.some((c) => c.fn === 'deleteAgent')).toBe(true);
    expect(recordInstalled).not.toHaveBeenCalled();
    expect(refreshAgents).not.toHaveBeenCalled();
    expect(outcome.message ?? '').toMatch(/[\u4e00-\u9fa5]/); // 中文，不是英文堆栈
  });

  it('⭐⭐ 建失败时主提示只给本地化结论，网关原文单独放进 diagnostic', async () => {
    const failingApi = makeApi({ createAgent: { ok: false, error: 'gateway not connected' } });
    const { deps } = makeDeps({ api: failingApi });

    const outcome = await installTemplate(deps, template);

    expect(outcome.ok).toBe(false);
    expect(outcome.message ?? '').toMatch(/[一-龥]/);
    expect(outcome.message ?? '').not.toContain('gateway not connected');
    expect(outcome.diagnostic).toContain('gateway not connected');
  });

  it('⭐ 已装过且正文一致（同 id 在网关里）⇒ 读回校对后跳过建、仍然记一次账', async () => {
    // ⚠️ 2026-10-07（质检 P2-1）：市场模板**不再"id 存在即跳过"** —— 跳过前必须读回
    //    IDENTITY.md 比对正文，所以这里的既有助手要装成"正是这个模板写的"。
    const api = matchingIdentityApi();
    const { deps, recordInstalled } = makeDeps({ api, currentAgentIds: [TEMPLATE_AGENT_ID] });

    const outcome = await installTemplate(deps, template);

    expect(outcome.ok).toBe(true);
    expect(outcome.alreadyInstalled).toBe(true);
    expect(outcome.agentId).toBe(TEMPLATE_AGENT_ID);
    expect(api.calls.map((call) => call.fn)).toEqual(['getAgentFile', 'getAgentFile']); // 校对读回，不建
    expect(recordInstalled).toHaveBeenCalledOnce();
  });

  it('⭐⭐ 同 id 的既有助手正文**不是**这个模板 ⇒ 明确报错、绝不复用、不记账（P2-1）', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const api = makeApi({
      getAgentFile: {
        ok: true,
        result: { file: { name: 'IDENTITY.md', missing: false, content: '# 别人的助手内容\n' } },
      },
    });
    const { deps, refreshAgents, recordInstalled } = makeDeps({ api, currentAgentIds: [TEMPLATE_AGENT_ID] });

    const outcome = await installTemplate(deps, template);

    expect(outcome.ok).toBe(false);
    expect(outcome.messageKey).toBe('market.error.assistantConflict');
    expect(outcome.diagnostic).toContain('template-agent-identity-mismatch');
    expect(api.calls.some((call) => call.fn === 'createAgent')).toBe(false);
    expect(api.calls.some((call) => call.fn === 'setAgentFile')).toBe(false); // 不覆盖用户文件
    expect(refreshAgents).not.toHaveBeenCalled();
    expect(recordInstalled).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('本地目录陈旧 + 网关报 already exists ⇒ 对账复用后强刷 UI 目录，并透传**网关里的真实 id**', async () => {
    // ⚠️ 网关里的 id 与定义 id 只差大小写（`reconcileAlreadyExistingAgent` 的规格化对账
    //    正是为这种目录陈旧准备的）——恒返回定义 id 会让「在罗盘助手中使用」落到
    //    "助手不在本机"（2026-10-07 质检 P3-4）。
    const gatewayAgentId = 'partner-w-TPL-88A1C42C9D74';
    const staleApi = matchingIdentityApi({
      createAgent: { ok: false, error: `agent "${gatewayAgentId}" already exists` },
      listAgents: {
        ok: true,
        result: {
          defaultId: 'main',
          mainKey: 'main',
          scope: 'per-sender',
          agents: [{ id: gatewayAgentId, name: '爆款内容教练' }],
        },
      },
    });
    const { deps, refreshAgents, recordInstalled } = makeDeps({ api: staleApi, currentAgentIds: [] });

    const outcome = await installTemplate(deps, template);

    expect(outcome).toMatchObject({
      ok: true,
      agentId: gatewayAgentId,
      alreadyInstalled: true,
    });
    expect(refreshAgents).toHaveBeenCalledOnce();
    expect(recordInstalled).toHaveBeenCalledOnce();
    expect(staleApi.calls.map((call) => call.fn)).toEqual([
      'createAgent',
      'listAgents',
      'getAgentFile',
      'getAgentFile',
    ]);
  });

  /**
   * ⚠️ 2026-09-20 U 盘交付实机：工作区没解析出来时，这里原来是
   *    `(await getWorkspacePath()) ?? ''` ⇒ 空串被一路拼成 `/partner-w-agents/<id>`
   *    ⇒ 每个助手都建失败，界面只剩一句英文。⇒ 现在必须在**发请求之前**拒绝。
   */
  it('⭐ 工作区还没就绪（空 / 相对）⇒ 直接拒绝，一次网关调用都不发', async () => {
    for (const bad of ['', '   ', null, 'lonely-team']) {
      const { deps, api, recordInstalled, refreshAgents } = makeDeps({ workspaceRoot: bad });
      const outcome = await installTemplate(deps, template);

      expect(outcome.ok).toBe(false);
      expect(outcome.message ?? '').toMatch(/[一-龥]/);
      expect(api.calls).toHaveLength(0);
      expect(refreshAgents).not.toHaveBeenCalled();
      expect(recordInstalled).not.toHaveBeenCalled();
    }
  });

  it('⭐ 工作区文件系统不支持 ⇒ 创建助手前拒绝，零网关写入', async () => {
    const { deps, api, recordInstalled } = makeDeps({
      probeWorkspaceFsIdentity: vi.fn(async () => ({
        state: 'unsupported-identity' as const,
        dev: null,
        ino: null,
        error: 'unsupported filesystem: exFAT',
      })),
    });

    const outcome = await installTemplate(deps, template);

    expect(outcome.ok).toBe(false);
    expect(api.calls).toHaveLength(0);
    expect(recordInstalled).not.toHaveBeenCalled();
  });

  it('拿不到网关 id ⇒ 直接拒绝（不发任何请求）', async () => {
    const { deps, recordInstalled } = makeDeps({ gatewayId: '' });
    const outcome = await installTemplate(deps, template);
    expect(outcome.ok).toBe(false);
    expect(outcome.message ?? '').toMatch(/[\u4e00-\u9fa5]/);
    expect(outcome.messageKey).toBe('market.error.noGateway');
    expect(recordInstalled).not.toHaveBeenCalled();
  });

  /**
   * ⭐ 2026-10-07（质检 P1-2）：失败文案要**成对**给出 —— i18n 键给 UI（9 语言），
   *    中文回落给没有 `t()` 的调用方；两条都不许出现机器码/英文原文。
   */
  it('⭐ 失败 = i18n 键 + 中文回落成对（坏工作区 / 未连网关各走各的键）', async () => {
    const noGateway = await installTemplate(makeDeps({ gatewayId: '' }).deps, template);
    expect(noGateway).toMatchObject({ ok: false, messageKey: 'market.error.noGateway' });
    expect(noGateway.message ?? '').toMatch(/[一-龥]/);

    const unavailable = await installTemplate(makeDeps({ workspaceRoot: null }).deps, template);
    expect(unavailable.messageKey).toBe('market.error.workspaceUnavailable');
    expect(unavailable.message ?? '').toMatch(/[一-龥]/);

    const unsupported = await installTemplate(
      makeDeps({
        probeWorkspaceFsIdentity: vi.fn(async () => ({
          state: 'unsupported-identity' as const,
          dev: null,
          ino: null,
          error: 'unsupported filesystem: exFAT',
        })),
      }).deps,
      template,
    );
    expect(unsupported.messageKey).toBe('market.error.workspaceUnsupported');
    expect(unsupported.message ?? '').not.toContain('exFAT');
  });
});
