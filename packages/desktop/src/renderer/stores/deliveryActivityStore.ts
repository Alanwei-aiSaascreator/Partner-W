import { create } from 'zustand';
import type {
  ArtifactDeliveryActivity,
  ArtifactDeliveryActivitySnapshot,
  ArtifactWorkspaceScope,
} from '@clawwork/shared';

interface DeliveryActivityState {
  owner: ArtifactWorkspaceScope;
  /**
   * ⭐ 第二轮（R2-4）：**权威 owner 是否已就绪**。初始 false；scope-changed 事件或
   *    活动快照（hydrate）带来真实 owner 后才置 true（活动帧 record 不算权威来源
   *    —— 不得把"观察到的第一帧"当权威 owner）。消费方（执行事件接收门）在 false
   *    期间对有界暂存帧做初始化屏障暂存，就绪后按原 scope/revision 过滤折入。
   *    epoch 切换（clear）复位为 false（新代次重新走一次初始化屏障）。
   */
  ownerReady: boolean;
  workspaceEpoch: number;
  records: Record<string, ArtifactDeliveryActivity>;
  active: readonly ArtifactDeliveryActivity[];
  clear: (epoch: number) => void;
  setOwner: (owner: ArtifactWorkspaceScope, epoch: number) => void;
  record: (activity: ArtifactDeliveryActivity, epoch: number) => void;
  hydrate: (snapshot: ArtifactDeliveryActivitySnapshot, epoch: number) => void;
}

function acceptsOwner(current: ArtifactWorkspaceScope, next: ArtifactWorkspaceScope): boolean {
  return next.revision > current.revision || (next.revision === current.revision && next.scope === current.scope);
}

function activeRecords(records: DeliveryActivityState['records']): ArtifactDeliveryActivity[] {
  return Object.values(records)
    .filter((entry) => entry.status === 'active')
    .sort((a, b) => a.startedAt - b.startedAt);
}

export const useDeliveryActivityStore = create<DeliveryActivityState>((set, get) => ({
  owner: { scope: null, revision: -1 },
  ownerReady: false,
  workspaceEpoch: 0,
  records: {},
  active: [],
  clear: (epoch) => set({ workspaceEpoch: epoch, ownerReady: false, records: {}, active: [] }),
  setOwner: (owner, epoch) =>
    set((state) => {
      if (state.workspaceEpoch !== epoch || !acceptsOwner(state.owner, owner)) return state;
      // 权威来源（scope-changed / 快照 hydrate）带来真实 owner ⇒ 初始化屏障解除。
      const nextReady = state.ownerReady || owner.scope !== null;
      if (owner.revision === state.owner.revision) {
        if (nextReady === state.ownerReady) return state;
        return { ownerReady: true };
      }
      return { owner: { ...owner }, records: {}, active: [], ownerReady: nextReady };
    }),
  record: (activity, epoch) =>
    set((state) => {
      const owner = { scope: activity.workspaceScope, revision: activity.workspaceRevision };
      if (state.workspaceEpoch !== epoch || !owner.scope || !acceptsOwner(state.owner, owner)) return state;
      const changedOwner = owner.revision > state.owner.revision;
      const prior = changedOwner ? undefined : state.records[activity.operationId];
      // Terminal evidence is sticky even if a delayed snapshot claims a higher sequence.
      if (prior && (prior.status !== 'active' || activity.sequence <= prior.sequence)) return state;
      const records = {
        ...(changedOwner ? {} : state.records),
        [activity.operationId]: {
          ...activity,
          ...(activity.pageProgress ? { pageProgress: { ...activity.pageProgress } } : {}),
          ...(activity.observedPhases ? { observedPhases: activity.observedPhases.map((step) => ({ ...step })) } : {}),
        },
      };
      const terminals = Object.values(records).filter((entry) => entry.status !== 'active');
      for (const entry of terminals.slice(0, Math.max(0, terminals.length - 2048))) delete records[entry.operationId];
      return { owner, records, active: activeRecords(records) };
    }),
  hydrate: (snapshot, epoch) => {
    get().setOwner(snapshot.owner, epoch);
    const state = get();
    if (
      state.workspaceEpoch !== epoch ||
      state.owner.scope !== snapshot.owner.scope ||
      state.owner.revision !== snapshot.owner.revision
    )
      return;
    // Terminal facts are installed first so an inconsistent delayed active row cannot revive them.
    for (const activity of [
      ...(snapshot.completedActivities ?? []).filter((entry) => entry.status !== 'active'),
      ...snapshot.activities,
    ]) {
      if (activity.workspaceScope === snapshot.owner.scope && activity.workspaceRevision === snapshot.owner.revision)
        get().record(activity, epoch);
    }
  },
}));
