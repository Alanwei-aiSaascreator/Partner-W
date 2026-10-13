import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderNativePptFile } from '../src/main/docgen/native-file.js';
import type { NativePptReport } from '../src/main/docgen/native-file.js';
import type { TemplateDeckContent } from '../src/main/docgen/template-deck/index.js';

/**
 * BUG-046 ② 的**返回通道**钉子（2026-10-13 复核，计划 P1）。
 *
 * 聚合本体在 `template-deck/input.ts:170-361`（另有 `template-deck-aggregate.test.ts`
 * 直接钉 `renderTemplateDeck`）。这里补的是**诊断走向模型那条通道**：
 *
 * ```
 * 模型 exec 技能脚本 (generate.cjs)
 *   → spawn runtime `--royin-render-native-ppt`（render-command.ts）
 *   → renderNativePptFile（= 本测试直接调用的函数）
 *   → renderSlotNativePpt catch ⇒ report.diagnostics = error.diagnostics
 *   → render-command.ts finish(): process.stdout.write(JSON.stringify(report) + '\n')
 *   → generate.cjs 解析那一行 JSON、按 schemaVersion/artifactIndexed/visualReview/
 *     status/fileCreated 五道契约检查后**原样返回**给模型
 * ```
 *
 * 断言口径（计划 §4 P1 第 1 条）：
 *  - 一次返回 **layout 4/5/6 三个计数问题**（不是修一个再撞下一个）；
 *  - 每条计数问题带 **期望数 + 角色清单 + 实际数**（expected/got/角色）；
 *  - **同页空值与溢出**也一起返回（不互相掩盖）；
 *  - 报告本身满足 generate.cjs 对失败报告的**全部**放行条件，且 JSON 序列化
 *    （stdout 那一行）不丢任何诊断。
 *
 * ⚠️ 本文件不修改任何产品代码：如果这条链丢诊断，本文件会红；当前应为绿（"② 代码已具备"）。
 */

const templatesRoot = resolve('resources/pptx-templates');
const resource = join(templatesRoot, 'native-deck');
const example = JSON.parse(fs.readFileSync(join(resource, 'content.example.json'), 'utf8')) as TemplateDeckContent;

const subset = (...pages: number[]): TemplateDeckContent =>
  Object.fromEntries(pages.map((page) => [String(page), structuredClone(example[String(page)])]));

/** run6b 终稿形状（BUG-046 真机）+ 同页空值与溢出（计划 P1 断言的第二半）。 */
function run6bShapedContent(): TemplateDeckContent {
  const content = subset(1, 2, 4, 5, 6, 16);
  content['4'] = (content['4'] as string[]).slice(0, 11); // 缺「底部结论」（契约 12）
  content['5'] = (content['5'] as string[]).slice(0, 11); // 契约 14
  content['6'] = (content['6'] as string[]).slice(0, 13); // 契约 21
  const page16 = content['16'] as string[];
  page16[1] = ''; // 同页空值（结尾副标）
  page16[2] = '超长'.repeat(40); // 同页溢出（联系方式上限 60 字，实 80）
  return content;
}

interface ChannelResult {
  report: NativePptReport;
  /** render-command.ts 写给 stdout、generate.cjs 读到的那一行。 */
  reportText: string;
  workspaceFiles: string[];
}

async function renderThroughChannel(): Promise<ChannelResult> {
  const workspace = mkdtempSync(join(tmpdir(), 'native-channel-'));
  try {
    fs.writeFileSync(
      join(workspace, 'input.native-ppt.json'),
      JSON.stringify({ template: 'templateDeck', title: '通道回归', content: run6bShapedContent() }),
    );
    const report = await renderNativePptFile('input.native-ppt.json', workspace, {
      templatesRoot,
      enabled: true,
    });
    return { report, reportText: JSON.stringify(report), workspaceFiles: fs.readdirSync(workspace).sort() };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

describe('BUG-046 ② 诊断经由 CLI 返回通道（renderNativePptFile 报告 + stdout JSON 行）', () => {
  it('一次返回 layout 4/5/6 三个计数问题，且每条带 expected/got/角色清单', async () => {
    const { report } = await renderThroughChannel();
    expect(report.status).toBe('render-failed');
    const diagnostics = (report.diagnostics ?? []) as Array<{ code: string; page?: number; detail?: string }>;
    const countIssues = diagnostics.filter((item) => item.code === 'slot-content-count');
    expect(countIssues).toHaveLength(3);
    for (const issue of countIssues) expect(issue.detail).toMatch(/expected \d+.*got \d+/);
    const layout4 = countIssues.find((issue) => issue.detail?.includes('layout 4'));
    expect(layout4?.detail).toContain('底部结论'); // 角色清单点名缺哪一槽
    expect(layout4?.detail).toMatch(/expected 12/);
    expect(layout4?.detail).toMatch(/got 11/);
    const layout5 = countIssues.find((issue) => issue.detail?.includes('layout 5'));
    expect(layout5?.detail).toMatch(/expected 14/);
    expect(layout5?.detail).toMatch(/got 11/);
    const layout6 = countIssues.find((issue) => issue.detail?.includes('layout 6'));
    expect(layout6?.detail).toMatch(/expected 21/);
    expect(layout6?.detail).toMatch(/got 13/);
  });

  it('同页空值与溢出一起返回（计数问题不许把它们盖掉）', async () => {
    const { report } = await renderThroughChannel();
    const diagnostics = (report.diagnostics ?? []) as Array<{ code: string; detail?: string }>;
    const codes = diagnostics.map((item) => item.code);
    expect(codes).toContain('text-invalid'); // 同页空值
    expect(codes).toContain('text-overflow'); // 同页溢出
    expect(codes.filter((code) => code === 'text-invalid')).toHaveLength(1);
    expect(codes.filter((code) => code === 'text-overflow')).toHaveLength(1);
  });

  it('stdout 那一行 JSON 不丢任何诊断，且满足 generate.cjs 对失败报告的全部放行条件', async () => {
    const { report, reportText } = await renderThroughChannel();
    // generate.cjs 的失败直通条件（generate.cjs:233-240）——逐条对着它核。
    expect(report.schemaVersion).toBe(1);
    expect(report.artifactIndexed).toBe(false);
    expect(report.visualReview).toBe('not-performed');
    expect(['source-invalid', 'render-failed']).toContain(report.status);
    expect(report.fileCreated).toBe(false);
    // render-command.ts 的退出码语义：非 file-generated ⇒ app.exit(1)。
    // stdout 一行 = 模型实际看到的那份 JSON——序列化不许把诊断吞掉。
    const parsed = JSON.parse(reportText) as NativePptReport;
    expect(parsed.diagnostics).toEqual(report.diagnostics);
    expect((parsed.diagnostics ?? []).length).toBeGreaterThanOrEqual(5);
    expect(reportText).toContain('底部结论');
  });

  it('失败轮不留任何成品（不写 pptx、不写收据）', async () => {
    const { workspaceFiles } = await renderThroughChannel();
    expect(workspaceFiles.filter((name) => name.endsWith('.pptx'))).toHaveLength(0);
    expect(workspaceFiles.filter((name) => /receipt|\.royin-/.test(name))).toHaveLength(0);
  });
});
