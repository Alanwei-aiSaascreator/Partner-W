import { describe, expect, it } from 'vitest';
import { extractCodeBlocksFromMarkdown } from '../src/main/artifact/extract';

/**
 * 用户反馈（10-02 邱天佑，`USER-FEEDBACK-TRIAGE-20261006.md` #9）：
 * "重新生成 docx：桌面出现 js 文件；新 docx 打不开/乱码；手动切换模型才正常。"
 *
 * 围栏块（```` ```name.ext ````）会被 `autoExtractArtifacts` 原样存成**真文件**。
 * 这对文本格式（.json/.md/.js/...）是设计行为，但围栏内容**永远是文本**：
 * 一旦模型把围栏标成二进制文档名（`报告.docx` / `台账.xlsx` / `deck.pptx` / `draft.pdf`），
 * 客户端就会 mint 出一个「扩展名是 Office/PDF、内容是纯文本」的假文档 ——
 * Word/WPS 打开必然报损坏或乱码，且它会带着官方 MIME 进入用户产物列表。
 *
 * 本条钉住：**二进制文档扩展名的围栏不产出文件**（内容仍留在聊天里，
 * 真文档只能走 docgen 通道渲染）。
 */
describe('extractCodeBlocksFromMarkdown · 围栏名字的扩展名', () => {
  /** >10 行，确保不会被 "短块不抽" 规则提前吞掉，从而真正走到命名逻辑。 */
  const longBody = Array.from({ length: 12 }, (_, index) => `第 ${index + 1} 行内容`).join('\n');
  const fence = (name: string) => `\`\`\`${name}\n${longBody}\n\`\`\``;

  it.each(['报告.docx', '报告.DOCX', '台账.xlsx', 'deck.pptx', 'draft.pdf', '老文档.doc', '旧表.xls', '旧稿.ppt'])(
    '不把文本围栏 mint 成二进制文档：%s',
    (name) => {
      expect(extractCodeBlocksFromMarkdown(fence(name))).toEqual([]);
    },
  );

  it.each(['report.json', 'notes.md', 'generate.js', 'script.py', 'custom.txt', '.gitignore'])(
    '文本扩展名的围栏照旧保留：%s',
    (name) => {
      const blocks = extractCodeBlocksFromMarkdown(fence(name));
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({ fileName: name, content: longBody });
    },
  );

  it('无点围栏照旧走 snippet 兜底（这是「文件」通道的设计行为）', () => {
    const blocks = extractCodeBlocksFromMarkdown(`\`\`\`js\n${longBody}\n\`\`\``);
    expect(blocks).toHaveLength(1);
    // ⚠️ 只钉"仍然产出一份 snippet 文件"这件事：本轮不改 `LANG_EXT` 的映射
    //   （它没有 `js`/`ts` 短名 ⇒ 现状兜底成 `.txt`，与本反馈无关，留给 owner 决定）。
    expect(blocks[0]?.fileName).toMatch(/^snippet-[0-9a-f]{6}\./);
  });
});
