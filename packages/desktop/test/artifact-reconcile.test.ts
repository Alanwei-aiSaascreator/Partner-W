import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildElectronProbe, runElectronProbe, type ElectronProbe } from './helpers/electron-probe.js';

interface ArtifactRow {
  id: string;
  name: string;
  type: string;
  filePath: string;
  localPath: string;
  mimeType: string;
  size: number;
}

interface ReconcileResult {
  saved: ArtifactRow[];
  existing: ArtifactRow[];
  updated: ArtifactRow[];
  missing: ArtifactRow[];
  skipped: string[];
  budgetExhausted: boolean;
}

const probePath = fileURLToPath(new URL('./helpers/artifact-reconcile-probe.ts', import.meta.url));
const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
const packageDir = dirname(packagePath);
const privateProbeRoot = process.env.CLAW_ARTIFACT_PROBE_ROOT;
let electronProbe: ElectronProbe;

function runProbe(workspacePath: string, scenario: string): Record<string, unknown> {
  return runElectronProbe({
    compiledProbePath: electronProbe.compiledProbePath,
    packageDir,
    workspacePath,
    scenario,
    privateProbeRoot,
  });
}

describe('artifact reconciliation', () => {
  let workspacePath: string;

  beforeAll(async () => {
    electronProbe = await buildElectronProbe({ probePath, packageDir, privateProbeRoot });
  }, 30_000);

  afterAll(() => electronProbe.cleanup());
  beforeEach(() => {
    workspacePath = mkdtempSync(join(privateProbeRoot ?? tmpdir(), 'clawwork-artifact-reconcile-'));
  });
  afterEach(() => rmSync(workspacePath, { recursive: true, force: true }));

  it('registers only new stable generated files and is idempotent', () => {
    const result = runProbe(workspacePath, 'lifecycle') as unknown as {
      first: ReconcileResult;
      second: ReconcileResult;
      count: { count: number };
    };
    expect(result.first.saved).toEqual([
      expect.objectContaining({
        name: '总结.docx',
        type: 'file',
        localPath: 'task-1/总结.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
      // ⭐ A 方案的 spike 2：**生成的 .pptx 会被登记成产物**（类型 file、PPTX 的 MIME）。
      //    这条是「助手做不出 PPT」那件事补完后的落点 —— 文件写进任务目录就会被列出来，
      //    不需要新 UI（见 docs/superpowers/specs/2026-09-24-local-docgen-design.md §2）。
      expect.objectContaining({
        name: '汇报.pptx',
        type: 'file',
        filePath: join(workspacePath, 'task-1', '汇报.pptx'),
        localPath: 'task-1/汇报.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      }),
    ]);
    expect(result.first.skipped).toEqual(expect.arrayContaining(['.secret.txt', 'draft.tmp', 'empty.pdf', 'inbox']));
    expect(result.second.saved).toEqual([]);
    expect(result.second.existing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ localPath: 'task-1/总结.docx' }),
        expect.objectContaining({ localPath: 'task-1/汇报.pptx' }),
      ]),
    );
    expect(result.count).toEqual({ count: 2 });
  });

  /**
   * ⭐ M1 端到端（2026-10-06，图14/16）：**坏文件物理上进不了 `artifacts` 表**。
   *
   * 单测（artifact-verify.test.ts）钉的是判据本体；这一条钉的是**接线**：
   * 真 SQLite + 真文件系统 + 真扫描路径下，截断的 `.pptx` 不登记、进 skipped、
   * 库里查无此行 —— 用户点开坏文件的路径从此不存在。
   */
  it('⭐ M1：截断的 pptx 不登记且进 skipped，合法 pptx 照常登记（坏文件进不了表）', () => {
    const probe = runProbe(workspacePath, 'corrupt-pptx') as {
      result: ReconcileResult;
      rows: Array<{ name: string; local_path: string; mime_type: string }>;
    };
    expect(probe.result.saved.map((artifact) => artifact.name)).toEqual(['complete.pptx']);
    expect(probe.result.skipped).toContain('truncated.pptx');
    expect(probe.rows).toEqual([
      expect.objectContaining({
        name: 'complete.pptx',
        local_path: 'task-1/complete.pptx',
        mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      }),
    ]);
  });

  /**
   * ⭐ M1 续（2026-10-06）：**原地改坏 ⇒ 清行**。
   *
   * 单看"不登记新版本"不够：旧行还在列表里 ⇒ 用户点开还是坏字节。
   * 这条钉死：改坏后旧行从 DB 消失（成果列表里不留"能点开但打不开"的条目）。
   */
  it('⭐ M1：已登记文件被原地改坏 → 旧行被清除，候选进 skipped', () => {
    const probe = runProbe(workspacePath, 'corrupt-after-register') as {
      first: ReconcileResult;
      before: Array<{ id: string; name: string }>;
      second: ReconcileResult;
      after: Array<{ id: string; name: string }>;
    };
    expect(probe.first.saved.map((artifact) => artifact.name)).toEqual(['deck.pptx']);
    expect(probe.before).toHaveLength(1);
    expect(probe.second.skipped).toContain('deck.pptx');
    expect(probe.after).toEqual([]);
  });

  /**
   * ⭐ P1-1（2026-10-07 体检）：门内**读失败 ≠ 结构损坏**。
   *
   * 上一档（M1）钉的是"读得出来、结构确认坏 ⇒ 清行"；这一档钉它的**对偶**：
   * 读不到时（EBUSY/EACCES 同构）一个字节都不许动 —— 否则一份本来好好的登记
   * 会因为"这一瞬读不到"被永久删掉，而下一轮基线按签名跳过，等于**不可自愈**。
   */
  it('⭐ 门内读失败（EBUSY/EACCES 同构）⇒ 只 skip，绝不删登记行', () => {
    const probe = runProbe(workspacePath, 'unreadable-keeps-row') as {
      first: ReconcileResult;
      before: Array<{ id: string; name: string }>;
      second: ReconcileResult;
      after: Array<{ id: string; name: string }>;
    };
    expect(probe.first.saved.map((artifact) => artifact.name)).toEqual(['deck.pptx']);
    expect(probe.before).toHaveLength(1);
    expect(probe.second.skipped).toContain('deck.pptx');
    expect(probe.second.saved).toEqual([]);
    expect(probe.after, '读失败把登记行删了 —— 这正是 P1-1 要根掉的行为').toEqual(probe.before);
  });

  /**
   * ⭐ P3-10（2026-10-07 体检）：陈旧行的清行按 **id + source_key** 复核。
   *
   * 判据：清行只针对"本趟读到的那一行"；并发那趟若已把该路径换成新登记，
   * 一个字节都不许动。旧实现按 (task_id, root, local_path) 删 ⇒ 会误伤新行。
   */
  it('⭐ 并发那趟已重新登记 ⇒ 清行按行身份复核，不动新行', () => {
    const probe = runProbe(workspacePath, 'corrupt-race-keeps-new-row') as {
      result: ReconcileResult;
      rows: Array<{ id: string; name: string }>;
    };
    expect(probe.result.skipped).toContain('deck.pptx');
    expect(probe.rows.map((row) => row.id)).toEqual(['concurrent-row']);
  });

  /**
   * ⭐ docx 登记门 + 脚本类文件不进产物（2026-10-06，用户反馈 #9）。
   *
   * ① `.docx` 并入登记前置门：纯文本改名的假 docx 不登记（Word/WPS 打开必报损坏的那批）。
   * ② `.js/.cjs/.mjs/.py` = 模型自己跑过的作业脚本不进产物列表（"桌面出现 js 文件"那一批）。
   *
   * ⚠️ 口径（行为差异写在这里）：**两个根同一条规则** —— 应用根任务目录与助手工作区
   *    一律排除脚本；显式保存路径（`saveArtifact*`，含用户点名要的代码块产物）不走本扫描，
   *    所以两个根在这一点上没有用户可感知的差异。
   * ⚠️ 对照项钉住边界：`.md`/`.html` 与合法 docx 照旧登记 —— 排除的是**脚本类**，
   *    不是"所有文本/代码"。
   */
  it('⭐ docx 登记门 + 脚本类排除（两个根同口径，文本类对照照旧登记）', () => {
    const probe = runProbe(workspacePath, 'docx-and-scripts') as {
      appResult: ReconcileResult;
      agentResult: ReconcileResult;
      rows: Array<{ name: string; root: string; local_path: string }>;
    };
    // 应用根：合法 docx 与文本类照旧登记；假 docx 与四类脚本全部挡在表外
    expect(probe.appResult.saved.map((artifact) => artifact.name)).toEqual(['notes.md', 'page.html', 'real.docx']);
    for (const name of ['fake.docx', 'debug.js', 'generate.cjs', 'tool.mjs', 'probe.py'])
      expect(probe.appResult.skipped).toContain(name);
    // 助手根：同一口径（脚本与假 docx 进 skipped，合法 docx 登记）
    expect(probe.agentResult.saved.map((artifact) => artifact.name)).toEqual(['report.docx']);
    expect(probe.agentResult.skipped).toEqual(
      expect.arrayContaining(['agent-fake.docx', 'agent-debug.js', 'agent-probe.py']),
    );
    // 库里只有四份合法交付物 —— 假 docx / 脚本一行都没有
    expect(probe.rows.map((row) => row.name)).toEqual(['notes.md', 'page.html', 'real.docx', 'report.docx']);
  });

  it('registers generated MP4/WebM files with video MIME without duplicate rows', () => {
    const result = runProbe(workspacePath, 'videos') as unknown as { first: ReconcileResult; second: ReconcileResult };
    // ⭐ BUG-120（2026-10-17）：mp4/webm 现在登记成专属类型 `video`（改型前一律 'file'）。
    //    扫描登记这条路与 videogen 显式保存那条路**同一口径** —— 同一份片子不该因为走哪条路就换个类型。
    expect(result.first.saved).toEqual([
      expect.objectContaining({ name: 'clip.mp4', type: 'video', mimeType: 'video/mp4' }),
      expect.objectContaining({ name: 'clip.webm', type: 'video', mimeType: 'video/webm' }),
    ]);
    expect(result.second.saved).toEqual([]);
    expect(result.second.existing).toHaveLength(2);
  });

  it('does not register a file that existed unchanged in the run baseline', () => {
    const { result } = runProbe(workspacePath, 'baseline') as unknown as { result: ReconcileResult };
    expect(result.saved).toEqual([]);
  });

  it.each([
    ['workspace', 'normal'],
    ['agent', 'normal'],
    ['workspace', 'controlled'],
    ['agent', 'controlled'],
  ])('rejects reserved intermediate files in the %s root with %s routing', (rootKind, mode) => {
    const probe = runProbe(workspacePath, `reserved-intermediate-${rootKind}-${mode}`) as {
      first: ReconcileResult;
      second: ReconcileResult;
      rows: Array<{ id: string; name: string; root: string; local_path: string }>;
    };

    expect(probe.first.saved.map((artifact) => artifact.name)).toEqual(['report.json']);
    expect(probe.second.saved).toEqual([]);
    expect(probe.second.existing.map((artifact) => artifact.name)).toEqual(['report.json']);
    expect(probe.rows).toEqual([
      expect.objectContaining({ id: 'prior-intermediate', name: 'prior.native-ppt.json', root: rootKind }),
      expect.objectContaining({ name: 'report.json', root: rootKind }),
    ]);
  });

  it('captures an empty baseline for a new task before its output directory exists', () => {
    expect(runProbe(workspacePath, 'new-task-baseline')).toEqual({ baseline: {} });
  });

  it('fails closed for an outside task junction or symlink', () => {
    const result = runProbe(workspacePath, 'task-link') as { supported: boolean; error?: string };
    if (!result.supported) return;
    expect(result.error).toMatch(/trusted task output/i);
  });

  it('reports database artifacts whose files are now missing', () => {
    const { result } = runProbe(workspacePath, 'missing') as unknown as { result: ReconcileResult };
    expect(result.missing).toEqual([
      expect.objectContaining({ id: 'artifact-missing', localPath: 'task-1/deleted.pdf' }),
    ]);
  });

  it('does not register a file that changes during stability verification', () => {
    const { result } = runProbe(workspacePath, 'changing') as unknown as { result: ReconcileResult };
    expect(result.saved).toEqual([]);
    expect(result.skipped).toContain('changing.txt');
  });

  it('retries stability verification once from the trusted root and registers a file that then settles', () => {
    const { result, checks } = runProbe(workspacePath, 'changing-once') as unknown as {
      result: ReconcileResult;
      checks: number;
    };
    expect(checks).toBe(2);
    expect(result.saved).toEqual([expect.objectContaining({ name: 'changing-once.txt' })]);
  });

  it('does not let unchanged baseline files consume the generated-result budget', () => {
    const { result } = runProbe(workspacePath, 'old-files-budget') as unknown as { result: ReconcileResult };
    expect(result.saved).toEqual([expect.objectContaining({ name: 'z-result.txt' })]);
  });

  it('fails closed when the run baseline was truncated', () => {
    const { result } = runProbe(workspacePath, 'truncated-baseline') as unknown as { result: ReconcileResult };
    expect(result.saved).toEqual([]);
    expect(result.budgetExhausted).toBe(true);
  });

  it('bounds traversal and reports exhaustion without scanning the whole task tree', () => {
    const { result } = runProbe(workspacePath, 'budget') as unknown as { result: ReconcileResult };
    expect(result.budgetExhausted).toBe(true);
    expect(result.saved.length).toBeLessThanOrEqual(2);
  });

  it('keeps concurrent reconciliation idempotent for the same task path', () => {
    const result = runProbe(workspacePath, 'concurrent') as unknown as {
      left: ReconcileResult;
      right: ReconcileResult;
      count: { count: number };
    };
    expect([...result.left.saved, ...result.right.saved]).toHaveLength(1);
    expect(result.count).toEqual({ count: 1 });
  });

  it('updates metadata in place when an already registered output changes', () => {
    const result = runProbe(workspacePath, 'updated') as unknown as {
      first: ReconcileResult;
      second: ReconcileResult;
      count: { count: number };
      stored: { size: number };
    };
    expect(result.second.updated).toEqual([expect.objectContaining({ id: result.first.saved[0].id, size: 14 })]);
    expect(result.count).toEqual({ count: 1 });
    expect(result.stored).toEqual({ size: 14 });
  });

  it('updates an artifact when the path is replaced with the same size and mtime', () => {
    const { first, second } = runProbe(workspacePath, 'replaced-same-metadata') as unknown as {
      first: ReconcileResult;
      second: ReconcileResult;
    };
    expect(second.updated).toEqual([expect.objectContaining({ id: first.saved[0].id })]);
  });

  it('does not rewrite an artifact already registered by attachment extraction', () => {
    const { result, stored } = runProbe(workspacePath, 'attachment') as unknown as {
      result: ReconcileResult;
      stored: { source_key: string; content_text: string };
    };
    expect(result.updated).toEqual([]);
    expect(result.existing).toEqual([expect.objectContaining({ id: 'attachment-artifact' })]);
    expect(stored).toEqual({ source_key: 'attachment:0:image.png', content_text: 'preserve me' });
  });

  it('excludes nested symlinks and never scans another task', () => {
    const probe = runProbe(workspacePath, 'nested-link') as unknown as {
      supported: boolean;
      result?: ReconcileResult;
    };
    if (!probe.supported) return;
    expect(probe.result?.saved.map((artifact) => artifact.name)).toEqual(['own.pdf']);
    expect(probe.result?.skipped).toContain('linked');
  });

  /**
   * ⭐ **第三个受信根**：应用工作区**根层**（2026-10-07）。
   *
   * 现场：模型绕过 docgen/slidegen，用 exec / CLI 把成品写到
   * `荣盈魔方工作区\荣盈互动公司介绍-v2-ade3018a.pptx` —— 前两个根
   * （`<工作区>/<taskId>` / 助手工作区）是**兄弟目录**，根层谁都不扫
   * ⇒ "生成成功了但产物面板里没有"，而且连失败提示都没有（claim-guard 找得到文件）。
   *
   * 这条用例同时钉住那一批纪律：起跑基线、depth 0 不递归、正向扩展名白名单、
   * 只读（不建任务目录）、以及"应用根那趟不许把根层行判成 missing"。
   */
  it('⭐ 第三个根（应用工作区根层）：交付物进产物，且不递归 / 不误收 / 只读', () => {
    const probe = runProbe(workspacePath, 'workspace-root') as {
      createdTaskDir: boolean;
      linkSupported: boolean;
      missingTaskBaseline: Record<string, string>;
      first: ReconcileResult;
      second: ReconcileResult;
      appResult: ReconcileResult;
      rows: Array<{ name: string; root: string; local_path: string; source_key: string }>;
    };

    // ① 只读：第三个根本**绝不**建任务目录（模型把成品写到根层时任务目录甚至可能不存在）
    expect(probe.createdTaskDir, '第三个根在应用工作区里建了任务目录 —— 它必须只读').toBe(false);
    // 新任务的第一份基线就是"根层那一层"的快照（不含任何任务目录）
    expect(probe.missingTaskBaseline).toEqual({ '用户已有文档.docx': expect.any(String) });

    // ② 这一轮写到根层的**文档类**交付物被登记；`local_path` 是**裸文件名**
    expect([...probe.first.saved].map((artifact) => artifact.name).sort()).toEqual([
      '交付说明.md',
      '荣盈互动公司介绍-v2-ade3018a.pptx',
    ]);
    expect(probe.rows.filter((row) => row.root === 'workspace-root')).toEqual([
      expect.objectContaining({
        name: '交付说明.md',
        local_path: '交付说明.md',
        source_key: expect.stringMatching(/^workspace-root-file:/),
      }),
      expect.objectContaining({
        name: '荣盈互动公司介绍-v2-ade3018a.pptx',
        local_path: '荣盈互动公司介绍-v2-ade3018a.pptx',
        source_key: expect.stringMatching(/^workspace-root-file:/),
      }),
    ]);

    // ③ 起跑**之前**就在根层的用户文件不进产物（基线挡），且不占预算
    expect(probe.first.saved.map((artifact) => artifact.name)).not.toContain('用户已有文档.docx');
    expect(probe.rows.map((row) => row.name)).not.toContain('用户已有文档.docx');

    // ④ depth 0 不递归 + 正向白名单：任务目录 / 助手目录 / 杂物 / 脚本 / 点开头 / junction 一个都不收
    for (const name of ['data.json', 'debug.js', '.hidden.pdf', 'task-1', 'rongying-agents']) {
      expect(probe.first.skipped, `${name} 不该进产物`).toContain(name);
      expect(probe.rows.map((row) => row.name)).not.toContain(name);
    }
    expect(probe.rows.map((row) => row.name)).not.toContain('task-dir.pptx');
    expect(probe.rows.map((row) => row.name)).not.toContain('deck.pptx');
    if (probe.linkSupported) expect(probe.rows.map((row) => row.name)).not.toContain('outside.pdf');

    // ⑤ 幂等：同一份基线第二趟只认"已有"，不再登记
    expect(probe.second.saved).toEqual([]);
    expect(probe.second.existing.map((artifact) => artifact.name).sort()).toEqual([
      '交付说明.md',
      '荣盈互动公司介绍-v2-ade3018a.pptx',
    ]);

    // ⑥ 应用根那趟**不许**把根层的行判成 missing（两批各行其是；混着算界面上一片红）
    expect(probe.appResult.missing.map((artifact) => artifact.name)).not.toContain('交付说明.md');
    expect(probe.appResult.missing.map((artifact) => artifact.name)).not.toContain('荣盈互动公司介绍-v2-ade3018a.pptx');
  });

  it('upgrades a legacy database by keeping the newest valid duplicate artifact metadata', () => {
    const { rows } = runProbe(workspacePath, 'legacy-artifact-upgrade') as {
      rows: Array<{ id: string; size: number; source_key: string }>;
    };
    expect(rows).toEqual([{ id: 'new-valid', size: 42, source_key: 'workspace-file:report.txt:new' }]);
  });

  /**
   * ⭐ **第二个受信根**：助手自己的工作区（2026-09-27）。
   *
   * 现场：用户让助手做 PPT / HTML，文件确实生成了、躺在助手的工作区里，
   * 而产物面板是空的 —— 真机 `.clawwork.db` 里 `SELECT COUNT(*) FROM artifacts` = **0**，
   * 因为扫描根一直是 `<应用工作区>/<taskId>`，与助手工作区是**兄弟目录**。
   *
   * ⚠️ 注意 `legacy-artifact-upgrade` 那条**顺带**验了老库迁移：
   *    探针里那张老 `artifacts` 表**没有 `root` 列**，而它照样通过。
   */
  it('⭐ 助手自己的工作区：新文件进产物，且不建任务目录、不干扰应用根那批', () => {
    const probe = runProbe(workspacePath, 'agent-root') as {
      createdTaskDirInsideAgentWs: boolean;
      agentResult: ReconcileResult;
      appResult: ReconcileResult;
      rows: Array<{ name: string; local_path: string; root: string; source_key: string }>;
    };

    // ① 助手根里新出现的**交付物**被登记了，而助手自己的配置（SOUL.md / IDENTITY.md /
    //    AGENTS.md / memory/**）**一个都不许进** —— 用户当初选「只要交付物」时点名的就是这批。
    //    漏掉的后果不是"少一条"，是每个任务的产物面板里永远堆着同一批噪音。
    expect(probe.agentResult.saved.map((artifact) => artifact.name)).toEqual(['deck.pptx']);
    expect(probe.agentResult.saved.map((artifact) => artifact.name)).not.toContain('SOUL.md');
    expect(probe.agentResult.saved.map((artifact) => artifact.name)).not.toContain('IDENTITY.md');
    expect(probe.rows).toHaveLength(1);
    expect(probe.rows[0]).toMatchObject({ name: 'deck.pptx', root: 'agent' });
    // ⭐ `local_path` **不带任务前缀** —— 它是相对**助手工作区**的
    expect(probe.rows[0]?.local_path).toBe('deck.pptx');
    expect(probe.rows[0]?.source_key.startsWith('agent-workspace-file:')).toBe(true);

    // ② 不许在助手工作区里建任务目录：那是**网关的**目录，我们只读
    expect(probe.createdTaskDirInsideAgentWs, '在助手工作区里建了 task-1/').toBe(false);

    // ③ 之后跑的应用根那趟**不该**把助手根的行判成 missing
    //    （两批产物各行其是；混着算就会在界面上显示成"文件不见了"）
    expect(probe.appResult.missing).toEqual([]);
  });
});
