// renderer-csp.mjs —— 渲染层 CSP（BUG-056②）：按"实际用到的面"列白名单；
// prod 与 dev 的差异只有 dev 源与 HMR 的 ws。
//
// 为什么不用全局 session.webRequest.onHeadersReceived：同 session 还有两个隐藏窗口
// （docgen 的 data: HTML 与 slidegen 的模型写在 HTML，后者靠内联脚本量框）——全局策略
// 会把这两条链打断或被迫放宽；meta 注入只作用于应用自己的两份文档，且随文档走。

export const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // HTML 预览（srcdoc 继承父策略）里是内联 <style>；React style={{}} 走 CSSOM 不受 CSP 管。
  "style-src 'self' 'unsafe-inline'",
  // 聊天正文图片=file://（MarkdownContent 转的）；头像=自定义协议；附件/PDF 预览=blob:；少量 data:。
  "img-src 'self' file: data: blob: clawwork-avatar:",
  "media-src 'self' clawwork-asset:",
  "font-src 'self' data:",
  "frame-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function rendererDevCsp(devOrigin) {
  const origin = new URL(devOrigin).origin;
  const ws = origin.replace(/^http/, 'ws');
  return [
    `default-src 'self' ${origin}`,
    `script-src 'self' 'unsafe-inline' ${origin}`, // vite/react 开发期注入内联引导脚本
    `style-src 'self' 'unsafe-inline' ${origin}`,
    `img-src 'self' file: data: blob: clawwork-avatar: ${origin}`,
    `media-src 'self' clawwork-asset:`,
    `font-src 'self' data:`,
    `frame-src 'self' blob:`,
    `connect-src 'self' ${origin} ${ws}`, // HMR
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'none'`,
    `frame-ancestors 'none'`,
  ].join('; ');
}
