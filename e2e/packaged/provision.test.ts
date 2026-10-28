/**
 * `maskPhone()` 的回归测试 —— 它是全仓**唯一**允许把手机号放进日志/报告的地方。
 *
 * 跑法： `pnpm test:e2e:unit`（或 `node --test e2e/packaged/provision.test.ts`）
 *
 * ⚠️ **不在 CI 里**：`pr-check.yml` 既不跑 `typecheck:e2e` 也不跑任何 `test:e2e*`
 * —— 它和 `e2e/helpers/temp-root.test.ts` 一样是**手动**门禁。
 * 别把它当成"已经有人守着"。（`typecheck:e2e` 会编译到本文件，那是本地 `pnpm check` 里的。）
 *
 * ⚠️ **本文件不碰任何真实 profile**：只 import 一个**纯函数**，不调 `readDevProvision`，
 * 不读 `%APPDATA%`。（那个目录里放的是真凭据，`provision.ts` 顶部有密钥纪律。）
 *
 * ## 为什么值得单独钉
 *
 * 两个 spec 的文件头都写着「日志里要标识手机号时**只允许** `maskPhone()`」——
 * 但那句话本身**不可执行**，可执行的只有这个函数的行为。而手机号一旦进了日志，
 * 就进了 CI 输出和截图，**收不回来**。所以"遮蔽得够不够"只能靠这里的断言说话。
 *
 * ⚠️ 这里断言的是**性质**，不是某个具体字符串：`maskPhone` 怎么改写法都行，
 * 只要"露出来的部分短到认不出人"这条成立。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { maskPhone } from './provision.ts';

/** 真实用例里会出现的那两种形态（`demo-main-path` / `late-login` 都只传这两种）。 */
const NATIONAL = '13800138000'; // 11 位
const E164 = '+8613800138000'; // 14 位

/** 原号码里**任何**连续 6 位片段。遮蔽结果里不该出现它们中的任何一个。 */
function windows(phone: string, size = 6): string[] {
  const out: string[] = [];
  for (let i = 0; i + size <= phone.length; i += 1) out.push(phone.slice(i, i + size));
  return out;
}

test('正常号码：露国家码与末 2 位，中间遮蔽', () => {
  assert.equal(maskPhone(NATIONAL), '138****00');
  assert.equal(maskPhone(E164), '+86****00');
});

test('⭐ 太短的号码**一位都不露** —— 遮蔽方案是固定的"前 3 后 2"，短号上会露掉大半', () => {
  // 这是本文件存在的主要理由：
  // 旧实现只挡 `length <= 5`，于是 6 位的 `123456` 会被遮成 `123****56`
  // —— 6 位里露出 5 位，等于没遮。而 `maskPhone` 是**唯一**允许标识手机号的函数，
  // 它必须是"短到一定程度就全遮"，不是"照着模板切一刀"。
  for (const short of ['123456', '1234567', '12345678', '123456789', '1234567890']) {
    assert.equal(
      maskPhone(short),
      '***',
      `${short.length} 位号码不该露出任何一位（旧实现会露出 ${short.slice(0, 3)}****${short.slice(-2)}）`,
    );
  }
});

test('⭐ 性质：遮蔽结果里不得出现原号码的任何连续 6 位片段', () => {
  for (const phone of [NATIONAL, E164, '123456', '1234567890', '010-12345678', '+14155552671']) {
    const masked = maskPhone(phone);
    for (const w of windows(phone)) {
      assert.ok(!masked.includes(w), `「${phone}」的片段「${w}」出现在了遮蔽结果「${masked}」里 ⇒ 这个遮蔽等于没遮`);
    }
  }
});

test('性质：遮蔽结果永远不等于原号码（不能"遮了个寂寞"）', () => {
  for (const phone of [NATIONAL, E164, '123456', '1234567890']) {
    assert.notEqual(maskPhone(phone), phone);
  }
});

test('性质：露出的位数有上限（前 3 + 后 2，其余全是掩码）', () => {
  for (const phone of [NATIONAL, E164, '1234567890']) {
    const masked = maskPhone(phone);
    const revealed = masked.replace(/\*+/g, '');
    assert.ok(
      revealed.length <= 5,
      `「${phone}」遮蔽后仍露出 ${revealed.length} 位（「${revealed}」）⇒ 超过"前 3 后 2"的口径`,
    );
  }
});
