/**
 * HTML 转义：内容来自**助手**，必须当成**数据**而不是标记。
 *
 * ## 为什么单独一个文件
 *
 * 这份实现原来只长在 `docgen/render-pdf.ts` 里。htmlgen 也要用它，而从那里 import
 * 会把整个 `render-pdf.js` 拉进来 —— 那个模块**顶层 import 了 electron**，
 * 于是任何想在纯 Node 里测 htmlgen 渲染的地方都得先有一份能用的 electron 安装。
 * 渲染是**纯字符串**的事，不该带上那个包袱。
 *
 * ⚠️ 两个调用点必须用**同一份**转义：各写一份时，一边补了 `'` 另一边没补这种事
 *    不会有任何测试发现（它只在属性上下文里出问题），而后果是注入。
 *
 * ⚠️ 单引号**也转**：转义函数会被用进属性值（`title="…"`），而属性用单引号包裹是合法写法。
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
