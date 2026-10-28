import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  renderTemplateDeck,
  verifyTemplateDeck,
  TemplateDeckError,
  type SlotTable,
  type TemplateDeckContent,
} from '../src/main/docgen/template-deck/index.js';

/**
 * 诊断聚合 + layout 4/5/6 最小复现（BUG-046 ② 的回归钉子，2026-10-08 pre19）。
 *
 * 真机背景（run6b，task 8e5b7580）：qwen3.7-flash 终稿封面 4 槽、目录 17 项全对，
 * 但 layout 4=11 项 / 5=11 项 / 6=13 项 vs 契约 12/14/21——**一次只报一个错**
 * （`slot-content-count expected 12`），模型"修一个→再跑→再撞下一个"，41 次源文件
 * 写入从未同时满足。本测试用同一形状的输入钉住两件事：
 *   ① 一次校验必须**返回全部**可收集的 layout 问题（不是单条 fail-fast）；
 *   ② 三处计数修对之后，模板渲染与产物校验全绿（证明模板本身可用、失败归类=模型填槽）。
 */

const resource = path.resolve('resources/pptx-templates/native-deck');
const template = fs.readFileSync(path.join(resource, 'tpl-native.pptx'));
const table = JSON.parse(fs.readFileSync(path.join(resource, 'detail.json'), 'utf8')) as SlotTable;
const example = JSON.parse(fs.readFileSync(path.join(resource, 'content.example.json'), 'utf8')) as TemplateDeckContent;
const subset = (...pages: number[]): TemplateDeckContent =>
  Object.fromEntries(pages.map((page) => [String(page), structuredClone(example[String(page)])]));

/** run6b 终稿形状：封面/目录全对，layout 4/5/6 计数不达契约。 */
function run6bShapedContent(): TemplateDeckContent {
  const content = subset(1, 2, 4, 5, 6, 16);
  content['4'] = (content['4'] as string[]).slice(0, 11); // 缺「底部结论」
  content['5'] = (content['5'] as string[]).slice(0, 11); // 只有 3 组
  content['6'] = (content['6'] as string[]).slice(0, 13); // 三列混搭形状
  return content;
}

function diagnosticsOf(error: unknown): Array<{ code: string; page?: number; detail: string }> {
  expect(error).toBeInstanceOf(TemplateDeckError);
  return (error as TemplateDeckError).diagnostics;
}

describe('templateDeck 诊断聚合（一次返回全部 layout 问题）', () => {
  it('run6b 形状：layout 4/5/6 三个计数问题一次抛全，而不是修一个再撞下一个', async () => {
    const content = run6bShapedContent();
    let thrown: unknown;
    try {
      await renderTemplateDeck(template, table, content);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TemplateDeckError);
    const diagnostics = diagnosticsOf(thrown);
    const countIssues = diagnostics.filter((item) => item.code === 'slot-content-count');
    expect(countIssues).toHaveLength(3);
    // BUG-053①：输出页序 = 选中序列位次（3/4/5），逐页不同——旧写法只在成功页递增，
    // 三个坏页会全报同一个号（[3,3,3]）；layout 身份由 detail 前缀 `layout <n>` 承载。
    expect(countIssues.map((item) => item.page)).toEqual([3, 4, 5]);
    // 每条诊断都带「期望数 + 角色清单 + 实际数」，让模型一轮内按表补齐。
    for (const issue of countIssues) expect(issue.detail).toMatch(/expected \d+.*got \d+/);
    const layout4 = countIssues.find((item) => item.detail.includes('layout 4'));
    expect(layout4?.detail).toContain('底部结论'); // 角色清单点名缺什么
    const layout6 = countIssues.find((item) => item.detail.includes('layout 6'));
    expect(layout6?.detail).toMatch(/got 13/);
  });

  it('同页多问题也一次抛全（计数 + 溢出 + 空串不互相掩盖）', async () => {
    const content = subset(1, 4);
    const page4 = content['4'] as string[];
    page4[2] = '超长'.repeat(40); // 卡片正文溢出
    page4[3] = ''; // 空串
    let thrown: unknown;
    try {
      await renderTemplateDeck(template, table, content);
    } catch (error) {
      thrown = error;
    }
    const diagnostics = diagnosticsOf(thrown);
    const codes = diagnostics.map((item) => item.code);
    expect(codes).toContain('text-invalid');
    expect(codes).toContain('text-overflow');
  });

  it('真正不可恢复（表结构坏）仍单条 fail-fast', async () => {
    const invalidTable = JSON.parse(JSON.stringify(table)) as SlotTable;
    invalidTable.pages[0].slide_number = 99;
    await expect(renderTemplateDeck(template, invalidTable, subset(1))).rejects.toThrow('slot-table-invalid');
  });
});

describe('layout 4/5/6 最小复现（无模型）', () => {
  it('修对三处计数后，4/5/6 组合渲染 + 产物校验全绿', async () => {
    const fixed = subset(1, 2, 4, 5, 6, 16);
    const buffer = await renderTemplateDeck(template, table, fixed);
    const verification = verifyTemplateDeck(buffer, table, fixed);
    expect(verification.pages).toBe(6);
    expect(verification.slots).toBe(4 + 17 + 12 + 14 + 21 + 4);
    expect(verification.charts).toBe(0);
  });

  it('⭐ check.ts 入口：多页产物问题一次抛全（跨页聚合）', async () => {
    const data = subset(1, 4, 5);
    const buffer = await renderTemplateDeck(template, table, data);
    const zip = await JSZip.loadAsync(buffer);
    // 篡改 layout 4 与 layout 5 两页的首个文本 run 为不同串。
    zip.file(
      'ppt/slides/slide4.xml',
      (await zip.file('ppt/slides/slide4.xml')!.async('string')).replace(/<a:t>[^<]*<\/a:t>/, '<a:t>changed-4</a:t>'),
    );
    zip.file(
      'ppt/slides/slide5.xml',
      (await zip.file('ppt/slides/slide5.xml')!.async('string')).replace(/<a:t>[^<]*<\/a:t>/, '<a:t>changed-5</a:t>'),
    );
    const damaged = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    let thrown: unknown;
    try {
      verifyTemplateDeck(damaged, table, data);
    } catch (error) {
      thrown = error;
    }
    const diagnostics = diagnosticsOf(thrown);
    const mismatches = diagnostics.filter((item) => item.code === 'content-mismatch');
    // 一次抛全两页问题，而不是撞到第 4 页就停。
    expect(mismatches).toHaveLength(2);
    const all = mismatches.map((item) => item.detail).join(' | ');
    expect(all).toContain('layout 4');
    expect(all).toContain('layout 5');
  });

  it('逐个修复序列可复现（fail-fast 迫使 ≥3 轮；聚合一轮修完）', async () => {
    // 第一轮：只拿到「layout 4 expected 12」——按老行为修好 layout 4。
    const step1 = run6bShapedContent();
    const fixed4 = subset(4)['4'] as string[];
    step1['4'] = fixed4;
    // 老行为第二轮：这回才报「layout 5 expected 14」。
    const step2 = structuredClone(step1);
    step2['5'] = subset(5)['5'];
    // 老行为第三轮：再报「layout 6 expected 21」——三轮才到全绿。
    const step3 = structuredClone(step2);
    step3['6'] = subset(6)['6'];
    const buffer = await renderTemplateDeck(template, table, step3);
    expect(verifyTemplateDeck(buffer, table, step3).pages).toBe(6);
  });
});
