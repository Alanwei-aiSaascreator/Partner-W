import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import i18n from '../i18n';
import { getLanguageConfig } from '../i18n/languages';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

function getRtf(): Intl.RelativeTimeFormat {
  return new Intl.RelativeTimeFormat(getLanguageConfig(i18n.language).intlLocale, { numeric: 'auto' });
}

export function formatRelativeTime(date: Date): string {
  const diff = date.getTime() - Date.now();
  const rtf = getRtf();
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) {
      return rtf.format(Math.round(diff / ms), unit);
    }
  }
  return i18n.t('common.justNow');
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 1 元 = 100 积分 = 100 分；1 分 = 1 积分 = 1e6 微积分。 */
const MICROS_PER_CREDIT = 1_000_000;

/**
 * 微积分 → 积分的显示串（**不带单位后缀**，单位由 i18n 文案给）。
 *
 * ⚠️ 不要拿 `formatCents` 复用：那个是**真实货币**（充值赠送金额），
 *    必须继续显示 ¥。两个单位混了是 1e6 倍量级的错误，而且不会报错。
 *
 * 小额也要看得出「扣了」—— 一次普通对话往往只有 1~2 积分，
 * 若按 0 位小数显示会全是 0，用户会以为没扣费（那正是这次报障的起点）。
 */
export function formatCredits(microCents: number): string {
  if (!Number.isFinite(microCents)) return '0';
  const credits = microCents / MICROS_PER_CREDIT;
  const abs = Math.abs(credits);
  // 有值但小到显示不出来时给 `<0.01`，而不是 0 —— 「0」是「没扣费」的意思
  if (abs > 0 && abs < 0.01) return '<0.01';
  if (abs < 1000) return credits.toFixed(2);
  return Math.round(credits).toLocaleString();
}

/**
 * 微积分 → 积分的**余额**显示串：始终两位小数 + 千分位（同样不带单位后缀）。
 *
 * BUG-082 / C-B §4：`formatCredits` 在 ≥1000 积分时四舍五入成整数 ——
 * `1000.40 → 1000.10` 两笔已经结算的消耗在屏幕上都是「1,000」，
 * 用户读到的是"没扣费"。
 *
 * ⚠️ 为什么是**新函数**而不是改 `formatCredits` 的默认行为：全站调用点里，
 *    图表刻度（Dashboard 的 Y 轴/提示）、30 天汇总、用量总量这些**非余额**场景
 *    要的是"读得清"，不是"看得见 0.01"。把它们的语义一起改了 = 全站变吵，
 *    而且那些数字本来就不承担"这次扣了多少"的信息。
 *    ⇒ 分工：**余额**（顶栏/账户页/总览的剩余额度）用本函数；
 *      聚合/图表继续用 `formatCredits`。两条行为都有测试锁住。
 */
export function formatCreditsPrecise(microCents: number): string {
  if (!Number.isFinite(microCents)) return '0';
  const credits = microCents / MICROS_PER_CREDIT;
  const abs = Math.abs(credits);
  // 与 formatCredits 同一个说法：有值但显示不出来 ⇒ `<0.01`，不是 0
  if (abs > 0 && abs < 0.01) return '<0.01';
  return credits.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// A few renderer helpers are deliberately imported by pure-Node tests and by
// build-time tooling.  Reading `navigator` at module evaluation time made all
// of those consumers crash before they could use the platform-independent
// helpers in this file.  The real renderer still takes the browser branch.
const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');

export const modKey = isMac ? '⌘' : 'Ctrl';
