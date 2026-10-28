import { describe, expect, it } from 'vitest';
import type { OurSkillEntry, SkillStatusEntry, SkillStatusReport } from '@clawwork/shared';
import { readSkillStatusReport, resolveSkillVerdict, skillJoinKey } from '../src/renderer/layouts/SkillMarket/verdict';

/**
 * 「这个助手现在能不能用它」—— 纯判据（2026-09-29）。
 *
 * ## 为什么要有这一层，而不是在组件里 `if`
 *
 * 这个问题**只能问网关**（`skills.status`，按助手）。而它的反面 ——「装上了」——
 * 看的是**磁盘**（主进程 `fs.existsSync`）。两个真相、两个主人，
 * 一旦让其中一个去推导另一个，就会出现"装上按钮旁边挂着一个绿标签"这种自相矛盾。
 * 所以判据全收在这个纯模块里，组件只负责画。
 *
 * ⭐ 三个**不许**（每条都对应一个会咬人的窗口）：
 * 1. 没装 ⇒ `none`，**不发探测、也不给标签**（卸载后网关侧还会报 ≥3 分钟"在"）；
 * 2. 没见到条目 ⇒ `unknown('absent')`，**绝不是 blocked**（安装有 ~0.7s 可见延迟，
 *    按助手的缓存也各算各的 —— "我没看到"不等于"它不能用"）；
 * 3. 问不到 ⇒ `unknown`，**不许渲染成绿，也不许渲染成红**（问不到就是问不到）。
 */

const t = (key: string, opts?: Record<string, unknown>): string => (opts ? `${key}(${JSON.stringify(opts)})` : key);

const our = (slug: string, over: Partial<OurSkillEntry> = {}): OurSkillEntry =>
  ({ slug, name: slug, installed: true, ...over }) as OurSkillEntry;

const entry = (over: Partial<SkillStatusEntry> = {}): SkillStatusEntry =>
  ({
    name: 'x',
    description: '',
    source: 'openclaw-managed',
    bundled: false,
    filePath: '',
    baseDir: '',
    skillKey: 'x',
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    eligible: true,
    requirements: { bins: [], anyBins: [], env: [], config: [], os: [] },
    missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
    configChecks: [],
    install: [],
    ...over,
  }) as SkillStatusEntry;

const report = (skills: SkillStatusEntry[]): SkillStatusReport =>
  ({ workspaceDir: 'C:/ws', managedSkillsDir: 'C:/managed', skills }) as SkillStatusReport;

describe('skillJoinKey：和网关那份清单按什么对上', () => {
  it('有 skillKey 就用它（前挂载的键比 slug 更准）', () => {
    expect(skillJoinKey(our('weekly-report', { skillKey: 'weekly-report' } as never))).toBe('weekly-report');
  });

  it('skillKey 缺失时退回 slug（frontmatter 坏掉时类型允许它缺）', () => {
    expect(skillJoinKey(our('meeting-minutes'))).toBe('meeting-minutes');
  });
});

describe('readSkillStatusReport：线上下来的东西要**校验**，不是断言', () => {
  it('skills 不是数组 ⇒ null', () => {
    expect(readSkillStatusReport({ skills: 'nope' })).toBeNull();
  });

  it('空对象 ⇒ null', () => {
    expect(readSkillStatusReport({})).toBeNull();
  });

  it('null / 非对象 ⇒ null', () => {
    expect(readSkillStatusReport(null)).toBeNull();
    expect(readSkillStatusReport('x')).toBeNull();
  });

  it('形状对 ⇒ 原样返回（不复制、不改写）', () => {
    const r = report([entry()]);
    expect(readSkillStatusReport(r)).toBe(r);
  });
});

describe('resolveSkillVerdict', () => {
  it('⭐ 没装 ⇒ none（连探测都不该发）', () => {
    const v = resolveSkillVerdict({
      skill: our('x', { installed: false } as never),
      report: null,
      agentKnown: true,
      t,
    });
    expect(v.kind).toBe('none');
  });

  it('⭐ 不知道问哪个助手 ⇒ unknown(no-agent)，不是绿也不是红', () => {
    const v = resolveSkillVerdict({
      skill: our('x'),
      report: report([entry({ skillKey: 'x' })]),
      agentKnown: false,
      t,
    });
    expect(v).toEqual({ kind: 'unknown', why: 'no-agent' });
  });

  it('⭐ 问不到（RPC 失败）⇒ unknown(rpc-failed)', () => {
    const v = resolveSkillVerdict({ skill: our('x'), report: null, agentKnown: true, t });
    expect(v).toEqual({ kind: 'unknown', why: 'rpc-failed' });
  });

  it('⭐ 报告里没有这一条 ⇒ unknown(absent)，**绝不判成 blocked**', () => {
    const v = resolveSkillVerdict({ skill: our('x'), report: report([]), agentKnown: true, t });
    expect(v).toEqual({ kind: 'unknown', why: 'absent' });
  });

  it('eligible 且无不满足项 ⇒ usable', () => {
    const v = resolveSkillVerdict({ skill: our('x'), report: report([entry({ skillKey: 'x' })]), agentKnown: true, t });
    expect(v).toEqual({ kind: 'usable' });
  });

  it('disabled ⇒ blocked，且说得出原因', () => {
    const v = resolveSkillVerdict({
      skill: our('x'),
      report: report([entry({ skillKey: 'x', disabled: true })]),
      agentKnown: true,
      t,
    });
    expect(v.kind).toBe('blocked');
    expect(v.kind === 'blocked' && v.reason).toBe('skillReasonDisabled');
  });

  it('被名单挡 ⇒ blocked，原因走同一条文案', () => {
    const v = resolveSkillVerdict({
      skill: our('x'),
      report: report([entry({ skillKey: 'x', blockedByAllowlist: true })]),
      agentKnown: true,
      t,
    });
    expect(v.kind === 'blocked' && v.reason).toBe('skillReasonBlocked');
  });

  it('configChecks 没过 ⇒ blocked，带上个数', () => {
    const v = resolveSkillVerdict({
      skill: our('x'),
      report: report([entry({ skillKey: 'x', configChecks: [{ satisfied: false, path: 'a' }] as never })]),
      agentKnown: true,
      t,
    });
    expect(v.kind === 'blocked' && v.reason).toContain('skillReasonConfig');
  });

  it('缺东西 ⇒ blocked，缺什么说出来（走 missing，不是 requirements）', () => {
    const v = resolveSkillVerdict({
      skill: our('x'),
      report: report([
        entry({
          skillKey: 'x',
          eligible: false,
          missing: { bins: ['ffmpeg'], anyBins: [], env: [], config: [], os: [] } as never,
          requirements: { bins: ['ffmpeg', 'ffprobe'], anyBins: [], env: [], config: [], os: [] } as never,
        }),
      ]),
      agentKnown: true,
      t,
    });
    expect(v.kind === 'blocked' && v.reason).toContain('skillMissingBins');
    // ⚠️ 用 `missing`（未满足的那部分）而不是 `requirements`（全部要求）——
    //    拿后者会把"已满足的"也算成缺的，把一个能用的技能说成不能用。
    expect(v.kind === 'blocked' && v.reason).not.toContain('"count":2');
  });

  it('eligible 为假但一条原因都说不出来 ⇒ 也要 blocked，且给一句通用话（不许空标签）', () => {
    const v = resolveSkillVerdict({
      skill: our('x'),
      report: report([entry({ skillKey: 'x', eligible: false })]),
      agentKnown: true,
      t,
    });
    expect(v.kind).toBe('blocked');
    expect(v.kind === 'blocked' && v.reason.length).toBeGreaterThan(0);
  });
});
