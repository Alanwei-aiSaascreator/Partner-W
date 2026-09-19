import { describe, expect, it } from 'vitest';
import { toSlug } from '../src/renderer/layouts/TeamsPanel/utils';

/**
 * `toSlug`（2026-09-20）。
 *
 * ⚠️ 这个文件是被实机跑出来的 bug 逼出来的：
 *    `toSlug('高效办公')` 里中文字符全被 `[^a-z0-9]+` 换成 `-`、再被掐头去尾 ⇒ 空串
 *    ⇒ 走兜底分支。原来兜底是 `agent-${Date.now()}`，而向导里那几个名字是在
 *    **同一毫秒**里算的 ⇒ **三个不同的助手得到同一个 slug** ⇒ `step2Valid` 的
 *    "slug 不重复"判成重名 ⇒ **「下一步」永远是灰的，向导走不下去**。
 *    而中文助手恰恰是主场景（市场里的官方模板全是中文名）。
 *
 * ⇒ 兜底值必须**由名字决定**：不同的名字给不同的值，同一个名字给同一个值
 *   （后者才能让"重名"被正确判出来）。
 */
describe('toSlug', () => {
  it('英文名照旧：小写 + 非字母数字换连字符', () => {
    expect(toSlug('Weekly Report')).toBe('weekly-report');
    expect(toSlug('  Sales Bot  ')).toBe('sales-bot');
  });

  it('⭐ 不同的中文名 ⇒ 不同的 slug（同一毫秒内也不许撞）', () => {
    const a = toSlug('高效办公');
    const b = toSlug('爆款内容教练');
    const c = toSlug('深度研究助手');

    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });

  it('⭐ 同一个中文名 ⇒ 同一个 slug（否则"重名"判不出来）', () => {
    expect(toSlug('高效办公')).toBe(toSlug('高效办公'));
  });

  it('掺中文的名字也能区分', () => {
    expect(toSlug('助手A')).not.toBe(toSlug('助手B'));
  });

  it('空名字 / 纯符号也给得出非空 slug', () => {
    expect(toSlug('')).toBeTruthy();
    expect(toSlug('——')).toBeTruthy();
    expect(toSlug('——')).not.toBe(toSlug('··'));
  });
});
