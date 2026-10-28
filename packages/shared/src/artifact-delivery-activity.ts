import { SLIDEGEN_MAX_PAGES } from './slidegen-failure.js';

export interface ArtifactDeliveryPageProgress {
  completed: number;
  total: number;
}

export function isArtifactDeliveryPageProgress(value: unknown): value is ArtifactDeliveryPageProgress {
  if (!value || typeof value !== 'object') return false;
  const progress = value as Record<string, unknown>;
  return (
    typeof progress.completed === 'number' &&
    typeof progress.total === 'number' &&
    Number.isInteger(progress.completed) &&
    Number.isInteger(progress.total) &&
    progress.completed >= 0 &&
    progress.completed <= progress.total &&
    progress.total > 0 &&
    progress.total <= SLIDEGEN_MAX_PAGES
  );
}

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
  /** 视频生成（2026-10-12 视频接入）：远端异步任务创建 → 轮询 → 下载，耗时以分钟计。 */
  | 'generating-video'
  | 'generating-image'
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
  pageProgress?: ArtifactDeliveryPageProgress;
  /** Bounded, actually observed phase transitions; absent on older senders. */
  observedPhases?: ArtifactDeliveryPhaseObservation[];
  historyTruncated?: boolean;
  /** Verified existing artifact; may originate in an earlier message of the same task. */
  artifactId?: string;
  endedAt?: number;
}

export interface ArtifactDeliveryActivitySnapshot {
  owner: ArtifactWorkspaceScope;
  activities: ArtifactDeliveryActivity[];
  /** Recent completed operations, separate from the active-only list. */
  completedActivities?: ArtifactDeliveryActivity[];
}
