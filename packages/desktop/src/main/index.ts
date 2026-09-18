import { app, shell, BrowserWindow, Menu, ipcMain, globalShortcut, dialog, protocol } from 'electron';
import { join } from 'path';
import { electronApp, is } from '@electron-toolkit/utils';
import { nativeTheme } from 'electron';
import { initAllGateways, destroyAllGateways } from './ws/index.js';
import { getMainWindow, setMainWindow } from './window-manager.js';
import { initDebugLogger, getDebugLogger } from './debug/index.js';
import { registerWsHandlers } from './ipc/ws-handlers.js';
import { registerArtifactHandlers } from './ipc/artifact-handlers.js';
import { registerInboxHandlers } from './ipc/inbox-handlers.js';
import { registerMediaHandlers } from './ipc/media-handlers.js';
import { registerWorkspaceHandlers } from './ipc/workspace-handlers.js';
import { registerSettingsHandlers } from './ipc/settings-handlers.js';
import { registerSearchHandlers } from './ipc/search-handlers.js';
import { registerDataHandlers } from './ipc/data-handlers.js';
import { registerStatsHandlers } from './ipc/stats-handlers.js';
import { registerUpdateHandlers } from './ipc/update-handlers.js';
import { registerDebugHandlers } from './ipc/debug-handlers.js';
import { configureVoicePermissionHandlers, registerVoiceHandlers } from './ipc/voice-handlers.js';
import { registerTrayHandlers } from './ipc/tray-handlers.js';
import { registerQuickLaunchHandlers } from './ipc/quick-launch-handlers.js';
import { registerContextHandlers } from './ipc/context-handlers.js';
import { registerNotificationHandlers } from './ipc/notification-handlers.js';
import { registerAvatarHandlers, registerAvatarProtocol } from './ipc/avatar-handlers.js';
import { registerHubHandlers } from './ipc/hub-handlers.js';
import { registerCommercialHandlers } from './ipc/commercial-handlers.js';
import { registerCommunityHandlers } from './ipc/community-handlers.js';
import { registerMarketHandlers } from './ipc/market-handlers.js';
import { registerGrowthHandlers } from './ipc/growth-handlers.js';
import { registerAnalyticsHandlers } from './ipc/analytics-handlers.js';
import { setupAnalytics, teardownAnalytics } from './analytics/setup.js';
import { initUsageReporter, destroyUsageReporter } from './commercial/usage-reporter.js';
import { bootstrapCommercialRelay } from './commercial/relay-startup.js';
import { unwatchAll } from './context/file-watcher.js';
import { isInstallingUpdate } from './auto-updater.js';
import { initTray, destroyTray } from './tray.js';
import { initQuickLaunch, destroyQuickLaunch } from './quick-launch.js';
import { getWorkspacePath, getDefaultWorkspacePath, readConfig, updateConfig } from './workspace/config.js';
import { initDatabase, closeDatabase } from './db/index.js';
import { applyUserDataOverride } from './runtime/user-data-override.js';
import { bootstrapLocalGatewayRuntime, shutdownLocalGatewayRuntime } from './runtime/index.js';

protocol.registerSchemesAsPrivileged([
  { scheme: 'clawwork-avatar', privileges: { secure: true, supportFetchAPI: true } },
]);

let isQuitting = false;
let devModeEnabled = false;

process.stdout?.on?.('error', () => {});
process.stderr?.on?.('error', () => {});

// Opt-in CDP endpoint for local debugging (CLAUDEW_DEBUG_PORT=9222).
// Off unless the env var is set, so packaged builds are unaffected.
if (process.env.CLAUDEW_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.CLAUDEW_DEBUG_PORT);
}

function buildAppMenu(devMode = false): Menu {
  const isMac = process.platform === 'darwin';
  const viewSubmenu: Electron.MenuItemConstructorOptions[] = [
    { role: 'resetZoom' as const },
    { role: 'zoomIn' as const },
    { role: 'zoomOut' as const },
    { type: 'separator' as const },
    { role: 'togglefullscreen' as const },
  ];
  if (devMode || is.dev) {
    viewSubmenu.push({ type: 'separator' as const }, { role: 'reload' as const }, { role: 'toggleDevTools' as const });
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const, accelerator: 'Command+H' },
              { role: 'hideOthers' as const, accelerator: 'Command+Alt+H' },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const, accelerator: 'Command+Q' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' as const, accelerator: 'Command+W' } : { role: 'quit' as const }],
    },
    { role: 'editMenu' as const },
    {
      label: 'View',
      submenu: viewSubmenu,
    },
    ...(isMac
      ? [
          {
            label: 'Window',
            submenu: [
              { role: 'minimize' as const, accelerator: 'Command+M' },
              { role: 'zoom' as const },
              { type: 'separator' as const },
              { role: 'front' as const },
            ],
          },
        ]
      : []),
  ];
  return Menu.buildFromTemplate(template);
}

function createWindow(): BrowserWindow {
  getDebugLogger().info({ domain: 'app', event: 'app.window.create' });
  devModeEnabled = readConfig()?.devMode === true;
  Menu.setApplicationMenu(buildAppMenu(devModeEnabled));

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: (() => {
      const t = readConfig()?.theme;
      const dark = t === 'light' ? false : t === 'dark' ? true : nativeTheme.shouldUseDarkColors;
      return dark ? '#1C1C1C' : '#FAFAFA';
    })(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.on('close', (e) => {
    if (!isQuitting && !isInstallingUpdate()) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('ready-to-show', () => {
    const savedZoom = readConfig()?.zoomLevel;
    if (savedZoom) {
      win.webContents.setZoomLevel(savedZoom);
    }
    win.show();
  });

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    if ((input.meta || input.control) && (input.key === '-' || input.key === '_')) {
      const level = win.webContents.getZoomLevel() - 0.5;
      win.webContents.setZoomLevel(level);
      updateConfig({ zoomLevel: level });
      event.preventDefault();
      return;
    }

    if (is.dev || devModeEnabled) return;

    const isReload = input.key === 'F5' || ((input.meta || input.control) && input.code === 'KeyR');
    if (isReload) event.preventDefault();
  });

  win.on('blur', () => {
    if (win.isDestroyed()) return;
    const level = win.webContents.getZoomLevel();
    const saved = readConfig()?.zoomLevel ?? 0;
    if (level !== saved) {
      updateConfig({ zoomLevel: level });
    }
  });

  win.webContents.setWindowOpenHandler((details) => {
    try {
      const parsed = new URL(details.url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        shell.openExternal(details.url);
      }
    } catch {}
    return { action: 'deny' };
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  setMainWindow(win);
  return win;
}

// ⚠️ 必须在 `app.ready` **之前**：userData 路径要在建窗口/建数据库之前就定下来。
// 仅 dev/test 且显式设了 CLAWWORK_USER_DATA_DIR 时生效 —— 这是模拟"新用户"的
// **唯一**合法手段（绝不靠删真实 %APPDATA%，见 junction 事故）。
applyUserDataOverride({ app, isPackaged: app.isPackaged });

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    initDebugLogger(app.getPath('logs'));
    getDebugLogger().info({ domain: 'app', event: 'app.start', data: { userData: app.getPath('userData') } });
    electronApp.setAppUserModelId('com.mofangluopan.app');

    registerWsHandlers();
    registerArtifactHandlers();
    registerInboxHandlers();
    registerMediaHandlers();
    registerWorkspaceHandlers();
    registerSettingsHandlers();
    registerSearchHandlers();
    registerDataHandlers();
    registerStatsHandlers();
    registerUpdateHandlers();
    registerDebugHandlers();
    registerVoiceHandlers();
    configureVoicePermissionHandlers();
    registerTrayHandlers();
    registerQuickLaunchHandlers();
    registerContextHandlers();
    registerNotificationHandlers();
    registerAvatarHandlers();
    registerAvatarProtocol();
    registerHubHandlers();
    registerCommercialHandlers();
    registerCommunityHandlers();
    registerMarketHandlers();
    registerGrowthHandlers();
    registerAnalyticsHandlers();

    ipcMain.handle('app:rebuild-menu', () => {
      devModeEnabled = readConfig()?.devMode === true;
      Menu.setApplicationMenu(buildAppMenu(devModeEnabled));
    });

    ipcMain.on('ui:set-window-button-visibility', (_event, visible: boolean) => {
      if (process.platform === 'darwin') {
        const win = getMainWindow();
        if (win) win.setWindowButtonVisibility(visible);
      }
    });

    const wsPath = getWorkspacePath() || getDefaultWorkspacePath();
    getDebugLogger().info({ domain: 'workspace', event: 'workspace.detected', data: { workspacePath: wsPath } });
    try {
      getDebugLogger().info({ domain: 'db', event: 'db.init.start', data: { workspacePath: wsPath } });
      initDatabase(wsPath);
      getDebugLogger().info({ domain: 'db', event: 'db.init.ok', data: { workspacePath: wsPath } });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      getDebugLogger().error({
        domain: 'db',
        event: 'db.init.failed',
        data: { workspacePath: wsPath },
        error: { name: err.name, message: err.message, stack: err.stack },
      });
      dialog.showErrorBox('Database Error', err.message);
      app.quit();
      return;
    }

    // ⚠️ 埋点必须**在开窗之前**初始化：窗口一开，登录/激活的 IPC 就活了，
    //    而下面那次运行时就绪等待在首跑要 37–74 秒 —— 用户在这段里完成登录/激活时，
    //    未初始化的 `trackEvent` 是**静默 no-op**（无日志、无重试），首跑最关键的
    //    `login_success` / `license_activated` 会直接丢掉。
    setupAnalytics();

    // 窗口先出来，别像卡死 —— 首次启动要解压 35k 个文件（1–3 分钟）
    createWindow();

    // ⚠️ 拉起本机运行时（定位 → 部署 → 起网关 → 等就绪）。**这一步永不抛**：
    // 失败只是"网关没起来"，界面照常出，让 ConnectionBanner 说真话；
    // 上一轮留下的、或用户自己的网关可能还活着，下面 initAllGateways() 照样要去连它。
    const runtimeResult = await bootstrapLocalGatewayRuntime({ userDataDir: app.getPath('userData') });
    if (!runtimeResult.ok) {
      getDebugLogger().error({
        domain: 'gateway',
        event: 'runtime.bootstrap.failed',
        data: { code: runtimeResult.code, reason: runtimeResult.reason },
      });
    }

    initAllGateways();

    // ⚠️ **runtime ready ≠ commercial ready**：网关活着只说明连得上；模型能不能用
    // 要看中转配置有没有落到网关（clawrouter provider）。
    //
    // 刻意**不 await**：这一步要等网关握手、要问服务端要 key，首次启动可能十几秒 ——
    // 挡住的话窗口白屏。也不抛（内部永不抛），因为"没登录/没激活"是**正常状态**，
    // 不是启动失败；界面自己有未激活的表达。
    //
    // 目录刷新靠 dispatcher 既有的退避重试（~60s 预算，见 gateway-dispatcher），
    // 它本来就是为"网关目录还没热"这件事写的。
    void bootstrapCommercialRelay().then((res) => {
      getDebugLogger().info({ domain: 'commercial', event: 'commercial.relay.bootstrap', data: { ...res } });
    });

    // 放在网关之后：首跑要立刻读一次额度，此时会话/配置已就绪，否则首报必然是空
    initUsageReporter();
    initTray();
    initQuickLaunch();

    app.on('activate', () => {
      const win = getMainWindow();
      if (win) {
        win.show();
        win.focus();
      } else {
        createWindow();
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;

  const logger = getDebugLogger();
  logger.info({ domain: 'app', event: 'app.before-quit', data: { installingUpdate: isInstallingUpdate() } });

  // Flush pending debug log writes before exit, then complete shutdown
  logger
    .flush()
    .catch(() => {})
    .finally(() => {
      globalShortcut.unregisterAll();
      unwatchAll();
      // 先掐定时器，否则拆网关的过程中还会触发一次上报，撞上半死会话
      destroyUsageReporter();
      // 顺手把队列里剩下的事件发出去（最后一次 flush 只在这一刻发生）
      teardownAnalytics();
      // ⚠️ 只有 ownership==='spawned' 才会真的停 —— 复用的网关是**先于客户端存在**的，
      // 绝不能因为用户关掉客户端就把它带走（判断在 stopGatewayIfOwned 里，有单测钉住）
      void shutdownLocalGatewayRuntime()
        .catch((err) => {
          // 收尾失败**绝不能**挡住退出 —— 记一笔就继续
          console.error('[runtime] 退出时收尾失败（忽略，继续退出）:', err);
        })
        .finally(() => {
          destroyAllGateways();
          destroyTray();
          destroyQuickLaunch();
          closeDatabase();
          app.quit();
        });
    });
});
