import { createHash } from 'node:crypto';
import type { Artifact } from '@clawwork/shared';
import { saveArtifactFromBuffer } from '../artifact/save.js';
import { captureArtifactWorkspaceOwner } from '../artifact/workspace-owner.js';
import { notifyArtifactActivity, type ArtifactActivityCallback } from '../artifact/activity-callback.js';
import { imagegenOperationKey, findImagegenRequestId, resolveImagegenRequestId } from './request-identity.js';
import { extractImagegenBlocks, type ImagegenFailure } from './request.js';
import type { ImagegenRelayClient } from './client.js';
import { findImagegenReplay, publishImagegenArtifact } from './replay.js';
import { verifyImagegenBuffer } from './verify.js';
/** 排队重试间隔（毫秒）：1–30 秒，缺省 6 秒。 */
function retryDelayMs(seconds: number | undefined): number {
  return (
    (Number.isFinite(seconds) && (seconds as number) > 0
      ? Math.min(Math.max(Math.ceil(seconds as number), 1), 30)
      : 6) * 1000
  );
}
export interface ImagegenGenerateInput {
  workspacePath: string;
  authScope: string;
  authCurrent?: () => boolean;
  taskId: string;
  messageId: string;
  content: string;
  client: ImagegenRelayClient;
  onActivity?: ArtifactActivityCallback;
  sleep?: (ms: number) => Promise<void>;
  maxPolls?: number;
}
export async function generateImagesFromMessage(
  input: ImagegenGenerateInput,
): Promise<{ saved: Artifact[]; failed: ImagegenFailure[] }> {
  const parsed = extractImagegenBlocks(input.content),
    saved: Artifact[] = [],
    failed = [...parsed.failures];
  const owner = captureArtifactWorkspaceOwner();
  const current = () => owner.current() && (input.authCurrent?.() ?? true);
  for (const request of parsed.requests) {
    try {
      const sourceKey = `imagegen:${imagegenOperationKey({ taskId: input.taskId, authScope: input.authScope, request })}:${createHash(
        'sha256',
      )
        .update(JSON.stringify([request.model, request.prompt, request.size]))
        .digest('hex')
        .slice(0, 16)}`;
      if (!current()) {
        failed.push({ code: 'imagegen-workspace-changed' });
        continue;
      }
      const replayInput = { taskId: input.taskId, sourceKey, workspacePath: input.workspacePath, size: request.size };
      const replay = await findImagegenReplay(replayInput);
      if (!current()) {
        failed.push({ code: 'imagegen-workspace-changed' });
        continue;
      }
      if (replay) {
        saved.push(replay);
        continue;
      }
      if (!current()) {
        failed.push({ code: 'imagegen-workspace-changed' });
        continue;
      }
      const identity = { taskId: input.taskId, authScope: input.authScope, request };
      let requestId = findImagegenRequestId(identity);
      const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      const deadline = Date.now() + 6 * 60_000;
      notifyArtifactActivity(input.onActivity, 'generating-image');
      if (!requestId) {
        if (!(await input.client.capabilities(request.size))) {
          failed.push({ code: 'imagegen-unavailable' });
          continue;
        }
        if (!current()) {
          failed.push({ code: 'imagegen-workspace-changed' });
          continue;
        }
        // Capability lookup yielded: another message may already have claimed this operation.
        requestId = findImagegenRequestId(identity);
        if (!requestId) {
          requestId = resolveImagegenRequestId(identity);
          // 上游排队时**不报错**：等一会儿用同一个 requestId 再来一次。
          // claim 是幂等的（同一个 requestId 不会重复建单，也不会重复扣费）。
          let giveUp = false;
          for (;;) {
            const created = await input.client.create(request, requestId);
            if (!created.ok) {
              failed.push({ code: created.code });
              giveUp = true;
              break;
            }
            if (!created.queued) break;
            if (!current()) {
              failed.push({ code: 'imagegen-workspace-changed' });
              giveUp = true;
              break;
            }
            const waitMs = retryDelayMs(created.retryAfterSeconds);
            if (Date.now() + waitMs >= deadline) {
              failed.push({ code: 'imagegen-result-unconfirmed' });
              giveUp = true;
              break;
            }
            await sleep(waitMs);
          }
          if (giveUp) continue;
        }
      }
      let complete = false;
      const polls = Math.max(1, Math.min(input.maxPolls ?? 90, 90));
      for (let poll = 0; poll < polls; poll++) {
        if (!current() || Date.now() >= deadline) break;
        const state = await input.client.query(requestId);
        if (state.status === 'finished') {
          complete = true;
          break;
        }
        if (state.status === 'failed') {
          failed.push({ code: state.code });
          break;
        }
        // queued 与 running 一样继续等；排队时按服务端建议的间隔轮询，避免空转。
        await sleep(state.status === 'queued' ? retryDelayMs(state.retryAfterSeconds) : 3000);
      }
      if (!complete) {
        if (failed.length === 0)
          failed.push({ code: current() ? 'imagegen-result-unconfirmed' : 'imagegen-workspace-changed' });
        continue;
      }
      if (!current()) {
        failed.push({ code: 'imagegen-workspace-changed' });
        continue;
      }
      notifyArtifactActivity(input.onActivity, 'downloading-media');
      const downloaded = await input.client.download(requestId);
      if (!downloaded.ok) {
        failed.push({ code: downloaded.code });
        continue;
      }
      const bytes = downloaded.bytes;
      if (!verifyImagegenBuffer(bytes, request.size)) {
        failed.push({ code: 'imagegen-image-invalid' });
        continue;
      }
      if (!current()) {
        failed.push({ code: 'imagegen-workspace-changed' });
        continue;
      }
      owner.assertCurrent();
      notifyArtifactActivity(input.onActivity, 'saving-artifacts');
      const artifact = await publishImagegenArtifact(`${input.workspacePath}:${sourceKey}`, async () => {
        const existing = await findImagegenReplay(replayInput);
        if (!current()) throw new Error('imagegen-workspace-changed');
        if (existing) return existing;
        return saveArtifactFromBuffer({
          workspacePath: input.workspacePath,
          taskId: input.taskId,
          messageId: input.messageId,
          fileName: `image-${createHash('sha256').update(sourceKey).digest('hex').slice(0, 16)}.png`,
          buffer: bytes,
          artifactType: 'image',
          sourceKey,
        });
      });
      saved.push(artifact);
    } catch (error) {
      failed.push({
        code:
          error instanceof Error && error.message === 'imagegen-image-invalid'
            ? 'imagegen-image-invalid'
            : error instanceof Error && error.message === 'imagegen-request-conflict'
              ? 'imagegen-block-invalid'
              : current()
                ? 'imagegen-save-failed'
                : 'imagegen-workspace-changed',
      });
    }
  }
  return { saved, failed };
}
