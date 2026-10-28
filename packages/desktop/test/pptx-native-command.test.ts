import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderNativePptFile } from '../src/main/docgen/native-file';
import { readSlideGenerationReceipt } from '../src/main/slidegen/receipt';
import { collectToolSlideReceipts, isToolSlideOutputCurrent } from '../src/main/slidegen/tool-receipts';

const templatesRoot = join(import.meta.dirname, '../resources/pptx-templates');
const raw = {
  title: 'Native lifecycle',
  template: 'business-deck-v5',
  slides: [{ templateId: 'insight', data: { slide_title: 'Required', evidence_1: 'All required text' } }],
};
let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'native-ppt-lifecycle-'));
  writeFileSync(join(workspace, 'input.native-ppt.json'), JSON.stringify(raw));
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

describe('native command lifecycle and immutable versions', () => {
  it('requires current proof for controlled PPT registration after an unconfirmed tool result', () => {
    expect(isToolSlideOutputCurrent(workspace, [], 'unconfirmed.pptx', true)).toBe(false);
    expect(isToolSlideOutputCurrent(workspace, [], 'unrelated.txt', true)).toBe(true);
    expect(isToolSlideOutputCurrent(workspace, [], 'unconfirmed.pptx')).toBe(true);
  });
  it('does not run with the test switch disabled', async () => {
    const result = await renderNativePptFile('input.native-ppt.json', workspace, { templatesRoot });
    expect(result.status).toBe('source-invalid');
    expect(result.fileCreated).toBe(false);
  });
  it('returns a source-bound JSON syntax diagnostic without generating an output', async () => {
    const source = '{"template":"templateDeck","content":[{"texts":["A "B""]}]}';
    writeFileSync(join(workspace, 'input.native-ppt.json'), source);
    const result = await renderNativePptFile('input.native-ppt.json', workspace, { templatesRoot, enabled: true });
    expect(result.status).toBe('source-invalid');
    expect(result.fileCreated).toBe(false);
    expect(result.artifactIndexed).toBe(false);
    expect(result.sourceSha256).toBe(createHash('sha256').update(source).digest('hex'));
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'native-source-json-invalid', position: source.indexOf('B'), line: 1 }),
    ]);
    expect(result.receiptFile).toBeUndefined();
    expect(readFileSync(join(workspace, 'input.native-ppt.json'), 'utf8')).toBe(source);
  });
  it('locates malformed JSON across CRLF lines without claiming quality checks', async () => {
    const source = [
      '{',
      '  "template": "templateDeck",',
      '  "content": [',
      '    {"texts": ["before"]}',
      '    {"texts": ["after"]}',
      '  ]',
      '}',
    ].join('\r\n');
    writeFileSync(join(workspace, 'input.native-ppt.json'), source);
    const result = await renderNativePptFile('input.native-ppt.json', workspace, { templatesRoot, enabled: true });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'native-source-json-invalid', line: 5, column: 5 }),
    ]);
    expect(result.visualReview).toBe('not-performed');
    expect(result.officeReview).toBe('not-performed');
    expect(result.contentReview).toBeUndefined();
  });
  it('locates an incomplete JSON document at the end without repairing or discarding content', async () => {
    const source = '{"content":[';
    writeFileSync(join(workspace, 'input.native-ppt.json'), source);
    const result = await renderNativePptFile('input.native-ppt.json', workspace, { templatesRoot, enabled: true });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'native-source-json-invalid',
        position: source.length,
        line: 1,
        column: source.length + 1,
      }),
    ]);
    expect(result.fileCreated).toBe(false);
    expect(readFileSync(join(workspace, 'input.native-ppt.json'), 'utf8')).toBe(source);
  });
  it.each(['\n', '\r\n', '\r'])('locates a missing comma with line separator %j', async (separator) => {
    const source = ['{', '"x":1', '"y":2}'].join(separator);
    writeFileSync(join(workspace, 'input.native-ppt.json'), source);
    const result = await renderNativePptFile('input.native-ppt.json', workspace, { templatesRoot, enabled: true });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'native-source-json-invalid',
        position: source.indexOf('"y"'),
        line: 3,
        column: 1,
      }),
    ]);
    expect(result.fileCreated).toBe(false);
    expect(result.receiptFile).toBeUndefined();
    expect(readFileSync(join(workspace, 'input.native-ppt.json'), 'utf8')).toBe(source);
  });
  it.each(['position 9 x', 'unexpected end n'])('does not invent coordinates from quoted input %j', async (source) => {
    writeFileSync(join(workspace, 'input.native-ppt.json'), source);
    const result = await renderNativePptFile('input.native-ppt.json', workspace, { templatesRoot, enabled: true });
    const diagnostic = result.diagnostics?.[0];
    expect(diagnostic).toEqual(expect.objectContaining({ code: 'native-source-json-invalid' }));
    for (const field of ['position', 'line', 'column']) expect(diagnostic).not.toHaveProperty(field);
    expect(result.sourceSha256).toBe(createHash('sha256').update(source).digest('hex'));
    expect(result.fileCreated).toBe(false);
    expect(result.receiptFile).toBeUndefined();
    expect(readFileSync(join(workspace, 'input.native-ppt.json'), 'utf8')).toBe(source);
  });
  it('performs field coverage and binds the actual output without claiming visual or Office checks', async () => {
    const result = await renderNativePptFile('input.native-ppt.json', workspace, { templatesRoot, enabled: true });
    expect(result.status).toBe('file-generated');
    expect(result.contentReview).toBe('field-coverage-passed');
    expect(result.visualReview).toBe('not-performed');
    expect(result.officeReview).toBe('not-performed');
    expect(result.qualityStatus).toBe('needs-review');
    expect(result.artifactIndexed).toBe(false);
    const receipt = readSlideGenerationReceipt(workspace, result.receiptFile!);
    expect(receipt.sourceFormat).toBe('native-template-v5');
    expect(receipt.resources).toHaveLength(2);
    const output = join(workspace, result.fileName!);
    const changed = readFileSync(output);
    changed[changed.length - 1] ^= 1;
    writeFileSync(output, changed);
    expect(() => readSlideGenerationReceipt(workspace, result.receiptFile!)).toThrow('receipt-version-mismatch');
  });
  it('preserves previous source and output when the input is rewritten for a revision', async () => {
    const first = await renderNativePptFile('input.native-ppt.json', workspace, { templatesRoot, enabled: true });
    writeFileSync(join(workspace, 'input.native-ppt.json'), JSON.stringify({ ...raw, title: 'Revised title' }));
    const second = await renderNativePptFile('input.native-ppt.json', workspace, {
      templatesRoot,
      enabled: true,
      previous: first.receiptFile,
    });
    expect(second.status).toBe('file-generated');
    expect(second.revision).toBe(1);
    expect(second.previousOutputSha256).toBe(first.outputSha256);
    expect(second.fileName).not.toBe(first.fileName);
    expect(readSlideGenerationReceipt(workspace, first.receiptFile!).outputSha256).toBe(first.outputSha256);
  });
  it('allows further user revisions beyond two while still rejecting stale parents', async () => {
    const first = await renderNativePptFile('input.native-ppt.json', workspace, { templatesRoot, enabled: true });
    const second = await renderNativePptFile('input.native-ppt.json', workspace, {
      templatesRoot,
      enabled: true,
      previous: first.receiptFile,
    });
    const third = await renderNativePptFile('input.native-ppt.json', workspace, {
      templatesRoot,
      enabled: true,
      previous: second.receiptFile,
    });
    const blocked = await renderNativePptFile('input.native-ppt.json', workspace, {
      templatesRoot,
      enabled: true,
      previous: third.receiptFile,
    });
    expect(third.revision).toBe(2);
    expect(blocked.fileCreated).toBe(true);
    expect(blocked.revision).toBe(3);
    expect(readSlideGenerationReceipt(workspace, blocked.receiptFile!).outputSha256).toBe(blocked.outputSha256);
    writeFileSync(join(workspace, first.fileName!), 'stale');
    const stale = await renderNativePptFile('input.native-ppt.json', workspace, {
      templatesRoot,
      enabled: true,
      previous: first.receiptFile,
    });
    expect(stale.fileCreated).toBe(false);
  });
  it('stops before rendering and does not register an artifact', async () => {
    const result = await renderNativePptFile('input.native-ppt.json', workspace, {
      templatesRoot,
      enabled: true,
      isCurrent: () => false,
    });
    expect(result.status).toBe('source-invalid');
    expect(result.fileCreated).toBe(false);
    expect(result.artifactIndexed).toBe(false);
  });
  it('reports missing template resources without a fallback success', async () => {
    const result = await renderNativePptFile('input.native-ppt.json', workspace, {
      templatesRoot: join(workspace, 'missing'),
      enabled: true,
    });
    expect(result.fileCreated).toBe(false);
    expect(result.diagnostics).toEqual([{ code: 'native-template-unavailable' }]);
  });
  it('rejects changed numeric facts and invalidates checks after template mutation', async () => {
    writeFileSync(
      join(workspace, 'input.native-ppt.json'),
      JSON.stringify({
        ...raw,
        slides: [{ templateId: 'metrics', data: { slide_title: 'Results', label_1: 'Revenue', value_1: '405' } }],
      }),
    );
    const first = await renderNativePptFile('input.native-ppt.json', workspace, { templatesRoot, enabled: true });
    expect(first.status).toBe('file-generated');
    writeFileSync(
      join(workspace, 'input.native-ppt.json'),
      JSON.stringify({
        ...raw,
        slides: [{ templateId: 'metrics', data: { slide_title: 'Results', label_1: 'Revenue', value_1: '406' } }],
      }),
    );
    const changed = await renderNativePptFile('input.native-ppt.json', workspace, {
      templatesRoot,
      enabled: true,
      previous: first.receiptFile,
    });
    expect(changed.diagnostics).toEqual([{ code: 'native-revision-data-changed' }]);
    const receipt = readSlideGenerationReceipt(workspace, first.receiptFile!);
    const resource = join(workspace, receipt.resources[0].file),
      bytes = readFileSync(resource);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(resource, bytes);
    expect(() => readSlideGenerationReceipt(workspace, first.receiptFile!)).toThrow();
  });
  it('collects only completed native tools from this task/session/run and deduplicates callbacks', async () => {
    const result = await renderNativePptFile('input.native-ppt.json', workspace, { templatesRoot, enabled: true });
    const message = {
      role: 'assistant' as const,
      taskId: 'task-1',
      sessionKey: 'session-1',
      runId: 'run-1',
      toolCalls: [
        { id: 'exec-1', name: 'exec', status: 'done' as const, startedAt: '', result: JSON.stringify(result) },
      ],
    };
    const input = {
      workspacePath: workspace,
      taskId: 'task-1',
      sessionKey: 'session-1',
      runId: 'run-1',
      messages: [message, message],
      allowNative: true,
    };
    expect(collectToolSlideReceipts(input).receipts).toHaveLength(1);
    expect(collectToolSlideReceipts({ ...input, runId: 'other-run' }).receipts).toHaveLength(0);
    expect(collectToolSlideReceipts({ ...input, allowNative: false }).receipts).toHaveLength(0);
  });
  it('rejects revisions whose verified parent was not registered to this task', async () => {
    const first = await renderNativePptFile('input.native-ppt.json', workspace, { templatesRoot, enabled: true });
    const revised = await renderNativePptFile('input.native-ppt.json', workspace, {
      templatesRoot,
      enabled: true,
      previous: first.receiptFile,
    });
    const input = {
      workspacePath: workspace,
      taskId: 'task-1',
      sessionKey: 'session-1',
      runId: 'run-2',
      allowNative: true,
      messages: [
        {
          role: 'assistant' as const,
          taskId: 'task-1',
          sessionKey: 'session-1',
          runId: 'run-2',
          toolCalls: [
            { id: 'exec-2', name: 'exec', status: 'done' as const, startedAt: '', result: JSON.stringify(revised) },
          ],
        },
      ],
    };
    expect(collectToolSlideReceipts(input).rejected).toBe(1);
    expect(
      collectToolSlideReceipts({
        ...input,
        isNativeParentCurrent: (file, sha) => file === first.fileName && sha === first.outputSha256,
      }).receipts,
    ).toHaveLength(1);
  });
  it('accepts a parent proved in the same run even when the child tool is delivered first', async () => {
    const first = await renderNativePptFile('input.native-ppt.json', workspace, { templatesRoot, enabled: true });
    const revised = await renderNativePptFile('input.native-ppt.json', workspace, {
      templatesRoot,
      enabled: true,
      previous: first.receiptFile,
    });
    const message = (taskId: string, id: string, report: unknown) => ({
      role: 'assistant' as const,
      taskId,
      sessionKey: 'session-1',
      runId: 'run-1',
      toolCalls: [{ id, name: 'exec', status: 'done' as const, startedAt: '', result: JSON.stringify(report) }],
    });
    const input = {
      workspacePath: workspace,
      taskId: 'task-1',
      sessionKey: 'session-1',
      runId: 'run-1',
      allowNative: true,
      messages: [message('task-1', 'child', revised), message('task-1', 'parent', first)],
    };
    expect(collectToolSlideReceipts(input).receipts).toHaveLength(2);
    expect(
      collectToolSlideReceipts({ ...input, messages: [input.messages[0], message('foreign-task', 'parent', first)] })
        .rejected,
    ).toBe(1);
  });
});
