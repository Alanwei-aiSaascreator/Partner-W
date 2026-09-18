import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * preload 是**唯一的桥**：渲染进程只能通过 `window.clawwork.*` 说话。
 * 这里用源码文本断言盯着"方法名 ↔ 通道名 ↔ 类型声明"三处不许漂
 * （与 `growth-preload-surface.test.ts` 同款）。
 *
 * ⚠️ 三处都会漂，**只有双向的集合相等能同时盯住**：
 *   · 往 preload 加一个主进程没注册的通道 ⇒ 用户点一下就是
 *     `Error: No handler registered for 'privacy:xxx'`；
 *   · 主进程加一个 preload 没暴露的通道 ⇒ 渲染层永远够不着（功能静默失踪）；
 *   · 名单只写一遍的 `it.each` 表格**两个方向都盯不住**（它是手抄的清单，
 *     抄漏一个照样绿 —— 与 `admin.test.ts` 那份 `ALL` 同一形状）。
 *   所以这里**从源码里解析出两份名单再比集合**，而不是手写对照表。
 */
const preload = readFileSync(join(__dirname, '../src/preload/index.ts'), 'utf8');
const types = readFileSync(join(__dirname, '../src/preload/clawwork.d.ts'), 'utf8');
const handlers = readFileSync(join(__dirname, '../src/main/ipc/privacy-handlers.ts'), 'utf8');

/** 从 handler 源码里抠出 `ipcMain.handle('隐私通道', …)` 的通道名。 */
export function handlerChannels(source: string): string[] {
  return Array.from(source.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)).map((match) => match[1]);
}

/** 从 preload 源码里抠出**方法名 → 通道名**的配对（每个方法一行）。 */
export function preloadPairs(source: string): Array<{ method: string; channel: string }> {
  const pairs: Array<{ method: string; channel: string }> = [];
  const pattern = /^\s*(\w+):[^\n]*?ipcRenderer\.invoke\(\s*'([^']+)'/gm;
  for (const match of source.matchAll(pattern)) {
    pairs.push({ method: match[1], channel: match[2] });
  }
  return pairs;
}

const privacyHandlers = handlerChannels(handlers);
const privacyPairs = preloadPairs(preload).filter((pair) => pair.channel.startsWith('privacy:'));

describe('preload 暴露的隐私工单接口', () => {
  it('handler 里注册的隐私通道 == preload 里 invoke 的隐私通道（正反双向）', () => {
    expect(privacyHandlers.length).toBeGreaterThan(0);
    // 双向集合相等：preload 多一个 ⇒ 用户点到 "No handler registered"；
    // 主进程多一个 ⇒ 渲染层够不着。
    expect([...privacyHandlers].sort()).toEqual(privacyPairs.map((pair) => pair.channel).sort());
    for (const channel of privacyHandlers) expect(channel).toMatch(/^privacy:/);
  });

  it('每个方法都在类型声明里（漏一个渲染层就取不到类型）', () => {
    const methods = privacyPairs.map((pair) => pair.method);
    expect(methods.length).toBeGreaterThan(0);
    // 方向一：preload 有的 ⇒ 类型声明里必须有
    for (const method of methods) expect(types, method).toContain(`${method}:`);
    // 方向二：类型声明里的 `privacy*` 方法 ⇒ preload 里必须有（漏了就是"声明了但没接线"）
    const declared = Array.from(types.matchAll(/^\s*(privacy\w*)\s*[:(]/gm)).map((match) => match[1]);
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) expect(methods, name).toContain(name);
  });

  it('方法名 ↔ 通道名逐个对齐（配对不许错位）', () => {
    // 从方法名推出应有的通道名：privacyDownloadExport → privacy:download-export
    const expected: Record<string, string> = {};
    for (const { method, channel } of privacyPairs) expected[method] = channel;
    expect(expected.privacyState).toBe('privacy:state');
    expect(expected.privacyRequestExport).toBe('privacy:request-export');
    expect(expected.privacyRequestDeletion).toBe('privacy:request-deletion');
    expect(expected.privacyCancelDeletion).toBe('privacy:cancel-deletion');
    expect(expected.privacyDownloadExport).toBe('privacy:download-export');
  });

  it('删除申请把理由原样透传（主进程再翻成 p_reason）', () => {
    expect(preload).toMatch(
      /privacyRequestDeletion:[\s\S]{0,200}?invoke\(\s*'privacy:request-deletion',\s*[A-Za-z_$][\w$]*\s*\)/,
    );
  });

  it('撤回删除把 payload 原样透传（IPC 只收一个 payload，主进程再翻成 p_id）', () => {
    expect(preload).toMatch(
      /privacyCancelDeletion:[\s\S]{0,200}?invoke\(\s*'privacy:cancel-deletion',\s*[A-Za-z_$][\w$]*\s*\)/,
    );
  });

  it('导出的类型声明给了具体形状（path + 截断信息），不是默认 Record', () => {
    expect(types).toMatch(
      /privacyDownloadExport:[\s\S]{0,300}?Promise<\s*IpcResult<\{\s*path:\s*string;\s*truncated:\s*boolean;\s*notes:\s*string\[\]\s*\}>\s*>/,
    );
  });

  it('抽取器不是瞎的：往源码里塞一个幽灵通道，两份名单立刻不相等（负对照）', () => {
    // ① handler 侧多一个
    const ghostHandler = handlers.replace(
      "  ipcMain.handle('privacy:state'",
      "  ipcMain.handle('privacy:ghost'\n  ipcMain.handle('privacy:state'",
    );
    expect(ghostHandler).not.toBe(handlers);
    expect([...handlerChannels(ghostHandler)].sort()).not.toEqual(privacyPairs.map((pair) => pair.channel).sort());

    // ② preload 侧多一个
    const ghostPreload = preload.replace(
      'privacyState: () =>',
      "privacyGhost: () => ipcRenderer.invoke('privacy:ghost', {}),\n    privacyState: () =>",
    );
    expect(ghostPreload).not.toBe(preload);
    const ghostPairs = preloadPairs(ghostPreload).filter((pair) => pair.channel.startsWith('privacy:'));
    expect(ghostPairs.map((pair) => pair.channel)).toContain('privacy:ghost');
    expect(ghostPairs.map((pair) => pair.channel).sort()).not.toEqual([...privacyHandlers].sort());
  });
});
