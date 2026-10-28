import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { findPptxTemplate } from '../src/main/docgen/pptx-template/catalog';
import { fillTemplateDeck } from '../src/main/docgen/pptx-template/fill';
import { resolvePptxTemplatesRoot } from '../src/main/docgen/pptx-template/locate';
import { parseTemplateDeck } from '../src/main/docgen/pptx-template/parse';
import { listZipEntries, readZipEntry } from '../src/main/preview/zip-entry';

/**
 * **六套固定样稿** —— 既是回归测试，也是人工审图的输入。
 *
 * 为什么固定六份而不是随手造：
 *  模板填充的效果**只能靠眼睛判**，而"看得见效果"有个陷阱 —— 换一批内容、
 *  换一个审的人，结论就不一样。固定输入 + 固定哈希，才能做到"改完再渲一遍直接对比"。
 *
 * 六份都按真实商务场景写，并**覆盖全部八种模板页** —— 只造一份漂亮的封面是验不出问题的。
 *
 * ## 人工审图怎么跑
 *
 * ```
 * PARTNERW_PPTX_SAMPLE_OUT="D:\某处\样稿" \
 *   ./node_modules/.bin/vitest run test/pptx-template-samples.test.ts
 * ```
 * 设了这个环境变量，六份 pptx 会**额外**落到那个目录（连同 `SAMPLES.json` 记下哈希），
 * 再用 WPS 转 PNG 逐张看。不设就只跑断言、不落盘 ——
 * `pnpm check` 里跑的就是不落盘那一种。
 */

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATES_ROOT = resolvePptxTemplatesRoot({ isPackaged: false, appPath: PACKAGE_ROOT })!;
const EXPORT_DIR = process.env.PARTNERW_PPTX_SAMPLE_OUT;

interface Sample {
  name: string;
  note: string;
  deck: unknown;
}

const COVER = (title: string, subtitle: string, date: string, author?: string) => ({
  templateId: 'cover',
  data: { cover_title: title, cover_subtitle: subtitle, date, ...(author ? { author } : {}) },
});

const SAMPLES: Sample[] = [
  {
    name: '01-季度经营复盘',
    note: '封面 + 数据 + 观点 + 行动：最常见的复盘结构',
    deck: {
      template: 'business-deck-v4',
      slides: [
        COVER('第三季度经营复盘', '私域增长与渠道结构变化', '2026-09-27', '增长组'),
        {
          templateId: 'metrics',
          data: {
            slide_title: '三个关键读数',
            slide_subtitle: '本季度实际 vs 上季度',
            value_1: '12.4%',
            label_1: '转化率',
            note_1: '较上季度 +1.8pp',
            value_2: '1,284',
            label_2: '新增线索',
            note_2: '私域占 62%',
            value_3: '38',
            label_3: '成交单数',
            note_3: '客单价 4,200 元',
            source_or_note: '口径：内部经营看板，截至 2026-09-27；成交以付款时间为准。',
          },
        },
        {
          templateId: 'insight',
          data: {
            slide_title: '真正变的是渠道结构',
            slide_subtitle: '不是量的问题，是来源变了',
            takeaway: '私域承接能力已经跟不上了：线索涨了 40%，成交只涨了 12%，中间那段漏在了承接环节。',
            evidence_1: '私域线索占比从 41% 升到 62%，但私域转化率比公域低 3.2pp。',
            evidence_2: '首次响应中位数从 8 分钟拉长到 47 分钟，承接人力没有同步增加。',
            evidence_3: '老客转介绍贡献了 28% 的成交，却没有对应的跟进流程。',
          },
        },
        {
          templateId: 'actions',
          data: {
            slide_title: '下季度要落地的四件事',
            slide_subtitle: '按优先级排序',
            action_1: '补齐私域承接话术并做一次全员内测',
            owner_1: '张',
            due_1: '本周五',
            action_2: '把响应时长纳入日报口径',
            owner_2: '李',
            due_2: '下周二',
            action_3: '给老客转介绍单独建一条跟进流程',
            owner_3: '王',
            due_3: '下月底',
            action_4: '重新评估公域投放的边际产出',
            owner_4: '张',
            due_4: '下季度初',
          },
        },
      ],
    },
  },
  {
    name: '02-新产品上市方案',
    note: '封面 + 章节 + 对比 + 时间线 + 结尾：完整方案骨架',
    deck: {
      template: 'business-deck-v4',
      slides: [
        COVER('轻享版上市方案', '定价、渠道与节奏', '2026-10-15', '产品组'),
        {
          templateId: 'section',
          data: {
            section_title: '第一部分：我们要解决的问题',
            section_summary:
              '现有版本对价格敏感型客户门槛偏高，实测有一半的试用用户在第三天流失，价格是首要原因。轻享版针对这一段需求。',
            section_context: '01 / 03',
          },
        },
        {
          templateId: 'comparison',
          data: {
            slide_title: '两个版本怎么分工',
            slide_subtitle: '不是替代关系，是覆盖面不同',
            left_title: '专业版（现有）',
            right_title: '轻享版（新）',
            left_item_1: '面向有专职运营的团队',
            left_item_2: '全功能，按席位计价',
            left_item_3: '客单价 4,200 元 / 年',
            right_item_1: '面向个人与三人以下小团队',
            right_item_2: '保留核心功能，去掉批量与协作',
            right_item_3: '定价 980 元 / 年',
          },
        },
        {
          templateId: 'timeline',
          data: {
            slide_title: '上市节奏',
            slide_subtitle: '从内测到全量',
            step_1_title: '内测',
            step_1_desc: '邀请 30 个存量用户，收两周反馈',
            step_2_title: '公测',
            step_2_desc: '开放注册，限额 500 个名额',
            step_3_title: '全量',
            step_3_desc: '去掉名额限制，开始投放',
            step_4_title: '复盘',
            step_4_desc: '看留存与转化，决定是否扩席',
          },
        },
        {
          templateId: 'closing',
          data: {
            closing_title: '需要今天拍板的两件事',
            closing_message: '一是定价 980 是否最终确认；二是内测名额是 30 还是 50。其余按上面的节奏推进。',
            contact_or_next_step: '下一步：产品组整理内测名单',
          },
        },
      ],
    },
  },
  {
    name: '03-渠道结构分析',
    note: '数据 + 对比 + 观点：纯分析型，不给行动项',
    deck: {
      template: 'business-deck-v4',
      slides: [
        COVER('渠道结构分析', '钱花在哪、人从哪来', '2026-09-20', '数据组'),
        {
          templateId: 'metrics',
          data: {
            slide_title: '获客成本对比',
            slide_subtitle: '单位：元 / 有效线索',
            value_1: '86',
            label_1: '私域',
            note_1: '含人力分摊',
            value_2: '214',
            label_2: '信息流',
            note_2: '不含品牌曝光',
            value_3: '341',
            label_3: '搜索竞价',
            note_3: '近三个月均价',
            source_or_note: '口径：市场部月度结算表；私域人力按 0.6 个全职折算。',
          },
        },
        {
          templateId: 'comparison',
          data: {
            slide_title: '量与质的分歧',
            slide_subtitle: '私域便宜，但成交率并不高',
            left_title: '量：私域赢',
            right_title: '质：搜索赢',
            left_item_1: '线索量占 62%，是最大来源',
            left_item_2: '单条成本只有搜索的四分之一',
            left_item_3: '但响应慢，流失在承接环节',
            right_item_1: '线索量只占 9%',
            right_item_2: '单条最贵，但成交率是私域的 2.4 倍',
            right_item_3: '客单价也高出 60%',
          },
        },
        {
          templateId: 'insight',
          data: {
            slide_title: '结论：不要一刀切砍预算',
            slide_subtitle: '按"每个成交的成本"重算一遍',
            takeaway:
              '按线索成本算，私域最划算；按成交成本算，搜索反而最低。现在用的是前一个口径，可能导致预算投错方向。',
            evidence_1: '私域单条线索 86 元，成交率 3.1% ⇒ 单个成交约 2,774 元。',
            evidence_2: '搜索单条线索 341 元，成交率 7.4% ⇒ 单个成交约 4,608 元。',
            evidence_3: '计入客单价差异后，两者差距收窄到 8% 以内，不再是一边倒。',
          },
        },
      ],
    },
  },
  {
    name: '04-项目进度汇报',
    note: '只有三页的短汇报：验短 deck 与「可以不填的字段」',
    deck: {
      template: 'business-deck-v4',
      slides: [
        {
          templateId: 'cover',
          data: { cover_title: '客户端 1.0.1 进度汇报', cover_subtitle: '当前状态与风险', date: '2026-09-27' },
        },
        {
          templateId: 'timeline',
          data: {
            slide_title: '走到哪一步了',
            slide_subtitle: '五个阶段已过四个',
            step_1_title: '功能闭环',
            step_1_desc: '已完成，含排版修复与失败可见',
            step_2_title: '集成',
            step_2_desc: '已完成，树与门禁树逐字节一致',
            step_3_title: '门禁',
            step_3_desc: '全 17 关通过',
            step_4_title: '打包',
            step_4_desc: '已完成，独立核验 17 项全过',
            step_5_title: '真盘验收',
            step_5_desc: '进行中，需人工插盘',
          },
        },
        {
          templateId: 'actions',
          data: {
            slide_title: '卡在哪、谁来做',
            slide_subtitle: '两件事需要人推进',
            action_1: '插真 U 盘跑 15 项验收清单',
            owner_1: '测试',
            due_1: '本周内',
            action_2: '确认激活卡发放名单',
            owner_2: '运营',
            due_2: '本周五',
          },
        },
      ],
    },
  },
  {
    name: '05-竞品调研简报',
    note: '章节 + 观点 + 对比 + 结尾：调研型',
    deck: {
      template: 'business-deck-v4',
      slides: [
        COVER('同类产品调研简报', '三家对标产品的定价与卖点', '2026-09-18', '市场组'),
        {
          templateId: 'section',
          data: {
            section_title: '调研范围',
            section_summary:
              '选了三家有代表性的：一家走低价铺量、一家走专业深度、一家走渠道捆绑。样本来自公开页面与试用账号。',
            section_context: '01 / 02',
          },
        },
        {
          templateId: 'insight',
          data: {
            slide_title: '定价不是主要差距',
            slide_subtitle: '差在"第一周能不能用起来"',
            takeaway: '三家的年费都在同一区间，真正拉开差距的是新用户第一周的上手体验，而不是价格。',
            evidence_1: '低价那家的七日留存反而最低，说明价格不是留存的驱动因素。',
            evidence_2: '专业深度那家把引导做成了"跟着走一遍"，七日留存高出 22pp。',
            evidence_3: '渠道捆绑那家靠已有客户导流，几乎不做新手引导。',
          },
        },
        {
          templateId: 'comparison',
          data: {
            slide_title: '三家的路数',
            slide_subtitle: '简化成两两对照',
            left_title: '低价铺量 / 专业深度',
            right_title: '渠道捆绑',
            left_item_1: '前者靠量，后者靠口碑',
            left_item_2: '都不依赖已有客户池',
            left_item_3: '获客成本都在 150-350 元区间',
            right_item_1: '几乎不投放',
            right_item_2: '客单价最高，但决策链最长',
            right_item_3: '新客占比只有 12%',
          },
        },
        {
          templateId: 'closing',
          data: {
            closing_title: '对我们的启发',
            closing_message: '把资源从价格调整挪到新手引导上；先做一版"跟着走一遍"的引导，两周后看七日留存。',
            contact_or_next_step: '下一步：市场组出引导改版草案',
          },
        },
      ],
    },
  },
  {
    name: '06-年度目标拆解',
    note: '八页全用上：验长 deck 与全部模板页',
    deck: {
      template: 'business-deck-v4',
      slides: [
        COVER('2027 年度目标拆解', '从年度数字到季度动作', '2026-11-30', '经营会'),
        {
          templateId: 'section',
          data: {
            section_title: '第一段：目标是什么',
            section_summary: '年度目标不是一句口号，要能被拆到季度、拆到人、拆到可检查的读数。这一段先把口径定死。',
            section_context: '01 / 03',
          },
        },
        {
          templateId: 'metrics',
          data: {
            slide_title: '三个年度数字',
            slide_subtitle: '口径已与财务对齐',
            value_1: '1.2 亿',
            label_1: '回款',
            note_1: '较今年 +45%',
            value_2: '3,000',
            label_2: '付费客户',
            note_2: '含续费',
            value_3: '78%',
            label_3: '续费率',
            note_3: '今年为 71%',
            source_or_note: '口径：按回款确认收入；续费率按客户数计，不按金额计。',
          },
        },
        {
          templateId: 'insight',
          data: {
            slide_title: '难点在续费，不在新签',
            slide_subtitle: '拆开看就知道资源该往哪放',
            takeaway: '新签按现在的增速能完成，缺口全部在续费上。续费率每掉 1pp，回款少 120 万。',
            evidence_1: '新签目标对应 2,100 家，按当前转化只需增加 18% 的线索量。',
            evidence_2: '续费目标要求续费率从 71% 提到 78%，历史上没有单年提过 7pp。',
            evidence_3: '今年流失客户里，64% 是在第三个月前就没再登录。',
          },
        },
        {
          templateId: 'comparison',
          data: {
            slide_title: '两种投入方式',
            slide_subtitle: '钱只有一份',
            left_title: '加投放',
            right_title: '加客户成功',
            left_item_1: '见效快，一个季度能看到线索量',
            left_item_2: '但线索成本每年涨 20%',
            left_item_3: '不解决续费问题',
            right_item_1: '见效慢，要两个季度',
            right_item_2: '边际成本随规模递减',
            right_item_3: '直接作用在回款上',
          },
        },
        {
          templateId: 'timeline',
          data: {
            slide_title: '分四个季度推',
            slide_subtitle: '前紧后稳',
            step_1_title: 'Q1 补齐',
            step_1_desc: '客户成功团队到位，建立流失预警',
            step_2_title: 'Q2 验证',
            step_2_desc: '看首个完整季度的续费率变化',
            step_3_title: 'Q3 放量',
            step_3_desc: '续费率达标后再加投放',
            step_4_title: 'Q4 收口',
            step_4_desc: '冲刺回款，同时为明年攒续费基数',
          },
        },
        {
          templateId: 'actions',
          data: {
            slide_title: '明年一季度就要做的',
            slide_subtitle: '按责任人排',
            action_1: '客户成功岗位招满并完成培训',
            owner_1: '人力',
            due_1: '1 月底',
            action_2: '上线流失预警看板',
            owner_2: '数据',
            due_2: '2 月中',
            action_3: '把续费率纳入季度考核',
            owner_3: '经营会',
            due_3: '1 月初',
            action_4: '重跑一遍客户分层口径',
            owner_4: '数据',
            due_4: '2 月底',
          },
        },
        {
          templateId: 'closing',
          data: {
            closing_title: '一句话总结',
            closing_message: '明年的关键变量是续费，不是线索。资源要先往客户成功挪，续费率验证通过之后再谈加投放。',
            contact_or_next_step: '下一步：经营会出一季度预算草案',
          },
        },
      ],
    },
  },
];

const scratch = mkdtempSync(join(tmpdir(), 'pptx-samples-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function slideTexts(buffer: Buffer): string[] {
  return listZipEntries(buffer)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1]))
    .map((n) => readZipEntry(buffer, n)!.toString('utf8'));
}

describe('六套固定样稿', () => {
  const built: Array<{ sample: Sample; buffer: Buffer }> = [];

  it('六份都能生成，且六份覆盖了全部八种模板页', async () => {
    if (EXPORT_DIR) mkdirSync(EXPORT_DIR, { recursive: true });
    const covered = new Set<string>();

    for (const sample of SAMPLES) {
      const parsed = parseTemplateDeck(sample.deck);
      expect(parsed.ok, `${sample.name}: ${JSON.stringify(parsed.ok ? {} : parsed.failure)}`).toBe(true);
      if (!parsed.ok) continue;
      for (const slide of parsed.deck.slides) covered.add(slide.templateId);

      const written = await fillTemplateDeck({
        deck: parsed.deck,
        templatesRoot: TEMPLATES_ROOT,
        outputDir: scratch,
        outputName: `${sample.name}.pptx`,
      });
      const buffer = readFileSync(written);
      built.push({ sample, buffer });

      if (EXPORT_DIR) writeFileSync(join(EXPORT_DIR, `${sample.name}.pptx`), buffer);
    }

    expect(built).toHaveLength(6);
    // 八种模板页一个都不能漏 —— 只造漂亮的封面是验不出问题的
    expect([...covered].sort()).toEqual([
      'actions',
      'closing',
      'comparison',
      'cover',
      'insight',
      'metrics',
      'section',
      'timeline',
    ]);
  });

  it('每份的页数与请求一致，且**一个 {{占位符}} 都不剩**', () => {
    for (const { sample, buffer } of built) {
      const deck = sample.deck as { slides: unknown[] };
      const texts = slideTexts(buffer);
      expect(texts, sample.name).toHaveLength(deck.slides.length);
      for (const xml of texts) {
        expect(xml.match(/\{\{[^}]+\}\}/g), `${sample.name} 有残留占位符`).toBeNull();
      }
    }
  });

  it('每份的内容都真的写进去了（抽样核对首尾两页）', () => {
    for (const { sample, buffer } of built) {
      const deck = sample.deck as { slides: Array<{ templateId: string; data: Record<string, string> }> };
      const texts = slideTexts(buffer);
      const first = deck.slides[0];
      expect(texts[0], `${sample.name} 封面`).toContain(first.data.cover_title);
      const last = deck.slides[deck.slides.length - 1];
      const lastSpec = findPptxTemplate(last.templateId)!;
      // 取最后一个模板页里第一个非空值来核对
      const probe = Object.keys(lastSpec.tokens).find((t) => (last.data[t] ?? '').length > 0);
      if (probe) expect(texts[texts.length - 1], `${sample.name} 末页`).toContain(last.data[probe]);
    }
  });

  it('导出目录（设了 PARTNERW_PPTX_SAMPLE_OUT 时）留下哈希记录', () => {
    if (!EXPORT_DIR) {
      expect(EXPORT_DIR).toBeUndefined();
      return;
    }
    const records = built.map(({ sample, buffer }) => {
      const deck = sample.deck as { slides: unknown[] };
      return {
        name: sample.name,
        note: sample.note,
        pages: deck.slides.length,
        bytes: buffer.byteLength,
        sha256: createHash('sha256').update(buffer).digest('hex'),
      };
    });
    writeFileSync(
      join(EXPORT_DIR, 'SAMPLES.json'),
      JSON.stringify(
        { generatedAt: new Date().toISOString(), templatesRoot: TEMPLATES_ROOT, samples: records },
        null,
        2,
      ) + '\n',
    );
    expect(records.every((r) => r.sha256.length === 64)).toBe(true);
  });
});
