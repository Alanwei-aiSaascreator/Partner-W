// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { ensureBundledSkillsWithRetry } from '../src/renderer/lib/ensure-bundled-skills';

describe('开机随包技能重试', () => {
  it('第一次网关未就绪、第二次成功 ⇒ 自动补齐，不要求用户重启', async () => {
    const ensure = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'GATEWAY_UNAVAILABLE' })
      .mockResolvedValueOnce({ ok: true, result: { installed: ['deck-layout'], failed: [] } });
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);

    const result = await ensureBundledSkillsWithRetry('gw-1', { ensure, sleep, delaysMs: [500, 1_500] });

    expect(result).toBe(true);
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it('部分安装失败也会重试，但次数严格封顶', async () => {
    const ensure = vi.fn(async () => ({
      ok: true,
      result: { installed: [], failed: [{ slug: 'deck-layout', error: 'still unavailable' }] },
    }));
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);

    const result = await ensureBundledSkillsWithRetry('gw-1', { ensure, sleep, delaysMs: [500, 1_500] });

    expect(result).toBe(false);
    expect(ensure).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1_500]);
  });
});
