import { BrowserWindow } from 'electron';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { extname, resolve, sep } from 'path';
import { extractImagesFromMarkdown, extractCodeBlocksFromMarkdown } from './extract.js';
import { saveArtifactFromBuffer } from './save.js';
import { isUniqueArtifactError } from './unique-error.js';
import { notifyArtifactActivity, type ArtifactActivityCallback } from './activity-callback.js';
import { getDb } from '../db/index.js';
import { getWorkspacePath } from '../workspace/config.js';
import { artifacts } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { safeFetch } from '../net/safe-fetch.js';
import { readOpenClawMediaFile } from '../media/resolve.js';
import type { Artifact, ArtifactDeliveryFailure, MessageAttachment } from '@clawwork/shared';

interface AutoExtractParams {
  workspacePath: string;
  taskId: string;
  messageId: string;
  content: string;
  attachments?: MessageAttachment[];
  gatewayHttpBase?: string;
  resolveMediaDownload?: (attachment: MessageAttachment) => Promise<string | null>;
  onActivity?: ArtifactActivityCallback;
}

const DATA_IMAGE_RE = /^data:(image\/(?:png|jpe?g|gif|webp|avif));base64,(.+)$/i;
interface AutoExtractResult {
  mediaFailures: NonNullable<ArtifactDeliveryFailure['mediaFailures']>;
  savedMediaSourceKeys?: string[];
  failedMediaSourceKeys?: string[];
}

const extractionByMessage = new Map<string, { signature: string; job: Promise<AutoExtractResult> }>();

type ExistingArtifact = Pick<Artifact, 'name' | 'type' | 'size' | 'contentText' | 'sourceKey'>;

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function sourceKey(kind: string, value: string): string {
  return `${kind}:${hashText(value)}`;
}

/**
 * "老行去重"用的类型家族（BUG-120，2026-10-17）。
 *
 * 视频在 2026-10-17 之前登记成 `'file'` —— 库里可能躺着这类旧行。若直接拿
 * `artifact.type !== input.artifactType` 比，改型后新来的 `'video'` 与旧行的 `'file'`
 * 对不上 ⇒ 同一份片子被**重复登记**，用户成果列表里冒出两条。
 * 二者本就是同一个存储家族（都是"文件类"），判据跨它们成立。
 */
function dedupeType(type: string): 'file' | 'image' | 'code' {
  return type === 'video' ? 'file' : (type as 'file' | 'image' | 'code');
}

function canonicalSavedName(name: string): string {
  return name.replace(/-[0-9a-f]{8}(\.[^.]+)$/i, '$1');
}

function extFromMime(mimeType: string | undefined): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/gif') return 'gif';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/avif') return 'avif';
  if (mimeType === 'video/mp4') return 'mp4';
  if (mimeType === 'video/webm') return 'webm';
  return 'png';
}

function safeMediaFileName(fileName: string | undefined, mimeType: string | undefined): string {
  const ext = extFromMime(mimeType);
  const raw = fileName?.trim() || `image.${ext}`;
  const clean = raw.replace(/[/\\]/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_');
  if (mimeType === 'video/mp4' || mimeType === 'video/webm') {
    return clean.toLowerCase().endsWith(`.${ext}`) ? clean : `${clean}.${ext}`;
  }
  if (/\.(png|jpe?g|gif|webp|avif)$/i.test(clean)) return clean;
  return `${clean || 'image'}.${ext}`;
}

async function readAttachmentMedia(
  attachment: MessageAttachment,
  trustedOrigin?: string,
  resolveMediaDownload?: AutoExtractParams['resolveMediaDownload'],
  onActivity?: ArtifactActivityCallback,
): Promise<Buffer | null> {
  if (attachment.artifactId && (attachment.mimeType === 'video/mp4' || attachment.mimeType === 'video/webm')) {
    const downloadUrl = await resolveMediaDownload?.(attachment);
    if (!downloadUrl) return null;
    notifyArtifactActivity(onActivity, 'downloading-media');
    return safeFetch(downloadUrl, { trustedOrigin, maxSize: 25 * 1024 * 1024 });
  }
  if (attachment.sourcePath) {
    const base64 = await readOpenClawMediaFile(attachment.sourcePath);
    return base64 ? Buffer.from(base64, 'base64') : null;
  }

  const dataMatch = attachment.dataUrl.match(DATA_IMAGE_RE);
  if (dataMatch) return Buffer.from(dataMatch[2], 'base64');

  if (/^https?:\/\//i.test(attachment.dataUrl)) {
    const isVideo = attachment.mimeType === 'video/mp4' || attachment.mimeType === 'video/webm';
    notifyArtifactActivity(onActivity, 'downloading-media');
    return safeFetch(attachment.dataUrl, { trustedOrigin, ...(isVideo ? { maxSize: 25 * 1024 * 1024 } : {}) });
  }

  return null;
}

async function doAutoExtractArtifacts(params: AutoExtractParams): Promise<AutoExtractResult> {
  const { workspacePath, taskId, messageId, content, attachments = [], gatewayHttpBase, resolveMediaDownload } = params;

  const db = getDb();
  const ownsWorkspace = (): boolean => getDb() === db && getWorkspacePath() === workspacePath;
  if (!ownsWorkspace()) return { mediaFailures: [] };
  const existingForMsg = db.select().from(artifacts).where(eq(artifacts.messageId, messageId)).all();
  const existing = existingForMsg as ExistingArtifact[];
  const existingSourceKeys = new Set(existing.map((artifact) => artifact.sourceKey).filter(Boolean));

  const images = extractImagesFromMarkdown(content);
  const codeBlocks = extractCodeBlocksFromMarkdown(content);

  const saved: Artifact[] = [];
  const mediaFailures: AutoExtractResult['mediaFailures'] = [];
  const savedMediaSourceKeys: string[] = [];
  const failedMediaSourceKeys: string[] = [];

  async function saveExtracted(input: {
    fileName: string;
    buffer: Buffer;
    artifactType: 'image' | 'code' | 'file' | 'video';
    sourceKey: string;
    contentText?: string;
  }): Promise<void> {
    if (!ownsWorkspace()) return;
    if (existingSourceKeys.has(input.sourceKey)) return;

    const canonicalName = canonicalSavedName(input.fileName);
    const legacyDuplicate = existing.some((artifact) => {
      if (artifact.sourceKey || dedupeType(artifact.type) !== dedupeType(input.artifactType)) return false;
      if (canonicalSavedName(artifact.name) !== canonicalName || artifact.size !== input.buffer.length) return false;
      if (input.artifactType === 'code') return artifact.contentText === input.contentText;
      return true;
    });
    if (legacyDuplicate) {
      existingSourceKeys.add(input.sourceKey);
      return;
    }

    try {
      notifyArtifactActivity(params.onActivity, 'saving-artifacts');
      const artifact = await saveArtifactFromBuffer({
        workspacePath,
        taskId,
        messageId,
        fileName: input.fileName,
        buffer: input.buffer,
        artifactType: input.artifactType,
        contentText: input.contentText,
        sourceKey: input.sourceKey,
      });
      existingSourceKeys.add(input.sourceKey);
      existing.push(artifact);
      saved.push(artifact);
    } catch (err) {
      if (isUniqueArtifactError(err)) {
        existingSourceKeys.add(input.sourceKey);
        return;
      }
      throw err;
    }
  }

  for (const img of images) {
    try {
      const key = sourceKey('markdown-image', img.src);
      if (existingSourceKeys.has(key)) continue;
      let buffer: Buffer;
      if (img.isRemote) {
        notifyArtifactActivity(params.onActivity, 'downloading-media');
        buffer = await safeFetch(img.src);
      } else if (img.src.startsWith('clawwork-media://')) {
        const filePath = resolve(img.src.replace('clawwork-media://', ''));
        if (!filePath.startsWith(resolve(workspacePath) + sep)) continue;
        buffer = readFileSync(filePath);
      } else {
        continue;
      }
      let ext = 'png';
      try {
        const pathname = new URL(img.src).pathname;
        const parsed = extname(pathname).toLowerCase().replace('.', '');
        if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg'].includes(parsed)) ext = parsed;
      } catch {
        ext = 'png';
      }
      const fileName = img.alt ? `${img.alt.replace(/[^a-zA-Z0-9_-]/g, '_')}.${ext}` : `image.${ext}`;
      await saveExtracted({
        fileName,
        buffer,
        artifactType: 'image',
        sourceKey: key,
      });
    } catch (err) {
      console.error('[auto-extract] image save failed:', err);
    }
  }

  for (const attachment of attachments) {
    const isVideo = attachment.mimeType === 'video/mp4' || attachment.mimeType === 'video/webm';
    const recordVideoFailure = (): void => {
      const key = sourceKey('attachment', attachment.sourcePath ?? attachment.dataUrl);
      if (!failedMediaSourceKeys.includes(key)) failedMediaSourceKeys.push(key);
      const fileName =
        attachment.fileName?.replaceAll('\\', '/').split('/').at(-1)?.trim() ||
        `video.${extFromMime(attachment.mimeType)}`;
      if (!mediaFailures.some((failure) => failure.fileName === fileName)) {
        mediaFailures.push({ fileName, reason: 'unavailable' });
      }
    };
    try {
      if (!attachment.dataUrl && !attachment.sourcePath) continue;
      if (attachment.mimeType && !attachment.mimeType.startsWith('image/') && !isVideo) continue;
      const key = sourceKey('attachment', attachment.sourcePath ?? attachment.dataUrl);
      if (existingSourceKeys.has(key)) continue;
      const buffer = await readAttachmentMedia(attachment, gatewayHttpBase, resolveMediaDownload, params.onActivity);
      if (!buffer) {
        if (isVideo) recordVideoFailure();
        continue;
      }
      const fileName = safeMediaFileName(attachment.fileName, attachment.mimeType);
      const previousSaved = saved.length;
      await saveExtracted({
        fileName,
        buffer,
        // BUG-120（2026-10-17）：视频附件记 `'video'`，不再借 `'file'`（此前与 docx/pptx 同档）。
        artifactType: isVideo ? 'video' : 'image',
        sourceKey: key,
      });
      if (isVideo && saved.length > previousSaved) savedMediaSourceKeys.push(key);
    } catch (err) {
      if (isVideo) recordVideoFailure();
      else console.error('[auto-extract] attachment media save failed:', err);
    }
  }

  for (const block of codeBlocks) {
    try {
      const key = sourceKey('code', `${block.fileName}\0${block.content}`);
      if (existingSourceKeys.has(key)) continue;
      await saveExtracted({
        fileName: block.fileName,
        buffer: Buffer.from(block.content, 'utf-8'),
        artifactType: 'code',
        contentText: block.content,
        sourceKey: key,
      });
    } catch (err) {
      console.error('[auto-extract] code block save failed:', err);
    }
  }

  if (!ownsWorkspace()) return { mediaFailures: [] };
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    for (const artifact of saved) {
      win.webContents.send('artifact:saved', artifact);
    }
  }
  return {
    mediaFailures,
    ...(savedMediaSourceKeys.length ? { savedMediaSourceKeys } : {}),
    ...(failedMediaSourceKeys.length ? { failedMediaSourceKeys } : {}),
  };
}

export async function autoExtractArtifacts(params: AutoExtractParams): Promise<AutoExtractResult> {
  const key = `${params.taskId}:${params.messageId}`;
  const signature = JSON.stringify([params.workspacePath, params.content, params.attachments, params.gatewayHttpBase]);
  const active = extractionByMessage.get(key);
  if (active) {
    if (active.signature === signature) return active.job;
    await active.job.catch(() => undefined);
    return autoExtractArtifacts(params);
  }

  const job = doAutoExtractArtifacts(params).finally(() => {
    if (extractionByMessage.get(key)?.job === job) extractionByMessage.delete(key);
  });
  extractionByMessage.set(key, { signature, job });
  return job;
}
