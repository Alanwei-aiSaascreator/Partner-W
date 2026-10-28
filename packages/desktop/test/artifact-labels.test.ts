import { describe, expect, it } from 'vitest';
import { getArtifactKindFilter, getArtifactLabel } from '../src/renderer/lib/artifact-labels';

/**
 * 产物类型标签。
 *
 * ⭐ 修的是 0.0.35 账本 §六-4：**`.html` 在列表里显示成「文本文件」**。
 * 根因是 `text/` 那个泛匹配把 `text/html` 一起吃掉了 —— 而 0.0.35 已经能**真渲染**
 * HTML 产物了（沙箱 iframe），标签却还说它是文本 ⇒ 界面在自我否定。
 *
 * ⚠️ 判据用**精确串**（`artifactKinds.html`），不是"不等于 text"：
 *    "不是文本"会被 `artifactKinds.file` 之类满足（本项目栽过这种断言）。
 */
const t = (key: string) => key;

const label = (artifact: { type: string; mimeType: string; name: string }) => getArtifactLabel(artifact as never, t);

describe('产物标签 × HTML', () => {
  it('⭐ text/html（浏览器会把它当网页）⇒ 网页，不是文本文件', () => {
    expect(label({ type: 'file', mimeType: 'text/html', name: 'report.html' })).toBe('artifactKinds.html');
  });

  it('⭐ 靠扩展名也认得（mime 常常是空串或 application/octet-stream）', () => {
    expect(label({ type: 'file', mimeType: '', name: '验收.html' })).toBe('artifactKinds.html');
    expect(label({ type: 'file', mimeType: 'application/octet-stream', name: 'page.htm' })).toBe('artifactKinds.html');
  });

  it('大小写不敏感（`.HTML` 也是网页）', () => {
    expect(label({ type: 'file', mimeType: '', name: 'INDEX.HTML' })).toBe('artifactKinds.html');
  });

  it('⚠️ 别把别的文本类型一起吞了：md 还是 Markdown、txt 还是文本', () => {
    expect(label({ type: 'file', mimeType: 'text/markdown', name: 'a.md' })).toBe('artifactKinds.markdown');
    expect(label({ type: 'file', mimeType: 'text/plain', name: 'a.txt' })).toBe('artifactKinds.text');
    expect(label({ type: 'file', mimeType: 'text/csv', name: 'a.csv' })).toBe('artifactKinds.text');
  });

  /**
   * ⚠️ 判据必须是**结尾**，不是"名字里含 `.html`"。
   *    ⭐ 这条夹具第一版写的是 `html-notes.txt` —— 里面**根本没有 `.html` 这个子串**，
   *    于是把 `endsWith` 改成 `includes` 的变异**活了下来**（变异测试抓到的）。
   *    换成 `report.html.bak`：它含 `.html` 却**不以它结尾**，才真的钉住这件事。
   */
  it('⚠️ 名字里含 `.html` 但结尾不是 ⇒ 不算网页（判据是结尾，不是包含）', () => {
    expect(label({ type: 'file', mimeType: 'text/plain', name: 'report.html.bak' })).toBe('artifactKinds.text');
    expect(label({ type: 'file', mimeType: '', name: 'a.html.txt' })).toBe('artifactKinds.text');
  });

  it('图片 / 代码 / 链接 / 数据那几支不受影响', () => {
    expect(label({ type: 'image', mimeType: 'image/png', name: 'a.png' })).toBe('artifactKinds.image');
    expect(label({ type: 'code', mimeType: '', name: 'a.ts' })).toBe('artifactKinds.code');
    expect(label({ type: 'link', mimeType: '', name: 'a' })).toBe('artifactKinds.link');
    expect(label({ type: 'structured_data', mimeType: '', name: 'a' })).toBe('artifactKinds.data');
  });
});

/**
 * ⭐ BUG-120（2026-10-17）：视频有了专属类型 `video` 之后，
 * **标签**要跟着说"视频"（改型前它落进 `artifactKinds.file`，界面上写着「文件」），
 * 而**筛选档**必须仍然留在「文件」那一档 —— 否则老用户在文件列表里就找不到自己刚生成的视频了。
 */
describe('产物标签 × 视频（BUG-120）', () => {
  it('type=video ⇒ 标签是「视频」，不是「文件」', () => {
    expect(label({ type: 'video', mimeType: 'video/mp4', name: '短片.mp4' })).toBe('artifactKinds.video');
    expect(label({ type: 'video', mimeType: 'video/webm', name: 'clip.webm' })).toBe('artifactKinds.video');
  });

  it('⚠️ 筛选档仍是 file（改型不能把视频从「文件」筛选里挤出去）', () => {
    expect(getArtifactKindFilter({ type: 'video', mimeType: 'video/mp4', name: '短片.mp4' })).toBe('file');
  });

  it('对照：图片/代码的筛选档不受影响', () => {
    expect(getArtifactKindFilter({ type: 'image', mimeType: 'image/png', name: 'a.png' })).toBe('image');
    expect(getArtifactKindFilter({ type: 'code', mimeType: '', name: 'a.ts' })).toBe('code');
    expect(getArtifactKindFilter({ type: 'file', mimeType: 'application/pdf', name: 'a.pdf' })).toBe('file');
  });
});
