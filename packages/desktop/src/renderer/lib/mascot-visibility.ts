/**
 * 「小盈」灵宠的显隐开关（2026-10-18 用户现场：「后面消失了」）。
 *
 * 原来"藏起来"只写一次 localStorage，**没有任何恢复入口**：右下角那个 16×16 的 X
 * 长期不可见（缺 `group`），误触一次灵宠就永久消失。修好可见性之后，仍然需要一条
 * 用户找得到的回头路 —— 设置 → 通用 里的开关。两边共用这一份读写：
 *   · 存储键只在这里定义（禁止各写一份字符串）；
 *   · 变化通过一次自定义事件广播（同窗口写 localStorage 不触发 `storage` 事件）。
 */

export const MASCOT_HIDDEN_KEY = 'rongying-cube:mascot-hidden:v1';
const MASCOT_VISIBILITY_EVENT = 'rongying-cube:mascot-visibility-changed';

export function isMascotHidden(): boolean {
  try {
    return localStorage.getItem(MASCOT_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** 写开关并广播。存不进去也广播（本次会话至少生效）。 */
export function setMascotHidden(hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(MASCOT_HIDDEN_KEY, '1');
    else localStorage.removeItem(MASCOT_HIDDEN_KEY);
  } catch {
    // 存不了就只在本次会话里生效 —— 不把失败变成异常。
  }
  try {
    window.dispatchEvent(new CustomEvent(MASCOT_VISIBILITY_EVENT));
  } catch {
    // 非浏览器环境（测试/主进程）没有 window
  }
}

/** 订阅显隐变化；返回退订函数。 */
export function subscribeMascotVisibility(listener: () => void): () => void {
  const handler = () => listener();
  window.addEventListener(MASCOT_VISIBILITY_EVENT, handler);
  return () => window.removeEventListener(MASCOT_VISIBILITY_EVENT, handler);
}
