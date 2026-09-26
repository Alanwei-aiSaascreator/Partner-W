import { createHash } from 'node:crypto';
import type { Artifact, DocgenFailure, DocgenFormat } from '@clawwork/shared';
import { getDebugLogger } from '../debug/index.js';
import { saveArtifactFromBuffer } from '../artifact/save.js';
import { extractDocgenBlocks } from './blocks.js';
import { PptxLayoutError } from './pptx-layout.js';
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
 *    的 `sourceKey` 去重会挡住（见 `artifact/save.ts` 的唯一约束）。
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

/** 文件名主名的上限（Windows 路径长度）。扩展名另算，所以三种格式的总长一致。 */
const MAX_STEM_CHARS = 60;

/**
 * 文件名：用请求标题，去掉 Windows 不允许的字符与控制字符；留空则退回该格式的稳定名字。
 * 扩展名**只**由 `DOCGEN_OUTPUT_BY_KIND` 给（别在这里写死 `.docx`：那是契约层的事）。
 *
 * ⚠️ 控制字符**不要直接写进正则字符类**：把控制字符以字面量形式写出来时，
 *    只要中间有一层把它解释成真字节，代码文件里就会出现真的 NUL ——
 *    grep 会直接把整个文件当二进制，那条正则也变成只匹配那两个码点。
 *    这里改成逐字符判断（`charCodeAt`），绕开所有转义层。
 */
export function documentFileNameFor(title: string, kind: DocgenKind): string {
  const withoutControls = [...title].map((ch) => (ch.charCodeAt(0) < 0x20 ? ' ' : ch)).join('');
  const cleaned = withoutControls
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_STEM_CHARS);
  const { extension, fallbackStem } = DOCGEN_OUTPUT_BY_KIND[kind];
  return `${cleaned || fallbackStem}${extension}`;
}

/**
 * 去重键：**kind + 内容哈希**。
 *
 * 原来只带「标题 + 页数/节数」—— 两份标题相同、条数相同但内容不同的文档会算出同一个键，
 * 后者被 `saveArtifactFromBuffer` 的唯一约束**静默丢掉**（用户只看到一份）。
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
}): Promise<DocgenGenerateResult> {
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
    try {
      const buffer = await renderDocument(request);
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
