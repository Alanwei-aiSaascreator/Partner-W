import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * preload 是**唯一的桥**：渲染进程只能通过 `window.clawwork.*` 说话。
 * 这里用源码文本断言盯着「方法名 ↔ 通道名 ↔ 类型声明」三处不许漂
 * （与 `growth-preload-surface.test.ts` 同款）。
 *
 * `analytics:track` 是渲染层**唯一**能主动写埋点的通道：事件名白名单在
 * `main/ipc/analytics-handlers.ts`（那条由 `analytics-handlers.test.ts` 钉），
 * 这里只钉「渲染层够得着这条通道、参数真的透传、类型声明与实现同名同通道」。
 */
const preload = readFileSync(join(__dirname, '../src/preload/index.ts'), 'utf8');
const types = readFileSync(join(__dirname, '../src/preload/clawwork.d.ts'), 'utf8');

describe('preload 暴露的埋点接口', () => {
  it.each([['analyticsTrack', 'analytics:track']])('%s → %s（且类型声明里有它）', (method, channel) => {
    expect(preload).toContain(method);
    expect(preload).toContain(channel);
    expect(types).toContain(`${method}:`);
  });

  it('payload 原样透传给 IPC（渲染层在 preload 里不做二次加工）', () => {
    expect(preload).toContain("ipcRenderer.invoke('analytics:track', payload)");
  });

  it('类型声明的返回值是 IpcResult<null>，不是默认的 Record', () => {
    expect(types).toMatch(/analyticsTrack:[\s\S]{0,200}?Promise<IpcResult<null>>/);
  });
});
