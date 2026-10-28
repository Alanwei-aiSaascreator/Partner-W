import { parseRechargeYuanToCents } from '@clawwork/shared';

/**
 * 充值「支付金额 → 到账积分」展示层（BUG-081 / C-A，2026-10-15）。
 *
 * 冻结口径：1 元 = 100 分；1 分 = 1 积分 ⇒ 到账积分 = 支付金额（分）× 1。
 * 用户口径（2026-10-15，覆盖审计原案的「基础 + 赠送 + 合计」拆分）：界面只按
 * 比例展示，不显示服务端 `bonusCents` —— 所以本文件的入参只有支付金额，
 * 没有赠送参数。
 *
 * ⚠️ 单位纪律（1e6 倍错账的坑，不报错、只静默错值）：
 *   - `formatCredits`（lib/utils.ts）收的是**微积分**（1 积分 = 1e6 微积分），
 *     输出余额/消费那种可能带小数的积分串；
 *   - 充值到账积分是**精确整数**（分 × 1），把人民币金额原值直接喂给
 *     `formatCredits` 会得到 `¥1.23 → '<0.01'` 这类 1e6 倍错位的文案；
 *   - 所以充值侧走本文件；人民币金额一律走 `¥ + toFixed(2)`（AccountSection
 *     里的 formatCents），两套单位不互相复用。
 */

/** 1 分 = 1 积分。改这个常数等于改商业比例 —— 那是产品拍板，不是工程细节。 */
const CREDITS_PER_CENT = 1;

/**
 * 支付金额（分）→ 到账积分显示串（整数、千分位，如 `123` / `10,000`）。
 *
 * 非法金额（null / NaN / 非整数分 / 负数）返回 null —— 调用方据此**隐藏**
 * 到账行，而不是把脏值渲染上屏。
 */
export function rechargeCreditsText(cents: number | null): string | null {
  if (cents === null || !Number.isFinite(cents) || !Number.isInteger(cents) || cents < 0) return null;
  return (cents * CREDITS_PER_CENT).toLocaleString();
}

/**
 * 自定义金额输入 → 到账积分显示串。
 *
 * 校验与换算**复用**既有整数分解析器 `parseRechargeYuanToCents`（格式、¥1–¥500
 * 范围与确认按钮的禁用判据同源）；非法输入返回 null。
 */
export function customRechargeCreditsText(raw: string): string | null {
  return rechargeCreditsText(parseRechargeYuanToCents(raw));
}
