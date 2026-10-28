import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 「图生视频」的图片来源（2026-10-17）。
 *
 * 产品语义：用户在本轮发了一张图 + 让助手做视频 ⇒ 这张图就是首帧。
 *
 * 为什么要在这里存一次：
 *   · 视频请求发生在**消息收尾**（主进程解析 `videogen` 围栏）时，那一刻渲染层已经
 *     不在调用栈上，拿不到附件；
 *   · 网关会把附件落到自己的 `media/inbound`，但那是内核的目录、不是我们的契约。
 *     ⇒ 在**发送那一刻**（`ws:send-message` 确实带着 base64）把图存进自己的目录，
 *       生成时把**绝对路径**交给 `firstFrame`，由 `reference-image.ts` 复验后取字节。
 *
 * 纪律：
 *   · 只记**最后一张**、只记图片、有 TTL；超过 12MB 的图不记（首帧读入也有上限）；
 *   · 文件落在 `<userData>/videogen-refs`，路径会作为 `authorizedAttachmentPaths`
 *     显式交给读取器 —— 不是"工作区里随便什么文件都能当首帧"。
 */
export interface SessionImage {
  mimeType: 'image/png' | 'image/jpeg';
  /** base64（不含 data: 前缀）。 */
  content: string;
  at: number;
}

const TTL_MS = 30 * 60_000;
const MAX_BASE64_BYTES = 12 * 1024 * 1024;

const lastImageBySession = new Map<string, SessionImage>();

function imageMime(value: unknown): 'image/png' | 'image/jpeg' | null {
  if (typeof value !== 'string') return null;
  const mime = value.toLowerCase();
  if (mime === 'image/png') return 'image/png';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'image/jpeg';
  return null;
}

/** 从一次发送的附件里挑**第一张**图记住；没有图就清掉旧的那张（避免上一轮的图串到这一轮）。 */
export function rememberSessionImage(
  sessionKey: string,
  attachments: readonly { mimeType?: unknown; content?: unknown }[] | undefined,
): void {
  if (!sessionKey) return;
  const image = (attachments ?? []).find(
    (attachment) => imageMime(attachment?.mimeType) && typeof attachment?.content === 'string',
  );
  if (!image) {
    lastImageBySession.delete(sessionKey);
    return;
  }
  const mimeType = imageMime(image.mimeType);
  const content = typeof image.content === 'string' ? image.content : '';
  if (!mimeType || !content || content.length > MAX_BASE64_BYTES) {
    lastImageBySession.delete(sessionKey);
    return;
  }
  lastImageBySession.set(sessionKey, { mimeType, content, at: Date.now() });
}

/** 取这一轮（TTL 内）的图；过期即丢弃。 */
export function takeSessionImage(sessionKey: string, now: number = Date.now()): SessionImage | null {
  const image = lastImageBySession.get(sessionKey);
  if (!image) return null;
  if (now - image.at > TTL_MS) {
    lastImageBySession.delete(sessionKey);
    return null;
  }
  return image;
}

/**
 * 把图写到 `<userData>/videogen-refs/<sha>.<ext>`，返回绝对路径。
 * 内容寻址 ⇒ 同一张图重复使用不会堆文件；写失败返回 null（调用方退回文生视频）。
 */
export function materializeSessionImage(userDataDir: string, image: SessionImage): string | null {
  try {
    const bytes = Buffer.from(image.content, 'base64');
    if (bytes.length === 0) return null;
    const digest = createHash('sha256').update(bytes).digest('hex');
    const dir = path.join(userDataDir, 'videogen-refs');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${digest}.${image.mimeType === 'image/png' ? 'png' : 'jpg'}`);
    writeFileSync(file, bytes);
    return file;
  } catch {
    return null;
  }
}

/** 测试用：清空进程内记忆。 */
export function resetSessionImages(): void {
  lastImageBySession.clear();
}
