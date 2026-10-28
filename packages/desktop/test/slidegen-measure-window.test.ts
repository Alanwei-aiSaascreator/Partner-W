import { describe, expect, it, vi } from 'vitest';

/**
 * 🔴 2026-09-28 真机：**多页 deck 从第 2 页起必失败** —— 因为 `measureSlide` 每页都
 * 「新建窗口 → 用完 destroy」。
 *
 * 现场（可复现，不是推测）：一个隐藏窗口 loadFile 成功之后，**紧跟着 destroy 再新建**，
 * 第二次 `loadFile` 一律 `ERR_FAILED (-2)`。对照实验：
 *
 * ```
 * A1 + A2 不销毁连开   -> 都 OK
 * 销毁后再建           -> FAIL: ERR_FAILED (-2)
 * ```
 *
 * 而 `emitPageShapes` 是**逐页**调的 ⇒ 双页 deck 一定在第二页炸。
 * 这条通道**从来没在真机出过一份 deck**，这就是原因。
 *
 * ## 为什么这个测试要 mock electron
 *
 * 真排版要 Chromium，单测里起不来（真链路由探针 + 真机验，见 `docs/`）。
 * 但**"每页新建一次窗口"这件事本身是可以在单测里钉住的** —— 钉的是**窗口复用**这条不变量，
 * 而不是排版结果。窗口数会说话：修好之后，量 N 页只该建 **1** 个窗口。
 */

const mocks = vi.hoisted(() => ({ constructed: 0, destroyed: 0 }));

vi.mock('electron', () => {
  const MEASURED = JSON.stringify([
    { id: 0, tag: 'Text', x: 0, y: 0, w: 100, h: 20, fontSizePx: 16, color: 'rgb(0,0,0)', text: 'x' },
  ]);
  class FakeBrowserWindow {
    webContents = {
      executeJavaScript: vi.fn(async () => MEASURED),
      debugger: {
        isAttached: () => false,
        attach: () => undefined,
        detach: () => undefined,
        sendCommand: async () => ({
          strings: ['data-sg', '0'],
          documents: [{ nodes: { attributes: [[0, 1]] }, layout: { nodeIndex: [0], paintOrders: [1] } }],
        }),
      },
    };
    constructor() {
      mocks.constructed += 1;
    }
    async loadFile() {
      // 真环境里"销毁后再建"的第二次 loadFile 会抛 ERR_FAILED —— 这里不复现那个竞态，
      // 只数窗口。竞态本身由真机探针证。
      return undefined;
    }
    isDestroyed() {
      return false;
    }
    destroy() {
      mocks.destroyed += 1;
    }
    on() {
      return this;
    }
  }
  return { BrowserWindow: FakeBrowserWindow };
});

const { measureSlide } = await import('../src/main/slidegen/measure.js');

describe('measureSlide：窗口要复用，不能每页新建又销毁', () => {
  it('⭐ 量三页只该建 1 个窗口（每页新建 ⇒ 第 2 页起 ERR_FAILED）', async () => {
    mocks.constructed = 0;

    await measureSlide('<div>第一页</div>', null);
    await measureSlide('<div>第二页</div>', null);
    await measureSlide('<div>第三页</div>', null);

    expect(
      mocks.constructed,
      '每页新建一个窗口 ⇒ 紧跟着的 loadFile 会 ERR_FAILED（真机实测）⇒ 多页 deck 永远做不出来',
    ).toBe(1);
  });

  it('⭐ 不许把复用的那个窗口销毁掉（销毁了下一轮又要新建 ⇒ 同样的坑）', async () => {
    mocks.constructed = 0;
    mocks.destroyed = 0;

    await measureSlide('<div>甲</div>', null);
    await measureSlide('<div>乙</div>', null);

    expect(mocks.destroyed, '复用的窗口不能在被复用期间被销毁').toBe(0);
  });

  it('量出来的元素照旧返回（复用窗口不能把结果弄丢）', async () => {
    const one = await measureSlide('<div>甲</div>', null);
    const two = await measureSlide('<div>乙</div>', null);

    expect(one.length).toBeGreaterThan(0);
    expect(two.length).toBeGreaterThan(0);
  });
});
