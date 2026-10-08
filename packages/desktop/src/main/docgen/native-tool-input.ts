import path from 'node:path';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import type { ToolCall } from '@clawwork/shared';
import { readWorkspaceBytes } from '../slidegen/source-file.js';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const WRITE_TOOLS = new Set(['write', 'write_file']);
const EDIT_TOOLS = new Set(['edit', 'apply_patch']);

export interface NativeInputOptions {
  /**
   * 本轮 run 的开始时刻（`run.createdAt`）。
   *
   * ⭐ BUG-046 ③（2026-10-08 真机 69 次 `native-current-write-required` 误诊）：
   * 判据从「write 工具 args 的 sha 必须与盘上一致」放宽为两层证据——
   *   ① 最强：本轮**某一次** write 的内容与盘上字节一致（sha 匹配，未变；
   *      BUG-054：同文件多次 write 时保留全部记录，任一次一致即通过 —— 数组序
   *      ≠ 执行序，旧的"最后一次胜出"在倒序时会覆盖掉正确证据）；
   *   ② 本轮被 edit/apply_patch 改过、且盘上 mtime 不早于 run 开始（edit 的 args
   *      不是全文，没有 sha 可对；freshness 就是它的"这是本轮产物"证明）。
   * 守卫强度不松：**run 开始前就存在、本轮没碰过的旧文件永不入选**（旧 Artifact
   * 冒充新 Artifact 的那个洞，一字没放宽）。
   */
  sinceMs?: number;
}

/**
 * 从本轮已完成的工具调用里挑出「当前这轮的 .native-ppt.json 源文件」。
 *
 * ⭐ BUG-046 ③：候选排序**按盘上 mtime**，不再按工具调用数组序——数组序是模型
 * 写回的顺序，mtime 才是执行序（10-04/10-05/10-08 三度复发实证）。只有 mtime
 * 完全相同才判 `native-input-ambiguous`（真的分不出谁最新）。
 */
export function nativeInputFromCompletedWrites(
  workspace: string,
  tools: ToolCall[],
  options: NativeInputOptions = {},
): string | undefined {
  const sinceMs = options.sinceMs;
  const candidates = new Map<string, { contents: string[]; edited: boolean }>();
  for (const tool of tools) {
    if (tool.status !== 'done' || !tool.args) continue;
    const write = WRITE_TOOLS.has(tool.name);
    if (!write && !EDIT_TOOLS.has(tool.name)) continue;
    const file = tool.args.path ?? tool.args.file_path;
    if (typeof file !== 'string' || !file.endsWith('.native-ppt.json')) continue;
    const relative = path.isAbsolute(file) ? path.relative(workspace, file) : file;
    const entry = candidates.get(relative) ?? { contents: [], edited: false };
    // ⭐ BUG-054（2026-10-09 只读复审）：同一文件多次写入时**保留每一次的内容**作为
    //    候选证据 —— 数组序 ≠ 执行序（同 BUG-046 ③ 的实证）。旧的"最后一次 write 胜出"
    //    在数组倒序时留下的是旧内容，sha 对不上 ⇒ 真新文件落选。现在 sha 与**任一次**
    //    记录一致即通过；多候选之间的裁决仍然只由盘上 mtime 负责（见文件头）。
    if (write && typeof tool.args.content === 'string') entry.contents.push(tool.args.content);
    // ⭐ F-A2：edit 证据与 write 证据**独立记账**——同 run 先 write 后 edit 同一文件时，
    //    write 记录的 args 是 edit 前的旧内容（第一层 sha 必不匹配），若第二层再因
    //    "该文件有 write 记录"跳过，候选两落空 → case A 误诊 native-current-write-required。
    if (EDIT_TOOLS.has(tool.name)) entry.edited = true;
    candidates.set(relative, entry);
  }
  const fresh = (relative: string): boolean => {
    if (sinceMs === undefined) return true;
    try {
      return statSync(path.resolve(workspace, relative)).mtimeMs >= sinceMs;
    } catch {
      return false;
    }
  };
  // 第一层：sha 匹配（内容逐字节一致）——最强证据。
  //    同文件多次 write ⇒ 与**任一次**记录一致即通过（BUG-054；数组序不作数）。
  const verified: Array<{ relative: string; mtimeMs: number }> = [];
  for (const [relative, entry] of candidates) {
    if (entry.contents.length === 0) continue;
    try {
      const disk = readWorkspaceBytes(workspace, relative, 1024 * 1024);
      const diskSha = sha(disk);
      if (!entry.contents.some((content) => sha(Buffer.from(content)) === diskSha)) continue;
      if (!fresh(relative)) continue;
      verified.push({ relative, mtimeMs: statSync(path.resolve(workspace, relative)).mtimeMs });
    } catch {
      continue;
    }
  }
  // 第二层：本轮有 edit/apply_patch 证据 + 盘上够新（只在调用方给了 run 起点时才启用）。
  //    判据就是"本轮改过 + freshness"，不再排除同时有 write 记录的候选（F-A2）。
  const edited: Array<{ relative: string; mtimeMs: number }> = [];
  if (sinceMs !== undefined) {
    for (const [relative, entry] of candidates) {
      if (!entry.edited) continue;
      try {
        const stat = statSync(path.resolve(workspace, relative));
        if (!stat.isFile() || stat.mtimeMs < sinceMs) continue;
        edited.push({ relative, mtimeMs: stat.mtimeMs });
      } catch {
        continue;
      }
    }
  }
  // 两层证据合并（同一文件两层都命中时按 relative 去重、取较大 mtime）。
  const merged = new Map<string, number>();
  for (const item of [...verified, ...edited])
    merged.set(item.relative, Math.max(merged.get(item.relative) ?? 0, item.mtimeMs));
  const chosen = [...merged.entries()]
    .map(([relative, mtimeMs]) => ({ relative, mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (chosen.length === 0) return undefined;
  if (chosen.length > 1 && chosen[0].mtimeMs === chosen[1].mtimeMs) throw Error('native-input-ambiguous');
  return chosen[0].relative;
}
