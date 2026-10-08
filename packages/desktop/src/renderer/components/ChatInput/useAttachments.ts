import { useState, useEffect, useCallback, useRef, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { PendingAttachment } from './types';
import { processAttachmentFiles } from './utils';

export function useAttachments() {
  const { t } = useTranslation();
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);

  /**
   * ⭐ 2026-10-07（质量战役区 2 · P2-5）：unmount 清理走 **ref 镜像**。
   *
   * 旧写法 `useEffect(..., [])` 的清理闭包捕获的是**首渲染**的 `pendingAttachments`
   * （永远是空数组）⇒ 卸载时一个 blob URL 都不会被回收，粘贴过的每张图都常驻内存
   * （从 2026-03-26 `useImageAttachments.ts` 起就带着这个洞）。镜像 ref 让清理永远看到
   * **最新**列表；effect 本身仍只挂一次（卸载时才跑）。
   */
  const pendingRef = useRef<PendingAttachment[]>([]);
  pendingRef.current = pendingAttachments;
  useEffect(() => {
    return () => {
      for (const att of pendingRef.current) URL.revokeObjectURL(att.previewUrl);
      pendingRef.current = [];
    };
  }, []);

  const handleFileSelect = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files?.length) return;
      const accepted = processAttachmentFiles(Array.from(files), t);
      if (accepted.length) {
        setPendingAttachments((prev) => [...prev, ...accepted]);
      }
      e.target.value = '';
    },
    [t],
  );

  const removeAttachment = useCallback((index: number) => {
    setPendingAttachments((prev) => {
      const removed = prev[index];
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  /**
   * 清空暂存附件（含对象 URL 回收）。
   *
   * 谁用：**离开一段对话**时（BUG-028）—— 暂存附件是会话级的临时状态，不该跟着用户
   * 走进下一段对话（真机：A 里贴的截图被打进了 B 的第一条消息）。
   * 与 `removeAttachment` 一样，回收 URL 是义务：不回收，粘贴过的每张图都常驻内存。
   */
  const clearAttachments = useCallback(() => {
    setPendingAttachments((prev) => {
      for (const attachment of prev) URL.revokeObjectURL(attachment.previewUrl);
      return prev.length === 0 ? prev : [];
    });
  }, []);

  /**
   * 只保留前 `keepCount` 个（超出个数上限时的「只保留前 N 个」一键裁剪，2026-10-07 · 方案 D）。
   *
   * ⚠️ 被裁掉的附件**必须回收 blob URL**（与 `removeAttachment` 同一义务）：
   *    裁剪是"一次丢一堆"，漏回收比单个删除漏得更狠。
   */
  const trimAttachments = useCallback((keepCount: number) => {
    const keep = Math.max(0, Math.floor(keepCount));
    setPendingAttachments((prev) => {
      if (prev.length <= keep) return prev;
      for (const attachment of prev.slice(keep)) URL.revokeObjectURL(attachment.previewUrl);
      return prev.slice(0, keep);
    });
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      const pastedFiles: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) pastedFiles.push(file);
        }
      }

      if (!pastedFiles.length) return;
      e.preventDefault();

      const accepted = processAttachmentFiles(pastedFiles, t);
      if (accepted.length) {
        setPendingAttachments((prev) => [...prev, ...accepted]);
      }
    },
    [t],
  );

  return {
    pendingAttachments,
    setPendingAttachments,
    handleFileSelect,
    removeAttachment,
    clearAttachments,
    trimAttachments,
    handlePaste,
  };
}
