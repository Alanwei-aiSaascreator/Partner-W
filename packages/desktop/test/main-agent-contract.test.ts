import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  COMMON_OPERATING_CONTRACT,
  MAIN_AGENT_ID,
  MAIN_AGENT_PROMPT_FILES,
  PRESET_PROMPT_VERSION,
} from '../src/renderer/lib/preset-agents';
import {
  ensureMainAgentContract,
  ensureMainAgentContractWithRetry,
  type MainAgentContractApi,
} from '../src/renderer/lib/main-agent-contract';

/**
 * **主罗盘（gateway agent `main`）的交付合同**。
 *
 * 为什么值得单开一个文件：六个预置助手各有一份 IDENTITY.md + SOUL.md（运行时**每轮全文注入**），
 * 而工作台的**默认助手**主罗盘什么都没有 —— 于是"同一产品、两个入口、两套行为"：
 * 用户从默认入口发起的任务拿不到交付合同，演示走错路、"已生成"式谎报的坑在这里没有护栏。
 *
 * 这个文件钉三件事：①合同内容真的到位（含演示硬约束）；②写入是**幂等**的、
 * 且**绝不覆盖用户手改过的文件**（与预置助手同一套版本标记语义）；
 * ③启动链**真的会调它**（源码栅栏 —— 删掉接线不会有别的测试变红）。
 */

interface StubWrite {
  agentId: string;
  name: string;
  content: string;
}

function createStubApi(initial: Record<string, string> = {}): {
  api: MainAgentContractApi;
  files: Map<string, string>;
  writes: StubWrite[];
} {
  const files = new Map<string, string>(Object.entries(initial));
  const writes: StubWrite[] = [];
  const api: MainAgentContractApi = {
    getAgentFile: vi.fn(async (_gatewayId: string, agentId: string, name: string) => {
      const content = files.get(name);
      return {
        ok: true,
        result: {
          agentId,
          file: content === undefined ? { name, missing: true, content: '' } : { name, missing: false, content },
        },
      };
    }),
    setAgentFile: vi.fn(async (_gatewayId: string, agentId: string, name: string, content: string) => {
      files.set(name, content);
      writes.push({ agentId, name, content });
      return { ok: true };
    }),
  };
  return { api, files, writes };
}

describe('主罗盘交付合同：内容与文件名', () => {
  it('只写运行时白名单里的两个文件名', () => {
    // 运行时 `agents.files.set` 只认这 6 个名字（WORKSPACE_BOOTSTRAP_FILENAMES），
    // 写别的名字会被网关以 unsupported file 拒掉。
    const allowed = new Set(['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'BOOTSTRAP.md', 'MEMORY.md']);
    expect(MAIN_AGENT_ID).toBe('main');
    const names = MAIN_AGENT_PROMPT_FILES.map((file) => file.name);
    expect(names).toEqual(['IDENTITY.md', 'SOUL.md']);
    for (const name of names) expect(allowed.has(name), `${name} 不在白名单里`).toBe(true);
  });

  it('IDENTITY 说的是主罗盘的身份，并且**如实**说明单助手串行（不假装多 Agent 在跑）', () => {
    const identity = MAIN_AGENT_PROMPT_FILES.find((file) => file.name === 'IDENTITY.md')?.content ?? '';
    expect(identity).toContain('主罗盘');
    expect(identity).toContain('调研员');
    expect(identity).toContain('质检师');
    expect(identity, '不能声称有独立的 worker/agent 在并行执行').toContain(
      'never claim that separate agents or workers are running',
    );
  });

  it('SOUL = 主罗盘角色 + 与六个预置助手**同一份**交付合同（含演示硬约束）', () => {
    const soul = MAIN_AGENT_PROMPT_FILES.find((file) => file.name === 'SOUL.md')?.content ?? '';
    expect(soul).toContain(COMMON_OPERATING_CONTRACT.trim());
    // 演示硬约束四件：必须先读 SKILL.md / 禁 docgen pptx / 禁自写脚本 / 禁"链接或路径"式交付。
    expect(soul).toContain('Before you write a presentation, read the 幻灯版面 skill file');
    expect(soul).toContain('document-deck');
    expect(soul).toContain('PptxGenJS');
    expect(soul).toContain('python-pptx');
    expect(soul).toContain('download link');
    expect(soul).toContain("this task's 产物 panel");
  });
});

describe('ensureMainAgentContract：写入 / 幂等 / 不碰用户的内容', () => {
  it('空工作区 ⇒ 写两份，带当前版本标记，agentId 就是 main', async () => {
    const { api, files, writes } = createStubApi();

    const result = await ensureMainAgentContract('gw-1', api);

    expect(result.failed).toEqual([]);
    expect(result.written).toEqual(['IDENTITY.md', 'SOUL.md']);
    expect(result.upgraded).toEqual([]);
    expect(writes.map((write) => write.agentId)).toEqual(['main', 'main']);
    for (const name of ['IDENTITY.md', 'SOUL.md']) {
      expect(files.get(name), `${name} 没有版本标记`).toContain(`<!-- mofang-prompt:${PRESET_PROMPT_VERSION} -->`);
    }
  });

  it('再跑一次什么都不做（幂等；每次开机都会调它）', async () => {
    const { api, writes } = createStubApi();
    await ensureMainAgentContract('gw-1', api);
    writes.length = 0;

    const second = await ensureMainAgentContract('gw-1', api);

    expect(second.written).toEqual([]);
    expect(second.upgraded).toEqual([]);
    expect(second.skipped).toEqual(['IDENTITY.md', 'SOUL.md']);
    expect(writes).toEqual([]);
  });

  it('⭐ 没有我们的标记（用户手改过）⇒ 一个字都不动', async () => {
    const { api, files, writes } = createStubApi({ 'SOUL.md': '用户自己写的 SOUL，删了会被投诉' });

    const result = await ensureMainAgentContract('gw-1', api);

    expect(result.skipped).toContain('SOUL.md');
    expect(result.written).toEqual(['IDENTITY.md']);
    expect(files.get('SOUL.md')).toBe('用户自己写的 SOUL，删了会被投诉');
    expect(writes.map((write) => write.name)).toEqual(['IDENTITY.md']);
  });

  it('⭐ 带我们**旧版本**标记 ⇒ 覆盖升级（老盘拿得到新合同）', async () => {
    const { api, files } = createStubApi({
      'SOUL.md': '# old compass\n\n<!-- mofang-prompt:2026-01-01.9 -->\n',
    });

    const result = await ensureMainAgentContract('gw-1', api);

    expect(result.upgraded).toEqual(['SOUL.md']);
    expect(result.written).toEqual(['IDENTITY.md']);
    expect(files.get('SOUL.md')).toContain(`<!-- mofang-prompt:${PRESET_PROMPT_VERSION} -->`);
    expect(files.get('SOUL.md')).toContain('The Compass');
  });

  it('⭐ 读不出来（ok:false / 形状不认识）⇒ 记 failed，**绝不盲写**', async () => {
    const failing: MainAgentContractApi = {
      getAgentFile: vi.fn(async () => ({ ok: false, error: 'gateway not connected' })),
      setAgentFile: vi.fn(async () => ({ ok: true })),
    };
    const malformed: MainAgentContractApi = {
      getAgentFile: vi.fn(async () => ({ ok: true, result: { unexpected: true } })),
      setAgentFile: vi.fn(async () => ({ ok: true })),
    };

    const first = await ensureMainAgentContract('gw-1', failing);
    const second = await ensureMainAgentContract('gw-1', malformed);

    expect(first.failed.map((entry) => entry.name)).toEqual(['IDENTITY.md', 'SOUL.md']);
    expect(second.failed).toHaveLength(2);
    expect(failing.setAgentFile).not.toHaveBeenCalled();
    expect(malformed.setAgentFile).not.toHaveBeenCalled();
  });

  it('一个文件写失败不影响另一个，且整个函数**不抛**', async () => {
    const files = new Map<string, string>();
    const api: MainAgentContractApi = {
      getAgentFile: vi.fn(async (_gatewayId: string, agentId: string, name: string) => ({
        ok: true,
        result: { agentId, file: { name, missing: true, content: '' } },
      })),
      setAgentFile: vi.fn(async (_gatewayId: string, _agentId: string, name: string, content: string) => {
        if (name === 'IDENTITY.md') return { ok: false, error: 'unsafe workspace file' };
        files.set(name, content);
        return { ok: true };
      }),
    };

    const result = await ensureMainAgentContract('gw-1', api);

    expect(result.failed).toEqual([{ name: 'IDENTITY.md', error: 'unsafe workspace file' }]);
    expect(result.written).toEqual(['SOUL.md']);
    expect(files.has('SOUL.md')).toBe(true);
  });
});

describe('ensureMainAgentContractWithRetry：尽力而为，永不抛', () => {
  const empty = { written: [], upgraded: [], skipped: [], failed: [] };
  const failed = { written: [], upgraded: [], skipped: [], failed: [{ name: 'SOUL.md', error: 'boom' }] };

  it('第一次失败、第二次成功 ⇒ true', async () => {
    const ensure = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(empty);
    const sleep = vi.fn(async () => {});

    const ok = await ensureMainAgentContractWithRetry('gw-1', { ensure, sleep, delaysMs: [500, 1_500] });

    expect(ok).toBe(true);
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('一直失败 ⇒ false（且用满重试预算）', async () => {
    const ensure = vi.fn(async () => failed);
    const sleep = vi.fn(async () => {});

    const ok = await ensureMainAgentContractWithRetry('gw-1', { ensure, sleep, delaysMs: [500, 1_500] });

    expect(ok).toBe(false);
    expect(ensure).toHaveBeenCalledTimes(3);
  });

  it('底层抛错也被吞掉（Promise.all 里不能有会炸的分支）', async () => {
    const ensure = vi.fn(async () => {
      throw new Error('ipc exploded');
    });

    await expect(
      ensureMainAgentContractWithRetry('gw-1', { ensure, sleep: async () => {}, delaysMs: [] }),
    ).resolves.toBe(false);
  });
});

/**
 * 渲染层那道**栅栏**（不是行为测试，故意说明白；与 `skills-our-ensure.test.ts` 同形）。
 *
 * 上面验的是"接到调用会不会写"。真正让它在开机时发生的，是 `useStartupReadiness`
 * 把 `ensureCompassContract` 交给工作区能力门禁。把这条接线删掉，**别的测试都不会红**，
 * 而主罗盘的交付合同会静默失效（回到"默认入口没有合同"的老状态）。
 */
describe('栅栏：开机时机确实会给主罗盘写合同', () => {
  it('useStartupReadiness 把主罗盘合同与技能自装、助手安装一起交给工作区门禁', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/hooks/useStartupReadiness.ts'), 'utf8');
    expect(source, '主罗盘合同必须经过与助手/技能相同的文件系统能力门禁').toContain(
      'ensureMainContract: ensureCompassContract',
    );
    expect(source, '网关联上时必须启动这道统一门禁').toContain('void runGatedBootstrap()');
    expect(source, '写入只能经 gateway-client 的 agents.files.set 通道').toContain('ensureMainAgentContract');
  });
});
