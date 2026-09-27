/**
 * **一份网页没生成出来**的形状（助手在回复里写了 ```` ```htmlgen ```` 块，但客户端没能把它排成页面）。
 *
 * ## 这条通道是什么
 *
 * 助手**不写 HTML**。它提交的是一份**结构化内容**（标题 / 摘要 / 小节 / 指标 / 表格 / 行动项 /
 * 来源），客户端拿自己的模板渲染成一份离线自包含的 `.html` 落进产物。
 * 所以"少给了一个字段"和"想塞一段自己的 HTML"都会被**明确拒绝**，而不是被硬塞进页面。
 *
 * ⚠️ 与 `docgen-failure.ts` 同一个道理：定义在 shared 是**故意的** —— 这个形状要跨
 *    主进程 → IPC → 渲染层三道边界，每层各写一遍必然漂移。
 * ⚠️ 这里只放**码 + 数据**，不放句子：文案在界面那一侧本地化（九种语言各一份）。
 */

/**
 * 支持的版式。**这是版式集合的唯一定义** —— 契约层（`main/htmlgen/request.ts`）直接用它，
 * 不另写一份字面量；否则"加了第六种版式而这里没跟上"会表现成助手写了个我们认不出的名字、
 * 而界面报不出有哪些可用的。
 *
 * 名字取 ascii 短词（助手要照着写、用户要照着转述），含义写在技能正文里：
 * `brief` 网页报告 / `proposal` 方案页 / `research` 调研简报 / `plan` 项目计划 / `data` 数据页。
 */
export const HTMLGEN_TEMPLATES = ['brief', 'proposal', 'research', 'plan', 'data'] as const;

export type HtmlgenTemplate = (typeof HTMLGEN_TEMPLATES)[number];

/**
 * 小节的四种内容类型。
 *
 * ⚠️ **只有四种**，而且这里列的是**内容类型**、不是"元素类型"：没有 `image`、没有 `div`、
 *    没有 `raw`。助手能表达的"长什么样"到此为止，排版全在客户端的模板里 ——
 *    这正是"模型写不出坏版面"的结构性保证（它不是被检查出来的，是**没地方写**）。
 */
export const HTMLGEN_SECTION_KINDS = ['narrative', 'metrics', 'table', 'actions'] as const;

export type HtmlgenSectionKind = (typeof HTMLGEN_SECTION_KINDS)[number];

/**
 * 没生成出来的原因。**判别联合**，不是"码 + 一堆可选字段"。
 *
 * 理由与 `DocgenFailure` 逐条相同（不带假默认值、穷尽性可查），另外多一条：
 * 这里有一类是**安全**失败（`htmlgen-unsupported-field`），它的文案必须能说清
 * "助手只能给内容、版式由客户端定" —— 写成可选字段就没人保证它一定带得上那个字段名。
 */
export type HtmlgenFailure =
  /**
   * 这一份的内容本身就不合规（JSON 非法、`kind` 不是 `"html"`、字段类型不对……）。
   *
   * ⚠️ **不带任何载荷**：请求还没解析出来就失败了，我们并不知道它本来想做哪一种，
   *    硬填一个版式名等于编一个事实出来。
   */
  | { code: 'htmlgen-block-invalid' }
  /**
   * `template` 写的名字我们不认识。
   *
   * `template` 带的是**助手原样写的那串**（可能很长/很奇怪），文案里逐字回显 ——
   *    用户照着它去让助手改，改了才认。
   */
  | { code: 'htmlgen-unknown-template'; template: string }
  /**
   * 内容里带了协议**没有的字段**（`html` / `style` / `color` / `src` / `url` / `x` / `y` ……）。
   *
   * ⭐ 这条是"模型写不了坏版面"的**执行点**：那些字段在 schema 里根本不存在，
   *    所以走到这里必然是"多写了"，而不是"我们检查了一下觉得不行"。
   *    `field` 是**字段路径**（`sections[1].style`），逐字回显，助手才知道删哪一处。
   */
  | { code: 'htmlgen-unsupported-field'; field: string }
  /**
   * 内容太薄：整份一个字都没有，或者这个版式**要的那一类**内容没给
   * （数据页没有数据、项目计划没有行动项……）。
   *
   * ⚠️ 两个原因合成一条码，因为**对用户是同一句话**："让助手把内容补上再来一次"。
   *    `needs` 是"这个版式至少要有其中一类"（空数组 = 不限，纯粹是"整份空的"）。
   */
  | { code: 'htmlgen-content-too-thin'; template: HtmlgenTemplate; needs: readonly HtmlgenSectionKind[] }
  /**
   * 排出来**太大**，超过 `MAX_HTMLGEN_OUTPUT_BYTES`。
   *
   * ⚠️ 这条不是防滥用，是**保富预览**：超了 `MAX_HTML_PREVIEW_BYTES` 的 `.html`
   *    只能当纯文本看（`build-preview.ts` 那条分支），等于这条路白做。
   *    宁可"没生成 + 说清是内容太多"，也不要给用户一份打不开像样的页面。
   *    `maxBytes` 带上是为了文案里那句"控制在多大以内"必须是**真的**。
   */
  | { code: 'htmlgen-output-too-large'; template: HtmlgenTemplate; maxBytes: number }
  /** 渲染/落盘时出的其它错（我们自己的意外，不假装知道原因）。 */
  | { code: 'htmlgen-render-failed'; template: HtmlgenTemplate };
