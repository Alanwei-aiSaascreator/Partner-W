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
  parentId?: number;
  position?: string;
  opacity?: number;
  textBounds?: { x: number; y: number; w: number; h: number }[];
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  /** Only explicitly balanced, plain horizontal LTR text can freeze native rows. */
  balancedPlainText?: boolean;
  textLines?: string[];
  fontSize: number;
  fontWeight: string;
  fontFamily?: string;
  fontStyle?: string;
  lineHeight?: number;
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
   * 它是不是**被人盖住了**（文字行内采样点上 topmost 的不是它自己）。
   * 由浏览器用 `elementFromPoint` 回答；导出顺序另取 Chromium 的实际 paint order。
   * 有值就说明**源版式有重叠**，属于校验器要报的东西。
   */
  occludedBy: string | null;
}

/** 浏览器里跑的量框脚本（在渲染进程执行）。 */
const MEASURE_SCRIPT = `(() => {
  const out = [];
  const elements = [];
  const visit = (el) => {
    if (el.hasAttribute('${MARK_ATTR}')) elements.push(el);
    const children = Array.from(el.children);
    if (/^(inline-)?(flex|grid)$/.test(getComputedStyle(el).display)) {
      children.sort((a, b) => (Number(getComputedStyle(a).order) || 0) - (Number(getComputedStyle(b).order) || 0));
    }
    children.forEach(visit);
  };
  visit(document.body);
  for (const el of elements) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const parent = el.parentElement?.closest('[${MARK_ATTR}]');
    let opacity = 1;
    for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) {
      const value = Number.parseFloat(getComputedStyle(ancestor).opacity);
      opacity *= Number.isFinite(value) ? value : 1;
    }
    const kind = el.getAttribute('${MARK_KIND_ATTR}');
    const range = document.createRange();
    range.selectNodeContents(el);
    let occludedBy = null;
    if (r.width >= 1 && r.height >= 1) {
      // A container center can be visible while the end of a footer line is
      // covered. Sample actual line rectangles so blank container space does
      // not become a text warning. This is a diagnostic, not a visibility proof.
      const rects = kind === 'text' ? Array.from(range.getClientRects()) : [r];
      const fractions = kind === 'text' ? [0.05, 0.25, 0.5, 0.75, 0.95] : [0.5];
      for (const rect of rects) {
        if (rect.width < 1 || rect.height < 1) continue;
        for (const fx of fractions) {
          for (const fy of [0.25, 0.5, 0.75]) {
            const top = document.elementFromPoint(rect.x + rect.width * fx, rect.y + rect.height * fy);
            if (top && top !== el && !el.contains(top)) {
              const owner = top.closest('[${MARK_ATTR}]');
              occludedBy = owner && owner !== el ? '#' + owner.getAttribute('${MARK_ATTR}') : top.tagName;
              break;
            }
          }
          if (occludedBy) break;
        }
        if (occludedBy) break;
      }
    }
    out.push({
      id: Number(el.getAttribute('${MARK_ATTR}')), kind,
      parentId: parent ? Number(parent.getAttribute('${MARK_ATTR}')) : undefined,
      position: cs.position, opacity,
      textBounds: kind === 'text' ? Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0)
        .map(rect => ({x: rect.x, y: rect.y, w: rect.width, h: rect.height})) : undefined,
      x: r.x, y: r.y, w: r.width, h: r.height,
      text: kind === 'text' ? (el.innerText ?? el.textContent.trim()) : '',
      balancedPlainText: kind === 'text' && el.childNodes.length === 1 && el.firstChild?.nodeType === 3 &&
        cs.getPropertyValue('text-wrap') === 'balance' && cs.direction === 'ltr' &&
        cs.getPropertyValue('writing-mode') === 'horizontal-tb' && cs.whiteSpace === 'normal',
      fontSize: parseFloat(cs.fontSize), fontWeight: cs.fontWeight, color: cs.color,
      fontFamily: cs.fontFamily, fontStyle: cs.fontStyle,
      lineHeight: cs.lineHeight === 'normal' ? undefined : parseFloat(cs.lineHeight),
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

interface PaintSnapshot {
  strings: string[];
  documents: {
    nodes: { attributes: number[][]; parentIndex?: number[] };
    layout: { nodeIndex: number[]; paintOrders?: number[]; text?: number[] };
    textBoxes?: { layoutIndex: number[]; start: number[]; length: number[]; bounds: number[][] };
  }[];
}

/** Reuse Chromium's inline boxes, never estimate glyph widths or drop content. */
function retainBalancedLines(
  snapshot: PaintSnapshot,
  document: PaintSnapshot['documents'][number],
  elements: MeasuredElement[],
): void {
  const { nodes, layout, textBoxes: boxes } = document;
  if (
    !Array.isArray(nodes.parentIndex) ||
    !Array.isArray(layout.text) ||
    !boxes ||
    ![boxes.layoutIndex, boxes.start, boxes.length, boxes.bounds].every(Array.isArray)
  )
    return;
  const nonFormatting = (text: string) => text.replace(/[ \t\r\n\f]/g, '');
  for (const element of elements) {
    if (!element.balancedPlainText || /[\u0590-\u08ff\u202a-\u202e\u2066-\u2069]/.test(element.text)) continue;
    const owner = nodes.attributes.findIndex((attributes) =>
      attributes.some(
        (value, i) =>
          i % 2 === 0 &&
          snapshot.strings[value] === MARK_ATTR &&
          snapshot.strings[attributes[i + 1]] === String(element.id),
      ),
    );
    if (owner < 0) continue;
    const node = nodes.parentIndex.indexOf(owner);
    const index = layout.nodeIndex.indexOf(node);
    const text = snapshot.strings[layout.text[index]];
    if (index < 0 || typeof text !== 'string') continue;
    const fragments = boxes.layoutIndex.flatMap((value, i) =>
      value === index ? [{ start: boxes.start[i], length: boxes.length[i], bounds: boxes.bounds[i] }] : [],
    );
    if (fragments.length < 2) continue;
    fragments.sort((a, b) => a.start - b.start);
    const rows: { text: string; y: number; height: number }[] = [];
    let end = 0;
    let valid = true;
    for (const fragment of fragments) {
      const { start, length, bounds } = fragment;
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(length) ||
        start < end ||
        length <= 0 ||
        start + length > text.length ||
        !Array.isArray(bounds) ||
        bounds.length !== 4 ||
        !bounds.every(Number.isFinite) ||
        bounds[3] <= 0 ||
        nonFormatting(text.slice(end, start))
      ) {
        valid = false;
        break;
      }
      const row = rows.at(-1);
      const sameRow = row && Math.abs(bounds[1] - row.y) < Math.min(row.height, bounds[3]) / 2;
      if (sameRow) row.text += text.slice(end, start) + text.slice(start, start + length);
      else {
        if (row && bounds[1] <= row.y) {
          valid = false;
          break;
        }
        rows.push({ text: text.slice(start, start + length), y: bounds[1], height: bounds[3] });
      }
      end = start + length;
    }
    const lines = rows.map((row) => row.text.replace(/[ \t\r\n\f]+/g, ' ').trim());
    if (
      valid &&
      !nonFormatting(text.slice(end)) &&
      lines.length > 1 &&
      lines.every((line) => line && !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(line)) &&
      nonFormatting(lines.join('')) === nonFormatting(element.text)
    )
      element.textLines = lines;
  }
}

/**
 * DOM preorder is not paint order: positioned auto-z elements can paint above
 * later flow content, and nested z-index values cannot be compared globally.
 * Chromium supplies the stacking-layer order; stable ties retain the browser
 * script's order-modified tree traversal (including flex/grid item `order`).
 */
async function orderByBrowserPaint(win: BrowserWindow, elements: MeasuredElement[]): Promise<MeasuredElement[]> {
  const debuggerApi = win.webContents.debugger;
  let attachedHere = false;
  try {
    if (!debuggerApi.isAttached()) {
      debuggerApi.attach('1.3');
      attachedHere = true;
    }
    const snapshot = (await debuggerApi.sendCommand('DOMSnapshot.captureSnapshot', {
      computedStyles: [],
      includePaintOrder: true,
    })) as PaintSnapshot;
    const orders = new Map<number, number>();
    if (!Array.isArray(snapshot?.strings) || !Array.isArray(snapshot.documents)) {
      throw new Error('browser paint order snapshot unavailable');
    }
    for (const document of snapshot.documents) {
      const { layout, nodes } = document;
      if (!Array.isArray(layout?.nodeIndex) || !Array.isArray(layout.paintOrders)) {
        throw new Error('browser paint order data unavailable');
      }
      for (let index = 0; index < layout.nodeIndex.length; index++) {
        const attributes = nodes.attributes[layout.nodeIndex[index]] ?? [];
        for (let attr = 0; attr < attributes.length; attr += 2) {
          if (snapshot.strings[attributes[attr]] !== MARK_ATTR) continue;
          const id = Number(snapshot.strings[attributes[attr + 1]]);
          const order = layout.paintOrders[index];
          if (!Number.isFinite(id) || !Number.isFinite(order)) {
            throw new Error('browser paint order contains an invalid element mapping');
          }
          orders.set(id, order);
        }
      }
      retainBalancedLines(snapshot, document, elements);
    }
    for (const element of elements) {
      if (element.w > 0 && element.h > 0 && !orders.has(element.id)) {
        throw new Error(`browser paint order missing for element #${element.id}`);
      }
    }
    return elements.sort((a, b) => (orders.get(a.id) ?? -1) - (orders.get(b.id) ?? -1));
  } finally {
    if (attachedHere && !win.isDestroyed() && debuggerApi.isAttached()) debuggerApi.detach();
  }
}

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
let measurementQueue: Promise<void> = Promise.resolve();

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
export function measureSlide(html: string, assetsRoot: string | null): Promise<MeasuredElement[]> {
  // Every caller shares one DOM and debugger. Hold the queue through cleanup,
  // and recover its tail so one failed page cannot block later requests.
  const result = measurementQueue.then(() => measureSlideInWindow(html, assetsRoot));
  measurementQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function measureSlideInWindow(html: string, assetsRoot: string | null): Promise<MeasuredElement[]> {
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
    return await orderByBrowserPaint(win, parsed);
  } finally {
    // ⚠️ **不要 destroy** —— 复用的窗口就是靠"不被销毁"才躲开那个竞态。
    //    只清掉这一页的临时文件。
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
