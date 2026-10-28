import type { ArtifactDeliveryPageProgress, ArtifactDeliveryPhase } from '@clawwork/shared';

export type ArtifactActivityCallback = (phase: ArtifactDeliveryPhase, progress?: ArtifactDeliveryPageProgress) => void;

/** Observability failures must not change the result of the actual producer. */
export function notifyArtifactActivity(
  callback: ArtifactActivityCallback | undefined,
  phase: ArtifactDeliveryPhase,
  progress?: ArtifactDeliveryPageProgress,
): void {
  try {
    if (progress) callback?.(phase, progress);
    else callback?.(phase);
  } catch (error) {
    console.warn('[artifact] activity notification failed:', error);
  }
}
