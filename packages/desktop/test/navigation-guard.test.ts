import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { isAllowedAppNavigation, installNavigationGuards } from '../src/main/security/navigation-guard.js';

// 模块 import 'electron'（shell）——测试注入了 openExternal，这里只需让模块可加载。
vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));

const rendererDir = mkdtempSync(path.join(os.tmpdir(), 'nav-guard-'));
mkdirSync(path.join(rendererDir, 'renderer'));
const indexHtml = path.join(rendererDir, 'renderer', 'index.html');
writeFileSync(indexHtml, '<html/>');
const outside = mkdtempSync(path.join(os.tmpdir(), 'nav-outside-'));

describe('isAllowedAppNavigation', () => {
  it('prod：渲染目录内的 file:// 允许（含中文/空格名）', () => {
    const zh = path.join(rendererDir, 'renderer', '中文 页面.html');
    writeFileSync(zh, '<html/>');
    expect(isAllowedAppNavigation(pathToFileURL(zh).href, { appRendererDir: path.join(rendererDir, 'renderer') })).toBe(
      true,
    );
  });
  it('prod：目录外 / 同前缀相邻目录 / http / data / javascript 一律拒绝', () => {
    const opts = { appRendererDir: path.join(rendererDir, 'renderer') };
    const sibling = path.join(rendererDir, 'renderer-evil.html');
    writeFileSync(sibling, '<html/>');
    expect(isAllowedAppNavigation(pathToFileURL(path.join(outside, 'x.html')).href, opts)).toBe(false);
    expect(isAllowedAppNavigation(pathToFileURL(sibling).href, opts)).toBe(false); // realpath 后 relative 出界
    expect(isAllowedAppNavigation('https://example.com/', opts)).toBe(false);
    expect(isAllowedAppNavigation('data:text/html,<b/>', opts)).toBe(false);
    expect(isAllowedAppNavigation('javascript:alert(1)', opts)).toBe(false);
  });
  it('dev：仅同源允许', () => {
    const opts = { appRendererDir: path.join(rendererDir, 'renderer'), devOrigin: 'http://localhost:5173' };
    expect(isAllowedAppNavigation('http://localhost:5173/quick-launch.html', opts)).toBe(true);
    expect(isAllowedAppNavigation('http://evil.test/', opts)).toBe(false);
  });
});

describe('installNavigationGuards（真 webContents 形状）', () => {
  function fakeContents() {
    const handlers = new Map<string, (e: { preventDefault: () => void }, url: string) => void>();
    return { handlers, on: (name: string, fn: never) => void handlers.set(name, fn as never) };
  }
  it('内部 URL 放行；外链拦截并 openExternal；javascript: 只拦不跳', () => {
    const contents = fakeContents();
    const openExternal = vi.fn();
    installNavigationGuards(contents as never, { appRendererDir: path.join(rendererDir, 'renderer'), openExternal });
    const guard = contents.handlers.get('will-navigate')!;

    let prevented = false;
    guard({ preventDefault: () => (prevented = true) }, pathToFileURL(indexHtml).href);
    expect(prevented).toBe(false);

    prevented = false;
    guard({ preventDefault: () => (prevented = true) }, 'https://example.com/docs');
    expect(prevented).toBe(true);
    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs');

    prevented = false;
    guard({ preventDefault: () => (prevented = true) }, 'javascript:alert(1)');
    expect(prevented).toBe(true);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(contents.handlers.has('will-redirect')).toBe(true);
  });
});
