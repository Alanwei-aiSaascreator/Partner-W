import type { SlidegenFailure, SlidegenWarning } from '@clawwork/shared';

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
    const line = failureLine(failure, t);
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines.join('\n');
}

/**
 * 版式警告 → 一句话。**第一句必须说清文件已经出来了。**
 *
 * 最多列三条：一页里几十个元素越界时，全列出来会变成一堵墙，
 * 用户要的是"去哪一页看什么"，不是一份完整清单。
 */
const MAX_WARNING_LINES = 3;

export function slidegenWarningToastBody(warnings: readonly SlidegenWarning[], t: Translate): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const warning of warnings) {
    let line: string;
    switch (warning.code) {
      case 'layout-out-of-bounds':
        line = t('slidegen.warn.outOfBounds', { page: warning.page });
        break;
      case 'layout-text-occluded':
        line = t('slidegen.warn.occluded', { page: warning.page });
        break;
    }
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
    if (lines.length >= MAX_WARNING_LINES) break;
  }
  const head = t('slidegen.warn.head');
  return lines.length > 0 ? `${head}\n${lines.join('\n')}` : head;
}
