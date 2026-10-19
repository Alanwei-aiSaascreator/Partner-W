import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getVideoQuality, setVideoQuality } from '../src/main/videogen/quality.js';
import {
  materializeSessionImage,
  rememberSessionImage,
  resetSessionImages,
  takeSessionImage,
} from '../src/main/videogen/session-image.js';

/**
 * 视频画质档位 + 图生视频的图片来源（2026-10-17）。
 *
 * 这里钉两个"会花错钱"的点：
 *  ① 档位只认两个值，脏数据不许把用户悄悄升级成贵档；
 *  ② 图片来源只认**本轮**的图，上一轮的图不能串到下一轮（否则用户会为一张旧图付费）。
 */

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PzWvWQAAAABJRU5ErkJggg==';

describe('video quality', () => {
  afterEach(() => setVideoQuality('standard'));

  it('默认标准档；只认 seedance', () => {
    setVideoQuality('standard');
    expect(getVideoQuality()).toBe('standard');
    expect(setVideoQuality('seedance')).toBe('seedance');
    expect(setVideoQuality('SEEDANCE')).toBe('standard');
    expect(setVideoQuality(undefined)).toBe('standard');
    expect(setVideoQuality({ quality: 'seedance' })).toBe('standard');
  });
});

describe('session image（图生视频首帧来源）', () => {
  let userData = '';

  beforeEach(() => {
    resetSessionImages();
    userData = mkdtempSync(join(tmpdir(), 'clawwork-videogen-refs-'));
  });
  afterEach(() => {
    resetSessionImages();
    rmSync(userData, { recursive: true, force: true });
  });

  it('记住本轮第一张图；非图片附件不记', () => {
    rememberSessionImage('s1', [
      { mimeType: 'text/plain', content: 'aGVsbG8=' },
      { mimeType: 'image/png', content: PNG_BASE64 },
    ]);
    expect(takeSessionImage('s1')?.mimeType).toBe('image/png');
    expect(takeSessionImage('s2')).toBeNull();
  });

  it('⭐ 本轮没有图 ⇒ 清掉上一轮的（否则会为一张旧图付费）', () => {
    rememberSessionImage('s1', [{ mimeType: 'image/png', content: PNG_BASE64 }]);
    expect(takeSessionImage('s1')).not.toBeNull();
    rememberSessionImage('s1', []);
    expect(takeSessionImage('s1')).toBeNull();
  });

  it('TTL 过期即丢弃', () => {
    rememberSessionImage('s1', [{ mimeType: 'image/png', content: PNG_BASE64 }]);
    const later = Date.now() + 31 * 60_000;
    expect(takeSessionImage('s1', later)).toBeNull();
  });

  it('落盘：内容寻址、字节与附件逐字一致，重复调用同一路径', () => {
    rememberSessionImage('s1', [{ mimeType: 'image/png', content: PNG_BASE64 }]);
    const image = takeSessionImage('s1');
    expect(image).toBeTruthy();
    const first = materializeSessionImage(userData, image!);
    const second = materializeSessionImage(userData, image!);
    expect(first).toBeTruthy();
    expect(existsSync(first!)).toBe(true);
    expect(second).toBe(first);
    expect(readFileSync(first!).toString('base64')).toBe(PNG_BASE64);
    expect(first!.endsWith('.png')).toBe(true);
  });

  it('超大图不记（首帧读取本身也有上限）', () => {
    rememberSessionImage('s1', [{ mimeType: 'image/png', content: 'A'.repeat(13 * 1024 * 1024) }]);
    expect(takeSessionImage('s1')).toBeNull();
  });
});
