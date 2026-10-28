import { create } from 'zustand';
import type { ArtifactDeliverySettled } from '@clawwork/shared';

interface ArtifactDeliveryState {
  settled: readonly ArtifactDeliverySettled[];
  record: (result: ArtifactDeliverySettled) => void;
}

export const useArtifactDeliveryStore = create<ArtifactDeliveryState>((set) => ({
  settled: [],
  record: (result) =>
    set((state) => ({
      settled: [
        ...state.settled.filter((entry) => entry.taskId !== result.taskId || entry.messageId !== result.messageId),
        result,
      ].slice(-128),
    })),
}));
