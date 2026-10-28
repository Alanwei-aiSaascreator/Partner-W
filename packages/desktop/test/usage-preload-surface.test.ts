import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-a23：`usage.cost` 这条链已整条删掉（渲染层不再有消费者，且它在多 agent 配置下
 * 恒为 INVALID_REQUEST）。preload 是**唯一的桥**，所以这里用源码文本把
 * 「方法名 ↔ 通道名 ↔ 类型声明 ↔ 网关方法」四处一起钉住 —— 只删渲染层那一处、
 * 桥还挂着，等于留了个**一调就错**的陷阱（同款先例 `analytics-preload-surface.test.ts`）。
 *
 * 反向也钉：`usage.status` 那条链**必须还在**（防"顺手删多了"）。
 *
 * ⚠️ 表里的第二列只放**短字符串**：`it.each` 会把它拼进测试名，塞整个文件进去
 * 会让测试名变成几千字（踩过一次，JSON reporter 里根本读不出来）。
 */
const sources = {
  'preload 桥': readFileSync(join(__dirname, '../src/preload/index.ts'), 'utf8'),
  类型声明: readFileSync(join(__dirname, '../src/preload/clawwork.d.ts'), 'utf8'),
  'IPC handler': readFileSync(join(__dirname, '../src/main/ipc/ws-handlers.ts'), 'utf8'),
  网关客户端方法: readFileSync(join(__dirname, '../src/main/ws/gateway-client.ts'), 'utf8'),
  上报器: readFileSync(join(__dirname, '../src/main/commercial/usage-reporter.ts'), 'utf8'),
} as const;

type SourceLabel = keyof typeof sources;

const gone: [SourceLabel, string][] = [
  ['preload 桥', 'getUsageCost'],
  ['preload 桥', 'ws:usage-cost'],
  ['类型声明', 'getUsageCost'],
  ['IPC handler', 'ws:usage-cost'],
  ['网关客户端方法', 'usage.cost'],
];

const kept: [SourceLabel, string][] = [
  ['preload 桥', 'getUsageStatus'],
  ['preload 桥', 'ws:usage-status'],
  ['类型声明', 'getUsageStatus:'],
  ['IPC handler', 'ws:usage-status'],
  ['网关客户端方法', 'usage.status'],
];

/**
 * T-a25：**渲染层**那条 `sessions.usage`（preload 桥 → IPC `ws:session-usage` → `getSessionUsage({ key })`）
 * 也整条撤掉 —— 它取回的数据在渲染层只有写没有读，而且 key 一失效（没发过消息 / 会话被删 /
 * agent 前缀变过）就报 `Invalid session reference`（全档 36 次）。
 *
 * ⚠️ **反向对照是这一刀的重点**：`GatewayClient.getSessionUsage` 与**上报器**那条路
 * （`usage-reporter.ts` 传 `{ agentScope: 'all' }`，有消费者、有测试）**必须还在** ——
 * 这里连"上报器仍显式声明 agentScope"一起钉住，防止后来人"看着同名就一起删"。
 */
const goneSession: [SourceLabel, string][] = [
  ['preload 桥', 'getSessionUsage'],
  ['preload 桥', 'ws:session-usage'],
  ['类型声明', 'getSessionUsage'],
  ['IPC handler', 'ws:session-usage'],
];

const keptSession: [SourceLabel, string][] = [
  ['网关客户端方法', 'sessions.usage'],
  // ⚠️ 判据必须是**只有真方法才能满足**的串：`gateway-client.ts` 的 docblock 里也出现过
  //    `getSessionUsage` 这个词（"同 getSessionUsage 的办法"），用裸词会把**注释**当成控制组
  //    （变异④当场验过这一点）。
  ['网关客户端方法', 'async getSessionUsage(params: {'],
  ['上报器', 'getSessionUsage'],
  ['上报器', "agentScope: 'all'"],
];

describe('preload / IPC：usage.cost 四处都已撤掉', () => {
  it.each(gone)('%s 里不再出现 %s', (label, needle) => {
    expect(sources[label]).not.toContain(needle);
  });
});

describe('preload / IPC：usage.status 那条链仍在（反向对照）', () => {
  it.each(kept)('%s 里仍有 %s', (label, needle) => {
    expect(sources[label]).toContain(needle);
  });
});

describe('preload / IPC：渲染层的 sessions.usage 已撤（T-a25）', () => {
  it.each(goneSession)('%s 里不再出现 %s', (label, needle) => {
    expect(sources[label]).not.toContain(needle);
  });
});

describe('preload / IPC：网关客户端与上报器那条 sessions.usage 仍在（反向对照）', () => {
  it.each(keptSession)('%s 里仍有 %s', (label, needle) => {
    expect(sources[label]).toContain(needle);
  });
});
