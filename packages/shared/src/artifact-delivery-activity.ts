export interface ArtifactWorkspaceScope {
  scope: string | null;
  /** Monotonic within this main process; rejects late initial snapshots. */
  revision: number;
}

export type ArtifactDeliveryPhase =
  | 'downloading-media'
  | 'generating-presentation'
  | 'generating-document'
  | 'generating-html'
  | 'saving-artifacts'
  | 'reconciling-artifacts';
export type ArtifactDeliveryTerminalStatus = 'succeeded' | 'needs-review' | 'failed' | 'canceled';
export interface ArtifactDeliveryPhaseObservation {
  phase: ArtifactDeliveryPhase;
  observedAt: number;
  sequence: number;
}
export interface ArtifactDeliveryActivity {
  taskId: string;
  sessionKey: string;
  messageId: string;
  runId?: string;
  workspaceScope: string;
  workspaceRevision: number;
  operationId: string;
  sequence: number;
  startedAt: number;
  phase: ArtifactDeliveryPhase;
  status: 'active' | ArtifactDeliveryTerminalStatus;
  /** Bounded, actually observed phase transitions; absent on older senders. */
  observedPhases?: ArtifactDeliveryPhaseObservation[];
  historyTruncated?: boolean;
  endedAt?: number;
}

export interface ArtifactDeliveryActivitySnapshot {
  owner: ArtifactWorkspaceScope;
  activities: ArtifactDeliveryActivity[];
  /** Recent completed operations, separate from the active-only list. */
  completedActivities?: ArtifactDeliveryActivity[];
}
