import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { renderNativePptFile } from '../src/main/docgen/native-file';
import { reviewNativePpt, type NativeReviewPorts } from '../src/main/docgen/native-review';
let workspace: string;
let receiptFile: string;
beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'native-final-review-'));
  writeFileSync(
    join(workspace, 'deck.native-ppt.json'),
    JSON.stringify({
      title: 'Review',
      template: 'business-deck-v5',
      slides: [
        { templateId: 'insight', data: { slide_title: 'First', evidence_1: 'Required facts' } },
        { templateId: 'insight', data: { slide_title: 'Second', evidence_1: 'Required facts two' } },
      ],
    }),
  );
  receiptFile = (
    await renderNativePptFile('deck.native-ppt.json', workspace, {
      enabled: true,
      templatesRoot: join(import.meta.dirname, '../resources/pptx-templates'),
    })
  ).receiptFile!;
  const header = Buffer.alloc(32);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(header);
  header.writeUInt32BE(1600, 16);
  header.writeUInt32BE(900, 20);
  writeFileSync(join(workspace, 'page-1.png'), header);
  writeFileSync(join(workspace, 'page-2.png'), header);
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));
function ports(): NativeReviewPorts {
  return {
    model: 'authorized-fixture-vision',
    render: async () => ['page-1.png', 'page-2.png'],
    review: vi.fn(async (input: Parameters<NativeReviewPorts['review']>[0]) => ({
      callId: 'actual-review-call',
      pages: input.pages.map((p) => ({ page: p.page, issues: [] })),
    })),
  };
}
it('sends every final-PPTX-bound page image with version and hash to the review adapter', async () => {
  const p = ports();
  const result = await reviewNativePpt(workspace, receiptFile, p);
  expect(result.status).toBe('passed');
  expect(p.review).toHaveBeenCalledWith(
    expect.objectContaining({
      revision: 0,
      outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      pages: [
        expect.objectContaining({ page: 1, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        expect.objectContaining({ page: 2, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      ],
    }),
  );
});
it('does not pass a review that omits a page or repeats a page', async () => {
  const p = ports();
  p.review = async () => ({ callId: 'review-1', pages: [{ page: 1, issues: [] }] });
  expect((await reviewNativePpt(workspace, receiptFile, p)).status).toBe('failed');
});
it('keeps problems and their page numbers instead of converting them to success', async () => {
  const p = ports();
  p.review = async () => ({
    callId: 'review-2',
    pages: [
      { page: 1, issues: [] },
      { page: 2, issues: [{ problem: 'Text overflows', suggestion: 'Split the evidence into another page' }] },
    ],
  });
  expect((await reviewNativePpt(workspace, receiptFile, p)).status).toBe('needs-revision');
});
it('makes no review call after stop and does not resurrect on a late reply', async () => {
  const p = ports();
  expect((await reviewNativePpt(workspace, receiptFile, p, () => false)).status).toBe('canceled');
  expect(p.review).not.toHaveBeenCalled();
  let active = true;
  p.review = async (input) => {
    active = false;
    return { callId: 'late', pages: input.pages.map((p) => ({ page: p.page, issues: [] })) };
  };
  expect((await reviewNativePpt(workspace, receiptFile, p, () => active)).status).toBe('canceled');
});
it('records unavailable visual capability as not performed', async () => {
  expect((await reviewNativePpt(workspace, receiptFile)).status).toBe('not-performed');
});
