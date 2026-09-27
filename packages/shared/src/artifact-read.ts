/**
 * **把一份产物读成文本**的结果形状（`artifact:read-file`）。
 *
 * 为什么要有它：这个通道原来是"要么给内容、要么给一句英文错误"，于是**"太大了"这件事
 * 没有承载位** —— 只能挤进 `error` 里当一句内部话（`artifact too large`），
 * 界面如实透出来就是给用户看英文，或者更糟：整份文件被读成字符串送进高亮，
 * 界面直接卡死。两种情况用户都看不出"这个文件其实没问题，只是太大"。
 *
 * ⚠️ 定义在 shared 是**故意的**：这个形状要跨主进程 → preload → 渲染层三道边界，
 *    每层各写一遍必然漂移（`ArtifactPreview` / `DocgenFailure` 都是这么收进来的）。
 * ⚠️ 这是**判别联合**，不是"一个可选字段"：`content` 与 `tooLarge` 不可能同时有意义，
 *    写成可选字段时调用方为了编译过会写 `result.content ?? ''` ——
 *    那正好是"把空字符串当文件内容"发出去，比报错难查得多。
 */

/**
 * 文本读法的结果。
 *
 * - `{ content, encoding }`：读到了。`encoding` 是**这份内容按什么解的**，
 *   调用方拿它决定"进高亮"还是"当二进制附件"（图片走 base64 那条）。
 * - `{ tooLarge, size }`：文件是好的，是我们**不肯**整份搬进内存。
 *   `size` 带上是为了界面能说出"有多大"，而不是干巴巴一句"太大了"。
 */
export type ArtifactFileReadResult =
  | { content: string; encoding: 'utf-8' | 'base64' }
  | { tooLarge: true; size: number };
