import { useEffect } from 'react';

/**
 * 禁止「把文件拖到窗口里」触发 Chromium 的默认导航（T05 回归项之一）。
 *
 * 为什么必须有它：把文件拖进 Chromium 窗口的默认行为是**导航到那个文件**
 * （`file://`），整个渲染层会被替换掉 —— 用户看到的是"应用没了"。输入卡片上的
 * 拖入处理器只覆盖卡片那块；这条是**窗口级兜底**：拖到侧栏、消息区、任何角落
 * 都不会导航。
 *
 * ⚠️ 只对**带文件**的拖动 `preventDefault`：应用内部的文本/选区拖动
 *    （拖字进 textarea、拖消息引用等）保持原生行为，一律 prevent 会把它们打死。
 * ⚠️ 用原生 `addEventListener` 而不是 React 合成事件：目标可能是 React 根节点
 *    之外的任何元素，合成事件收不到。
 */
export function usePreventFileDropNavigation(): void {
  useEffect(() => {
    const isFileDrag = (event: globalThis.DragEvent): boolean =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const prevent = (event: globalThis.DragEvent): void => {
      if (isFileDrag(event)) event.preventDefault();
    };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);
}
