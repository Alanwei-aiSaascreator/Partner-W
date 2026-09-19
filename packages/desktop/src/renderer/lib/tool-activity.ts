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

/**
 * **此刻在跑哪一条**工具调用 —— 「进行中」反馈的唯一出口（§12）。
 *
 * ## 为什么要有它
 *
 * 这个推导原来在**两处各写了一遍**（活动条 `ComposerActivity`、工具汇总
 * `ToolCallSummary`），一字不差：`[...calls].reverse().find(c => c.status === 'running')`。
 * 两处重复 ⇒ 迟早只改一处。
 *
 * ## 它同时是"该收掉了吗"的唯一判据
 *
 * 界面上所有"正在进行"的反馈都该由它驱动：返回 `null` 就**必须收掉**。四个相位都错过过：
 * - **只显示不收** ⇒ 转圈永远不停，用户以为卡死；
 * - **结束不收** ⇒ 明明跑完了还说"正在执行"；
 * - **失败不收** ⇒ 报错了还说在跑，是**在说谎**（与 `item.status:"blocked"` 那条同类）；
 * - **取消不收** ⇒ 那一轮已经作废，还挂着一条"正在跑"。
 *
 * ⚠️ 取的是**最近**一条（`reverse().find`），不是第一条：长任务里前后会跑好几个工具，
 *    显示最早那条等于告诉用户一件早就做完的事。
 * ⚠️ 纯函数、不改动入参 —— 两个调用方都在 React 的 render 路径上。
 */
export function latestRunningCall(toolCalls: ToolCall[]): ToolCall | null {
  for (let i = toolCalls.length - 1; i >= 0; i -= 1) {
    if (toolCalls[i].status === 'running') return toolCalls[i];
  }
  return null;
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
