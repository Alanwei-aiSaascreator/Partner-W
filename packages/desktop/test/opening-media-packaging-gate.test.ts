import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OPENING_MEDIA_DIR_NAME, OPENING_MEDIA_SCHEME, OPENING_VIDEO_FILE_NAME } from '@clawwork/shared';

/**
 * 打包门禁：开场片必须**在包里、且找得到**（形状照抄 pptx-template-packaging-gate）。
 *
 * 这类缺陷的形状：开发态一切正常、装出来 404 → 视频永远进兜底。
 * 两侧各钉一条：
 *  ① `electron-builder.yml` 真有一条把 `resources/media` 映射到 `<resources>/media`，
 *     且 `to:` 与 `OPENING_MEDIA_DIR_NAME` 一字不差；
 *  ② 目录里占位文件永远在（删掉会让 `scripts/require-bundled-runtime.cjs` 的
 *     "缺源"判定把构建变成硬失败 —— 这里就是那条规则的 CI 侧替身）。
 */

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('electron-builder.yml 的 extraResources', () => {
  const yml = readFileSync(join(PACKAGE_ROOT, 'electron-builder.yml'), 'utf8');

  it('有一条把 resources/media 映射到 <resources>/media', () => {
    expect(yml).toContain('from: resources/media');
  });

  it('⭐ `to:` 与 shared 的 OPENING_MEDIA_DIR_NAME 一字不差', () => {
    const to = new RegExp(`from:\\s*resources/media\\s*\\n\\s*to:\\s*(\\S+)`).exec(yml)?.[1];
    expect(to).toBe(OPENING_MEDIA_DIR_NAME);
  });

  it('媒体走 extraResources 而不是打进 app.asar', () => {
    const filesSection = yml.slice(yml.indexOf('\nfiles:'));
    expect(filesSection).not.toContain('resources/media');
  });
});

describe('resources/media 占位与素材', () => {
  it('目录与 .gitkeep 占位在（= 构建门禁硬失败规则的 CI 侧替身）', () => {
    const dir = join(PACKAGE_ROOT, 'resources', 'media');
    expect(existsSync(dir), '缺 resources/media 目录').toBe(true);
    expect(existsSync(join(dir, '.gitkeep')), '缺 .gitkeep —— 删掉它会让构建红').toBe(true);
  });

  it('opening.mp4 已落位且体积在 20MB 门槛内（18.6MB 目标）', () => {
    const file = join(PACKAGE_ROOT, 'resources', 'media', OPENING_VIDEO_FILE_NAME);
    expect(existsSync(file), `缺 ${OPENING_VIDEO_FILE_NAME}`).toBe(true);
    const size = readFileSync(file).byteLength;
    expect(size).toBeLessThan(20 * 1024 * 1024);
    expect(size).toBeGreaterThan(1024 * 1024);
  });
});

describe('渲染层 URL 与跨层常量一致（渲染层不 import main 是架构规矩，用文本断言补齐）', () => {
  it('OpeningMedia 用 scheme + dir + 文件名三常量拼 URL', () => {
    const source = readFileSync(join(PACKAGE_ROOT, 'src/renderer/components/OpeningMedia.tsx'), 'utf8');
    expect(source).toContain('OPENING_MEDIA_SCHEME');
    expect(source).toContain('OPENING_MEDIA_DIR_NAME');
    expect(source).toContain('OPENING_VIDEO_FILE_NAME');
    expect(OPENING_MEDIA_SCHEME).toBe('clawwork-asset');
  });
});
