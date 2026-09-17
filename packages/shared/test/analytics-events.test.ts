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
    const block = /check \(event in \(([\s\S]*?)\)\)/.exec(sql);
    expect(block).not.toBeNull();
    const inSql = Array.from(block![1].matchAll(/'([a-z_]+)'/g)).map((m) => m[1]);
    expect(new Set(inSql)).toEqual(new Set(ANALYTICS_EVENTS));
  });
});
