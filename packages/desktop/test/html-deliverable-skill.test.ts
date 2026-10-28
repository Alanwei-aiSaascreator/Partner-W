import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HTMLGEN_TEMPLATES } from '@clawwork/shared';
import { resolveOurSkillsRoot } from '../src/main/skills/locate.js';
import { HTMLGEN_LIMITS, HTMLGEN_TEMPLATE_SPECS } from '../src/main/htmlgen/request.js';

/**
 * 技能正文（`our-skills/html-deliverable/SKILL.md`）**必须真的教了这条通道**。
 *
 * 为什么这个也要钉：**助手能不能产出网页，唯一通路就是这份文档**。
 * 客户端不做任何"猜"（内容不合规就整份拒），技能里写漏一种版式、或把上限写大了，
 * 运行时不报错、别的测试也不红，表现只是"助手照旧说一句做不到"或者
 * "用户拿到一条莫名其妙的拒绝提示" —— 两者都看不出是文档写漏了。
 *
 * ⭐ 更值钱的是**上限数字**：技能里写着"80 行"，而契约层（`HTMLGEN_LIMITS`）改成 40 时，
 *    助手会照着 80 写 ⇒ 请求被整份拒绝 ⇒ 用户拿到的是"什么都没生成"。
 *    两边一起改才不会漂，所以这里**从 `HTMLGEN_LIMITS` 取值**去比。
 *
 * ⚠️ 与 `document-deck-skill.test.ts` 一样，只验"教到了没有"，不验文风。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, '..');
/** ⚠️ `resolveOurSkillsRoot` 可能给 undefined（解析不到就明说，别拿 undefined 去拼路径）。 */
const OUR_SKILLS_ROOT = resolveOurSkillsRoot({ isPackaged: false, appPath: PROJECT_DIR });
if (!OUR_SKILLS_ROOT) throw new Error('解析不到随包技能根目录 —— 这个测试就失去意义了');
const SKILL_PATH = path.join(OUR_SKILLS_ROOT, 'html-deliverable', 'SKILL.md');
const text = fs.readFileSync(SKILL_PATH, 'utf-8').replace(/\r\n/g, '\n');

describe('html-deliverable 技能：通道与版式都教到了', () => {
  it('围栏语言写着 `htmlgen`（写错一个字母，这条通道就永远用不出来）', () => {
    expect(text).toContain('htmlgen');
  });

  it('⭐ 五个版式**逐个**给出 id 与用途（少一个，那种版式就用不出来）', () => {
    for (const template of HTMLGEN_TEMPLATES) {
      expect(text, `正文里没有版式 ${template}`).toContain(`\`${template}\``);
    }
  });

  it('⭐ 四种小节的 `kind` 都写着（助手照字段名写请求）', () => {
    for (const kind of ['narrative', 'metrics', 'table', 'actions']) {
      expect(text, `正文里没有小节类型 ${kind}`).toContain(`"kind": "${kind}"`);
    }
  });

  it('每类小节的字段都写着', () => {
    for (const field of [
      'heading',
      'paragraphs',
      'bullets',
      'items',
      'label',
      'value',
      'caption',
      'columns',
      'rows',
      'title',
      'owner',
      'due',
    ]) {
      expect(text, `正文里没提 ${field}`).toContain(field);
    }
  });

  it('⭐ 上限数字与契约层一致（技能里写大了 ⇒ 助手越界 ⇒ 整份被拒）', () => {
    const L = HTMLGEN_LIMITS;
    const expectations: [string, string][] = [
      [`${L.maxSections} 个小节`, '小节数'],
      [`${L.maxSources} 条`, '来源条数'],
      [`${L.maxTitleChars} 字`, '标题字数'],
      [`${L.maxSummaryChars} 字`, '摘要字数'],
      [`${L.maxParagraphs} 段`, '正文段数'],
      [`${L.maxParagraphChars} 字`, '单段字数'],
      [`${L.maxBullets} 条`, '要点条数'],
      [`${L.maxBulletChars} 字`, '单条要点字数'],
      [`${L.maxMetricItems} 张`, '指标卡数'],
      [`${L.maxTableColumns} 列`, '表格列数'],
      [`${L.maxTableRows} 行`, '表格行数'],
      [`${L.maxTableCellChars} 字`, '单元格字数'],
      [`${L.maxActionItems} 条`, '行动项数'],
      [`${L.maxActionDetailChars} 字`, '行动项说明字数'],
    ];
    for (const [needle, what] of expectations) {
      expect(text, `技能里没有「${needle}」（${what}）—— 契约层改了就要同步改技能`).toContain(needle);
    }
  });

  it('⭐ 每种版式"至少要哪一类内容"都写着（写漏 ⇒ 助手按错的版式配内容 ⇒ 整份被拒）', () => {
    // 中文说法与契约层的小节类型一一对应（技能是给人看的，写 `narrative` 用户读不懂）
    const label: Record<string, string> = { narrative: '正文', metrics: '指标', table: '表格', actions: '行动项' };
    const lines = text.split('\n');
    for (const template of HTMLGEN_TEMPLATES) {
      const required = HTMLGEN_TEMPLATE_SPECS[template].requires.map((kind) => label[kind]);
      // 判据：**存在一行**同时写着这个版式名与它要的那一类内容
      //（不能只找"含版式名的第一行" —— 上面那张"用途表"也含版式名，那样会张冠李戴）
      const row = lines.find(
        (line) => line.includes(`\`${template}\``) && required.some((word) => line.includes(word)),
      );
      expect(row, `没有哪一行同时写着 \`${template}\` 与它要的「${required.join(' / ')}」`).toBeTruthy();
    }
  });

  it('⭐ `data` 版式**不收**行动项这条也写着（助手写进去会整份被拒）', () => {
    expect(text).toMatch(/不收行动项/);
  });

  it('⭐ **不许自己写 HTML** 这条必须明写（这是整条通道的前提）', () => {
    expect(text).toMatch(/不要写 HTML|不要\*\*输出\*\* `?<div>/);
    // 协议外的字段被点名，助手才知道哪些不能写
    for (const forbidden of ['style', 'color', 'src', 'url']) {
      expect(text, `正文里没点名禁掉 ${forbidden}`).toContain(forbidden);
    }
  });

  it('⭐ 仍然不许说"文件已经存在"（客户端在这一轮结束后才生成）', () => {
    expect(text).toMatch(/不要说「已经生成了」/);
    expect(text).toMatch(/右侧「产物」/);
  });

  it('不与 `document-deck` 抢活：要"能接着改"的文件、要 PPT，都指回那边', () => {
    expect(text).toContain('document-deck');
    expect(text).toMatch(/\.docx/);
    expect(text).toMatch(/\.pptx/);
  });
});
