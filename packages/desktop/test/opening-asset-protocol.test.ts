// 开场片协议层单测：纯定位函数 + 白名单式 URL → 路径解析（node 环境）。
import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';

vi.mock('electron', () => ({ net: { fetch: vi.fn() }, protocol: { handle: vi.fn() } }));

import { resolveOpeningAssetRequest, resolveOpeningMediaRoot } from '../src/main/media/opening-asset';

describe('resolveOpeningMediaRoot', () => {
  it('packaged：<resources>/media', () => {
    expect(resolveOpeningMediaRoot({ isPackaged: true, resourcesPath: 'C:\\app\\resources' })).toBe(
      path.join('C:\\app\\resources', 'media'),
    );
  });
  it('dev：<appPath>/resources/media', () => {
    expect(resolveOpeningMediaRoot({ isPackaged: false, appPath: 'D:\\repo\\packages\\desktop' })).toBe(
      path.join('D:\\repo\\packages\\desktop', 'resources', 'media'),
    );
  });
  it('缺参数 → undefined（不猜兜底路径）', () => {
    expect(resolveOpeningMediaRoot({ isPackaged: true })).toBeUndefined();
    expect(resolveOpeningMediaRoot({ isPackaged: false })).toBeUndefined();
  });
});

describe('resolveOpeningAssetRequest', () => {
  const root = path.join('C:\\app\\resources', 'media');
  const canonical = path.join(root, 'opening.mp4');

  it('合法 URL → 根下 opening.mp4', () => {
    expect(resolveOpeningAssetRequest('clawwork-asset://media/opening.mp4', root)).toBe(canonical);
  });
  it('host 大小写不敏感（Windows 语义）', () => {
    expect(resolveOpeningAssetRequest('clawwork-asset://MEDIA/opening.mp4', root)).toBe(canonical);
  });
  it('拒绝：其它 scheme / 其它 host / 其它文件名 / 空 path', () => {
    expect(resolveOpeningAssetRequest('https://media/opening.mp4', root)).toBeNull();
    expect(resolveOpeningAssetRequest('clawwork-asset://evil/opening.mp4', root)).toBeNull();
    expect(resolveOpeningAssetRequest('clawwork-asset://media/other.mp4', root)).toBeNull();
    expect(resolveOpeningAssetRequest('clawwork-asset://media/', root)).toBeNull();
    expect(resolveOpeningAssetRequest('clawwork-asset://media', root)).toBeNull();
  });
  it('拒绝：任何点段/反斜杠（含编码形式）', () => {
    expect(resolveOpeningAssetRequest('clawwork-asset://media/../opening.mp4', root)).toBeNull();
    expect(resolveOpeningAssetRequest('clawwork-asset://media/%2e%2e/opening.mp4', root)).toBeNull();
    expect(resolveOpeningAssetRequest('clawwork-asset://media/..%5copening.mp4', root)).toBeNull();
    expect(resolveOpeningAssetRequest('clawwork-asset://media\\opening.mp4', root)).toBeNull();
  });
  it('拒绝：绝对路径 / 无法解析的 URL', () => {
    expect(resolveOpeningAssetRequest('clawwork-asset://media/C:/windows/opening.mp4', root)).toBeNull();
    expect(resolveOpeningAssetRequest('not a url at all', root)).toBeNull();
  });
});
