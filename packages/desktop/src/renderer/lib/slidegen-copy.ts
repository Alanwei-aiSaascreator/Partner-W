import type { SlidegenFailure } from '@clawwork/shared';

/**
 * 幻灯片没生成出来 / 版式有毛病时，给用户看的那句话。
 *
 * ## 两档严重性，**两套文案**，绝不混用
 *
 * | 档 | 用户看到的 | 意味着 |
 * | --- | --- | --- |
 * | `SlidegenFailure` | 红色 toast「没能生成」+ 产物里**没有**文件 | 真的没出来 |
 * | `SlidegenWarning` | 黄色 toast「**已经生成了**，但有几处要注意」 | 文件在产物里，只是某几页版式要改 |
 *
 * ⚠️ 把警告写成失败文案，用户会去找一个**其实已经存在**的文件，然后以为我们坏了。
 *    所以警告的第一句必须是「**已经生成**」。
 *
 * ⚠️ 按 `code` 走**穷尽 switch**（不是查表、不是 `default` 兜底）：漏掉一种新原因是
 *    编译期报错，而不是在界面上渲染出一个裸键 —— 那种坏法没人会发现
 *    （同 `docgen-failure-copy.ts` / `htmlgen-failure-copy.ts` 的理由）。
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 一条失败 → 一句话。返回 `null` 表示这条不值得单独说（由调用方决定要不要合并）。 */
function failureLine(failure: SlidegenFailure, t: Translate): string {
  switch (failure.code) {
    case 'slidegen-block-empty':
      return t('slidegen.fail.blockEmpty');
    case 'slidegen-block-unclosed':
      // 几乎总是"这一次回复太长、被截断了"。要说清"内容还在"，否则用户以为白做了。
      return t('slidegen.fail.blockUnclosed');
    case 'slidegen-file-no-fence':
      // 助手**写了文件**、但文件里没有版面代码。要说清"文件在哪儿、缺的是什么"，
      // 助手才知道去改那个文件，而不是重发一段聊天。（与上面那条的处置不同。）
      return t('slidegen.fail.fileNoFence');
    case 'slidegen-file-unreadable':
      // 文件在、但读不动（权限 / 被删 / 正写到一半）。让用户知道**再试一次**有意义。
      return t('slidegen.fail.fileUnreadable');
    case 'slidegen-file-too-large':
      // 带上 max/got：用户要能看到"超了多少"，否则只能猜。单位为字节，文案里写清。
      return t('slidegen.fail.fileTooLarge', { max: failure.max, got: failure.got });
    case 'slidegen-reply-incomplete':
      // 拿到全文了，全文就这么长（超了取回上限 / 模型自己写超了）⇒ 重试没用，要改内容。
      return t('slidegen.fail.replyIncomplete');
    case 'slidegen-reply-unavailable':
      // 没取到本轮那条回复 ⇒ **我们没生成**（宁可没有，也不给半份）。重试有意义。
      return t('slidegen.fail.replyUnavailable');
    case 'slidegen-title-missing':
      // 标题同时是**文件名**。说清"要一行 title 注释"，助手才知道补什么。
      return t('slidegen.fail.titleMissing');
    case 'slidegen-unparsable':
      return t('slidegen.fail.unparsable');
    case 'slidegen-unknown-tag':
      // 把那个标签名回给用户 —— 他能照着让助手改（也方便他转述给我们）。
      return t('slidegen.fail.unknownTag', { tag: failure.tag });
    case 'slidegen-eval-failed':
      return t('slidegen.fail.evalFailed');
    case 'slidegen-too-many-pages':
      return t('slidegen.fail.tooManyPages', { max: failure.max, got: failure.got });
    case 'slidegen-render-failed':
      return t('slidegen.fail.renderFailed');
  }
}

/** 一句能贴进 toast 的话（多条时合并；重复的码只留一条）。 */
export function slidegenFailureToastBody(failures: readonly SlidegenFailure[], t: Translate): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const failure of failures) {
    const diagnostic = failure.diagnostic;
    const line = diagnostic
      ? `${failureLine(failure, t)}\n[${diagnostic.code}${diagnostic.offset === undefined ? '' : ` @${diagnostic.offset}`}] ${diagnostic.detail}`
      : failureLine(failure, t);
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines.join('\n');
}
