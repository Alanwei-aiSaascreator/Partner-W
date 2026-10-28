import { describe, expect, it } from 'vitest';

import {
  IDENTITY_BLOCK_END,
  IDENTITY_BLOCK_START,
  buildIdentityBlock,
  mergeIdentityIntoUserMd,
} from '../src/renderer/lib/identity-persona';
import {
  INDUSTRY_BRIEFING_PREFIXES,
  buildIndustryBriefing,
  resolveIndustryMethod,
} from '../src/renderer/lib/industry-method';
import type { OnboardingIndustry } from '../src/renderer/lib/user-onboarding';

/**
 * 行业方法**真的进到提示词里**这条链（2026-10-16，全量总单第 23 行）。
 *
 * ## 为什么这必须是独立的测试
 *
 * `test/industry-method.test.ts` 只证明"两个行业产出的**键**不同"。
 * 那还不够 —— 键不同但**没人把它写进助手读的东西**，用户就是白填了这个行业。
 * 这一份证明的是**闭环**：行业 → 三行文字 → 身份块 → `USER.md`（助手每轮全文读到）。
 *
 * ## 为什么"重复保存不堆积"是硬要求
 *
 * 身份块是**按前缀剥离再重写**的（`stripIdentityBlock`）。如果行业那三行不被剥离，
 * 用户点两次「保存并应用」，`USER.md` 里就会出现两份、三份……越写越长，
 * 最后撑爆运行时的 4000 字上限，**用户自己写的记忆整份写不进去**。
 * 这是不可逆的损坏，所以它必须有测试守着，而不是"记得就行"。
 */

const industry = (code: OnboardingIndustry['code']): OnboardingIndustry => ({
  code,
  generalConfirmed: code === null,
  source: 'user',
  catalogVersion: 1,
});

/** 假翻译：键原样返回，便于断言"写进去的确实是行业那几行"。 */
const identityT = (key: string): string => key;

const cLines = () => buildIndustryBriefing(resolveIndustryMethod(industry('C')), identityT);
const rLines = () => buildIndustryBriefing(resolveIndustryMethod(industry('R')), identityT);

describe('buildIdentityBlock：行业三行是可选的（不给就一个字都不变）', () => {
  it('⭐ 不传行业 ⇒ 与既有行为逐字相同（既有调用方不受影响）', () => {
    const before = buildIdentityBlock({ groupLabel: '制造业', tagLabels: ['目标导向'] });
    const withUndefined = buildIdentityBlock({
      groupLabel: '制造业',
      tagLabels: ['目标导向'],
      industryLines: undefined,
    });
    const withEmpty = buildIdentityBlock({ groupLabel: '制造业', tagLabels: ['目标导向'], industryLines: [] });
    expect(withUndefined).toBe(before);
    expect(withEmpty).toBe(before);
  });

  it('⭐ 传了行业 ⇒ 三行进块，且在结束标记之前（不许漏到块外）', () => {
    const lines = cLines();
    expect(lines).not.toBeNull();
    const block = buildIdentityBlock({ groupLabel: '制造业', tagLabels: [], industryLines: lines ?? [] });
    const endIndex = block.indexOf(IDENTITY_BLOCK_END);
    for (const line of lines ?? []) {
      expect(block, `行业那行没进身份块：${line}`).toContain(line);
      expect(block.indexOf(line), `行业那行跑到结束标记外面了：${line}`).toBeLessThan(endIndex);
    }
    expect(block.startsWith(IDENTITY_BLOCK_START)).toBe(true);
  });

  it('⭐ 两个不同行业的身份块逐字不同（这就是"影响了提示词"）', () => {
    const blockC = buildIdentityBlock({ groupLabel: '制造业', tagLabels: [], industryLines: cLines() ?? [] });
    const blockR = buildIdentityBlock({ groupLabel: '文体娱乐', tagLabels: [], industryLines: rLines() ?? [] });
    expect(blockC).not.toBe(blockR);
    for (const line of cLines() ?? []) expect(blockC).toContain(line);
    for (const line of rLines() ?? []) expect(blockR).toContain(line);
    for (const line of rLines() ?? []) expect(blockC).not.toContain(line);
  });

  it('⭐ 行业行落在身份块的标记之间，剥离器认得出（前缀就是登记的那三个）', () => {
    const block = buildIdentityBlock({ groupLabel: '制造业', tagLabels: [], industryLines: cLines() ?? [] });
    for (const prefix of INDUSTRY_BRIEFING_PREFIXES) {
      expect(block, `身份块里没有 ${prefix} 这一行`).toContain(prefix);
    }
  });
});

describe('合并进 USER.md：可重复保存，不堆积、不吞用户自己写的东西', () => {
  const userWrote = '这是我自己写的记忆，一个字节都不许丢。\n\n- 我的偏好：先给结论。';

  it('⭐ 行业块能写进 USER.md', () => {
    const block = buildIdentityBlock({ groupLabel: '制造业', tagLabels: [], industryLines: cLines() ?? [] });
    const merged = mergeIdentityIntoUserMd(userWrote, block);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.content).toContain(userWrote);
    for (const line of cLines() ?? []) expect(merged.content).toContain(line);
  });

  it('⭐ 连存两次不堆积：行业那三行在文件里各只出现一次', () => {
    const block = buildIdentityBlock({ groupLabel: '制造业', tagLabels: [], industryLines: cLines() ?? [] });
    const once = mergeIdentityIntoUserMd(userWrote, block);
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const twice = mergeIdentityIntoUserMd(once.content, block);
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    expect(twice.content).toBe(once.content);
    for (const line of cLines() ?? []) {
      const occurrences = twice.content.split(line).length - 1;
      expect(occurrences, `行业那行被写了 ${occurrences} 次：${line}`).toBe(1);
    }
    expect(twice.content).toContain(userWrote);
  });

  it('⭐ 换行业 = 换内容（旧行业那三行必须被剥掉，不能新旧并存）', () => {
    const blockC = buildIdentityBlock({ groupLabel: '制造业', tagLabels: [], industryLines: cLines() ?? [] });
    const blockR = buildIdentityBlock({ groupLabel: '文体娱乐', tagLabels: [], industryLines: rLines() ?? [] });
    const withC = mergeIdentityIntoUserMd(userWrote, blockC);
    expect(withC.ok).toBe(true);
    if (!withC.ok) return;
    const withR = mergeIdentityIntoUserMd(withC.content, blockR);
    expect(withR.ok).toBe(true);
    if (!withR.ok) return;
    for (const line of rLines() ?? []) expect(withR.content).toContain(line);
    for (const line of cLines() ?? []) expect(withR.content, `换行业后旧行还留着：${line}`).not.toContain(line);
    expect(withR.content).toContain(userWrote);
  });

  it('⭐ 行业清空（用户改回「暂不确定」）⇒ 再存一次会把那三行摘干净', () => {
    const blockC = buildIdentityBlock({ groupLabel: '制造业', tagLabels: [], industryLines: cLines() ?? [] });
    const withC = mergeIdentityIntoUserMd(userWrote, blockC);
    expect(withC.ok).toBe(true);
    if (!withC.ok) return;
    const cleared = buildIdentityBlock({ groupLabel: '制造业', tagLabels: [] });
    const after = mergeIdentityIntoUserMd(withC.content, cleared);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    for (const prefix of INDUSTRY_BRIEFING_PREFIXES) {
      expect(after.content, `摘干净后还剩 ${prefix}`).not.toContain(prefix);
    }
    expect(after.content).toContain(userWrote);
  });

  it('⭐ 4000 字上限照旧生效（行业块不能变成绕过上限的后门）', () => {
    const block = buildIdentityBlock({ groupLabel: '制造业', tagLabels: [], industryLines: cLines() ?? [] });
    const huge = 'x'.repeat(4000);
    expect(mergeIdentityIntoUserMd(huge, block)).toMatchObject({ ok: false, reason: 'over-limit', limit: 4000 });
  });
});
