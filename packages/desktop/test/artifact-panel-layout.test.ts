import { describe, expect, it } from 'vitest';
import { resolveArtifactPanelLayout } from '../src/renderer/lib/artifact-panel-layout';

/**
 * Task 4（WorkBuddy 产物 UI A 批）：产物预览的**布局裁定**（纯函数）。
 *
 * 目标：宽窗并排可读（主对话 ≥360、预览 ≥360），窄窗改抽屉，极小窗全屏；
 * 进入/退出用 24px 回滞，避免临界 resize 反复切换；用户宽度偏好只被**有效宽度**
 * clamp，历史偏好不被窗口变化覆盖。
 */
describe('resolveArtifactPanelLayout', () => {
  const base = { navigationWidth: 224, requestedPreviewWidth: 500 };

  it('⭐ 宽窗（1280/224/500）⇒ inline、宽 500', () => {
    expect(resolveArtifactPanelLayout({ ...base, viewportWidth: 1280 })).toEqual({ mode: 'inline', width: 500 });
  });

  it('⭐ 首次布局（无 previousMode）：usable ≥720 ⇒ inline；<720 ⇒ drawer；viewport <600 ⇒ fullscreen', () => {
    // usable = 900-224 = 676 < 720
    expect(resolveArtifactPanelLayout({ ...base, viewportWidth: 900 }).mode).toBe('drawer');
    // usable = 944-224 = 720 ⇒ inline
    expect(resolveArtifactPanelLayout({ ...base, viewportWidth: 944 }).mode).toBe('inline');
    // viewport 500 < 600 ⇒ fullscreen，宽 = viewport
    expect(resolveArtifactPanelLayout({ ...base, viewportWidth: 500 })).toEqual({ mode: 'fullscreen', width: 500 });
  });

  it('⭐ 抽屉宽不超 viewport', () => {
    const layout = resolveArtifactPanelLayout({ ...base, viewportWidth: 900, requestedPreviewWidth: 1200 });
    expect(layout.mode).toBe('drawer');
    expect(layout.width).toBeLessThanOrEqual(900);
  });

  it('⭐ 回滞：inline 在 usable=719 进抽屉；drawer 在 730 保持、744 回 inline', () => {
    // usable 719 ⇒ viewport 943（首次走 720 阈值也应是 drawer；这里分别给 previousMode）
    expect(resolveArtifactPanelLayout({ ...base, viewportWidth: 943, previousMode: 'inline' }).mode).toBe('drawer');
    expect(resolveArtifactPanelLayout({ ...base, viewportWidth: 954, previousMode: 'drawer' }).mode).toBe('drawer');
    expect(resolveArtifactPanelLayout({ ...base, viewportWidth: 968, previousMode: 'drawer' }).mode).toBe('inline');
  });

  it('⭐ fullscreen 回滞：viewport 610 保持、624 退出', () => {
    expect(resolveArtifactPanelLayout({ ...base, viewportWidth: 610, previousMode: 'fullscreen' }).mode).toBe(
      'fullscreen',
    );
    // 624 ≥ 624 ⇒ 退出；usable 400 <720 ⇒ 落 drawer
    expect(resolveArtifactPanelLayout({ ...base, viewportWidth: 624, previousMode: 'fullscreen' }).mode).toBe('drawer');
  });

  it('⭐ inline 宽度夹在 [360, usable-360]（给主对话留可读宽）', () => {
    // usable = 1000-224 = 776 ⇒ 上限 416
    expect(resolveArtifactPanelLayout({ ...base, viewportWidth: 1000, requestedPreviewWidth: 1000 }).width).toBe(416);
    expect(resolveArtifactPanelLayout({ ...base, viewportWidth: 1280, requestedPreviewWidth: 100 }).width).toBe(360);
  });

  it('非法输入（NaN/负数）⇒ 回退到安全默认（不低于 360，不高于可用空间）', () => {
    const layout = resolveArtifactPanelLayout({
      viewportWidth: Number.NaN,
      navigationWidth: Number.NaN,
      requestedPreviewWidth: Number.NaN,
    });
    expect(Number.isFinite(layout.width)).toBe(true);
    expect(layout.width).toBeGreaterThanOrEqual(360);
    expect(['inline', 'drawer', 'fullscreen']).toContain(layout.mode);
  });
});
