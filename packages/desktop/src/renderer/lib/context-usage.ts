/**
 * 上下文占用百分比的唯一换算口径（2026-10-17）。
 *
 * 现场 bug：顶栏把分母写死成 200,000，而模型目录里声明的窗口更大（100 万级）⇒
 * 真实占用 100 万 token 时显示「上下文 500%」，用户不知道那是什么意思。
 *
 * 口径：
 *   · 分母 = 当前模型目录条目的 `contextWindow`；缺失/非法（≤0 / NaN / 非数字）才回落 200k；
 *   · 显示夹在 0–100（超过 100 是"窗口已经不够"，不是"用了 5 个窗口"）；
 *   · 没有读数（null / undefined / 0 / 负数）⇒ `null`，界面不显示这一行。
 */

/** 目录没声明时的安全默认（不是产品承诺，只是别拿 0 去除）。 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

export function resolveContextWindow(entry: { contextWindow?: unknown } | undefined | null): number {
  const value = entry?.contextWindow;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return DEFAULT_CONTEXT_WINDOW;
}

export function contextUsagePercent(contextTokens: number | null | undefined, contextWindow: number): number | null {
  if (typeof contextTokens !== 'number' || !Number.isFinite(contextTokens) || contextTokens <= 0) return null;
  const window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW;
  return Math.min(100, Math.round((contextTokens / window) * 100));
}
