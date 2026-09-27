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
 */
export function documentFileStem(title: string, fallbackStem: string): string {
  const withoutControls = [...title].map((ch) => (ch.charCodeAt(0) < 0x20 ? ' ' : ch)).join('');
  const cleaned = withoutControls
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DOCUMENT_STEM_CHARS);
  return cleaned || fallbackStem;
}
