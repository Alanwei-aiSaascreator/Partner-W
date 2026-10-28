import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 结构守卫：更新提示的落点必须**每个界面**都挂着（2026-10-19）。
 *
 * 用户原话："升级必须要进入主页面？不能在输入手机号页面显示然后下载更新吗？"
 *
 * 历史事故的形状很具体：`useUpdateCheck` 一度被限制成 `entryScreen === 'workspace'`，
 * 因为提示点击后跳「设置 → 关于」，而 `Settings` 只在工作区挂载 —— 登录页点了没反应。
 * 现在落点改成 App 层的 `UpdateDialog`，所以：
 *   ① `useUpdateCheck` 必须**无参调用**（不许再按界面门控）；
 *   ② 每个界面的 return 里都要有 `<UpdateDialog />`（与 `<AppToaster />` 同数量）。
 *
 * 这两条都是"看源码就能守住"的契约，不需要渲染整个 App（jsdom 里跑 real store 太重）。
 */
const here = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(here, '..', 'src', 'renderer', 'App.tsx'), 'utf8');

describe('更新弹窗的挂载契约', () => {
  it('useUpdateCheck 必须无参调用（不许按界面门控）', () => {
    expect(appSource).toContain('useUpdateCheck();');
    expect(appSource).not.toMatch(/useUpdateCheck\(\s*entryScreen/u);
  });

  it('每个界面 return 都挂 <UpdateDialog />（数量与 AppToaster 一致）', () => {
    const dialogMounts = appSource.match(/<UpdateDialog \/>/gu) ?? [];
    const toasterMounts = appSource.match(/<AppToaster themeMode=\{themeMode\} \/>/gu) ?? [];
    expect(toasterMounts.length).toBeGreaterThanOrEqual(6);
    expect(dialogMounts.length).toBe(toasterMounts.length);
  });
});
