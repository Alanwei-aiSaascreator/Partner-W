/**
 * 从 `sessions.list` 的返回里读**某一个会话的真实权限模式**。
 *
 * ⚠️ 存在的理由（spec §2.4）：界面上的档位必须来自**网关读回来的真值**，
 *    不是本地那个开关的猜测。两者会漂：在任务 A 里开了全权、切到任务 B 关掉开关
 *    —— A 仍然是 full，除非有人去读它。「界面在说谎」是本项目栽过最多的形状。
 *
 * ⚠️ **只认 `'full'`**。运行时其实有四个模式，其中 `workspace` 也**不**解除工作区限制
 *    （`workspaceOnly = policy.mode !== 'full'`）⇒ "不是 guarded 就算全权"是错的。
 *    认不出的一律**不算全权**（fail-closed）。
 */

/** 网关那边 `full` 的字面量。**唯一**表示"能碰整台电脑"的值。 */
const FULL_ACCESS_MODE = 'full';

export function isFullAccessMode(mode: unknown): boolean {
  return mode === FULL_ACCESS_MODE;
}

/**
 * 在 `sessions.list` 的返回里按会话键找 `permissionMode`。
 *
 * 形状宽容一点（网关两种包法都出现过）：既接裸数组，也接 `{ sessions: [...] }`。
 * 任何读不出来的情况都回 `null`，**不抛** —— 徽章读不到就是"不显示全权"，
 * 绝不该把整个输入框带崩。
 */
export function findPermissionMode(rows: unknown, sessionKey: string | null | undefined): string | null {
  if (!sessionKey) return null;
  const list = Array.isArray(rows)
    ? rows
    : rows && typeof rows === 'object' && Array.isArray((rows as { sessions?: unknown }).sessions)
      ? (rows as { sessions: unknown[] }).sessions
      : null;
  if (!list) return null;

  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const entry = row as { key?: unknown; sessionKey?: unknown; permissionMode?: unknown };
    const key = typeof entry.key === 'string' ? entry.key : entry.sessionKey;
    if (key !== sessionKey) continue;
    return typeof entry.permissionMode === 'string' ? entry.permissionMode : null;
  }
  return null;
}
