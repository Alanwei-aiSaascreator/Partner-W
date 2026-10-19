import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { useTranslation } from 'react-i18next';
import '../styles/theme.css';
import i18n from '../i18n';
import ErrorBoundary from '../components/ErrorBoundary';
import RepairPanel from '../features/repair/RepairPanel';
import { resolveSystemLanguage } from '../i18n/languages';

/**
 * `荣盈魔方.exe --repair` 的独立窗口（SPEC 一·形态）。
 *
 * ⚠️ 与主界面**不共用 `App.tsx`**，也**不挂 `ThemeProvider`**：后者要读
 *    `settings:get`（设置模块），而修复模式下主进程**只注册 `repair:*` 四条通道** ——
 *    挂上去就是一条必然失败、只会往日志里丢错误的调用（实测确认过）。
 *    主题在这里直接按系统偏好落 `data-theme`，与主界面 `auto` 分支同值。
 *
 * ⚠️ preload 是同一个桥（`window.clawwork`）：别的 invoke 一律没人应答 ——
 *    不是"忘了关"，是没开。
 */

function useSystemTheme(): void {
  useEffect(() => {
    const root = document.documentElement;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (matches: boolean): void => {
      const theme = matches ? 'dark' : 'light';
      root.setAttribute('data-theme', theme);
      root.style.colorScheme = theme;
    };
    apply(query.matches);
    const onChange = (event: MediaQueryListEvent): void => apply(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
}

function RepairApp() {
  const { t } = useTranslation();
  useSystemTheme();
  return (
    <div className="flex h-full flex-col bg-[var(--bg-secondary)]">
      <header className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-5 py-3">
        <h1 className="type-section-title text-[var(--text-primary)]">{t('settings.repair.title')}</h1>
      </header>
      <main className="flex-1 overflow-y-auto px-5 py-4">
        <RepairPanel />
      </main>
    </div>
  );
}

function MissingBridge() {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <p className="type-body text-[var(--danger)]">
        window.clawwork is undefined — the preload bridge did not load.
      </p>
    </div>
  );
}

async function bootstrap(): Promise<void> {
  // 语言先按系统给一个；`RepairPanel` 拿到主进程回传的持久化语言后会再切一次。
  try {
    const system = resolveSystemLanguage();
    if (i18n.language !== system) await i18n.changeLanguage(system);
  } catch {
    // 切不过去就用 i18n 的默认语言
  }
  const root = createRoot(document.getElementById('root') as HTMLElement);
  root.render(
    <React.StrictMode>
      <ErrorBoundary>{window.clawwork ? <RepairApp /> : <MissingBridge />}</ErrorBoundary>
    </React.StrictMode>,
  );
}

void bootstrap();
