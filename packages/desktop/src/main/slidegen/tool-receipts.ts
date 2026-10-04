import { createHash } from 'node:crypto';
import { parseSlidegenToolStream, type Message, type SlidegenWarning, type ToolCall } from '@clawwork/shared';
import { readSlideGenerationReceipt, type SlideGenerationReceipt } from './receipt.js';
import { readSlideSourceFile, readWorkspaceBytes } from './source-file.js';
import { extractSlidegenBlocks, type SlidegenDeck } from './blocks.js';

export interface ToolSlideReceipt {
  receiptFile: string;
  receipt: SlideGenerationReceipt;
  source: string;
}
type ToolMessage = Pick<Message, 'taskId' | 'sessionKey' | 'runId' | 'role' | 'toolCalls'>;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function reportFrom(tool: ToolCall): Record<string, unknown> | null {
  if (tool.status !== 'done' || typeof tool.result !== 'string' || tool.result.length > 2 * 1024 * 1024) return null;
  let result = tool.result.trim();
  if (tool.name === 'process' && tool.args?.action === 'poll') {
    const trailer = '\n\nProcess exited with code 0.';
    if (!result.endsWith(trailer)) return null;
    result = result.slice(0, -trailer.length).trim();
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
}): { receipts: ToolSlideReceipt[]; rejected: number } {
  const result: { receipts: ToolSlideReceipt[]; rejected: number } = { receipts: [], rejected: 0 };
  if (!input.runId || !input.taskId || !input.sessionKey) return result;
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
      const report = reportFrom(tool);
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
      const receipt = readSlideGenerationReceipt(input.workspacePath, file);
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
        const content =
          receipt.sourceFormat === 'native-template-v5'
            ? new TextDecoder('utf-8', { fatal: true }).decode(
                readWorkspaceBytes(input.workspacePath, receipt.sourceFile, 1024 * 1024),
              )
            : readSlideSourceFile(input.workspacePath, receipt.sourceFile);
        if (createHash('sha256').update(content).digest('hex') !== receipt.sourceSha256)
          throw new Error('tool-receipt-mismatch');
        if (receipt.sourceFormat === 'native-template-v5')
          result.receipts.push({ receiptFile: file, receipt, source: content });
        else {
          const { decks } = extractSlidegenBlocks(content);
          if (decks.length !== 1) throw new Error('tool-receipt-mismatch');
          result.receipts.push({ receiptFile: file, receipt, source: decks[0].source });
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
    const current = readSlideGenerationReceipt(workspace, entry.receiptFile);
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
  const known = (tool: ToolCall): boolean => {
    if (tool.status !== 'done' || typeof tool.result !== 'string' || tool.result.length > 2 * 1024 * 1024) return false;
    const report = reportFrom(tool);
    if (
      report &&
      entries.some(
        (entry) =>
          entry.receiptFile === report.receiptFile &&
          ['sourceSha256', 'fileName', 'outputSha256', 'bytes', 'pages'].every(
            (key) => report[key] === entry.receipt[key as keyof SlideGenerationReceipt],
          ),
      )
    )
      return true;
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
  const polls = new Map<string, boolean[]>();
  let characters = 0;
  for (const tool of tools) {
    characters += typeof tool.result === 'string' ? tool.result.length : 0;
    if (tool.name !== 'process' || tool.args?.action !== 'poll' || typeof tool.args.sessionId !== 'string') continue;
    if (tool.result?.trim().endsWith('Process still running.')) continue;
    const outcomes = polls.get(tool.args.sessionId) ?? [];
    outcomes.push(known(tool));
    polls.set(tool.args.sessionId, outcomes);
  }
  if (characters > 8 * 1024 * 1024 || tools.length > 256) return tools.some(generationCommand);
  return tools.some((tool) => {
    if (tool.name !== 'exec' && !(tool.name === 'process' && tool.args?.action === 'poll')) return false;
    if (!generationCommand(tool) && !looksLikeReport(tool)) return false;
    if (known(tool)) return false;
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
    return matching.every(
      (entry) =>
        JSON.stringify(readSlideGenerationReceipt(workspace, entry.receiptFile)) === JSON.stringify(entry.receipt),
    );
  } catch {
    return false;
  }
}
