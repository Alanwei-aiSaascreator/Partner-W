import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';

/**
 * 原生壳（Android/iOS）的窗口初始化。
 *
 * ## 为什么要显式关掉 WebView 覆盖状态栏
 *
 * Android 7.0+ 默认允许应用内容画到状态栏下面，而 **Android WebView 里的
 * `env(safe-area-inset-top)` 恒为 0** —— 也就是说 CSS 里写
 * `padding-top: env(safe-area-inset-top)` 在 Android 上等于没写。真机表现：
 * 顶部那排（汉堡按钮）被状态栏压住、点不到。
 *
 * 关掉 overlay 之后，WebView 的坐标系从状态栏下沿开始，CSS 不用再猜。
 */
export async function initNativeShell(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  const dark = document.documentElement.dataset.theme !== 'light';
  const background = dark ? '#13131c' : '#f4f3ef';

  try {
    // ⚠️ 不要在这里 setOverlaysWebView({ overlay: false })：它和页面的 inset 留白会叠加，
    //    导致顶部空出两条。真正的留白交给 --inset-top（MainActivity 注入的真实值）。
    await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light });
    await StatusBar.setBackgroundColor({ color: background });
  } catch {
    // 插件不可用（纯网页 / 旧壳）时静默：网页版由浏览器自己处理安全区。
  }
}
