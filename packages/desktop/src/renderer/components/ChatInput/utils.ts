import { toast } from '@/lib/toast';
import type { PendingAttachment } from './types';
import { MAX_ATTACHMENT_SIZE, MAX_SEND_MATERIAL_BYTES, GATEWAY_INJECTED_MODEL, materialBudgetMb } from './constants';

type TranslateFn = (key: string, opts?: Record<string, unknown>) => string;

export function getModelLabel(model: string | undefined, fallback?: string): string {
  if (!model || model === GATEWAY_INJECTED_MODEL) return fallback ?? 'Default';
  return model.split('/').pop() ?? model;
}

export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

export function processAttachmentFiles(files: File[], t: TranslateFn): PendingAttachment[] {
  const accepted: PendingAttachment[] = [];
  /**
   * 单文件超过**发送字节预算**的名字（P2-2，2026-10-07）。
   *
   * 入料侧的 100MB 闸门（`MAX_ATTACHMENT_SIZE`）与发送侧预算（默认 18MiB 折算）之间
   * 差着一大截：以前收得进、发不出、**而且一句话都没有** —— 文件躺进暂存条，直到点发送
   * 才被字节闸门拦下（"收得进发不出还不说"，质量战役区 2 · P2-2）。
   * 这里**只提示、不拦截**（用户可能就是要先加进来、再手动配别的）；发送侧闸门仍在。
   * 预算取默认值：协商值在网关侧（本函数无 store 上下文）；默认值与随包网关一致，
   * 差异只在"网关被配置得更宽/更窄"时，提示可能偏保守 —— 提示不拦人，可以接受。
   */
  const overSendBudget: string[] = [];
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_SIZE) {
      toast.error(t('chatInput.attachmentTooLarge', { fileName: file.name }));
      continue;
    }
    if (file.size > MAX_SEND_MATERIAL_BYTES) overSendBudget.push(file.name);
    accepted.push({ file, previewUrl: URL.createObjectURL(file) });
  }
  if (overSendBudget.length > 0) {
    toast.warning(t('chatInput.materialSingleTooLarge', { size: materialBudgetMb(MAX_SEND_MATERIAL_BYTES) }), {
      description: overSendBudget.join('、'),
    });
  }
  return accepted;
}

export function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.split(',')[1]);
    };
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}
