/**
 * 在**真实浏览器引擎**里渲染一页，量出每个元素最终落在哪。
 *
 * ⭐ 整个方案的支点：**排版交给 Chromium，我们只记录结果。**
 *    flex / 换行 / 居中 / 绝对定位全部由它算完，我们拿到矩形之后，
 *    在 pptx 里**绝对定位**放回去。所以这里不需要实现任何布局引擎。
 *
 * 用的是 Electron 自带的隐藏窗口（不是 playwright）—— 产品里只有它。
 * `render-pdf.ts` 早就在用同一招（隐藏窗口 + `printToPDF`）。
 */
import { BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MARK_ATTR, MARK_KIND_ATTR, SLIDE_CANVAS, slideDocument } from './layout.js';

export interface MeasuredElement {
  id: number;
  kind: 'slide' | 'box' | 'text' | 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  fontSize: number;
  fontWeight: string;
  color: string;
  textAlign: string;
  letterSpacing: number;
  background: string;
  backgroundImage: string;
  borderRadius: number;
  borderWidth: number;
  borderColor: string;
  src?: string;
  /** 这行文字**实际占几行**（浏览器说了算）。单行的框在 pptx 里必须 `wrap:false`。 */
  lines: number;
  /**
   * 它是不是**被人盖住了**（中心点上 topmost 的不是它自己）。
   * 由浏览器用 `elementFromPoint` 回答 —— 我们按 DOM 顺序画，所以这个结论在 pptx 里同样成立。
   * 有值就说明**源版式有重叠**，属于校验器要报的东西。
   */
  occludedBy: string | null;
}

/** 浏览器里跑的量框脚本（在渲染进程执行）。 */
const MEASURE_SCRIPT = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('[${MARK_ATTR}]')) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const kind = el.getAttribute('${MARK_KIND_ATTR}');
    const range = document.createRange();
    range.selectNodeContents(el);
    let occludedBy = null;
    if (r.width >= 1 && r.height >= 1) {
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      if (top && top !== el && !el.contains(top)) {
        const owner = top.closest('[${MARK_ATTR}]');
        occludedBy = owner && owner !== el ? '#' + owner.getAttribute('${MARK_ATTR}') : top.tagName;
      }
    }
    out.push({
      id: Number(el.getAttribute('${MARK_ATTR}')), kind,
      x: r.x, y: r.y, w: r.width, h: r.height,
      text: kind === 'text' ? el.textContent.trim() : '',
      fontSize: parseFloat(cs.fontSize), fontWeight: cs.fontWeight, color: cs.color,
      textAlign: cs.textAlign,
      letterSpacing: cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing),
      background: cs.backgroundColor, backgroundImage: cs.backgroundImage,
      borderRadius: parseFloat(cs.borderTopLeftRadius) || 0,
      borderWidth: parseFloat(cs.borderTopWidth) || 0,
      borderColor: cs.borderTopColor,
      src: kind === 'image' ? el.getAttribute('src') : undefined,
      lines: kind === 'text' ? (range.getClientRects().length || 1) : 0,
      occludedBy,
    });
  }
  return JSON.stringify(out);
})()`;

/** 等图片与字体就绪 —— 不等的话量到的是回退字体/空图的尺寸。 */
const READY_SCRIPT = `(async () => {
  await Promise.all(Array.from(document.images).map((i) => i.complete ? 1 : new Promise((r) => { i.onload = i.onerror = r; })));
  await document.fonts.ready;
  return true;
})()`;

/**
 * 把相对的图片路径改写成绝对 `file://`。
 *
 * ⚠️ 不改写的话两张图**都加载不上**（logo 变空框、背景变纯色）：
 *    页面用 `data:` / 临时文件加载时，`assets/…` 这种相对路径解析不到。
 */
export function absolutizeImageSources(html: string, assetsRoot: string | null): string {
  if (!assetsRoot) return html;
  return html.replace(/(<img [^>]*src=")([^"]*)(")/g, (full, pre: string, src: string, post: string) => {
    if (/^(https?:|data:|file:)/i.test(src)) return full;
    // 只取文件名：DSL 写的是 `assets/xxx.png`，实际目录由调用方给
    const abs = path.join(assetsRoot, path.basename(decodeURIComponent(src)));
    return `${pre}${pathToFileURL(abs).toString()}${post}`;
  });
}

/**
 * **一个进程内只建一个**测量窗口，量不同页只换内容、不销毁。
 *
 * 🔴 2026-09-28 真机查清：**每页新建一个窗口会让第 2 页起 `loadFile` 直接 `ERR_FAILED (-2)`。**
 *    对照实验（隐藏窗口、同一份 HTML）：
 *    - 不销毁、连开两个 ⇒ **都 OK**
 *    - 销毁之后再建一个 ⇒ **FAIL: ERR_FAILED (-2)**
 *    ⇒ 是「destroy → 新建」这一步坏了，不是"第二个窗口"。
 *
 * ⚠️ 而 `emitPageShapes` 是**逐页**调的 ⇒ 双页 deck 一定在第二页炸。
 *    这条通道**从来没在真机出过一份 deck**，这就是原因。
 */
let reusableWindow: BrowserWindow | null = null;

function acquireMeasureWindow(): BrowserWindow {
  if (reusableWindow && !reusableWindow.isDestroyed()) return reusableWindow;

  const win = new BrowserWindow({
    show: false,
    width: SLIDE_CANVAS.width,
    height: SLIDE_CANVAS.height,
    useContentSize: true,
    webPreferences: {
      // ⚠️ 这一页是**模型写的内容**渲染出来的：必须按不可信内容对待。
      //    `sandbox` + 不给 preload + 关掉 node 集成 ⇒ 页面里拿不到任何宿主能力。
      //    （求值那层已经拦了 `require`，这里是第二道：即使 HTML 里混进了脚本也跑不出花。）
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: true,
    },
  });
  // 窗口真的没了就清掉引用，下次重新建（这是"被外力关掉"的兜底，不是常规路径）。
  win.on('closed', () => {
    if (reusableWindow === win) reusableWindow = null;
  });
  reusableWindow = win;
  return win;
}

/**
 * 渲染并量框。返回按绘制顺序排列的元素（**顺序即 z-order**）。
 *
 * 失败一律抛出 —— 上层翻成失败码。**绝不返回空数组冒充"这页是空的"**。
 */
export async function measureSlide(html: string, assetsRoot: string | null): Promise<MeasuredElement[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slidegen-'));
  const htmlPath = path.join(dir, 'slide.html');
  fs.writeFileSync(htmlPath, slideDocument(absolutizeImageSources(html, assetsRoot)), 'utf8');

  const win = acquireMeasureWindow();

  try {
    await win.loadFile(htmlPath);
    await win.webContents.executeJavaScript(READY_SCRIPT, true);
    const raw = (await win.webContents.executeJavaScript(MEASURE_SCRIPT, true)) as string;
    const parsed = JSON.parse(raw) as MeasuredElement[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('measure produced no elements');
    }
    return parsed;
  } finally {
    // ⚠️ **不要 destroy** —— 复用的窗口就是靠"不被销毁"才躲开那个竞态。
    //    只清掉这一页的临时文件。
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
