/**
 * 产物文件名的**主名**（不含扩展名）怎么从标题来。
 *
 * ⚠️ 为什么抽出来：`docgen`（pptx/docx/xlsx/pdf）与 `htmlgen`（html）两处都要这条规则。
 *    各写一份的话，改了一边另一边不会红 —— 而"文件名里带了 `?` 或控制字符"这件事
 *    在 Windows 上是**写不进去**（`saveArtifactFromBuffer` 直接抛），
 *    表现是"某种格式生成失败、另一种好好的"，很难一眼看出是命名规则分了叉。
 */

/** 主名的长度上限（Windows 路径长度）。扩展名另算，所以各格式的总长一致。 */
export const MAX_DOCUMENT_STEM_CHARS = 60;

/**
 * 用标题做文件名主名：去掉 Windows 不允许的字符与控制字符；留空则退回该格式的稳定名字。
 *
 * ⚠️ 控制字符**不要直接写进正则字符类**：把控制字符以字面量形式写出来时，
 *    只要中间有一层把它解释成真字节，代码文件里就会出现真的 NUL ——
 *    grep 会直接把整个文件当二进制，那条正则也变成只匹配那两个码点。
 *    这里改成逐字符判断（`charCodeAt`），绕开所有转义层。
 *
 * ⭐ **连续点必须在这里洗掉（BUG-042-a，2026-10-08 亲验必炸）**：
 *    标题 `关于...的说明` / `第1..3章` 会原样产出含 `..` 的主名，而落盘层的
 *    `workspace/safe-name.ts` 把「名字里含 `..`」当**路径逃逸**无条件 throw ⇒
 *    docgen 整份报 `render-failed`、一个文件都不出。
 *    修在**源头**（这里），不是放松落盘层的守卫 —— 那道守卫守的是任意来源的名字。
 *    单个 `.` 照旧保留（`v1.2 报告` 是正常文件名）；替换成一个安全字符 `·`
 *    （与产品自己生成的名字同款分隔符，NTFS/exFAT 上都合法，也不是路径字符）。
 */
export function documentFileStem(title: string, fallbackStem: string): string {
  const withoutControls = [...title].map((ch) => (ch.charCodeAt(0) < 0x20 ? ' ' : ch)).join('');
  const cleaned = withoutControls
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\.{2,}/g, '·')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DOCUMENT_STEM_CHARS)
    // ⭐ **截断之后**还要再洗一次收尾的点/空白（BUG-058①，2026-10-13 联审残余）：
    //    标题以单个点结尾（`方案.`）或第 60 个字符恰好是点（截断把点留在末尾）时，
    //    出片路拼 `${stem}${ext}` 会得到 `方案..docx` —— 落盘层
    //    `workspace/safe-name.ts:8` 的 `includes('..')` 守卫把这个当路径逃逸**无条件 throw**
    //    ⇒ 整份 render-failed（BUG-042-a 只洗了连续点，尾点没治）。
    //    去这里是"源头"修法：落盘层守的是任意来源的名字，一个字都不放松。
    //    `[.\s]+$` 一并吃掉"点 + 空白"的组合；中间的点（`v1.2`）完好保留；
    //    全部去空（`.` / `. . .`）⇒ 退回 `fallbackStem`。
    .replace(/[.\s]+$/, '');
  return cleaned || fallbackStem;
}
