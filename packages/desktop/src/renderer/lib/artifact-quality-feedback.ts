import type { Message, SlidegenWarning } from '@clawwork/shared';

export const ARTIFACT_QUALITY_MARKER = '[artifact-layout-review]';

export interface ArtifactQualityNote {
  sourceMessageId: string;
  warnings: SlidegenWarning[];
}

export function parseArtifactQualityNote(message: Pick<Message, 'role' | 'content'>): ArtifactQualityNote | null {
  if (message.role !== 'system' || !message.content.startsWith(`${ARTIFACT_QUALITY_MARKER}\n`)) return null;
  try {
    const value = JSON.parse(message.content.slice(ARTIFACT_QUALITY_MARKER.length)) as Partial<ArtifactQualityNote>;
    if (!value || typeof value.sourceMessageId !== 'string' || !value.sourceMessageId) return null;
    if (!Array.isArray(value.warnings) || !value.warnings.length) return null;
    if (
      !value.warnings.every(
        (warning) =>
          warning &&
          (warning.code === 'layout-out-of-bounds' || warning.code === 'layout-text-occluded') &&
          Number.isInteger(warning.page) &&
          warning.page > 0 &&
          Number.isInteger(warning.element) &&
          warning.element >= 0 &&
          typeof warning.detail === 'string' &&
          (warning.artifactName === undefined || typeof warning.artifactName === 'string'),
      )
    )
      return null;
    return { sourceMessageId: value.sourceMessageId, warnings: value.warnings };
  } catch {
    return null;
  }
}
