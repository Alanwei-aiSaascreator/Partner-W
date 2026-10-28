/**
 * 冷启动开场片：主进程侧的资源定位与自定义协议。
 *
 * 渲染层沙箱（sandbox:true、无 fs、拿不到 resourcesPath）拿不到真机文件，
 * 所以走与 `clawwork-avatar` 同一形状的自定义协议：渲染层只认固定 URL 字符串
 * （`clawwork-asset://media/opening.mp4`），dev/packaged 的路径解析都收敛在这里。
 *
 * ⚠️ 协议通道只放行**一个文件名**（白名单式，见 `resolveOpeningAssetRequest`）；
 *    真机现场把 `<resources>/media/opening.mp4` 删掉/改名 = 协议 404 →
 *    渲染层走兜底链（视频层卸载、吉祥物独占），与无素材的现状逐字一致。
 */
import { protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { OPENING_MEDIA_DIR_NAME, OPENING_MEDIA_SCHEME, OPENING_VIDEO_FILE_NAME } from '@clawwork/shared';

/** 纯函数，形状照抄 `docgen/pptx-template/locate.ts` 与 `runtime/locate.ts`。 */
export function resolveOpeningMediaRoot(opts: {
  isPackaged: boolean;
  resourcesPath?: string;
  appPath?: string;
}): string | undefined {
  if (opts.isPackaged) {
    return opts.resourcesPath ? path.join(opts.resourcesPath, OPENING_MEDIA_DIR_NAME) : undefined;
  }
  return opts.appPath ? path.join(opts.appPath, 'resources', OPENING_MEDIA_DIR_NAME) : undefined;
}

const ALLOWED_PATHNAME = `/${OPENING_VIDEO_FILE_NAME}`;

/**
 * 纯函数：URL → 允许的绝对路径；白名单式，非白名单一律 null。
 *
 * 只接受 `${scheme}://${dir}/${file}` 这一个形状 —— host 大小写不敏感
 * （Windows 文件系统语义），pathname 先 decodeURIComponent 再与白名单比，
 * 比较前统一切小写；任何 `..`、反斜杠、绝对路径、其它文件名都无法通过
 * 全量字符串相等判定。
 */
export function resolveOpeningAssetRequest(url: string, root: string): string | null {
  // 字符串级预检：任何点段/反斜杠（含百分号编码形式）直接拒绝。
  // 即便 URL 解析器会把 `..` 规整掉、最终路径也只会是常量文件名，这层是
  // "白名单以外的一切都不解释"的显式声明。
  if (/\.\.|%2e|\\\\|%5c/i.test(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${OPENING_MEDIA_SCHEME}:`) return null;
  if (parsed.hostname.toLowerCase() !== OPENING_MEDIA_DIR_NAME) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  if (pathname.toLowerCase() !== ALLOWED_PATHNAME) return null;
  return path.join(root, OPENING_VIDEO_FILE_NAME);
}

/**
 * 注册协议（必须在 app.whenReady 之后调用；特权声明在 `main/index.ts` 提前完成）。
 *
 * ⚠️ 响应体走**全量 buffer + 显式头**，不走 `net.fetch(file://)` 透传：
 *    真机实测（pre6c，2026-10-06）`net.fetch` 的流式响应喂给媒体栈会直接
 *    `MEDIA_ELEMENT_ERROR: Format error`（code 4），而同一文件装进 Blob 播放
 *    正常（1920×1080 canplay）——即"文件没问题、响应形状的问题"。
 *    这正是施工图 §3.1 预留的退路：20MB 全量读入对单窗口一次加载完全可接受
 *    （循环期间复用同一份缓冲）。显式 `Content-Type` + `Content-Length`，
 *    不声称 Range（媒体栈收到 200 全量即可播）。
 */
export function registerOpeningMediaProtocol(opts: {
  isPackaged: boolean;
  resourcesPath?: string;
  appPath?: string;
}): void {
  protocol.handle(OPENING_MEDIA_SCHEME, async (request) => {
    const root = resolveOpeningMediaRoot(opts);
    if (!root) return new Response('not found', { status: 404 });
    const file = resolveOpeningAssetRequest(request.url, root);
    if (!file) return new Response('not found', { status: 404 });
    try {
      const buffer = await readFile(file);
      return new Response(buffer, {
        status: 200,
        headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(buffer.byteLength) },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}
