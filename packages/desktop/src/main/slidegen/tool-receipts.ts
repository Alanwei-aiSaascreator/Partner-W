import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseSlidegenToolStream, type Message, type SlidegenWarning, type ToolCall } from '@clawwork/shared';
import { readSlideGenerationReceipt, type SlideGenerationReceipt } from './receipt.js';
import { contained, readSlideSourceFile, readWorkspaceBytes } from './source-file.js';
import { extractSlidegenBlocks, type SlidegenDeck } from './blocks.js';

export interface ToolSlideReceipt {
  receiptFile: string;
  receipt: SlideGenerationReceipt;
  source: string;
  /**
   * ⭐ **这条收据（以及它的成品）在哪个目录**（真实路径）—— B 包，2026-10-07。
   *
   * **缺省 = 调用方给的 `workspacePath`**（助手工作区，老行为）：报告里没有
   * `outputDir`（老子进程 / native 路由）或它不落在我们认的根里时就是这个。
   * 真机形态：模型把 CLI 的 cwd 设成了应用工作区根层 ⇒ 那批收据的目录是它。
   *
   * ⚠️ 这个值**不是报告说了算**：它是"收据**读得回来**的那个目录"，而收据自己带着
   *    该目录的身份（`workspaceIdentity` 的 dev/ino）—— 换个目录读，`verify` 那一步就拒了。
   */
  outputDir?: string;
}

/**
 * 报告里那句"东西写在哪"（`render-file.ts` 的 `outputDir`，绝对路径）。
 *
 * ⚠️ **只有落在我们认的根里才认**：报告会被主进程用来读收据、复制成品，
 *    而它这一路经过模型（工具结果原文）⇒ 模型可以编。认的根 = 助手工作区
 *    （调用方给的 `workspacePath`）+ 调用方额外交进来的（线上是**应用工作区**）。
 *    其余一律 `undefined` ⇒ 回落老行为（fail-closed，不是放宽）。
 */
function reportOutputDir(report: Record<string, unknown>, roots: readonly string[]): string | undefined {
  const value = report.outputDir;
  if (typeof value !== 'string' || !path.isAbsolute(value)) return undefined;
  try {
    const real = fs.realpathSync(value);
    if (!fs.statSync(real).isDirectory()) return undefined;
    return roots.some((root) => {
      try {
        return contained(fs.realpathSync(root), real);
      } catch {
        return false;
      }
    })
      ? real
      : undefined;
  } catch {
    return undefined;
  }
}
type ToolMessage = Pick<Message, 'taskId' | 'sessionKey' | 'runId' | 'role' | 'toolCalls'>;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * 本批工具调用里「干净退出」（`Process exited with code 0.`）出现过的后台会话 id 集合。
 *
 * ⭐ 2026-10-06 真机（受控模板链 attempt01 fadcaef8）：生成脚本**先**打印完整报告、
 *    进程**后**退出；模型分两次 poll —— 第一次拿到报告（尾巴 `Process still running.`），
 *    第二次只拿到 `(no new output)` + `Process exited with code 0.`。
 *    「报告与退出同一次 poll 到达」与「分两次到达」是**同一条证据**（报告在退出之前打印，
 *    退出发生在报告之后）。只认前者会把这类完全正常的调用序列整轮判成
 *    `slidegen-output-unconfirmed`，交付线上没有任何一条路径能救回。
 *    ⇒ 仍以「该会话被证实干净退出」为先决条件：退出非 0 / 根本没退出 ⇒ 一律不认（fail-closed）。
 */
function sessionsWithCleanExit(tools: readonly ToolCall[]): Set<string> {
  const sessions = new Set<string>();
  for (const tool of tools) {
    if (tool.name !== 'process' || tool.args?.action !== 'poll' || typeof tool.args.sessionId !== 'string') continue;
    if ((tool.result ?? '').trim().endsWith('Process exited with code 0.')) sessions.add(tool.args.sessionId);
  }
  return sessions;
}

function reportFrom(tool: ToolCall, cleanExitSessions?: ReadonlySet<string>): Record<string, unknown> | null {
  if (tool.status !== 'done' || typeof tool.result !== 'string' || tool.result.length > 2 * 1024 * 1024) return null;
  let result = tool.result.trim();
  if (tool.name === 'process' && tool.args?.action === 'poll') {
    const exited = '\n\nProcess exited with code 0.';
    const running = '\n\nProcess still running.';
    if (result.endsWith(exited)) result = result.slice(0, -exited.length).trim();
    else if (
      result.endsWith(running) &&
      typeof tool.args.sessionId === 'string' &&
      cleanExitSessions?.has(tool.args.sessionId)
    )
      result = result.slice(0, -running.length).trim();
    else return null;
  } else if (tool.name !== 'exec') return null;
  try {
    const report = parseSlidegenToolStream(result)?.report;
    return object(report) && report.status === 'file-generated' && report.receiptStatus === 'ready' ? report : null;
  } catch {
    return null;
  }
}

export function collectToolSlideReceipts(input: {
  workspacePath: string;
  taskId: string;
  sessionKey: string;
  runId?: string;
  messages: readonly ToolMessage[];
  allowNative?: boolean;
  isNativeParentCurrent?: (fileName: string, outputSha256: string) => boolean;
  /**
   * ⭐ 除助手工作区外，**还允许从哪些目录读收据**（B 包，2026-10-07）。
   * 线上传的是**应用工作区**：模型把 CLI 的 cwd 设成工作区根层时，收据与成品都在那儿，
   * 不认这个目录就永远读不回那条收据（那份真产出被判"未确认"）。
   * ⚠️ 传进来的每一条都必须是**我们自己的根**（应用工作区 / 助手工作区），
   *    不是报告说了算 —— 报告那一路经过模型，可以编。
   */
  allowedReceiptRoots?: readonly string[];
}): { receipts: ToolSlideReceipt[]; rejected: number } {
  const result: { receipts: ToolSlideReceipt[]; rejected: number } = { receipts: [], rejected: 0 };
  if (!input.runId || !input.taskId || !input.sessionKey) return result;
  const scopedTools = input.messages
    .filter(
      (message) =>
        message.role === 'assistant' &&
        message.taskId === input.taskId &&
        message.sessionKey === input.sessionKey &&
        message.runId === input.runId,
    )
    .flatMap((message) => message.toolCalls);
  const cleanExitSessions = sessionsWithCleanExit(scopedTools);
  const proofs = new Map<
    string,
    { report: Record<string, unknown> | null; serialized: string; conflicting: boolean }
  >();
  let totalCharacters = 0;
  for (const message of input.messages) {
    if (
      message.role !== 'assistant' ||
      message.taskId !== input.taskId ||
      message.sessionKey !== input.sessionKey ||
      message.runId !== input.runId
    )
      continue;
    for (const tool of message.toolCalls) {
      if (typeof tool.result === 'string') totalCharacters += tool.result.length;
      if (totalCharacters > 8 * 1024 * 1024) return { receipts: [], rejected: proofs.size + 1 };
      if (!tool.id || (tool.status !== 'done' && tool.status !== 'error')) continue;
      const report = reportFrom(tool, cleanExitSessions);
      const serialized = JSON.stringify([tool.name, tool.status, tool.result ?? null, tool.args?.action ?? null]);
      const previous = proofs.get(tool.id);
      if (!previous) {
        if (proofs.size >= 256) return { receipts: [], rejected: proofs.size + 1 };
        proofs.set(tool.id, { report, serialized, conflicting: false });
      } else if (previous.serialized !== serialized) {
        previous.conflicting = true;
        previous.report ??= report;
      }
    }
  }
  const seen = new Set<string>();
  for (const proof of proofs.values()) {
    if (!proof.report) continue;
    if (proof.conflicting) {
      result.rejected++;
      continue;
    }
    const { report } = proof;
    const file = report.receiptFile;
    try {
      if (
        report.schemaVersion !== 1 ||
        report.fileCreated !== true ||
        report.artifactIndexed !== false ||
        report.visualReview !== 'not-performed' ||
        typeof file !== 'string' ||
        !/^\.royin-ppt-receipt-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/.test(file)
      )
        throw new Error('tool-receipt-invalid');
      // ⭐ 收据读哪去（B 包）：报告说"写在哪儿"、且那个目录是我们认的根 ⇒ 就从那儿读。
      //    收据自己带着目录身份（dev/ino），读错目录会在 `readSlideGenerationReceipt`
      //    的 `verify` 那一步被拒 ⇒ 这条线索**不放大**任何信任。
      const outputDir =
        reportOutputDir(report, [input.workspacePath, ...(input.allowedReceiptRoots ?? [])]) ?? input.workspacePath;
      const receipt = readSlideGenerationReceipt(outputDir, file);
      if (
        receipt.sourceFormat === 'native-template-v5' &&
        (!input.allowNative ||
          report.contentReview !== 'field-coverage-passed' ||
          report.officeReview !== 'not-performed' ||
          report.qualityStatus !== 'needs-review')
      )
        throw new Error('tool-receipt-native-disabled');
      for (const key of ['sourceSha256', 'fileName', 'outputSha256', 'bytes', 'pages'] as const) {
        if (report[key] !== receipt[key]) throw new Error('tool-receipt-mismatch');
      }
      if (!seen.has(file)) {
        // ⚠️ 源文件按**收据所在的那个目录**读，不是按助手工作区：收据连目录一起被绑定
        //    （`verify`），所以它自述的 `sourceFile` 就是相对它自己的目录的。
        const content =
          receipt.sourceFormat === 'native-template-v5'
            ? new TextDecoder('utf-8', { fatal: true }).decode(
                readWorkspaceBytes(outputDir, receipt.sourceFile, 1024 * 1024),
              )
            : readSlideSourceFile(outputDir, receipt.sourceFile);
        if (createHash('sha256').update(content).digest('hex') !== receipt.sourceSha256)
          throw new Error('tool-receipt-mismatch');
        if (receipt.sourceFormat === 'native-template-v5')
          result.receipts.push({ receiptFile: file, receipt, source: content, outputDir });
        else {
          const { decks } = extractSlidegenBlocks(content);
          if (decks.length !== 1) throw new Error('tool-receipt-mismatch');
          result.receipts.push({ receiptFile: file, receipt, source: decks[0].source, outputDir });
        }
        seen.add(file);
      }
    } catch {
      result.rejected++;
    }
  }
  const accepted: ToolSlideReceipt[] = [];
  for (const entry of result.receipts.sort((a, b) => (a.receipt.revision ?? 0) - (b.receipt.revision ?? 0))) {
    const receipt = entry.receipt;
    if (receipt.sourceFormat === 'native-template-v5' && (receipt.revision ?? 0) > 0) {
      const parentProved = accepted.some(
        (parent) =>
          parent.receiptFile === receipt.previousReceiptFile &&
          parent.receipt.sourceFormat === 'native-template-v5' &&
          parent.receipt.fileName === receipt.previousFileName &&
          parent.receipt.outputSha256 === receipt.previousOutputSha256,
      );
      if (
        !parentProved &&
        (!receipt.previousFileName ||
          !receipt.previousOutputSha256 ||
          !input.isNativeParentCurrent?.(receipt.previousFileName, receipt.previousOutputSha256))
      ) {
        result.rejected++;
        continue;
      }
    }
    accepted.push(entry);
  }
  result.receipts = accepted;
  return result;
}

export function reuseToolSlideDeck(
  workspace: string,
  entries: readonly ToolSlideReceipt[],
  deck: SlidegenDeck,
): SlidegenWarning[] | null {
  const matched = entries.filter((entry) => entry.source === deck.source);
  if (!matched.length) return null;
  return matched.flatMap((entry) => {
    // ⚠️ 按**这条收据自己的目录**复核（`entry.outputDir`）：跨根的那批（模型渲在
    //    应用工作区根层）在助手工作区里根本读不到 —— 用 `workspace` 会把它整条判成
    //    "收据对不上"，而它其实好好的。
    const current = readSlideGenerationReceipt(entry.outputDir ?? workspace, entry.receiptFile);
    if (JSON.stringify(current) !== JSON.stringify(entry.receipt)) throw new Error('tool-receipt-mismatch');
    return entry.receipt.warnings.map((warning) => ({ ...warning, artifactName: current.fileName }));
  });
}

export function hasUnconfirmedSlideToolOutput(
  tools: readonly ToolCall[],
  entries: readonly ToolSlideReceipt[],
): boolean {
  const generationCommand = (tool: ToolCall) =>
    tool.name === 'exec' &&
    typeof tool.args?.command === 'string' &&
    /(?:^|[\\/\s"'])deck-layout[\\/]scripts[\\/]generate\.cjs(?:[\s"']|$)/i.test(tool.args.command);
  /** 归一化 workspace 相对路径（分隔符/大小写），与 `receipt.sourceFile` 同口径。 */
  const normalizeSource = (value: string): string => {
    const slashed = value.replaceAll('\\', '/').replace(/^\.\//, '');
    return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
  };
  /**
   * 从生成命令里取**源文件参数**（与 `receipt.sourceFile` 同口径）；
   * 取不到回 `null` —— 调用方必须当「无法证明被取代」，保持 fail-closed。
   */
  const renderSourceFromCommand = (tool: ToolCall): string | null => {
    if (tool.name !== 'exec' || typeof tool.args?.command !== 'string') return null;
    const command = tool.args.command;
    if (!/(?:^|[\\/\s"'])deck-layout[\\/]scripts[\\/]generate\.cjs(?:[\s"']|$)/i.test(command)) return null;
    const tokens = command.match(/"[^"]*"|'[^']*'|[^\s"']+/g) ?? [];
    for (let index = tokens.length - 1; index >= 0; index -= 1) {
      const raw = tokens[index]!.replace(/^["']|["']$/g, '');
      if (/\.(?:slidegen|native-ppt\.json)$/i.test(raw)) return normalizeSource(raw);
    }
    return null;
  };
  /**
   * 「这次尝试在渲染哪个源文件」—— exec 看命令；后台 poll 回溯到它那次 launch 的命令
   * （`Command still running (session …)` 里的 sessionId 对上）。取不到回 `null`。
   */
  const renderSourceForAttempt = (tool: ToolCall, index: number): string | null => {
    if (tool.name === 'exec') return renderSourceFromCommand(tool);
    const sessionId = tool.args?.sessionId;
    if (tool.name !== 'process' || tool.args?.action !== 'poll' || typeof sessionId !== 'string') return null;
    for (let cursor = 0; cursor < index; cursor += 1) {
      const launch = tools[cursor]!;
      if (launch.name !== 'exec' || typeof launch.result !== 'string') continue;
      if (/Command still running \(session ([^,\s)]+), pid [^)]*\)\./.exec(launch.result)?.[1] === sessionId)
        return renderSourceFromCommand(launch);
    }
    return null;
  };
  const cleanExitSessions = sessionsWithCleanExit(tools);
  /** 工具结果里**已被 receipt 认领**的那一条（认领判据与旧 `known` 一字不差）。 */
  const knownEntry = (tool: ToolCall): ToolSlideReceipt | null => {
    if (tool.status !== 'done' || typeof tool.result !== 'string' || tool.result.length > 2 * 1024 * 1024) return null;
    const report = reportFrom(tool, cleanExitSessions);
    if (!report) return null;
    return (
      entries.find(
        (entry) =>
          entry.receiptFile === report.receiptFile &&
          ['sourceSha256', 'fileName', 'outputSha256', 'bytes', 'pages'].every(
            (key) => report[key] === entry.receipt[key as keyof SlideGenerationReceipt],
          ),
      ) ?? null
    );
  };
  const known = (tool: ToolCall): boolean => {
    if (knownEntry(tool)) return true;
    if (tool.status !== 'done' || typeof tool.result !== 'string' || tool.result.length > 2 * 1024 * 1024) return false;
    const trailer =
      tool.name === 'exec'
        ? '\n\n(Command exited with code 1)'
        : tool.name === 'process' && tool.args?.action === 'poll'
          ? '\n\nProcess exited with code 1.'
          : '';
    if (!trailer || !tool.result.trim().endsWith(trailer)) return false;
    try {
      const value = parseSlidegenToolStream(tool.result.trim().slice(0, -trailer.length).trim())?.report;
      return (
        object(value) &&
        value.schemaVersion === 1 &&
        value.fileCreated === false &&
        value.artifactIndexed === false &&
        value.visualReview === 'not-performed' &&
        ['source-invalid', 'render-failed', 'runtime-unavailable'].includes(String(value.status))
      );
    } catch {
      return false;
    }
  };
  const looksLikeReport = (tool: ToolCall): boolean => {
    if (typeof tool.result !== 'string' || tool.result.length > 2 * 1024 * 1024) return false;
    const text = tool.result
      .trim()
      .replace(/\n\n(?:\(Command exited with code -?\d+\)|Process exited with code -?\d+\.)$/, '')
      .trim();
    try {
      const value = parseSlidegenToolStream(text)?.report;
      return (
        object(value) &&
        value.schemaVersion === 1 &&
        value.artifactIndexed === false &&
        value.visualReview === 'not-performed' &&
        'fileCreated' in value &&
        ['file-generated', 'source-invalid', 'render-failed', 'runtime-unavailable', 'output-unconfirmed'].includes(
          String(value.status),
        )
      );
    } catch {
      return false;
    }
  };
  /**
   * 「已被更晚的确认输出取代」（2026-10-05 真机：同一轮里多次 exec 生成脚本 —— 修引号/重渲染后
   * 更晚那次已有 receipt 认领，更早那次的中间报告没有凭据 ⇒ 整轮被判 `slidegen-output-unconfirmed`）。
   *
   * ⚠️ 只在**同一生成器命令**、**同一源文件**、更晚那次已被 receipt 认领时成立：
   *    - 取不到源文件（非 exec / 命令里没有源文件参数）⇒ 不成立（保持 fail-closed）；
   *    - 仍在跑 / 等人批准 ⇒ 不成立（那正是「先等它」，不能被取代掉）；
   *    - 不同源文件（如纠正稿另存 `xxx-v2.slidegen`）⇒ 不成立（谱系不同，见方案 §件② 反例）。
   */
  const superseded = (tool: ToolCall, index: number): boolean => {
    // ⭐ V1（2026-10-13）：`declared`（只有模型声明、未确认执行）与 running/awaitingApproval
    //    同类 —— 都是"未结束"，都不能被更晚的收据取代（见 `hasUnconfirmedSlideToolOutput`
    //    的调用方 `data-handlers` 的未认领输出判据）。
    if (tool.status === 'running' || tool.status === 'awaitingApproval' || tool.status === 'declared') return false;
    const source = renderSourceForAttempt(tool, index);
    if (!source) return false;
    return tools.some((later, laterIndex) => {
      if (laterIndex <= index) return false;
      const entry = knownEntry(later);
      if (entry === null) return false;
      if (normalizeSource(entry.receipt.sourceFile) === source) return true;
      // ⭐ native 直通流（2026-10-06 attempt02 真机）：receipt.sourceFile 是**暂存副本**
      //    `.royin-native-XXXX/source.json`，与生成命令里的工作区源文件参数（*.native-ppt.json）
      //    **永不相等** —— 只按 receipt.sourceFile 比对时，模型每一次引号/JSON 试错的失败 exec
      //    全部判"未认领"，整单毒化成 `slidegen-output-unconfirmed`（真机：13 页 pptx 已登记
      //    且可打开，交付却判 failed）。此时回退比对该次**已被 receipt 认领**的渲染命令里的源参数。
      //    取不到源参数（null）⇒ 不豁免（fail-closed）；更晚成功的是不同源文件（xxx-v2）⇒ 不豁免。
      return (
        entry.receipt.sourceFormat === 'native-template-v5' && renderSourceForAttempt(later, laterIndex) === source
      );
    });
  };
  const polls = new Map<string, boolean[]>();
  let characters = 0;
  for (const tool of tools) {
    characters += typeof tool.result === 'string' ? tool.result.length : 0;
    if (tool.name !== 'process' || tool.args?.action !== 'poll' || typeof tool.args.sessionId !== 'string') continue;
    // ⭐ 报告先到、退出后到（2026-10-06 真机 attempt01）：这次 poll 的尾巴还是
    //    `Process still running.`，但报告已被认领（`sessionsWithCleanExit` 已证实该会话后来
    //    干净退出）—— 它**就是**这次启动的认领凭据，必须计入；只有仍然无据的 running poll
    //    才继续"没有结论"。
    if (tool.result?.trim().endsWith('Process still running.') && !known(tool)) continue;
    // ⭐ 终局那次 poll 常常一个字都没有（`(no new output)` + `Process exited with code 0.`）。
    //    它**既不确认也不否定**这次启动 —— 报告已由更早那次 poll 认领。把它计成"未认领"
    //    会反过来毒化整次启动。⚠️ 只有**干净且无输出**的退出才算中性；带任何输出的退出照旧参与判定。
    if (/^\(no new output\)\s*Process exited with code 0\.$/.test(tool.result?.trim() ?? '')) continue;
    const outcomes = polls.get(tool.args.sessionId) ?? [];
    outcomes.push(known(tool));
    polls.set(tool.args.sessionId, outcomes);
  }
  if (characters > 8 * 1024 * 1024 || tools.length > 256) return tools.some(generationCommand);
  return tools.some((tool, index) => {
    if (tool.name !== 'exec' && !(tool.name === 'process' && tool.args?.action === 'poll')) return false;
    if (!generationCommand(tool) && !looksLikeReport(tool)) return false;
    if (known(tool)) return false;
    // ⭐ 更晚且已确认的同源渲染会取代更早的未认领报告（见 `superseded`）。
    if (superseded(tool, index)) return false;
    if (generationCommand(tool) && typeof tool.result === 'string') {
      const session = /Command still running \(session ([^,\s)]+), pid [^)]*\)\./.exec(tool.result)?.[1];
      const outcomes = session ? polls.get(session) : undefined;
      if (outcomes?.length && outcomes.every(Boolean)) return false;
    }
    return true;
  });
}

export function isToolSlideOutputCurrent(
  workspace: string,
  entries: readonly ToolSlideReceipt[],
  file: string,
  requirePptProof = false,
): boolean {
  const matching = entries.filter((entry) =>
    process.platform === 'win32'
      ? entry.receipt.fileName.toLowerCase() === file.toLowerCase()
      : entry.receipt.fileName === file,
  );
  if (requirePptProof && /\.pptx$/i.test(file) && !matching.length) return false;
  try {
    // ⚠️ 同上：每条按**它自己的目录**复核（跨根收据在助手工作区里读不到）。
    return matching.every(
      (entry) =>
        JSON.stringify(readSlideGenerationReceipt(entry.outputDir ?? workspace, entry.receiptFile)) ===
        JSON.stringify(entry.receipt),
    );
  } catch {
    return false;
  }
}
