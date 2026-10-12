// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimBundledSkillConflictNotification,
  clearBundledSkillsReport,
  ensureBundledSkillsWithRetry,
  formatBundledSkillNames,
  getBundledSkillsReport,
  publishBundledSkillsReport,
  resetBundledSkillsReportForTests,
  subscribeBundledSkillsReport,
} from '../src/renderer/lib/ensure-bundled-skills';

/**
 * 开机随包技能自装：**failed 与 conflicts 是两回事**（2026-10-11 升级补齐）。
 *
 *   · `failed`   = 装/升失败（网关没热、写盘出错…）—— 可重试、重试有封顶；
 *   · `conflicts`= 我们在装的那份被用户改过（或来源存疑）—— **终态**，
 *                  开机**绝不**替用户做"替换"这个决定，重试一百次也是同一个冲突；
 *                  界面要显示受影响技能并接**既有修复入口**（技能市场「修复随包版本」）。
 *
 * ⚠️ 因此 `failed.length === 0` **不等于**"新技能全生效"：有冲突时技能同样没升上去。
 *    旧实现只看 failed，把一个"保留了用户修改、没升级成功"的结果报成成功。
 */
describe('开机随包技能重试', () => {
  beforeEach(() => {
    resetBundledSkillsReportForTests();
  });

  it('第一次网关未就绪、第二次成功 ⇒ 自动补齐，不要求用户重启', async () => {
    const ensure = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'GATEWAY_UNAVAILABLE' })
      .mockResolvedValueOnce({ ok: true, result: { installed: ['deck-layout'], failed: [] } });
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);

    const outcome = await ensureBundledSkillsWithRetry('gw-1', { ensure, sleep, delaysMs: [500, 1_500] });

    expect(outcome.allEffective).toBe(true);
    expect(outcome.completed).toBe(true);
    expect(outcome.installed).toEqual(['deck-layout']);
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.failed).toEqual([]);
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it('failed 会重试，但次数严格封顶', async () => {
    const ensure = vi.fn(async () => ({
      ok: true,
      result: { installed: [], failed: [{ slug: 'deck-layout', error: 'still unavailable' }] },
    }));
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);

    const outcome = await ensureBundledSkillsWithRetry('gw-1', { ensure, sleep, delaysMs: [500, 1_500] });

    expect(outcome.allEffective).toBe(false);
    expect(outcome.failed).toEqual([{ slug: 'deck-layout', error: 'still unavailable' }]);
    expect(ensure).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1_500]);
  });

  it('只有冲突（failed 为空）⇒ 不重试、且明确"未全生效"', async () => {
    const ensure = vi.fn(async () => ({
      ok: true,
      result: {
        installed: [],
        upgraded: [],
        adopted: [],
        failed: [],
        conflicts: [{ slug: 'deck-layout', reason: 'user-modified', paths: ['scripts/generate.cjs'] }],
      },
    }));
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);

    const outcome = await ensureBundledSkillsWithRetry('gw-1', { ensure, sleep, delaysMs: [500, 1_500] });

    // 冲突是终态：重试改变不了用户的文件，只会让启动流程白等两次
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(outcome.failed).toEqual([]);
    // ⭐ 这条就是"不把 failed.length === 0 当作全生效"的钉子
    expect(outcome.allEffective, '用户改过的技能没升上去 ⇒ 不算全生效').toBe(false);
    expect(outcome.conflicts).toEqual([
      { slug: 'deck-layout', reason: 'user-modified', paths: ['scripts/generate.cjs'] },
    ]);
  });

  it('冲突 + 失败混在一起：失败照旧重试，冲突明细不丢', async () => {
    let attempt = 0;
    const ensure = vi.fn(async () => {
      attempt += 1;
      return {
        ok: true,
        result: {
          installed: [],
          upgraded: [],
          adopted: [],
          conflicts: [{ slug: 'document-deck', reason: 'unverified-origin', paths: ['SKILL.md'] }],
          failed: attempt < 3 ? [{ slug: 'html-deliverable', error: 'EBUSY' }] : [],
        },
      };
    });
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);

    const outcome = await ensureBundledSkillsWithRetry('gw-1', { ensure, sleep, delaysMs: [500, 1_500] });

    expect(ensure).toHaveBeenCalledTimes(3);
    expect(outcome.failed).toEqual([]);
    expect(outcome.allEffective, '失败清零了，但冲突还在 ⇒ 仍未全生效').toBe(false);
    expect(outcome.conflicts).toEqual([{ slug: 'document-deck', reason: 'unverified-origin', paths: ['SKILL.md'] }]);
  });

  it('一次都没拿到结构完整的答复 ⇒ completed=false（不假装有结论）', async () => {
    const ensure = vi.fn(async () => ({ ok: false, error: 'GATEWAY_UNAVAILABLE' }));
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);

    const outcome = await ensureBundledSkillsWithRetry('gw-1', { ensure, sleep, delaysMs: [500] });

    expect(outcome.completed).toBe(false);
    expect(outcome.allEffective).toBe(false);
    expect(ensure).toHaveBeenCalledTimes(2);
  });
});

describe('随包技能报告（供设置页显示受影响技能并接修复入口）', () => {
  beforeEach(() => {
    resetBundledSkillsReportForTests();
  });

  it('发布 / 订阅 / 清除', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeBundledSkillsReport(listener);

    expect(getBundledSkillsReport()).toBeNull();
    const report = {
      gatewayId: 'gw-1',
      conflicts: [{ slug: 'deck-layout', reason: 'user-modified', paths: ['scripts/generate.cjs'] }],
      failed: [],
      names: { 'deck-layout': '幻灯版面（自己排）' },
      updatedAt: 1,
    };
    publishBundledSkillsReport(report);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getBundledSkillsReport()).toBe(report);

    clearBundledSkillsReport();
    expect(getBundledSkillsReport()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    publishBundledSkillsReport(report);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('冲突提示每应用生命周期只弹一次（claim 一次即作废）', () => {
    expect(claimBundledSkillConflictNotification()).toBe(true);
    expect(claimBundledSkillConflictNotification()).toBe(false);

    resetBundledSkillsReportForTests();
    expect(claimBundledSkillConflictNotification(), '复位后（新的应用生命周期）重新可提示').toBe(true);
  });

  it('受影响技能展示名：解析到了用名字，解析不到退回 slug（不许空）', () => {
    expect(
      formatBundledSkillNames([{ slug: 'deck-layout' }, { slug: 'document-deck' }], {
        'deck-layout': '幻灯版面（自己排）',
      }),
    ).toBe('幻灯版面（自己排）、document-deck');
  });
});
