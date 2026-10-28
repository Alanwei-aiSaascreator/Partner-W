/**
 * **一份文件没生成出来**的形状（助手在回复里写了 ```` ```docgen ```` 块，但客户端没能把它排成文件）。
 *
 * 为什么要有它：渲染失败原来只在主进程 `console.error` 一句、`result.failed` 收成一串
 * **给日志看的英文句子**，界面上一个字都没有。用户看到的是"我让它做 PPT，它说做好了，
 * 但右边什么都没有" —— 这比报错还糟，因为它看起来像我们坏了。
 *
 * ⚠️ 定义在 shared 是**故意的**：这个形状要跨主进程 → IPC → 渲染层三道边界，
 *    每层各写一遍必然漂移（`ArtifactPreview` / `RuntimeBootstrapStatus` 都是这么收进来的）。
 * ⚠️ 这里只放**码 + 数字**，不放句子：文案在界面那一侧本地化（九种语言各一份）。
 */

/**
 * 四种文档格式。**这是格式集合的唯一定义** —— `main/docgen/request.ts` 的
 * `DOCGEN_KINDS` 直接就是它，不另写一份，否则"加了第五种格式而这里没跟上"
 * 会表现成界面报不出那种格式的名字。
 */
export const DOCGEN_FORMATS = ['pptx', 'docx', 'xlsx', 'pdf'] as const;

export type DocgenFormat = (typeof DOCGEN_FORMATS)[number];

/**
 * 没生成出来的原因。**判别联合**，不是"码 + 一堆可选字段"。
 *
 * 理由有两条，都是被咬过的：
 *  1. **不带假默认值**：用可选字段时，界面为了填文案得写 `failure.page ?? 0` ——
 *     而"第 0 页"是个**编出来的事实**。联合类型让"这类失败必然有页码"变成编译期事实。
 *  2. **穷尽性**：界面按 `code` 选文案，漏掉一种会编译期报错，不会悄悄多出一种
 *     没人翻译的原因、在界面上渲染成裸键。
 *
 * ⚠️ `page` 的口径：`slides` 数组里**从 1 数**，封面不算。选它是因为要照着改的是
 *    **助手** —— 它手里就是那个 `slides` 数组，`slides[page - 1]` 一步到位；
 *    用"含封面的页序"会让它每次都得减一，减错一次就再失败一轮。
 */
export type DocgenFailure =
  /** 演示文稿某一页内容过多：缩到正文下限也排不进一页。 */
  | { code: 'presentation-page-overflow'; format: DocgenFormat; page: number }
  /** 演示文稿某一页的标题过长。 */
  | { code: 'presentation-page-title-overflow'; format: DocgenFormat; page: number; maxChars: number }
  /** 演示文稿的封面标题过长。 */
  | { code: 'presentation-cover-title-overflow'; format: DocgenFormat; maxChars: number }
  /** 演示文稿的封面副标题过长。 */
  | { code: 'presentation-cover-subtitle-overflow'; format: DocgenFormat; maxChars: number }
  /**
   * 演示文稿里有文字**带了换行**（`\n` / `\r\n` / `\r`）。
   *
   * 为什么这是失败而不是"我们替它压扁"：压扁会改掉用户的字 —— 助手本来可能想写两段，
   * 压扁后变成一句读不通的长句，而用户与助手都不知道发生了什么。
   * 另外，版面判定是按"一段会折几行"估高的，真换行会让估高少算，保护就被绕过去了。
   *
   * ⚠️ 四种字段各有独立的码，不是"一个码 + 字段名"：文案里**位置**那句话完全不同
   *    （封面标题 / 副标题 / 第 N 页标题 / 第 N 页第 M 条要点），
   *    拆开之后界面那个 `switch` 是平的、穷尽的，每个参数都必然存在。
   */
  | { code: 'presentation-cover-title-multiline'; format: DocgenFormat }
  | { code: 'presentation-cover-subtitle-multiline'; format: DocgenFormat }
  | { code: 'presentation-slide-title-multiline'; format: DocgenFormat; page: number }
  | { code: 'presentation-slide-bullet-multiline'; format: DocgenFormat; page: number; bullet: number }
  /**
   * **模板填充**那条路的四种拒绝（见 `main/docgen/pptx-template/`）。
   *
   * ⚠️ 它们带的是 `templateId` / `field` 这类**标识符**，不是句子 ——
   *    `presentation-*` 那几条只带数字是刻意的（文案里那个位置那句话完全不同），
   *    而这几条要告诉助手的是"**你写的这个名字我不认识**"，
   *    所以必须把那个名字原样回给它，否则它没法改。
   *
   * ⚠️ 四个码分开而不是"一个码 + 一个 kind 字段"：文案里给助手的**动作**不同 ——
   *    名字不认识 ⇒ 从目录里挑一个；字段不认识 ⇒ 删掉它；
   *    字段缺了 ⇒ 补上；值太长 ⇒ 改短。合成一条会让文案只能写一句万金油。
   *
   * `page` 的口径与上面一致：`slides` 数组里**从 1 数**。
   */
  | { code: 'template-page-unknown'; format: DocgenFormat; page: number; templateId: string }
  | { code: 'template-field-unknown'; format: DocgenFormat; page: number; templateId: string; field: string }
  | { code: 'template-field-missing'; format: DocgenFormat; page: number; templateId: string; field: string }
  | {
      code: 'template-field-too-long';
      format: DocgenFormat;
      page: number;
      templateId: string;
      field: string;
      maxChars: number;
    }
  /**
   * 这一份的内容本身就不合规（JSON 非法、字段与 `kind` 对不上……）。
   *
   * ⚠️ **没有 `format`**：请求还没解析出来就失败了，我们并不知道它本来想做成什么。
   *    硬填一个格式等于编一个事实出来。
   */
  | { code: 'request-invalid' }
  /**
   * 取回了完整原文，但**它本身还是不完整的**（超过 `maxChars` / 模型输出被截断）。
   *
   * ⚠️ 与 `slidegen-reply-incomplete` 逐条同义：拿到的是全文，再取不会更长。
   */
  | { code: 'docgen-reply-incomplete' }
  /**
   * **没能取回本轮那条回复** ⇒ **绝不拿被截断的文本去生成半份文件**。
   *
   * 见 `slidegen-reply-unavailable` 的注释：两条链必须同一处置，
   * 不能"一条修好了、另一条还卡在 8,000"。
   */
  | { code: 'docgen-reply-unavailable' }
  /**
   * ⭐ **这条通道不做演示**（H0 硬门，2026-10-07）：这一轮用户要的是"给人看的演示"
   * （`newDeckIntent` / `revisionIntent`），客户端**拒收** `kind:"pptx"` 的 docgen 请求，
   * 让它改走「幻灯版面（自己排）」—— 整份版面写进 `.slidegen` 文件、按该技能 SKILL.md 出片。
   *
   * 为什么必须是**一条失败**而不是静默跳过：跳过之后那段 docgen 块什么也不产出，
   * 用户与模型都看不到任何解释 ⇒ 又回到"它说做好了、面板里什么都没有"。
   * 这条码的文案同时是**给模型的下一步**（写着该走哪条路）。
   *
   * ⚠️ `format` 恒为 `'pptx'`（拦的就是演示那一种）；留着它是因为下游 toast 按格式说名字，
   *    去掉它会让"没生成的是什么"少一格。
   */
  | { code: 'presentation-slidegen-required'; format: DocgenFormat }
  /**
   * 渲染/落盘时出的其它错（我们自己的意外，不假装知道原因）。
   *
   * `maxChars` 出现在上面几条上，含义是**这一页 / 这个标题最多能放几个全角字**。
   * 带上它是因为提示里那句「请控制在 N 字以内」必须是**真的** —— 随口写一个数字，
   * 用户照着改还是失败，提示就成了假话。
   */
  | { code: 'render-failed'; format: DocgenFormat };
