import { useEffect } from 'react';
import { useTaskStore } from '../stores/taskStore';
import { useDeliveryActivityStore } from '../stores/deliveryActivityStore';

export function useDeliveryActivitySubscription(): void {
  const epoch = useTaskStore((state) => state.workspaceEpoch);
  useEffect(() => {
    const store = useDeliveryActivityStore.getState();
    if (store.workspaceEpoch !== epoch) store.clear(epoch);
    let alive = true,
      pendingSnapshot = true,
      snapshotOverloaded = false;
    const observed = new Set<string>();
    const ownsEpoch = () => alive && useTaskStore.getState().workspaceEpoch === epoch;
    const unsubscribeScope = window.clawwork.onArtifactWorkspaceScopeChanged?.((owner) => {
      if (ownsEpoch()) useDeliveryActivityStore.getState().setOwner(owner, epoch);
    });
    const unsubscribeActivity = window.clawwork.onArtifactDeliveryActivity?.((activity) => {
      if (!ownsEpoch()) return;
      if (pendingSnapshot) {
        if (observed.size < 2048) observed.add(activity.operationId);
        else snapshotOverloaded = true;
      }
      useDeliveryActivityStore.getState().record(activity, epoch);
    });
    // Install listeners first: a terminal event may arrive before this snapshot.
    void window.clawwork
      .getArtifactDeliveryActivitySnapshot?.()
      .then((snapshot) => {
        if (!ownsEpoch() || snapshotOverloaded) return;
        useDeliveryActivityStore.getState().hydrate(
          {
            ...snapshot,
            activities: snapshot.activities.filter((activity) => !observed.has(activity.operationId)),
            completedActivities: snapshot.completedActivities?.filter(
              (activity) => !observed.has(activity.operationId),
            ),
          },
          epoch,
        );
      })
      .catch((error: unknown) => console.warn('[artifact] activity snapshot unavailable:', error))
      .finally(() => {
        pendingSnapshot = false;
        observed.clear();
      });
    return () => {
      alive = false;
      unsubscribeScope?.();
      unsubscribeActivity?.();
    };
  }, [epoch]);
}
