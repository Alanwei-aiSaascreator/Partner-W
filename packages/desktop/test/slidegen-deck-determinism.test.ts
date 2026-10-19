import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { writeSlidePptx, type Shape, type SlidePage } from '../src/main/slidegen/emit';

/**
 * 同一份页面**两次独立渲染必须逐字节相同**（2026-10-17）。
 *
 * 现场：全量套件在高负载下偶发红在
 * `slidegen-render-segments > produces a byte-identical, gate-passing deck whether rendered in one pass or resumed`
 * —— 两次渲染只差**墙钟秒**。根因是 pptxgenjs 4.0.1 把 `new Date()` 写进
 * `docProps/core.xml`（`dcterms:created/modified`），ZIP 条目时间戳也取当前时间。
 *
 * 后果不只是测试不稳：`outputSha256` 是恢复/去重/证据链的判据，跨秒就该相同的东西不该不同。
 * 修法：写出后把 core.xml 的两个时间戳与所有 ZIP 条目时间钉成常量（`pinDeckTimestamps`）。
 */
let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-determinism-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const text: Shape = {
  kind: 'text',
  id: 1,
  x: 80,
  y: 80,
  w: 800,
  h: 70,
  text: '第一页标题',
  fontSize: 32,
  bold: true,
  color: '111111',
  align: 'left',
  letterSpacing: 0,
  wrap: false,
  gradient: null,
};

const pages: readonly SlidePage[] = [{ background: 'FFFFFF', shapes: [text] }];

function sha(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function write(name: string): Promise<string> {
  const file = path.join(root, name);
  await writeSlidePptx(pages, file, null);
  return file;
}

it('⭐ 隔一秒再渲染一次，成品仍逐字节相同（时间戳不能进产物）', async () => {
  const first = await write('a.pptx');
  // pptxgenjs 的 core.xml 只精确到秒 ⇒ 跨秒必现差异（这是本用例能真红的原因）。
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const second = await write('b.pptx');

  expect(sha(second)).toBe(sha(first));
  expect(fs.statSync(second).size).toBe(fs.statSync(first).size);
});
