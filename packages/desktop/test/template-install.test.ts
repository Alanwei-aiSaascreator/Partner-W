import { describe, expect, it, vi } from 'vitest';
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
      return { ok: true, result: {} };
    };
  return {
    calls,
    createAgent: rec('createAgent'),
    updateAgent: rec('updateAgent'),
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
    ...overrides,
  };
  return { deps, api, refreshAgents, recordInstalled };
}

describe('installTemplate —— 真安装的编排', () => {
  it('⭐ 成功：建 agent（带模板的提示词）→ 刷新目录 → 服务端记账', async () => {
    const { deps, api, refreshAgents, recordInstalled } = makeDeps();

    const outcome = await installTemplate(deps, template);

    expect(outcome.ok).toBe(true);
    expect(outcome.agentId).toBe('rongying-tpl-3f2a1b4c');
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

  /**
   * ⭐⭐ 2026-09-20 U 盘交付实机（T-a28，用户原话「市场的哪些 prompt 都安装不了」）：
   *
   * 走到这个分支时，用户**永远**只看到「操作没成功，请稍后重试。」—— 因为那一行**写死了**
   * `describeTemplateError('unknown')`：网关怎么解释（`agent creation failed: …`）都被丢掉，
   * 界面上没有原文 ⇒ 用户无从下手，我们也无法远程定位。
   * ⇒ 断言：**结论仍是中文**（用户先看到能读的那句），但**原文必须跟着出来**。
   *
   * ⚠️ 这条与上面那条「不是英文堆栈」并不冲突：中文结论在前，原文是**证据**不是堆栈。
   */
  it('⭐⭐ 建失败时要把**网关原文**带出来（不许再拿一句"请稍后重试"糊掉）', async () => {
    const failingApi = makeApi({ createAgent: { ok: false, error: 'gateway not connected' } });
    const { deps } = makeDeps({ api: failingApi });

    const outcome = await installTemplate(deps, template);

    expect(outcome.ok).toBe(false);
    expect(outcome.message ?? '').toMatch(/[一-龥]/); // 结论仍是中文（与上一条同口径）
    expect(outcome.message ?? '').toContain('gateway not connected'); // 原文必须带出来
  });

  it('⭐ 已装过（同 id 在网关里）⇒ 跳过建、仍然记一次账（跨机器状态最终一致）', async () => {
    const { deps, api, recordInstalled } = makeDeps({ currentAgentIds: ['rongying-tpl-3f2a1b4c'] });

    const outcome = await installTemplate(deps, template);

    expect(outcome.ok).toBe(true);
    expect(outcome.alreadyInstalled).toBe(true);
    expect(api.calls).toHaveLength(0);
    expect(recordInstalled).toHaveBeenCalledOnce();
  });

  /**
   * ⚠️ 2026-09-20 U 盘交付实机：工作区没解析出来时，这里原来是
   *    `(await getWorkspacePath()) ?? ''` ⇒ 空串被一路拼成 `/rongying-agents/<id>`
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

  it('拿不到网关 id ⇒ 直接拒绝（不发任何请求）', async () => {
    const { deps, recordInstalled } = makeDeps({ gatewayId: '' });
    const outcome = await installTemplate(deps, template);
    expect(outcome.ok).toBe(false);
    expect(outcome.message ?? '').toMatch(/[\u4e00-\u9fa5]/);
    expect(recordInstalled).not.toHaveBeenCalled();
  });
});
