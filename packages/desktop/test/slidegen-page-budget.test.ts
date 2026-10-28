import { describe, expect, it } from 'vitest';
import { SLIDEGEN_MAX_PAGES, messagePageBudgetFailure, pageBudgetFailure } from '@clawwork/shared';

/**
 * ⭐⭐ 「多少页算太多」这一刀（2026-09-29）。
 *
 * ## 为什么它值得单独一条测试
 *
 * 原来这个判据**只写在 `generate.ts` 的循环里**（`if (pages.length > SLIDEGEN_MAX_PAGES)`），
 * 而那个函数要起真浏览器量框（`measure.ts`）—— `slidegen.test.ts` 的开头写明
 * "在单测里起不来，硬桩一个假浏览器只会测到桩自己"。
 * ⇒ **这条判据从来没有过测试**：`grep slidegen-too-many-pages` 在整个 test 目录里 0 命中。
 * 所以把它抽成**纯函数**，判据才守得住。
 *
 * ## 为什么上限必须显著大于 60
 *
 * 本机真渲染实测：**26 页 612 ms、64 页 1068 ms**（≈17–24 ms/页）。
 * 也就是说 60 这道闸**会拒掉一份只花 1 秒就能渲染完的稿子**。
 * 而 `SLIDEGEN_FAILURE` 那份类型文件里写着它的设计意图：
 * 「**这条通道不因为内容多而拒绝**」——闸的理由是**成本**（每页一次浏览器渲染），
 * 不是"内容太长"。成本既然量出来是 1 秒级，闸就该按测量值定，而不是拍一个 60。
 *
 * ⚠️ 这不是把闸删掉：极端页数仍然会拒（那才是"几百页"那个原始担忧），
 * 只是它退回到**兜底**的位置，不再对正常的长稿子开枪。
 */
describe('slidegen 的页数闸', () => {
  it('⭐ 64 页**不许**被拒（本机真渲染实测只需 ~1 秒）', () => {
    expect(pageBudgetFailure(64)).toBeNull();
  });

  it('正常长稿：40 / 60 / 80 页都不拒', () => {
    for (const pages of [40, 60, 80]) {
      expect(pageBudgetFailure(pages), `${pages} 页不该被拒`).toBeNull();
    }
  });

  it('上限之内放行、超出才拒（边界两侧各一次）', () => {
    expect(pageBudgetFailure(SLIDEGEN_MAX_PAGES)).toBeNull();
    expect(pageBudgetFailure(SLIDEGEN_MAX_PAGES + 1)).toEqual({
      code: 'slidegen-too-many-pages',
      max: SLIDEGEN_MAX_PAGES,
      got: SLIDEGEN_MAX_PAGES + 1,
    });
  });

  it('兜底仍然说得出两个数字（用户要知道现在多少页、上限多少）', () => {
    const failure = pageBudgetFailure(9999);
    expect(failure?.code).toBe('slidegen-too-many-pages');
    expect(failure && 'max' in failure ? failure.max : 0).toBeGreaterThan(0);
    expect(failure && 'got' in failure ? failure.got : 0).toBe(9999);
  });

  it('⭐ 同一消息里多份 deck 共享 200 页预算', () => {
    expect(messagePageBudgetFailure([80, 120])).toBeNull();
    expect(messagePageBudgetFailure([120, 81])).toEqual({
      code: 'slidegen-too-many-pages',
      max: SLIDEGEN_MAX_PAGES,
      got: 201,
    });
  });
});
