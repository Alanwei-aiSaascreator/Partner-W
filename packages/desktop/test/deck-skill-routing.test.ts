import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveOurSkillsRoot } from '../src/main/skills/locate.js';

/**
 * 三条出 PPT 的路**必须分工互斥**。
 *
 * 为什么值得单开一个文件：这条链上没有别的守门人 —— 客户端不做任何校验，
 * 运行时不报错，测试不写就永远绿。而**判错路的代价是用户直接看见的**：
 * 走「文档生成」出来的是白底 + 标题 + 项目符号（那条技能自己的对照表都写着"没有版式"），
 * 而走「幻灯版面」出来的是模型自己排的版面、可编辑、**无字数上限**。
 *
 * 🔴 2026-09-28 真机实测（这是本条规矩的来源）：用户说了一句"做个PPT"，
 *    模型照 `document-deck` 的 description 选了它 ⇒ 同一个任务下**四版 PPTX
 *    全部是 `PptxGenJS`**（`docProps/core.xml` 的 `<dc:creator>`），
 *    从"优化版"到"最终版"**一次都没换过路**，只是在同一条路上越磨越花。
 *
 * ⭐ 关键认识：**`description` 是选技能时唯一能看见的东西** ——
 *    正文要等选中之后才会被打开。所以**分工只由 description 决定**，这个文件只钉 description。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, '..');
const OUR_SKILLS_ROOT = resolveOurSkillsRoot({ isPackaged: false, appPath: PROJECT_DIR });
if (!OUR_SKILLS_ROOT) throw new Error('解析不到随包技能根目录 —— 这个测试就失去意义了');
/** ⚠️ 上面的 `throw` 收窄**进不了函数体** ⇒ 在函数里用要先把 string 那份取出来。 */
const SKILLS_ROOT: string = OUR_SKILLS_ROOT;

function descriptionOf(skillDir: string): string {
  const file = path.join(SKILLS_ROOT, skillDir, 'SKILL.md');
  const text = fs.readFileSync(file, 'utf-8').replace(/\r\n/g, '\n');
  const m = text.match(/^description:\s*'([^']*)'/m);
  expect(m, `${skillDir}/SKILL.md 读不到 frontmatter 的 description`).not.toBeNull();
  return m?.[1] ?? '';
}

const 文档生成 = descriptionOf('document-deck');
const 幻灯版面 = descriptionOf('deck-layout');
const 模板版 = descriptionOf('presentation-deck-v2');

describe('出 PPT 的三条路：触发词分工互斥', () => {
  it('⭐「做个PPT」只由「幻灯版面」认领（无字数上限那条，才是该给它的默认）', () => {
    expect(幻灯版面, '「做个PPT」必须由幻灯版面认领 —— 提示词里"自己排版是默认路线"说的就是它').toMatch(
      /做个\s*PPT|做\s*PPT|做一份\s*PPT/,
    );
  });

  it('⭐「文档生成」不许认领「做个PPT」（它会出白底 + 项目符号的素版）', () => {
    expect(文档生成, '三条路里最朴素的那条不该收 PPT 请求').not.toMatch(/做个\s*PPT/i);
  });

  it('「文档生成」仍然认领文档三格式 —— 别把触发词一起让掉', () => {
    for (const trigger of ['写份报告', '整理成表格', '导出PDF']) {
      expect(文档生成, `「文档生成」丢了「${trigger}」⇒ 那种格式没人认领`).toContain(trigger);
    }
  });

  it('⭐「文档生成」的 description 要**明说**它不是拿给人看的那条', () => {
    // 只删触发词不够：模型在"没听清用哪条"时需要一句能行动的指路，否则它还是会回来。
    expect(文档生成, '要写明"要拿给人看的演示文稿不要用这条"').toMatch(/幻灯版面|模板版/);
  });

  it('「幻灯版面」不许把自己说成"随手草稿用文档生成"—— 那是在往朴素路推', () => {
    expect(幻灯版面, '这句话会把 PPT 请求推回最朴素那条').not.toMatch(/随手草稿用\s*「?文档生成/);
  });

  it('⭐「模板版」要写明它的格子有字数上限 —— 不写，模型就会拿它当默认然后整份被拒', () => {
    // 这正是 2026-09-27 真机那次事故的形状：模型看见"模板"就用了，
    // 撞上每格 ~40 字的上限 ⇒ **整份被拒** ⇒ 用户一个文件都没拿到。
    // 描述里不写这条，模型没有理由不选它。
    expect(模板版, '模板版必须自报"每格有字数上限"，否则它会看起来是纯赚').toMatch(/上限/);
  });

  it('⭐ 三条路的 description 两两不重复认领同一个触发词', () => {
    // 只需要钉一条最要命的：PPT 这个触发词只能有一个主人。
    const 认领PPT = [文档生成, 幻灯版面, 模板版].filter((d) => /做个\s*PPT/i.test(d));
    expect(认领PPT, `「做个PPT」被 ${认领PPT.length} 条描述认领 —— 必须只有一条`).toHaveLength(1);
  });
});
