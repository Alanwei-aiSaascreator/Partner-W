import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (buf: Buffer) => buf.toString(),
  },
}));

import {
  CAPABILITY_BOUNDARY_FILE,
  ensureCapabilityBoundaryPrompt,
  ensureCapabilityBoundaryPromptWithRetry,
  type CapabilityBoundaryGateway,
} from '../src/main/capability/capability-boundary-prompt';
import { CAPABILITY_BOUNDARY_PROMPT_VERSION } from '@clawwork/core';

/**
 * BUG-043 · 能力边界的**注入端**（主进程 → 网关 RPC → main 助手的 AGENTS.md）。
 *
 * 主流程（`main/index.ts`）在网关起来后调用它；这里钉住的都是"写错了会伤到用户"的点：
 *   · 读不到文件 ⇒ **不写**（不把"读不到"当"不存在"）；
 *   · 已有我们的区块 ⇒ 只换区块、幂等；
 *   · 用户自己写的 AGENTS.md ⇒ 原文一字不动、只在末尾追加我们的区块；
 *   · 目录/网关不可用 ⇒ 不阻塞启动、如实降级（只写规则、不伪造模型名）。
 */
const MODELS_PAYLOAD = {
  models: [
    { id: 'qwen3.7-flash', provider: 'clawrouter', input: ['text', 'image'] },
    { id: 'deepseek-v4-flash', provider: 'clawrouter', input: ['text'] },
    { id: 'claude-opus-4', provider: 'anthropic', input: ['text'] },
  ],
};

function fakeGateway(overrides: Partial<CapabilityBoundaryGateway> = {}) {
  const base = {
    listModels: vi.fn(async () => MODELS_PAYLOAD),
    getAgentFile: vi.fn(async () => ({ file: { name: CAPABILITY_BOUNDARY_FILE, missing: true } })),
    setAgentFile: vi.fn(async () => ({ ok: true })),
  };
  // 覆盖项是 vi.fn（Mock），接口签名是普通方法 —— 交叉类型把两侧都保留：
  // 调用点既要能过 `CapabilityBoundaryGateway`，也要能摸到 `.mock.calls`。
  return { ...base, ...overrides } as typeof base & CapabilityBoundaryGateway;
}

describe('能力边界注入（AGENTS.md）', () => {
  it('文件缺失 ⇒ 写入带标记的区块，且只列本服务目录里的模型', async () => {
    const gateway = fakeGateway();
    const outcome = await ensureCapabilityBoundaryPrompt(gateway);

    expect(outcome.status).toBe('written');
    expect(gateway.setAgentFile).toHaveBeenCalledOnce();
    const [agentId, name, content] = gateway.setAgentFile.mock.calls[0] as unknown as [string, string, string];
    expect(agentId).toBe('main');
    expect(name).toBe('AGENTS.md');
    expect(content).toContain(`mofang-capability-boundary:${CAPABILITY_BOUNDARY_PROMPT_VERSION}:begin`);
    expect(content).toContain('当前暂不支持该模型或能力');
    expect(content).toContain('qwen3.7-flash');
    // 网关全量目录里的非本服务模型（claude）不许混进"可用模型"清单。
    expect(content).not.toContain('claude-opus-4');
  });

  it('已是当前版本 ⇒ 一个字节都不写（幂等）', async () => {
    const first = fakeGateway();
    await ensureCapabilityBoundaryPrompt(first);
    const written = (first.setAgentFile.mock.calls[0] as unknown as [string, string, string])[2];

    const second = fakeGateway({
      getAgentFile: vi.fn(async () => ({ file: { name: 'AGENTS.md', missing: false, content: written } })),
    });
    const outcome = await ensureCapabilityBoundaryPrompt(second);
    expect(outcome.status).toBe('unchanged');
    expect(second.setAgentFile).not.toHaveBeenCalled();
  });

  it('用户自己写的 AGENTS.md（没有我们的标记）⇒ 原文一字不动，只追加区块', async () => {
    const original = '# AGENTS.md\n\n我们的团队约定：先复述需求再动手。\n';
    const gateway = fakeGateway({
      getAgentFile: vi.fn(async () => ({ file: { name: 'AGENTS.md', missing: false, content: original } })),
    });
    const outcome = await ensureCapabilityBoundaryPrompt(gateway);

    expect(outcome.status).toBe('upgraded');
    const content = (gateway.setAgentFile.mock.calls[0] as unknown as [string, string, string])[2];
    expect(content.startsWith(original)).toBe(true);
    expect(content).toContain('我们的团队约定：先复述需求再动手。');
    expect(content).toContain(`mofang-capability-boundary:${CAPABILITY_BOUNDARY_PROMPT_VERSION}:end`);
  });

  it('读不出来（RPC 报错 / 形状不认识）⇒ 一律不写，如实 failed', async () => {
    const throwing = fakeGateway({
      getAgentFile: vi.fn(async () => {
        throw new Error('gateway not connected');
      }),
    });
    expect((await ensureCapabilityBoundaryPrompt(throwing)).status).toBe('failed');
    expect(throwing.setAgentFile).not.toHaveBeenCalled();

    const weird = fakeGateway({ getAgentFile: vi.fn(async () => ({ unexpected: true })) });
    const outcome = await ensureCapabilityBoundaryPrompt(weird);
    expect(outcome.status).toBe('failed');
    expect(weird.setAgentFile).not.toHaveBeenCalled();
  });

  it('网关目录拉不到 ⇒ 降级写规则（不伪造模型名、不抛）', async () => {
    const gateway = fakeGateway({
      listModels: vi.fn(async () => {
        throw new Error('models.list failed');
      }),
    });
    const outcome = await ensureCapabilityBoundaryPrompt(gateway);
    expect(outcome.status).toBe('written');
    const content = (gateway.setAgentFile.mock.calls[0] as unknown as [string, string, string])[2];
    expect(content).toContain('当前暂不支持该模型或能力');
    expect(content).not.toContain('qwen3.7-flash');
  });

  it('网关还没连上时按退避重试，连上后成功（启动链不阻塞、不抛）', async () => {
    let attempt = 0;
    const gateway = fakeGateway({
      getAgentFile: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('not connected');
        return { file: { name: 'AGENTS.md', missing: true } };
      }),
    });
    const sleeps: number[] = [];
    const outcome = await ensureCapabilityBoundaryPromptWithRetry(gateway, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      delaysMs: [2000, 5000],
    });
    expect(outcome.status).toBe('written');
    expect(sleeps).toEqual([2000]);
    expect(attempt).toBe(2);
  });

  it('重试到底仍失败 ⇒ 返回 failed（调用方只记日志，永不抛）', async () => {
    const gateway = fakeGateway({
      getAgentFile: vi.fn(async () => {
        throw new Error('never');
      }),
    });
    const outcome = await ensureCapabilityBoundaryPromptWithRetry(gateway, {
      sleep: async () => {},
      delaysMs: [1, 1],
    });
    expect(outcome.status).toBe('failed');
  });
});
