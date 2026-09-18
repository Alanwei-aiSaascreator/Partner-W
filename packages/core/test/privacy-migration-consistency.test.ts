import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describePrivacyError } from '../src/services/privacy-error-message.js';
import { normalizePrivacyState } from '../src/services/privacy-service.js';

/**
 * 隐私归一化 / 码表与**迁移文件**的跨文件一致性锁。
 *
 * 为什么需要它：状态白名单（`privacy-service.ts` 的 `STATUSES`）与错误码表都是
 * **手抄**进 core 的 —— 抄错了今天不会响、以后也不会响（用户只会拿到兜底文案或
 * 'unknown' 状态）。这条 P4 线上同一个形状**第二次**出现（第一次是 Task 4 的
 * `packages/shared/test/analytics-events.test.ts`，当时就写下"Task 12 有同一个坑，
 * 到时按同法落位"），所以这次连抽取器一起钉。
 *
 * ⚠️ 抽取正则刻意收 `[A-Za-z0-9_]`：写窄了（比如 `[a-z_]+`）会把将来带数字/大写的
 *    状态名或码**静默丢掉**，SQL 侧加了名字而这条照样绿 —— 那正是它要防的事。
 */

/** 从 cwd 逐级上溯找外层仓库的迁移文件（同款先例：`packages/shared/test/analytics-events.test.ts`）。 */
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

export function extractSqlStatuses(sql: string): string[] {
  const block = /check\s*\(\s*status in\s*\(([\s\S]*?)\)\)/.exec(sql);
  if (!block) {
    throw new Error('没从迁移里匹配到 `check (status in (...))` 块 —— 多半是格式变了，**不是**白名单漂移');
  }
  return Array.from(block[1].matchAll(/'([A-Za-z0-9_]+)'/g)).map((m) => m[1]);
}

export function extractSqlRaiseCodes(sql: string): string[] {
  const all = sql.match(/raise\s+exception/gi)?.length ?? 0;
  const codes = Array.from(sql.matchAll(/raise\s+exception\s+'([A-Za-z0-9_]+)'/gi)).map((m) => m[1]);
  // ⚠️ 抠到的条数必须与出现次数一致：不一致说明有 raise 的文案不是裸机器码
  //    （比如带空格），宁可当场炸，也不静默漏掉一个用户能收到的码。
  if (codes.length !== all) {
    throw new Error(
      `有 ${all} 处 raise exception，只抠出 ${codes.length} 个裸机器码 —— 多半是格式变了或有带空格的文案`,
    );
  }
  return Array.from(new Set(codes));
}

const PRIVACY_TABLES = readOuterMigration('20260917000050_privacy_tables.sql');
const CLIENT_RPC_SQL = [
  readOuterMigration('20260917000049_analytics_rpcs.sql'),
  readOuterMigration('20260917000051_privacy_rpcs.sql'),
].join('\n');

describe('隐私码表 / 白名单与迁移的跨文件一致性', () => {
  it('迁移 50 里的每个状态都能被归一化原样认出（加一个状态就必须同步 core）', () => {
    const statuses = extractSqlStatuses(PRIVACY_TABLES);
    expect(statuses.length).toBeGreaterThan(0);

    for (const value of statuses) {
      const state = normalizePrivacyState({ export: { id: 'e', status: value }, deletion: null });
      expect(state.export?.status, `迁移里的状态 ${value} 没被认出（会静默降级成 unknown）`).toBe(value);
    }
  });

  it('迁移 49/51 里 raise 的每个码都有专门中文（漏一个 ⇒ 用户只看到兜底文案）', () => {
    const codes = extractSqlRaiseCodes(CLIENT_RPC_SQL);
    expect(codes.length).toBeGreaterThan(0);

    const fallback = describePrivacyError('__definitely_not_a_code__');
    for (const code of codes) {
      expect(describePrivacyError(code), `${code} 没有专门文案，会退化成兜底`).not.toBe(fallback);
    }
  });

  it('抽取器容得下数字与大写、容忍空白（窄正则 = 假绿）', () => {
    expect(extractSqlStatuses("check (status in ('v2_state','READY'))")).toEqual(['v2_state', 'READY']);
    expect(extractSqlRaiseCodes("raise  exception   'v2_code_1';\nraise exception 'ALSO_2';")).toEqual([
      'v2_code_1',
      'ALSO_2',
    ]);
  });

  it('遇到抠不出来的 raise 会炸，而不是静默漏码', () => {
    expect(() => extractSqlRaiseCodes("raise exception '带空格的文案'")).toThrow();
  });
});
