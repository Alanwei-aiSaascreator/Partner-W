import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 桌面宠物窗口（2026-10-18 用户现场：「宠物开局有然后不见了也拖不动，后面消失了。」）
 *
 * 这个档钉死三件曾经能把它"变没"的事：
 *  ① `ready-to-show` 是**唯一**一次 `show()` —— 渲染进程没首帧就永远不可见，
 *     而 `petWindowOpen()` 仍返回 true，用户再点只会对一个隐藏窗口 `show()`；
 *  ② 加载失败/渲染进程崩溃后窗口留在"看不见但存在"的僵尸态；
 *  ③ 换位置时用主屏 + 硬编码偏移 ⇒ 副屏用户点"走动"会把宠物瞬移到别处（体感=消失）。
 *
 * ⚠️ 每条用例都拿一份**全新**模块实例（`vi.resetModules()` + 动态 import）：
 *    `petWindow` 是模块级的，共享会让断言互相污染。
 */

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FakeWindowOptions {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  frame?: boolean;
  transparent?: boolean;
  alwaysOnTop?: boolean;
  skipTaskbar?: boolean;
  show?: boolean;
  resizable?: boolean;
  hasShadow?: boolean;
  webPreferences?: Record<string, unknown>;
}

interface FakeWindow {
  options: FakeWindowOptions;
  bounds: Rect;
  destroyed: boolean;
  shown: number;
  focused: number;
  loadFileCalls: { file: string; options?: { hash?: string } }[];
  loadURLCalls: string[];
  webContents: {
    emit: (event: string, ...args: unknown[]) => void;
  };
  emit: (event: string, ...args: unknown[]) => void;
  close: () => void;
}

const mocks = vi.hoisted(() => ({
  instances: [] as FakeWindow[],
  log: [] as { event: string; data?: Record<string, unknown> }[],
  primary: { x: 0, y: 0, width: 1920, height: 1080 } as Rect,
  matching: null as Rect | null,
}));

vi.mock('electron', () => {
  type Handler = (...args: unknown[]) => void;

  class FakeWebContents {
    private handlers = new Map<string, Handler[]>();

    on(event: string, handler: Handler): void {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
  }

  class FakeBrowserWindow implements FakeWindow {
    options: FakeWindowOptions;
    bounds: Rect;
    destroyed = false;
    shown = 0;
    focused = 0;
    loadFileCalls: { file: string; options?: { hash?: string } }[] = [];
    loadURLCalls: string[] = [];
    webContents = new FakeWebContents();
    private handlers = new Map<string, Handler[]>();

    constructor(options: FakeWindowOptions) {
      this.options = options;
      this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width ?? 0, height: options.height ?? 0 };
      mocks.instances.push(this);
    }

    private register(event: string, handler: Handler, once: boolean): void {
      const wrapped: Handler = once
        ? (...args: unknown[]) => {
            this.remove(event, wrapped);
            handler(...args);
          }
        : handler;
      const list = this.handlers.get(event) ?? [];
      list.push(wrapped);
      this.handlers.set(event, list);
    }

    private remove(event: string, handler: Handler): void {
      const list = this.handlers.get(event) ?? [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    }

    on(event: string, handler: Handler): void {
      this.register(event, handler, false);
    }

    once(event: string, handler: Handler): void {
      this.register(event, handler, true);
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of [...(this.handlers.get(event) ?? [])]) handler(...args);
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }

    destroy(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('closed');
    }

    close(): void {
      this.destroy();
    }

    show(): void {
      this.shown += 1;
    }

    focus(): void {
      this.focused += 1;
    }

    getBounds(): Rect {
      return this.bounds;
    }

    setPosition(x: number, y: number): void {
      this.bounds = { ...this.bounds, x, y };
    }

    setAlwaysOnTop(): void {}

    loadFile(file: string, options?: { hash?: string }): Promise<void> {
      this.loadFileCalls.push({ file, options });
      return Promise.resolve();
    }

    loadURL(url: string): Promise<void> {
      this.loadURLCalls.push(url);
      return Promise.resolve();
    }
  }

  return {
    BrowserWindow: FakeBrowserWindow,
    screen: {
      getPrimaryDisplay: () => ({ workArea: mocks.primary }),
      getDisplayMatching: () => ({ workArea: mocks.matching ?? mocks.primary }),
    },
  };
});

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));

vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: () => ({
    info: (input: { event: string; data?: Record<string, unknown> }) => mocks.log.push(input),
  }),
}));

interface PetWindowModule {
  openPetWindow: () => { ok: true };
  movePetWindow: () => { ok: true };
  closePetWindow: () => { ok: true };
  petWindowOpen: () => boolean;
}

async function loadModule(): Promise<PetWindowModule> {
  vi.resetModules();
  return (await import('../src/main/pet/window.js')) as unknown as PetWindowModule;
}

beforeEach(() => {
  mocks.instances.length = 0;
  mocks.log.length = 0;
  mocks.primary = { x: 0, y: 0, width: 1920, height: 1080 };
  mocks.matching = null;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('桌面宠物窗口', () => {
  it('建窗参数：无边框/透明/置顶/不进任务栏，先隐藏再显示', async () => {
    const pet = await loadModule();
    pet.openPetWindow();
    const win = mocks.instances[0]!;

    expect(win.options).toMatchObject({
      width: 240,
      height: 300,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
    });
    expect(win.options.webPreferences?.sandbox).toBe(true);
    expect(win.loadFileCalls).toHaveLength(1);
    expect(win.loadFileCalls[0]!.options?.hash).toBe('pet');
  });

  it('ready-to-show 到了就显示', async () => {
    const pet = await loadModule();
    pet.openPetWindow();
    const win = mocks.instances[0]!;
    expect(win.shown).toBe(0);
    win.emit('ready-to-show');
    expect(win.shown).toBe(1);
    // 重复触发不会再 show（once）
    win.emit('ready-to-show');
    expect(win.shown).toBe(1);
  });

  it('⭐ ready-to-show 一直不来时用兜底定时器显示（否则窗口永远不可见）', async () => {
    vi.useFakeTimers();
    const pet = await loadModule();
    pet.openPetWindow();
    const win = mocks.instances[0]!;

    vi.advanceTimersByTime(1600);
    expect(win.shown).toBe(1);
    expect(
      mocks.log.some((entry) => entry.event === 'pet.window.shown' && entry.data?.reason === 'fallback-timeout'),
    ).toBe(true);
  });

  it('⭐ 渲染进程崩溃 ⇒ 销毁窗口（不留"看不见但 open"的僵尸），下次点击能重建', async () => {
    const pet = await loadModule();
    pet.openPetWindow();
    const first = mocks.instances[0]!;

    first.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(first.destroyed).toBe(true);
    expect(pet.petWindowOpen()).toBe(false);
    expect(mocks.log.some((entry) => entry.event === 'pet.window.renderer-gone')).toBe(true);

    pet.openPetWindow();
    expect(mocks.instances).toHaveLength(2);
    expect(pet.petWindowOpen()).toBe(true);
  });

  it('⭐ 主框架加载失败（非 ERR_ABORTED）同样销毁；ERR_ABORTED 不算失败', async () => {
    const pet = await loadModule();
    pet.openPetWindow();
    const first = mocks.instances[0]!;

    first.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'file:///index.html#pet', true);
    expect(first.destroyed).toBe(false);

    first.webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///index.html#pet', true);
    expect(first.destroyed).toBe(true);
    expect(pet.petWindowOpen()).toBe(false);
  });

  it('⭐ 关掉再开：旧窗口迟到的 ready-to-show 不能作用到新窗口', async () => {
    const pet = await loadModule();
    pet.openPetWindow();
    const first = mocks.instances[0]!;
    first.close();
    expect(pet.petWindowOpen()).toBe(false);

    pet.openPetWindow();
    const second = mocks.instances[1]!;
    expect(second).not.toBe(first);

    // 旧窗口的闭包如果绑的是模块变量，这里会把"下一个"窗口 show 出来
    first.emit('ready-to-show');
    expect(second.shown).toBe(0);
  });

  it('⭐ movePetWindow 用窗口所在屏，并把窗口夹在该屏工作区内（副屏不会"消失"）', async () => {
    const pet = await loadModule();
    mocks.primary = { x: 0, y: 0, width: 1920, height: 1080 };
    mocks.matching = { x: 1920, y: 0, width: 800, height: 600 };
    pet.openPetWindow();
    const win = mocks.instances[0]!;
    // 宠物现在在副屏上
    win.bounds = { x: 2000, y: 100, width: 240, height: 300 };
    vi.spyOn(Math, 'random').mockReturnValue(0);

    pet.movePetWindow();

    expect(win.bounds.x).toBeGreaterThanOrEqual(1920 + 24);
    expect(win.bounds.x + win.bounds.width).toBeLessThanOrEqual(1920 + 800);
    expect(win.bounds.y).toBeGreaterThanOrEqual(0 + 24);
    expect(win.bounds.y + win.bounds.height).toBeLessThanOrEqual(600);
  });

  it('窗口没开时 move/close 是安全空操作', async () => {
    const pet = await loadModule();
    expect(pet.petWindowOpen()).toBe(false);
    expect(pet.movePetWindow()).toEqual({ ok: true });
    expect(pet.closePetWindow()).toEqual({ ok: true });
    expect(mocks.instances).toHaveLength(0);
  });

  it('已开着再点"放到桌面"只 show+focus，不重建窗口', async () => {
    const pet = await loadModule();
    pet.openPetWindow();
    const win = mocks.instances[0]!;
    pet.openPetWindow();
    expect(mocks.instances).toHaveLength(1);
    expect(win.shown).toBe(1);
    expect(win.focused).toBe(1);
  });
});
