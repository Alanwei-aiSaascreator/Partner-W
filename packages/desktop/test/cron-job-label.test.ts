import { describe, expect, it } from 'vitest';
import { parseSystemJobName, systemJobDescription, systemJobLabel } from '../src/renderer/lib/cron-job-label.js';

/**
 * 网关自动建的定时任务在界面上是**英文名**（T-a4）：
 * `heartbeat-main`、`Memory Dreaming Promotion`、`skill-collection-review-<agentId>`。
 * 用户在「定时任务」页看到的就是这几串，中文界面上一片英文。
 *
 * ## ⚠️ 为什么只能做**展示层**映射
 *
 * `job.name` 在网关侧是数据的一部分，而且**用户能改**（`CronJobDialog` 里有名字输入框）。
 * 所以：
 * - 映射只发生在**显示**的那一步，`job.name` 本身一个字节都不动；
 * - **认不出来的一律原样显示** —— 用户改过名的、将来网关改名了，都走这条，
 *   绝不会出现"被我们张冠李戴成别的任务"。
 * - 认不出来的代价只是"又是英文"（良性降级），不是显示错的任务（恶性）。
 */
const fakeT = (key: string, opts?: Record<string, unknown>) => (opts ? `${key}(${JSON.stringify(opts)})` : key);

describe('parseSystemJobName', () => {
  it('heartbeat：尾部是 agent id', () => {
    expect(parseSystemJobName('heartbeat-main')).toEqual({ kind: 'heartbeat', agentId: 'main' });
  });

  it('Memory Dreaming Promotion（固定名，不带 agent）', () => {
    expect(parseSystemJobName('Memory Dreaming Promotion')).toEqual({ kind: 'memoryDreaming' });
  });

  it('skill-collection-review：尾部是 agent id（含带连字符的模板 id）', () => {
    expect(parseSystemJobName('skill-collection-review-partner-w-office')).toEqual({
      kind: 'skillReview',
      agentId: 'partner-w-office',
    });
    expect(parseSystemJobName('skill-collection-review-partner-w-tpl-78b62899')).toEqual({
      kind: 'skillReview',
      agentId: 'partner-w-tpl-78b62899',
    });
  });

  it('⭐ 用户自己改过名的任务 ⇒ 认不出来 ⇒ null（**必须**这样，否则会把用户的任务显示成系统任务）', () => {
    expect(parseSystemJobName('我的周报提醒')).toBeNull();
    expect(parseSystemJobName('heartbeat')).toBeNull();
    expect(parseSystemJobName('')).toBeNull();
    expect(parseSystemJobName('Memory Dreaming')).toBeNull();
  });

  it('⭐ 尾巴是空的（`skill-collection-review-`）⇒ null，不是"agentId 为空字符串"', () => {
    expect(parseSystemJobName('skill-collection-review-')).toBeNull();
    expect(parseSystemJobName('heartbeat-')).toBeNull();
  });
});

describe('systemJobLabel', () => {
  it('认得出就用字面量键取文案', () => {
    expect(systemJobLabel('heartbeat-main', fakeT)).toBe('cron.systemJob.heartbeat');
    expect(systemJobLabel('Memory Dreaming Promotion', fakeT)).toBe('cron.systemJob.memoryDreaming');
  });

  it('⭐ skill-collection-review 带上**这个助手的名字**（不然用户不知道是给谁建的）', () => {
    const label = systemJobLabel('skill-collection-review-partner-w-tpl-78b62899', fakeT, (id) =>
      id === 'partner-w-tpl-78b62899' ? '爆款内容教练' : undefined,
    );
    expect(label).toContain('cron.systemJob.skillReview');
    expect(label).toContain('爆款内容教练');
  });

  it('⭐ 查不到中文名 ⇒ 退回 agentId（宁可显示生 id，也不要空白）', () => {
    const label = systemJobLabel('skill-collection-review-gone', fakeT, () => undefined);
    expect(label).toContain('gone');
  });

  it('⭐ 认不出来的名字 ⇒ null，调用方原样显示（这是**良性降级**的那条路）', () => {
    expect(systemJobLabel('我的周报提醒', fakeT)).toBeNull();
  });
});

describe('systemJobDescription —— 名字对上还不够，**载荷也要对上**', () => {
  it('心跳：载荷 kind 是 heartbeat 才换描述', () => {
    expect(systemJobDescription('heartbeat-main', { kind: 'heartbeat' }, fakeT)).toBe('cron.systemJob.descHeartbeat');
  });

  it('⭐ 名字是系统任务、载荷却换了样 ⇒ null（不能让界面按老样子描述一个已经变了的任务）', () => {
    expect(systemJobDescription('heartbeat-main', { kind: 'brandNewKind' }, fakeT)).toBeNull();
    expect(systemJobDescription('heartbeat-main', undefined, fakeT)).toBeNull();
  });

  it('记忆整理：只认那个**实测到的内部标记串**', () => {
    const sentinel = '__openclaw_memory_core_short_term_promotion_dream__';
    expect(systemJobDescription('Memory Dreaming Promotion', { kind: 'agentTurn', message: sentinel }, fakeT)).toBe(
      'cron.systemJob.descMemoryDreaming',
    );
    // ⚠️ 标记串变了就说原文（良性降级），不要拿旧描述硬套一个新载荷
    expect(
      systemJobDescription('Memory Dreaming Promotion', { kind: 'agentTurn', message: '别的东西' }, fakeT),
    ).toBeNull();
  });

  it('技能库巡检：agentTurn 就换描述（那段英文指令很长，截断后没法看）', () => {
    expect(
      systemJobDescription('skill-collection-review-x', { kind: 'agentTurn', message: 'Review this…' }, fakeT),
    ).toBe('cron.systemJob.descSkillReview');
  });

  it('⭐ 非系统任务一律 null（改的只是那三种，不是全局屏蔽）', () => {
    expect(systemJobDescription('我的提醒', { kind: 'agentTurn', message: '记得回电话' }, fakeT)).toBeNull();
  });
});
