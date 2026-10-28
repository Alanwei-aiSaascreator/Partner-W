import type { ImagegenFailure } from '@clawwork/shared';
export type { ImagegenFailure, ImagegenFailureCode } from '@clawwork/shared';
export interface ImagegenRequest {
  model: 'qwen-image-plus';
  prompt: string;
  size: string;
  title: string;
  operationId: string;
}
export function extractImagegenBlocks(content: string): { requests: ImagegenRequest[]; failures: ImagegenFailure[] } {
  const opening = [...content.matchAll(/^```[ \t]*imagegen[ \t]*$/gim)];
  if (opening.length === 0) return { requests: [], failures: [] };
  const invalid = () => ({ requests: [], failures: [{ code: 'imagegen-block-invalid' as const }] });
  const matches = [...content.matchAll(/^```[ \t]*imagegen[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gim)];
  if (matches.length !== 1 || opening.length !== 1) return invalid();
  try {
    const value: unknown = JSON.parse(matches[0][1]);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
    const r = value as Record<string, unknown>;
    if (
      Object.keys(r).some((key) => !['model', 'prompt', 'size', 'title', 'operationId'].includes(key)) ||
      r.model !== 'qwen-image-plus' ||
      typeof r.operationId !== 'string' ||
      !/^[a-zA-Z0-9_-]{8,80}$/.test(r.operationId) ||
      typeof r.prompt !== 'string' ||
      !r.prompt.trim() ||
      Array.from(r.prompt).length > 800 ||
      typeof r.size !== 'string' ||
      !['1328*1328', '1664*928', '928*1664'].includes(r.size) ||
      (r.title !== undefined && (typeof r.title !== 'string' || r.title.length > 80))
    )
      return invalid();
    return {
      requests: [
        {
          model: r.model,
          prompt: r.prompt.trim(),
          size: r.size,
          operationId: r.operationId,
          title: typeof r.title === 'string' ? r.title : 'Image',
        },
      ],
      failures: [],
    };
  } catch {
    return invalid();
  }
}
