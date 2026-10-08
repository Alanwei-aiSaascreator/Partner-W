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
import { useUiStore } from '@/stores/uiStore';

export type ArtifactPreviewAction = (artifact: Artifact) => void;

/**
 * 从成果卡（聊天内或右侧列表）发起"在右侧预览"。
 *
 * ⚠️ **不是 toggle**：重复点击不关栏（关栏是预览窗格里「返回列表」的职责，
 *    按钮语义各自单纯）。也不触发系统打开 —— 那是卡片上「打开」自己的动作。
 */
export function requestArtifactPreview(artifact: Artifact): void {
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
 */
export function useArtifactPanelViewScope(): void {
  const mainView = useUiStore((s) => s.mainView);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  useEffect(() => {
    if (mainView !== 'chat' || settingsOpen) useUiStore.getState().setArtifactPanelMode('list');
  }, [mainView, settingsOpen]);
}
