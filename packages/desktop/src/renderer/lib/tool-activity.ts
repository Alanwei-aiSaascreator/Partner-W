import type { ToolCall } from '@clawwork/shared';

export type ToolActivityKind =
  | 'listDirectory'
  | 'readFile'
  | 'search'
  | 'execute'
  | 'writeFile'
  | 'browseWeb'
  | 'other';

export interface ToolActivityGroup {
  key: string;
  kind: ToolActivityKind;
  status: ToolCall['status'];
  calls: ToolCall[];
}

export interface ToolActivitySummaryModel {
  totalCount: number;
  completedCount: number;
  runningCount: number;
  errorCount: number;
  durationMs: number | null;
  groups: ToolActivityGroup[];
}

const EXACT_KINDS: Readonly<Record<string, ToolActivityKind>> = {
  ls: 'listDirectory',
  dir: 'listDirectory',
  rg: 'search',
  grep: 'search',
  find: 'search',
  exec: 'execute',
  shell: 'execute',
  bash: 'execute',
};

export function classifyToolActivity(name: string): ToolActivityKind {
  const normalized = name.trim().toLowerCase().replaceAll('-', '_');
  const exact = EXACT_KINDS[normalized];
  if (exact) return exact;
  if (/(^|[._])(?:ls|list_directory|list_files)(?:$|[._])/.test(normalized)) return 'listDirectory';
  if (/(?:read|open|get)_?(?:file|document)|read_file/.test(normalized)) return 'readFile';
  if (/(?:search|find|grep|ripgrep|query)/.test(normalized)) return 'search';
  if (/(?:apply_patch|write|edit|save|create|move|rename|delete|remove)_?(?:file|directory)?/.test(normalized)) {
    return 'writeFile';
  }
  if (/(?:browser|web|url|navigate|fetch_page|open_page)/.test(normalized)) return 'browseWeb';
  if (/(?:exec|shell|terminal|command|powershell|cmd|bash)/.test(normalized)) return 'execute';
  return 'other';
}

function activityDuration(toolCalls: ToolCall[], hasRunning: boolean): number | null {
  if (toolCalls.length === 0 || hasRunning) return null;
  const starts = toolCalls.map((call) => Date.parse(call.startedAt)).filter(Number.isFinite);
  const completions = toolCalls
    .map((call) => (call.completedAt ? Date.parse(call.completedAt) : Number.NaN))
    .filter(Number.isFinite);
  if (starts.length === 0 || completions.length === 0) return null;
  return Math.max(0, Math.max(...completions) - Math.min(...starts));
}

export function summarizeToolActivity(toolCalls: ToolCall[]): ToolActivitySummaryModel {
  const groups = new Map<string, ToolActivityGroup>();
  let completedCount = 0;
  let runningCount = 0;
  let errorCount = 0;

  for (const call of toolCalls) {
    if (call.status === 'running') runningCount += 1;
    else completedCount += 1;
    if (call.status === 'error') errorCount += 1;

    const kind = classifyToolActivity(call.name);
    const key = `${kind}:${call.status}`;
    const group = groups.get(key);
    if (group) group.calls.push(call);
    else groups.set(key, { key, kind, status: call.status, calls: [call] });
  }

  return {
    totalCount: toolCalls.length,
    completedCount,
    runningCount,
    errorCount,
    durationMs: activityDuration(toolCalls, runningCount > 0),
    groups: [...groups.values()],
  };
}
