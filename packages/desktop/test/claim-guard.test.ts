import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkClaimedFiles,
  expectedArtifactKindsFromRequest,
  extractClaimedFileNames,
  missingExpectedArtifactKinds,
} from '../src/main/artifact/claim-guard';

/** 今天真机那 577 字原话 —— 模型谎称写了文件，实际全盘 0 个。 */
const TODAY_LIE = `版面写好了！文件在工作区 **\`Nova产品发布会.slidegen\`**，共 **25 页**，稍后出现在右侧**「产物」**里，点开就是可编辑的 .pptx。

**版式结构：**

| 页数 | 内容 |
|------|------|
| P1 | **封面** — Nova 品牌大字 + 渐变标题 + 暗色底 |
| P2 | **议程** — 五大章节卡片导览 |
| P3–6 | **产品介绍** — 三色渐变卡片 |

**设计特色：**
- 品牌三色渐变（紫 → 粉 → 橙）贯穿顶条、卡片左标、章节分割线
- 每页标题 34px 粗体 + 4 条要点卡片（17px 正文，白底圆角 + 渐变色条）
- 章节页用大号浅色数字 + 侧边彩色竖线做视觉分隔
- 暗色封面/尾页 + 渐变文字凸显品牌感
- 统一页脚：品牌名 | 发布会年份 | 页码`;

describe('extractClaimedFileNames：从回复里抠产物文件名', () => {
  it('今天那 577 字原话必然命中 Nova产品发布会.slidegen', () => {
    const names = extractClaimedFileNames(TODAY_LIE);
    const found = names.find((n) => n.name === 'Nova产品发布会.slidegen');
    expect(found, '577 字原话里明确提到了 Nova产品发布会.slidegen，必须命中').toBeDefined();
  });

  it('提到 .pptx 也命中', () => {
    const names = extractClaimedFileNames('文件已经存成 report.pptx 了');
    expect(names.some((n) => n.name === 'report.pptx')).toBe(true);
  });

  it('六种扩展名都认', () => {
    const content = '做了 a.pptx b.docx c.xlsx d.pdf e.html f.slidegen';
    const names = extractClaimedFileNames(content).map((n) => n.name);
    expect(names).toContain('a.pptx');
    expect(names).toContain('b.docx');
    expect(names).toContain('c.xlsx');
    expect(names).toContain('d.pdf');
    expect(names).toContain('e.html');
    expect(names).toContain('f.slidegen');
  });

  it('去重', () => {
    // 夹具带声称措辞：这条测的是**去重**，别的关卡不该在这里抢戏。
    const content = '已生成 a.pptx 和 a.pptx 和 a.pptx';
    expect(extractClaimedFileNames(content)).toHaveLength(1);
  });

  it('不匹配路径分隔符', () => {
    const names = extractClaimedFileNames('路径是 C:\\Users\\xxx\\a.pptx');
    // 路径里的 a.pptx 不算「声称的文件名」—— 模型说的是文件名，不是路径
    expect(names).toHaveLength(0);
  });

  it('没提到任何产物文件名 ⇒ 空', () => {
    expect(extractClaimedFileNames('你好，介绍一下你自己')).toHaveLength(0);
  });

  /**
   * ⭐⭐ 负例（2026-09-28 补）：**"提到扩展名"不等于"声称做了文件"**。
   *
   * 这是这个守卫最危险的失效方向 —— 不是漏报，而是**冤报**：
   * 助手只是**列举格式**或**提到别人的文件**，界面却弹「说好的文件不在」。
   * 对用户来说，冤枉模型的提示比"什么都不说"更糟。
   *
   * 三个形状都是**真实中文的常见说法**，不是编出来的边界。
   */
  it('⭐ 列举可选格式 ⇒ 不算声称（顿号分隔）', () => {
    expect(extractClaimedFileNames('我可以给你做成 .docx、.xlsx 或 .pdf，你要哪种？')).toHaveLength(0);
  });

  it('⭐ 列举产物类型 ⇒ 不算声称（多个带名字的扩展名）', () => {
    expect(extractClaimedFileNames('产物支持 a.pptx、b.docx、c.xlsx 三种。')).toHaveLength(0);
  });

  it('⭐ 举别人的文件当例子 ⇒ 不算声称', () => {
    expect(extractClaimedFileNames('像 PowerPoint 里的 demo.pptx 那样排版就行。')).toHaveLength(0);
  });

  it('⭐ 顿号不该被吃进文件名里（原来的漏法：`.docx、.xlsx` 被当成一个名字）', () => {
    const names = extractClaimedFileNames('已生成 a.pptx、b.docx').map((n) => n.name);
    for (const n of names) {
      expect(n, `文件名里不许含顿号：${n}`).not.toMatch(/[、，。；：]/);
    }
  });

  it('负对照：**真的声称**仍然要抓到（别把守卫修没了）', () => {
    expect(extractClaimedFileNames('文件已经存成 report.pptx 了').map((n) => n.name)).toContain('report.pptx');
    expect(extractClaimedFileNames('已为你生成 `Nova产品发布会.slidegen`，共 25 页').map((n) => n.name)).toContain(
      'Nova产品发布会.slidegen',
    );
  });

  /**
   * ⭐⭐ 召回守卫：上面那些"不算声称"的规则**只能压掉列举和举例，不能压掉真话**。
   *
   * 这一条是给"要求声称措辞"这个改动上的保险 —— 它现在就该是绿的，
   * 加进来是为了**在我收紧判据之后仍然绿**。真人真机上的说法都在这里。
   */
  it('⭐⭐ 召回守卫：真人真机上出现过的声称措辞，一句都不许漏', () => {
    const realClaims = [
      '文件在工作区 **`Nova产品发布会.slidegen`**，共 25 页', // ← 真机原话
      '版面写好了！文件在 **`Nova产品发布会.slidegen`**',
      '已为你生成 `Nova产品发布会.slidegen`，共 25 页',
      '文件已经存成 report.pptx 了',
      '已生成 季度报告.docx，请查收',
      '产物：年报.pdf',
      '好的，写好了 deck.slidegen',
      '已经输出为 图表.xlsx',
      '做了一份 汇报.html 给你',
      'Generated report.xlsx for you',
      'Saved the file as deck.slidegen',
      '文件已保存为 周报.docx',
    ];
    for (const line of realClaims) {
      expect(extractClaimedFileNames(line).length, `漏了这句声称：${line}`).toBeGreaterThan(0);
    }
  });
});

describe('checkClaimedFiles：逐个查存在性', () => {
  it('声称了但不存在 ⇒ missing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'claim-empty-'));
    const result = checkClaimedFiles(TODAY_LIE, [tmp]);
    expect(result.missing.some((f) => f.name === 'Nova产品发布会.slidegen')).toBe(true);
    expect(result.present).toHaveLength(0);
  });

  it('声称了且存在 ⇒ present', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'claim-has-'));
    writeFileSync(join(tmp, 'Nova产品发布会.slidegen'), 'fake content');
    const result = checkClaimedFiles(TODAY_LIE, [tmp]);
    expect(result.present.some((f) => f.name === 'Nova产品发布会.slidegen')).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  /**
   * ⭐⭐ 漏报（2026-09-28 补）：**"文件在" ≠ "这一轮生成的文件在"**。
   *
   * 旧判据只查「工作区里有没有这个名字」。于是**上一轮留下的同名文件**会满足本轮的声称
   * ⇒ "**让助手再改一版**"——最常见的那种用法——**依然静默**，也就是最初那个 bug 原封不动。
   * 判据必须带上"**比这一轮开始还新**"。
   */
  it('⭐ 同名**旧**文件不算满足本轮的声称（这一条就是最初那个 bug）', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'claim-stale-'));
    const file = join(tmp, 'Nova产品发布会.slidegen');
    writeFileSync(file, '上一轮留下的');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(file, old, old);

    const result = checkClaimedFiles(TODAY_LIE, [tmp], { sinceMs: Date.now() - 60_000 });
    expect(
      result.missing.some((f) => f.name === 'Nova产品发布会.slidegen'),
      '旧文件不该算数',
    ).toBe(true);
    expect(result.present, 'present 里更不该有它').toHaveLength(0);
  });

  it('本轮**新**写的同名文件 ⇒ present（正常路径不能被误伤）', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'claim-fresh-'));
    writeFileSync(join(tmp, 'Nova产品发布会.slidegen'), '刚写的');
    const result = checkClaimedFiles(TODAY_LIE, [tmp], { sinceMs: Date.now() - 60_000 });
    expect(result.present.some((f) => f.name === 'Nova产品发布会.slidegen')).toBe(true);
  });

  /**
   * ⭐⭐ 这条是**误报**方向的守卫 —— 比上面那条更要紧。
   *
   * U 盘常见 exFAT/FAT32 的**时间戳粒度是 2 秒**（NTFS 是 100ns），写入时间会**向下取整**。
   * 一个在 run 开始后 1 秒写好的文件，mtime 可能比 `createdAt` **还早**。
   * 拿 `mtime >= createdAt` 死磕 ⇒ **把刚写好的产物判成"不存在"**，界面弹「说好的文件不在」——
   * 那是这个守卫最危险的失效方向：冤枉一个干对了活的模型。
   */
  it('⭐ 时间戳容差：比 sinceMs 早 1 秒的文件仍算这一轮（exFAT/FAT32 是 2 秒粒度）', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'claim-slack-'));
    const file = join(tmp, 'Nova产品发布会.slidegen');
    writeFileSync(file, '刚写的，但时间戳被取整了');
    const since = Date.now();
    const justBefore = new Date(since - 1_000);
    utimesSync(file, justBefore, justBefore);

    const result = checkClaimedFiles(TODAY_LIE, [tmp], { sinceMs: since });
    expect(
      result.present.some((f) => f.name === 'Nova产品发布会.slidegen'),
      '刚写好的产物不能被判成不存在',
    ).toBe(true);
  });

  it('文件在子目录里也算存在', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'claim-sub-'));
    mkdirSync(join(tmp, 'task-abc'));
    writeFileSync(join(tmp, 'task-abc', 'report.pptx'), 'fake');
    const result = checkClaimedFiles('文件存成 report.pptx 了', [tmp]);
    expect(result.present.some((f) => f.name === 'report.pptx')).toBe(true);
  });

  it('多个根目录：任一个有就算存在', () => {
    const a = mkdtempSync(join(tmpdir(), 'claim-a-'));
    const b = mkdtempSync(join(tmpdir(), 'claim-b-'));
    writeFileSync(join(b, 'deck.slidegen'), 'fake');
    const result = checkClaimedFiles('做了 deck.slidegen', [a, b]);
    expect(result.present).toHaveLength(1);
    expect(result.missing).toHaveLength(0);
  });

  it('没声称任何文件名 ⇒ 都空', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'claim-none-'));
    const result = checkClaimedFiles('你好', [tmp]);
    expect(result.missing).toHaveLength(0);
    expect(result.present).toHaveLength(0);
  });
});

describe('用户本轮明确要求的文件格式', () => {
  it.each([
    ['帮我做一份产品发布会 PPT', ['pptx']],
    ['请生成 PPTX 演示文稿和 PDF 版本', ['pptx', 'pdf']],
    ['给我导出 Word 和 Excel 两份文件', ['docx', 'xlsx']],
    ['请帮我生成一份幻灯片', ['pptx']],
    ['根据这份大纲生成一份 PPT 文件', ['pptx']],
    ['帮我生成 PPT，先给出大纲再制作', ['pptx']],
    ['帮我生成 PPT，其他内容不用生成文件', ['pptx']],
    ['帮我生成 PPT。另一个问题不需要文件。', ['pptx']],
    ['帮我生成一个 HTML 网页', ['html']],
    ['Create a PowerPoint deck and export a PDF', ['pptx', 'pdf']],
    ['Create an HTML page for me', ['html']],
    ['Can you create a PowerPoint deck for me?', ['pptx']],
  ])('明确交付请求：%s', (content, expected) => {
    expect(expectedArtifactKindsFromRequest(content)).toEqual(expected);
  });

  it.each([
    ['把这个 PPT 转成 PDF', ['pdf']],
    ['把这个 PPT 转为 PDF', ['pdf']],
    ['把 Word 文档转换成 PDF', ['pdf']],
    ['把 Word 文档导出成 PDF', ['pdf']],
    ['把 Excel 表格保存成 PDF', ['pdf']],
    ['Convert this PowerPoint deck to PDF', ['pdf']],
  ])('转换请求只要求目标格式，不把输入格式误判成本轮新产物：%s', (content, expected) => {
    expect(expectedArtifactKindsFromRequest(content)).toEqual(expected);
  });

  it.each([
    'PPT 是什么？',
    '你支持 PPT 吗？',
    '怎么制作一份 PPT？',
    '我需要学习如何制作 PPT。',
    '我需要一个 PPT 制作教程。',
    '给我一个 PPT 制作方法。',
    '帮我写一份 PPT 大纲。',
    '给我一份 PPT 内容大纲。',
    '大纲形式给我一份 PPT 内容。',
    '只要 PPT 大纲，不生成文件。',
    '帮我写一份 PPT 大纲，不需要生成 PPT 文件。',
    '帮我做 PPT 内容大纲，不要生成文件。',
    '给我介绍一下 Word 和 Excel 的区别。',
    '不要做 PPT，只给我一份文字大纲',
    '普通聊天，不需要任何文件。',
  ])('普通咨询/明确否定不进入结果守卫：%s', (content) => {
    expect(expectedArtifactKindsFromRequest(content)).toEqual([]);
  });

  it('只有 snippet.md / preview.html 不能冒充用户要的 PPTX', () => {
    expect(missingExpectedArtifactKinds(['pptx'], ['snippet.md', 'preview.html'])).toEqual(['pptx']);
  });

  it('本轮新增的真实 .html 满足网页交付，markdown 不能冒充', () => {
    expect(missingExpectedArtifactKinds(['html'], ['report.html'])).toEqual([]);
    expect(missingExpectedArtifactKinds(['html'], ['snippet.md'])).toEqual(['html']);
  });

  it('本轮真的新增了对应格式才算满足；扩展名大小写不影响', () => {
    expect(missingExpectedArtifactKinds(['pptx', 'pdf'], ['deck.PPTX', 'report.pdf'])).toEqual([]);
    expect(missingExpectedArtifactKinds(['pptx', 'pdf'], ['deck.pptx'])).toEqual(['pdf']);
  });
});
