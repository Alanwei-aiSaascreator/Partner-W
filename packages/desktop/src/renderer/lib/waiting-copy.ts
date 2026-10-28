/**
 * 等待期的中性文案：本地计时只表示已等待多久。
 *
 * ## 为什么要有它
 *
 * 用户报的体感是「卡住好久突然跳出来」。但拆开看，"卡住"里有一大半是
 * **看不出它还在动**：正文不流式（那是上游 openclaw 的行为，我们修不了，
 * 见 `docs/` 下的流式结论），等待期界面上又只有一行静态文案。
 *
 * 按已等待时长轮换提示，不用定时器推断后台存活、正在执行的动作或任务难度。
 * 真实动作由网关或主进程事件单独提供。
 *
 * ## ⚠️ 一条硬纪律：不许承诺完成时间
 *
 * 「马上就完成啦」这类话**不能写**。回答要真拖到 90 秒，它就从安慰变成了
 * 用户截图发朋友圈的素材 —— 性质跟"把暂时失败写成确定失败"是同一类
 *（那条我们已经修过一次，见 [[commercial-call-timeouts-and-false-exhaustion]]）。
 * 提示只描述等待，不能承诺完成时间或声称后台仍在处理。
 *
 * ## i18n 形状不是随便定的
 *
 * key 必须是 `` `chatInput.waiting.line.${band}${index}` `` 这种**前缀 + 纯后缀**的模板串：
 * `scripts/lib/i18n-usage.mjs` 的扫描器**看不见** `t(映射表[x])` 那种写法，
 * 会把文案判成 unused 然后失败。见 [[i18n-and-testing-gotchas-p1]]。
 */

/**
 * i18n key 的**完整前缀** —— 只给测试用（拿它去 locale 文件里查 key 在不在）。
 *
 * ⚠️ 这里**故意不导出**一个"帮我拼好 key"的函数：那样调用方会写成
 *    `t(waitingLineKey(ms))` —— 而 `scripts/lib/i18n-usage.mjs` 的扫描器
 *    **只认字面 key 或 `` t(`前缀${变量}`) `` 这种模板串**，函数调用它看不见，
 *    于是这些文案会被判成 unused、`check:i18n` 直接失败（真踩过）。
 *    调用方必须自己写出模板串，见 `ComposerActivity`。
 */
export const WAITING_LINE_PREFIX_FOR_TESTS = 'chatInput.waiting.line.';

/** 多久换一句。太快像闪烁，太慢像卡住。 */
export const WAITING_ROTATE_MS = 6000;

/** 每一档备几句。轮完一圈从头来。 */
export const WAITING_LINES_PER_BAND = 3;

/**
 * 三档，按"已经等了多久"分：
 *   - `fresh`     < 30s
 *   - `long`      30–90s
 *   - `veryLong`  ≥ 90s
 * 分档不意味着后台状态发生了变化。
 */
// 不导出：外部只需要 `waitingBand()` 的返回值，不需要这个名字
//（`check:dead-code` 会把"导出了但没人用"抓出来，别为对称而导出）。
type WaitingBand = 'fresh' | 'long' | 'veryLong';

const LONG_AFTER_MS = 30_000;
const VERY_LONG_AFTER_MS = 90_000;

/** 把任意输入夹成合法的毫秒数（负数 / NaN / 非有限值都当 0）。 */
function safeElapsed(elapsedMs: number): number {
  return Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
}

export function waitingBand(elapsedMs: number): WaitingBand {
  const ms = safeElapsed(elapsedMs);
  if (ms >= VERY_LONG_AFTER_MS) return 'veryLong';
  if (ms >= LONG_AFTER_MS) return 'long';
  return 'fresh';
}

/**
 * 这一秒该显示哪一句。
 *
 * 必须是**确定性**的（同一个毫秒数永远给同一句）：随机会让每次 re-render
 * 都换一句，看起来像界面坏了；而调用方本来就每秒重渲染一次，
 * 用"已等待时长"推索引就自然轮播了。
 */
export function waitingLineSuffix(elapsedMs: number): string {
  const ms = safeElapsed(elapsedMs);
  const band = waitingBand(ms);
  const index = Math.floor(ms / WAITING_ROTATE_MS) % WAITING_LINES_PER_BAND;
  // 只给**后缀**，前缀由调用方写在 `t()` 的模板串里（扫描器要看得见）。
  return `${band}${index}`;
}

/**
 * 那个"一直在走的秒数"。
 *
 * 本地计算的已等待时长不证明后台存活，也不估算剩余时间。
 * 格式与用户看过的方案预览一致（`12.4s` / `143.7s`），不做 mm:ss 换算。
 */
export function formatElapsed(elapsedMs: number): string {
  return `${(safeElapsed(elapsedMs) / 1000).toFixed(1)}s`;
}
