import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_UNAVAILABLE_MESSAGE,
  checkInstallWorkspace,
  isAbsoluteWorkspacePath,
} from '../src/renderer/lib/install-workspace';

/**
 * 「安装助手前，工作区能不能用」的判定（2026-09-20 U 盘交付实机）。
 *
 * ⚠️ 这个文件钉的是**拒绝**的形态，而不是"通过"。实机上出的事是：
 *    工作区没解析出来时两条安装链各自悄悄降级成垃圾路径 ——
 *    `workspace:team-path` 在 `!base` 时 `return slug`（相对路径），
 *    市场模板把空串拼成 `/rongying-agents/<id>`（根相对路径）。
 *    两者都会让**每一个助手都建失败**，而界面只剩一句英文
 *    `No agents were created successfully`。⇒ 判定必须拒绝坏输入、并给中文原因。
 */
describe('checkInstallWorkspace', () => {
  it('空 / 只有空白 ⇒ 拒绝，给中文原因', () => {
    for (const bad of ['', '   ', null, undefined]) {
      const res = checkInstallWorkspace(bad);
      expect(res.ok).toBe(false);
      expect(res.ok === false && res.message).toBe(WORKSPACE_UNAVAILABLE_MESSAGE);
    }
  });

  it('⭐ 相对路径（＝`workspace:team-path` 降级时返回的 slug 本身）⇒ 拒绝', () => {
    const res = checkInstallWorkspace('lonely-team');
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.message).toBe(WORKSPACE_UNAVAILABLE_MESSAGE);
  });

  /**
   * ⚠️ 本条**刻意只钉"空 ⇒ 拒绝"**，不去钉 `'/rongying-agents/x'` 这种根相对串的形态：
   *    本判定收的是**工作区根**（市场链的坏输入是空串），而 `/x/y` 在 POSIX 上本来就是
   *    合法的绝对路径 —— 在判定里加平台分支，会让同一条用例在本机（Windows）与 CI
   *    （ubuntu）上行为不同。真实坏输入由 `template-install.test.ts` 从**入口**钉住。
   */
  it('⭐ 空工作区根 ⇒ 拒绝（市场链的坏输入就是它，而不是拼出来以后的那串）', () => {
    expect(checkInstallWorkspace('').ok).toBe(false);
    expect(checkInstallWorkspace(null).ok).toBe(false);
  });

  it('绝对路径 ⇒ 通过，且**原样**返回（尾部分隔符的清理由各自的拼接方负责）', () => {
    const win = checkInstallWorkspace('  D:\\ws\\荣盈魔方工作区  ');
    expect(win.ok).toBe(true);
    expect(win.ok === true && win.path).toBe('D:\\ws\\荣盈魔方工作区');

    const posix = checkInstallWorkspace('/tmp/ws');
    expect(posix.ok).toBe(true);
    expect(posix.ok === true && posix.path).toBe('/tmp/ws');
  });
});

describe('isAbsoluteWorkspacePath', () => {
  it('盘符 / UNC / POSIX 绝对路径都认', () => {
    expect(isAbsoluteWorkspacePath('C:\\ws')).toBe(true);
    expect(isAbsoluteWorkspacePath('d:/ws')).toBe(true);
    expect(isAbsoluteWorkspacePath('\\\\nas\\share\\ws')).toBe(true);
    expect(isAbsoluteWorkspacePath('/tmp/ws')).toBe(true);
  });

  it('相对路径、盘符不完整的、只有盘符的都不算', () => {
    expect(isAbsoluteWorkspacePath('ws')).toBe(false);
    expect(isAbsoluteWorkspacePath('lonely-team')).toBe(false);
    expect(isAbsoluteWorkspacePath('C:')).toBe(false);
    expect(isAbsoluteWorkspacePath('C:ws')).toBe(false);
    expect(isAbsoluteWorkspacePath('')).toBe(false);
  });
});
