import { join } from 'node:path';
import { BrowserWindow, screen, type Display } from 'electron';
import { is } from '@electron-toolkit/utils';
import { getDebugLogger } from '../debug/index.js';

/**
 * 桌面宠物窗口（2026-10-17 用户：「可以拖到桌面，让他在桌面帮忙」）。
 *
 * 无边框 + 透明 + 置顶 + 不进任务栏。窗口里只放小盈与三个动作
 * （看看桌面 / 整理桌面 / 删除…），真正的文件操作在主进程（见 `pet/desktop.ts`）。
 *
 * ⚠️ 它**不是**主窗口的第二个实例：不加载应用路由，靠 `index.html#pet` 这一支
 *    在渲染层切到宠物界面（见 `renderer/pet/PetWindow.tsx`）。
 *
 * 2026-10-18 用户现场：「宠物开局有然后不见了也拖不动，后面消失了。」下面几条是
 * 针对这句话的硬约束（每条都对应一个曾经能把它变没的真实路径）：
 *   ① **显示不能只挂在 `ready-to-show` 上** —— 那是唯一一次 `show()`，渲染进程
 *      没画（preload 卡住/页面崩）就永远不可见，而 `petWindowOpen()` 仍返回 true，
 *      用户再点一次也只会对一个隐藏窗口 `show()`，看上去"再也打不开"。
 *   ② **回调必须绑实例，不能绑模块变量** —— 关掉再开时 `petWindow` 会被覆盖，
 *      `petWindow?.show()` 可能显示的是"下一个"窗口（或对已销毁窗口调用）。
 *   ③ **加载失败/渲染进程崩溃要销毁并记日志** —— 否则窗口变成看不见的黑洞。
 *   ④ **换位置要按窗口真实尺寸夹进工作区**，并且用窗口所在那块屏，不用主屏。
 */
let petWindow: BrowserWindow | null = null;

/** 小窗尺寸（与 `PetWindow.tsx` 的 `h-screen/w-screen` 内容一致，只用于定位计算）。 */
const PET_WIDTH = 240;
const PET_HEIGHT = 300;
/** 贴边留白：窗口不要顶着屏幕边缘/任务栏。 */
const PET_EDGE_MARGIN = 24;
/**
 * `ready-to-show` 兜底。1.5s 是"正常首帧"的宽松上界（同机实测首帧在数百毫秒级）；
 * 到点还没画就直接显示窗口 —— 宁可让用户看见一个空窗，也不要"点了没反应"。
 */
const PET_SHOW_FALLBACK_MS = 1500;

function log(event: string, data?: Record<string, unknown>): void {
  try {
    getDebugLogger().info({ domain: 'app', event, ...(data ? { data } : {}) });
  } catch {
    // 日志系统未初始化时也不能影响开窗
  }
}

/** 把 `size` 夹进 `start..start+span`，两侧各留 `margin`；工作区比窗口还小时贴左上。 */
function clampAxis(start: number, span: number, size: number, margin: number): number {
  const min = start + margin;
  const max = start + Math.max(margin, span - size - margin);
  return Math.min(Math.max(min, start + span - size - margin), max);
}

/** `far=false` 贴起始边（左/上），`far=true` 贴结束边（右/下，按窗口尺寸夹进工作区）。 */
function axisPosition(start: number, span: number, size: number, far: boolean): number {
  return far ? clampAxis(start, span, size, PET_EDGE_MARGIN) : start + PET_EDGE_MARGIN;
}

function cornerPosition(workArea: Display['workArea'], width: number, height: number, right: boolean, bottom: boolean) {
  return {
    x: axisPosition(workArea.x, workArea.width, width, right),
    y: axisPosition(workArea.y, workArea.height, height, bottom),
  };
}

export function petWindowOpen(): boolean {
  return petWindow !== null && !petWindow.isDestroyed();
}

export function openPetWindow(): { ok: true } {
  if (petWindowOpen()) {
    petWindow!.show();
    petWindow!.focus();
    log('pet.window.reopened');
    return { ok: true };
  }
  const { workArea } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    width: PET_WIDTH,
    height: PET_HEIGHT,
    x: clampAxis(workArea.x, workArea.width, PET_WIDTH, PET_EDGE_MARGIN),
    y: clampAxis(workArea.y, workArea.height, PET_HEIGHT, PET_EDGE_MARGIN),
    frame: false,
    transparent: true,
    // 透明窗显式给全透明底色：不给时 Windows 上偶发"首帧白块/整窗不可见"。
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // ⚠️ 必须持有模块级强引用（Electron 会把窗口 GC 掉）；`closed` 时再置空。
  petWindow = win;
  win.setAlwaysOnTop(true, 'screen-saver');
  try {
    const bounds = win.getBounds();
    log('pet.window.open', { x: bounds.x, y: bounds.y });
  } catch {
    // 定位读取失败不影响开窗
  }

  let shown = false;
  const showOnce = (reason: 'ready-to-show' | 'fallback-timeout'): void => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
    log('pet.window.shown', { reason });
  };

  // ① 正常路径 + 兜底：`ready-to-show` 只发一次，且渲染进程没首帧时永远不发。
  win.once('ready-to-show', () => showOnce('ready-to-show'));
  const showFallback = setTimeout(() => showOnce('fallback-timeout'), PET_SHOW_FALLBACK_MS);

  // ③ 加载失败 / 渲染进程崩溃：销毁，让下一次点击能重建；绝不留下"看得见引用、
  //    看不见窗口"的僵尸实例。
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3 = ERR_ABORTED（被打断的导航，不是失败）
    log('pet.window.load-failed', { errorCode, errorDescription, validatedURL });
    if (!win.isDestroyed()) win.destroy();
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    log('pet.window.renderer-gone', { reason: details.reason });
    if (!win.isDestroyed()) win.destroy();
  });

  win.on('closed', () => {
    clearTimeout(showFallback);
    // ② 只有"自己还是当前实例"时才清空：关掉再开的竞态里不能把新窗口的引用抹掉。
    if (petWindow === win) petWindow = null;
    log('pet.window.closed');
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#pet`);
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'), { hash: 'pet' });
  }
  return { ok: true };
}

/** 换个位置（四角轮换，带一点随机）—— 桌面宠物的「走动」。 */
export function movePetWindow(): { ok: true } {
  if (!petWindowOpen()) return { ok: true };
  const win = petWindow!;
  const bounds = win.getBounds();
  // ④ 用窗口**当前所在**那块屏：主屏副屏混用时不能把宠物瞬移到主屏（对用户就是"消失"）。
  const { workArea } = screen.getDisplayMatching(bounds);
  const corners = [
    cornerPosition(workArea, bounds.width, bounds.height, true, true),
    cornerPosition(workArea, bounds.width, bounds.height, false, true),
    cornerPosition(workArea, bounds.width, bounds.height, true, false),
    cornerPosition(workArea, bounds.width, bounds.height, false, false),
  ];
  const pick = corners[Math.floor(Math.random() * corners.length)]!;
  win.setPosition(pick.x, pick.y, true);
  log('pet.window.moved', { x: pick.x, y: pick.y });
  return { ok: true };
}

export function closePetWindow(): { ok: true } {
  if (petWindowOpen()) petWindow!.close();
  return { ok: true };
}
