import { describe, expect, it } from 'vitest';
import {
  BODY_BOX,
  COVER_TITLE,
  COVER_TITLE_MIN_PT,
  LINE_SPACING,
  MAX_BODY_PT,
  MIN_BODY_PT,
  bodyFontSizePt,
  coverTitleLinesAt,
  coverTitlePtFor,
  estimateBodyHeightPt,
  estimateTextHeightPt,
  findPptxLayoutProblem,
} from '../src/main/docgen/pptx-layout';
import type { DocgenPptxRequest } from '../src/main/docgen/request';

/**
 * 正文字号是**算出来的**，不是写死的。
 *
 * 写死 18pt 是量出来的 bug（2026-09-26，WPS 渲染成图看的）：
 * 12 条短要点就把第 1 条压在标题上；12 条 × 300 字上下都冲出版面。
 * 而契约允许一页 12 条（`DOCGEN_LIMITS` 是 P1 定死的，不许动）⇒ 只能从排版侧解决。
 *
 * ⚠️ "装得下"这条判据用的是 `estimateBodyHeightPt` —— 也就是**实现自己那个模型**，
 *    所以它只能证明"按这个模型自洽"，**证明不了模型符合真渲染器**。
 *    符合与否是靠渲染成图回看验的，不在这条测试的射程里。
 */

const SHORT = ['文档生成能力：方案已出', '文件导入提示：已修'];

/** 一条刚好顶到上限的要点（300 字）。 */
const maxBullet = (tag: string): string => {
  const head = `${tag}：`;
  return head + '内'.repeat(300 - head.length);
};

describe('bodyFontSizePt —— 现实体量必须装得下', () => {
  it('短要点仍用最大字号（不能无谓地把正常内容缩小）', () => {
    expect(bodyFontSizePt(SHORT)).toBe(MAX_BODY_PT);
  });

  it('returns the readable floor when twelve bullets need pagination', () => {
    const bullets = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 条要点，简短一句`);
    const size = bodyFontSizePt(bullets);
    expect(size).toBe(MIN_BODY_PT);
    expect(size).toBeGreaterThanOrEqual(18);
    expect(estimateBodyHeightPt(bullets, size)).toBeGreaterThan(BODY_BOX.h * 72);
  });

  it('一份中等的真实汇报（4 页 × 4 条）每页都装得下', () => {
    const pages = [
      [
        '文档生成能力：方案已出并落地',
        '文件导入提示：已修复并复验',
        'U 盘更新通道：已恢复',
        '电脑操控权限：两档已上线',
      ],
      ['本周主要问题：更新链上偶发启动器卡死，已加日志留档以便下次定性'],
      ['下周计划：PPT 排版保真', '多版式与主题', '真盘验收', '发布 1.0.0 到稳定通道'],
      ['需要支持：一台干净的测试机', '一张测试用激活卡'],
    ];
    for (const bullets of pages) {
      const size = bodyFontSizePt(bullets);
      expect(estimateBodyHeightPt(bullets, size)).toBeLessThanOrEqual(BODY_BOX.h * 72);
    }
  });

  it('内容越多，字号只减不增（单调）', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let count = 1; count <= 12; count += 1) {
      const size = bodyFontSizePt(Array.from({ length: count }, (_, i) => `第 ${i + 1} 条，中等长度的要点内容`));
      expect(size).toBeLessThanOrEqual(previous);
      previous = size;
    }
  });

  it('空页不炸（纯标题页是合法的）', () => {
    expect(bodyFontSizePt([])).toBe(MAX_BODY_PT);
  });
});

describe('bodyFontSizePt —— 已知装不下的极限', () => {
  // 12 条 × 300 字 = 3600 字压一页。就算缩到下限也要几百 pt，而框只有 230pt
  // —— 那不是"字号没算对"，是**内容本身就超过一页**。
  // 2026-09-26 之前这里只是"钉住缺口"：字号停在下限，然后**照样生成一份糊出画面的 PPT**。
  // 现在同样的体量必须**被拒**（见下面 `findPptxLayoutProblem`），所以这条只剩
  // "下限是下限"这一个断言 —— 真正的不再糊弄由 `findPptxLayoutProblem` 那组保证。
  it('12 条 × 300 字在下限下仍装不下（这正是要被判失败的那种体量）', () => {
    const bullets = Array.from({ length: 12 }, (_, i) => maxBullet(`要点${i + 1}`));
    expect(bodyFontSizePt(bullets)).toBe(MIN_BODY_PT);
    expect(estimateBodyHeightPt(bullets, MIN_BODY_PT)).toBeGreaterThan(BODY_BOX.h * 72);
  });

  it('下限本身是"还看得见"，不是能一直缩', () => {
    expect(MIN_BODY_PT).toBeGreaterThanOrEqual(18);
    expect(MIN_BODY_PT).toBeLessThan(MAX_BODY_PT);
  });
});

/** 一页只有标题的页 —— 用来单独试标题的判定，不让正文干扰。 */
const pageWith = (title: string, bullets: string[] = []): DocgenPptxRequest => ({
  kind: 'pptx',
  title: '内测汇报',
  slides: [{ title, bullets }],
});

const deckOf = (slides: DocgenPptxRequest['slides'], title = '内测汇报'): DocgenPptxRequest => ({
  kind: 'pptx',
  title,
  slides,
});

describe('findPptxLayoutProblem —— 装不下就必须**说出来**，不能糊过去', () => {
  it('12 条 × 300 字（一页 3600 字）：判"内容过多"，并指出是第几页', () => {
    const bullets = Array.from({ length: 12 }, (_, i) => maxBullet(`要点${i + 1}`));
    expect(findPptxLayoutProblem(pageWith('本周进展', bullets))).toEqual({
      code: 'slide-body-overflow',
      page: 1,
    });
  });

  it('页号按 slides 数组从 1 数（封面不算）—— 助手照着改的就是 slides[N-1]', () => {
    const bullets = Array.from({ length: 12 }, (_, i) => maxBullet(`要点${i + 1}`));
    const deck = deckOf([
      { title: '正常页', bullets: ['一条'] },
      { title: '正常页二', bullets: ['一条'] },
      { title: '这页塞爆了', bullets },
    ]);
    expect(findPptxLayoutProblem(deck)).toEqual({ code: 'slide-body-overflow', page: 3 });
  });

  it('120 字中文页标题：判"标题过长"', () => {
    expect(findPptxLayoutProblem(pageWith('标'.repeat(120)))).toMatchObject({
      code: 'slide-title-overflow',
      page: 1,
    });
  });

  it('120 字中文封面标题：判封面标题过长', () => {
    expect(findPptxLayoutProblem(deckOf([{ title: '第一页', bullets: ['一条'] }], '标'.repeat(120)))).toMatchObject({
      code: 'cover-title-overflow',
    });
  });

  it('超长副标题也判（副标题同样是排出来的，不会自己换行到天荒地老）', () => {
    const deck: DocgenPptxRequest = {
      ...deckOf([{ title: '第一页', bullets: ['一条'] }]),
      subtitle: '副'.repeat(200),
    };
    expect(findPptxLayoutProblem(deck)).toMatchObject({ code: 'cover-subtitle-overflow' });
  });

  it('一份正常的中文汇报：判无问题（不能把正常内容也拦下来）', () => {
    const deck = deckOf([
      { title: '本月完成情况', bullets: ['文档生成能力已落地', '文件导入提示已修'] },
      { title: '关键指标', bullets: ['周活 1,240', '留存 38%', '平均时长 21 分钟'] },
      { title: '问题与风险', bullets: ['更新链上偶发启动器卡死'] },
      { title: '下一步计划', bullets: ['PPT 主题与配色', '真盘验收'] },
      { title: '需要支持', bullets: ['一台干净的测试机'] },
    ]);
    expect(findPptxLayoutProblem(deck)).toBeNull();
  });

  it('纯标题页（没有要点）不判失败 —— 分隔页是合法的', () => {
    expect(findPptxLayoutProblem(pageWith('第二部分：下一步计划'))).toBeNull();
  });

  it('多处都有问题时，报**第一处**（封面优先，然后按页序）—— 一次让助手改一件事', () => {
    const bullets = Array.from({ length: 12 }, (_, i) => maxBullet(`要点${i + 1}`));
    const deck = deckOf(
      [
        { title: '正常页', bullets: ['一条'] },
        { title: '标'.repeat(120), bullets },
      ],
      '标'.repeat(120),
    );
    expect(findPptxLayoutProblem(deck)).toMatchObject({ code: 'cover-title-overflow' });
  });
});

describe('findPptxLayoutProblem —— 报出来的 maxChars 必须是**真的**能用', () => {
  // 「标题请控制在 N 字以内」如果 N 是随口写的，用户照着改还是失败 —— 提示就成了假话。
  // 所以两头都钉：maxChars 字**必须**通过，maxChars+1 字**必须**不通过。
  const len = (n: number): DocgenPptxRequest => pageWith('标'.repeat(n));

  it('页标题：maxChars 通过、再多一个字就不通过', () => {
    const problem = findPptxLayoutProblem(len(120));
    if (problem?.code !== 'slide-title-overflow') throw new Error('夹具没被判成标题过长');
    expect(problem.maxChars).toBeGreaterThan(0);
    expect(findPptxLayoutProblem(len(problem.maxChars))).toBeNull();
    expect(findPptxLayoutProblem(len(problem.maxChars + 1))).toMatchObject({ code: 'slide-title-overflow' });
  });

  it('封面标题：maxChars 通过、再多一个字就不通过', () => {
    const problem = findPptxLayoutProblem(deckOf([{ title: '第一页', bullets: [] }], '标'.repeat(120)));
    if (problem?.code !== 'cover-title-overflow') throw new Error('夹具没被判成封面标题过长');
    const coverWith = (title: string): DocgenPptxRequest => deckOf([{ title: '第一页', bullets: [] }], title);
    expect(findPptxLayoutProblem(coverWith('标'.repeat(problem.maxChars)))).toBeNull();
    expect(findPptxLayoutProblem(coverWith('标'.repeat(problem.maxChars + 1)))).toMatchObject({
      code: 'cover-title-overflow',
    });
  });
});

describe('estimateTextHeightPt —— 标题类文字的估高（与正文同一套口径）', () => {
  it('空串不占高度', () => {
    expect(estimateTextHeightPt('', 26, BODY_BOX)).toBe(0);
  });

  it('字越多越高，且长到一定程度会换行（不是永远算一行）', () => {
    const short = estimateTextHeightPt('短标题', 26, BODY_BOX);
    const long = estimateTextHeightPt('长'.repeat(120), 26, BODY_BOX);
    const oneLine = 26 * LINE_SPACING;
    expect(short).toBeCloseTo(oneLine, 5);
    expect(long).toBeGreaterThan(oneLine);
  });
});

describe('estimateBodyHeightPt —— 模型自身的口径', () => {
  it('空内容为 0（不占高度）', () => {
    expect(estimateBodyHeightPt([], 18)).toBe(0);
  });

  it('字号越大，同一份内容越高', () => {
    expect(estimateBodyHeightPt(SHORT, 18)).toBeGreaterThan(estimateBodyHeightPt(SHORT, 12));
  });

  it('行距倍数是被用上的（不是摆设）', () => {
    // 两条同高内容的差 = 1 行 × 字号 × 行距
    const one = estimateBodyHeightPt(['短'], 18);
    const two = estimateBodyHeightPt(['短', '短'], 18);
    expect(two - one).toBeCloseTo(18 * LINE_SPACING + 3, 5);
  });
});

/**
 * 内嵌换行：**必须拒绝，不许压扁、不许静默替换**。
 *
 * ## 这是一条真会被绕过的洞（不是洁癖）
 *
 * 上面那套版面判定把一段文字按"半角宽 ÷ 每行容量"算行数 —— 那是**估算一行会被怎么折**。
 * 但 PptxGenJS 对我们的文本是**真实换行**：`"第一行\n第二行"` 在文件里就是两行。
 * 于是估高会**少算一行**，而"装不下就拒"这道保护就被绕过去了 ——
 * 结果是**照样产出一份糊出画面的文件**，正是这一版要根治的那个症状。
 *
 * ## 为什么是拒，而不是把 `\n` 换成空格
 *
 * 压扁会**改变用户的文字**：助手本来可能是想写两段，压扁后变成一句读不通的长句，
 * 而用户与助手都不知道发生了什么。拒掉则把选择权交回去 ——
 * 要分段就拆页 / 拆成多条要点，要一行就自己删掉换行。**一次也别替用户改字。**
 *
 * 三种换行形式都要拦：模型产出里 `\r\n` 与裸 `\r` 都出现过（Windows 剪贴板、CRLF 文件）。
 */

const BREAKS = [
  ['LF', '\n'],
  ['CRLF', '\r\n'],
  ['CR', '\r'],
] as const;

describe('findPptxLayoutProblem —— 内嵌换行：四类字段 × 三种换行，一个都不能漏', () => {
  for (const [name, br] of BREAKS) {
    it(`封面标题里有 ${name} ⇒ 拒，并指出是封面标题`, () => {
      const deck = deckOf([{ title: '第一页', bullets: [] }], `第一行${br}第二行`);
      expect(findPptxLayoutProblem(deck)).toEqual({ code: 'cover-title-multiline' });
    });

    it(`封面副标题里有 ${name} ⇒ 拒，并指出是副标题`, () => {
      const deck: DocgenPptxRequest = {
        ...deckOf([{ title: '第一页', bullets: [] }]),
        subtitle: `上${br}下`,
      };
      expect(findPptxLayoutProblem(deck)).toEqual({ code: 'cover-subtitle-multiline' });
    });

    it(`页标题里有 ${name} ⇒ 拒，并指出是第几页`, () => {
      expect(findPptxLayoutProblem(pageWith(`上半句${br}下半句`))).toEqual({
        code: 'slide-title-multiline',
        page: 1,
      });
    });

    it(`要点里有 ${name} ⇒ 拒，并指出第几页第几条`, () => {
      expect(findPptxLayoutProblem(pageWith('正常标题', ['正常一条', `前半${br}后半`]))).toEqual({
        code: 'slide-bullet-multiline',
        page: 1,
        bullet: 2,
      });
    });
  }

  it('`\\r\\n` 只报一次（不是"两个换行"）', () => {
    const deck = deckOf([{ title: '第一页', bullets: [] }], '上\r\n下');
    expect(findPptxLayoutProblem(deck)).toEqual({ code: 'cover-title-multiline' });
  });

  it('第 2 页的换行报第 2 页（页号口径与超量失败一致）', () => {
    const deck = deckOf([
      { title: '正常', bullets: ['一条'] },
      { title: '正常二', bullets: ['另一条\r\n带换行'] },
    ]);
    expect(findPptxLayoutProblem(deck)).toEqual({ code: 'slide-bullet-multiline', page: 2, bullet: 1 });
  });

  it('换行判定**先于**超量判定（否则用户按提示去拆页，还是失败）', () => {
    const maxBullet = '内'.repeat(300);
    const bullets = Array.from({ length: 12 }, () => maxBullet);
    bullets[3] = `第一段\r\n${maxBullet}`;
    const bulletsWith = (): DocgenPptxRequest => pageWith('本周进展', [...bullets]);
    expect(findPptxLayoutProblem(bulletsWith())).toEqual({
      code: 'slide-bullet-multiline',
      page: 1,
      bullet: 4,
    });
  });

  it('负对照：**正常的中文与中英混排**仍然通过（不能把这条判得过宽）', () => {
    const deck: DocgenPptxRequest = {
      kind: 'pptx',
      title: 'Q3 复盘与 1.0.1 计划',
      subtitle: '2026-09-26 · Product Team',
      slides: [
        { title: '本周完成（P0 两条）', bullets: ['PPT 版面保护已落地', 'relay 侧文生图已就绪'] },
        { title: '指标', bullets: ['周活 1,240（环比 +8%）', '留存 38% / 平均时长 21 分钟'] },
      ],
    };
    expect(findPptxLayoutProblem(deck)).toBeNull();
  });

  it('负对照：制表符与全角空格**不算**换行（别把"看着像空白"都拦掉）', () => {
    expect(findPptxLayoutProblem(pageWith('标题', ['甲乙\t丙　丁']))).toBeNull();
  });
});

/**
 * 🔴 2026-09-28 真机：**封面标题一长就折行，折点很难看。**
 *
 * 现场：`一年级数学上册·第一单元 准备课（最终版）` 折成
 * 「…准备课（最终」/「版）」—— 括号被劈开。版面判定**允许**两行（几何上装得下），
 * 所以这不是 bug —— 但它**观感差**，而封面是第一印象。
 *
 * ⇒ 与其折在一个难看的位置，不如**把字号收一档挤进一行**。
 *    只在"收得动"的时候收：缩到下限还放不下就**不硬缩**，让它照旧折行
 *    （硬缩会把标题变成一行小字，比折行更糟）。
 */
describe('封面标题：长了就收字号挤进一行', () => {
  const SHORT = '九月经营简报';
  const LONG = '一年级数学上册·第一单元 准备课（最终版）';

  it('短标题**不缩**（本来就一行放得下）', () => {
    expect(coverTitlePtFor(SHORT)).toBe(COVER_TITLE.pt);
  });

  it('⭐ 长标题缩到一行放得下 —— 且缩完确实只剩一行', () => {
    const pt = coverTitlePtFor(LONG);
    expect(pt, '一点没缩 ⇒ 它会折成两行，折点很难看').toBeLessThan(COVER_TITLE.pt);
    expect(coverTitleLinesAt(LONG, pt), `缩到 ${pt}pt 还是不止一行`).toBe(1);
  });

  it('⭐ 不缩到看不见：有下限，且缩完仍然是一档能当封面的字号', () => {
    const pt = coverTitlePtFor(LONG);
    expect(pt).toBeGreaterThanOrEqual(COVER_TITLE_MIN_PT);
    expect(COVER_TITLE_MIN_PT).toBeGreaterThanOrEqual(24);
  });

  it('⭐ 缩到下限还放不下 ⇒ **不硬缩**，保持原字号（宁可折行，也不要一行小字）', () => {
    const absurd = '这是一个非常非常非常非常非常非常非常非常非常非常非常长的封面标题'.repeat(2);
    expect(coverTitlePtFor(absurd)).toBe(COVER_TITLE.pt);
  });

  /**
   * ⭐ 这条是**渲染探针反推出来的**，不是在实现里读出来的。
   *
   * 上面那条用的标题**过不了版面判定**（34pt 折 4 行 > 封面标题下边界），
   * 所以它在生产里根本走不到 `coverTitlePtFor` —— 只拿它当夹具，
   * "不硬缩"那条分支就有可能是**死代码**，没人会发现。
   *
   * 真机可达的那一档是：**34pt 两行装得下、缩到下限仍挤不进一行**。
   * 下面这个标题半角宽 57（一行容量 34pt 是 36.4、下限 24pt 是 51.6），正好落在这档里。
   * 两头都钉住：判定说它没问题，而函数**确实**没缩。
   */
  it('⭐ "不硬缩"分支在**真实可达**的输入上也走得到（不是只有被拒的标题才这样）', () => {
    const reachable = '2026 年第三季度华东区渠道复盘与第四季度铺货计划（讨论稿）';
    expect(
      findPptxLayoutProblem(deckOf([{ title: '第一页', bullets: [] }], reachable)),
      '夹具本身该是"判定通过"的',
    ).toBeNull();
    expect(coverTitleLinesAt(reachable, COVER_TITLE_MIN_PT), '夹具该是"缩到下限也挤不进一行"的').toBeGreaterThan(1);
    expect(coverTitlePtFor(reachable)).toBe(COVER_TITLE.pt);
  });

  it('空串不炸（契约层会挡，但这里不该抛）', () => {
    expect(coverTitlePtFor('')).toBe(COVER_TITLE.pt);
  });
});
