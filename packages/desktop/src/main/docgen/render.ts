import type { DocgenRequest } from './request.js';
import { renderDocx } from './render-docx.js';
import { renderPptx } from './render-pptx.js';
import { renderXlsx } from './render-xlsx.js';

/**
 * **渲染层的唯一入口**：按 `kind` 把请求交给对应格式的渲染器。
 *
 * 为什么要有这一层（而不是让调用方自己 switch）：
 *
 *  1. **穷尽性**：`DOCGEN_KINDS` 加第四种格式时，下面的 `switch` 会**编译期**报错
 *     （返回类型不含 `undefined`），而不是运行期悄悄返回一份空 buffer。
 *     调用方自己去 switch 就会漏，而漏掉的表现是"生成了一个 0 字节的文件"。
 *  2. **三种格式的差异全在各自文件里**：`render-pptx.ts` / `render-docx.ts` /
 *     `render-xlsx.ts` —— 坏掉时一眼能定位到是哪一种，测试也各钉各的。
 *
 * ⚠️ 每个渲染器只接收**已经校验过**的请求（`parseDocgenRequest` 的产物），
 *    所以这里不做任何字段检查：形状不对说明契约层漏了，那是契约层的 bug。
 */
export async function renderDocument(request: DocgenRequest): Promise<Buffer> {
  switch (request.kind) {
    case 'pptx':
      return renderPptx(request);
    case 'docx':
      return renderDocx(request);
    case 'xlsx':
      return renderXlsx(request);
    default: {
      // 编译期护栏：`DOCGEN_KINDS` 加了新成员而这里没接，`request` 就不是 `never`，
      // 这行会在 typecheck 阶段报错 ⇒ 提交前就发现，而不是等用户收到一份空文件。
      const unhandled: never = request;
      throw new Error(`unsupported docgen kind: ${JSON.stringify(unhandled)}`);
    }
  }
}
