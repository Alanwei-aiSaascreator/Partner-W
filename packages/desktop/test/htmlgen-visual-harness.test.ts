import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildHtmlgenHtml } from '../src/main/htmlgen/templates';
import { parseHtmlgenRequest } from '../src/main/htmlgen/request';
import { HTMLGEN_TEMPLATES } from '@clawwork/shared';

/**
 * **人工视觉验收的材料准备**（不是视觉验收本身）—— `docgen-pptx-visual-harness` 的网页版。
 *
 * 为什么网页这边也需要它：pptx 那边有一条"真渲染器回看"的纪律（判据是估算模型，
 * 只有真渲染能证伪）。网页这边**连材料都没有** —— `buildHtmlgenHtml` 的 30 条测试
 * 全都在断言**字符串里有没有某段 HTML**，没有一条看过**它长什么样**。
 * "文字都在"证明不了"没重叠、没被裁、打印出来没截断"。
 *
 * ⚠️ 这个文件同样**证明不了**观感 —— 那件事只有真渲染回看能证明。
 *    它只保证"要看的这五份确实出得来、而且是我想验的那五种模板"。
 *
 * 落点在**系统临时目录**（不是仓库、不是桌面）—— 本仓对"写到工作区外"有明确规矩。
 */

const OUT_DIR = join(tmpdir(), 'partner-w-htmlgen-visual');

/** 五份样本各用一种模板，内容用真实体量（不是 `foo` / `bar`）。 */
const SAMPLES: { file: string; request: Record<string, unknown> }[] = [
  {
    file: '1-brief',
    request: {
      kind: 'html',
      title: '九月经营简报',
      lang: 'zh-CN',
      template: 'brief',
      summary: '本月增长主要来自老客复购，新增获客成本仍在高位，建议下月把预算往留存倾斜。',
      sections: [
        {
          kind: 'narrative',
          heading: '核心判断',
          paragraphs: [
            '九月整体营收环比增长 12%，其中老客复购贡献了七成。新增获客的单个成本比上月高 18%，连续第二个月上升。',
            '产品侧的三个改动（文档生成、文件导入提示、更新通道修复）都已上线，客服工单量下降了约四分之一。',
          ],
          bullets: ['老客贡献七成营收', '获客成本连续两月上升', '工单量下降约 25%'],
        },
        {
          kind: 'metrics',
          heading: '关键指标',
          items: [
            { label: '月营收', value: '¥ 186 万' },
            { label: '环比', value: '+12%' },
            { label: '周活', value: '1,240' },
            { label: '留存', value: '38%' },
            { label: '获客成本', value: '¥ 92' },
            { label: '工单量', value: '-25%' },
          ],
        },
        {
          kind: 'table',
          heading: '分渠道明细',
          caption: '按营收贡献排序',
          columns: ['渠道', '营收', '环比', '获客成本'],
          rows: [
            ['老客复购', '¥ 130 万', '+19%', '—'],
            ['自然流量', '¥ 34 万', '+6%', '¥ 41'],
            ['投放', '¥ 22 万', '-4%', '¥ 156'],
          ],
        },
        {
          kind: 'actions',
          heading: '下一步',
          items: [
            { title: '预算向留存倾斜', detail: '下月把投放预算的三成转到老客运营。', owner: '市场组' },
            { title: '压获客成本', detail: '暂停两个高成本投放计划，改测自然流量。', owner: '市场组' },
          ],
        },
      ],
      sources: [{ label: '内部经营数据（2026-09）' }, { label: '客服工单系统导出' }],
    },
  },
  {
    file: '2-proposal',
    request: {
      kind: 'html',
      title: '内部工具升级方案',
      lang: 'zh-CN',
      template: 'proposal',
      summary: '把现在三套并行的表格流程合成一条，预计每月省下约 40 工时。',
      sections: [
        {
          kind: 'narrative',
          heading: '现状与问题',
          paragraphs: [
            '目前交付、验收、结算三张表各由不同的人维护，同一批数据要录三遍。上个月因为口径不一致返工了两次。',
          ],
          bullets: ['同一批数据录三遍', '口径不一致返工两次', '月底对账要两天'],
        },
        {
          kind: 'metrics',
          heading: '预期收益',
          items: [
            { label: '每月省工时', value: '约 40 小时' },
            { label: '对账耗时', value: '2 天 → 半天' },
            { label: '一次性投入', value: '约 3 人日' },
          ],
        },
        {
          kind: 'actions',
          heading: '实施步骤',
          items: [
            { title: '第一步 · 合并表结构', detail: '三张表并成一张，保留原有编号规则。', owner: '研发' },
            { title: '第二步 · 灰度一周', detail: '先让交付组试用，收集问题。', owner: '交付组' },
            { title: '第三步 · 全量切换', detail: '旧表只读留档，不再录入。', owner: '研发' },
          ],
        },
      ],
      sources: [{ label: '交付组访谈（2026-09-20）' }],
    },
  },
  {
    file: '3-research',
    request: {
      kind: 'html',
      title: '同类工具能力对比',
      lang: 'zh-CN',
      template: 'research',
      summary: '三家同类产品都能出文档，但只有一家支持可编辑的演示文稿。',
      sections: [
        {
          kind: 'narrative',
          heading: '结论',
          paragraphs: [
            '对比了市面上三个同类工具。共同点是都能生成文档与表格；差异主要在演示文稿的可编辑性与字数限制上。',
          ],
          bullets: ['三家都能出文档', '只有一家出可编辑演示文稿', '两家有明显字数上限'],
        },
        {
          kind: 'table',
          heading: '能力对照',
          columns: ['能力', 'A 产品', 'B 产品', '我们'],
          rows: [
            ['Word', '支持', '支持', '支持'],
            ['Excel', '支持', '部分支持', '支持'],
            ['可编辑 PPT', '不支持', '支持', '支持'],
            ['字数上限', '有（约 40 字/格）', '无', '无'],
          ],
        },
      ],
      sources: [{ label: '各产品公开文档（2026-09）' }],
    },
  },
  {
    file: '4-plan',
    request: {
      kind: 'html',
      title: '十月上线计划',
      lang: 'zh-CN',
      template: 'plan',
      summary: '先修路由，再压测，最后发稳定通道。',
      sections: [
        {
          kind: 'narrative',
          heading: '目标',
          paragraphs: ['十月的目标只有一个：把演示文稿这条路走顺，然后发一版稳定包。'],
          bullets: ['路由修完', '压测通过', '发稳定通道'],
        },
        {
          kind: 'actions',
          heading: '排期',
          items: [
            { title: '第 1 周 · 修路由', detail: '技能描述分工 + 设备身份加固。', owner: '研发' },
            { title: '第 2 周 · 真机验', detail: '干净机器上跑一遍 32 项验收。', owner: '测试' },
            { title: '第 3 周 · 发稳定', detail: '通过后再发，不抢时间。', owner: '研发' },
          ],
        },
      ],
      sources: [{ label: '内部排期会（2026-09-28）' }],
    },
  },
  {
    file: '5-data',
    request: {
      kind: 'html',
      title: '本周数据速览',
      lang: 'zh-CN',
      template: 'data',
      summary: '六个数，一眼看完本周。',
      sections: [
        {
          kind: 'metrics',
          heading: '核心',
          items: [
            { label: '新增任务', value: '418' },
            { label: '成功产出', value: '391' },
            { label: '成功率', value: '93.5%' },
            { label: '平均耗时', value: '42 秒' },
            { label: '报错率', value: '1.2%' },
            { label: '活跃助手', value: '12' },
          ],
        },
        {
          kind: 'table',
          heading: '分类明细',
          columns: ['类型', '数量', '成功率'],
          rows: [
            ['文档', '186', '96%'],
            ['演示文稿', '104', '88%'],
            ['网页', '101', '95%'],
          ],
        },
      ],
      sources: [{ label: '网关用量统计' }],
    },
  },
];

describe('网页视觉验收：五份样本出得来', () => {
  it('每份模板都渲染成一份真 HTML，落在临时目录里好让人打开看', () => {
    mkdirSync(OUT_DIR, { recursive: true });
    const written: string[] = [];

    for (const sample of SAMPLES) {
      const parsed = parseHtmlgenRequest(sample.request);
      expect(parsed.ok, `${sample.file} 的样本本身不合契约：${JSON.stringify(parsed)}`).toBe(true);
      if (!parsed.ok) continue;

      const html = buildHtmlgenHtml(parsed.request);
      expect(html.length, `${sample.file} 渲染成了空网页`).toBeGreaterThan(500);
      expect(html, `${sample.file} 的标题没进正文`).toContain(String(sample.request.title));
      const file = join(OUT_DIR, `${sample.file}.html`);
      writeFileSync(file, html, 'utf8');
      written.push(file);
    }

    expect(written).toHaveLength(SAMPLES.length);
  });

  it('五种模板都覆盖到了（少一种就有一份没被看过）', () => {
    const used = new Set(SAMPLES.map((s) => s.request.template as string));
    expect([...used].sort()).toEqual([...HTMLGEN_TEMPLATES].sort());
  });
});
