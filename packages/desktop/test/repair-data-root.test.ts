import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveRepairDataRoot } from '../src/main/repair/targets.js';

/**
 * 修复模式看哪个"运行数据根"（2026-10-18 打包态冒烟抓到的真缺陷）。
 *
 * 现场：r39 的 `--repair` 打开后，六项全报"没有找到状态目录 / 这里用不上"。
 * 根因不是扫描逻辑，而是**根给错了** —— 修复模式在 `app.setName('Partner-W 修复工具')`
 * **之后**才取 `app.getPath('userData')`，拿到的是它自己的 Chromium 目录
 * （`%APPDATA%\Partner-W 修复工具`）；而正常应用的运行数据在 `%APPDATA%\@clawwork`。
 * ⇒ 安装版用户点开修复工具，永远看一个空目录（而且看起来像"全绿"）。
 */
describe('修复模式的数据根', () => {
  it('盘上形态：以实际重定向到的目录为准（正常应用也在用的那一份）', () => {
    expect(
      resolveRepairDataRoot({
        portableTarget: 'U:\\Partner-W-运行数据',
        installedUserDataDir: 'C:\\Users\\u\\AppData\\Roaming\\@clawwork',
      }),
    ).toBe('U:\\Partner-W-运行数据');
  });

  it('⭐ 安装形态：用**正常应用**的 userData，不是修复工具自己的 Chromium 目录', () => {
    const installed = 'C:\\Users\\u\\AppData\\Roaming\\@clawwork';
    const repairOwn = 'C:\\Users\\u\\AppData\\Roaming\\Partner-W 修复工具';
    const root = resolveRepairDataRoot({ portableTarget: null, installedUserDataDir: installed });
    expect(root).toBe(installed);
    expect(root).not.toBe(repairOwn);
  });

  it('盘上重定向失败（target=null）⇒ 仍按安装形态取，不静默变成空目录来源', () => {
    expect(resolveRepairDataRoot({ portableTarget: null, installedUserDataDir: 'C:\\data\\@clawwork' })).toBe(
      'C:\\data\\@clawwork',
    );
  });
});

/**
 * 源码顺序守卫：`setName` 之后取 `getPath('userData')` 就是那个 bug 本身。
 * 纯逻辑测不到"取早取晚"，只有钉住入口文件里的顺序。
 */
describe('修复模式入口源码顺序（防回归）', () => {
  const mainSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/main/repair/main.ts'), 'utf8');

  it('⭐ 正常应用的 userData 必须在 setName **之前**取', () => {
    const capture = mainSource.indexOf("const installedUserDataDir = app.getPath('userData')");
    const rename = mainSource.indexOf("app.setName('Partner-W 修复工具')");
    expect(capture).toBeGreaterThan(-1);
    expect(rename).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(rename);
  });

  it('⭐ 传给 host 的 userDataDir 走 resolveRepairDataRoot（不许直接传 app.getPath）', () => {
    expect(mainSource).toContain('userDataDir: resolveRepairDataRoot(');
    expect(mainSource).not.toContain("userDataDir: app.getPath('userData')");
  });
});
