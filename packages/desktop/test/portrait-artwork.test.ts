import { describe, expect, it } from 'vitest';
import { PORTRAIT_ARTWORK, portraitArtworkFor } from '../src/renderer/lib/portrait-artwork';
import { PORTRAIT_ROLE_CODES } from '../src/renderer/lib/user-portrait';

/**
 * 3a 立绘表（03 画像侧）。
 *
 * ⚠️ 这里**故意不打桩**：`PortraitCard.test` 把立绘表整个 mock 掉，验的是"有图/缺图/坏图"
 *    三条降级路；这一档反过来钉住**真实素材链**——六个角色的 webp 是不是真的都在仓库里、
 *    名字是不是按 `persona-<role>` 约定（一张都不许只落在枕山身上）。
 *    素材改名/漏挂时，这条会当场红，而不是等到实机上头像空白。
 */
describe('portrait-artwork 六角色 lookup', () => {
  it('六个角色全部有立绘，且 URL 指向各自的 persona-<role> 文件', () => {
    for (const code of PORTRAIT_ROLE_CODES) {
      const url = portraitArtworkFor(code);
      expect(url, `缺少 ${code} 的立绘`).toBeTruthy();
      expect(url, `${code} 的立绘文件名不符合约定`).toContain(`persona-${code}`);
    }
  });

  it('表里的键 = 六个角色 code（不多不少）', () => {
    expect(Object.keys(PORTRAIT_ARTWORK).sort()).toEqual([...PORTRAIT_ROLE_CODES].sort());
  });
});
