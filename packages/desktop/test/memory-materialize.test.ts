/**
 * 长期记忆 → `MEMORY.md` 的**投影与回读**（假网关 + 真文件语义）。
 *
 * 这一层要挡的假话是"写进文件就算记住了"：
 *   · 写进去的必须是**受管区块**，`MEMORY.md` 里用户/运行时自己的正文一个字不动；
 *   · 写完必须**回读**核对（`readback` 来自回读，不是我们内存里刚拼的那串）；
 *   · 读不出来 ⇒ **不写**（盲写会把一个本来有内容的文件覆盖成只剩我们这一块）；
 *   · 某个助手写失败 ⇒ 如实进 `failed`，不报"全部成功"。
 */
import { describe, expect, it, vi } from 'vitest';
import { memoryBlockEntryLines } from '@clawwork/core';
import { materializeMemory, type MemoryGatewayApi } from '../src/main/memory/materialize.js';

interface FakeFile {
  content: string;
  missing?: boolean;
}

/** 假网关：一份 `agentId → 文件` 的映射；可注入读/写失败。 */
function fakeGateway(initial: Record<string, FakeFile> = {}): {
  api: MemoryGatewayApi;
  files: Record<string, FakeFile>;
  writes: Array<{ agentId: string; name: string; content: string }>;
  failRead: Set<string>;
  failWrite: Set<string>;
} {
  const files: Record<string, FakeFile> = { ...initial };
  const writes: Array<{ agentId: string; name: string; content: string }> = [];
  const failRead = new Set<string>();
  const failWrite = new Set<string>();
  const api: MemoryGatewayApi = {
    async getAgentFile(agentId: string): Promise<unknown> {
      if (failRead.has(agentId)) throw new Error('gateway down');
      const file = files[agentId];
      return { file: { name: 'MEMORY.md', content: file?.content ?? '', missing: file?.missing ?? true } };
    },
    async setAgentFile(agentId: string, name: string, content: string): Promise<unknown> {
      if (failWrite.has(agentId)) throw new Error('read-only volume');
      writes.push({ agentId, name, content });
      files[agentId] = { content, missing: false };
      return { ok: true };
    },
  };
  return { api, files, writes, failRead, failWrite };
}

const AGENTS = ['main', 'agent-a'];

describe('记忆投影：写进 MEMORY.md 的受管区块', () => {
  it('⭐ 每个助手都写到了，且**用户自己在 MEMORY.md 里写的东西一个字不动**', async () => {
    const gateway = fakeGateway({
      main: { content: '# 我的笔记\n\n运行时自己攒的记忆。\n', missing: false },
      'agent-a': { content: '', missing: true },
    });

    const result = await materializeMemory({
      gateway: gateway.api,
      agentIds: AGENTS,
      entries: [{ text: '用户希望结论先行。' }, { text: '用户所在行业是电商。' }],
    });

    expect(result.written.sort()).toEqual([...AGENTS].sort());
    expect(result.failed).toEqual([]);
    for (const agentId of AGENTS) {
      expect(gateway.files[agentId].content).toContain('- 用户希望结论先行。');
      expect(gateway.files[agentId].content).toContain('- 用户所在行业是电商。');
    }
    // 用户 / 运行时的正文原样保留
    expect(gateway.files['main'].content).toContain('# 我的笔记');
    expect(gateway.files['main'].content).toContain('运行时自己攒的记忆。');
  });

  it('⭐ `readback` 是**回读**回来的内容（写成什么样，文件里就该是什么样）', async () => {
    const gateway = fakeGateway();
    const result = await materializeMemory({
      gateway: gateway.api,
      agentIds: AGENTS,
      entries: [{ text: '用户在做跨境电商。' }],
    });
    expect(result.readback['main']).toEqual(['用户在做跨境电商。']);
    expect(result.readback['agent-a']).toEqual(['用户在做跨境电商。']);
  });

  it('幂等：同一批记忆再投一次 ⇒ 全部 unchanged，**一次写都不发**', async () => {
    const gateway = fakeGateway();
    const entries = [{ text: '用户希望结论先行。' }];
    await materializeMemory({ gateway: gateway.api, agentIds: AGENTS, entries });
    const writesAfterFirst = gateway.writes.length;

    const second = await materializeMemory({ gateway: gateway.api, agentIds: AGENTS, entries });
    expect(second.written).toEqual([]);
    expect(second.unchanged.sort()).toEqual([...AGENTS].sort());
    expect(gateway.writes.length).toBe(writesAfterFirst);
  });

  it('⭐ 删掉一条后重投 ⇒ 区块里真的没有它了（"删除后不再召回"的文件侧）', async () => {
    const gateway = fakeGateway();
    await materializeMemory({
      gateway: gateway.api,
      agentIds: AGENTS,
      entries: [{ text: '留下这条' }, { text: '删掉这条' }],
    });
    expect(memoryBlockEntryLines(gateway.files['main'].content)).toEqual(['留下这条', '删掉这条']);

    await materializeMemory({ gateway: gateway.api, agentIds: AGENTS, entries: [{ text: '留下这条' }] });
    expect(memoryBlockEntryLines(gateway.files['main'].content)).toEqual(['留下这条']);
    expect(gateway.files['main'].content).not.toContain('删掉这条');
  });

  it('一条都没有时写的是"当前没有已确认的长期记忆"，不是一个空标题', async () => {
    const gateway = fakeGateway();
    await materializeMemory({ gateway: gateway.api, agentIds: AGENTS, entries: [] });
    expect(gateway.files['main'].content).toContain('当前没有已确认的长期记忆');
  });

  it('🔴 读失败 ⇒ **不写**那个助手（盲写会覆盖掉它本来的内容）', async () => {
    const gateway = fakeGateway({ main: { content: '原有的内容', missing: false } });
    gateway.failRead.add('main');

    const result = await materializeMemory({ gateway: gateway.api, agentIds: AGENTS, entries: [{ text: '一条记忆' }] });
    expect(result.failed).toEqual([{ agentId: 'main', error: 'gateway down' }]);
    expect(gateway.writes.map((w) => w.agentId)).toEqual(['agent-a']);
    expect(gateway.files['main'].content).toBe('原有的内容');
  });

  it('🔴 载荷形状不认识 ⇒ 同样当读失败，不写', async () => {
    const gateway = fakeGateway();
    const api: MemoryGatewayApi = {
      getAgentFile: async () => ({ content: '错位的字段' }),
      setAgentFile: gateway.api.setAgentFile,
    };
    const result = await materializeMemory({ gateway: api, agentIds: ['main'], entries: [{ text: '一条记忆' }] });
    expect(result.failed).toEqual([{ agentId: 'main', error: 'read unrecognized' }]);
    expect(result.written).toEqual([]);
  });

  it('⭐ 某个助手写失败 ⇒ 如实进 failed，**不报"全部成功"**', async () => {
    const gateway = fakeGateway();
    gateway.failWrite.add('agent-a');
    const result = await materializeMemory({ gateway: gateway.api, agentIds: AGENTS, entries: [{ text: '一条记忆' }] });
    expect(result.written).toEqual(['main']);
    expect(result.failed).toEqual([{ agentId: 'agent-a', error: 'read-only volume' }]);
    expect(result.readback['agent-a']).toBeUndefined();
  });

  it('助手名单为空 ⇒ 什么都不写（也不假装写成）', async () => {
    const gateway = fakeGateway();
    const result = await materializeMemory({ gateway: gateway.api, agentIds: [], entries: [{ text: '一条记忆' }] });
    expect(result.written).toEqual([]);
    expect(gateway.writes).toEqual([]);
    expect(result.block).toContain('一条记忆');
  });
});

describe('投影不吞异常：单个助手出错不影响其它助手', () => {
  it('读抛异常 + 另一个助手正常 ⇒ 正常那个照样写成', async () => {
    const gateway = fakeGateway();
    const original = gateway.api.getAgentFile;
    const spy = vi
      .spyOn(gateway.api, 'getAgentFile')
      .mockImplementation(async (agentId: string, name: string) =>
        agentId === 'main' ? Promise.reject(new Error('boom')) : original(agentId, name),
      );
    const result = await materializeMemory({ gateway: gateway.api, agentIds: AGENTS, entries: [{ text: '一条记忆' }] });
    spy.mockRestore();
    expect(result.failed).toEqual([{ agentId: 'main', error: 'boom' }]);
    expect(result.written).toEqual(['agent-a']);
  });
});
