/**
 * 模板填充那条路的**渲染适配层** —— 把契约层的原始输入变成一份 pptx Buffer。
 *
 * 为什么完整校验放在这一层、而不是契约层（`request.ts` 的 `parsePptx`）：
 * 契约层的错误出口是一句 `string`，到了 `generate.ts` 会被统一压成
 * `{code:'request-invalid'}` —— **模型写的那个名字就丢了**。
 * 而模板这条路的四类拒绝全都要带着名字回去（"我不认识 `tmeline`"），
 * 所以它们必须从**渲染阶段的失败出口**（`DocgenFailure`）走。
 *
 * ⚠️ 这一层不许"顺手兜底"：模板没填上不是"渲染失败"，
 *    大多数时候是**目录与模板文件漂移了**（形状名对不上）。
 *    那种情况会被上游的对齐测试在 CI 里拦掉；线上真发生了就如实报 render-failed。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DocgenFailure } from '@clawwork/shared';
import { fillTemplateDeck } from './fill.js';
import { parseTemplateDeck } from './parse.js';

/** 渲染阶段的失败：带着结构化的 `DocgenFailure` 上去，而不是一句人话。 */
export class PptxTemplateFailureError extends Error {
  readonly failure: DocgenFailure;
  constructor(failure: DocgenFailure) {
    super(`pptx template: ${failure.code}`);
    this.name = 'PptxTemplateFailureError';
    this.failure = failure;
  }
}

export interface RenderPptxFromTemplateOptions {
  /** 契约层原样传下来的输入（`{template?, slides:[{templateId,data}]}`）。 */
  raw: unknown;
  /** 模板目录；`undefined` = 定位不到（打包漏了 extraResources / 开发态跑错目录）。 */
  templatesRoot: string | undefined;
  /** 产出文件名（不含目录）。 */
  fileName: string;
}

export async function renderPptxFromTemplate(opts: RenderPptxFromTemplateOptions): Promise<Buffer> {
  const parsed = parseTemplateDeck(opts.raw);
  if (!parsed.ok) throw new PptxTemplateFailureError(parsed.failure);

  if (!opts.templatesRoot) {
    // 定位不到模板目录：这是**我们这边**的问题，不是助手内容的问题 ⇒ render-failed。
    throw new PptxTemplateFailureError({ code: 'render-failed', format: 'pptx' });
  }

  // automizer 的产出必须落到真实文件（它按路径写 zip），所以过一个临时目录。
  // ⚠️ 用 `mkdtemp` 而不是固定的临时文件名：两条消息同时生成时不会互相踩。
  const scratch = mkdtempSync(join(tmpdir(), 'pptx-template-render-'));
  try {
    const written = await fillTemplateDeck({
      deck: parsed.deck,
      templatesRoot: opts.templatesRoot,
      outputDir: scratch,
      outputName: opts.fileName,
    });
    return readFileSync(written);
  } catch (error) {
    if (error instanceof PptxTemplateFailureError) throw error;
    throw new PptxTemplateFailureError({ code: 'render-failed', format: 'pptx' });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
