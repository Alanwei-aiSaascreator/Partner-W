import { createHash } from 'node:crypto';
import type { Artifact, DocgenFailure, DocgenFormat } from '@clawwork/shared';
import { getDebugLogger } from '../debug/index.js';
import { saveArtifactFromBuffer } from '../artifact/save.js';
import { notifyArtifactActivity, type ArtifactActivityCallback } from '../artifact/activity-callback.js';
import { captureArtifactWorkspaceOwner } from '../artifact/workspace-owner.js';
import { documentFileStem } from '../util/document-file-name.js';
import { extractDocgenBlocks } from './blocks.js';
import { PptxLayoutError } from './pptx-layout.js';
import { PptxTemplateFailureError } from './pptx-template/render.js';
import { DOCGEN_OUTPUT_BY_KIND, type DocgenKind, type DocgenRequest } from './request.js';
import { renderDocument } from './render.js';

/**
 * 消息里有 ```` ```docgen ```` 块 ⇒ 渲染成真文件（pptx / docx / xlsx）并
 * **走客户端现成的产物通道**存下来。
 *
 * 落盘位置、DB 记录、界面通知全部交给 `saveArtifactFromBuffer`（它写进任务目录、
 * 写 `artifacts` 表、返回 Artifact 给调用方推 `artifact:saved`）——
 * 这样"生成的文件能被用户找到"不需要任何新 UI、新表、新事件。
 * 三种格式共用这一条路，区别只在 `renderDocument` 里那一层分发。
 *
 * 三条刻意的行为：
 *  - **一份失败不影响另一份**：多份请求里坏了一份，其余的照做。
 *  - **不抛**：调用方在消息收尾路径上（`ipc/data-handlers.ts`），抛出去会连带影响
 *    产物登记与"消息已完成"的记账。所以这里把错误收成 `failed` 并记日志。
 *  - **不重复存**：同一段内容在重放/重试里被处理两次时，`saveArtifactFromBuffer`
 *    的 `sourceKey` 去重会把它结算成**既有行**（返回第一次那一份）——
 *    不写第二份、不报假失败（见 `artifact/save.ts` 的"唯一约束语义"）。
 *
 * ⚠️ `failed` 是**结构化**的（`DocgenFailure`），不是一串给日志看的英文句子 ——
 *    调用方要把它推给界面、由界面按九种语言各翻一份（见 `shared/docgen-failure.ts`）。
 */

export interface DocgenGenerateResult {
  saved: Artifact[];
  failed: DocgenFailure[];
}

/**
 * 把渲染层抛出来的错**归类**成界面能翻译的码。
 *
 * 认不出来的就落到 `render-failed`：那是我们自己的意外，不该假装知道原因，
 * 也不该把 `error.message` 透给用户（那是英文内部话，用户看不懂，助手也拿不到）。
 * 原始文本进调试日志（下面 `docgen.save-failed`），排障时照样查得到。
 */
function failureFromRenderError(error: unknown, format: DocgenFormat): DocgenFailure {
  // 模板填充那条路**自带**结构化的失败（四类拒绝都带着模型写的那个名字）。
  // ⚠️ 必须排在下面那串 `instanceof` 之前单独认，否则会被压成一句
  //    `render-failed` —— 助手就只能看到"渲染失败"，不知道是自己拼错了模板名。
  if (error instanceof PptxTemplateFailureError) return error.failure;
  if (error instanceof PptxLayoutError) {
    const problem = error.problem;
    switch (problem.code) {
      case 'slide-body-overflow':
        return { code: 'presentation-page-overflow', format, page: problem.page };
      case 'slide-title-overflow':
        return {
          code: 'presentation-page-title-overflow',
          format,
          page: problem.page,
          maxChars: problem.maxChars,
        };
      case 'cover-title-overflow':
        return { code: 'presentation-cover-title-overflow', format, maxChars: problem.maxChars };
      case 'cover-subtitle-overflow':
        return { code: 'presentation-cover-subtitle-overflow', format, maxChars: problem.maxChars };
      case 'cover-title-multiline':
        return { code: 'presentation-cover-title-multiline', format };
      case 'cover-subtitle-multiline':
        return { code: 'presentation-cover-subtitle-multiline', format };
      case 'slide-title-multiline':
        return { code: 'presentation-slide-title-multiline', format, page: problem.page };
      case 'slide-bullet-multiline':
        return {
          code: 'presentation-slide-bullet-multiline',
          format,
          page: problem.page,
          bullet: problem.bullet,
        };
    }
  }
  return { code: 'render-failed', format };
}

/**
 * 文件名：用请求标题，去掉 Windows 不允许的字符与控制字符；留空则退回该格式的稳定名字。
 * 扩展名**只**由 `DOCGEN_OUTPUT_BY_KIND` 给（别在这里写死 `.docx`：那是契约层的事）。
 *
 * ⚠️ 主名那段的规则在 `util/document-file-name.ts`（htmlgen 也要用同一份）。
 */
export function documentFileNameFor(title: string, kind: DocgenKind): string {
  const { extension, fallbackStem } = DOCGEN_OUTPUT_BY_KIND[kind];
  return `${documentFileStem(title, fallbackStem)}${extension}`;
}

/**
 * 去重键：**kind + 内容哈希**。
 *
 * 原来只带「标题 + 页数/节数」—— 两份标题相同、条数相同但内容不同的文档会算出同一个键，
 * 后者被 `saveArtifactFromBuffer` 的唯一约束顶掉，用户只看到一份。
 * ⚠️ 冲突的**结算语义**在 `artifact/save.ts` 里定死了（2026-10-07 体检 P2-4）：
 *    "唯一约束 = 它已经存在" ⇒ 返回既有行，**不删刚渲染的新文件、不报假失败**。
 *    （本注释原先写"静默丢掉"，与当时的实现——抛错 + 删文件 + 记一条 failed——恰好相反。）
 * 哈希用的是**校验后的请求**（键序由解析器决定，稳定），重放同一段内容仍然得到同一个键。
 */
function sourceKeyFor(request: DocgenRequest): string {
  const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 16);
  return `docgen:${request.kind}:${digest}`;
}

export async function generateDocumentsFromMessage(input: {
  workspacePath: string;
  taskId: string;
  messageId: string;
  content: string;
  onActivity?: ArtifactActivityCallback;
  /**
   * 随包 pptx 模板目录，**由调用方注入**（`ipc/data-handlers.ts` 用 `resolvePptxTemplatesRoot` 算）。
   *
   * ⚠️ 刻意不在这里 `import { app } from 'electron'`：这个模块被测试直接 import
   *    （`documentFileNameFor`），而 vitest 没有 electron mock —— 引进来会连带
   *    打掉一批与模板毫无关系的测试。注入还顺带让"打包态定位"能在单测里覆盖。
   */
  templatesRoot?: string;
  skipPptx?: boolean;
  /**
   * ⭐ **演示意图硬门（H0，2026-10-07）**：这一轮用户要的是"给人看的演示"
   * （调用方从用户请求算出来的 `newDeckIntent || revisionIntent`）。
   *
   * 为真 ⇒ `kind:"pptx"` 的请求**一律不出片**，改为记一条
   * `presentation-slidegen-required` 失败（文案把模型导流到「幻灯版面（自己排）」）。
   * 与 `skipPptx` 的差别只有一个字：**静默 vs 有话说** ——
   * 那条是受控验收（native 链自己出片，用户不会缺东西），这条是生产里模型走错了路
   * （不说一句就变成"它说做好了、面板里什么都没有"）。
   *
   * ⚠️ **受控优先**：两个同时为真时走 `skipPptx` 的静默处置（见下面的分支顺序）。
   */
  reroutePptxToSlidegen?: boolean;
}): Promise<DocgenGenerateResult> {
  const owner = captureArtifactWorkspaceOwner();
  const result: DocgenGenerateResult = { saved: [], failed: [] };
  const { requests, errors } = extractDocgenBlocks(input.content);
  // 解析阶段失败**说不出格式**（请求还没成形，硬填一个就是编事实）。
  result.failed.push(...errors.map((): DocgenFailure => ({ code: 'request-invalid' })));
  if (requests.length === 0) {
    if (errors.length > 0) {
      getDebugLogger().warn({
        domain: 'artifact',
        event: 'docgen.blocks-invalid',
        data: { taskId: input.taskId, errors },
      });
    }
    return result;
  }

  for (const request of requests) {
    if (request.kind === 'pptx') {
      // ⚠️ **顺序就是纪律**：受控（native 链自己出片）静默跳过优先；
      //    演示意图才回一条失败把模型导流去「幻灯版面」。
      if (input.skipPptx) continue;
      if (input.reroutePptxToSlidegen) {
        result.failed.push({ code: 'presentation-slidegen-required', format: 'pptx' });
        getDebugLogger().warn({
          domain: 'artifact',
          event: 'docgen.pptx-rerouted-to-slidegen',
          data: { taskId: input.taskId, title: request.title },
        });
        continue;
      }
    }
    try {
      owner.assertCurrent();
      notifyArtifactActivity(
        input.onActivity,
        request.kind === 'pptx' ? 'generating-presentation' : 'generating-document',
      );
      const buffer = await renderDocument(request, {
        templatesRoot: input.templatesRoot,
        fileName: documentFileNameFor(request.title, request.kind),
        onTemplateFallback: (error) => {
          const cause = error.cause instanceof Error ? error.cause.message : undefined;
          getDebugLogger().warn({
            domain: 'artifact',
            event: 'docgen.template-render-fallback',
            data: { taskId: input.taskId, kind: request.kind, cause },
          });
        },
      });
      owner.assertCurrent();
      notifyArtifactActivity(input.onActivity, 'saving-artifacts');
      const artifact = await saveArtifactFromBuffer({
        workspacePath: input.workspacePath,
        taskId: input.taskId,
        messageId: input.messageId,
        fileName: documentFileNameFor(request.title, request.kind),
        buffer,
        artifactType: 'file',
        sourceKey: sourceKeyFor(request),
      });
      result.saved.push(artifact);
      getDebugLogger().info({
        domain: 'artifact',
        event: 'docgen.saved',
        data: { taskId: input.taskId, name: artifact.name, size: artifact.size, kind: request.kind },
      });
    } catch (error) {
      const message = (error as Error).message;
      result.failed.push(failureFromRenderError(error, request.kind));
      getDebugLogger().warn({
        domain: 'artifact',
        event: 'docgen.save-failed',
        data: { taskId: input.taskId, kind: request.kind, error: message },
      });
    }
  }

  return result;
}
