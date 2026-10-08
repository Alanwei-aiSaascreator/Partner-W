import { useEffect } from 'react';
import { useUiStore } from '@/stores/uiStore';

/**
 * 产物保存 → 右侧「产物」面板**自动展开**（2026-10-06 用户反馈 #2）。
 *
 * 反馈原文：「文档生成后提示右侧产物，但要**手动点右上角「切换上下文面板」**才看得到」。
 * 以前面板默认收起，生成完只在聊天里提示一句"见右侧产物" —— 而右侧什么都没有，
 * 用户得先知道那个按钮在哪。现在：文件产物一落盘就把面板打开。
 *
 * 取舍（都是刻意的）：
 * - **只认文件类产物**（`type === 'file'`）：docgen / htmlgen / PPT（slidegen）/ 另存为
 *   走的都是这一档；而 `auto-extract` 会给每条带代码块或图片的回复都存 `code` / `image`，
 *   若也展开，正常聊天过程中面板会反复弹出来抢走正文宽度。
 * - **已经开着就什么都不做**：`setRightPanelOpen(true)` 幂等，但省掉一次无谓的 store 写入 +
 *   订阅者重渲（生成过程中 `artifact:saved` 是连发的）。
 * - **只置状态，不拽人**：设置页 / 非聊天视图下右面板本来就不渲染（见 `App.tsx` 的显示条件）。
 *   这里不关设置、不切主视图 —— 用户回到聊天时自然看到面板已开。
 * - **不按任务过滤**：跨会话存下的产物也要看得见（右侧面板本来就有「历史产物」区），
 *   而且"文件落地了"本身就是要告诉用户的事。
 */
export function useArtifactPanelReveal(): void {
  useEffect(() => {
    return window.clawwork.onArtifactSaved((artifact) => {
      if (artifact.type !== 'file') return;
      const ui = useUiStore.getState();
      if (!ui.rightPanelOpen) ui.setRightPanelOpen(true);
    });
  }, []);
}
