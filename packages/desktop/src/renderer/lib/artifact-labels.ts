import type { Artifact } from '@clawwork/shared';

export type ArtifactKindFilter = 'all' | 'image' | 'code' | 'file' | 'other';

type Translate = (key: string) => string;

function normalizedName(artifact: Pick<Artifact, 'name'>): string {
  return artifact.name.toLowerCase();
}

export function getArtifactKindFilter(artifact: Pick<Artifact, 'type' | 'mimeType' | 'name'>): ArtifactKindFilter {
  if (artifact.type === 'image' || artifact.mimeType.startsWith('image/')) return 'image';
  if (artifact.type === 'code') return 'code';
  // ⚠️ BUG-120（2026-10-17）：视频有了专属类型 `'video'`，但**筛选档不许跟着分家** ——
  //    改型前视频就是 `'file'`，用户是在「文件」里找它的；分出去会让老用户的视频"消失"
  //    （`FileBrowser` 的客户端筛选与主进程 SQL 的 `kind='file'` 都读这一口径）。
  if (artifact.type === 'file' || artifact.type === 'video') return 'file';
  return 'other';
}

function getArtifactLabelKey(artifact: Pick<Artifact, 'type' | 'mimeType' | 'name'>): string {
  const name = normalizedName(artifact);
  if (artifact.type === 'image' || artifact.mimeType.startsWith('image/')) return 'artifactKinds.image';
  if (artifact.type === 'code') return 'artifactKinds.code';
  if (artifact.type === 'link') return 'artifactKinds.link';
  if (artifact.type === 'structured_data') return 'artifactKinds.data';
  // BUG-120：类型标签要跟着类型说实话（改型前这一档落进 `artifactKinds.file`，写着「文件」）。
  if (artifact.type === 'video') return 'artifactKinds.video';
  if (artifact.mimeType === 'text/markdown' || name.endsWith('.md')) return 'artifactKinds.markdown';
  // ⚠️ **必须排在下面那条 `text/` 泛匹配之前**：`text/html` 也以 `text/` 开头，
  //    排在它后面就永远轮不到 —— 这正是"列表里显示成「文本文件」"的根因。
  //    而 0.0.35 起 `.html` 是**真渲染**的（沙箱 iframe），标签说它是文本 = 界面自我否定。
  if (artifact.mimeType === 'text/html' || name.endsWith('.html') || name.endsWith('.htm')) {
    return 'artifactKinds.html';
  }
  if (artifact.mimeType.startsWith('text/') || name.endsWith('.txt')) return 'artifactKinds.text';
  return 'artifactKinds.file';
}

export function getArtifactLabel(artifact: Pick<Artifact, 'type' | 'mimeType' | 'name'>, t: Translate): string {
  return t(getArtifactLabelKey(artifact));
}

/**
 * 文件**身份**（界面标题 / 可访问名）—— 就是注册时的 `name`。
 *
 * ⭐ 2026-10-04 真机缺陷：FileCard / FilePreview / 搜索结果把**类型名**当身份显示 ——
 *    真实注册的视频「荣盈魔方测试.mp4」在界面上显示成「文件」。
 *    类型名是**类型元信息**（`getArtifactLabel` 的用途），不是文件名。
 *
 * ⚠️ 只有注册名**确实为空**（历史遗留行）才回落到类型名：
 *    不裁剪正常注册名、绝不从路径猜名字 —— 猜出来的名字比类型名更糟。
 */
export function getArtifactDisplayName(artifact: Pick<Artifact, 'type' | 'mimeType' | 'name'>, t: Translate): string {
  const name = artifact.name.trim();
  return name.length > 0 ? name : getArtifactLabel(artifact, t);
}
