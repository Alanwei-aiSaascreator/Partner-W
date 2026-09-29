import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Artifact, SlidegenFailure, SlidegenWarning } from '@clawwork/shared';
import { messagePageBudgetFailure } from '@clawwork/shared';
import { getDebugLogger } from '../debug/index.js';
import { saveArtifactFromBuffer } from '../artifact/save.js';
import { documentFileStem } from '../util/document-file-name.js';
import { extractSlidegenBlocks, type SlidegenDeck } from './blocks.js';
import { SlideDslError } from './dsl.js';
import { evaluateSlide } from './evaluate.js';
import { emitPageShapes } from './pipeline.js';
import { writeSlidePptx } from './emit.js';

/**
 * 消息里有 ```` ```slidegen ```` 块 ⇒ 排成 `.pptx` 并走**客户端现成的产物通道**存下来。
 *
 * 与 `docgen/generate.ts` / `htmlgen/generate.ts` 逐条同构，三条刻意的行为一模一样：
 *  - **一份失败不影响另一份**：多份请求里坏了一份，其余的照做；
 *  - **不抛**：调用方在消息收尾路径上（`ipc/data-handlers.ts`），抛出去会连带影响
 *    产物登记与"消息已完成"的记账；
 *  - **不重复存**：`sourceKey` 去重挡住重放（见 `artifact/save.ts` 的唯一约束）。
 *
 * ⭐ 与那两条**不一样**的一条：**版式问题只警告、不拒绝**。
 *    越界 / 文字被盖住都会照常出文件，只是把话说清楚 —— 见 `validate.ts` 顶部那段。
 */

export interface SlidegenGenerateResult {
  saved: Artifact[];
  failed: SlidegenFailure[];
  /** 文件出来了，但版式有问题。**不是失败**，是要转达给用户/助手的话。 */
  warnings: SlidegenWarning[];
}

/** 文件名：标题做主名（与 docgen/htmlgen 共用同一份清洗规则），扩展名固定 `.pptx`。 */
export function slideFileNameFor(title: string): string {
  return `${documentFileStem(title, '演示文稿')}.pptx`;
}

/**
 * 去重键：**标题 + 版面源码哈希**。
 *
 * 与另两条同一个理由：只带标题会在"两份标题相同、内容不同"时算出同一个键，
 * 后者被唯一约束**静默丢掉**（用户只看到一份）。哈希用**版面源码**本身，
 * 所以重放同一段源码仍然得到同一个键。
 */
function sourceKeyFor(deck: SlidegenDeck): string {
  const digest = createHash('sha256').update(deck.source).digest('hex').slice(0, 16);
  return `slidegen:${digest}`;
}

/**
 * 把 DSL 层抛出来的错**归类**成界面能翻译的码。
 *
 * ⚠️ 认不出来的落到 `slidegen-render-failed`：那是我们自己的意外，
 *    不该假装知道原因，也不该把 `error.message` 透给用户（英文内部话）。原始文本进调试日志。
 */
export function failureFromError(error: unknown): SlidegenFailure {
  if (error instanceof SlideDslError) {
    switch (error.code) {
      case 'dsl-unknown-tag':
        return { code: 'slidegen-unknown-tag', tag: error.message.replace(/^unknown tag <|>$/g, '') };
      case 'dsl-eval-failed':
        return { code: 'slidegen-eval-failed' };
      case 'dsl-unparsable':
      case 'dsl-no-root':
        return { code: 'slidegen-unparsable' };
      default:
        return { code: 'slidegen-render-failed' };
    }
  }
  return { code: 'slidegen-render-failed' };
}

export async function generateSlidesFromMessage(input: {
  workspacePath: string;
  taskId: string;
  messageId: string;
  content: string;
}): Promise<SlidegenGenerateResult> {
  const result: SlidegenGenerateResult = { saved: [], failed: [], warnings: [] };
  const { decks, failures } = extractSlidegenBlocks(input.content);
  result.failed.push(...failures.map((entry) => entry.failure));
  if (decks.length === 0) {
    if (failures.length > 0) {
      getDebugLogger().warn({
        domain: 'artifact',
        event: 'slidegen.blocks-invalid',
        data: { taskId: input.taskId, details: failures.map((entry) => entry.detail) },
      });
    }
    return result;
  }

  // 图片按工作区解析：DSL 里写 `assets/xxx.png`，实际文件在任务工作区里。
  const assetsDir = path.join(input.workspacePath, 'assets');
  const assetRoot = fs.existsSync(assetsDir) ? assetsDir : input.workspacePath;

  // 先求值、累计同一条消息里的 deck，再决定是否允许渲染。
  // 首次超额就返回：既不能让前一份先写盘，也不能在预算已确定失败后继续耗时求值。
  const evaluated: Array<{ deck: SlidegenDeck; pages: ReturnType<typeof evaluateSlide> }> = [];
  const evaluatedPageCounts: number[] = [];
  for (const deck of decks) {
    try {
      const pages = evaluateSlide(deck.source);
      evaluated.push({ deck, pages });
      evaluatedPageCounts.push(pages.length);
      const budget = messagePageBudgetFailure(evaluatedPageCounts);
      if (budget) {
        result.failed.push(budget);
        return result;
      }
    } catch (error) {
      result.failed.push(failureFromError(error));
      getDebugLogger().warn({
        domain: 'artifact',
        event: 'slidegen.save-failed',
        data: { taskId: input.taskId, error: (error as Error).message },
      });
    }
  }

  for (const { deck, pages } of evaluated) {
    try {
      let buffer: Buffer;
      const emitted = [];
      for (const [index, page] of pages.entries()) {
        const one = await emitPageShapes(page, assetRoot);
        emitted.push(one.page);
        for (const w of one.warnings) result.warnings.push({ ...w, page: index + 1 });
      }

      // 先写到盘上（pptxgenjs 只接受路径），读完立刻删掉 —— 产物通道那边会再存一份，
      // 留着这个临时文件会在用户的工作区里多出一个他没要的文件。
      const tmpPath = path.join(input.workspacePath, `.slidegen-${Date.now()}.pptx`);
      try {
        await writeSlidePptx(emitted, tmpPath, assetRoot);
        buffer = fs.readFileSync(tmpPath);
      } finally {
        fs.rmSync(tmpPath, { force: true });
      }

      const artifact = await saveArtifactFromBuffer({
        workspacePath: input.workspacePath,
        taskId: input.taskId,
        messageId: input.messageId,
        fileName: slideFileNameFor(deck.title),
        buffer,
        artifactType: 'file',
        sourceKey: sourceKeyFor(deck),
      });
      result.saved.push(artifact);
      getDebugLogger().info({
        domain: 'artifact',
        event: 'slidegen.saved',
        data: {
          taskId: input.taskId,
          name: artifact.name,
          size: artifact.size,
          pages: emitted.length,
          warnings: result.warnings.length,
        },
      });
    } catch (error) {
      result.failed.push(failureFromError(error));
      getDebugLogger().warn({
        domain: 'artifact',
        event: 'slidegen.save-failed',
        data: { taskId: input.taskId, error: (error as Error).message },
      });
    }
  }

  return result;
}
