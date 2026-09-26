/**
 * **首轮产物索引**（2026-09-26）：新会话的第一条消息里，附一份"这块盘上之前产出过什么"。
 *
 * 为什么要有它：产物从来没丢（`artifact:list` 不传参就是全库），但**助手不知道**它们存在 ——
 * 于是用户每开一个新会话，都得自己想起来去 `@` 某一份旧文件。补的是"助手知道有"，
 * 而"人看得见"那半在右侧「历史产物」面板（`artifact-history.ts`）。
 *
 * ⚠️ 只给**索引**（名字/来源/日期/大小），**不给内容**：几份 PDF 就能把上下文吃满、积分乱烧。
 *    要内容得用户 `@` 那一份 —— 那是**故意**的成本闸门。
 * ⚠️ 文件内容是**数据**，文件名更是：名字里可以塞换行和 `<script>`。写进提示词的每一个
 *    字符都要净化并转义，否则这就是一条**提示词注入**通道（用户传进来的文件名由对方控制）。
 */
import type { Artifact } from '@clawwork/shared';

/** 最多列几条（再多就是噪音，而且白烧 token）。 */
export const ARTIFACT_INDEX_LIMIT = 20;
/** 只列这个天数以内的（一年前的文件提它没意义）。 */
export const ARTIFACT_INDEX_MAX_AGE_DAYS = 30;
/** 单行名字的上限（防止一个超长文件名把整块撑爆）。 */
export const ARTIFACT_INDEX_MAX_NAME_CHARS = 120;

/**
 * C0 / C1 控制字符（含换行、制表）。
 *
 * ⚠️ 用**转义序列**写在字符串里，别在源码里放裸控制字符 —— 裸的控制字符会让整个文件
 *    被当成二进制（git、编辑器、diff 全都不再正常显示它）。
 */
// eslint-disable-next-line no-control-regex -- 控制字符正是这里要清掉的东西
const CONTROL_CHARS = new RegExp('[\u0000-\u001F\u007F-\u009F]+', 'g');

export interface ArtifactIndexOptions {
  now: number;
  /** 当前会话（它的产物不需要"提醒"）。 */
  excludeTaskId?: string | null;
  /** 会话标题查不到时显示的占位（会话可能已被删除，产物还在）。 */
  unknownTaskLabel: string;
  limit?: number;
  maxAgeDays?: number;
}

/**
 * 一行里的文本：去控制字符、压空白、截断、转义 —— **顺序不能反**
 * （先转义的话 `&lt;` 里的 `;` 会被当成普通字符截断，先截断又会把转义序列劈成两半）。
 */
export function sanitizeIndexText(value: string, maxChars: number): string {
  const flattened = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  const cut = flattened.length > maxChars ? `${flattened.slice(0, maxChars - 1)}…` : flattened;
  return cut.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** `2026-09-20`（本地日期就够 —— 这份索引给人看的，不是给对账用的）。 */
function formatDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 生成 `<artifacts-index>` 块；**没有可列的就返回 `null`**（调用方据此什么都不加）。
 *
 * ⚠️ 返回 `null` 而不是空块：一个空的清单只会让模型以为"这块盘上什么都没有"。
 */
export function buildArtifactsIndex(
  artifacts: readonly Artifact[],
  taskTitles: ReadonlyMap<string, string>,
  options: ArtifactIndexOptions,
): string | null {
  const limit = options.limit ?? ARTIFACT_INDEX_LIMIT;
  const maxAgeMs = (options.maxAgeDays ?? ARTIFACT_INDEX_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000;

  const usable = artifacts
    .filter((a) => a.taskId !== options.excludeTaskId)
    // 文件已经不在盘上的别列：助手照着说"有这份"，用户一点却发现没了
    .filter((a) => a.availability !== 'missing')
    .map((a) => ({ artifact: a, at: new Date(a.createdAt).getTime() }))
    .filter((entry) => Number.isFinite(entry.at) && options.now - entry.at <= maxAgeMs)
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);

  if (usable.length === 0) return null;

  const lines = usable.map(({ artifact, at }) => {
    const name = sanitizeIndexText(artifact.name, ARTIFACT_INDEX_MAX_NAME_CHARS);
    const source = sanitizeIndexText(taskTitles.get(artifact.taskId) ?? options.unknownTaskLabel, 60);
    return `- ${name} (${source} · ${formatDay(at)} · ${formatSize(artifact.size)})`;
  });

  return [
    '<artifacts-index>',
    'Files produced earlier in this workspace, newest first. The user can pull any one of them into this turn by @-mentioning it; you do not have their contents.',
    ...lines,
    '</artifacts-index>',
  ].join('\n');
}
