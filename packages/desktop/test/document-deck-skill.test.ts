import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveOurSkillsRoot } from '../src/main/skills/locate.js';
import { DOCGEN_LIMITS } from '../src/main/docgen/request.js';

/**
 * 技能正文（`our-skills/document-deck/SKILL.md`）**必须真的教了三种格式**。
 *
 * 为什么这个也要钉：**助手能不能产出 Word / Excel，唯一通路就是这份文档**。
 * 客户端不做任何校验（技能里写漏一种，运行时不报错、测试也不红），
 * 表现只是"助手照旧说一句做不到" —— 用户看不出是文档写漏了还是能力没做。
 *
 * ⭐ 更值钱的是**上限数字**：技能里写着"60 页"，而契约层（`DOCGEN_LIMITS`）改成 50 时，
 *    助手会照着 60 写 ⇒ 请求被整份拒绝 ⇒ 用户拿到的是"什么都没生成"。
 *    两边一起改才不会漂，所以这里**从 `DOCGEN_LIMITS` 取值**去比。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, '..');
/** ⚠️ `resolveOurSkillsRoot` 可能给 undefined（解析不到就明说，别拿 undefined 去拼路径）。 */
const OUR_SKILLS_ROOT = resolveOurSkillsRoot({ isPackaged: false, appPath: PROJECT_DIR });
if (!OUR_SKILLS_ROOT) throw new Error('解析不到随包技能根目录 —— 这个测试就失去意义了');
const SKILL_PATH = path.join(OUR_SKILLS_ROOT, 'document-deck', 'SKILL.md');
const text = fs.readFileSync(SKILL_PATH, 'utf-8').replace(/\r\n/g, '\n');

describe('document-deck 技能：四种格式都教到了', () => {
  it('四种 kind 的 JSON 示例都在（少一种，那种格式就用不出来）', () => {
    for (const kind of ['pptx', 'docx', 'xlsx', 'pdf']) {
      expect(text, `正文里没有 "kind": "${kind}" 的示例`).toContain(`"kind": "${kind}"`);
    }
  });

  it('⭐ 旧的"PDF 做不到"口径必须已经删干净（否则助手照旧拒绝）', () => {
    expect(text).not.toMatch(/要\s*\*{0,2}PDF\*{0,2}\s*、?\s*要\*{0,2}图片[^\n]*这两种做不到/);
    expect(text, '图片仍然做不到，这条不能顺手删了').toMatch(/图片/);
  });

  it('每种格式的内容字段都写着（助手照字段名写请求）', () => {
    for (const field of ['slides', 'sections', 'paragraphs', 'bullets', 'sheets', 'rows', 'heading', 'name']) {
      expect(text, `正文里没提 ${field}`).toContain(field);
    }
  });

  it('⭐ 上限数字与契约层一致（技能里写大了 ⇒ 助手越界 ⇒ 整份被拒）', () => {
    const L = DOCGEN_LIMITS;
    const expectations: [string, string][] = [
      [`${L.maxSlides} 页`, 'pptx 页数'],
      [`${L.maxBulletsPerSlide} 条`, 'pptx 每页要点数'],
      [`${L.maxTitleChars} 字`, 'pptx/docx 标题字数'],
      [`${L.maxBulletChars} 字`, '要点字数'],
      [`${L.maxNotesChars} 字`, '讲者备注字数'],
      [`${L.maxSections} 个`, 'docx 小节数'],
      [`${L.maxParagraphsPerSection} 段`, 'docx 每节段数'],
      [`${L.maxParagraphChars} 字`, 'docx 单段字数'],
      [`${L.maxSheets} 张`, 'xlsx 表数'],
      [`${L.maxRowsPerSheet} 行`, 'xlsx 每表行数'],
      [`${L.maxColumnsPerSheet} 格`, 'xlsx 每行格数'],
      [`${L.maxCellChars} 字`, '单元格字数'],
      [`${L.maxSheetNameChars} 字`, '表名字数'],
    ];
    for (const [needle, what] of expectations) {
      expect(text, `技能里没有「${needle}」（${what}）—— 契约层改了就要同步改技能`).toContain(needle);
    }
  });

  it('Excel 的三条硬限制写着（表名长度 / 禁用字符 / 不能重名）', () => {
    expect(text).toMatch(/不能含/);
    expect(text).toMatch(/不能重名/);
  });

  it('⭐ 旧的"Word / Excel 做不到"口径必须已经删干净（否则助手照旧拒绝）', () => {
    expect(text).not.toContain('Word / Excel 还做不到');
    expect(text).not.toContain('只能出 PPT');
  });

  it('⭐ 仍然不许说"文件已经存在"（客户端在这一轮结束后才渲染）', () => {
    expect(text).toMatch(/不要说「已经生成了」/);
    expect(text).toMatch(/右侧「产物」/);
  });
});
