/**
 * 「记忆草案契约」的注入（`AGENTS.md`）。
 *
 * ## 为什么这条必须有测试
 *
 * 没有这段契约，`collectMemoryDrafts` 那条路就是**有测试、没人触发**的死代码 ——
 * 助手根本不知道 ```` ```memory ```` 这个载体存在，草案永远为零。
 * 这个仓库为此付过代价（H4 那条"有测试、没人看"的死组件），所以契约的注入要有据可查：
 * 写进去的是什么、幂等不幂等、读不出来时会不会盲写。
 */
import { describe, expect, it } from 'vitest';
import { memoryContractBulletLines } from '@clawwork/core';
import { ensureMemoryContractPrompt, ensureMemoryContractPromptWithRetry } from '../src/main/memory/contract.js';
import type { MemoryGatewayApi } from '../src/main/memory/materialize.js';

function fakeGateway(initial: Record<string, string> = {}): {
  api: MemoryGatewayApi;
  files: Record<string, string>;
  failRead: Set<string>;
  failWrite: Set<string>;
} {
  const files = { ...initial };
  const failRead = new Set<string>();
  const failWrite = new Set<string>();
  return {
    files,
    failRead,
    failWrite,
    api: {
      async getAgentFile(agentId: string) {
        if (failRead.has(agentId)) throw new Error('gateway down');
        return { file: { name: 'AGENTS.md', content: files[agentId] ?? '', missing: files[agentId] === undefined } };
      },
      async setAgentFile(agentId: string, _name: string, content: string) {
        if (failWrite.has(agentId)) throw new Error('read-only');
        files[agentId] = content;
        return { ok: true };
      },
    },
  };
}

describe('记忆契约注入（AGENTS.md）', () => {
  it('写成：契约区块落在 main 的 AGENTS.md 上，正文原样保留', async () => {
    const gateway = fakeGateway({ main: '# 用户自己写的 AGENTS.md\n' });
    const outcome = await ensureMemoryContractPrompt(gateway.api);

    expect(outcome).toEqual({ status: 'written' });
    expect(gateway.files['main']).toContain('# 用户自己写的 AGENTS.md');
    expect(gateway.files['main']).toContain('partner-w-memory-contract:1:begin');
    expect(gateway.files['main']).toContain('不要对用户说"我记住了"');
    expect(memoryContractBulletLines(gateway.files['main']).length).toBeGreaterThan(0);
  });

  it('幂等：再投一次是 unchanged，**一次写都不发**', async () => {
    const gateway = fakeGateway();
    await ensureMemoryContractPrompt(gateway.api);
    const after = gateway.files['main'];
    expect(await ensureMemoryContractPrompt(gateway.api)).toEqual({ status: 'unchanged' });
    expect(gateway.files['main']).toBe(after);
  });

  it('旧版本的区块会被升级（否则永远升级不了）', async () => {
    const gateway = fakeGateway({
      main: '<!-- partner-w-memory-contract:0:begin -->\n很旧的契约\n<!-- partner-w-memory-contract:0:end -->',
    });
    expect(await ensureMemoryContractPrompt(gateway.api)).toEqual({ status: 'upgraded' });
    expect(gateway.files['main']).not.toContain('很旧的契约');
    expect(gateway.files['main']).toContain('partner-w-memory-contract:1:begin');
  });

  it('🔴 读失败 ⇒ failed，**不写**（盲写会覆盖掉用户自己的 AGENTS.md）', async () => {
    const gateway = fakeGateway({ main: '用户的内容' });
    gateway.failRead.add('main');
    expect(await ensureMemoryContractPrompt(gateway.api)).toEqual({ status: 'failed', reason: 'gateway down' });
    expect(gateway.files['main']).toBe('用户的内容');
  });

  it('🔴 载荷形状不认识 ⇒ failed，不写', async () => {
    const api: MemoryGatewayApi = {
      getAgentFile: async () => ({ content: '错位的字段' }),
      setAgentFile: async () => ({ ok: true }),
    };
    expect(await ensureMemoryContractPrompt(api)).toEqual({ status: 'failed', reason: 'read unrecognized' });
  });

  it('写失败 ⇒ failed，不吞', async () => {
    const gateway = fakeGateway();
    gateway.failWrite.add('main');
    expect(await ensureMemoryContractPrompt(gateway.api)).toEqual({ status: 'failed', reason: 'read-only' });
  });
});

describe('契约注入的重试包装', () => {
  it('第一次失败、第二次成功 ⇒ 跟着退避重试到成功', async () => {
    let attempts = 0;
    const api: MemoryGatewayApi = {
      async getAgentFile() {
        attempts += 1;
        if (attempts === 1) throw new Error('not ready');
        return { file: { content: '', missing: true } };
      },
      async setAgentFile() {
        return { ok: true };
      },
    };
    const slept: number[] = [];
    const outcome = await ensureMemoryContractPromptWithRetry(api, {
      delaysMs: [1, 2],
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(outcome).toEqual({ status: 'written' });
    expect(slept).toEqual([1]);
    expect(attempts).toBe(2);
  });

  it('一直失败 ⇒ 退避用尽后如实返回 failed（不假装写过）', async () => {
    const api: MemoryGatewayApi = {
      getAgentFile: async () => {
        throw new Error('down');
      },
      setAgentFile: async () => ({ ok: true }),
    };
    const slept: number[] = [];
    const outcome = await ensureMemoryContractPromptWithRetry(api, {
      delaysMs: [1, 2],
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(outcome).toEqual({ status: 'failed', reason: 'down' });
    expect(slept).toEqual([1, 2]);
  });
});
