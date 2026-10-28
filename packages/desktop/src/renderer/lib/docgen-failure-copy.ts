import type { DocgenFailure } from '@clawwork/shared';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function docgenFailureMessage(failure: DocgenFailure, t: Translate): string {
  switch (failure.code) {
    case 'presentation-page-overflow':
      return t('docgen.pageOverflow', { page: failure.page });
    case 'presentation-page-title-overflow':
      return t('docgen.pageTitleOverflow', { page: failure.page, maxChars: failure.maxChars });
    case 'presentation-cover-title-overflow':
      return t('docgen.coverTitleOverflow', { maxChars: failure.maxChars });
    case 'presentation-cover-subtitle-overflow':
      return t('docgen.coverSubtitleOverflow', { maxChars: failure.maxChars });
    case 'presentation-cover-title-multiline':
      return t('docgen.coverTitleMultiline');
    case 'presentation-cover-subtitle-multiline':
      return t('docgen.coverSubtitleMultiline');
    case 'presentation-slide-title-multiline':
      return t('docgen.slideTitleMultiline', { page: failure.page });
    case 'presentation-slide-bullet-multiline':
      return t('docgen.slideBulletMultiline', { page: failure.page, bullet: failure.bullet });
    // ── 模板填充那条路的四类拒绝 ──
    // 文案里**都把名字带上**：只说"模板不对"助手改不了；
    // 说"第 2 页我不认识 `tmeline`"，它一眼就看出自己拼错了。
    case 'template-page-unknown':
      return t('docgen.templatePageUnknown', { page: failure.page, templateId: failure.templateId });
    case 'template-field-unknown':
      return t('docgen.templateFieldUnknown', {
        page: failure.page,
        templateId: failure.templateId,
        field: failure.field,
      });
    case 'template-field-missing':
      return t('docgen.templateFieldMissing', {
        page: failure.page,
        templateId: failure.templateId,
        field: failure.field,
      });
    case 'template-field-too-long':
      return t('docgen.templateFieldTooLong', {
        page: failure.page,
        templateId: failure.templateId,
        field: failure.field,
        maxChars: failure.maxChars,
      });
    case 'request-invalid':
      return t('docgen.requestInvalid');
    case 'docgen-reply-incomplete':
      // 拿到全文了，全文就这么长 ⇒ 重试没用，要改内容。
      return t('docgen.replyIncomplete');
    case 'docgen-reply-unavailable':
      // 没取到本轮那条回复 ⇒ **我们没生成**（宁可没有，也不给半份）。重试有意义。
      return t('docgen.replyUnavailable');
    case 'presentation-slidegen-required':
      // ⭐ H0 硬门（2026-10-07）：这条**同时**是给用户的解释和给模型的下一步 ——
      //    演示改走「幻灯版面」，整份版面写进 `.slidegen` 文件。路线逐字写在这条文案里。
      return t('docgen.slidegenRequired');
    case 'render-failed':
      return t('docgen.renderFailed', { format: failure.format });
  }
}

export function docgenFailureToastBody(failures: readonly DocgenFailure[], t: Translate): string {
  const [first, ...rest] = failures;
  if (!first) return '';
  const head = docgenFailureMessage(first, t);
  if (rest.length === 0) return head;
  return `${head}\n${t('docgen.moreFailures', { rest: rest.length })}`;
}
