/**
 * 把**原始英文错误**翻译成用户看得懂的一句话（2026-10-17 用户反馈：
 * 发送中断/失败时直接弹 `WebSocket is closed` 这类英文，用户以为卡死了）。
 *
 * 纪律：
 *  · 只做**归类**，不编细节 —— 认不出就回"失败，请重试"这一档；
 *  · 原始文本仍然由调用方写调试日志（`reportDebugEvent` / console），排障不受影响；
 *  · 关键词表覆盖本项目实际会出现的形状（网关未连接、超时、限流、上下文超限、额度不足）。
 */
export type HumanizedErrorKind =
  | 'not-connected'
  | 'timeout'
  | 'rate-limit'
  | 'context-length'
  | 'insufficient-credits'
  | 'send-failed';

const RULES: { pattern: RegExp; kind: HumanizedErrorKind }[] = [
  { pattern: /not[- ]?connected|websocket (?:is )?closed|socket hang up|ECONNREFUSED/i, kind: 'not-connected' },
  { pattern: /timeout|timed out|ETIMEDOUT/i, kind: 'timeout' },
  { pattern: /rate limit|429|too many requests/i, kind: 'rate-limit' },
  { pattern: /context[ _-]?length|maximum context|too many tokens/i, kind: 'context-length' },
  { pattern: /insufficient|quota|402|余额|额度/i, kind: 'insufficient-credits' },
];

export function humanizeErrorKind(raw: unknown): HumanizedErrorKind {
  const text = typeof raw === 'string' ? raw : raw instanceof Error ? raw.message : String(raw ?? '');
  for (const rule of RULES) if (rule.pattern.test(text)) return rule.kind;
  return 'send-failed';
}

// 字面量列出：i18n 扫描器只认字面量键（模板拼接会被判成 unused）。
const KEY_BY_KIND: Record<HumanizedErrorKind, string> = {
  'not-connected': 'errors.human.not-connected',
  timeout: 'errors.human.timeout',
  'rate-limit': 'errors.human.rate-limit',
  'context-length': 'errors.human.context-length',
  'insufficient-credits': 'errors.human.insufficient-credits',
  'send-failed': 'errors.human.send-failed',
};

/** 归类 ⇒ i18n key（键位在 `errors.human.*`，九语言齐全）。 */
export function humanizeErrorKey(raw: unknown): string {
  return KEY_BY_KIND[humanizeErrorKind(raw)];
}
