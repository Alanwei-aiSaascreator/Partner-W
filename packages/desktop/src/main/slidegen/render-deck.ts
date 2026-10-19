import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { messagePageBudgetFailure } from '@clawwork/shared';
import type { SlideNode } from './dsl.js';
import { emitPageShapes, type EmittedPage } from './pipeline.js';
import { writeSlidePptx } from './emit.js';
import type { LayoutWarning } from './validate.js';
import type { RenderSegmentCheckpoint } from './render-segments.js';

export async function renderSlideDeck(input: {
  pages: readonly SlideNode[];
  workspacePath: string;
  assetsRoot: string | null;
  assertCurrent?: () => void;
  onPage?: (page: number, total: number) => void;
  /**
   * 分段账本（staged/chunked，P20）。给了它 ⇒ 做完的段落盘、中断后重跑取回；
   * 不给 ⇒ 行为与从前逐字一致（既有调用点与全部既有测试都不传）。
   *
   * ⚠️ 总段数与本轮页数不符时**整份作废**（见 `openRenderSegmentCheckpoint`）：
   *    账本记的是另一份页计划，套上来就会把别页的形状用在这一页上。
   */
  segments?: RenderSegmentCheckpoint | null;
}) {
  if (!input.pages.length || messagePageBudgetFailure([input.pages.length])) throw new Error('page-count-invalid');
  const checkpoint = input.segments && input.segments.total() === input.pages.length ? input.segments : null;
  const emitted: EmittedPage['page'][] = [];
  const warnings: Array<LayoutWarning & { page: number }> = [];
  for (const [index, page] of input.pages.entries()) {
    input.assertCurrent?.();
    // ⭐ 中断恢复：这一段上一轮已经做完 ⇒ 取回它的形状，**不再量框**（真正省下的是排版 + 量框；
    //    恢复路径上没有任何模型调用，所以不产生第二笔计费）。取不回（没做过 / 载荷坏了）⇒ null，
    //    照常重做这一段 —— 账本永远只是加速器，不是真相源。
    const restored = checkpoint?.load(index) ?? null;
    const one = restored ?? (await emitPageShapes(page, input.assetsRoot));
    input.assertCurrent?.();
    emitted.push(one.page);
    warnings.push(...one.warnings.map((warning) => ({ ...warning, page: index + 1 })));
    // 只有真的量过一次才落账 —— 恢复来的段已经在账上了，重复写只是白写一遍盘。
    if (!restored) checkpoint?.save(index, one);
    input.onPage?.(index + 1, input.pages.length);
  }
  const temporary = path.join(input.workspacePath, `.slidegen-${randomUUID()}.pptx`);
  try {
    input.assertCurrent?.();
    await writeSlidePptx(emitted, temporary, input.assetsRoot);
    input.assertCurrent?.();
    const buffer = fs.readFileSync(temporary);
    // 成品已经出来了 ⇒ 这一份源的排版账本使命完成。清在这里而不是在调用方：
    // 贵的那一半（逐页量框）在上面已经走完，中断窗口的现实位置就是那个循环；
    // 让两个调用点各自记得清一次，早晚漏一个。
    checkpoint?.clear();
    return {
      buffer,
      pages: emitted.length,
      bytes: buffer.length,
      outputSha256: createHash('sha256').update(buffer).digest('hex'),
      warnings,
      visualReview: 'not-performed' as const,
    };
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
