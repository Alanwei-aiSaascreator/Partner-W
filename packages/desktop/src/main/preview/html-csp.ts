/**
 * HTML 预览的 CSP。**`default-src 'none'` 一句话禁掉了脚本、外链、表单、框架** ——
 * 只放行内联样式与 `data:` 图片（够看排版，不够把用户的浏览器变成跳板）。
 *
 * ⚠️ 为什么这一道不能省（渲染层已经给了 `sandbox`）：sandbox 是**容器**层的锁，
 *    CSP 是**内容**层的锁。哪天有人为了"让图表动起来"把 `allow-scripts` 松掉，
 *    还有这一道拦着外联；反过来哪天 CSP 被改坏，sandbox 仍然挡住脚本。
 *
 * ⚠️ 单独一个文件是**故意的**：它有两个消费者 —— `build-preview.ts` 往里注入、
 *    `htmlgen/templates.ts` 把同一份写进**我们产出的** `.html` 里
 *    （用户把它拷到浏览器里打开时，那道锁跟着文件走）。两处各抄一份字符串的话，
 *    某天只改一处就会变成"应用里安全、发出去不安全"，而这一点测试很难覆盖到。
 */

export const HTML_PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";
