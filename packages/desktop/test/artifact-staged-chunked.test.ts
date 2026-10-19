import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeasuredElement } from '../src/main/slidegen/measure.js';

vi.mock('electron', () => ({ BrowserWindow: {} }));
vi.mock('../src/main/slidegen/measure.js', () => ({ measureSlide: vi.fn() }));
import { renderSlideDeck } from '../src/main/slidegen/render-deck.js';
import { openRenderSegmentCheckpoint } from '../src/main/slidegen/render-segments.js';
import { measureSlide } from '../src/main/slidegen/measure.js';
import { evaluateSlide } from '../src/main/slidegen/evaluate.js';
import { isVerifiedFileName, verifyArtifactBuffer } from '../src/main/artifact/verify.js';

/**
 * ⭐ T24（2026-10-16 本地全量执行 · Owner D）：**staged/chunked 的"真实可合并"与完成门**。
 *
 * ## 这一档补的接缝
 *
 * `slidegen-render-segments.test.ts` 已经钉住"分段状态 / 中断恢复 / 不重复计费"，
 * 但它只用 `measureSlide` 的**调用次数**与 `result.pages` 证明"没重做已确认段"。
 * 它**没有**证明最要紧的那一件事：**取回的分段真的被组装进了最终 pptx 的字节里**
 * （"本地分段产物真实可合并"）。
 *
 * 如果取回的段在组装时被丢掉（或只有形状没进 `emitted`），用户会拿到一份**少了几页**
 * 的成品 —— 而"measureSlide 只被调用一次"照样是真的（那几页确实没重量），
 * 现有那几条断言全绿也照样是真的。这条接缝就是本档要钉的。
 *
 * 另外钉一条"完成门"：分段**只**是本机排版进度，任何部分的成品都不能冒充交付物 ——
 * 判据用真文件 + **登记前置门的同一份判据**（`artifact/verify.ts`）。
 */

const PLAN_DIGEST = createHash('sha256').update('staged-chunked-merge-source', 'utf8').digest('hex');
let workspacePath = '';
let ledgerRoot = '';

const measured: MeasuredElement = {
  id: 0,
  kind: 'slide',
  x: 0,
  y: 0,
  w: 1280,
  h: 720,
  text: '',
  fontSize: 24,
  fontWeight: '400',
  color: 'rgb(0, 0, 0)',
  textAlign: 'left',
  letterSpacing: 0,
  background: 'rgb(255, 255, 255)',
  backgroundImage: 'none',
  borderRadius: 0,
  borderWidth: 0,
  borderColor: 'rgb(0, 0, 0)',
  lines: 0,
  occludedBy: null,
};
const pages = evaluateSlide(
  '<Slide><Text>ALPHA-PAGE</Text></Slide><Slide><Text>BETA-PAGE</Text></Slide><Slide><Text>GAMMA-PAGE</Text></Slide>',
);
const measuredText = (text: string): MeasuredElement[] => [
  measured,
  { ...measured, id: 1, kind: 'text', x: 80, y: 80, w: 800, h: 70, text, lines: 1 },
];

const checkpointFiles = (): string[] => fs.readdirSync(ledgerRoot).filter((n) => n.startsWith('.royin-render-'));

function render() {
  return renderSlideDeck({
    pages,
    workspacePath,
    assetsRoot: null,
    segments: openRenderSegmentCheckpoint({ workspace: ledgerRoot, planDigest: PLAN_DIGEST, total: pages.length }),
  });
}

/** 从渲染出的 pptx 字节里读回每一页的文本（真 ZIP、真 XML）。 */
async function slideTexts(buffer: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
  return Promise.all(names.map(async (n) => (await zip.file(n)!.async('string')).replace(/<[^>]+>/g, ' ')));
}

beforeEach(() => {
  vi.resetAllMocks();
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'staged-merge-out-'));
  ledgerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'staged-merge-ledger-'));
});
afterEach(() => {
  for (const folder of [workspacePath, ledgerRoot]) {
    const resolved = fs.realpathSync(folder);
    if (!resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)) throw new Error('unexpected test directory');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

describe('⭐ T24 · 真实可合并：取回的分段进最终 pptx 的字节', () => {
  it('⭐ 中断后恢复 ⇒ 最终 pptx 里**同时**有上一轮已确认段的文本和这一轮新量的文本', async () => {
    // 第一轮：量完前两页，第 3 页中断（= 强杀落在逐页循环里）。
    vi.mocked(measureSlide)
      .mockReset()
      .mockImplementationOnce(async () => measuredText('ALPHA-PAGE'))
      .mockImplementationOnce(async () => measuredText('BETA-PAGE'))
      .mockRejectedValueOnce(new Error('killed mid-deck'));
    await expect(render()).rejects.toThrow('killed mid-deck');

    // 已确认的两段真实落盘（不是内存里推的进度）。
    expect(checkpointFiles().filter((n) => n.includes('seg-')).length).toBe(2);

    // 第二轮：只重做第 3 页。
    vi.mocked(measureSlide).mockReset().mockImplementation(async () => measuredText('GAMMA-PAGE'));
    const resumed = await render();
    expect(measureSlide).toHaveBeenCalledTimes(1);

    // ★ 关键：三页的文本**都在**成品字节里 —— 前两页来自取回的段，第三页来自这一轮。
    const texts = await slideTexts(resumed.buffer);
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain('ALPHA-PAGE');
    expect(texts[1]).toContain('BETA-PAGE');
    expect(texts[2]).toContain('GAMMA-PAGE');

    // 成品出片后账本整份清掉（不留垃圾）。
    expect(checkpointFiles()).toEqual([]);
  });

  it('⭐ 取回的段带来的是**上一轮那份形状**（不是这一轮量出来的）—— 内容级证明', async () => {
    vi.mocked(measureSlide)
      .mockReset()
      .mockImplementationOnce(async () => measuredText('FIRST-RUN-ONLY'))
      .mockRejectedValueOnce(new Error('stop'));
    await expect(render()).rejects.toThrow('stop');

    // 第二轮：这一轮如果重量第 1 页会得到完全不同的文本；但因为取回了，它不该出现。
    vi.mocked(measureSlide).mockReset().mockImplementation(async () => measuredText('SECOND-RUN-TEXT'));
    const resumed = await render();
    const texts = await slideTexts(resumed.buffer);
    expect(texts[0]).toContain('FIRST-RUN-ONLY');
    expect(texts[0]).not.toContain('SECOND-RUN-TEXT');
  });

  it('失败（中断）时**不产生半份成品**：工作区里没有任何 pptx', async () => {
    vi.mocked(measureSlide)
      .mockReset()
      .mockImplementationOnce(async () => measuredText('ALPHA-PAGE'))
      .mockRejectedValueOnce(new Error('interrupted'));
    await expect(render()).rejects.toThrow('interrupted');
    expect(fs.readdirSync(workspacePath).filter((n) => n.endsWith('.pptx'))).toEqual([]);
    expect(fs.readdirSync(workspacePath)).toEqual([]);
  });
});

describe('⭐ T24 · 完成门：分段状态不是"完成"，只有真实成品才过登记门', () => {
  it('全部段已确认 ⇒ 量框零调用，出片后 bytes 仍是**一份过登记门的真 pptx**', async () => {
    const checkpoint = openRenderSegmentCheckpoint({ workspace: ledgerRoot, planDigest: PLAN_DIGEST, total: 3 });
    checkpoint!.save(0, { page: { shapes: [], background: 'FFFFFF' }, warnings: [] });
    checkpoint!.save(1, { page: { shapes: [], background: 'FFFFFF' }, warnings: [] });
    checkpoint!.save(2, { page: { shapes: [], background: 'FFFFFF' }, warnings: [] });
    vi.mocked(measureSlide).mockReset();

    const result = await render();
    expect(measureSlide).not.toHaveBeenCalled();
    // 完成门 = 登记前置门对 .pptx 的同一份判据（zip + 必要件 + slides）。
    expect(isVerifiedFileName('deck.pptx')).toBe(true);
    expect(verifyArtifactBuffer('deck.pptx', result.buffer)).toEqual({ ok: true });
  });

  it('中断留下的进度**不是**交付物：标记位全空（没有"已索引"的假完成）', async () => {
    vi.mocked(measureSlide)
      .mockReset()
      .mockImplementationOnce(async () => measuredText('ALPHA-PAGE'))
      .mockRejectedValueOnce(new Error('boom'));
    await expect(render()).rejects.toThrow('boom');
    // 中断没有留下任何文件 ⇒ 没有可登记的成品，没有"已交付"。
    expect(fs.readdirSync(workspacePath)).toEqual([]);
    // 账本只记进度、不含任何"成品已交付"字段（schema 是显式白名单，多字段会被判坏→从零渲染）。
    const ledger = JSON.parse(fs.readFileSync(path.join(ledgerRoot, `.royin-render-plan-${PLAN_DIGEST}.json`), 'utf8'));
    expect(Object.keys(ledger).sort()).toEqual(['completed', 'planDigest', 'schemaVersion', 'total', 'updatedAt']);
    expect(ledger.completed).toEqual([0]);
  });
});
