import type { Artifact } from '@clawwork/shared';
import { getDebugLogger } from '../debug/index.js';
import { saveArtifactFromBuffer } from '../artifact/save.js';
import { extractDocgenBlocks } from './blocks.js';
import { renderPptx } from './render.js';

/**
 * 消息里有 ```` ```docgen ```` 块 ⇒ 渲染成真文件并**走客户端现成的产物通道**存下来。
 *
 * 落盘位置、DB 记录、界面通知全部交给 `saveArtifactFromBuffer`（它写进任务目录、
 * 写 `artifacts` 表、返回 Artifact 给调用方推 `artifact:saved`）——
 * 这样"生成的 PPT 能被用户找到"不需要任何新 UI、新表、新事件。
 *
 * 三条刻意的行为：
 *  - **一份失败不影响另一份**：多页/多份请求里坏了一份，其余的照做。
 *  - **不抛**：调用方在消息收尾路径上（`ipc/data-handlers.ts`），抛出去会连带影响
 *    产物登记与"消息已完成"的记账。所以这里把错误收成 `failed` 并记日志。
 *  - **不重复存**：同一段内容在重放/重试里被处理两次时，`saveArtifactFromBuffer`
 *    的 `sourceKey` 去重会挡住（见 `artifact/save.ts` 的唯一约束）。
 */

export interface DocgenGenerateResult {
  saved: Artifact[];
  failed: string[];
}

/**
 * 文件名：用请求标题，去掉 Windows 不允许的字符与控制字符；留空则退回一个稳定的名字。
 *
 * ⚠️ 控制字符**不要写进字符类**（`[\u0000-\u001f]` 这种写法一旦被某层解释成真字节，
 *    文件里就会出现真的 NUL，grep 直接把它当二进制，而正则也变成只匹配那两个码点）。
 *    这里改成逐字符判断，绕开所有转义层。
 */
export function deckFileNameFor(title: string): string {
  const withoutControls = [...title].map((ch) => (ch.charCodeAt(0) < 0x20 ? ' ' : ch)).join('');
  const cleaned = withoutControls
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return `${cleaned || '演示文稿'}.pptx`;
}

export async function generateDecksFromMessage(input: {
  workspacePath: string;
  taskId: string;
  messageId: string;
  content: string;
}): Promise<DocgenGenerateResult> {
  const result: DocgenGenerateResult = { saved: [], failed: [] };
  const { requests, errors } = extractDocgenBlocks(input.content);
  result.failed.push(...errors);
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
      const buffer = await renderPptx(request);
      const artifact = await saveArtifactFromBuffer({
        workspacePath: input.workspacePath,
        taskId: input.taskId,
        messageId: input.messageId,
        fileName: deckFileNameFor(request.title),
        buffer,
        artifactType: 'file',
        // 同一段内容重放时不要存出第二份（唯一约束是 message_id + source_key）。
        sourceKey: `docgen:${request.title}:${request.slides.length}`,
      });
      result.saved.push(artifact);
      getDebugLogger().info({
        domain: 'artifact',
        event: 'docgen.saved',
        data: { taskId: input.taskId, name: artifact.name, size: artifact.size },
      });
    } catch (error) {
      const message = (error as Error).message;
      result.failed.push(message);
      getDebugLogger().warn({
        domain: 'artifact',
        event: 'docgen.save-failed',
        data: { taskId: input.taskId, error: message },
      });
    }
  }

  return result;
}
