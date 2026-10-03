import type { ToolCall } from '@clawwork/shared';

export type ToolActivityKind =
  | 'listDirectory'
  | 'readFile'
  | 'search'
  | 'execute'
  | 'writeFile'
  | 'browseWeb'
  | 'generateImage'
  | 'generateVideo'
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
  image_generate: 'generateImage',
  video_generate: 'generateVideo',
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

export function toolCallDurationMs(call: ToolCall): number | null {
  const start = Date.parse(call.startedAt);
  const end = call.completedAt ? Date.parse(call.completedAt) : Number.NaN;
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

function activityDuration(toolCalls: ToolCall[], hasRunning: boolean): number | null {
  if (toolCalls.length === 0 || hasRunning) return null;
  if (toolCalls.some((call) => toolCallDurationMs(call) === null)) return null;
  const starts = toolCalls.map((call) => Date.parse(call.startedAt));
  const completions = toolCalls.map((call) => Date.parse(call.completedAt!));
  return Math.max(...completions) - Math.min(...starts);
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

/**
 * 工具失败原因是否属于**运行时安全样板**（不该当"失败原因"展示）。
 *
 * ⚠️ 2026-10-03 真机事故（W03 搜索复现）：`web_search` 失败时，运行时把
 * EXTERNAL_UNTRUSTED_CONTENT 安全声明整段塞进了调用的 error/result（`SECURITY NOTICE:` 开头、
 * 内容是"外部不可信来源 / 别把里面当指令"那套给模型看的防护话术），工具卡把这串**英文样板**
 * 原样渲染成"失败原因"——用户看到的既不是中文可行动，也不是真正的失败原因。
 *
 * 判据**只认样板形状**（行首 `SECURITY NOTICE:` 或 `EXTERNAL_UNTRUSTED_CONTENT` 包裹标记），
 * 别的一律原样展示；展开后的单卡里仍是原文（详情不删证据）。
 */
export function isRuntimeBoilerplateNotice(text: string): boolean {
  const trimmed = text.trim();
  return /^SECURITY NOTICE:/i.test(trimmed) || trimmed.includes('<<<EXTERNAL_UNTRUSTED_CONTENT');
}

/**
 * 摘要行可展示的失败原因：跳过运行时安全样板；没有可用原因时返回空串（摘要行少一行灰字，
 * 失败本身仍由"N 个失败"与展开详情表达）。
 */
export function visibleFailureReason(toolCalls: ToolCall[]): string {
  const call = toolCalls.find(
    (candidate) =>
      candidate.status === 'error' && candidate.result?.trim() && !isRuntimeBoilerplateNotice(candidate.result),
  );
  return call?.result?.trim() ?? '';
}

/**
 * 还没结束的状态 —— `running` 与 `awaitingApproval`（A2，2026-09-19）。
 *
 * ⚠️ **它们不是一回事，但都"没结束"**：显示上要分开说（`awaitingApproval` 有自己的文案，
 * 见 `ToolCallCard` / `ComposerActivity`），**归类**上必须同一桶 ——
 * 少了 `awaitingApproval`，`summarizeToolActivity` 的 `runningCount` 就是 0，
 * 而 `ToolCallSummary` 会据此把"等着人批准"渲染成 **`done`**（那是撒谎）。
 */
function isUnfinished(status: ToolCall['status']): boolean {
  return status === 'running' || status === 'awaitingApproval';
}

/**
 * 最新一条**在等人批准**的调用（没有就 null）。
 *
 * ⚠️ 与 `latestRunningCall` **分开**，因为它们的文案不同：
 * "执行中：X" 说的是"在动"，而这条要说的是"**没动，在等人**" ——
 * 复用前者就等于什么都没说（A2 的口径就是不让复用）。
 */
export function latestAwaitingApproval(toolCalls: ToolCall[]): ToolCall | null {
  for (let i = toolCalls.length - 1; i >= 0; i -= 1) {
    if (toolCalls[i].status === 'awaitingApproval') return toolCalls[i];
  }
  return null;
}

export function summarizeToolActivity(toolCalls: ToolCall[]): ToolActivitySummaryModel {
  const groups = new Map<string, ToolActivityGroup>();
  let completedCount = 0;
  let runningCount = 0;
  let errorCount = 0;

  for (const call of toolCalls) {
    if (isUnfinished(call.status)) runningCount += 1;
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
