import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readSlideGenerationReceipt, type SlideGenerationReceipt } from '../slidegen/receipt.js';
import { readWorkspaceBytes } from '../slidegen/source-file.js';
export interface NativeReviewPorts {
  render(receipt: SlideGenerationReceipt): Promise<string[]>;
  model: string;
  review(input: {
    outputSha256: string;
    revision: number;
    pages: Array<{ page: number; image: string; sha256: string }>;
  }): Promise<{
    callId: string;
    pages: Array<{ page: number; issues: Array<{ problem: string; suggestion: string }> }>;
  }>;
}
export interface NativeVisualReview {
  status: 'not-performed' | 'passed' | 'needs-revision' | 'failed' | 'canceled';
  reason?: string;
  model?: string;
  outputSha256?: string;
  revision?: number;
  callId?: string;
  images?: Array<{ page: number; image: string; sha256: string }>;
  pages?: Array<{ page: number; issues: Array<{ problem: string; suggestion: string }> }>;
}
export async function reviewNativePpt(
  workspace: string,
  receiptFile: string,
  ports?: NativeReviewPorts,
  isCurrent: () => boolean = () => true,
): Promise<NativeVisualReview> {
  let receipt: SlideGenerationReceipt | undefined;
  let result: NativeVisualReview;
  try {
    if (!isCurrent()) return { status: 'canceled' };
    receipt = readSlideGenerationReceipt(workspace, receiptFile);
    if (receipt.sourceFormat !== 'native-template-v5') throw Error('native-visual-source-invalid');
    const version = { outputSha256: receipt.outputSha256, revision: receipt.revision ?? 0 };
    if (!ports?.model) result = { ...version, status: 'not-performed', reason: 'visual-model-unconfigured' };
    else {
      const frames = await ports.render(receipt);
      if (!isCurrent()) return { ...version, status: 'canceled' };
      if (frames.length !== receipt.pages || new Set(frames).size !== frames.length)
        throw Error('native-visual-pages-missing');
      const images = frames.map((image, index) => {
        const bytes = readWorkspaceBytes(workspace, image, 16 * 1024 * 1024);
        if (
          bytes.length < 24 ||
          bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
          bytes.readUInt32BE(16) < 1200 ||
          bytes.readUInt32BE(20) < 675
        )
          throw Error('native-visual-image-too-small');
        return { page: index + 1, image, sha256: createHash('sha256').update(bytes).digest('hex') };
      });
      if (readSlideGenerationReceipt(workspace, receiptFile).outputSha256 !== receipt.outputSha256)
        throw Error('native-visual-version-changed');
      if (!isCurrent()) return { ...version, status: 'canceled' };
      const review = await ports.review({ ...version, pages: images });
      if (!isCurrent()) return { ...version, status: 'canceled', callId: review.callId };
      if (
        typeof review.callId !== 'string' ||
        !review.callId ||
        !Array.isArray(review.pages) ||
        review.pages.length !== receipt.pages ||
        review.pages.some(
          (p, i) =>
            p.page !== i + 1 ||
            !Array.isArray(p.issues) ||
            p.issues.length > 30 ||
            p.issues.some(
              (issue) =>
                typeof issue.problem !== 'string' ||
                !issue.problem ||
                issue.problem.length > 2000 ||
                typeof issue.suggestion !== 'string' ||
                !issue.suggestion ||
                issue.suggestion.length > 2000,
            ),
        )
      )
        throw Error('native-visual-review-incomplete');
      for (const image of images)
        if (
          createHash('sha256')
            .update(readWorkspaceBytes(workspace, image.image, 16 * 1024 * 1024))
            .digest('hex') !== image.sha256
        )
          throw Error('native-visual-image-changed');
      if (readSlideGenerationReceipt(workspace, receiptFile).outputSha256 !== receipt.outputSha256)
        throw Error('native-visual-version-changed');
      result = {
        ...version,
        model: ports.model,
        callId: review.callId,
        images,
        pages: review.pages,
        status: review.pages.some((page) => page.issues.length) ? 'needs-revision' : 'passed',
      };
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    result = {
      status: isCurrent() ? 'failed' : 'canceled',
      reason: /^native-|^visual-/.test(reason) ? reason : 'native-visual-unavailable',
      outputSha256: receipt?.outputSha256,
      revision: receipt?.revision,
    };
  }
  if (receipt && isCurrent()) {
    const folder = path.dirname(receipt.sourceFile);
    fs.writeFileSync(path.join(workspace, folder, `visual-review-${randomUUID()}.json`), JSON.stringify(result), {
      flag: 'wx',
    });
  }
  return result;
}
