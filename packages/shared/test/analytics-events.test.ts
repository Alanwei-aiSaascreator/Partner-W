import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANALYTICS_EVENTS, isAnalyticsEvent } from '../src/analytics-events.js';

/**
 * 从 cwd 逐级上溯找外层仓库的迁移文件。
 * ⚠️ **别写死 `..`**：P4 的客户端改动在 worktree 里做
 * （`mofang-compass-desktop/.worktrees/local-file-artifact-loop`），
 * 与主检出到外层仓库的相对深度**不一样**。
 */
function readOuterMigration(name: string): string {
  let dir = process.cwd();
  for (let hop = 0; hop < 8; hop += 1) {
    const candidate = join(dir, 'supabase', 'migrations', name);
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`找不到迁移文件 ${name}（从 ${process.cwd()} 上溯 8 层）`);
}

/**
 * 从一段 `check (event in (...))` 的 SQL 里抠出事件名。
 *
 * ⚠️ 名字字符集刻意收 `[A-Za-z0-9_]`：今天 12 个名字恰好**全**落在 `[a-z_]+`，
 * 但把它写成 `[a-z_]+` 会让将来带数字/大写的名字被**静默丢掉**（SQL 侧加了名字、
 * 这条却照样绿）—— 那正是这条锁要防的事。见下面 fixture 用例。
 */
export function extractSqlEvents(sql: string): string[] {
  const block = /check\s*\(\s*event in\s*\(([\s\S]*?)\)\)/.exec(sql);
  if (!block) {
    throw new Error(
      '没从迁移里匹配到 `check (event in (...))` 块 —— ' +
        '这多半是迁移的格式变了（空白/换行），**不是**白名单漂移；' +
        '请对照迁移 48 的 CHECK 约束写法。',
    );
  }
  return Array.from(block[1].matchAll(/'([A-Za-z0-9_]+)'/g)).map((m) => m[1]);
}

describe('analytics events', () => {
  it('白名单非空且无重复', () => {
    expect(ANALYTICS_EVENTS.length).toBeGreaterThan(0);
    expect(new Set(ANALYTICS_EVENTS).size).toBe(ANALYTICS_EVENTS.length);
  });

  it('isAnalyticsEvent 只放行白名单里的名字', () => {
    expect(isAnalyticsEvent('chat_sent')).toBe(true);
    expect(isAnalyticsEvent('not_a_real_event')).toBe(false);
    expect(isAnalyticsEvent('')).toBe(false);
  });

  it('与迁移 48 的 CHECK 约束逐字一致（两边任一改动都必须让这条响）', () => {
    const sql = readOuterMigration('20260917000048_analytics_events.sql');
    expect(new Set(extractSqlEvents(sql))).toEqual(new Set(ANALYTICS_EVENTS));
  });

  it('抽取能抓到含数字与大写的名字（窄正则会把它们静默丢掉 ⇒ 假绿）', () => {
    const fake = "event text not null check (event in ('v2_event','APP_LAUNCH'))";
    expect(extractSqlEvents(fake)).toEqual(['v2_event', 'APP_LAUNCH']);
  });

  it('抽取容忍 CHECK 块的空白/换行（格式变了要报得出来，而不是当成白名单漂移）', () => {
    const fake = ['event text not null check (', '  event in (', "    'v2_event'", '  ))'].join('\n');
    expect(extractSqlEvents(fake)).toEqual(['v2_event']);
  });
});
