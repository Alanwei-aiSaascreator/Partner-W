import { describe, expect, it } from 'vitest';
import { updateStatusFromCheck } from '../src/renderer/lib/update-status';

/**
 * 「检查更新」的返回值 → 界面该显示的状态。
 *
 * 为什么单拎出来：检查完会**自动开始下载**（非便携形态），用户进设置页时更新
 * **往往已经下好了**。而界面以前只看 `hasUpdate` ⇒ 显示成「下载更新」，用户一点，
 * 主进程说"早下好了"、界面却停在 0% 的下载进度上（2026-09-18 实测）。
 * 规则只有一句：**主进程说是什么状态，就是什么状态**。
 */
describe('检查结果 → 界面状态', () => {
  it('没有新版本 ⇒ idle', () => {
    expect(updateStatusFromCheck({ hasUpdate: false, state: 'idle' })).toBe('idle');
  });

  it('有新版本、还没开始下 ⇒ available', () => {
    expect(updateStatusFromCheck({ hasUpdate: true, state: 'available' })).toBe('available');
  });

  it('⭐ 主进程说已下载 ⇒ downloaded（不许显示成"可下载"）', () => {
    expect(updateStatusFromCheck({ hasUpdate: true, state: 'downloaded' })).toBe('downloaded');
  });

  it('⭐ 主进程说正在下 ⇒ downloading', () => {
    expect(updateStatusFromCheck({ hasUpdate: true, state: 'downloading' })).toBe('downloading');
  });

  it('老 preload / 测试桩没给 state ⇒ 退回 available（有新版本就该能下）', () => {
    expect(updateStatusFromCheck({ hasUpdate: true })).toBe('available');
  });

  it('⭐ 主进程说已下载、但这次检查没报新版本 ⇒ 仍是 downloaded（安装入口不能被藏起来）', () => {
    // 可达路径：检查拿不到 updateInfo（hasUpdate=false），而 pending 里有下好的包
    expect(updateStatusFromCheck({ hasUpdate: false, state: 'downloaded' })).toBe('downloaded');
  });

  it('确实没有新版本、也没有下好的包 ⇒ idle', () => {
    expect(updateStatusFromCheck({ hasUpdate: false, state: 'idle' })).toBe('idle');
  });
});
