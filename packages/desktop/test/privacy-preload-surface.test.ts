import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * preload 是**唯一的桥**：渲染进程只能通过 `window.clawwork.*` 说话。
 * 这里用源码文本断言盯着"方法名 ↔ 通道名 ↔ 类型声明"三处不许漂
 * （与 `growth-preload-surface.test.ts` 同款）。
 */
const preload = readFileSync(join(__dirname, '../src/preload/index.ts'), 'utf8');
const types = readFileSync(join(__dirname, '../src/preload/clawwork.d.ts'), 'utf8');

describe('preload 暴露的隐私工单接口', () => {
  it.each([
    ['privacyState', 'privacy:state'],
    ['privacyRequestExport', 'privacy:request-export'],
    ['privacyRequestDeletion', 'privacy:request-deletion'],
    ['privacyCancelDeletion', 'privacy:cancel-deletion'],
    ['privacyDownloadExport', 'privacy:download-export'],
  ])('%s → %s（且类型声明里有它）', (method, channel) => {
    expect(preload).toContain(method);
    expect(preload).toContain(channel);
    expect(types).toContain(`${method}:`);
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

  it('导出的类型声明给了具体形状（{ path: string }），不是默认 Record', () => {
    expect(types).toMatch(/privacyDownloadExport:[\s\S]{0,200}?Promise<IpcResult<\{\s*path:\s*string\s*\}>>/);
  });
});
