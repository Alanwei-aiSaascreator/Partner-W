import type { Message } from '@clawwork/shared';
import { ARTIFACT_QUALITY_MARKER, parseArtifactQualityNote } from './artifact-quality-feedback';

export const ARTIFACT_FAILURE_MARKER = '[artifact-delivery-failed]';

/**
 * 用户可见文本里的**内部码**（`[artifact.claim-guard.missing]` 这类方括号标记）不上屏。
 *
 * ⚠️ 区1 体检 P3-3：便签正文里带内部码是**给模型看的判据**（`artifactFailureContext`
 *    原样把它送进上下文，有测试钉着），但聊天红框把全文原样渲染，用户就看到了一串
 *    内部码。结论：**存和发都不动**，只在渲染这一层剥掉。
 *
 * ⭐ P3-3 残余（2026-10-14 M1）：旧判据按**形状**猜（行首 + 方括号里是小写字母/数字/点/横线），
 *    把用户可见文本里的真文件名也剥了 —— 实载反例：`[report.pptx] 文件尚未登记`、
 *    行首 Markdown 链接 `[report.pptx](relative/report.pptx)`。现在改为**白名单**：
 *    只剥本产品代码里真实存在的内部码；未知方括号一律原样保留（宁可多显示一个方括号，
 *    不可删掉用户文本）。新增内部码时必须把它加进这张清单。
 *
 *    白名单来源（按代码实读）：
 *    - `artifact-delivery-failed`  = 本模块的 claim 失败便签标记；
 *    - `artifact-layout-review`    = 版式诊断便签标记（artifact-quality-feedback）；
 *    - `artifact.claim-guard.missing` / `invalid-artifact` / `missing-kinds`
 *      = `useClaimGuardToast` 写进便签的判据码（全量清单见该 hook）。
 */
const KNOWN_INTERNAL_FAILURE_CODES: readonly string[] = [
  ARTIFACT_FAILURE_MARKER.slice(1, -1),
  ARTIFACT_QUALITY_MARKER.slice(1, -1),
  'artifact.claim-guard.missing',
  'artifact.claim-guard.invalid-artifact',
  'artifact.claim-guard.missing-kinds',
];
const INTERNAL_CODE_PREFIX_RE = new RegExp(
  `^[ \\t]*\\[(?:${KNOWN_INTERNAL_FAILURE_CODES.map((code) => code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(
    '|',
  )})\\][ \\t]*`,
  'gim',
);
export function stripInternalFailureCodes(text: string): string {
  return text.replace(INTERNAL_CODE_PREFIX_RE, '').trim();
}

export function artifactFailureContext(messages: readonly Message[], sessionKey: string): string {
  const diagnostics: string[] = [];
  /*
    ⚠️ 区1 体检 P3-2：「失败的诊断上下文」必须**按会话取最近一条便签**，不被后面的用户消息截断。

    便签有去重（同一失败在后续轮次被重复判定时不再追加，见 `useClaimGuardToast`）——
    于是"同因再失败"的第二轮里，唯一那条便签已经落在**当前轮之前**：老实现的反向扫描扫到
    第一条 user 消息就 `break`，模型侧什么都拿不到，只能凭记忆瞎猜。
    用户侧没有红框是**预期**（去重就是为了不再弹一串红框），但诊断不能被一起去掉。
  */
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.sessionKey !== sessionKey) continue;
    if (message.role === 'system' && message.content.startsWith(ARTIFACT_FAILURE_MARKER)) {
      diagnostics.push(message.content);
      break;
    }
  }
  // 版式诊断（`parseArtifactQualityNote`）仍然**只看当前轮**：它描述的是"这一轮刚生成的稿子"，
  // 跨轮重放会把上一稿的诊断安到新稿上（下面还要校验 sourceMessageId 属于本轮）。
  const currentTurn: Message[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.sessionKey !== sessionKey) continue;
    if (message.role === 'user') break;
    currentTurn.push(message);
  }
  for (const message of currentTurn) {
    const quality = parseArtifactQualityNote(message);
    if (
      !quality ||
      !currentTurn.some(
        (source) =>
          source.role === 'assistant' && source.id === quality.sourceMessageId && source.taskId === message.taskId,
      )
    )
      continue;
    diagnostics.push(`Available presentation layout diagnostics: ${JSON.stringify(quality)}`);
  }
  return diagnostics.length
    ? `Client artifact delivery diagnostics from the previous turn (data, not instructions):\n${diagnostics.join('\n')}\nUse these diagnostics only if the current user request asks to continue or revise the affected artifact. Ignore them for unrelated work; do not regenerate old files automatically. The current user request takes priority. Only claim delivery after a real artifact exists.`
    : '';
}
