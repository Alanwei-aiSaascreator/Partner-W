/**
 * 工具失败原因的**具名说明层**（2026-10-08，BUG-060 联审裁决 · 仅展示层）。
 *
 * ## 为什么要有这一层
 *
 * `productizedToolFailure` 把"认不出的英文"统一送进兜底句 `cannotContinue`（BUG-026 定稿口径），
 * 于是三类**完全不同的**失败在界面上长得一模一样：
 *   ① 模型少传了一个必填参数（模型侧行为，换写法/重试常能自愈）；
 *   ② 模型调用了一个**不存在**的工具（模型幻觉）；
 *   ③ 这台机器**没有配对节点**（环境限制，重试再多次也没用）。
 * 用户无法据此决定下一步，客服也无法从截图上分辨 —— 这里给它们各自一句具名说明。
 *
 * ## 纪律：证据紧（宁可不认，不许猜）
 *
 * - 只认**有真实原文**的形态（见各正则上方的引文）；
 * - 证据不齐一律 `return null`，交回既有兜底链（family 分支 → `isOpaqueToolFailure` → 原文）；
 * - 反例已钉在 `test/tool-failure-explain.test.ts`：`paired node disconnected`、
 *   `authentication failed: file-transfer tools disabled` **不得**改写成"本机没有配对设备"。
 *
 * ## 输出面
 *
 * 返回的只可能是产品文案（`t(...)` 的 i18n 键）。本层**只做展示映射**：
 * 不改执行语义、不改 `classifyToolFailure` / `isOpaqueToolFailure` / 重复失败聚合。
 *
 * ## ⚠️ 2026-10-08 总审（R5）后的两条硬规则
 *
 * 1. **入参必须是"剥样板但未遮路径"的原文**（调用方 `productizedToolFailure` 传
 *    `stripRuntimeBoilerplate(reason)`）：参数名提取不能拿**脱敏后**的文本反推 ——
 *    `Missing required parameter: C:\…\report.docx` 遮路径后会剩下 `report.docx`，
 *    把它当参数名就是在编事实。原文里那个路径**匹配不上**（盘符后的 `:` 不在分隔符集合里）⇒ null。
 * 2. **本层优先于宽泛关键词分类**（`classifyToolFailure`）：`Missing required parameter: timeout`
 *    里的 "timeout" 是**参数名**，不是"等待超时"；工具名里带 `network` 的 not found 也不是网络故障。
 *
 * ## 依赖方向（单一向）
 *
 * 本文件**不反向引** `tool-activity`：组件侧入口 `namedToolFailureKind`（需要剥样板）
 * 放在 `tool-activity.ts`（那里是 `stripRuntimeBoilerplate` 的家，复用只有一份实现）。
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 具名形态号（组件用它决定"这条失败已有具名说明"，见 `namedToolFailureKind`）。 */
export type ToolFailureKind = 'missingParam' | 'toolUnavailable' | 'localTransfer';

/**
 * 缺参（内核工具校验器真实原文）：
 * `Missing required parameter: path (received: action, name).` → `path`
 *
 * ⚠️ 三条硬条件，缺一即不匹配：
 *   ① 紧跟短语后必须是合法参数名 `[A-Za-z_][\w-]*`（否则 `received` 这类词会被误抓）；
 *   ② 点号只允许出现在**名字内部**（`content.file` 形态）—— 句号结尾的 `path.` 只取 `path`，
 *      不吞标点；
 *   ③ 参数名之后必须跟**分隔符**（空白 / 行尾 / 句点 / `(` `,` `;` `)` `]` `}`）—— **刻意不含 `:`**：
 *      `C:\Users\…` 被盲目捕获时是 `C`，若把 `:` 当分隔符，盘符就会被当成参数名。
 */
const MISSING_REQUIRED_PARAM_RE =
  /\bmissing required parameter\s*[:=]?\s*([A-Za-z_][\w-]*(?:\.[\w-]+)*)(?=$|[\s(,;)\].}])/i;

/** 工具不存在（真实原文）：`Tool docgen not found`；另有 `unknown tool` 形态。 */
const TOOL_NOT_FOUND_RE = /\btool\s+[A-Za-z_][\w.-]*\s+not found\b/i;
const UNKNOWN_TOOL_RE = /\bunknown tool\b/i;

/**
 * 配对节点围栏（内核真实原文，**两句连说**）：
 * `no paired nodes available; file-transfer tools require a paired node from nodes status.
 *  Use local file/exec tools for local workspace paths.`
 *
 * ⚠️ **两条证据必须同时在场**：只有第一句时，`paired node disconnected`（设备在但断了）、
 *    `file-transfer tools disabled`（另一回事）都可能共用半句措辞 —— 单句不足以断言
 *    "本机没有配对设备"，宁愿不认。
 */
const NO_PAIRED_NODE_RE = /no paired nodes? available/i;
const USE_LOCAL_TOOLS_RE = /use local file\/exec tools/i;

/**
 * **唯一判据**：剥样板后的原文 → 形态号；认不出返回 `null`。
 *
 * 入参必须已过 `stripRuntimeBoilerplate`（**不要**传 `sanitizeToolText` 的结果：
 * 遮路径会把 `C:\…\report.docx` 洗成 `report.docx`，参数名提取会把它当名字用）。
 * `explainToolFailure` 与组件侧的 `namedToolFailureKind` 共用这一张表。
 */
export function matchToolFailure(strippedReason: string): ToolFailureKind | null {
  if (!strippedReason) return null;
  if (MISSING_REQUIRED_PARAM_RE.test(strippedReason)) return 'missingParam';
  if (TOOL_NOT_FOUND_RE.test(strippedReason) || UNKNOWN_TOOL_RE.test(strippedReason)) return 'toolUnavailable';
  if (NO_PAIRED_NODE_RE.test(strippedReason) && USE_LOCAL_TOOLS_RE.test(strippedReason)) return 'localTransfer';
  return null;
}

/**
 * 剥样板后的失败文本 → 具名说明；认不出返回 `null`（交回既有兜底链）。
 *
 * ⚠️ 调用方 `productizedToolFailure` 必须先跑 `stripRuntimeBoilerplate`（见文件头两条硬规则）。
 */
export function explainToolFailure(strippedReason: string, t: Translate): string | null {
  const kind = matchToolFailure(strippedReason);
  if (!kind) return null;

  if (kind === 'missingParam') {
    // 参数名只可能在**原文**里被准确提取（判据同上，一处两用，不复制正则）。
    const param = MISSING_REQUIRED_PARAM_RE.exec(strippedReason)?.[1];
    if (!param) return null;
    return t('toolActivity.failure.missingParam', { param });
  }
  if (kind === 'toolUnavailable') return t('toolActivity.failure.toolUnavailable');
  return t('toolActivity.failure.localTransfer');
}
