import {
  HTMLGEN_TEMPLATES,
  type HtmlgenFailure,
  type HtmlgenSectionKind,
  type HtmlgenTemplate,
} from '@clawwork/shared';

/**
 * 网页没生成出来时给用户看的那句话。
 *
 * ⚠️ 按 `code` 走**穷尽 switch**（不是查表、不是 `default` 兜底）：漏掉一种新的失败原因
 *    会在编译期报错，而不是在界面上渲染出一个裸键 —— 那种坏法没人会发现
 *    （同 `docgen-failure-copy.ts` 的理由）。
 *
 * ⚠️ 版式名与小节类型名**走各自的 switch**（也是闭集）：它们是英文短词（`brief` /
 *    `metrics`），直接拼进中文句子用户看不懂，而"这个版式至少要有一段正文"这种话
 *    必须说得出"正文"两个字。两个 switch 都是穷尽的，加第六种版式时两处一起红。
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;

function templateLabelKey(template: HtmlgenTemplate): string {
  switch (template) {
    case 'brief':
      return 'htmlgen.template.brief';
    case 'proposal':
      return 'htmlgen.template.proposal';
    case 'research':
      return 'htmlgen.template.research';
    case 'plan':
      return 'htmlgen.template.plan';
    case 'data':
      return 'htmlgen.template.data';
  }
}

function sectionLabelKey(kind: HtmlgenSectionKind): string {
  switch (kind) {
    case 'narrative':
      return 'htmlgen.section.narrative';
    case 'metrics':
      return 'htmlgen.section.metrics';
    case 'table':
      return 'htmlgen.section.table';
    case 'actions':
      return 'htmlgen.section.actions';
  }
}

export function htmlgenFailureMessage(failure: HtmlgenFailure, t: Translate): string {
  switch (failure.code) {
    case 'htmlgen-block-invalid':
      return t('htmlgen.blockInvalid');
    case 'htmlgen-unknown-template':
      return t('htmlgen.unknownTemplate', { template: failure.template, allowed: HTMLGEN_TEMPLATES.join(' / ') });
    case 'htmlgen-unsupported-field':
      return t('htmlgen.unsupportedField', { field: failure.field });
    case 'htmlgen-content-too-thin':
      return t('htmlgen.contentTooThin', {
        template: t(templateLabelKey(failure.template)),
        needs: failure.needs.map((kind) => t(sectionLabelKey(kind))).join(' / '),
      });
    case 'htmlgen-output-too-large':
      return t('htmlgen.outputTooLarge', { maxMb: Math.floor(failure.maxBytes / (1024 * 1024)) });
    case 'htmlgen-render-failed':
      return t('htmlgen.renderFailed');
  }
}

export function htmlgenFailureToastBody(failures: readonly HtmlgenFailure[], t: Translate): string {
  const [first, ...rest] = failures;
  if (!first) return '';
  const head = htmlgenFailureMessage(first, t);
  if (rest.length === 0) return head;
  return `${head}\n${t('htmlgen.moreFailures', { rest: rest.length })}`;
}
