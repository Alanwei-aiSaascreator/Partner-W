package com.mofangluopan.mobile;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

/**
 * 手机端原生壳入口。
 *
 * ## 为什么手动注入状态栏高度
 *
 * Android 15+ 强制 edge-to-edge：WebView 一直画到状态栏下面，而 **Android WebView 里
 * `env(safe-area-inset-top)` 恒为 0**。Capacitor 的 `adjustMarginsForEdgeToEdge` 与
 * `setDecorFitsSystemWindows` 在这个壳里都被 Bridge 自己的布局逻辑吃掉了（实测三次，
 * 包一装上去顶部还是压着）。
 *
 * 所以不再依赖系统开关：直接读真实 WindowInsets，把像素值塞给页面（CSS 变量
 * `--inset-top` + localStorage 兜住页面重载），页面用 `max(env(...), var(--inset-top))`
 * 自己留白。
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 页面加载有早晚、insets 也可能在首帧之后才稳定：多次注入，谁生效算谁的。
        for (long delay : new long[] {300L, 1000L, 2500L, 5000L}) {
            new Handler(Looper.getMainLooper()).postDelayed(this::injectInsets, delay);
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        // 从后台回来 / 旋转屏幕后 insets 会变，补一次。
        injectInsets();
    }

    private void injectInsets() {
        WebView webView = getBridge() == null ? null : getBridge().getWebView();
        if (webView == null) return;

        WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(getWindow().getDecorView());
        if (insets == null) return;

        int topPx = insets.getInsets(WindowInsetsCompat.Type.systemBars()).top;
        int bottomPx = insets.getInsets(WindowInsetsCompat.Type.systemBars()).bottom;
        float density = getResources().getDisplayMetrics().density;
        int topDp = Math.round(topPx / density);
        int bottomDp = Math.round(bottomPx / density);

        String js = "try{"
                + "document.documentElement.style.setProperty('--inset-top','" + topDp + "px');"
                + "document.documentElement.style.setProperty('--inset-bottom','" + bottomDp + "px');"
                + "localStorage.setItem('mofang_inset_top','" + topDp + "');"
                + "localStorage.setItem('mofang_inset_bottom','" + bottomDp + "');"
                + "}catch(e){}";

        webView.post(() -> webView.evaluateJavascript(js, null));
    }
}
