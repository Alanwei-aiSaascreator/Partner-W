import { describe, expect, it, vi } from 'vitest';
import { runWorkspaceGatedBootstrap } from '../src/renderer/lib/startup-workspace-gate';

describe('runWorkspaceGatedBootstrap', () => {
  it('⭐ 先探测；不支持时助手与技能都零写入', async () => {
    const order: string[] = [];
    const bootstrapAssistants = vi.fn(async () => order.push('assistants'));
    const ensureSkills = vi.fn(async () => order.push('skills'));

    const result = await runWorkspaceGatedBootstrap({
      probe: vi.fn(async () => {
        order.push('probe');
        return { state: 'unsupported-identity' as const, dev: null, ino: null };
      }),
      bootstrapAssistants,
      ensureSkills,
    });

    expect(result?.state).toBe('unsupported-identity');
    expect(order).toEqual(['probe']);
    expect(bootstrapAssistants).not.toHaveBeenCalled();
    expect(ensureSkills).not.toHaveBeenCalled();
  });

  it('支持时也必须探测完成后才启动两条写入链', async () => {
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
    });

    expect(order.slice(0, 2)).toEqual(['probe:start', 'probe:end']);
    expect(order).toEqual(expect.arrayContaining(['assistants', 'skills']));
  });
});
