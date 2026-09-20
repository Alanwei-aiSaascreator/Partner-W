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
