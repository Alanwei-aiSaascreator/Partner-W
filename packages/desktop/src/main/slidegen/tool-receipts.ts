import { createHash } from 'node:crypto';
import type { Message, SlidegenWarning, ToolCall } from '@clawwork/shared';
import { readSlideGenerationReceipt, type SlideGenerationReceipt } from './receipt.js';
import { readSlideSourceFile } from './source-file.js';
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
    const report: unknown = JSON.parse(result);
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
      for (const key of ['sourceSha256', 'fileName', 'outputSha256', 'bytes', 'pages'] as const) {
        if (report[key] !== receipt[key]) throw new Error('tool-receipt-mismatch');
      }
      if (!seen.has(file)) {
        const content = readSlideSourceFile(input.workspacePath, receipt.sourceFile);
        if (createHash('sha256').update(content).digest('hex') !== receipt.sourceSha256)
          throw new Error('tool-receipt-mismatch');
        const { decks } = extractSlidegenBlocks(content);
        if (decks.length !== 1) throw new Error('tool-receipt-mismatch');
        result.receipts.push({ receiptFile: file, receipt, source: decks[0].source });
        seen.add(file);
      }
    } catch {
      result.rejected++;
    }
  }
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
