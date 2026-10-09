/**
 * 成果预览的**导航适配层**（WorkBuddy 产物 UI A 批 Task 3，2026-10-09）。
 *
 * 只做三件展示协调：选中已有 ID（`fileStore`）、置右栏预览模式（`uiStore` 瞬态字段）、
 * 打开右栏。**不**新建 Artifact store、**不**复制 Artifact 对象、**不**写消息/登记链 ——
 * 预览内容的真源仍是「当前任务权威成果集合 + 既有 previewArtifact/readArtifactFile IPC」。
 */
import { useEffect } from 'react';
import type { Artifact } from '@clawwork/shared';
import { useFileStore } from '@/stores/fileStore';
import { useTaskStore } from '@/stores/taskStore';
import { useUiStore } from '@/stores/uiStore';

export type ArtifactPreviewAction = (artifact: Artifact) => void;

/**
 * 预览入口的**焦点引用**（H5，2026-10-09 复审；H5 终审 E5：身份绑定）。
 *
 * 为什么需要它：窄窗下预览是 Radix 抽屉，而当前树里**没有 Trigger** —— 关闭时
 * Radix 无处归还焦点（实测落到 `body`）。所以在"请求预览"那一刻记下入口元素，
 * 关闭时（`onCloseAutoFocus`）归还给**仍连接且属于同一 task/epoch** 的那一个。
 *
 * 为什么还要绑定 task/epoch：入口"仍在文档里"不等于"还是这次预览的入口" ——
 * 预览期间切了任务或换了工作区，旧入口属于上一个范围，归还焦点会把用户拽回
 * 旧范围的控件上（终审两例实测）。范围不符就当没有入口，走当前视图兜底。
 *
 * ⚠️ 不是新 store、不持久化、不持有 Artifact：一个模块级引用，取一次即消费。
 */
type PreviewFocusTarget = {
  element: HTMLElement;
  taskId: string | null;
  workspaceEpoch: number;
};
let previewFocusTarget: PreviewFocusTarget | null = null;

/** 显式丢弃（离开聊天 / 去来源这类"这次预览已经结束"的路径）。 */
export function clearArtifactPreviewFocusTarget(): void {
  previewFocusTarget = null;
}

/** 取出归还点：只消费一次；已脱离文档、或已跨范围（task/epoch 变化）的入口不算数。 */
export function takeArtifactPreviewFocusTarget(): HTMLElement | null {
  const target = previewFocusTarget;
  previewFocusTarget = null;
  const current = useTaskStore.getState();
  return target?.element.isConnected &&
    target.taskId === current.activeTaskId &&
    target.workspaceEpoch === current.workspaceEpoch
    ? target.element
    : null;
}

/**
 * 从成果卡（聊天内或右侧列表）发起"在右侧预览"。
 *
 * ⚠️ **不是 toggle**：重复点击不关栏（关栏是预览窗格里「返回列表」的职责，
 *    按钮语义各自单纯）。也不触发系统打开 —— 那是卡片上「打开」自己的动作。
 * ⚠️ **非 available 直接拒绝**（H4a）：预览会真去读文件；unknown/missing/unsafe
 *    进来只会得到一次注定失败的读取。这里是三层约束的第二层（卡上按钮禁用是第一层、
 *    预览面板的权威解析是第三层）——直接调用本函数的老路径也受同一道门保护。
 */
export function requestArtifactPreview(artifact: Artifact): void {
  if (artifact.availability !== 'available') return;
  // ⭐ H5：在**改变 store、抽屉卸载原面板之前**捕获当前焦点元素 —— 抽屉关闭时
  //    要把它归还给它。晚一步捕获拿到的是抽屉里的节点（那时已经没意义了）。
  //    E5：同时记下**此刻的 task/epoch** —— 关闭时若范围已变，这个入口就作废。
  const focused = document.activeElement;
  const owner = useTaskStore.getState();
  previewFocusTarget =
    focused instanceof HTMLElement && focused !== document.body
      ? { element: focused, taskId: owner.activeTaskId, workspaceEpoch: owner.workspaceEpoch }
      : null;
  useFileStore.getState().setSelectedArtifact(artifact.id);
  useUiStore.getState().setArtifactPanelMode('preview');
  useUiStore.getState().setRightPanelOpen(true);
}

/**
 * App 挂载的**视图门**：离开聊天或打开设置 ⇒ 预览模式复位回列表。
 *
 * 为什么必须在 App 层（而不是 RightPanel 的卸载 cleanup）：窄窗/布局变化也可能
 * 使 RightPanel 重挂载，拿"任意卸载"当复位会误伤；`mainView`/`settingsOpen` 才是
 * "用户现在的视图是不是聊天"的权威事实。**回聊天不自动恢复**上次预览 ——
 * FileBrowser 期间改过共享选中 ID（选 B），自动恢复就会预览出另一份文件。
 *
 * H5 追加：同一条门也**清掉焦点入口引用** —— 离开聊天/开设置意味着这次预览已经结束，
 * 不能把焦点还给一个"上一个视图里"的元素。
 */
export function useArtifactPanelViewScope(): void {
  const mainView = useUiStore((s) => s.mainView);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  useEffect(() => {
    if (mainView !== 'chat' || settingsOpen) {
      clearArtifactPreviewFocusTarget();
      useUiStore.getState().setArtifactPanelMode('list');
    }
  }, [mainView, settingsOpen]);
}
