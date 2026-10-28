/**
 * ⚠️ DOCX-205 合同 §5.C（2026-10-10）：聊天里 `docgen` / `htmlgen` 围栏卡片的
 * **状态判据** —— 展示与承诺必须跟随**真实交付状态**，不许拿"围栏存在 / 工具 write
 * 成功 / 模型承诺"当交付证据。
 *
 * 两个数据源（都是既有接线，不新建状态系统、不轮询 DB）：
 *  1. `useDeliveryActivityStore`：主进程交付流水线的活动帧（按 taskId+messageId 取最新）；
 *  2. `useTaskArtifacts(taskId)`：该任务**实时核验过 availability** 的已登记产物
 *     （生成 → 写入 → 校验 → 登记 → 实时可读，正是"登记 + 同版本重新读取"的现行出口）。
 *
 * 状态机（合同伪码的落地）：
 *  无活动 ⇒ `pending`（待处理）
 *  active ⇒ `generating`；failed ⇒ `failed`；needs-review/canceled ⇒ `unconfirmed`
 *  succeeded **且**该 messageId 有 availability=available 的登记产物 ⇒ `delivered`
 *  succeeded 但查不到可用产物 ⇒ `unconfirmed`（已结算但拿不出可开文件 —— 如实未确认，
 *  **不**为了让卡片变绿发明布尔标记）
 */

import { useMemo } from 'react';
import type { ArtifactDeliveryActivity } from '@clawwork/shared';
import { useDeliveryActivityStore } from '@/stores/deliveryActivityStore';
import { useTaskArtifacts } from '@/hooks/useTaskArtifacts';

export type RequestCardState = 'pending' | 'generating' | 'failed' | 'unconfirmed' | 'delivered';

/** 纯派生（可单测）：只消费既有交付结果，不发明新的成功标记。 */
export function deriveRequestCardState(input: {
  activity: Pick<ArtifactDeliveryActivity, 'status'> | undefined;
  availableArtifactId: string | undefined;
}): RequestCardState {
  const { activity, availableArtifactId } = input;
  if (!activity) return 'pending';
  switch (activity.status) {
    case 'active':
      return 'generating';
    case 'failed':
      return 'failed';
    case 'needs-review':
    case 'canceled':
      return 'unconfirmed';
    case 'succeeded':
      return availableArtifactId ? 'delivered' : 'unconfirmed';
  }
}

export interface ArtifactDeliveryProof {
  state: RequestCardState;
  /** `delivered` 时指向**已登记**的那一版；打开按钮只许用它。 */
  artifactId?: string;
}

/** 卡片种类（决定"哪份已登记产物算这一张卡片的交付"与活动帧的归属判据）。 */
export type RequestCardKind = 'docgen' | 'htmlgen' | 'videogen' | 'imagegen';

/**
 * 每种卡片认哪些扩展名的**已登记产物**。
 *
 * ⚠️ 2026-10-12（视频接入）收紧：原来"该消息下任一份可用产物"就算交付 —— 一条消息里
 *    同时有 docgen 与 videogen 块时，docgen 卡片会拿视频产物当自己的交付物，
 *    「打开」按钮点开的是**另一个文件**。按扩展名归属是这里唯一的诚实判据。
 */
const KIND_EXTENSIONS: Readonly<Record<RequestCardKind, readonly string[]>> = Object.freeze({
  docgen: ['.pptx', '.docx', '.xlsx', '.pdf'],
  htmlgen: ['.html'],
  videogen: ['.mp4'],
  imagegen: ['.png'],
});

function isKindArtifactName(kind: RequestCardKind, name: string | undefined): boolean {
  if (typeof name !== 'string') return false;
  const lower = name.toLowerCase();
  return KIND_EXTENSIONS[kind].some((ext) => lower.endsWith(ext));
}

/** 活动帧是不是**视频作业**的（视频有自己的后台作业帧，与消息收尾帧并存）。 */
function isVideoActivity(record: Pick<ArtifactDeliveryActivity, 'phase' | 'observedPhases'>): boolean {
  if (record.phase === 'generating-video') return true;
  return (record.observedPhases ?? []).some((step) => step.phase === 'generating-video');
}

/**
 * 卡片证明的取数 hook。
 *
 * ⚠️ 作用域：taskId + messageId 精确匹配（messageId 全局唯一），活动记录本身由
 *    store 按 workspaceEpoch/owner 门控（换工作区即清），两者相加就是本文件能拿到的
 *    全部"当前交付范围"证据 —— 不再自己维护第二套 scope 字段。
 *
 * ⚠️ `kind = 'videogen'` 时**两处都换成视频专属判据**：活动帧只认含
 *    `generating-video` 相位的那条（视频是脱离消息路径的后台作业，自己一条帧），
 *    产物只认 `.mp4`。不传 kind 保持旧行为（该消息下任一可用产物）——
 *    现有调用方已全部显式传 kind。
 */
export function useArtifactDeliveryProof(
  taskId: string | undefined,
  messageId: string | undefined,
  kind?: RequestCardKind,
): ArtifactDeliveryProof {
  const activity = useDeliveryActivityStore((state) => {
    if (!taskId || !messageId) return undefined;
    let best: ArtifactDeliveryActivity | undefined;
    for (const record of Object.values(state.records)) {
      if (record.taskId !== taskId || record.messageId !== messageId) continue;
      // 视频作业有**自己的**帧（脱离消息路径的分钟级后台任务，晚于消息帧结束）：
      //  · videogen 卡只认视频帧；docgen/htmlgen 卡**跳过**视频帧 ——
      //    否则一条"文档+视频"混排消息里，视频帧失败会把已经拿到 docx 的文档卡染成失败。
      if (kind) {
        const video = isVideoActivity(record);
        const image =
          record.phase === 'generating-image' ||
          (record.observedPhases ?? []).some((step) => step.phase === 'generating-image');
        if (kind === 'videogen' && (!video || image)) continue;
        if (kind === 'imagegen' && (!image || video)) continue;
        if (kind !== 'videogen' && kind !== 'imagegen' && (video || image)) continue;
      }
      const newer =
        !best ||
        record.startedAt > best.startedAt ||
        (record.startedAt === best.startedAt && record.sequence > best.sequence);
      if (newer) best = record;
    }
    return best;
  });
  const { artifacts } = useTaskArtifacts(taskId);
  const available = useMemo(
    () =>
      taskId && messageId
        ? artifacts.find(
            (artifact) =>
              artifact.taskId === taskId &&
              (kind === 'imagegen' && activity?.artifactId
                ? artifact.id === activity.artifactId
                : artifact.messageId === messageId) &&
              artifact.availability === 'available' &&
              (kind ? isKindArtifactName(kind, artifact.name) : true),
          )
        : undefined,
    [artifacts, taskId, messageId, kind, activity?.artifactId],
  );
  return {
    state: deriveRequestCardState({ activity, availableArtifactId: available?.id }),
    ...(available ? { artifactId: available.id } : {}),
  };
}
