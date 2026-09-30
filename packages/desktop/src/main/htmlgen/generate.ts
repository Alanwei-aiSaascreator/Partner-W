import { createHash } from 'node:crypto';
import type { Artifact, HtmlgenFailure } from '@clawwork/shared';
import { getDebugLogger } from '../debug/index.js';
import { saveArtifactFromBuffer } from '../artifact/save.js';
import { notifyArtifactActivity, type ArtifactActivityCallback } from '../artifact/activity-callback.js';
import { documentFileStem } from '../util/document-file-name.js';
import { extractHtmlgenBlocks } from './blocks.js';
import type { HtmlgenRequest } from './request.js';
import { HtmlgenOutputTooLargeError, renderHtmlgenDocument } from './templates.js';

/**
 * 消息里有 ```` ```htmlgen ```` 块 ⇒ 排成网页并**走客户端现成的产物通道**存下来。
 *
 * 与 `docgen/generate.ts` 逐条同构（那边是 pptx/docx/xlsx/pdf，这边是 html），
 * 三条刻意的行为也一模一样：
 *  - **一份失败不影响另一份**：多份请求里坏了一份，其余的照做；
 *  - **不抛**：调用方在消息收尾路径上（`ipc/data-handlers.ts`），抛出去会连带影响
 *    产物登记与"消息已完成"的记账；
 *  - **不重复存**：`sourceKey` 去重挡住重放（见 `artifact/save.ts` 的唯一约束）。
 *
 * ⚠️ 为什么复用 `saveArtifactFromBuffer` 而不是另开一条落盘路：
 *    "用户能在产物面板看到、能打开预览、能打印"这三件事**已经**由它背后的通道提供了
 *    （写进任务目录 + 写 `artifacts` 表 + 返回 Artifact 给调用方推 `artifact:saved`）。
 *    新的落盘路 = 新的可见性缺口，而那种缺口的表现是"它说做好了，但右边什么都没有"。
 */

export interface HtmlgenGenerateResult {
  saved: Artifact[];
  failed: HtmlgenFailure[];
}

/** 文件名：标题做主名（与 docgen 共用同一份清洗规则），扩展名固定 `.html`。 */
export function htmlFileNameFor(title: string): string {
  return `${documentFileStem(title, '网页')}.html`;
}

/**
 * 去重键：**版式 + 内容哈希**。
 *
 * 与 docgen 同一个理由（那边踩过）：只带标题会在"两份标题相同、内容不同"时算出同一个键，
 * 后者被唯一约束**静默丢掉**（用户只看到一份）。哈希用**校验后的请求**，
 * 键序由解析器决定，所以重放同一段内容仍然得到同一个键。
 */
function sourceKeyFor(request: HtmlgenRequest): string {
  const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 16);
  return `htmlgen:${request.template}:${digest}`;
}

/**
 * 把渲染层抛出来的错**归类**成界面能翻译的码。
 *
 * 认不出来的落到 `htmlgen-render-failed`：那是我们自己的意外，不该假装知道原因，
 * 也不该把 `error.message` 透给用户（英文内部话）。原始文本进调试日志。
 */
function failureFromRenderError(error: unknown, request: HtmlgenRequest): HtmlgenFailure {
  if (error instanceof HtmlgenOutputTooLargeError) {
    return { code: 'htmlgen-output-too-large', template: request.template, maxBytes: error.maxBytes };
  }
  return { code: 'htmlgen-render-failed', template: request.template };
}

export async function generateHtmlPagesFromMessage(input: {
  workspacePath: string;
  taskId: string;
  messageId: string;
  content: string;
  onActivity?: ArtifactActivityCallback;
}): Promise<HtmlgenGenerateResult> {
  const result: HtmlgenGenerateResult = { saved: [], failed: [] };
  const { requests, failures } = extractHtmlgenBlocks(input.content);
  result.failed.push(...failures.map((entry) => entry.failure));
  if (requests.length === 0) {
    if (failures.length > 0) {
      getDebugLogger().warn({
        domain: 'artifact',
        event: 'htmlgen.blocks-invalid',
        data: { taskId: input.taskId, details: failures.map((entry) => entry.detail) },
      });
    }
    return result;
  }

  for (const request of requests) {
    try {
      notifyArtifactActivity(input.onActivity, 'generating-html');
      const buffer = await renderHtmlgenDocument(request);
      notifyArtifactActivity(input.onActivity, 'saving-artifacts');
      const artifact = await saveArtifactFromBuffer({
        workspacePath: input.workspacePath,
        taskId: input.taskId,
        messageId: input.messageId,
        fileName: htmlFileNameFor(request.title),
        buffer,
        artifactType: 'file',
        sourceKey: sourceKeyFor(request),
      });
      result.saved.push(artifact);
      getDebugLogger().info({
        domain: 'artifact',
        event: 'htmlgen.saved',
        data: { taskId: input.taskId, name: artifact.name, size: artifact.size, template: request.template },
      });
    } catch (error) {
      result.failed.push(failureFromRenderError(error, request));
      getDebugLogger().warn({
        domain: 'artifact',
        event: 'htmlgen.save-failed',
        data: {
          taskId: input.taskId,
          template: request.template,
          error: (error as Error).message,
        },
      });
    }
  }

  return result;
}
