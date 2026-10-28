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
 * BUG-046 补链二（r6 终审收窄后的证据收口，2026-10-14）：
 * 诊断从 `generate.cjs` 的 stdout **再往前走一段** —— 经过**真实 gateway 侧 exec 工具封装**
 * （frozen openclaw 2026.9.3 的 `createExecTool`：工具 schema → 跑进程 → toolResult）
 * 到达**模型可见**的 `content[0].text`。
 *
 * 为什么还缺这一段（终审原话）：`deck-layout-diagnostics-chain.test.ts` 只到脚本 stdout；
 * 真实网关把 exec 结果包成 toolResult 的那一层（截断 / 重排 / 丢字段）没有证据。
 * 本文件把**真实 dist 里那一个** `createExecTool`（agent 循环调用的同一个工具对象）
 * 在**受控子进程**里驱动起来，喂给它的就是同一份真正经 `generate.cjs` 产出的 stdout：
 *
 *   run6b 形状内容 → 真实 `renderNativePptFile` 报告 → 受控 runtime 逐字打印（替身）
 *     → 真实 `generate.cjs`（子进程，退出码 1）→ **真实 exec 工具** → toolResult.content[0].text
 *
 * 产品取结果有两条出口，都在本文件里对着**真实 dist 的同一份代码**取证：
 *  ① 直通出口（`ask=off`，frozen runtime 默认）：`execute()` 返回值本身；
 *  ② 审批续跑出口（产品配置 `tools.exec.mode=ask`，批准后由续跑 attempt 取结果）：
 *     `formatExecApprovalContinuationSourceOutput`（真实纯函数，自带 256k 上限 + 显式截断标记）。
 *
 * 边界（诚实口径，别当更强的证明读）：
 *  · **没有启动网关进程**：离线在受控 node 子进程里调用同一份 dist 的同一个工具工厂，
 *    `execute()` 就是 agent 循环的调用入口；approval 关掉（`security=full` + `ask=off`，
 *    即 frozen runtime 的默认值）—— 产品的 `mode=ask` 审批闸在**运行之前**，不影响运行之后的
 *    结果构造：两类出口都消费同一份 `outcome.aggregated`（直通出口 `buildExecForegroundResult`；
 *    续跑出口 `buildGatewayExecApprovalFollowupSummary` → `formatExecApprovalContinuationSourceOutput`）；
 *  · 受控 runtime 仍是**替身**（报告内容来自真实渲染器，逐字打印）；
 *  · 不解析 provider 请求体、不落 transcript：证据到"模型可见的 toolResult 文本 / 续跑摘要"为止，
 *    "这条文本如何进 provider 请求"不在本文件范围；
 *  · 不付费、不联网、不碰 18789 / 运行数据（openclaw state 落临时目录）。
 *
 * 门控（与 `pptx-template-packaged.test.ts` 同套路）：需要一个**已部署的** openclaw 包根
 *
 * ```
 * PARTNERW_OPENCLAW_RUNTIME_DIR="Q:\Partner-W-运行数据\...\runtime\deployed\<key>\node_modules\openclaw" \
 *   pnpm exec vitest run test/deck-layout-diagnostics-native-wrapper.test.ts
 * ```
 *
 * 不设就整组 skip（仓库/CI 里没有 runtime 部署）；设了却解析不出 exec 工具 ⇒ **报错**，
 * 不静默跳过（runtime 换代时这里必须响）。
 */

const RUNTIME_DIR = process.env.PARTNERW_OPENCLAW_RUNTIME_DIR;
const ENABLED = typeof RUNTIME_DIR === 'string' && RUNTIME_DIR.length > 0 && fs.existsSync(RUNTIME_DIR);
const DIST_DIR = ENABLED ? resolveDistDir(RUNTIME_DIR!) : '';

function resolveDistDir(root: string): string {
  const direct = path.join(root, 'dist');
  if (fs.existsSync(direct)) return direct;
  if (path.basename(root) === 'dist') return root;
  return direct; // 不存在 ⇒ 下面解析时明确报错
}

interface ExecToolModule {
  modulePath: string;
  exportName: string;
}

/**
 * 在 dist 里按**内容**找导出的函数（文件名是版本哈希，会随 runtime 换代变），
 * 并从该模块的 export 语句里读出它的导出名（minify 别名）。
 *
 * ⚠️ 先扫 `bash-tools*` 命名族（exec 相关模块 2026.9.3 都在这个命名族里），
 *    找不到才全量回退 —— 全量读 5000+ 个模块（几百 MB）在冷盘上会白白吃掉几十秒。
 */
const resolvedModules = new Map<string, ExecToolModule>();
function findExportedFunction(distDir: string, marker: string, functionName: string): ExecToolModule {
  const cacheKey = `${distDir}\u0000${functionName}`;
  const cached = resolvedModules.get(cacheKey);
  if (cached) return cached;
  if (!fs.existsSync(distDir)) throw new Error(`openclaw dist not found: ${distDir}`);
  const names = fs.readdirSync(distDir).filter((name) => name.endsWith('.mjs'));
  const preferred = names.filter((name) => name.startsWith('bash-tools'));
  for (const name of [...preferred, ...names.filter((entry) => !entry.startsWith('bash-tools'))]) {
    const modulePath = path.join(distDir, name);
    const text = fs.readFileSync(modulePath, 'utf8');
    if (!text.includes(marker)) continue;
    const exportBlocks = [...text.matchAll(/export\s*\{([^}]*)\}/g)].map((match) => match[1]);
    for (const block of exportBlocks) {
      const alias = new RegExp(`${functionName}\\s+as\\s+([A-Za-z_$][\\w$]*)`).exec(block)?.[1];
      if (alias) {
        const resolved = { modulePath, exportName: alias };
        resolvedModules.set(cacheKey, resolved);
        return resolved;
      }
      if (new RegExp(`(^|,)\\s*${functionName}\\s*(,|$)`).test(block)) {
        const resolved = { modulePath, exportName: functionName };
        resolvedModules.set(cacheKey, resolved);
        return resolved;
      }
    }
    throw new Error(`${functionName} found in ${name} but not exported`);
  }
  throw new Error(`no module with ${functionName}(...) under ${distDir}`);
}

const resolveExecToolModule = (distDir: string): ExecToolModule =>
  findExportedFunction(distDir, 'function createExecTool(', 'createExecTool');

/**
 * 审批续跑出口（产品配置 `tools.exec.mode=ask` 时，批准后由续跑 attempt 取结果）：
 * `formatExecApprovalContinuationSourceOutput` —— 纯函数，取 `outcome.aggregated`
 * 渲染成模型可见的续跑摘要（自带 256k UTF-16 上限 + 显式截断标记）。
 */
const resolveApprovalOutputModule = (distDir: string): ExecToolModule =>
  findExportedFunction(
    distDir,
    'function formatExecApprovalContinuationSourceOutput(',
    'formatExecApprovalContinuationSourceOutput',
  );

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
let stateDir = '';
let resultPath = '';
let harnessPath = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-wrapper-'));
  workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const managedDir = path.join(root, 'managed');
  expect(
    installBundledSkill({ root: path.join(import.meta.dirname, '../our-skills'), managedDir, slug: 'deck-layout' }).ok,
  ).toBe(true);
  command = path.join(managedDir, 'deck-layout/scripts/generate.cjs');
  child = path.join(root, 'runtime-child.cjs');
  reportPath = path.join(root, 'real-report.json');
  stateDir = path.join(root, 'openclaw-state');
  fs.mkdirSync(stateDir);
  resultPath = path.join(root, 'tool-result.json');
  harnessPath = path.join(root, 'exec-tool-harness.mjs');
});

afterEach(() => {
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('test path escaped');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const sourceName = 'report.native-ppt.json';

/** 同一份源文件：真实渲染器先跑一遍（产出真报告），链上再被脚本读一遍（sha/新鲜度）。 */
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

/**
 * 受控子进程 harness：import **真实 dist** 里的 exec 工具工厂，把工具 schema 与
 * `execute()` 的返回值（= agent 循环拿到的 toolResult）落盘。
 * 输出走文件而不是 stdout —— dist 里任何一行日志都不该污染证据。
 */
function writeHarness(): void {
  fs.writeFileSync(
    harnessPath,
    `import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [modulePath, exportName, approvalModulePath, approvalExport, workspace, command, outPath] =
  process.argv.slice(2);
const mod = await import(pathToFileURL(modulePath).href);
const factory = mod[exportName];
if (typeof factory !== 'function') throw new Error('createExecTool export missing: ' + exportName);
const tool = factory({
  cwd: workspace,
  host: 'gateway',
  security: 'full',
  ask: 'off',
  allowBackground: false,
  notifyOnExit: false,
  timeoutSec: 60,
});
const result = await tool.execute('call-1', { command }, undefined, () => {});
// 审批续跑出口：把同一条真实的 outcome.aggregated 喂给产品 mode=ask 那条取结果路径的渲染函数。
const approval = await import(pathToFileURL(approvalModulePath).href);
const continuation = approval[approvalExport]([{ label: 'output', value: result.details?.aggregated ?? '' }]);
fs.writeFileSync(outPath, JSON.stringify({
  toolName: tool.name,
  schemaType: tool.parameters?.type,
  schemaKeys: Object.keys(tool.parameters?.properties ?? {}),
  result,
  continuation,
}));
`,
  );
}

interface ToolRun {
  toolName: string;
  schemaType: string;
  schemaKeys: string[];
  result: {
    content: Array<{ type: string; text: string }>;
    details: { status: string; exitCode: number | null; aggregated?: string; cwd?: string };
  };
  /** 审批续跑出口渲染后的模型可见文本（`tools.exec.mode=ask` 那条路径取的同一份 aggregated）。 */
  continuation: string;
}

/**
 * 用**真实 exec 工具**跑一条命令（受控子进程；openclaw state 隔离到临时目录，
 * 不影响本机运行数据）。`extraEnv` 在 import 之前生效（如输出保留上限）。
 */
function runViaRealExecTool(extraEnv: Record<string, string> = {}, commandOverride?: string): ToolRun {
  const { modulePath, exportName } = resolveExecToolModule(DIST_DIR);
  const approval = resolveApprovalOutputModule(DIST_DIR);
  writeHarness();
  const { NODE_OPTIONS: options, NODE_PATH: nodePath, ...env } = process.env;
  void options;
  void nodePath;
  const spawn = spawnSync(
    process.execPath,
    [
      harnessPath,
      modulePath,
      exportName,
      approval.modulePath,
      approval.exportName,
      workspace,
      commandOverride ?? `node "${command}" "${sourceName}"`,
      resultPath,
    ],
    {
      cwd: workspace,
      env: {
        ...env,
        OPENCLAW_STATE_DIR: stateDir,
        HOME: stateDir,
        USERPROFILE: stateDir,
        ROYIN_NATIVE_PPT_VALIDATION: '1',
        ROYIN_TEST_REPORT: reportPath,
        ...extraEnv,
      },
      encoding: 'utf8',
      timeout: 90_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (spawn.status !== 0) {
    throw new Error(`exec tool harness failed (status=${spawn.status}): ${spawn.stderr || spawn.stdout}`);
  }
  return JSON.parse(fs.readFileSync(resultPath, 'utf8')) as ToolRun;
}

describe.skipIf(!ENABLED)('BUG-046 · 真实 exec 工具封装（工具 schema → toolResult → 模型可见负载）', () => {
  // 冷盘首跑要给"受控子进程 + 首次 import 真实 dist"留时间（仓库默认 35s 在外盘冷读时会不够）。
  it(
    '⭐ 真实 gateway exec 工具：失败轮 stdout 逐字到达模型可见 text，退出码显式标注',
    { timeout: 120_000 },
    async () => {
      const report = await realReport();
      fs.writeFileSync(reportPath, JSON.stringify(report));
      configureControlledRuntime();

      const run = runViaRealExecTool();

      // ① 驱动的是真实 exec 工具：名字与参数 schema（模型看到的工具定义）都对得上。
      expect(run.toolName).toBe('exec');
      expect(run.schemaType).toBe('object');
      for (const key of ['command', 'workdir', 'timeoutSeconds', 'background'])
        expect(run.schemaKeys, `exec schema 缺 ${key}`).toContain(key);

      // ② 模型可见负载 = toolResult.content[0].text；stdout（单行 JSON）必须逐字在里面。
      const modelVisible = run.result.content[0].text;
      expect(run.result.details.exitCode).toBe(1);
      // frozen runtime 语义：普通非零退出是 completed + 显式退出码标注（不是静默成功，
      // 也不是把输出换成一句错误话术）。
      expect(run.result.details.status).toBe('completed');
      expect(modelVisible.endsWith('(Command exited with code 1)')).toBe(true);
      const payloadText = modelVisible.slice(0, modelVisible.lastIndexOf('\n\n(Command exited with code 1)'));
      const payload = JSON.parse(payloadText) as NativePptReport & { runtimeCleanup?: string };
      expect(payload.diagnostics).toEqual(report.diagnostics);
      expect(payload.fileCreated).toBe(false);
      expect(payload.artifactIndexed).toBe(false);
      expect(payload.visualReview).toBe('not-performed');
      expect(payload.runtimeCleanup).toBe('complete');

      // ③ 多槽位诊断一条不少（与链一相同的判据，换由模型可见通道取证）。
      const diagnostics = payload.diagnostics as Array<{ code: string; detail?: string }>;
      expect(diagnostics.length).toBeGreaterThanOrEqual(5);
      const counts = diagnostics.filter((item) => item.code === 'slot-content-count');
      expect(counts).toHaveLength(3);
      expect(counts.find((item) => item.detail?.includes('layout 4'))?.detail).toMatch(
        /expected 12.*got 11|got 11.*expected 12/,
      );
      expect(modelVisible).toContain('底部结论');
      expect(modelVisible).toContain('got 13');

      // ④ 没有走任何截断通道（默认保留上限 2e5 字符，本负载远在其下）；
      //    details.aggregated 与模型可见 text 同源（两个出口不打架）。
      expect(modelVisible).not.toContain('retention cap');
      expect(modelVisible.length).toBeLessThan(20_000);
      expect(run.result.details.aggregated).toBe(modelVisible);

      // ④b 产品 `tools.exec.mode=ask` 的**审批续跑出口**（真实 dist 的纯函数）：同一份
      //     aggregated 原样进续跑摘要 —— 两条取结果路径都逐字带上诊断，没有第二套截断。
      expect(run.continuation).toBe(modelVisible);
      expect(run.continuation).not.toContain('truncated to fit the continuation budget');
      expect(run.continuation).toContain('底部结论');

      // ⑤ 脚本确实按 native 路由把源文件交给了 runtime（与链一相同的接线判据）。
      const invocation = JSON.parse(
        fs.readFileSync(path.join(workspace, 'runtime-invocation.json'), 'utf8'),
      ) as string[];
      expect(invocation).toEqual(['--royin-render-native-ppt', sourceName]);
    },
  );

  it('负对照：输出越过保留上限时是**显式**标注 + 保留尾部，绝不静默丢头', { timeout: 120_000 }, () => {
    // 把上限压到 1000 字符（frozen runtime 的 clamp 下限），验证"丢"只走显式通道。
    const run = runViaRealExecTool(
      { OPENCLAW_BASH_MAX_OUTPUT_CHARS: '1000' },
      `node -e "process.stdout.write('H'.repeat(500)+String.fromCharCode(10)+'T'.repeat(4000)+String.fromCharCode(10)+'TAILZ')"`,
    );
    const modelVisible = run.result.content[0].text;

    expect(modelVisible).toContain('[earlier output was discarded at the retention cap and cannot be recovered]');
    expect(modelVisible).toContain('TAILZ');
    expect(modelVisible.length).toBeLessThan(2_000);
  });
});
