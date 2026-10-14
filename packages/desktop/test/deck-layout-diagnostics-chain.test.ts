import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installBundledSkill } from '../src/main/skills/bundled.js';
import { renderNativePptFile } from '../src/main/docgen/native-file.js';
import type { NativePptReport } from '../src/main/docgen/native-file.js';
import type { TemplateDeckContent } from '../src/main/docgen/template-deck/index.js';

/**
 * BUG-046 补链测试（2026-10-14 M1）：**真实 `generate.cjs` 子进程**上的诊断传递。
 *
 * 现有覆盖到哪、缺哪：
 *  · `template-deck-aggregate.test.ts` —— 聚合本体（`renderTemplateDeck` 一次抛全）
 *  · `template-deck-diagnostics-channel.test.ts` —— `renderNativePptFile` 报告 → stdout JSON 行
 *    （**JSON roundtrip**，没有启动脚本子进程）
 *  · 本文件 —— 补上**模型实际拿到的那一段**：诊断从"渲染报告"经过技能脚本
 *    `our-skills/deck-layout/scripts/generate.cjs` 的放行契约（schemaVersion / status /
 *    fileCreated / 退出码 / runtimeCleanup）后，**完整**（多条 slot 错误 + 总数 +
 *    角色清单 + 实际值，一字不截）到达模型可见的 stdout payload；坏页不写产物。
 *
 * 边界（与施工图一致，别当更强的证明读）：
 *  · `generate.cjs` 是**仓库里那份真品**（经产品自己的 `installBundledSkill` 安装）；
 *  · 受控子进程（`generate-runtime.json` 指到的 runtime）是**测试替身**——它打印的
 *    报告是先用**真实** `renderNativePptFile` 在同一份模板/内容上产出的真报告，
 *    经文件落到替身里逐字输出；即"报告内容真实、runtime 是替身、脚本壳真实"。
 *    打包态 Electron renderer（`render-command.ts`）不在本测试范围。
 *  · 不付费、不联网、不碰 18789/运行数据。
 */

const templatesRoot = path.resolve('resources/pptx-templates');
const resource = path.join(templatesRoot, 'native-deck');
const example = JSON.parse(fs.readFileSync(path.join(resource, 'content.example.json'), 'utf8')) as TemplateDeckContent;

const subset = (...pages: number[]): TemplateDeckContent =>
  Object.fromEntries(pages.map((page) => [String(page), structuredClone(example[String(page)])]));

/** run6b 形状（BUG-046 真机）：layout 4/5/6 计数不达契约 + 同页空值/溢出。 */
function run6bShapedContent(): TemplateDeckContent {
  const content = subset(1, 2, 4, 5, 6, 16);
  content['4'] = (content['4'] as string[]).slice(0, 11); // 缺「底部结论」（契约 12）
  content['5'] = (content['5'] as string[]).slice(0, 11); // 契约 14
  content['6'] = (content['6'] as string[]).slice(0, 13); // 契约 21
  const page16 = content['16'] as string[];
  page16[1] = ''; // 同页空值
  page16[2] = '超长'.repeat(40); // 同页溢出
  return content;
}

let root = '';
let workspace = '';
let command = '';
let child = '';
let reportPath = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-chain-'));
  workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const managedDir = path.join(root, 'managed');
  expect(
    installBundledSkill({ root: path.join(import.meta.dirname, '../our-skills'), managedDir, slug: 'deck-layout' }).ok,
  ).toBe(true);
  command = path.join(managedDir, 'deck-layout/scripts/generate.cjs');
  child = path.join(root, 'runtime-child.cjs');
  reportPath = path.join(root, 'real-report.json');
});
afterEach(() => {
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('test path escaped');
  fs.rmSync(root, { recursive: true, force: true });
});

/** 同一份源文件：真实渲染器先跑一遍（产出真报告），链上再被脚本读一遍（sha/新鲜度））。 */
const sourceName = 'report.native-ppt.json';

async function realReport(): Promise<NativePptReport> {
  fs.writeFileSync(
    path.join(workspace, sourceName),
    JSON.stringify({ template: 'templateDeck', title: '链上回归', content: run6bShapedContent() }),
  );
  const report = await renderNativePptFile(sourceName, workspace, { templatesRoot, enabled: true });
  expect(report.status).toBe('render-failed');
  return report;
}

/** 受控 runtime：逐字打印真报告（render-command.ts 的形状）+ 记录 argv + 失败退出码 1。 */
function configureControlledRuntime(): void {
  fs.writeFileSync(
    child,
    `const fs=require('node:fs');
fs.writeFileSync('runtime-invocation.json', JSON.stringify(process.argv.slice(2)));
process.stdout.write(fs.readFileSync(process.env.ROYIN_TEST_REPORT,'utf8'));
process.exit(1);`,
  );
  fs.writeFileSync(
    path.join(path.dirname(command), 'generate-runtime.json'),
    JSON.stringify({ schemaVersion: 1, executable: process.execPath, args: [child] }),
  );
}

function invoke(): { status: number | null; stdout: string; stderr: string } {
  const { NODE_OPTIONS: options, NODE_PATH: nodePath, ...env } = process.env;
  void options;
  void nodePath;
  const result = spawnSync(process.execPath, [command, sourceName], {
    cwd: workspace,
    env: { ...env, ROYIN_NATIVE_PPT_VALIDATION: '1', ROYIN_TEST_REPORT: reportPath },
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 512 * 1024,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('BUG-046 · 真实 generate.cjs 子进程上的多槽位诊断传递', () => {
  it('⭐ 具名放行契约：多条 slot 错误 + 总数 + 角色/实际值 完整到达模型可见 payload，不降级成裸码', async () => {
    const report = await realReport();
    fs.writeFileSync(reportPath, JSON.stringify(report));
    configureControlledRuntime();

    const { status, stdout } = invoke();
    // 失败报告按 generate.cjs 的约定原样直通（退出码 1），不被压成 render-output-unconfirmed。
    expect(status).toBe(1);
    const payload = JSON.parse(stdout.trim()) as NativePptReport & { runtimeCleanup?: string };
    expect(payload.status).toBe('render-failed');
    expect(payload.fileCreated).toBe(false);
    expect(payload.artifactIndexed).toBe(false);
    expect(payload.visualReview).toBe('not-performed');
    expect(payload.runtimeCleanup).toBe('complete');

    // ① 诊断**逐字**到达（deep equal：不丢字段、不截断、不改写）。
    expect(payload.diagnostics).toEqual(report.diagnostics);
    const diagnostics = payload.diagnostics as Array<{ code: string; detail?: string }>;
    expect(diagnostics.length).toBeGreaterThanOrEqual(5);

    // ② 三个计数问题一次到齐，每条带 期望数 + 角色清单 + 实际数。
    const counts = diagnostics.filter((item) => item.code === 'slot-content-count');
    expect(counts).toHaveLength(3);
    const layout4 = counts.find((item) => item.detail?.includes('layout 4'));
    expect(layout4?.detail).toMatch(/expected 12/);
    expect(layout4?.detail).toMatch(/got 11/);
    expect(layout4?.detail, '角色清单要点名缺哪一槽').toContain('底部结论');
    const layout6 = counts.find((item) => item.detail?.includes('layout 6'));
    expect(layout6?.detail).toMatch(/expected 21/);
    expect(layout6?.detail).toMatch(/got 13/);
    // 同页空值/溢出也活着（没被计数问题盖掉）。
    expect(diagnostics.map((item) => item.code)).toContain('text-invalid');
    expect(diagnostics.map((item) => item.code)).toContain('text-overflow');
    // 原文级别不截断（模型看到的就是这些字）。
    expect(stdout).toContain('底部结论');
    expect(stdout).toContain('got 13');

    // ③ 脚本确实把源文件按 native 路由交给了 runtime（args 形状与真 renderer 契约一致）。
    const invocation = JSON.parse(fs.readFileSync(path.join(workspace, 'runtime-invocation.json'), 'utf8')) as string[];
    expect(invocation).toEqual(['--royin-render-native-ppt', sourceName]);

    // ④ 坏页不写、不登记：工作区里没有 pptx / 收据残留。
    const leftovers = fs
      .readdirSync(workspace)
      .filter((name) => name.endsWith('.pptx') || name.startsWith('.royin-ppt-receipt'));
    expect(leftovers).toHaveLength(0);
  });
});
