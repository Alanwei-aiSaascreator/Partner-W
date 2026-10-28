import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * preload 是**唯一的桥**：这里用源码文本断言盯着「方法名 ↔ 通道名 ↔ 类型声明」
 * 三处不许漂（与 `analytics-preload-surface.test.ts` 同款）。
 *
 * `profile:flush-storage`（M3 / BUG-034）的纪律：
 *  - 渲染层**无参**调用——目标 session 由主进程从 `event.sender` 解析；
 *  - `requested:true` 仅代表"已发起刷新请求"（Electron 34 该 API 无回执）。
 */
const preload = readFileSync(join(__dirname, '../src/preload/index.ts'), 'utf8');
const types = readFileSync(join(__dirname, '../src/preload/clawwork.d.ts'), 'utf8');

describe('preload 暴露的画像持久化接口', () => {
  it.each([['requestProfileStorageFlush', 'profile:flush-storage']])(
    '%s → %s（且类型声明里有它）',
    (method, channel) => {
      expect(preload).toContain(method);
      expect(preload).toContain(channel);
      expect(types).toContain(`${method}:`);
    },
  );

  it('无参直发（渲染层不得传 partition/path —— 目标 session 只由主进程解析）', () => {
    expect(preload).toMatch(
      /requestProfileStorageFlush:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(\s*'profile:flush-storage'\s*\)/,
    );
    expect(preload).not.toMatch(/requestProfileStorageFlush:[\s\S]{0,200}?partition/);
  });

  it('类型声明的返回值是 IpcResult<{ requested: true }>，不是默认的 Record', () => {
    expect(types).toMatch(/requestProfileStorageFlush:[\s\S]{0,200}?Promise<IpcResult<\{ requested: true \}>>/);
  });
});
