import type { CapacitorConfig } from '@capacitor/cli';

/**
 * 手机端原生壳（Android/iOS）配置。
 *
 * 设计要点：
 * - webDir=dist：App 加载**本地**资源（https://localhost），启动不依赖网络；
 * - 连的是远程网关 wss（frp 隧道），Origin 会是 https://localhost /
 *   capacitor://localhost，所以桌面端写 allowedOrigins 时必须带上这两个（已处理）；
 * - 关键凭据（网关地址、设备 token、设备私钥）走 Preferences（原生存储），
 *   不放在 WebView 的 IndexedDB 里 —— 这是"断联后不用再扫码"的前提。
 */
const config: CapacitorConfig = {
  appId: 'com.mofangluopan.mobile',
  appName: '魔方罗盘',
  webDir: 'dist-app',
  android: {
    allowMixedContent: false,
    backgroundColor: '#ffffff',
    /**
     * Android 15+ 强制 edge-to-edge：WebView 会画到状态栏下面，而 Android WebView 的
     * `env(safe-area-inset-top)` 恒为 0 —— CSS 留白无效，顶部按钮就被状态栏压住点不到。
     * `force` 让 Capacitor 自己给 WebView 加 margin 让开状态栏/导航栏。
     */
    adjustMarginsForEdgeToEdge: 'force',
  },
  server: {
    androidScheme: 'https',
    iosScheme: 'capacitor',
  },
  plugins: {
    Preferences: {
      // 单独分组，避免与其它插件的 key 撞车
      group: 'MofangCompass',
    },
  },
};

export default config;
