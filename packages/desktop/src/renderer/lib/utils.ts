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

export function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 100_000 ? 1 : 0)}K`;
  if (tokens < 1_000_000_000) return `${(tokens / 1_000_000).toFixed(tokens < 100_000_000 ? 1 : 0)}M`;
  return `${(tokens / 1_000_000_000).toFixed(1)}B`;
}

export function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
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

/** 1 元 = 100 积分 = 100 分 = 1e8 微积分。 */
const MICROS_PER_RMB = 100_000_000;

/**
 * 微积分 → **人民币**的显示串（不带 ¥ 前缀，前缀由调用方给）。
 *
 * ⚠️ 与 `formatCredits` 是两个单位：积分是账本单位，元是等值换算。
 *    1 元 = 100 积分 ⇒ 换算系数是 1e8 微积分/元，不是 1e6。
 *    混了就是 100 倍量级的错误，而且不会报错。
 *
 * 用 4 位小数：一次普通对话常常只有几分钱，2 位会全显示成 ¥0.00。
 */
export function formatRmb(micros: number): string {
  if (!Number.isFinite(micros)) return '0';
  const yuan = micros / MICROS_PER_RMB;
  const abs = Math.abs(yuan);
  if (abs > 0 && abs < 0.0001) return '<0.0001';
  if (abs < 1000) return yuan.toFixed(4);
  return yuan.toFixed(2);
}

const isMac = navigator.platform.toUpperCase().includes('MAC');

export const modKey = isMac ? '⌘' : 'Ctrl';
