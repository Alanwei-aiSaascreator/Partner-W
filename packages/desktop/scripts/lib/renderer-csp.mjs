// renderer-csp.mjs —— 渲染层 CSP（BUG-056②）：按"实际用到的面"列白名单；
// prod 与 dev 的差异只有 dev 源与 HMR 的 ws。
//
// 为什么不用全局 session.webRequest.onHeadersReceived：同 session 还有两个隐藏窗口
// （docgen 的 data: HTML 与 slidegen 的模型写在 HTML，后者靠内联脚本量框）——全局策略
// 会把这两条链打断或被迫放宽；meta 注入只作用于应用自己的两份文档，且随文档走。
//
// ⚠️ S-R3 复审修正（2026-10-14）：
//   · 每条 directive 只授权**它那一类资源**（img 里写了 data: 不等于 media 能放 data:）。
//     视频预览是 `data:video/...;base64,`（FilePreview.tsx）⇒ media-src 必须含 data:；
//     Markdown 正文远程图片直接赋 img src（MarkdownContent.tsx）⇒ img-src 必须含 https:。
//   · meta 承载的 CSP **不支持 frame-ancestors**（W3C CSP3 "The meta element"）——
//     原来写着也无效，已删除；不要拿"字符串在策略里"当抗嵌入证据（见测试注释）。

export const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // HTML 预览（srcdoc 继承父策略）里是内联 <style>；React style={{}} 走 CSSOM 不受 CSP 管。
  "style-src 'self' 'unsafe-inline'",
  // 图片面：聊天正文图片=file://（MarkdownContent 转的）；头像=自定义协议；附件/PDF 预览=blob:；
  // 内联图片=data:；**Markdown 正文远程图片=https:（组件直接赋 img src）**。
  "img-src 'self' file: data: blob: clawwork-avatar: https:",
  // 媒体面：开场片=clawwork-asset:；**FilePreview 的视频预览=data:（`data:${mime};base64,`）**。
  "media-src 'self' clawwork-asset: data:",
  "font-src 'self' data:",
  "frame-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export function rendererDevCsp(devOrigin) {
  const origin = new URL(devOrigin).origin;
  const ws = origin.replace(/^http/, 'ws');
  return [
    `default-src 'self' ${origin}`,
    `script-src 'self' 'unsafe-inline' ${origin}`, // vite/react 开发期注入内联引导脚本
    `style-src 'self' 'unsafe-inline' ${origin}`,
    `img-src 'self' file: data: blob: clawwork-avatar: https: ${origin}`,
    `media-src 'self' clawwork-asset: data:`,
    `font-src 'self' data:`,
    `frame-src 'self' blob:`,
    `connect-src 'self' ${origin} ${ws}`, // HMR
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'none'`,
  ].join('; ');
}
