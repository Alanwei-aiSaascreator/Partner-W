import type { DocgenFailure } from '@clawwork/shared';

/**
 * 把主进程给的**结构化失败**翻成人话。
 *
 * ## 为什么是 `switch` 而不是"码 → key"的映射表
 *
 * 映射表要写成 `t(KEYS[failure.code])` 或 `t(\`docgen.${failure.code}\`)` ——
 * 两种写法**都逃得过 i18n 门禁**：
 *  - 计算出来的 key 不在「代码里的字面量 key」集合里，于是"这个键没人用过"与
 *    "这个键根本不存在"两个方向同时失明；
 *  - 拼错的键不会报错，运行期只是把裸键名渲染到 toast 上。
 * 而且 `switch` 有**穷尽性**：`DocgenFailure` 加了新成员，这里编译期就报错。
 *
 * 所以每个 key 都在 t 调用里**字面量**写出来，让门禁两个方向都看得见。
 *
 * ⚠️ 上面这段注释**故意不写带引号的 t 调用示例**：i18n 扫描器读的是**原始源码文本**
 *    （连注释一起读），注释里出现一个形如 `t` + 引号串的片段会被当成一个真 key，
 *    然后以"代码引用了、词表里没有"的形态把门禁打红。这个坑踩过一次。
 */

/** 只取用得到的部分，好让这个函数能脱离 react-i18next 单测。 */
type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * 一条失败该说什么。
 *
 * 语气上刻意做到两件事：**说清是什么**（哪份、哪页）+ **说清怎么办**
 * （拆页 / 缩短 / 重出一份）。只说"生成失败"等于没说 —— 用户下一步无事可做。
 */
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
    case 'request-invalid':
      return t('docgen.requestInvalid');
    case 'render-failed':
      return t('docgen.renderFailed');
  }
}

/**
 * 整条提示的正文：**第一处具体原因**，后面挂一句"还有几份"。
 *
 * 为什么只展开第一处：一次列九条错误没人看得完，而用户下一次要做的动作是**一件**
 * （去让助手改那一页）。剩下的用一句计数带过，需要细节的可以看右侧产物与调试日志。
 */
export function docgenFailureToastBody(failures: readonly DocgenFailure[], t: Translate): string {
  const [first, ...rest] = failures;
  if (!first) return '';
  const head = docgenFailureMessage(first, t);
  if (rest.length === 0) return head;
  return `${head}\n${t('docgen.moreFailures', { rest: rest.length })}`;
}
