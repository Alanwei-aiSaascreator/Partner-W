import { describe, expect, it, vi } from 'vitest';
import { runWorkspaceGatedBootstrap } from '../src/renderer/lib/startup-workspace-gate';

describe('runWorkspaceGatedBootstrap', () => {
  it('⭐ 先探测；不支持时助手、技能与主罗盘合同都零写入', async () => {
    const order: string[] = [];
    const bootstrapAssistants = vi.fn(async () => order.push('assistants'));
    const ensureSkills = vi.fn(async () => order.push('skills'));
    const ensureMainContract = vi.fn(async () => order.push('main-contract'));

    const result = await runWorkspaceGatedBootstrap({
      probe: vi.fn(async () => {
        order.push('probe');
        return { state: 'unsupported-identity' as const, dev: null, ino: null };
      }),
      bootstrapAssistants,
      ensureSkills,
      ensureMainContract,
    });

    expect(result?.state).toBe('unsupported-identity');
    expect(order).toEqual(['probe']);
    expect(bootstrapAssistants).not.toHaveBeenCalled();
    expect(ensureSkills).not.toHaveBeenCalled();
    expect(ensureMainContract).not.toHaveBeenCalled();
  });

  it('支持时也必须探测完成后才启动三条写入链', async () => {
    const order: string[] = [];
    await runWorkspaceGatedBootstrap({
      probe: async () => {
        order.push('probe:start');
        await Promise.resolve();
        order.push('probe:end');
        return { state: 'ok', dev: '1', ino: '2' };
      },
      bootstrapAssistants: async () => {
        order.push('assistants');
      },
      ensureSkills: async () => {
        order.push('skills');
      },
      ensureMainContract: async () => {
        order.push('main-contract');
      },
    });

    expect(order.slice(0, 2)).toEqual(['probe:start', 'probe:end']);
    expect(order).toEqual(expect.arrayContaining(['assistants', 'skills', 'main-contract']));
  });

  it('⭐ unknown / null 都 fail-closed，不启动任何写入链', async () => {
    for (const result of [{ state: 'unknown' as const, dev: null, ino: null }, null]) {
      const bootstrapAssistants = vi.fn(async () => {});
      const ensureSkills = vi.fn(async () => {});
      const ensureMainContract = vi.fn(async () => {});
      await runWorkspaceGatedBootstrap({
        probe: async () => result,
        bootstrapAssistants,
        ensureSkills,
        ensureMainContract,
      });
      expect(bootstrapAssistants).not.toHaveBeenCalled();
      expect(ensureSkills).not.toHaveBeenCalled();
      expect(ensureMainContract).not.toHaveBeenCalled();
    }
  });
});
