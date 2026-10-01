export interface SlidegenToolProgress {
  schemaVersion: 1;
  status: 'slidegen-progress';
  sourceSha256: string;
  completed: number;
  total: number;
}

export interface SlidegenToolStream {
  progress?: SlidegenToolProgress;
  report?: Record<string, unknown>;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const reportStatuses = new Set([
  'file-generated',
  'source-invalid',
  'render-failed',
  'runtime-unavailable',
  'output-unconfirmed',
]);

function progressRecord(value: Record<string, unknown>): value is SlidegenToolProgress & Record<string, unknown> {
  return (
    Object.keys(value).length === 5 &&
    value.schemaVersion === 1 &&
    value.status === 'slidegen-progress' &&
    typeof value.sourceSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sourceSha256) &&
    Number.isInteger(value.completed) &&
    Number.isInteger(value.total) &&
    (value.completed as number) >= 1 &&
    (value.completed as number) <= (value.total as number) &&
    (value.total as number) <= 200
  );
}

function terminalRecord(value: Record<string, unknown>): boolean {
  return (
    value.schemaVersion === 1 &&
    reportStatuses.has(String(value.status)) &&
    value.artifactIndexed === false &&
    value.visualReview === 'not-performed' &&
    'fileCreated' in value
  );
}

export function parseSlidegenToolStream(text: string, partial = false): SlidegenToolStream | null {
  if (typeof text !== 'string' || text.length > 2 * 1024 * 1024) return null;
  const input = text.trim();
  if (!input) return null;
  try {
    const whole: unknown = JSON.parse(input);
    if (!object(whole)) return null;
    if (progressRecord(whole)) return { progress: whole };
    return terminalRecord(whole) ? { report: whole } : null;
  } catch {
    const lines = input.split(/\r?\n/);
    if (lines.length < 2 || lines.length > 201) return null;
    const result: SlidegenToolStream = {};
    for (let i = 0; i < lines.length; i++) {
      let value: unknown;
      try {
        value = JSON.parse(lines[i]);
      } catch {
        return partial && i === lines.length - 1 && result.progress && lines[i].startsWith('{') ? result : null;
      }
      if (!object(value)) return null;
      if (progressRecord(value)) {
        const previous = result.progress;
        if (
          previous &&
          (value.sourceSha256 !== previous.sourceSha256 ||
            value.total !== previous.total ||
            value.completed <= previous.completed)
        )
          return null;
        result.progress = value;
      } else {
        if (!terminalRecord(value) || i !== lines.length - 1 || !result.progress) return null;
        if (value.sourceSha256 !== undefined && value.sourceSha256 !== result.progress.sourceSha256) return null;
        if (
          value.status === 'file-generated' &&
          (value.sourceSha256 !== result.progress.sourceSha256 || value.pages !== result.progress.total)
        )
          return null;
        result.report = value;
      }
    }
    return result.progress || result.report ? result : null;
  }
}
