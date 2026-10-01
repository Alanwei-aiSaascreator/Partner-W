import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { messagePageBudgetFailure } from '@clawwork/shared';
import type { SlideNode } from './dsl.js';
import { emitPageShapes, type EmittedPage } from './pipeline.js';
import { writeSlidePptx } from './emit.js';
import type { LayoutWarning } from './validate.js';

export async function renderSlideDeck(input: {
  pages: readonly SlideNode[];
  workspacePath: string;
  assetsRoot: string | null;
  assertCurrent?: () => void;
  onPage?: (page: number, total: number) => void;
}) {
  if (!input.pages.length || messagePageBudgetFailure([input.pages.length])) throw new Error('page-count-invalid');
  const emitted: EmittedPage['page'][] = [];
  const warnings: Array<LayoutWarning & { page: number }> = [];
  for (const [index, page] of input.pages.entries()) {
    input.assertCurrent?.();
    const one = await emitPageShapes(page, input.assetsRoot);
    input.assertCurrent?.();
    emitted.push(one.page);
    warnings.push(...one.warnings.map((warning) => ({ ...warning, page: index + 1 })));
    input.onPage?.(index + 1, input.pages.length);
  }
  const temporary = path.join(input.workspacePath, `.slidegen-${randomUUID()}.pptx`);
  try {
    input.assertCurrent?.();
    await writeSlidePptx(emitted, temporary, input.assetsRoot);
    input.assertCurrent?.();
    const buffer = fs.readFileSync(temporary);
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
