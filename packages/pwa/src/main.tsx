import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { Capacitor } from '@capacitor/core';
import { swUpdateStore } from './stores/sw-update-store';
import './i18n';
import './styles/index.css';
import App from './App';
import { initNativeShell } from './platform/native-shell';

// 原生壳里先把窗口布局理顺（关掉 WebView 覆盖状态栏），再渲染 React。
// 不 await：它失败也不该挡住界面，网页版直接返回。
void initNativeShell();

// 原生壳注入的状态栏高度存在 localStorage：页面重载后 CSS 变量会丢，这里补回来。
// （Android WebView 的 env(safe-area-inset-top) 恒为 0，所以不能只靠 CSS。）
try {
  const insetTop = Number(localStorage.getItem('mofang_inset_top') || '0');
  const insetBottom = Number(localStorage.getItem('mofang_inset_bottom') || '0');
  if (insetTop > 0) document.documentElement.style.setProperty('--inset-top', `${insetTop}px`);
  if (insetBottom > 0) document.documentElement.style.setProperty('--inset-bottom', `${insetBottom}px`);

  // 兜底：原生注入万一没跑（首次启动时序、权限变化），安卓上按 24px 留白，
  // 至少不会让顶部按钮压在状态栏下面点不到。
  const isNative = typeof window !== 'undefined' && 'Capacitor' in window;
  if (isNative && !(insetTop > 0)) {
    document.documentElement.style.setProperty('--inset-top', '24px');
  }
} catch {
  /* storage unavailable */
}

/**
 * ⚠️ Service Worker 只在浏览器 PWA 里注册。
 *
 * 原生壳（Capacitor）里**绝不注册**：App 加载的是本地 dist-app 资源，SW 只会
 * 用磁盘里缓存的旧 bundle 响应页面 —— 装新 APK 后界面仍是旧版（真机 2026-10-22：
 * 语音按钮「装新包还是看不到」，bundle 却是新的，就是 SW 旧缓存挡的）。
 * 本地资源没有离线更新的需求，绕开 SW 反而让「装包即新版」成立。
 */
if (Capacitor.isNativePlatform()) {
  // 清掉历史版本注册过的 SW：不主动 unregister，旧 SW 会继续拦截页面，
  // 「装新包还是旧界面」依然成立。
  if ('serviceWorker' in navigator) {
    void navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => {
        for (const registration of registrations) void registration.unregister();
      })
      .catch(() => undefined);
  }
} else {
  const updateServiceWorker = registerSW({
    immediate: true,
    onRegisteredSW(_swUrl: string, registration: ServiceWorkerRegistration | undefined) {
      if (!registration) return;
      swUpdateStore.getState().setRegistration(registration);
    },
    onNeedRefresh() {
      swUpdateStore.getState().setUpdateReady(() => updateServiceWorker(true));
    },
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
