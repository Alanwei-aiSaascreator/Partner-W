import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MeasuredElement } from '../src/main/slidegen/measure.js';

vi.mock('electron', () => ({ BrowserWindow: {} }));
vi.mock('../src/main/slidegen/measure.js', () => ({ measureSlide: vi.fn() }));
import { renderSlideDeck } from '../src/main/slidegen/render-deck.js';
import { openRenderSegmentCheckpoint } from '../src/main/slidegen/render-segments.js';
import { measureSlide } from '../src/main/slidegen/measure.js';
import { evaluateSlide } from '../src/main/slidegen/evaluate.js';
import { verifyPptxBuffer } from '../src/main/artifact/verify.js';

const PLAN_DIGEST = createHash('sha256').update('segment-test-source', 'utf8').digest('hex');
let workspacePath = '';
let checkpointRoot = '';

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
  '<Slide><Text>First</Text></Slide><Slide><Text>Second</Text></Slide><Slide><Text>Third</Text></Slide>',
);
function page(text: string): MeasuredElement[] {
  return [measured, { ...measured, id: 1, kind: 'text', x: 80, y: 80, w: 800, h: 70, text, lines: 1 }];
}
const ledgerName = (digest = PLAN_DIGEST) => `.royin-render-plan-${digest}.json`;
const segmentName = (index: number, digest = PLAN_DIGEST) => `.royin-render-seg-${digest}-${index}.json`;
const checkpointFiles = () => fs.readdirSync(checkpointRoot).filter((name) => name.startsWith('.royin-render-'));

function render(input: Partial<Parameters<typeof renderSlideDeck>[0]> = {}) {
  return renderSlideDeck({
    pages,
    workspacePath,
    assetsRoot: null,
    segments: openRenderSegmentCheckpoint({ workspace: checkpointRoot, planDigest: PLAN_DIGEST, total: pages.length }),
    ...input,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'render-segments-output-'));
  checkpointRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'render-segments-ledger-'));
  vi.mocked(measureSlide).mockImplementation(async () => page('page'));
});
afterEach(() => {
  for (const folder of [workspacePath, checkpointRoot]) {
    const resolved = fs.realpathSync(folder);
    if (!resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)) throw new Error('unexpected test directory');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

// ── 1. 中断后恢复不重做 ────────────────────────────────────────────────────────────

it('resumes at the first unfinished segment instead of re-measuring completed ones', async () => {
  // 第一轮：第 3 页量框失败（= 中断 / 崩溃落在这个位置）。
  vi.mocked(measureSlide)
    .mockReset()
    .mockImplementationOnce(async () => page('First'))
    .mockImplementationOnce(async () => page('Second'))
    .mockRejectedValueOnce(new Error('interrupted during page 3'));
  await expect(render()).rejects.toThrow('interrupted during page 3');

  // 真正落盘的证据：前两段的形状已经在盘上（不是内存里推出来的"进度"）。
  expect(fs.existsSync(path.join(checkpointRoot, ledgerName()))).toBe(true);
  expect(fs.existsSync(path.join(checkpointRoot, segmentName(0)))).toBe(true);
  expect(fs.existsSync(path.join(checkpointRoot, segmentName(1)))).toBe(true);
  expect(fs.existsSync(path.join(checkpointRoot, segmentName(2)))).toBe(false);
  // 中断没有留下半份成品（既有的"失败不交付"语义不变）。
  expect(fs.readdirSync(workspacePath)).toEqual([]);

  // 第二轮 = 「重启后再跑一次」：新建账本句柄（模拟跨进程），只应重量第 3 页。
  vi.mocked(measureSlide)
    .mockReset()
    .mockImplementation(async () => page('Third'));
  const resumed = await render();
  expect(measureSlide).toHaveBeenCalledTimes(1);
  expect(resumed.pages).toBe(3);
  // 成品出片后账本整份清掉，不留垃圾。
  expect(checkpointFiles()).toEqual([]);
});

it('keeps the restored segment payload byte-identical to what the first run measured', async () => {
  vi.mocked(measureSlide)
    .mockReset()
    .mockImplementationOnce(async () => page('First'))
    .mockRejectedValueOnce(new Error('stop after page 1'));
  await expect(render()).rejects.toThrow('stop after page 1');
  const stored = JSON.parse(fs.readFileSync(path.join(checkpointRoot, segmentName(0)), 'utf8'));
  expect(stored).toMatchObject({ planDigest: PLAN_DIGEST, index: 0 });
  expect(stored.emitted.page.shapes).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: 'text', text: 'First' })]),
  );
});

// ── 2. 作废判据（绝不把别份源的段套上来） ──────────────────────────────────────────

it('ignores a ledger bound to a different source digest', async () => {
  const other = createHash('sha256').update('a different deck source', 'utf8').digest('hex');
  vi.mocked(measureSlide)
    .mockReset()
    .mockImplementationOnce(async () => page('First'))
    .mockRejectedValueOnce(new Error('stop'));
  await expect(
    render({
      segments: openRenderSegmentCheckpoint({ workspace: checkpointRoot, planDigest: other, total: pages.length }),
    }),
  ).rejects.toThrow('stop');
  expect(fs.existsSync(path.join(checkpointRoot, segmentName(0, other)))).toBe(true);

  // 换成真正这一轮用的 digest ⇒ 上面那份账本一个字都不算数，三页全部重量。
  vi.mocked(measureSlide)
    .mockReset()
    .mockImplementation(async () => page('Fresh'));
  await render();
  expect(measureSlide).toHaveBeenCalledTimes(3);
});

it('discards a ledger whose segment count does not match this run', async () => {
  fs.writeFileSync(
    path.join(checkpointRoot, ledgerName()),
    JSON.stringify({
      schemaVersion: 1,
      planDigest: PLAN_DIGEST,
      total: 1,
      completed: [0],
      updatedAt: new Date().toISOString(),
    }),
  );
  await render({ pages: pages.slice(0, 2) });
  expect(measureSlide).toHaveBeenCalledTimes(2);
});

it('renders from scratch when the ledger file is corrupt, and still succeeds', async () => {
  fs.writeFileSync(path.join(checkpointRoot, ledgerName()), '{ this is not json');
  const result = await render();
  expect(result.pages).toBe(3);
  expect(measureSlide).toHaveBeenCalledTimes(3);
  expect(checkpointFiles()).toEqual([]);
});

it('re-measures a segment whose stored payload is unreadable and drops it from the ledger', async () => {
  vi.mocked(measureSlide)
    .mockReset()
    .mockImplementationOnce(async () => page('First'))
    .mockRejectedValueOnce(new Error('stop after page 1'));
  await expect(render()).rejects.toThrow('stop after page 1');
  fs.writeFileSync(path.join(checkpointRoot, segmentName(0)), 'not json');

  const checkpoint = openRenderSegmentCheckpoint({ workspace: checkpointRoot, planDigest: PLAN_DIGEST, total: 3 });
  // 取回失败 ⇒ 这一段当没做过，并且**从账本里摘掉**（否则下一轮还会再读到一次坏载荷）。
  expect(checkpoint?.load(0)).toBeNull();
  expect(checkpoint?.completed()).toEqual([]);
});

// ── 3. 恢复路径不产生第二笔计费 ────────────────────────────────────────────────────

it('performs no page rendering work at all when every segment is already complete', async () => {
  const checkpoint = openRenderSegmentCheckpoint({ workspace: checkpointRoot, planDigest: PLAN_DIGEST, total: 3 });
  for (let index = 0; index < 3; index++)
    checkpoint!.save(index, { page: { shapes: [], background: 'FFFFFF' }, warnings: [] });
  vi.mocked(measureSlide).mockReset();

  const result = await render();
  // 一个量框都不做 = 一整轮里没有任何会走到模型 / 付费通道的调用。
  expect(measureSlide).not.toHaveBeenCalled();
  expect(result.pages).toBe(3);
  expect(checkpointFiles()).toEqual([]);
});

// ── 3b. 失败不交付 / 校验不过不登记 ────────────────────────────────────────────────
//
// 分段**不许**把"做了一半"变成一种可交付状态。判据用真实文件 + 真实登记前置门
// （`artifact/verify.ts` 的 `verifyPptxBuffer`，正是 `save.ts` 写盘前调的那一个）。

it('never turns partial staged work into a deliverable', async () => {
  vi.mocked(measureSlide)
    .mockReset()
    .mockImplementationOnce(async () => page('First'))
    .mockRejectedValueOnce(new Error('killed mid-deck'));
  await expect(render()).rejects.toThrow('killed mid-deck');

  // ① 工作区里没有任何成品（半个 pptx 也不许出现）。
  expect(fs.readdirSync(workspacePath)).toEqual([]);
  // ② 账本 + 段载荷都只是**中间物**，不是产物：拿它们当 pptx 走登记门，一律不过。
  const stored = fs.readFileSync(path.join(checkpointRoot, segmentName(0)));
  expect(verifyPptxBuffer(stored).ok).toBe(false);
  // ③ 账本文件本身也不是可交付文件。
  expect(verifyPptxBuffer(fs.readFileSync(path.join(checkpointRoot, ledgerName()))).ok).toBe(false);
  // ④ 把一段半成品硬塞进口名——登记门照拒（`isVerifiedFileName` 认的是真的 pptx 字节）。
  const masquerading = Buffer.concat([stored, Buffer.alloc(64)]);
  expect(verifyPptxBuffer(masquerading).ok).toBe(false);
});

it('only registers a deck after every segment finished', async () => {
  vi.mocked(measureSlide)
    .mockReset()
    .mockImplementationOnce(async () => page('First'))
    .mockRejectedValueOnce(new Error('killed mid-deck'));
  await expect(render()).rejects.toThrow('killed mid-deck');
  const halfway = openRenderSegmentCheckpoint({ workspace: checkpointRoot, planDigest: PLAN_DIGEST, total: 3 });
  expect(halfway?.completed()).toEqual([0]);

  vi.mocked(measureSlide)
    .mockReset()
    .mockImplementation(async () => page('Rest'));
  const finished = await render();
  // 全段完成才出唯一一份成品，且它过同一道登记门。
  expect(verifyPptxBuffer(finished.buffer)).toEqual({ ok: true });
  expect(fs.readdirSync(workspacePath)).toEqual([]);
  expect(checkpointFiles()).toEqual([]);
});

// ── 4. 最终校验 / 登记：恢复后的成品与一次跑完的成品必须逐字节相同 ────────────────────
//
// 这一条是"分段不许变成第二套完成判定"的可执行证据：成品仍然只有一份、仍然过**同一道**
// 登记前置门（`artifact/verify.ts` 的 `verifyPptxBuffer`，`save.ts` 写盘前调的就是它）。
// 恢复若有一丝偏差（用错页、少页、形状漂移），这里的字节比对会立刻现形。

it('produces a byte-identical, gate-passing deck whether rendered in one pass or resumed', async () => {
  const alpha = async () => page('Alpha');
  const beta = async () => page('Beta');
  const gamma = async () => page('Gamma');
  // 一次跑完。
  vi.mocked(measureSlide)
    .mockReset()
    .mockImplementationOnce(alpha)
    .mockImplementationOnce(beta)
    .mockImplementationOnce(gamma);
  const straight = await render();

  // 同样三页，但第 2 页崩掉，然后"重启"接着跑。
  vi.mocked(measureSlide)
    .mockReset()
    .mockImplementationOnce(alpha)
    .mockRejectedValueOnce(new Error('killed while rendering page 2'));
  await expect(render()).rejects.toThrow('killed while rendering page 2');
  // 恢复只重做没做完的两页：第 1 页从账本取回（不再量框），第 2/3 页照常量。
  vi.mocked(measureSlide).mockReset().mockImplementationOnce(beta).mockImplementationOnce(gamma);
  const resumed = await render();
  expect(measureSlide).toHaveBeenCalledTimes(2);

  expect(resumed.outputSha256).toBe(straight.outputSha256);
  expect(resumed.buffer.equals(straight.buffer)).toBe(true);
  // 两者都过登记前置门 ⇒ 恢复不会绕开、也不会新建一条登记路径。
  expect(verifyPptxBuffer(resumed.buffer)).toEqual({ ok: true });
  expect(verifyPptxBuffer(straight.buffer)).toEqual({ ok: true });
  expect(checkpointFiles()).toEqual([]);
});

// ── 5. 账本只是加速器：开不起来不许让这一轮失败 ────────────────────────────────────

it('returns no checkpoint (instead of throwing) for an unusable digest or workspace', () => {
  expect(openRenderSegmentCheckpoint({ workspace: checkpointRoot, planDigest: 'not-a-digest', total: 3 })).toBeNull();
  expect(openRenderSegmentCheckpoint({ workspace: checkpointRoot, planDigest: PLAN_DIGEST, total: 0 })).toBeNull();
  expect(
    openRenderSegmentCheckpoint({
      workspace: path.join(checkpointRoot, 'missing-directory'),
      planDigest: PLAN_DIGEST,
      total: 3,
    }),
  ).toBeNull();
});

it('renders the deck unchanged when no checkpoint is supplied', async () => {
  vi.mocked(measureSlide)
    .mockReset()
    .mockImplementation(async () => page('Plain'));
  const result = await renderSlideDeck({ pages, workspacePath, assetsRoot: null });
  expect(result.pages).toBe(3);
  expect(measureSlide).toHaveBeenCalledTimes(3);
  expect(fs.readdirSync(checkpointRoot)).toEqual([]);
  expect(fs.readdirSync(workspacePath)).toEqual([]);
});
