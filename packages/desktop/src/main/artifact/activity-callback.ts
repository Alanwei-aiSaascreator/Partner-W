import type { ArtifactDeliveryPhase } from '@clawwork/shared';

export type ArtifactActivityCallback = (phase: ArtifactDeliveryPhase) => void;

/** Observability failures must not change the result of the actual producer. */
export function notifyArtifactActivity(
  callback: ArtifactActivityCallback | undefined,
  phase: ArtifactDeliveryPhase,
): void {
  try {
    callback?.(phase);
  } catch (error) {
    console.warn('[artifact] activity notification failed:', error);
  }
}
